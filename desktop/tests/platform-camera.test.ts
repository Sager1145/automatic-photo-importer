import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cameraSources, closeCameraBridge, prepareCamera } from '../platform/camera-bridge';
import { sourceAware } from '../core/source-fs';
import { ownTemporaryFolder } from './fixtures/os';

// The helper protocol (list, files, read by range) is tested on every system in camera-direct.test.ts.
test('a USB camera reports its card slots, and its capacity is their sum', async () => {
  const { cameraCapacity } = await import('../platform/camera-bridge');
  assert.deepEqual(cameraCapacity([{name:'Slot 1',total:100,free:40},{name:'Slot 2',total:100,free:60}]), {storages:[{name:'Slot 1',total:100,free:40},{name:'Slot 2',total:100,free:60}],total:200,free:100});
  // One slot without figures: the slots are still listed, but no partial sum is shown as the camera's capacity.
  assert.deepEqual(cameraCapacity([{name:'Slot 1',total:100,free:40},{name:'Slot 2'}]), {storages:[{name:'Slot 1',total:100,free:40},{name:'Slot 2',total:undefined,free:undefined}],total:undefined,free:undefined});
  assert.deepEqual(cameraCapacity(undefined), {});
});

test('a camera with two card slots is two sources, each with a stable id, its own capacity and its own stage request', async () => {
  const { cameraSourcesFrom, cameraOf } = await import('../platform/camera-bridge');
  const zf={cameraID:'cam\\usb#1',name:'Z f',storages:[{id:'10001',name:'Slot 1',total:124642131968,free:93033594880},{id:'20001',name:'Slot 2',total:124642131968,free:79312322560}]};
  const sources=cameraSourcesFrom([zf]);
  assert.deepEqual(sources.map(source=>[source.id,source.name,source.total,source.free]),[['camera:cam\\usb#1|10001','Z f · Slot 1',124642131968,93033594880],['camera:cam\\usb#1|20001','Z f · Slot 2',124642131968,79312322560]]);
  assert.deepEqual(sources.map(source=>source.storage),[{id:'10001',name:'Slot 1',camera:'Z f'},{id:'20001',name:'Slot 2',camera:'Z f'}]);
  assert.ok(sources.every(source=>source.transport==='camera'&&source.storages===undefined));
  // The id follows the slot, not its position: listed the other way round, each slot keeps its id.
  assert.deepEqual(cameraSourcesFrom([{...zf,storages:[...zf.storages].reverse()}]).map(source=>source.id).sort(),sources.map(source=>source.id).sort());
  assert.deepEqual(cameraOf(sources[1]!),{cameraID:'cam\\usb#1',storageID:'20001'});
  // One storage: one source under the camera's own name and id, staging the whole camera.
  const [single]=cameraSourcesFrom([{cameraID:'x100',name:'X100VI',storages:[{id:'10000001',name:'External Memory',total:100,free:40}]}]);
  assert.deepEqual(single,{id:'camera:x100',name:'X100VI',path:'camera://x100',transport:'camera',media:'sd',storages:[{name:'External Memory',total:100,free:40}],total:100,free:40});
  assert.deepEqual(cameraOf(single!),{cameraID:'x100'});
  // Slots without ids (an older helper), or with the same id twice, cannot be told apart: the camera stays one source.
  assert.equal(cameraSourcesFrom([{...zf,storages:zf.storages.map(({id,...rest})=>rest)}]).length,1);
  assert.equal(cameraSourcesFrom([{...zf,storages:zf.storages.map(storage=>({...storage,id:'1'}))}]).length,1);
});

test('two slots of one camera, each a source: each lists and reads only its own slot, at once, with nothing staged', async t => {
  // A temporary folder of its own: test files running alongside add theirs to the system one.
  await ownTemporaryFolder(t);
  const scratch=await realpath(await mkdtemp(path.join(tmpdir(),'importer-camera-slots-')));
  const prior=process.env.IMPORTER_NATIVE_BRIDGE;
  const helper=path.join(scratch,'fake-camera.cjs');
  await writeFile(helper,`const rl=require('node:readline').createInterface({input:process.stdin});const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
rl.on('line',line=>{const c=JSON.parse(line);
 if(c.command==='list')send({id:c.id,result:[{cameraID:'zf',name:'Z f',storages:[{id:'1',name:'Slot 1'},{id:'2',name:'Slot 2'}]}]});
 else if(c.command==='files')send({id:c.id,result:['1','2'].filter(id=>!c.storageID||c.storageID===id).map(id=>({storage:'Slot '+id,folder:['DCIM'],name:'slot.txt',size:1,objectID:'o'+id}))});
 else if(c.command==='read'){const data=Buffer.from(c.objectID.slice(1)).subarray(c.offset,c.offset+c.length);send({id:c.id,result:{bytes:data.length,data:data.toString('base64')}});}
 else send({id:c.id,result:true});});`);
  process.env.IMPORTER_NATIVE_BRIDGE=helper;
  const files=sourceAware(fs),before=new Set(await readdir(tmpdir()));
  try {
    const sources=await cameraSources();
    assert.deepEqual(sources.map(source=>source.name),['Z f · Slot 1','Z f · Slot 2']);
    const opened=await Promise.all(sources.map(source=>prepareCamera(source)));
    assert.notEqual(opened[0]!.path,opened[1]!.path,'each slot is read under a folder of its own');
    assert.deepEqual(await Promise.all(opened.map((camera,index)=>files.readdir(path.join(camera.path,`Slot ${index+1}`,'DCIM')))),[['slot.txt'],['slot.txt']]);
    await assert.rejects(files.readdir(path.join(opened[0]!.path,'Slot 2')),{code:'ENOENT'},'Slot 1 lists only Slot 1');
    const first=async(file:string)=>{const handle=await files.open(file,'r');try{const buffer=Buffer.alloc(1);await handle.read(buffer,0,1,0);return buffer.toString();}finally{await handle.close();}};
    assert.deepEqual(await Promise.all(opened.map((camera,index)=>first(path.join(camera.path,`Slot ${index+1}`,'DCIM','slot.txt')))),['1','2']);
    for(const camera of opened)await camera.cleanup();
    assert.deepEqual((await readdir(tmpdir())).filter(name=>!before.has(name)&&/photo-importer/i.test(name)),[]);
  }finally{await closeCameraBridge();if(prior===undefined)delete process.env.IMPORTER_NATIVE_BRIDGE;else process.env.IMPORTER_NATIVE_BRIDGE=prior;await rm(scratch,{recursive:true,force:true});}
});

test('a camera read only in part says so, and a camera on USB that the system never offered is no source', async () => {
  const { cameraSourcesFrom, unansweredCameras } = await import('../platform/camera-bridge');
  const listed=[{cameraID:'zf',name:'Z f',problem:'cardsUnknown'},{cameraID:'x',name:'X100VI',storages:[{id:'10000001',name:'External Memory',total:128,free:120}]},{cameraID:'usb:2228224',name:'NIKON DSC Z f',unanswered:true}];
  const sources=cameraSourcesFrom(listed);
  assert.deepEqual(sources.map(source=>[source.name,source.cameraProblem??'',source.total??'']),[['Z f','cardsUnknown',''],['X100VI','',128]]);
  assert.deepEqual(unansweredCameras(listed),[{name:'NIKON DSC Z f'}]);
  const { loadingCameras } = await import('../platform/camera-bridge');
  // A camera still reading its cards is no source yet, so it is never announced as one drive and then replaced by its slots.
  assert.deepEqual(cameraSourcesFrom([{cameraID:'zf',name:'Z f',loading:true}]),[]);
  assert.deepEqual(loadingCameras([{cameraID:'zf',name:'Z f',loading:true},...listed]),['Z f']);
  // Anything else in "problem" is ignored.
  assert.equal(cameraSourcesFrom([{cameraID:'a',name:'A',problem:'other'}])[0]!.cameraProblem,undefined);
});

test('each common camera brand is known by its USB vendor id, with a setup hint in every language', async () => {
  const { cameraBrand, cameraBrands } = await import('../camera-brands');
  const { createTranslator } = await import('../renderer/i18n');
  const { cameraSourcesFrom, unansweredCameras } = await import('../platform/camera-bridge');
  assert.deepEqual([0x04a9,0x054c,0x04b0,0x04cb,0x04da,0x07b4,0x33a2,0x25fb,0x1a98,0x1003,0x2756,0x2672,0x2ca3].map(vendor=>cameraBrand(vendor)?.name),
    ['Canon','Sony','Nikon','Fujifilm','Panasonic','OM System','OM System','Pentax / Ricoh','Leica','Sigma','Hasselblad','GoPro','DJI']);
  assert.equal(cameraBrand(0x1234),undefined);assert.equal(cameraBrand(undefined),undefined);
  // No vendor id belongs to two brands.
  const ids=cameraBrands.flatMap(brand=>brand.vendors);assert.equal(new Set(ids).size,ids.length);
  for(const language of ['zh-Hans','zh-Hant','ja'] as const)for(const brand of cameraBrands)assert.notEqual(createTranslator(language)(brand.hint),brand.hint,`${language}: ${brand.name}`);
  // The helper's vendor ids reach the sources and the cameras not answering; anything else is ignored.
  assert.equal(cameraSourcesFrom([{cameraID:'a',name:'Z f',problem:'cardsUnknown',vendor:0x04b0}])[0]!.usbVendor,0x04b0);
  assert.deepEqual(unansweredCameras([{cameraID:'usb:1',name:'USB PTP Camera',unanswered:true,vendor:0x04cb},{cameraID:'usb:2',name:'X',unanswered:true,vendor:-1}]),[{name:'USB PTP Camera',vendor:0x04cb},{name:'X'}]);
});

test('a camera card tells its room, contents, battery and serial; the drive details show them', async () => {
  const { cameraSourcesFrom } = await import('../platform/camera-bridge');
  const listed=[{cameraID:'zf',name:'Z f',battery:60,serial:'0000004004634',storages:[
    {id:'10001',name:'Slot 1',total:124642131968,free:92846555136,freeImages:1893,summary:{extensions:{nef:[1027,38000000000],mov:[1,200000000]},first:1785692531000,last:1793694543000}},
    {id:'20001',name:'Slot 2',total:124642131968,free:79250587648,freeImages:1893,summary:{extensions:{jpg:[6833,30000000000],nef:[1,37000000],'../x':[1,1]}}}]}];
  const [slot1,slot2]=cameraSourcesFrom(listed);
  assert.deepEqual(slot1!.details,{battery:60,serial:'0000004004634',freeImages:1893,contents:{extensions:{nef:[1027,38000000000],mov:[1,200000000]},first:1785692531000,last:1793694543000}});
  assert.deepEqual(Object.keys(slot2!.details!.contents!.extensions),['jpg','nef'],'an extension that is no extension is left out');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { I18nProvider } = await import('../renderer/i18n');
  const { SourceDetailRows, contentGroups } = await import('../renderer/source-details');
  assert.deepEqual(contentGroups(slot1!.details!.contents!).map(group=>[group.key,group.files]),[['{count} RAW',1027],['{count} videos',1]]);
  const html=renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(SourceDetailRows,{source:{...slot1!,details:{...slot1!.details,shutterCount:41234,shutterNote:'mechanical'}}})}));
  for(const part of ['USB camera','1,893','1,027 RAW · 1 videos','60 %','41,234','0000004004634','92.8 GB free of 124.6 GB'])assert.ok(html.includes(part),part);
  const drive=renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(SourceDetailRows,{source:{id:'d',name:'CARD',path:'/Volumes/CARD',transport:'storage',media:'sd',total:64e9,free:1e9,details:{fileSystem:'exfat',readOnly:true}}})}));
  for(const part of ['SD card','exFAT','Write-protected'])assert.ok(drive.includes(part),part);
});

test('a camera with no card it can read is no source but a notice with what to do', async () => {
  const { cameraSourcesFrom, unansweredCameras } = await import('../platform/camera-bridge');
  const listed=[{cameraID:'zf',name:'Z f',problem:'noCards',vendor:0x04b0},{cameraID:'x',name:'X100VI'},{cameraID:'usb:1',name:'NIKON DSC Z 8',unanswered:true,vendor:0x04b0}];
  assert.deepEqual(cameraSourcesFrom(listed).map(source=>source.name),['X100VI']);
  assert.deepEqual(unansweredCameras(listed),[{name:'Z f',vendor:0x04b0,reason:'noCards'},{name:'NIKON DSC Z 8',vendor:0x04b0}]);
});

test('a camera body names its slots’ card types, and a camera’s slots share one camera card', async () => {
  const { cameraSlots, slotMedia } = await import('../camera-slots');
  const { cameraSourcesFrom } = await import('../platform/camera-bridge');
  assert.deepEqual(cameraSlots('Z f'),['sd','microsd']);
  assert.deepEqual(cameraSlots('Canon EOS R5'),['cfexpress-b','sd']);
  assert.deepEqual(cameraSlots('X-H2S'),['cfexpress-b','sd']);
  assert.deepEqual(cameraSlots('ILCE-1'),['card','card'],'Sony combined CFexpress A / SD slots');
  assert.equal(cameraSlots('Unknown 9000'),undefined);
  assert.equal(slotMedia('Z f','Slot 2',0),'microsd','by the slot number in its name');
  const [slot1,slot2]=cameraSourcesFrom([{cameraID:'zf',name:'Z f',storages:[{id:'10001',name:'Slot 1'},{id:'20001',name:'Slot 2'}]}]);
  assert.deepEqual([slot1!.media,slot2!.media],['sd','microsd']);
  assert.equal(cameraSourcesFrom([{cameraID:'x',name:'X100VI',storages:[{id:'10000001',name:'External Memory'}]}])[0]!.media,'sd');
  const { cameraGroups, CameraCard, SourceRow } = await import('../renderer/RootApp');
  const card=(source:import('../shared').Source)=>({id:source.id,source});
  const drive={id:'d',name:'CARD',path:'/Volumes/CARD',transport:'storage' as const};
  const groups=cameraGroups([card(slot1!),card(drive),card(slot2!)]);
  assert.deepEqual(groups.map(group=>[group.camera??'',group.cards.map(item=>item.id)]),[['Z f',[slot1!.id,slot2!.id]],['',['d']]]);
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { I18nProvider } = await import('../renderer/i18n');
  const sources=[{...slot1!,details:{battery:60,shutterCount:9690,serial:'0000004004634'}},{...slot2!,details:{battery:60,shutterCount:9690}}];
  const html=renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(CameraCard,{camera:'Z f',sources,children:sources.map(source=>createElement(SourceRow,{key:source.id,slot:true,source,act:()=>{},configured:true}))})}));
  for(const part of ['data-testid="camera-card"','Z f','Battery 60 %','Shutter count 9,690','Serial 0000004004634','2 card slots','Slot 1','SD card','Slot 2','microSD card'])assert.ok(html.includes(part),part);
  // The camera's facts show once, in its header, not in each slot.
  assert.equal(html.split('9,690').length-1,1);
});
