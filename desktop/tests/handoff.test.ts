import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as core from '../core/index';
import type {Metadata} from '../shared';

// The A006 pair: library organization A (photobackup) was stopped part-way; an older build then ran
// organization B (videobackup), which moved some of A's already-moved videos on into videobackup
// without seeing A. A's moved files are missing from its destinations, yet B's signed, complete
// journal records each one moving from that exact path, with the same inode, size and SHA-256.
core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2026-10-03T12:00:00',fields:{}});
const base={backup:false,template:'{year}/{yyyymm}/{camera}',unknownRules:{}};
const camera='2026/202610/Sony A7';
const names=['C0016.MOV','C0017.MOV','A.JPG','B.JPG','D.JPG'];

async function pair(t:test.TestContext,{strategy='rename',finishA=false,finalizeA=false,from='2025'}:{strategy?:core.OrganizationStrategy;finishA?:boolean;finalizeA?:boolean;from?:string}={}){
 const drive=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'handoff-')));
 t.after(()=>fs.rm(drive,{recursive:true,force:true}));
 const photos=path.join(drive,'photobackup'),videos=path.join(drive,'videobackup'),card=path.join(drive,from);
 for(const folder of [photos,videos,card])await fs.mkdir(folder,{recursive:true});
 for(const name of names)await fs.writeFile(path.join(card,name),'bytes of '+name);
 // A: the card folder into photobackup, stopped right after its first video moved (unless finished).
 const a=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:[from.split('/')[0]!]},metadata)).plans[0]!;
 const controller=new AbortController();
 const run=core.executeReorganization(a,finishA?undefined:controller.signal,finishA?undefined:value=>{if(value.step==='moving'&&/\.MOV$/i.test(value.file))controller.abort();},{strategy});
 if(finishA)assert.deepEqual((await run).errors,[]);else await assert.rejects(run,{name:'AbortError'});
 const [journal]=await core.getOrganizationRecovery(photos);const A=journal!.id;
 if(finalizeA)assert.ok((await core.finalizeOrganization(photos,A)).removed>0);
 // The older build that ran B could not see A: hide A's journal from this build while B runs.
 const store=path.join(photos,'Photo Importer Recovery',A),hidden=path.join(drive,'hidden-'+A);
 await fs.rename(store,hidden);
 const {plans:[split]}=await core.plan(drive,[photos],{...base,layout:'video-root',videoRoots:[videos],sourceFolders:['photobackup','videobackup'],reorganize:true},metadata);
 assert.deepEqual((await core.executeReorganization(split!.videos!,undefined,undefined,{strategy:'rename'})).errors,[]);
 await fs.mkdir(path.dirname(store),{recursive:true});await fs.rename(hidden,store);
 const [later]=await core.getOrganizationRecovery(videos);
 const handed=(await fs.readdir(path.join(videos,camera)).catch(()=>[] as string[])).filter(name=>names.includes(name));
 assert.ok(handed.length>0,'B moved at least one of A\'s videos on');
 return {drive,photos,videos,card,A,B:later!.id,handed};
}
const job=async(root:string,id:string)=>(await core.getOrganizationRecovery(root)).find(item=>item.id===id);

test('the earlier journal is listed without an error when a later complete journal moved its files on',async t=>{
 const {photos,A}=await pair(t);
 const listed=await job(photos,A);
 assert.ok(listed,'still listed');assert.equal(listed!.error,undefined);assert.equal(listed!.status,'pending');
});

test('resuming the earlier journal hands the moved-on files to the later journal and finishes the rest',async t=>{
 const {photos,videos,card,A,B,handed}=await pair(t);
 const result=await core.resumeOrganization(photos,A);
 assert.deepEqual(result.errors,[]);
 for(const name of handed)assert.equal(await fs.readFile(path.join(videos,camera,name),'utf8'),'bytes of '+name,'left where the later organization put it');
 for(const name of names.filter(name=>!handed.includes(name)))assert.equal(await fs.readFile(path.join(photos,camera,name),'utf8'),'bytes of '+name);
 for(const name of names)await assert.rejects(fs.stat(path.join(card,name)),{code:'ENOENT'});
 assert.equal((await job(photos,A))?.status,'complete');assert.equal((await job(photos,A))?.error,undefined);
 // The later journal is untouched and still checks out.
 assert.deepEqual((await core.resumeOrganization(videos,B)).errors,[]);
});

test('undoing the earlier journal puts back its own files and leaves the handed-off ones with the later journal',async t=>{
 const {photos,videos,card,A,B,handed}=await pair(t);
 const undone=await core.undoOrganization(photos,A);
 assert.equal(undone.handedOff,handed.length);
 for(const name of handed)await fs.access(path.join(videos,camera,name));
 const moved=(await fs.readdir(card)).filter(name=>names.includes(name));
 assert.ok(moved.length>0&&!moved.some(name=>handed.includes(name)),'its other moved files are back in the card folder');
 assert.equal(await job(photos,A),undefined,'fully undone');
 assert.deepEqual((await core.resumeOrganization(videos,B)).errors,[]);
});

test('finalizing keeps the retained original of a handed-off file and releases the others',async t=>{
 const {photos,A,handed}=await pair(t,{strategy:'copy',finishA:true});
 const before=await job(photos,A);assert.equal(before?.error,undefined);
 const kept=await core.finalizeOrganization(photos,A);
 assert.equal(kept.removed,names.length-handed.length,'every other kept original is released');
 const store=path.join(photos,'Photo Importer Recovery',A,'originals');
 const left=(await fs.readdir(store,{recursive:true})).map(String).filter(file=>handed.includes(path.basename(file)));
 assert.equal(left.length,handed.length,'the handed-off files keep their originals');
});

test('no hand-off when the file at the later destination is not the one that left',async t=>{
 const {photos,videos,A,handed}=await pair(t);
 const file=path.join(videos,camera,handed[0]!),bytes=await fs.readFile(file);
 await fs.rm(file);await fs.writeFile(file,Buffer.alloc(bytes.length,7));
 assert.match((await job(photos,A))?.error??'',/Moved file changed or is missing/);
 assert.match((await core.resumeOrganization(photos,A)).errors.join(' '),/Moved file changed or is missing/);
});

test('when the later journal is undone, the file is back where the earlier one expects it',async t=>{
 const {photos,videos,A,B}=await pair(t);
 await core.undoOrganization(videos,B);
 assert.deepEqual((await core.resumeOrganization(photos,A)).errors,[]);
 assert.equal((await job(photos,A))?.status,'complete');
});

test('rechecking the later journal after the earlier one finished never supersedes it',async t=>{
 const {photos,videos,A,B}=await pair(t,{strategy:'copy',finishA:true});
 assert.deepEqual((await core.resumeOrganization(photos,A)).errors,[]);
 assert.deepEqual((await core.resumeOrganization(videos,B)).errors,[]);
 const listed=await job(photos,A);
 assert.ok(listed,'the earlier journal stays listed');assert.equal(listed!.error,undefined);
 // Its kept originals stay releasable.
 const released=await core.finalizeOrganization(photos,A);assert.ok(released.removed>0);
});

test('resuming the earlier journal never supersedes the later one that moved files back to its sources',async t=>{
 // A pulled videos out of videobackup's dated folders; B (older build) moved them back to the same paths.
 const {photos,videos,A,B}=await pair(t,{from:'videobackup/'+camera});
 assert.deepEqual((await core.resumeOrganization(photos,A)).errors,[]);
 const later=await job(videos,B);
 assert.ok(later,'the later journal stays listed');assert.equal(later!.error,undefined);
 assert.ok((await core.undoOrganization(videos,B)).restored>0,'and can still be undone');
});

test('undo reports a handed-off file as missing when it is gone from both places',async t=>{
 const {photos,videos,A,B,handed}=await pair(t);
 assert.deepEqual((await core.resumeOrganization(photos,A)).errors,[]);
 await core.undoOrganization(videos,B);
 await fs.rm(path.join(photos,camera,handed[0]!));
 await assert.rejects(core.undoOrganization(photos,A),/no longer where this organization put it/);
});

test('like A006: a finished, finalized journal whose copies were moved on lists and rechecks cleanly',async t=>{
 // A copied, kept and then released its originals; B later moved some of A's copies on.
 const {photos,A}=await pair(t,{strategy:'copy',finishA:true,finalizeA:true});
 // Journals from that build recorded no 'published' event for a copy.
 const log=path.join(photos,'Photo Importer Recovery',A,'event-log.jsonl');
 await fs.writeFile(log,(await fs.readFile(log,'utf8')).split('\n').filter(line=>!line.includes('"event":"published"')).join('\n'));
 const listed=await job(photos,A);
 assert.equal(listed?.error,undefined);assert.equal(listed?.status,'complete');
 assert.deepEqual((await core.resumeOrganization(photos,A)).errors,[]);
 assert.equal((await job(photos,A))?.error,undefined);
 // Finalizing again is harmless: the moved-on copies are left to the later organization.
 const again=await core.finalizeOrganization(photos,A);assert.equal(again.removed,0);assert.ok(again.handedOff>0);
});

async function finished(t:test.TestContext,strategy:core.OrganizationStrategy='rename',release=false){
 const drive=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'handoff-')));
 t.after(()=>fs.rm(drive,{recursive:true,force:true}));
 const photos=path.join(drive,'photobackup'),card=path.join(drive,'2025');
 for(const folder of [photos,card])await fs.mkdir(folder,{recursive:true});
 for(const name of names)await fs.writeFile(path.join(card,name),'bytes of '+name);
 const a=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(a,undefined,undefined,{strategy})).errors,[]);
 const [journal]=await core.getOrganizationRecovery(photos);
 if(release)assert.ok((await core.finalizeOrganization(photos,journal!.id)).removed>0);
 // Moved away by hand, with no journal recording it.
 const gone=path.join(photos,camera,'C0016.MOV');await fs.rename(gone,path.join(drive,'elsewhere.MOV'));
 return {drive,photos,A:journal!.id,gone};
}

for(const [strategy,release] of [['rename',false],['copy',true]] as const)test(`a finished${release?', released':''} journal whose file vanished with no later organization is listed with that file counted missing`,async t=>{
 const {drive,photos,A}=await finished(t,strategy,release);
 // It may be the only copy: the job stays pending, and the listing counts it instead of stopping at it.
 const listed=await job(photos,A);
 assert.equal(listed?.error,undefined);assert.equal(listed?.status,'pending');assert.equal(listed?.missing,1);assert.equal(listed?.completed,names.length-1);
 // It never blocks a new organization either.
 const next=(await core.plan(drive,[photos],{...base,template:'{year}/{camera}',layout:'flat',reorganize:true,sourceFolders:['photobackup']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(next,undefined,undefined,{strategy:'rename'})).errors,[]);
});

test('undoing a finished journal whose file was later moved away names that file and changes nothing',async t=>{
 const {photos,A,gone}=await finished(t);
 await assert.rejects(core.undoOrganization(photos,A),error=>error instanceof Error&&error.message.includes(gone)&&/1 organized file/.test(error.message));
 for(const name of names.filter(name=>name!=='C0016.MOV'))await fs.access(path.join(photos,camera,name));
});
