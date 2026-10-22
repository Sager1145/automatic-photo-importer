import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import * as core from '../core/index';
import type {MediaLayout,Metadata,TransferPlan} from '../shared';
import {parts,put,temporary,tree} from './fixtures/edge';

core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const metadata=async(file:string):Promise<Metadata>=>({camera:path.basename(file).startsWith('DJI')?'DJI Osmo Pocket 3':'Nikon Z6III',date:'2026-10-03T12:00:00',fields:{}});
/** A backup drive laid out by hand: wrong folders, photos and videos mixed, a name used twice. */
async function library(t:test.TestContext){
 const root=await temporary(t,'edge-organize-'),drive=path.join(root,'drive'),photos=path.join(drive,'photobackup'),videos=path.join(drive,'videobackup');
 const files:Record<string,string>={
  'photobackup/old/DSC_0001.NEF':'raw 1','photobackup/old/DSC_0001.xmp':'xmp 1','photobackup/old/C0004.MP4':'sony clip','photobackup/old/C0004M01.XML':'sony xml',
  'photobackup/old/DJI_0005.MP4':'dji clip','photobackup/old/DJI_0005.LRF':'dji proxy','photobackup/a/DSC_0002.JPG':'first 0002','photobackup/b/DSC_0002.JPG':'second 0002',
  'photobackup/deep/x/y/z/IMG_0003.HEIC':'heic','photobackup/empty.JPG':'','videobackup/misc/IMG_0009.JPG':'photo among videos','videobackup/keep.txt':'not media',
 };
 for(const [relative,content] of Object.entries(files))await put(path.join(drive,relative),content);
 // Distinct modified dates, so undo can be checked to restore them.
 for(const [index,relative] of Object.keys(files).entries()){const when=new Date(Date.UTC(2020,0,1+index));await fs.utimes(path.join(drive,relative),when,when);}
 return {root,drive,photos,videos,files};
}
async function snapshot(drive:string){
 const result=new Map<string,string>();
 for(const [relative,digest] of await tree(drive))result.set(relative,`${digest} ${(await fs.stat(path.join(drive,relative))).mtime.toISOString()}`);
 return result;
}
const settings=(layout:MediaLayout,photos:string,videos:string)=>({backup:false,reorganize:true,template:'{year}/{yyyymm}/{camera}',layout,unknownRules:{},...(layout==='video-root'?{videoRoots:[videos],sourceFolders:['photobackup','videobackup']}:{})});
async function organize(drive:string,photos:string,videos:string,layout:MediaLayout,strategy:'rename'|'copy',signal?:AbortSignal,onProgress?:()=>void){
 const source=layout==='video-root'?drive:photos;
 const {plans:[transfer]}=await core.plan(source,[photos],settings(layout,photos,videos),metadata);
 const results=[];for(const part of parts(transfer!))results.push(await core.executeReorganization(part,signal,onProgress,{strategy}));
 return {transfer:transfer!,results};
}
const jobs=async(...roots:string[])=>(await Promise.all(roots.map(root=>core.getOrganizationRecovery(root)))).flat();
const misplaced=async(drive:string,photos:string,videos:string,layout:MediaLayout)=>(await core.findMisplaced(layout==='video-root'?drive:photos,photos,settings(layout,photos,videos),metadata)).count;

for(const strategy of ['rename','copy'] as const)test(`video-root organization in place (${strategy}) moves videos to videobackup and undo restores every file and date`,async t=>{
 const {drive,photos,videos,files}=await library(t);
 const before=await snapshot(drive);
 assert.equal(await misplaced(drive,photos,videos,'video-root'),Object.keys(files).length-2);
 const {results}=await organize(drive,photos,videos,'video-root',strategy);
 for(const result of results)assert.deepEqual(result.errors,[]);
 const camera='2026/202610/Nikon Z6III',pocket='2026/202610/DJI Osmo Pocket 3';
 for(const relative of [`photobackup/${camera}/DSC_0001.NEF`,`photobackup/${camera}/DSC_0001.xmp`,`photobackup/${camera}/IMG_0003.HEIC`,`photobackup/${camera}/IMG_0009.JPG`,
  `videobackup/${camera}/C0004.MP4`,`videobackup/${camera}/C0004M01.XML`,`videobackup/${pocket}/DJI_0005.MP4`,`videobackup/${pocket}/DJI_0005.LRF`])await fs.access(path.join(drive,relative));
 // The two DSC_0002.JPG keep both their bytes: one in the camera folder, one in a conflict folder.
 const organized=await tree(drive),twins=[...organized].filter(([relative])=>relative.endsWith('DSC_0002.JPG'));
 assert.equal(twins.length,2);assert.equal(new Set(twins.map(([,digest])=>digest)).size,2);
 assert.ok(twins.some(([relative])=>relative.split(path.sep).includes('Conflicts')));
 assert.equal(await misplaced(drive,photos,videos,'video-root'),0);
 assert.equal(await fs.readFile(path.join(videos,'keep.txt'),'utf8'),'not media');
 // Every byte is still there exactly once outside the recovery store (the copy strategy also keeps the originals inside it).
 assert.deepEqual(new Set(organized.values()),new Set([...before.values()].map(value=>value.split(' ')[0])));
 const found=await jobs(photos,videos);
 assert.equal(found.length,2);assert.ok(found.every(job=>job.status==='complete'&&job.undoable&&!job.error),JSON.stringify(found));
 for(const job of found)await core.undoOrganization(job.root,job.id);
 assert.deepEqual(await snapshot(drive),before);
 assert.deepEqual(await jobs(photos,videos),[]);
});

test('finalize releases kept originals, and a later layout supersedes the earlier journal without losing a byte',async t=>{
 const {drive,photos,videos,files}=await library(t);
 const contents=new Set(Object.values(files).map(content=>content));
 const first=await organize(drive,photos,videos,'format','copy');
 for(const result of first.results)assert.deepEqual(result.errors,[]);
 const [job]=await jobs(photos);assert.ok(job?.finalizable&&job.retainedFiles,JSON.stringify(job));
 // A second layout before finalizing supersedes the first journal; only the newest is listed.
 const second=await organize(drive,photos,videos,'type-format','copy');
 for(const result of second.results)assert.deepEqual(result.errors,[]);
 const listed=await jobs(photos);assert.equal(listed.length,1);assert.notEqual(listed[0]!.id,job.id);
 await assert.rejects(core.finalizeOrganization(photos,job.id),/superseded/);
 const released=await core.finalizeOrganization(photos,listed[0]!.id);
 assert.equal(released.removed,listed[0]!.retainedFiles);
 assert.equal(await misplaced(drive,photos,videos,'type-format'),0);
 // Outside the recovery store each photobackup file appears once; superseded originals stay retained.
 const visible=[...(await tree(photos)).keys()].filter(relative=>!relative.endsWith('.txt'));
 assert.equal(visible.length,Object.keys(files).filter(name=>name.startsWith('photobackup/')).length);
 const store=await fs.readdir(path.join(photos,'Photo Importer Recovery'),{recursive:true});
 assert.ok(store.length>0);
 for(const relative of visible)assert.ok(contents.has(await fs.readFile(path.join(photos,relative),'utf8')),relative);
 await assert.rejects(core.undoOrganization(photos,listed[0]!.id),/released|cannot be undone/);
});

test('an organization stopped part-way resumes, and an undo stopped part-way finishes on the next try',async t=>{
 const {drive,photos,videos}=await library(t);
 const before=await snapshot(drive);
 const control=new AbortController();let seen=0;
 const source=photos,{plans:[transfer]}=await core.plan(source,[photos],settings('type-format',photos,videos),metadata);
 await assert.rejects(core.executeReorganization(transfer!,control.signal,()=>{if(++seen===3)control.abort();},{strategy:'rename'}),{name:'AbortError'});
 const [stopped]=await jobs(photos);assert.equal(stopped?.status,'pending');
 const resumed=await core.resumeOrganization(photos,stopped.id);assert.deepEqual(resumed.errors,[]);
 assert.equal((await jobs(photos))[0]?.status,'complete');
 assert.equal(await misplaced(drive,photos,videos,'type-format'),0);
 const undo=new AbortController();let restoring=0;
 await assert.rejects(core.undoOrganization(photos,stopped.id,undo.signal,progress=>{if(progress.step==='restoring'&&++restoring===4)undo.abort();}),{name:'AbortError'});
 await core.undoOrganization(photos,stopped.id);
 assert.deepEqual(await snapshot(drive),before);
});

test('two organizations started at once on one library: the second waits or refuses, and nothing is lost',async t=>{
 const {drive,photos,videos}=await library(t);
 const contents=new Set((await tree(drive)).values());
 const plans:TransferPlan[]=[];
 for(const layout of ['format','flat'] as const)plans.push((await core.plan(photos,[photos],settings(layout,photos,videos),metadata)).plans[0]!);
 const outcomes=await Promise.allSettled(plans.map(transfer=>core.executeReorganization(transfer,undefined,undefined,{strategy:'rename'})));
 // The first runs; the second, reviewed before the first moved anything, finds its files moved and stops.
 assert.equal(outcomes[0]!.status,'fulfilled');
 if(outcomes[0]!.status==='fulfilled')assert.deepEqual(outcomes[0]!.value.errors,[]);
 const second=outcomes[1]!;
 assert.ok(second.status==='rejected'||second.value.errors.length>0||second.value.moved===0,JSON.stringify(second));
 const after=await tree(drive);
 assert.deepEqual(new Set(after.values()),contents);
 for(const job of await jobs(photos))assert.equal(job.error,undefined,JSON.stringify(job));
});
