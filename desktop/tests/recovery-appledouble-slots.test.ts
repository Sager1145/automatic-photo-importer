import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as core from '../core/index';
import {endedJournal} from '../core/recovery';
import {organizeByCopy} from './fixtures/records';

core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const metadata=async()=>({camera:'Sony',date:'2024-02-03',fields:{}});
const storage=(root:string)=>path.join(root,'Photo Importer Data','Organizations');
const exists=(file:string)=>fs.lstat(file).then(()=>true,()=>false);
/** What macOS writes beside a created file or folder on exFAT: a header with no entries (bookkeeping only). */
const bookkeeping=()=>{const b=Buffer.alloc(4096);b.writeUInt32BE(0x00051607,0);b.writeUInt32BE(0x00020000,4);return b;};
/** Finder info with a colour label: real user data. */
const labelled=()=>{const b=Buffer.alloc(4096);b.writeUInt32BE(0x00051607,0);b.writeUInt32BE(0x00020000,4);b.writeUInt16BE(1,24);b.writeUInt32BE(9,26);b.writeUInt32BE(50,30);b.writeUInt32BE(32,34);b[50+9]=0x0c;return b;};

async function organized(t:test.TestContext){
 const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'recovery-ad-'))),root=path.join(parent,'library');await fs.mkdir(root);
 t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const original=path.join(root,'incoming','A.JPG');await fs.mkdir(path.dirname(original));await fs.writeFile(original,'precious original');
 const p=(await core.plan(root,[root],{backup:false,reorganize:true,template:'first/{year}/{yyyymm}/{camera}',layout:'flat'},metadata)).plans[0]!;
 assert.deepEqual((await organizeByCopy(p)).errors,[]);
 const [job]=await core.getOrganizationRecovery(root);
 const originals=path.join(storage(root),job!.id,'originals'),index=path.join(originals,'0'),[slot]=await fs.readdir(index),slotFolder=path.join(index,slot!);
 // The sidecars macOS adds for the folders and the file.
 const sidecars={index:path.join(originals,'._0'),slot:path.join(index,`._${slot}`),file:path.join(slotFolder,'._A.JPG')};
 for(const file of Object.values(sidecars))await fs.writeFile(file,bookkeeping());
 return {root,original,job:job!,originals,index,slotFolder,sidecars,destination:p.entries[0]!.destination};
}

test('finalize leaves no slot folders and no bookkeeping sidecars, and the journal counts as ended',async t=>{
 const {root,job,originals,index,sidecars}=await organized(t);
 assert.equal(await endedJournal(root,job.id),undefined,'not ended while the original is kept');
 const done=await core.finalizeOrganization(root,job.id);assert.equal(done.removed,1);
 assert.deepEqual(await fs.readdir(originals),[]);
 assert.equal(await exists(index),false);
 for(const file of Object.values(sidecars))assert.equal(await exists(file),false);
 assert.deepEqual(await endedJournal(root,job.id),[]);
});

test('a bookkeeping sidecar left behind by an earlier finalize does not stop the journal from ending',async t=>{
 const {root,job,originals}=await organized(t);
 await core.finalizeOrganization(root,job.id);
 await fs.mkdir(path.join(originals,'0','11111111-1111-1111-1111-111111111111'),{recursive:true});
 await fs.writeFile(path.join(originals,'0','11111111-1111-1111-1111-111111111111','._A.JPG'),bookkeeping());
 await fs.writeFile(path.join(originals,'._0'),bookkeeping());
 assert.deepEqual(await endedJournal(root,job.id),[]);
});

test('a sidecar holding a Finder label keeps its folder and keeps the journal from ending',async t=>{
 const {root,job,slotFolder,index,sidecars}=await organized(t);
 await fs.writeFile(sidecars.file,labelled());
 const done=await core.finalizeOrganization(root,job.id);assert.equal(done.removed,1);
 assert.equal(await exists(sidecars.file),true);
 assert.equal(await exists(slotFolder),true);assert.equal(await exists(index),true);
 assert.equal(await endedJournal(root,job.id),undefined);
});

test('a real non-sidecar file is always counted',async t=>{
 const {root,job,slotFolder}=await organized(t);
 await core.finalizeOrganization(root,job.id);
 await fs.mkdir(slotFolder,{recursive:true});await fs.writeFile(path.join(slotFolder,'B.JPG'),'x');
 assert.equal(await endedJournal(root,job.id),undefined);
});

test('undo still restores the original, then tidies the slot folders and their sidecars',async t=>{
 const {root,job,original,originals,index,sidecars}=await organized(t);
 await fs.rm(original,{force:true});
 const undone=await core.undoOrganization(root,job.id);assert.equal(undone.restored,1);
 assert.equal(await fs.readFile(original,'utf8'),'precious original');
 assert.equal(await exists(index),false);
 for(const file of Object.values(sidecars))assert.equal(await exists(file),false);
 assert.deepEqual(await fs.readdir(originals),[]);
});

test('delete recovery files works with sidecars in the originals folders',async t=>{
 const {root,job,destination}=await organized(t);
 const deleted=await core.deleteOrganizationRecovery(root,job.id);assert.equal(deleted.released,1);
 assert.equal(await fs.readFile(destination,'utf8'),'precious original');
 assert.equal(await exists(path.join(storage(root),job.id)),false);
});
