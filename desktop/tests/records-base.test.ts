import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as core from '../core/index';
import {registerDestinations} from '../core/app-store';
import {journalFolderFor,pointerFilesFor} from './fixtures/records';
import {findResidue,cleanResidue} from '../core/residue';
import type {Metadata} from '../shared';

// The same organizations as the per-library tests, with the records at the configured destination (B=D): every
// library beneath it shares one "Photo Importer Data" there, and nothing of the app is written in the libraries.
core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2026-10-03T12:00:00',fields:{}});
const base={backup:false,template:'{year}/{yyyymm}/{camera}',unknownRules:{}};
const camera='2026/202610/Sony A7';
const stopAfterFirstMove=()=>{const controller=new AbortController();return {signal:controller.signal,progress:(value:{step?:string;completed:number})=>{if(value.step==='moving'&&value.completed>=1)controller.abort();}};};
const exists=(file:string)=>fs.lstat(file).then(()=>true,()=>false);

async function destination(t:test.TestContext){
 const folder=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'records-base-')));
 const drive=path.join(folder,'A006');await fs.mkdir(drive);
 registerDestinations([drive]);
 t.after(async()=>{registerDestinations([]);await fs.rm(folder,{recursive:true,force:true});});
 const photos=path.join(drive,'photobackup'),videos=path.join(drive,'videobackup');
 for(const folder of [photos,videos,path.join(drive,'2025')])await fs.mkdir(folder,{recursive:true});
 return {drive,photos,videos,store:path.join(drive,'Photo Importer Data')};
}
/** Nothing of the app's in a library: no records folder of any version. */
async function clean(folder:string){
 for(const name of await fs.readdir(folder,{recursive:true}))assert.ok(!/Photo Importer|photo-importer/i.test(String(name)),`${folder}: ${name}`);
}

test('journals of every library and their pointers live in the destination\'s one store; supersession across sibling folders still holds',async t=>{
 const {drive,photos,videos,store}=await destination(t);
 await fs.writeFile(path.join(drive,'2025','C0016.MOV'),'bytes of a Sony clip');
 // The year folder organized into photobackup, then a video-root split moves the clip on into videobackup.
 const first=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(first,undefined,undefined)).errors,[]);
 const [earlier]=await core.getOrganizationRecovery(photos);
 assert.equal(path.dirname(await journalFolderFor(photos,earlier!.id)),path.join(store,'Organizations'));
 const {plans:[second]}=await core.plan(drive,[photos],{...base,layout:'video-root',videoRoots:[videos],sourceFolders:['photobackup','videobackup'],reorganize:true},metadata);
 for(const part of [second!,second!.videos!])assert.deepEqual((await core.executeReorganization(part,undefined,undefined)).errors,[]);
 const [later]=await core.getOrganizationRecovery(videos);
 assert.equal(path.dirname(await journalFolderFor(videos,later!.id)),path.join(store,'Organizations'));
 await assert.rejects(core.resumeOrganization(photos,earlier!.id),new RegExp(`superseded by ${later!.id}`));
 assert.equal((await core.undoOrganization(videos,later!.id)).restored,1);
 assert.equal(await fs.readFile(path.join(photos,camera,'C0016.MOV'),'utf8'),'bytes of a Sony clip');
 await clean(photos);await clean(videos);
});

test('a stopped video-folder journal\'s pointer for photobackup sits in the destination\'s store and blocks the photo folder until it is finished',async t=>{
 const {drive,photos,videos,store}=await destination(t);
 for(const name of ['C0016.MOV','C0017.MOV','A.JPG'])await fs.writeFile(path.join(photos,name),'bytes of '+name);
 const {plans:[split]}=await core.plan(drive,[photos],{...base,layout:'video-root',videoRoots:[videos],sourceFolders:['photobackup','videobackup'],reorganize:true},metadata);
 const stop=stopAfterFirstMove();
 await assert.rejects(core.executeReorganization(split!.videos!,stop.signal,stop.progress),{name:'AbortError'});
 const [stopped]=await core.getOrganizationRecovery(videos);
 const [pointer]=await pointerFilesFor(photos);
 assert.ok(pointer!.startsWith(path.join(store,'Pointers')+path.sep),pointer);
 const again=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['photobackup']},metadata)).plans[0]!;
 assert.match((await core.executeReorganization(again,undefined,undefined)).errors.join(' '),new RegExp(`Finish organization ${stopped!.id}`));
 // The refused attempt left its own journal, with nothing moved: undone, it no longer stands in the way.
 const refused=(await core.getOrganizationRecovery(photos)).find(job=>job.id!==stopped!.id)!;
 await core.undoOrganization(photos,refused.id);
 assert.deepEqual((await core.resumeOrganization(videos,stopped!.id)).errors,[]);
 assert.deepEqual(await pointerFilesFor(photos),[],'the finished journal\'s pointer is gone');
 await clean(photos);await clean(videos);
});

test('top-folder pointers for a source above the libraries go to the destination\'s store, and the emptied card folder can go',async t=>{
 const {drive,photos,store}=await destination(t);
 await fs.writeFile(path.join(drive,'2025','A.JPG'),'a photo');
 const reviewed=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(reviewed,undefined,undefined)).errors,[]);
 assert.equal(await exists(path.join(drive,'2025')),false,'nothing of the app kept the emptied folder');
 assert.deepEqual(await pointerFilesFor(path.join(drive,'2025')),[]);
 assert.ok(await exists(path.join(store,'store.json')));
});

test('imports into a backup folder beneath the destination keep receipts, staging and the index in the destination\'s store',async t=>{
 const {drive,photos,store}=await destination(t);
 const card=path.join(path.dirname(drive),'card');await fs.mkdir(card);await fs.writeFile(path.join(card,'DSC_0001.NEF'),Buffer.alloc(3000,1));
 const transfer=(await core.plan(card,[photos],{...base,layout:'flat'},metadata)).plans[0]!;
 assert.deepEqual((await core.execute(transfer)).errors,[]);
 await clean(photos);
 assert.ok((await fs.readdir(path.join(store,'Imports'))).some(name=>/^receipts-\d{6}\.jsonl$/.test(name)));
 assert.ok((await fs.readdir(path.join(store,'Libraries'))).some(name=>name.startsWith('photobackup ')));
 // The cleanup of the backup folder finds the destination's store.
 const found=await findResidue([photos]);await cleanResidue(found,{keepResumable:true});
 assert.equal(found.items.filter(item=>item.kind!=='receipt').length,0);
});

test('a journal whose library folder was renamed away stays listed from the destination\'s store, flagged as not found',async t=>{
 const {drive,photos}=await destination(t);
 await fs.writeFile(path.join(drive,'2025','A.JPG'),'a photo');
 const reviewed=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(reviewed,undefined,undefined)).errors,[]);
 const [job]=await core.getOrganizationRecovery(photos);
 await fs.rename(photos,path.join(drive,'photos renamed'));
 const {orphanedJournals}=await import('../core/recovery');
 const orphans=await orphanedJournals(drive);
 assert.deepEqual(orphans.map(item=>[item.id,item.root,item.missingRoot]),[[job!.id,photos,true]]);
 assert.match(orphans[0]!.error!,/not found/);
});

test('the cleanup keeps a pointer whose journal\'s library folder is not there',async t=>{
 const {drive,photos,videos}=await destination(t);
 for(const name of ['C0016.MOV','C0017.MOV','A.JPG'])await fs.writeFile(path.join(photos,name),'bytes of '+name);
 const {plans:[split]}=await core.plan(drive,[photos],{...base,layout:'video-root',videoRoots:[videos],sourceFolders:['photobackup','videobackup'],reorganize:true},metadata);
 const stop=stopAfterFirstMove();
 await assert.rejects(core.executeReorganization(split!.videos!,stop.signal,stop.progress),{name:'AbortError'});
 const [pointer]=await pointerFilesFor(photos);
 await fs.rename(videos,videos+' elsewhere');
 await cleanResidue(await findResidue([photos]),{keepResumable:true});
 assert.ok(await exists(pointer!),'kept');
});
