import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import * as core from '../core/index';
import {findResidue,cleanResidue} from '../core/residue';

core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const metadata=async()=>({camera:'Sony',date:'2024-02-03',fields:{}});
const storage=(root:string)=>path.join(root,'Photo Importer Recovery');
const exists=(file:string)=>fs.lstat(file).then(()=>true,()=>false);
async function fixture(t:test.TestContext){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'delete-recovery-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const original=path.join(root,'incoming','A.JPG');await fs.mkdir(path.dirname(original));await fs.writeFile(original,'precious original');return {root,original};
}
async function organize(root:string,folder:string,signal?:AbortSignal,onProgress?:()=>void){
 const p=(await core.plan(root,[root],{backup:false,reorganize:true,template:`${folder}/{year}/{yyyymm}/{camera}`,layout:'flat' as const,unknownRules:{}},metadata)).plans[0]!;
 return {result:await core.executeReorganization(p,signal,onProgress),destination:p.entries[0]!.destination};
}
const ids=async(root:string)=>(await fs.readdir(storage(root))).filter(name=>/^[0-9a-f-]{36}$/.test(name));

test('a stopped organization is refused and stays as it is',async t=>{
 const {root}=await fixture(t),controller=new AbortController();
 await assert.rejects(organize(root,'first',controller.signal,()=>controller.abort()),{name:'AbortError'});
 const [id]=await ids(root);
 await assert.rejects(core.deleteOrganizationRecovery(root,id!),/finish or undo/i);
 assert.ok(await exists(path.join(storage(root),id!,'manifest.json')));
 assert.equal((await core.getOrganizationRecovery(root))[0]!.status,'pending');
});

test('a finished organization: its kept original is released after its destination is checked, then only its journal goes',async t=>{
 const {root}=await fixture(t);const {result,destination}=await organize(root,'first');assert.deepEqual(result.errors,[]);
 const [job]=await core.getOrganizationRecovery(root);assert.equal(job!.retainedFiles,1);
 const measured=await core.measureOrganizationRecovery(root,job!.id);
 assert.ok(measured.files>=3&&measured.bytes>='precious original'.length,JSON.stringify(measured));
 const deleted=await core.deleteOrganizationRecovery(root,job!.id);
 assert.equal(deleted.released,1);assert.equal(deleted.files,measured.files);
 // Releasing appends to the event log first.
 assert.ok(deleted.bytes>=measured.bytes);
 assert.equal(await fs.readFile(destination,'utf8'),'precious original');
 assert.equal(await exists(path.join(storage(root),job!.id)),false);
 assert.deepEqual(await core.getOrganizationRecovery(root),[]);
 // Nothing is left behind for a residue check, and the empty recovery folder is gone.
 assert.equal(await exists(storage(root)),false);
});

test('a destination that no longer matches keeps the original and the whole journal',async t=>{
 const {root}=await fixture(t);const {destination}=await organize(root,'first');
 const [job]=await core.getOrganizationRecovery(root);
 await fs.writeFile(destination,'tampered original');
 await assert.rejects(core.deleteOrganizationRecovery(root,job!.id),/Destination/);
 const originals=path.join(storage(root),job!.id,'originals','0');const [slot]=await fs.readdir(originals);
 assert.equal(await fs.readFile(path.join(originals,slot!,'A.JPG'),'utf8'),'precious original');
 assert.ok(await exists(path.join(storage(root),job!.id,'manifest.json')));
});

test('replaced organizations are deleted oldest first; every other journal and every organized file stays',async t=>{
 const {root}=await fixture(t);const made:string[]=[];let last='';
 for(const folder of ['first','second','third']){const {result,destination}=await organize(root,folder);assert.deepEqual(result.errors,[]);last=destination;made.push((await core.getOrganizationRecovery(root))[0]!.id);}
 const listed=await core.getOrganizationRecovery(root,{includeEnded:true});
 assert.deepEqual(listed.map(job=>[job.id,job.status]).sort(),[[made[0],'superseded'],[made[1],'superseded'],[made[2],'complete']].sort());
 // The newest is still named by the ones it replaced.
 await assert.rejects(core.deleteOrganizationRecovery(root,made[2]!),new RegExp(`${made[1]}`));
 await assert.rejects(core.deleteOrganizationRecovery(root,made[1]!),new RegExp(`${made[0]}`));
 const first=await core.deleteOrganizationRecovery(root,made[0]!);assert.equal(first.released,0);assert.ok(first.bytes>0);
 assert.deepEqual((await ids(root)).sort(),[made[1],made[2]].sort());
 for(const id of made.slice(1))assert.ok(await exists(path.join(storage(root),id,'manifest.json')));
 assert.equal(await fs.readFile(last,'utf8'),'precious original');
 assert.deepEqual((await core.resumeOrganization(root,made[2]!)).errors,[]);
 await core.deleteOrganizationRecovery(root,made[1]!);
 await core.deleteOrganizationRecovery(root,made[2]!);
 assert.equal(await fs.readFile(last,'utf8'),'precious original');
 assert.deepEqual(await core.getOrganizationRecovery(root,{includeEnded:true}),[]);
});

test('a replaced organization whose kept original has no checked copy elsewhere is refused',async t=>{
 const {root}=await fixture(t);
 await organize(root,'first');const old=(await core.getOrganizationRecovery(root))[0]!.id;
 const {destination}=await organize(root,'second');const newer=(await core.getOrganizationRecovery(root))[0]!.id;
 // The newer journal's own kept original (the old destination's file) and its organized file both changed.
 const directory=path.join(storage(root),newer,'originals','0'),[slot]=await fs.readdir(directory);
 await fs.writeFile(path.join(directory,slot!,'A.JPG'),'tampered original');await fs.writeFile(destination,'tampered original');
 await assert.rejects(core.deleteOrganizationRecovery(root,old),/no checked copy/i);
 assert.ok(await exists(path.join(storage(root),old,'manifest.json')));
});

test('an undone organization can be deleted; the restored file stays',async t=>{
 const {root,original}=await fixture(t);await organize(root,'first');
 const [job]=await core.getOrganizationRecovery(root);await core.undoOrganization(root,job!.id);
 assert.deepEqual(await core.getOrganizationRecovery(root),[]);
 const [undone]=await core.getOrganizationRecovery(root,{includeEnded:true});assert.equal(undone!.status,'undone');
 await core.deleteOrganizationRecovery(root,job!.id);
 assert.equal(await fs.readFile(original,'utf8'),'precious original');
 assert.equal(await exists(path.join(storage(root),job!.id)),false);
});

test('an unknown or invalid organization is refused without touching anything',async t=>{
 const {root}=await fixture(t);await organize(root,'first');
 await assert.rejects(core.deleteOrganizationRecovery(root,'../incoming'),/Invalid recovery identifier/);
 await assert.rejects(core.deleteOrganizationRecovery(root,'6b1f1b8e-8a9b-4c1d-9e3f-0a1b2c3d4e5f'),/ENOENT|not found/i);
 assert.equal((await ids(root)).length,1);
});

// A power cut or crash part-way: before the journal is set aside it is untouched; after, it is
// gone from the list and what is left is residue that Clean up removes.
async function interrupted(t:test.TestContext,when:'before'|'after'){
 const {root}=await fixture(t);const {destination}=await organize(root,'first');
 const [job]=await core.getOrganizationRecovery(root);
 const script=path.join(root,'crash.mjs'),module=path.resolve('desktop/core/index.ts');
 await fs.writeFile(script,`import filesystem from 'node:fs/promises';
 import {deleteOrganizationRecovery,configureOrganizationRecovery} from ${JSON.stringify(module)};
 configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
 const rename=filesystem.rename,rm=filesystem.rm;
 filesystem.rename=async(...args)=>{if(${JSON.stringify(when)}==='before'&&String(args[1]).includes('deleting-'))process.exit(91);return rename(...args);};
 filesystem.rm=async(...args)=>{if(${JSON.stringify(when)}==='after'&&String(args[0]).includes('deleting-'))process.exit(91);return rm(...args);};
 await deleteOrganizationRecovery(${JSON.stringify(root)},${JSON.stringify(job!.id)});process.exit(0);`);
 const child=spawnSync(process.execPath,['--import','tsx',script],{cwd:process.cwd(),encoding:'utf8'});
 assert.equal(child.status,91,child.stderr);await fs.unlink(script);
 return {root,id:job!.id,destination};
}
test('interrupted before the journal is set aside, it is still whole and can be deleted again',async t=>{
 const {root,id,destination}=await interrupted(t,'before');
 assert.ok(await exists(path.join(storage(root),id,'manifest.json')));
 const [job]=await core.getOrganizationRecovery(root);assert.equal(job!.id,id);assert.equal(job!.status,'complete');
 await core.deleteOrganizationRecovery(root,id);
 assert.equal(await exists(path.join(storage(root),id)),false);assert.equal(await fs.readFile(destination,'utf8'),'precious original');
});
test('interrupted after the journal is set aside, it is gone from the list and Clean up removes the rest',async t=>{
 const {root,id,destination}=await interrupted(t,'after');
 assert.equal(await exists(path.join(storage(root),id)),false);
 assert.deepEqual(await core.getOrganizationRecovery(root,{includeEnded:true}),[]);
 const residue=await findResidue([root]);
 assert.ok(residue.items.some(item=>item.kind==='organization'&&path.basename(item.path).startsWith(`deleting-${id}-`)),JSON.stringify(residue.items.map(item=>item.path)));
 await cleanResidue(residue);
 assert.deepEqual((await fs.readdir(storage(root)).catch(()=>[])).filter(name=>name.startsWith('deleting-')),[]);
 assert.equal(await fs.readFile(destination,'utf8'),'precious original');
});
