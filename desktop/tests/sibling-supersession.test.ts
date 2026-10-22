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

test('a successor in a folder its journal does not list as a sibling is refused',async t=>{
 const {drive,photos,other,earlier}=await fixture(t);
 // A real, signed journal in another backup folder that never listed photobackup.
 await fs.mkdir(path.join(drive,'2024'));await fs.writeFile(path.join(drive,'2024','B.JPG'),'another photo');
 const unrelated=(await core.plan(drive,[other],{...base,layout:'flat',reorganize:true,sourceFolders:['2024']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(unrelated,undefined,undefined,{strategy:'rename'})).errors,[]);
 const [stranger]=await core.getOrganizationRecovery(other);
 await supersededEvent(photos,earlier,{successor:stranger!.id,successorRoot:other});
 const visible=(await core.getOrganizationRecovery(photos)).find(job=>job.id===earlier);
 assert.equal(visible!.id,earlier);assert.match(visible!.error!,/not in a listed sibling backup folder/);
 for(const operation of [core.resumeOrganization,core.undoOrganization,core.finalizeOrganization])await assert.rejects(operation(photos,earlier),/not in a listed sibling backup folder/);
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
