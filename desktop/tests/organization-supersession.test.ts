import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import filesystem from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHmac,randomUUID} from 'node:crypto';
import * as core from '../core/index';

const secret='fixture-only-host-recovery-secret-32bytes';
core.configureOrganizationRecovery(secret);
const metadata=async()=>({camera:'Sony',date:'2024-02-03',fields:{}});
async function fixture(t:test.TestContext){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'organization-supersession-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const original=path.join(root,'incoming','A.JPG');await fs.mkdir(path.dirname(original));await fs.writeFile(original,'precious original');return {root,original};
}
async function plan(root:string,folder:string){return (await core.plan(root,[root],{backup:false,reorganize:true,template:`${folder}/{year}/{yyyymm}/{camera}`,separateMedia:false,unknownRules:{}},metadata)).plans[0]!;}
async function saved(root:string,id:string){
 const directory=path.join(root,'.photo-importer-recovery',id,'originals','0');
 const [slot]=await fs.readdir(directory);return path.join(directory,slot!,'A.JPG');
}
async function writeEvent(root:string,id:string,extra:Record<string,unknown>,seal=true){
 const record={id,root,event:'superseded',...extra};
 const value=seal?{...record,seal:createHmac('sha256',secret).update(JSON.stringify(record)).digest('hex')}:record;
 const file=path.join(root,'.photo-importer-recovery',id,`event-${randomUUID()}.json`);await fs.writeFile(file,JSON.stringify(value));return file;
}

test('successive layouts retain all prior originals and list only the latest recovery job',async t=>{
 const {root}=await fixture(t);const ids:string[]=[];
 for(const folder of ['first','second','third']){
  const result=await core.executeReorganization(await plan(root,folder));assert.deepEqual(result.errors,[]);
  const jobs=await core.getOrganizationRecovery(root);assert.equal(jobs.length,1);assert.equal(jobs[0]!.status,'complete');ids.push(jobs[0]!.id);
 }
 for(const id of ids){assert.equal(await fs.readFile(await saved(root,id),'utf8'),'precious original');}
 for(const id of ids.slice(0,-1)){
  await assert.rejects(core.resumeOrganization(root,id),/superseded by [a-f0-9-]+/);
  await assert.rejects(core.finalizeOrganization(root,id),/superseded by [a-f0-9-]+/);
 }
 assert.deepEqual((await core.resumeOrganization(root,ids[2]!)).errors,[]);
 assert.equal((await core.getOrganizationRecovery(root))[0]!.id,ids[2]);
});

test('an overlapping incomplete job blocks a new organization before moving any file',async t=>{
 const {root,original}=await fixture(t),controller=new AbortController();
 await assert.rejects(core.executeReorganization(await plan(root,'first'),controller.signal,()=>controller.abort()),{name:'AbortError'});
 const result=await core.executeReorganization(await plan(root,'second'));
 assert.match(result.errors.join(' '),/Finish organization .* overlapping/);
 assert.equal(await fs.readFile(original,'utf8'),'precious original');
 await assert.rejects(fs.stat(path.join(root,'second')),{code:'ENOENT'});
});

test('resume finishes predecessor marking after interruption before the superseded event is written',async t=>{
 const {root}=await fixture(t);await core.executeReorganization(await plan(root,'first'));
 const old=(await core.getOrganizationRecovery(root))[0]!.id,open=filesystem.open;
 let intercepted=false;
 t.mock.method(filesystem,'open',async(...args:Parameters<typeof open>)=>{
  const handle=await open(...args);
  if(String(args[0]).includes(path.join(old,'event-'))){const write=handle.writeFile.bind(handle);handle.writeFile=async(...values:Parameters<typeof handle.writeFile>)=>{if(String(values[0]).includes('"event":"superseded"')){intercepted=true;throw new Error('simulated interruption');}return write(...values);};}
  return handle;
 });
 const result=await core.executeReorganization(await plan(root,'second'));t.mock.restoreAll();
 assert.equal(intercepted,true);assert.match(result.errors.join(' '),/simulated interruption/);
 const pending=(await core.getOrganizationRecovery(root)).find(job=>job.id!==old)!;assert.equal(pending.status,'pending');
 assert.deepEqual((await core.resumeOrganization(root,pending.id)).errors,[]);
 assert.deepEqual((await core.getOrganizationRecovery(root)).map(job=>job.id),[pending.id]);
 assert.equal(await fs.readFile(await saved(root,old),'utf8'),'precious original');
});

test('finalization remains usable after organization removes obsolete source folders',async t=>{
 const {root,original}=await fixture(t);assert.deepEqual((await core.executeReorganization(await plan(root,'first'))).errors,[]);
 await assert.rejects(fs.stat(path.dirname(original)),{code:'ENOENT'});
 const [job]=await core.getOrganizationRecovery(root);
 assert.equal((await core.finalizeOrganization(root,job!.id)).removed,1);
 assert.equal((await core.getOrganizationRecovery(root))[0]!.status,'complete');
});

test('a reviewed in-place edit supersedes old routing without altering the old retained original',async t=>{
 const {root}=await fixture(t),first=await plan(root,'first');await core.executeReorganization(first);
 const old=(await core.getOrganizationRecovery(root))[0]!.id;
 await fs.writeFile(first.entries[0]!.destination,'new intentional render');
 const second=await plan(root,'second');assert.deepEqual((await core.executeReorganization(second)).errors,[]);
 const [latest]=await core.getOrganizationRecovery(root);assert.equal(latest!.status,'complete');
 assert.equal(await fs.readFile(await saved(root,old),'utf8'),'precious original');
 assert.equal(await fs.readFile(await saved(root,latest!.id),'utf8'),'new intentional render');
 assert.equal(await fs.readFile(second.entries[0]!.destination,'utf8'),'new intentional render');
});

test('an unresolved finalization intent blocks overlapping organization without changing retained bytes',async t=>{
 const {root}=await fixture(t);await core.executeReorganization(await plan(root,'first'));
 const old=(await core.getOrganizationRecovery(root))[0]!.id;
 await writeEvent(root,old,{event:'finalize-intent',index:0});
 const result=await core.executeReorganization(await plan(root,'second'));
 assert.match(result.errors.join(' '),/Finish organization/);
 await assert.rejects(fs.stat(path.join(root,'second')),{code:'ENOENT'});
 assert.equal(await fs.readFile(await saved(root,old),'utf8'),'precious original');
});

for(const authentication of ['unsigned','tampered'] as const)test(`${authentication} successor events cannot hide recovery jobs`,async t=>{
 const {root}=await fixture(t);await core.executeReorganization(await plan(root,'first'));const [job]=await core.getOrganizationRecovery(root);
 const file=await writeEvent(root,job!.id,{successor:randomUUID()},authentication!=='unsigned');
 if(authentication==='tampered'){const record=JSON.parse(await fs.readFile(file,'utf8'));record.successor=randomUUID();await fs.writeFile(file,JSON.stringify(record));}
 const [visible]=await core.getOrganizationRecovery(root);assert.equal(visible!.id,job!.id);assert.equal(visible!.status,'pending');assert.match(visible!.error!,/authentication/);
 await assert.rejects(core.resumeOrganization(root,job!.id),/authentication/);
 assert.equal(await fs.readFile(await saved(root,job!.id),'utf8'),'precious original');
});

for(const invalid of ['self','missing'] as const)test(`even an authenticated supersession rejects ${invalid} successors`,async t=>{
 const {root}=await fixture(t);await core.executeReorganization(await plan(root,'first'));const [job]=await core.getOrganizationRecovery(root);
 await writeEvent(root,job!.id,{successor:invalid==='self'?job!.id:randomUUID()});
 await assert.rejects(core.resumeOrganization(root,job!.id),invalid==='self'?/successor/:{code:'ENOENT'});
});

test('authenticated successor cycles cannot hide either recovery journal',async t=>{
 const {root,original}=await fixture(t),initial=path.join(root,'a/2024/202402/Sony/A.JPG');
 await fs.mkdir(path.dirname(initial),{recursive:true});await fs.rename(original,initial);
 await core.executeReorganization(await plan(root,'b'));const first=(await core.getOrganizationRecovery(root))[0]!.id;
 await core.executeReorganization(await plan(root,'a'));const second=(await core.getOrganizationRecovery(root))[0]!.id;
 await writeEvent(root,second,{successor:first});
 await assert.rejects(core.resumeOrganization(root,first),/cycle/);
 const jobs=await core.getOrganizationRecovery(root);assert.equal(jobs.length,2);assert.ok(jobs.every(job=>job.status==='pending'&&/cycle/.test(job.error!)));
});
