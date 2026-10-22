import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHmac} from 'node:crypto';
import * as core from '../core/index';
import type {Metadata} from '../shared';

// A library first organized into one backup folder, then split into photobackup and videobackup:
// the video's later journal lives in the sibling videobackup and must supersede the earlier one.
const secret='fixture-only-host-recovery-secret-32bytes';
core.configureOrganizationRecovery(secret);
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2026-10-03T12:00:00',fields:{}});
const base={backup:false,template:'{year}/{yyyymm}/{camera}',unknownRules:{}};
const camera='2026/202610/Sony A7';
const log=(root:string,id:string)=>path.join(root,'Photo Importer Recovery',id,'event-log.jsonl');

async function fixture(t:test.TestContext,photo=false){
 const drive=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'video-root-journal-')));
 t.after(()=>fs.rm(drive,{recursive:true,force:true}));
 const photos=path.join(drive,'photobackup'),videos=path.join(drive,'videobackup'),other=path.join(drive,'otherbackup');
 for(const folder of [photos,videos,other,path.join(drive,'2025')])await fs.mkdir(folder,{recursive:true});
 await fs.writeFile(path.join(drive,'2025','C0016.MOV'),'bytes of a Sony clip');
 if(photo)await fs.writeFile(path.join(drive,'2025','A.JPG'),'a photo');
 // First: the year folder organized into photobackup, journaled there.
 const first=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(first,undefined,undefined,{strategy:'rename'})).errors,[]);
 const [earlier]=await core.getOrganizationRecovery(photos);
 return {drive,photos,videos,other,earlier:earlier!.id};
}
async function split(drive:string,photos:string,videos:string,strategy:core.OrganizationStrategy='rename'){
 const {plans:[second]}=await core.plan(drive,[photos],{...base,layout:'video-root',videoRoots:[videos],sourceFolders:['photobackup','videobackup'],reorganize:true},metadata);
 for(const part of [second!,second!.videos!])assert.deepEqual((await core.executeReorganization(part,undefined,undefined,{strategy})).errors,[]);
 const [later]=await core.getOrganizationRecovery(videos);
 return later!.id;
}
/** A host-signed superseded event, as only this app could write it. */
async function supersededEvent(root:string,id:string,extra:Record<string,unknown>){
 const record={id,root,event:'superseded',...extra};
 await fs.appendFile(log(root,id),JSON.stringify({...record,seal:createHmac('sha256',secret).update(JSON.stringify(record)).digest('hex')})+'\n');
}

test('a journal in the sibling video folder supersedes the earlier photo-folder journal for resume, undo and finalize',async t=>{
 const {drive,photos,videos,earlier}=await fixture(t);
 const later=await split(drive,photos,videos);
 await fs.access(path.join(videos,camera,'C0016.MOV'));
 assert.deepEqual((await core.getOrganizationRecovery(photos)).filter(job=>job.error),[]);
 assert.ok(!(await core.getOrganizationRecovery(photos)).some(job=>job.id===earlier),'the earlier journal is hidden as superseded');
 const superseded=new RegExp(`superseded by ${later}`);
 await assert.rejects(core.resumeOrganization(photos,earlier),superseded);
 await assert.rejects(core.undoOrganization(photos,earlier),superseded);
 await assert.rejects(core.finalizeOrganization(photos,earlier),superseded);
 // The successor itself still resumes and undoes normally, back into the photo folder.
 assert.deepEqual((await core.resumeOrganization(videos,later)).errors,[]);
 assert.equal((await core.undoOrganization(videos,later)).restored,1);
 assert.equal(await fs.readFile(path.join(photos,camera,'C0016.MOV'),'utf8'),'bytes of a Sony clip');
});

test('the successor journal can also be finalized from the sibling folder',async t=>{
 const {drive,photos,videos,earlier}=await fixture(t);
 // Copy-and-keep leaves the moved clip's original in the video folder's recovery store to release.
 const later=await split(drive,photos,videos,'copy');
 assert.deepEqual(await core.finalizeOrganization(videos,later),{removed:1,bytes:Buffer.byteLength('bytes of a Sony clip'),finalized:1});
 await assert.rejects(core.finalizeOrganization(photos,earlier),/superseded by/);
});

test('a successor in another folder that relocates none of the journal\'s files is refused',async t=>{
 const {drive,photos,other,earlier}=await fixture(t);
 // A real, signed journal in another backup folder that never listed photobackup.
 await fs.mkdir(path.join(drive,'2024'));await fs.writeFile(path.join(drive,'2024','B.JPG'),'another photo');
 const unrelated=(await core.plan(drive,[other],{...base,layout:'flat',reorganize:true,sourceFolders:['2024']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(unrelated,undefined,undefined,{strategy:'rename'})).errors,[]);
 const [stranger]=await core.getOrganizationRecovery(other);
 await supersededEvent(photos,earlier,{successor:stranger!.id,successorRoot:other});
 const visible=(await core.getOrganizationRecovery(photos)).find(job=>job.id===earlier);
 assert.equal(visible!.id,earlier);assert.match(visible!.error!,/does not relocate a prior destination/);
 for(const operation of [core.resumeOrganization,core.undoOrganization,core.finalizeOrganization])await assert.rejects(operation(photos,earlier),/does not relocate a prior destination/);
});

for(const root of ['own','relative','unknown-journal'] as const)test(`a successor ${root==='unknown-journal'?'with no journal in its folder':root==='own'?'in the journal\'s own folder':'given as a relative folder'} is refused`,async t=>{
 const {drive,photos,videos,earlier}=await fixture(t);
 const successorRoot=root==='own'?photos:root==='relative'?'videobackup':videos;
 await supersededEvent(photos,earlier,{successor:'00000000-0000-4000-8000-000000000000',successorRoot});
 const visible=(await core.getOrganizationRecovery(photos)).find(job=>job.id===earlier);
 assert.equal(visible!.id,earlier);assert.ok(visible!.error,`${root}: reported`);
 await assert.rejects(core.resumeOrganization(photos,earlier),root==='unknown-journal'?{code:'ENOENT'}:/successor/);
 assert.ok(drive);
});

test('a tampered successor folder in a signed event is refused',async t=>{
 const {drive,photos,videos,other,earlier}=await fixture(t);
 await split(drive,photos,videos);
 const file=log(photos,earlier),text=await fs.readFile(file,'utf8');
 assert.ok(text.includes(videos));
 await fs.writeFile(file,text.replaceAll(JSON.stringify(videos),JSON.stringify(other)));
 const visible=(await core.getOrganizationRecovery(photos)).find(job=>job.id===earlier);
 assert.equal(visible!.id,earlier);assert.match(visible!.error!,/authentication/);
 await assert.rejects(core.resumeOrganization(photos,earlier),/authentication/);
});

test('removing the video folder later never blocks organizing the photo folder, and the earlier journal stays visible',async t=>{
 const {drive,photos,videos,earlier}=await fixture(t);
 await split(drive,photos,videos);
 // Back to one folder: the user renames videobackup away.
 await fs.rename(videos,path.join(drive,'videobackup-old'));
 await fs.mkdir(path.join(drive,'2024'));await fs.writeFile(path.join(drive,'2024','B.JPG'),'another photo');
 const next=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2024']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(next,undefined,undefined,{strategy:'rename'})).errors,[]);
 await fs.access(path.join(photos,camera,'B.JPG'));
 // Its successor is gone, so the earlier journal is reported, not hidden.
 const visible=(await core.getOrganizationRecovery(photos)).find(job=>job.id===earlier);
 assert.ok(visible?.error,'the earlier journal is listed with its error');
});

test('an unfinished journal in the photo folder blocks the video folder from moving its files',async t=>{
 const drive=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'video-root-journal-')));
 t.after(()=>fs.rm(drive,{recursive:true,force:true}));
 const photos=path.join(drive,'photobackup'),videos=path.join(drive,'videobackup');
 for(const folder of [photos,videos,path.join(drive,'2025')])await fs.mkdir(folder,{recursive:true});
 for(const name of ['C0016.MOV','C0017.MOV'])await fs.writeFile(path.join(drive,'2025',name),'bytes of '+name);
 // A flat organization stopped after its first file: its journal in photobackup is unfinished.
 const first=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata)).plans[0]!;
 const controller=new AbortController();
 await assert.rejects(core.executeReorganization(first,controller.signal,progress=>{if(progress.completed>=1)controller.abort();},{strategy:'rename'}),{name:'AbortError'});
 const {plans:[second]}=await core.plan(drive,[photos],{...base,layout:'video-root',videoRoots:[videos],sourceFolders:['photobackup','videobackup','2025'],reorganize:true},metadata);
 const result=await core.executeReorganization(second!.videos!,undefined,undefined,{strategy:'rename'});
 assert.match(result.errors.join(' '),/Finish organization .* overlapping/);
 assert.deepEqual(await fs.readdir(videos).then(names=>names.filter(name=>name!=='Photo Importer Recovery')),[],'nothing moved into the video folder');
});

test('after the video folder is removed, the photo folder can still be re-templated over the earlier journal\'s files',async t=>{
 // The earlier journal placed both the clip and A.JPG; only the clip moves on to videobackup.
 const {drive,photos,videos,earlier}=await fixture(t,true);
 await split(drive,photos,videos);
 await fs.rm(videos,{recursive:true,force:true});
 // A new template moves photobackup's files, including the folder the superseded journal recorded.
 const next=(await core.plan(drive,[photos],{...base,template:'{year}/{camera}',layout:'flat',reorganize:true,sourceFolders:['photobackup']},metadata)).plans[0]!;
 assert.ok(next.entries.length>0);
 assert.deepEqual((await core.executeReorganization(next,undefined,undefined,{strategy:'rename'})).errors,[]);
 await fs.access(path.join(photos,'2026/Sony A7/A.JPG'));
 assert.ok((await core.getOrganizationRecovery(photos)).find(job=>job.id===earlier)?.error,'the earlier journal stays listed with its error');
});

async function clips(t:test.TestContext){
 const drive=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'video-root-journal-')));
 t.after(()=>fs.rm(drive,{recursive:true,force:true}));
 const photos=path.join(drive,'photobackup'),videos=path.join(drive,'videobackup');
 for(const folder of [photos,videos,path.join(drive,'2025')])await fs.mkdir(folder,{recursive:true});
 for(const name of ['C0016.MOV','C0017.MOV','A.JPG','B.JPG'])await fs.writeFile(path.join(drive,'2025',name),'bytes of '+name);
 const first=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(first,undefined,undefined,{strategy:'rename'})).errors,[]);
 return {drive,photos,videos};
}
const stopAfterFirstMove=()=>{const controller=new AbortController();return {signal:controller.signal,progress:(value:{step?:string;completed:number})=>{if(value.step==='moving'&&value.completed>=1)controller.abort();}};};

test('an unfinished video-folder journal is found through the earlier journal it superseded, and blocks a photo-folder organization',async t=>{
 const {drive,photos,videos}=await clips(t);
 const {plans:[split]}=await core.plan(drive,[photos],{...base,layout:'video-root',videoRoots:[videos],sourceFolders:['photobackup','videobackup'],reorganize:true},metadata);
 const stop=stopAfterFirstMove();
 await assert.rejects(core.executeReorganization(split!.videos!,stop.signal,stop.progress,{strategy:'rename'}),{name:'AbortError'});
 const [unfinished]=await core.getOrganizationRecovery(videos);
 // A flat re-template of photobackup lists no sibling, yet would move the clip the video journal still owns.
 const next=(await core.plan(drive,[photos],{...base,template:'{year}/{camera}',layout:'flat',reorganize:true,sourceFolders:['photobackup']},metadata)).plans[0]!;
 const result=await core.executeReorganization(next,undefined,undefined,{strategy:'rename'});
 assert.match(result.errors.join(' '),new RegExp(`Finish organization ${unfinished!.id}`));
 assert.equal(result.moved,0);
 // The blocked organization moved nothing; undoing its empty journal lets the video journal finish.
 const blocked=(await core.getOrganizationRecovery(photos)).find(job=>job.status==='pending')!;
 await core.undoOrganization(photos,blocked.id);
 assert.deepEqual((await core.resumeOrganization(videos,unfinished!.id)).errors,[],'the video journal still resumes');
 await fs.access(path.join(videos,camera,'C0017.MOV'));
});

test('a superseded journal an older version left unfinished never blocks later organizations',async t=>{
 const {drive,photos}=await clips(t);
 const retemplate=(template:string)=>core.plan(drive,[photos],{...base,template,layout:'flat',reorganize:true,sourceFolders:['photobackup']},metadata).then(result=>result.plans[0]!);
 const stop=stopAfterFirstMove();
 await assert.rejects(core.executeReorganization(await retemplate('{year}/{camera}'),stop.signal,stop.progress,{strategy:'rename'}),{name:'AbortError'});
 const unfinished=(await core.getOrganizationRecovery(photos)).find(job=>job.status==='pending')!;
 // Nothing can resume, undo or finalize a superseded journal, so blocking on it would block for good.
 await supersededEvent(photos,unfinished.id,{successor:'00000000-0000-4000-8000-000000000000'});
 await assert.rejects(core.resumeOrganization(photos,unfinished.id),/superseded/);
 const result=await core.executeReorganization(await retemplate('{camera}/{year}'),undefined,undefined,{strategy:'rename'});
 assert.deepEqual(result.errors,[]);assert.ok(result.moved>0);
});

test('a successor folder replaced by a link since is skipped, not refused, when this plan does not list it',async t=>{
 const {drive,photos,videos}=await clips(t);
 const {plans:[split]}=await core.plan(drive,[photos],{...base,layout:'video-root',videoRoots:[videos],sourceFolders:['photobackup','videobackup'],reorganize:true},metadata);
 for(const part of [split!.videos!,split!])assert.deepEqual((await core.executeReorganization(part,undefined,undefined,{strategy:'rename'})).errors,[]);
 const elsewhere=path.join(drive,'elsewhere');await fs.rename(videos,elsewhere);await fs.symlink(elsewhere,videos);
 const next=(await core.plan(drive,[photos],{...base,template:'{year}/{camera}',layout:'flat',reorganize:true,sourceFolders:['photobackup']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(next,undefined,undefined,{strategy:'rename'})).errors,[]);
});

test('a fully undone journal no longer blocks an overlapping organization',async t=>{
 const {drive,photos}=await clips(t);
 const [done]=await core.getOrganizationRecovery(photos);
 await core.undoOrganization(photos,done!.id);
 const again=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(again,undefined,undefined,{strategy:'rename'})).errors,[]);
});

test('a partly undone journal blocks an overlapping organization instead of losing the rest of its undo',async t=>{
 const {drive,photos}=await clips(t);
 const [done]=await core.getOrganizationRecovery(photos);
 const controller=new AbortController();
 await assert.rejects(core.undoOrganization(photos,done!.id,controller.signal,progress=>{if(progress.step==='restoring'&&progress.completed>=2)controller.abort();}),{name:'AbortError'});
 const next=(await core.plan(drive,[photos],{...base,template:'{year}/{camera}',layout:'flat',reorganize:true,sourceFolders:['photobackup']},metadata)).plans[0]!;
 assert.ok(next.entries.length>0);
 const result=await core.executeReorganization(next,undefined,undefined,{strategy:'rename'});
 assert.match(result.errors.join(' '),new RegExp(`Finish organization ${done!.id}`));
 assert.equal(result.moved,0);
 assert.ok((await core.undoOrganization(photos,done!.id)).restored>0,'its undo still finishes');
});

test('a sibling backup folder that now resolves elsewhere stops the organization',async t=>{
 const {drive,photos,videos}=await clips(t);
 const {plans:[split]}=await core.plan(drive,[photos],{...base,template:'{year}/{camera}',layout:'video-root',videoRoots:[videos],sourceFolders:['photobackup','videobackup'],reorganize:true},metadata);
 assert.ok(split!.entries.length>0);
 const stop=stopAfterFirstMove();
 await assert.rejects(core.executeReorganization(split!,stop.signal,stop.progress,{strategy:'rename'}),{name:'AbortError'});
 const job=(await core.getOrganizationRecovery(photos)).find(item=>item.status==='pending')!;
 const elsewhere=path.join(drive,'elsewhere');await fs.mkdir(elsewhere);
 await fs.rm(videos,{recursive:true});await fs.symlink(elsewhere,videos);
 const resumed=await core.resumeOrganization(photos,job.id);
 assert.match(resumed.errors.join(' '),/Unsafe sibling backup folder/);assert.equal(resumed.moved,0);
});

/** Files imported straight into photobackup, so no organization journal is there yet. */
async function imported(t:test.TestContext){
 const drive=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'video-root-journal-')));
 t.after(()=>fs.rm(drive,{recursive:true,force:true}));
 const photos=path.join(drive,'photobackup'),videos=path.join(drive,'videobackup');
 for(const folder of [photos,videos])await fs.mkdir(folder,{recursive:true});
 for(const name of ['C0016.MOV','C0017.MOV','A.JPG','B.JPG'])await fs.writeFile(path.join(photos,name),'bytes of '+name);
 return {drive,photos,videos};
}
for(const photoFirst of [true,false])test(`a stopped video-folder journal blocks a photo-folder organization ${photoFirst?'found through the photo journal\'s sibling list':'found through its pointer, with no photo journal'}`,async t=>{
 const {drive,photos,videos}=await imported(t);
 // App order: the photo part completes first, listing videobackup; here also the case with no photo journal.
 const {plans:[split]}=await core.plan(drive,[photos],{...base,layout:'video-root',videoRoots:[videos],sourceFolders:['photobackup','videobackup'],reorganize:true},metadata);
 if(photoFirst)assert.deepEqual((await core.executeReorganization(split!,undefined,undefined,{strategy:'rename'})).errors,[]);
 const stop=stopAfterFirstMove();
 await assert.rejects(core.executeReorganization(split!.videos!,stop.signal,stop.progress,{strategy:'rename'}),{name:'AbortError'});
 const [stopped]=await core.getOrganizationRecovery(videos);
 const next=(await core.plan(drive,[photos],{...base,template:'{year}/{camera}',layout:'flat',reorganize:true,sourceFolders:['photobackup']},metadata)).plans[0]!;
 const result=await core.executeReorganization(next,undefined,undefined,{strategy:'rename'});
 assert.match(result.errors.join(' '),new RegExp(`Finish organization ${stopped!.id}`));
 assert.equal(result.moved,0);
 const blocked=(await core.getOrganizationRecovery(photos)).find(job=>job.status==='pending')!;
 await core.undoOrganization(photos,blocked.id);
 assert.deepEqual((await core.resumeOrganization(videos,stopped!.id)).errors,[]);
 for(const name of ['C0016.MOV','C0017.MOV'])assert.equal(await fs.readFile(path.join(videos,camera,name),'utf8'),'bytes of '+name);
 // Once finished, the video journal no longer blocks the photo folder.
 const after=(await core.plan(drive,[photos],{...base,template:'{year}/{camera}',layout:'flat',reorganize:true,sourceFolders:['photobackup']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(after,undefined,undefined,{strategy:'rename'})).errors,[]);
});

test('a sibling folder renamed only by case is refused, not skipped',async t=>{
 const {drive,photos,videos}=await imported(t);
 const {plans:[split]}=await core.plan(drive,[photos],{...base,layout:'video-root',videoRoots:[videos],sourceFolders:['photobackup','videobackup'],reorganize:true},metadata);
 const stop=stopAfterFirstMove();
 await assert.rejects(core.executeReorganization(split!.videos!,stop.signal,stop.progress,{strategy:'rename'}),{name:'AbortError'});
 const renamed=path.join(drive,'VideoBackup');await fs.rename(videos,renamed);
 if(await fs.realpath(videos).catch(()=>undefined)!==renamed){t.skip('case-sensitive filesystem');return;}
 const next=(await core.plan(drive,[photos],{...base,template:'{year}/{camera}',layout:'flat',reorganize:true,sourceFolders:['photobackup']},metadata)).plans[0]!;
 const result=await core.executeReorganization(next,undefined,undefined,{strategy:'rename'});
 assert.match(result.errors.join(' '),/Unsafe sibling backup folder/);assert.equal(result.moved,0);
});

for(const kind of ['undo','finalize'] as const)test(`a ${kind} of the earlier journal racing a new organization never loses a file`,async t=>{
 const drive=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'video-root-journal-')));
 t.after(()=>fs.rm(drive,{recursive:true,force:true}));
 const photos=path.join(drive,'photobackup');
 for(const folder of [photos,path.join(drive,'2025')])await fs.mkdir(folder,{recursive:true});
 const names=['A.JPG','B.JPG','C.JPG'];for(const name of names)await fs.writeFile(path.join(drive,'2025',name),'bytes of '+name);
 const strategy=kind==='finalize'?'copy':'rename';
 const first=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(first,undefined,undefined,{strategy})).errors,[]);
 const [prior]=await core.getOrganizationRecovery(photos);
 const next=(await core.plan(drive,[photos],{...base,template:'{year}/{camera}',layout:'flat',reorganize:true,sourceFolders:['photobackup']},metadata)).plans[0]!;
 // Starts while the new organization is checking earlier journals, before it takes the earlier journal's lock.
 let raced:Promise<unknown>|undefined;
 const result=await core.executeReorganization(next,undefined,value=>{if(value.step==='earlier'&&!raced)raced=(kind==='undo'?core.undoOrganization(photos,prior!.id):core.finalizeOrganization(photos,prior!.id)).then(value=>value,error=>error);},{strategy:'rename'});
 const other=await raced;assert.ok(other!==undefined,'the race was started');
 if(kind==='undo'){
  // The undo wins: the files are back on the card folder, and the new organization moved nothing.
  assert.ok(!(other instanceof Error),String(other));assert.equal(result.moved,0);
  for(const name of names)assert.equal(await fs.readFile(path.join(drive,'2025',name),'utf8'),'bytes of '+name);
 } else {
  // Finalizing a finished journal and then superseding it are both safe.
  assert.ok(!(other instanceof Error),String(other));assert.deepEqual(result.errors,[]);
  for(const name of names)assert.equal(await fs.readFile(path.join(photos,'2026/Sony A7',name),'utf8'),'bytes of '+name);
 }
 // Every photo exists exactly once outside the recovery store.
 const all=(await fs.readdir(drive,{recursive:true})).map(String).filter(file=>!file.includes('Photo Importer Recovery')&&names.includes(path.basename(file)));
 assert.equal(all.length,names.length,all.join(', '));
});

test('a tampered sibling pointer stops the organization instead of hiding a journal',async t=>{
 const {drive,photos,videos}=await imported(t);
 const {plans:[split]}=await core.plan(drive,[photos],{...base,layout:'video-root',videoRoots:[videos],sourceFolders:['photobackup','videobackup'],reorganize:true},metadata);
 const stop=stopAfterFirstMove();
 await assert.rejects(core.executeReorganization(split!.videos!,stop.signal,stop.progress,{strategy:'rename'}),{name:'AbortError'});
 const folder=path.join(photos,'Photo Importer Recovery'),[name]=(await fs.readdir(folder)).filter(item=>item.startsWith('journal-'));
 const file=path.join(folder,name!),pointer=JSON.parse(await fs.readFile(file,'utf8'));
 await fs.writeFile(file,JSON.stringify({...pointer,root:path.join(drive,'elsewhere')}));
 const next=(await core.plan(drive,[photos],{...base,template:'{year}/{camera}',layout:'flat',reorganize:true,sourceFolders:['photobackup']},metadata)).plans[0]!;
 const result=await core.executeReorganization(next,undefined,undefined,{strategy:'rename'});
 assert.match(result.errors.join(' '),/authentication/);assert.equal(result.moved,0);
});

test('a single-folder organization that pulls files out of the video folder supersedes its journal cleanly',async t=>{
 const {drive,photos,videos}=await imported(t);
 const {plans:[split]}=await core.plan(drive,[photos],{...base,layout:'video-root',videoRoots:[videos],sourceFolders:['photobackup','videobackup'],reorganize:true},metadata);
 for(const part of [split!,split!.videos!])assert.deepEqual((await core.executeReorganization(part,undefined,undefined,{strategy:'rename'})).errors,[]);
 const [video]=await core.getOrganizationRecovery(videos);
 // Back to one folder: everything, videos included, moves into photobackup. This plan lists no sibling.
 const back=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['photobackup','videobackup']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(back,undefined,undefined,{strategy:'rename'})).errors,[]);
 for(const name of ['C0016.MOV','C0017.MOV'])await fs.access(path.join(photos,camera,name));
 assert.deepEqual((await core.getOrganizationRecovery(videos)).filter(job=>job.error),[],'the video journal is superseded, not broken');
 assert.ok(!(await core.getOrganizationRecovery(videos)).some(job=>job.id===video!.id));
 await assert.rejects(core.undoOrganization(videos,video!.id),/superseded by/);
});

test('a torn sibling pointer is rewritten by its own journal and names that journal while damaged',async t=>{
 const {drive,photos,videos}=await imported(t);
 const {plans:[split]}=await core.plan(drive,[photos],{...base,layout:'video-root',videoRoots:[videos],sourceFolders:['photobackup','videobackup'],reorganize:true},metadata);
 const stop=stopAfterFirstMove();
 await assert.rejects(core.executeReorganization(split!.videos!,stop.signal,stop.progress,{strategy:'rename'}),{name:'AbortError'});
 const [stopped]=await core.getOrganizationRecovery(videos);
 // As a full disk or power cut while writing could leave it.
 const pointer=path.join(photos,'Photo Importer Recovery',`journal-${stopped!.id}.json`);await fs.writeFile(pointer,'');
 const next=(await core.plan(drive,[photos],{...base,template:'{year}/{camera}',layout:'flat',reorganize:true,sourceFolders:['photobackup']},metadata)).plans[0]!;
 const blocked=await core.executeReorganization(next,undefined,undefined,{strategy:'rename'});
 assert.match(blocked.errors.join(' '),new RegExp(`resume organization ${stopped!.id}`));assert.equal(blocked.moved,0);
 await core.undoOrganization(photos,(await core.getOrganizationRecovery(photos)).find(job=>job.status==='pending')!.id);
 // Resuming the video journal repairs its pointer and finishes.
 assert.deepEqual((await core.resumeOrganization(videos,stopped!.id)).errors,[]);
 assert.ok((await fs.readFile(pointer,'utf8')).includes('sibling-journal'));
});
