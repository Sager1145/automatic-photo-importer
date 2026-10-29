import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {evaluateRoutes,classifyPlacement} from '../core/folder-rules';
import {parseTemplate} from '../folder-template';
import type {InventoryFile,Metadata} from '../shared';

const root='/library',mtime=new Date('2024-02-03T12:00:00Z');
function file(relative:string,kind:InventoryFile['kind']='JPEG',companionOf?:string):InventoryFile {return {path:path.join(root,relative),relative,size:10,kind,included:true,...(companionOf?{companionOf:path.join(root,companionOf)}:{})};}
const options={backup:false,template:'Trips/{camera}/{year}/{monthName}',layout:'flat' as const,reorganize:true};
const raw:Metadata={camera:'NIKON Z f',date:'2024-02-03T12:00:00+08:00',exposure:{iso:200},fields:{}};
function routes(files:InventoryFile[],metadata=new Map(files.filter(f=>f.kind!=='Other').map(f=>[f.path,raw])),changed={}) {return evaluateRoutes({sourceRoot:root,files,scanned:files,metadata,mtimes:new Map(files.map(f=>[f.path,mtime])),roots:[{root,role:'photos'}],options:{...options,...changed}});}

test('a custom static-prefix template classifies placement without a simple builder',()=>{
  assert.equal(parseTemplate(options.template),undefined);
  const f=file('Trips/NIKON Z f/2024/02 February/A.JPG'),[route]=routes([f]);
  assert.equal(route.relative,'Trips/NIKON Z f/2024/02 February/A.JPG');
  assert.equal(classifyPlacement({route,actual:{root:'photos',relativePath:f.relative},rulesScope:'current'}).status,'inPlace');
});

test('changing folder rules invalidates placement without rewriting capture or exposure',()=>{
  const f=file('Trips/NIKON Z f/2024/02 February/A.JPG'),metadata=new Map([[f.path,structuredClone(raw)]]),before=structuredClone(metadata.get(f.path));
  const [oldRoute]=routes([f],metadata),actual={root:'photos' as const,relativePath:f.relative};
  assert.equal(classifyPlacement({route:oldRoute,actual,rulesScope:'new',evaluatedRulesScope:'old'}).status,'unchecked');
  const [newRoute]=routes([f],metadata,{template:'{camera}/{yyyyMMdd}'});
  const placement=classifyPlacement({route:newRoute,actual,rulesScope:'new',evaluatedRulesScope:'new'});
  assert.equal(placement.status,'misplaced');
  assert.deepEqual(placement.expectedRoute,{role:'photos',relativePath:'NIKON Z f/20240203/A.JPG'});
  assert.deepEqual(metadata.get(f.path),before);
});

test('missing EXIF: keep is unclassifiable, folder and fileDate still have comparable destinations',()=>{
  const f=file('Unknown Camera/DCIM/A.JPG'),metadata=new Map<string,Metadata>([[f.path,{fields:{}}]]);
  const [kept]=routes([f],metadata,{noMetadata:'keep'});
  assert.equal(kept.reason,'keep');assert.equal(kept.noMetadataReason,'noDate');
  assert.equal(classifyPlacement({route:kept,actual:{root:'photos',relativePath:f.relative},rulesScope:'r'}).status,'unclassifiable');
  const [unknown]=routes([f],metadata,{noMetadata:'folder',noMetadataFolder:'Unsorted'});
  assert.equal(unknown.relative,'Unsorted/DCIM/A.JPG');
  assert.equal(classifyPlacement({route:unknown,actual:{root:'photos',relativePath:f.relative},rulesScope:'r'}).status,'misplaced');
  const [dated]=routes([f],metadata,{noMetadata:'fileDate',template:'{year}/{yyyymm}/{camera}'});
  assert.equal(dated.relative,'2024/202402/Unknown files/A.JPG');
  assert.equal(dated.effectiveMetadata.date,undefined);assert.equal(dated.effectiveMtime?.getTime(),mtime.getTime());
  assert.deepEqual(metadata.get(f.path),{fields:{}});
});

test('RAW, JPEG and sidecar inheritance remains separate from original capture and exposure',()=>{
  const files=[file('DCIM/A.NEF','RAW'),file('DCIM/A.JPG'),file('DCIM/A.XMP','Other','DCIM/A.NEF')];
  const metadata=new Map<string,Metadata>([[files[0].path,raw],[files[1].path,{exposure:{iso:800},fields:{}}]]),before=structuredClone([...metadata]);
  const decisions=routes(files,metadata,{noMetadata:'keep'});
  assert.deepEqual(decisions.map(d=>d.relative),['Trips/NIKON Z f/2024/02 February/A.NEF','Trips/NIKON Z f/2024/02 February/A.JPG','Trips/NIKON Z f/2024/02 February/A.XMP']);
  assert.equal(new Set(decisions.map(d=>d.family)).size,1);
  assert.equal(decisions[1].effectiveMetadata.date,raw.date);
  assert.deepEqual([...metadata],before);assert.equal(metadata.get(files[1].path)?.date,undefined);
});

test('Live Photos and their video sidecars follow still routing without mutating inventory or EXIF',()=>{
  const files=[file('DCIM/A.HEIC','HEIF'),file('DCIM/A.MOV','Videos'),file('DCIM/A.MOV.XMP','Other','DCIM/A.MOV')];
  const metadata=new Map<string,Metadata>([[files[0].path,{...raw,make:'Apple',contentId:'live'}],[files[1].path,{camera:'Video camera',date:'2025-01-01T00:00:00Z',contentId:'live',fields:{}}]]),before=structuredClone([...metadata]);
  const decisions=routes(files,metadata,{layout:'video-root',videoTemplate:'Clips/{camera}/{year}'});
  assert.deepEqual(decisions.map(d=>[d.root,d.relative]),[
    ['photos','Trips/NIKON Z f/2024/02 February/A.HEIC'],['photos','Trips/NIKON Z f/2024/02 February/A.MOV'],['photos','Trips/NIKON Z f/2024/02 February/A.MOV.XMP']]);
  assert.equal(files[1].companionOf,undefined);assert.deepEqual([...metadata],before);
});

test('GoPro chapters and proxies use first-chapter date in the separate video template',()=>{
  const files=[file('DCIM/GX010123.MP4','Videos'),file('DCIM/GX020123.MP4','Videos'),file('DCIM/GL020123.LRV','Videos','DCIM/GX020123.MP4')];
  const metadata=new Map<string,Metadata>([[files[0].path,{...raw,camera:'GoPro',date:'2024-02-29T23:59:59'}],[files[1].path,{...raw,camera:'GoPro',date:'2024-03-01T00:01:00'}]]);
  const decisions=routes(files,metadata,{layout:'video-root',videoTemplate:'Clips/{camera}/{yyyyMMdd}'});
  assert.deepEqual(decisions.map(d=>[d.root,d.relative]),[
    ['videos','Clips/GoPro/20240229/GX010123.MP4'],['videos','Clips/GoPro/20240229/GX020123.MP4'],['videos','Clips/GoPro/20240229/GL020123.LRV']]);
  assert.equal(new Set(decisions.map(d=>d.family)).size,1);
  assert.equal(decisions[1].effectiveMetadata.date,'2024-02-29T23:59:59');
  assert.equal(metadata.get(files[1].path)?.date,'2024-03-01T00:01:00');
});

test('existing edited ancestry classifies exports and companions, while RAW stays original',()=>{
  const files=[file('2024/202402/Finished/NIKON Z f/A.NEF','RAW'),file('2024/202402/Finished/NIKON Z f/A.JPG'),file('2024/202402/Finished/NIKON Z f/B.JPG'),file('2024/202402/Finished/NIKON Z f/B.XMP','Other','2024/202402/Finished/NIKON Z f/B.JPG')];
  const decisions=routes(files,undefined,{editedFolder:'Finished'});
  assert.equal(decisions[0].relative,'Trips/NIKON Z f/2024/02 February/A.NEF');
  for(const d of decisions.slice(1))assert.equal(classifyPlacement({route:d,actual:{root:'photos',relativePath:d.file.relative},rulesScope:'r'}).status,'inPlace');
  const [imported]=routes([files[1]],undefined,{editedFolder:'Finished',reorganize:false});
  assert.equal(imported.relative,'Trips/NIKON Z f/2024/02 February/A.JPG');
});

test('legal special directories and numbered conflict names are accepted by existing policy',()=>{
  const files=[file('2024/Camera/Conflicts/content/A.JPG'),file('Problem files/Empty/A.JPG'),file('Drive backups/SSD/A.JPG'),file('Photo Importer Data/Organizations/A.JPG'),file('Trips/NIKON Z f/2024/02 February/A (2).JPG')];
  const decisions=routes(files);
  for(const d of decisions)assert.equal(classifyPlacement({route:d,actual:{root:'photos',relativePath:d.file.relative},rulesScope:'r'}).status,'inPlace');
  assert.deepEqual(decisions.slice(0,4).map(d=>d.reason),['exempt','exempt','exempt','exempt']);
  assert.equal(decisions[4].relative,'Trips/NIKON Z f/2024/02 February/A (2).JPG');
});

test('unknown camera rules use nearby media context while explicit unknown folders retain their paths',()=>{
  const files=[file('DCIM/A.NEF','RAW'),file('DCIM/A.WAV','Other'),file('DCIM/INDEX.DAT','Other')],metadata=new Map([[files[0].path,raw]]);
  const decisions=routes(files,metadata,{reorganize:false,unknownRules:{wav:{action:'camera'},dat:'Camera indexes'},noMetadata:'keep'});
  assert.deepEqual(decisions.map(d=>d.relative),['Trips/NIKON Z f/2024/02 February/A.NEF','Trips/NIKON Z f/2024/02 February/A.WAV','Camera indexes/INDEX.DAT']);
  assert.equal(metadata.has(files[1].path),false);
});

test('real inventory classifies excluded empty media and their companions without adopting excluded unknown files',async t=>{
  const fs=await import('node:fs/promises'),os=await import('node:os'),{inventory}=await import('../core/inventory');
  const sourceRoot=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'catalog-empty-family-')));
  t.after(()=>fs.rm(sourceRoot,{recursive:true,force:true}));
  const contents:Record<string,string>={'A.CR3':'','A.XMP':'edits','GX010001.MP4':'','GX010001.LRF':'proxy','B.JPG':'image','B.XMP':'','empty.bin':'','unknown.dat':'unknown'};
  for(const [name,body] of Object.entries(contents))await fs.writeFile(path.join(sourceRoot,name),body);
  const listed=await inventory(sourceRoot),excluded=['A.CR3','A.XMP','GX010001.MP4','GX010001.LRF'];
  for(const name of excluded)assert.equal(listed.files.find(file=>path.basename(file.path)===name)?.included,false);
  const metadata=new Map([[path.join(sourceRoot,'B.JPG'),raw]]),mtimes=new Map(listed.files.map(file=>[file.path,mtime]));
  const input={sourceRoot,files:listed.files,scanned:listed.files,metadata,mtimes,roots:[{root:sourceRoot,role:'photos' as const}],options};
  const decisions=evaluateRoutes(input),byName=new Map(decisions.map(route=>[path.basename(route.file.path),route]));
  for(const name of excluded){
    const route=byName.get(name);
    assert.equal(route?.reason,'emptyPrimary',`${name} has an explicit empty-primary decision`);
    const placement=classifyPlacement({route,actual:{root:'photos',relativePath:name},rulesScope:'r'});
    assert.equal(placement.status,'unclassifiable');assert.equal(placement.reason,'emptyPrimary');
    assert.equal(placement.expectedRoute,undefined,'no move destination is suggested');
  }
  assert.equal(byName.get('B.XMP')?.reason,'route','an empty companion of nonempty media still routes normally');
  assert.equal(byName.has('empty.bin'),false);assert.equal(byName.has('unknown.dat'),false);
  const sidecar=listed.files.find(file=>path.basename(file.path)==='A.XMP')!;
  assert.equal(evaluateRoutes({...input,files:[sidecar]})[0]?.reason,'emptyPrimary','the scanned relationship resolves a primary outside the chosen file subset');
});
