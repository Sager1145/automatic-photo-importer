import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {plan,execute,findMisplaced,executeReorganization,configureOrganizationRecovery} from '../core/index';
import {formatFolder} from '../media-formats';
import type {MediaLayout,Metadata,PlanEntry,TransferPlan} from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const base={backup:false,template:'{year}/{yyyymm}/{camera}',unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Nikon Z6III',date:'2026-10-03T12:00:00',fields:{}});
const card=['DSC_0001.NEF','DSC_0001.JPG','DSC_0001.xmp','DSC_0001.dop','NKSC_PARAM/DSC_0001.NEF.nksc','IMG_0002.HEIC','IMG_0002.AAE','SCAN_0003.tif','C0004.MP4','C0004M01.XML','DJI_0005.MP4','DJI_0005.LRF','DJI_0005.WAV','DJI_0006.LRF'];

async function fixture(t:test.TestContext,files=card){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'media-layout-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'card'),drive=path.join(root,'drive'),photos=path.join(drive,'photobackup'),videos=path.join(drive,'videobackup');
 for(const folder of [source,photos,videos])await fs.mkdir(folder,{recursive:true});
 for(const name of files){await fs.mkdir(path.dirname(path.join(source,name)),{recursive:true});await fs.writeFile(path.join(source,name),'bytes of '+name);}
 return {root,source,drive,photos,videos};
}
const parts=(transfer:TransferPlan)=>[transfer,...(transfer.videos?[transfer.videos]:[])];
/** source name → destination relative to its own root. */
function placed(transfer:TransferPlan):Record<string,string>{
 const result:Record<string,string>={};
 for(const part of parts(transfer))for(const entry of part.entries)result[path.relative(path.join(part.root,'..','..','card'),entry.source)]=(part===transfer?'':'[videos] ')+path.relative(part.root,entry.destination);
 return result;
}
const camera='2026/202610/Nikon Z6III';
const expected:Record<MediaLayout,Record<string,string>>={
 'flat':{'DSC_0001.NEF':'','DSC_0001.JPG':'','DSC_0001.xmp':'','DSC_0001.dop':'','NKSC_PARAM/DSC_0001.NEF.nksc':'NKSC_PARAM/','IMG_0002.HEIC':'','IMG_0002.AAE':'','SCAN_0003.tif':'','C0004.MP4':'','C0004M01.XML':'','DJI_0005.MP4':'','DJI_0005.LRF':'','DJI_0005.WAV':'','DJI_0006.LRF':''},
 'format':{'DSC_0001.NEF':'NEF/','DSC_0001.JPG':'JPEG/','DSC_0001.xmp':'NEF/','DSC_0001.dop':'NEF/','NKSC_PARAM/DSC_0001.NEF.nksc':'NEF/NKSC_PARAM/','IMG_0002.HEIC':'HEIF/','IMG_0002.AAE':'HEIF/','SCAN_0003.tif':'TIFF/','C0004.MP4':'MP4/','C0004M01.XML':'MP4/','DJI_0005.MP4':'MP4/','DJI_0005.LRF':'MP4/','DJI_0005.WAV':'MP4/','DJI_0006.LRF':'LRF/'},
 'type-format':{'DSC_0001.NEF':'Photos/NEF/','DSC_0001.JPG':'Photos/JPEG/','DSC_0001.xmp':'Photos/NEF/','DSC_0001.dop':'Photos/NEF/','NKSC_PARAM/DSC_0001.NEF.nksc':'Photos/NEF/NKSC_PARAM/','IMG_0002.HEIC':'Photos/HEIF/','IMG_0002.AAE':'Photos/HEIF/','SCAN_0003.tif':'Photos/TIFF/','C0004.MP4':'Videos/MP4/','C0004M01.XML':'Videos/MP4/','DJI_0005.MP4':'Videos/MP4/','DJI_0005.LRF':'Videos/MP4/','DJI_0005.WAV':'Videos/MP4/','DJI_0006.LRF':'Videos/LRF/'},
 'photos-flat':{'DSC_0001.NEF':'','DSC_0001.JPG':'','DSC_0001.xmp':'','DSC_0001.dop':'','NKSC_PARAM/DSC_0001.NEF.nksc':'NKSC_PARAM/','IMG_0002.HEIC':'','IMG_0002.AAE':'','SCAN_0003.tif':'','C0004.MP4':'Videos/','C0004M01.XML':'Videos/','DJI_0005.MP4':'Videos/','DJI_0005.LRF':'Videos/','DJI_0005.WAV':'Videos/','DJI_0006.LRF':'Videos/'},
 'videos-flat':{'DSC_0001.NEF':'Photos/','DSC_0001.JPG':'Photos/','DSC_0001.xmp':'Photos/','DSC_0001.dop':'Photos/','NKSC_PARAM/DSC_0001.NEF.nksc':'Photos/NKSC_PARAM/','IMG_0002.HEIC':'Photos/','IMG_0002.AAE':'Photos/','SCAN_0003.tif':'Photos/','C0004.MP4':'','C0004M01.XML':'','DJI_0005.MP4':'','DJI_0005.LRF':'','DJI_0005.WAV':'','DJI_0006.LRF':''},
 'video-root':{'DSC_0001.NEF':'','DSC_0001.JPG':'','DSC_0001.xmp':'','DSC_0001.dop':'','NKSC_PARAM/DSC_0001.NEF.nksc':'NKSC_PARAM/','IMG_0002.HEIC':'','IMG_0002.AAE':'','SCAN_0003.tif':'','C0004.MP4':'[videos] ','C0004M01.XML':'[videos] ','DJI_0005.MP4':'[videos] ','DJI_0005.LRF':'[videos] ','DJI_0005.WAV':'[videos] ','DJI_0006.LRF':'[videos] '},
};

test('format folders are the uppercase extension with spelling variants merged',()=>{
 assert.deepEqual(['a.nef','a.JPG','a.jpeg','a.jpe','a.heic','a.HIF','a.heif','a.tif','a.TIFF','a.mpg','a.mpeg','a.MOV','a.cr3'].map(formatFolder),['NEF','JPEG','JPEG','JPEG','HEIF','HEIF','HEIF','TIFF','TIFF','MPEG','MPEG','MOV','CR3']);
});

for(const layout of Object.keys(expected) as MediaLayout[])test(`${layout}: every file and its companions land in the layout's folder`,async t=>{
 const {source,photos,videos}=await fixture(t);
 const {plans:[transfer]}=await plan(source,[photos],{...base,layout,videoRoots:[videos]},metadata);
 assert.equal(!!transfer!.videos,layout==='video-root');
 const want=Object.fromEntries(Object.entries(expected[layout]).map(([name,folder])=>{const video=folder.startsWith('[videos] ');return [name,(video?'[videos] ':'')+path.join(camera,folder.replace('[videos] ',''),path.basename(name))];}));
 assert.deepEqual(placed(transfer!),want);
 // A family (RAW+JPEG+sidecars, video+XML/LRF/WAV) shares one conflict folder: the camera folder.
 for(const part of parts(transfer!))for(const entry of part.entries)assert.equal(entry.allocation!.folder,path.join(part.root,camera),entry.source);
 for(const part of parts(transfer!))assert.deepEqual(await execute(part),{copied:part.entries.length,skipped:0,errors:[]});
});

test('video-root uses a separate video template when one is chosen',async t=>{
 const {source,photos,videos}=await fixture(t,['DSC_0001.NEF','C0004.MP4','C0004M01.XML']);
 const {plans:[transfer]}=await plan(source,[photos],{...base,layout:'video-root',videoTemplate:'{camera}/{yyyyMMdd}',videoRoots:[videos]},metadata);
 assert.deepEqual(placed(transfer!),{'DSC_0001.NEF':camera+'/DSC_0001.NEF','C0004.MP4':'[videos] Nikon Z6III/20261003/C0004.MP4','C0004M01.XML':'[videos] Nikon Z6III/20261003/C0004M01.XML'});
});

test('edited exports stay flat in the edited folder whatever the layout',async t=>{
 const {source,photos}=await fixture(t,['DSC_0001.JPG']);
 for(const layout of ['format','type-format','videos-flat'] as const){
  const {plans:[transfer]}=await plan(source,[photos],{...base,layout},async()=>({...await metadata(),edited:true}));
  assert.equal(path.relative(photos,transfer!.entries[0]!.destination),'2026/202610/editied/Nikon Z6III/DSC_0001.JPG',layout);
 }
});

test('a camera-folder file with no matching photo or video goes directly in the camera folder',async t=>{
 const {source,photos}=await fixture(t,['DSC_0001.NEF','orphan.dat']);
 const {plans:[transfer]}=await plan(source,[photos],{...base,layout:'type-format',unknownRules:{dat:{action:'camera'}}},metadata);
 assert.deepEqual(placed(transfer!),{'DSC_0001.NEF':camera+'/Photos/NEF/DSC_0001.NEF','orphan.dat':camera+'/orphan.dat'});
});

test('video-root needs a video folder for every destination',async t=>{
 const {source,photos}=await fixture(t,['C0004.MP4']);
 await assert.rejects(plan(source,[photos],{...base,layout:'video-root'},metadata),/video backup folder/i);
});

test('an identical file already at the destination is skipped; a different file with the same name moves its family to Conflicts',async t=>{
 const {source,photos}=await fixture(t,['DSC_0001.NEF','DSC_0001.JPG','DSC_0001.xmp','C0004.MP4','C0004M01.XML']);
 const at=(relative:string)=>path.join(photos,camera,relative);
 await fs.mkdir(at('NEF'),{recursive:true});await fs.mkdir(at('MP4'),{recursive:true});
 await fs.writeFile(at('NEF/DSC_0001.NEF'),'a different photo with this name');
 await fs.writeFile(at('MP4/C0004.MP4'),'bytes of C0004.MP4');
 const {plans:[transfer]}=await plan(source,[photos],{...base,layout:'format'},metadata);
 const by=(name:string)=>transfer!.entries.find(entry=>path.basename(entry.source)===name)!;
 const conflict=path.relative(path.join(photos,camera),by('DSC_0001.NEF').destination).split(path.sep);
 assert.equal(conflict[0],'Conflicts');
 // The whole still family moves together and keeps its format folders.
 assert.deepEqual(['DSC_0001.NEF','DSC_0001.JPG','DSC_0001.xmp'].map(name=>path.relative(path.join(photos,camera),by(name).destination)),[`Conflicts/${conflict[1]}/NEF/DSC_0001.NEF`,`Conflicts/${conflict[1]}/JPEG/DSC_0001.JPG`,`Conflicts/${conflict[1]}/NEF/DSC_0001.xmp`]);
 // The identical video is kept; its companion is copied beside it.
 assert.equal(by('C0004.MP4').destination,at('MP4/C0004.MP4'));assert.equal(by('C0004.MP4').skip,true);
 assert.equal(by('C0004M01.XML').destination,at('MP4/C0004M01.XML'));
 assert.equal((await execute(transfer!)).errors.length,0);
 assert.equal(await fs.readFile(at('NEF/DSC_0001.NEF'),'utf8'),'a different photo with this name');
});

test('two different files with the same name on one card do not overwrite each other',async t=>{
 const {source,photos}=await fixture(t,['100NIKON/DSC_0001.NEF','101NIKON/DSC_0001.NEF','100NIKON/DSC_0002.JPG','101NIKON/DSC_0002.jpg']);
 await fs.writeFile(path.join(source,'101NIKON/DSC_0002.jpg'),'bytes of 100NIKON/DSC_0002.JPG');
 const {plans:[transfer]}=await plan(source,[photos],{...base,layout:'format'},metadata);
 const destinations=transfer!.entries.map((entry:PlanEntry)=>path.relative(path.join(photos,camera),entry.destination));
 assert.ok(destinations.includes('NEF/DSC_0001.NEF'));
 assert.equal(destinations.filter(item=>item.startsWith('Conflicts/')&&item.endsWith('/NEF/DSC_0001.NEF')).length,1,'the second NEF goes to a conflict folder');
 // Same name in another case and same bytes: one copy is enough.
 const jpegs=transfer!.entries.filter(entry=>/dsc_0002/i.test(entry.source));
 assert.equal(new Set(jpegs.map(entry=>entry.destination.toLowerCase())).size,1);
 assert.equal((await execute(transfer!)).errors.length,0);
});

test('organization moves an existing backup into the new layout, including between photo and video roots',async t=>{
 const {drive,photos,videos}=await fixture(t,[]);
 const put=async(file:string)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'bytes of '+path.basename(file));};
 // Laid out by the former "separate by media type" folders.
 await put(path.join(photos,camera,'RAW/DSC_0001.NEF'));await put(path.join(photos,camera,'RAW/DSC_0001.xmp'));
 await put(path.join(photos,camera,'Videos/C0004.MP4'));await put(path.join(photos,camera,'Videos/C0004M01.XML'));
 await put(path.join(videos,camera,'DSC_0009.JPG'));
 const options={...base,layout:'video-root' as const,videoRoots:[videos],sourceFolders:['photobackup','videobackup']};
 const misplaced=await findMisplaced(drive,photos,options,metadata);
 assert.deepEqual(misplaced.files.sort(),['photobackup/'+camera+'/RAW/DSC_0001.NEF','photobackup/'+camera+'/RAW/DSC_0001.xmp','photobackup/'+camera+'/Videos/C0004.MP4','photobackup/'+camera+'/Videos/C0004M01.XML','videobackup/'+camera+'/DSC_0009.JPG'].sort());
 const {plans:[transfer]}=await plan(drive,[photos],{...options,reorganize:true},metadata);
 for(const part of parts(transfer!))assert.deepEqual((await executeReorganization(part,undefined,undefined,{strategy:'rename'})).errors,[]);
 for(const file of [path.join(photos,camera,'DSC_0001.NEF'),path.join(photos,camera,'DSC_0001.xmp'),path.join(photos,camera,'DSC_0009.JPG'),path.join(videos,camera,'C0004.MP4'),path.join(videos,camera,'C0004M01.XML')])await fs.access(file);
 assert.equal((await findMisplaced(drive,photos,options,metadata)).count,0);
});

test('organization moves files from the old media-type folders into format folders',async t=>{
 const {photos}=await fixture(t,[]);
 const put=async(relative:string)=>{const file=path.join(photos,camera,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'bytes of '+relative);};
 await put('RAW/DSC_0001.NEF');await put('JPEG/DSC_0001.JPG');await put('RAW/DSC_0001.xmp');await put('Videos/C0004.MOV');
 const options={...base,layout:'type-format' as const};
 assert.equal((await findMisplaced(photos,photos,options,metadata)).count,4);
 const {plans:[transfer]}=await plan(photos,[photos],{...options,reorganize:true},metadata);
 assert.deepEqual((await executeReorganization(transfer!,undefined,undefined,{strategy:'rename'})).errors,[]);
 for(const relative of ['Photos/NEF/DSC_0001.NEF','Photos/JPEG/DSC_0001.JPG','Photos/NEF/DSC_0001.xmp','Videos/MOV/C0004.MOV'])await fs.access(path.join(photos,camera,relative));
});

test('the backup folder check reports each file it checks out of the total',async t=>{
 const {photos}=await fixture(t,[]);
 for(const name of ['wrong/A.JPG','wrong/B.JPG',camera+'/C.JPG']){const file=path.join(photos,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,name);}
 const seen:[number,number|undefined][]=[];let listed=0;
 const found=await findMisplaced(photos,photos,{...base,layout:'flat'},metadata,undefined,(count,_file,detail)=>{if(detail?.step==='listing')listed=count;else seen.push([count,detail?.total]);});
 // Listing reports files found before the check counts them against the total.
 assert.equal(listed,3);
 assert.equal(found.count,2);
 assert.deepEqual(seen.map(([count])=>count).sort(),[1,2,3]);assert.ok(seen.every(([,total])=>total===3));
});
