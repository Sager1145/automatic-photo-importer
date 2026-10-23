import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHmac,randomUUID} from 'node:crypto';
import * as core from '../core/index';
import type {Metadata} from '../shared';

// With the user's approval, a finished journal from before the event log is converted to it by the listing
// that read it, from the state already read, whenever no job is using the drive.
const secret='fixture-only-host-recovery-secret-32bytes';
core.configureOrganizationRecovery(secret);
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2026-10-03T12:00:00',fields:{}});
const base={backup:false,template:'{year}/{yyyymm}/{camera}',unknownRules:{}};

async function legacy(t:test.TestContext,extra=40){
 core.setConversionGate(()=>false);
 const drive=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'auto-conversion-')));
 t.after(()=>{core.setConversionGate(()=>true);return fs.rm(drive,{recursive:true,force:true});});
 const photos=path.join(drive,'photobackup'),card=path.join(drive,'2025');
 for(const folder of [photos,card])await fs.mkdir(folder,{recursive:true});
 for(const name of ['A.JPG','B.JPG','C.JPG'])await fs.writeFile(path.join(card,name),'bytes of '+name);
 const plan=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(plan,undefined,undefined,{strategy:'copy'})).errors,[]);
 const [journal]=await core.getOrganizationRecovery(photos);const id=journal!.id;
 const folder=path.join(photos,'Photo Importer Recovery',id),log=path.join(folder,'event-log.jsonl');
 const lines=(await fs.readFile(log,'utf8')).split('\n').filter(Boolean);
 for(let index=0;index<extra;index++){const record={id,root:photos,event:'checked',index:0,at:new Date(Date.UTC(2026,9,21,0,0,0,index)).toISOString()};lines.push(JSON.stringify({...record,seal:createHmac('sha256',secret).update(JSON.stringify(record)).digest('hex')}));}
 for(const line of lines)await fs.writeFile(path.join(folder,`event-${randomUUID()}.json`),line);
 await fs.rm(log);
 return {photos,id,folder,log,lines};
}
const rows=async(root:string,id:string)=>{const job=(await core.getOrganizationRecovery(root)).find(item=>item.id===id);assert.ok(job);return job;};
const files=async(folder:string)=>(await fs.readdir(folder)).filter(name=>/^event-.*\.json$/.test(name));
const eachOnce=async(log:string,lines:string[])=>{const now=(await fs.readFile(log,'utf8')).split('\n').filter(Boolean);for(const line of lines)assert.equal(now.filter(item=>item===line).length,1,'once: '+line.slice(0,60));};

test('a finished legacy journal is converted by the listing: no event file is left, the state is the same',async t=>{
 const {photos,id,folder,log,lines}=await legacy(t);
 const before=await rows(photos,id);
 core.setConversionGate(()=>true);
 const steps:string[]=[];
 const after=(await core.getOrganizationRecovery(photos,{onProgress:update=>{if(update.convert&&steps.at(-1)!==update.convert.step)steps.push(update.convert.step);}})).find(item=>item.id===id);
 assert.deepEqual(await files(folder),[]);
 await eachOnce(log,lines);
 assert.deepEqual(after,before);
 assert.deepEqual(steps,['converting','cleaning'],'both steps are reported');
 assert.deepEqual(await rows(photos,id),before,'and the converted journal reads the same');
 assert.ok((await core.finalizeOrganization(photos,id)).removed>0,'still a working journal');
});

test('nothing is converted while a job is using the drive; it is converted once the job ends',async t=>{
 const {photos,id,folder,lines}=await legacy(t);
 let busy=true;core.setConversionGate(()=>!busy);
 await core.getOrganizationRecovery(photos);
 assert.equal((await files(folder)).length,lines.length,'untouched during the job');
 await assert.rejects(fs.stat(path.join(folder,'event-log.jsonl')),{code:'ENOENT'});
 busy=false;await core.getOrganizationRecovery(photos);
 assert.deepEqual(await files(folder),[]);
});

test('a job that starts stops the conversion, which the next listing finishes',async t=>{
 const {photos,id,folder,log,lines}=await legacy(t);
 const before=await rows(photos,id);
 core.setConversionGate(()=>true);
 let stopped=false;
 await core.getOrganizationRecovery(photos,{onProgress:update=>{if(update.convert?.step==='cleaning'&&update.convert.done>=5&&!stopped){stopped=true;core.stopConversions();}}});
 assert.ok(stopped);
 const left=await files(folder);assert.ok(left.length>0&&left.length<lines.length,`stopped part-way (${left.length} left)`);
 await eachOnce(log,lines);
 assert.deepEqual(await rows(photos,id),before,'read the same meanwhile');
 await core.getOrganizationRecovery(photos);
 assert.deepEqual(await files(folder),[]);await eachOnce(log,lines);
});

for(const stop of ['authenticating','after the log was written','removing files'] as const)test(`an abort ${stop} counts every record once and changes nothing else`,async t=>{
 const {photos,id,folder,log,lines}=await legacy(t,1200);
 const before=await rows(photos,id);
 core.setConversionGate(()=>true);
 const controller=new AbortController();
 const hit=(update:{convert?:{step:string;done:number;total:number}})=>{
  const c=update.convert;if(!c)return;
  if(stop==='authenticating'&&c.step==='converting'&&c.done>=500)controller.abort();
  if(stop==='after the log was written'&&c.step==='cleaning'&&c.done===0)controller.abort();
  if(stop==='removing files'&&c.step==='cleaning'&&c.done>=100)controller.abort();
 };
 await assert.rejects(core.getOrganizationRecovery(photos,{signal:controller.signal,onProgress:hit}),{name:'AbortError'});
 const present=await fs.stat(log).then(()=>true,()=>false);
 if(stop==='authenticating')assert.equal(present,false,'nothing written');else await eachOnce(log,lines);
 // Nothing outside this journal's folder changed.
 assert.deepEqual((await fs.readdir(path.join(photos,'Photo Importer Recovery'))).sort(),[id]);
 assert.deepEqual(await rows(photos,id),before,'reads the same after the stop');
 await core.getOrganizationRecovery(photos);
 assert.deepEqual(await files(folder),[]);await eachOnce(log,lines);
 assert.deepEqual(await rows(photos,id),before);
});

test('a record that fails authentication stops the conversion before anything is written',async t=>{
 const {photos,id,folder,log}=await legacy(t,5);
 const [first]=await files(folder),file=path.join(folder,first!);
 const record=JSON.parse(await fs.readFile(file,'utf8'));await fs.writeFile(file,JSON.stringify({...record,at:'2000-01-01T00:00:00.000Z'}));
 core.setConversionGate(()=>true);
 const job=await rows(photos,id);
 assert.ok(job.error,'reported, not converted');
 await assert.rejects(fs.stat(log),{code:'ENOENT'});
 assert.ok((await files(folder)).includes(first!));
});
