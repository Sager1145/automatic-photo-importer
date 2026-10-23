import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import os from 'node:os';
import {createHmac,randomUUID} from 'node:crypto';
import * as core from '../core/index';
import type {Metadata} from '../shared';

// (Performance round) Journals from before the event log keep one small file per event. On a USB drive a large one
// (86,526 files on A006) takes many minutes to read. An explicit Recheck or Resume folds those
// records, unchanged and still signed, into the event log and then removes the files.
const secret='fixture-only-host-recovery-secret-32bytes';
core.configureOrganizationRecovery(secret);
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2026-10-03T12:00:00',fields:{}});
const base={backup:false,template:'{year}/{yyyymm}/{camera}',unknownRules:{}};
const names=['A.JPG','B.JPG','C.JPG','D.MOV'];

/** A finished organization (kept originals: copy-and-keep) whose events are rewritten in the older
 * one-file-per-event form, exactly as that version stored them. */
async function legacy(t:test.TestContext,extra=0){
 const drive=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'journal-compaction-')));
 t.after(()=>fs.rm(drive,{recursive:true,force:true}));
 const photos=path.join(drive,'photobackup'),card=path.join(drive,'2025');
 for(const folder of [photos,card])await fs.mkdir(folder,{recursive:true});
 for(const name of names)await fs.writeFile(path.join(card,name),'bytes of '+name);
 const plan=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(plan,undefined,undefined,{strategy:'copy'})).errors,[]);
 const [journal]=await core.getOrganizationRecovery(photos);const id=journal!.id;
 const folder=path.join(photos,'Photo Importer Recovery',id),log=path.join(folder,'event-log.jsonl');
 const lines=(await fs.readFile(log,'utf8')).split('\n').filter(Boolean);
 // Further signed records of a kind that changes nothing, to make a large journal.
 for(let index=0;index<extra;index++){const record={id,root:photos,event:'checked',index:0,at:new Date(Date.UTC(2026,9,21,0,0,0,index)).toISOString()};lines.push(JSON.stringify({...record,seal:createHmac('sha256',secret).update(JSON.stringify(record)).digest('hex')}));}
 for(const line of lines)await fs.writeFile(path.join(folder,`event-${randomUUID()}.json`),line);
 await fs.rm(log);
 return {drive,photos,id,folder,log,lines};
}

const legacyFiles=async(folder:string)=>(await fs.readdir(folder)).filter(name=>/^event-.*\.json$/.test(name));
const outcome=async(root:string,id:string)=>{
 try{const job=(await core.getOrganizationRecovery(root)).find(item=>item.id===id);return job?.error??job?.status??'unlisted';}catch(error){return String(error);}
};

test('a per-event file that is a link, a folder or too large is refused',async t=>{
 for(const kind of ['link','folder','large']){
  const {photos,id,folder}=await legacy(t);
  const [first]=await legacyFiles(folder),file=path.join(folder,first!),keep=await fs.readFile(file,'utf8');
  await fs.rm(file);
  if(kind==='link'){const target=path.join(folder,'elsewhere.txt');await fs.writeFile(target,keep);await fs.symlink(target,file);}
  else if(kind==='folder')await fs.mkdir(file);
  else await fs.writeFile(file,keep+' '.repeat(3000));
  const result=await outcome(photos,id);
  assert.notEqual(result,'complete',kind+' must not be read as an event');
  assert.match(result,/./);
 }
});

test('per-event files are read at most four at a time',async t=>{
 const {photos,id}=await legacy(t,300);
 const mod=createRequire(import.meta.url)('node:fs/promises') as {open:typeof fs.open};const real=mod.open;let open=0,peak=0;
 mod.open=async(...args:Parameters<typeof fs.open>)=>{
  const handle=await real(...args),close=handle.close.bind(handle);open++;peak=Math.max(peak,open);
  handle.close=async()=>{open--;return close();};return handle;
 };
 try{assert.equal(await outcome(photos,id),'complete');}finally{mod.open=real;}
 assert.ok(peak<=4,'peak open files '+peak);
 assert.ok(peak>=2,'but they are read in parallel: '+peak);
});
