import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fork} from 'node:child_process';
import {createHash} from 'node:crypto';
/** Directory listing without the destination checksum index, which every copy may refresh. */
const visible=async(folder:string)=>(await fs.readdir(folder)).filter(name=>!name.startsWith('.photo-importer-index'));


// These are actual SIGKILL process-termination tests. They do not emulate loss
// of kernel page cache, controller caches, or power to the storage device.
const data = Buffer.concat([Buffer.from('precious media prefix\n'),Buffer.alloc(2*1024*1024,165),Buffer.from('\nprecious media suffix')]);
const hash = (bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const expectedHash = hash(data);
const prefixHash = hash(data.subarray(0,4093));
const foreign = 'pre-existing foreign file';
interface WorkerMessage {
  type:'checkpoint'|'result';file?:string;bytesWritten?:number;target?:string;
  result?:{copied?:number;skipped?:number;errors?:string[];moved?:number;removed?:number;finalized?:number};
  jobs?:{id:string;status:string}[];
}
async function fixture(t:test.TestContext) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'process-crash-')));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const source = path.join(base,'source'), destination = path.join(base,'destination'),library = path.join(base,'library');
  await fs.mkdir(source);await fs.mkdir(destination);await fs.mkdir(path.join(library,'incoming'),{recursive:true});
  const original = path.join(library,'incoming','A.JPG');
  await fs.writeFile(path.join(source,'A.bin'),data);await fs.writeFile(original,data);
  await fs.writeFile(path.join(destination,'keep.txt'),foreign);await fs.writeFile(path.join(library,'keep.txt'),foreign);
  return {base,source,destination,library,original,target:path.join(library,'2024','202402','FixtureCamera','JPEG','A.JPG')};
}
async function worker(t:test.TestContext,mode:string,base:string,kill=false,id?:string):Promise<WorkerMessage> {
  const child = fork(new URL('./fixtures/process-crash-worker.mts',import.meta.url),[mode,base,...(id?[id]:[])],{execArgv:['--import','tsx'],silent:true});
  let stderr = '', message:WorkerMessage|undefined;
  child.stderr?.on('data',chunk=>{stderr+=chunk;});
  child.stdout?.resume();
  t.after(()=>{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');});
  return new Promise((resolve,reject)=>{
    const deadline = setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`Crash worker ${mode} missed its checkpoint: ${stderr}`));},15000);
    child.on('error',error=>{clearTimeout(deadline);reject(error);});
    child.on('message',(value:WorkerMessage)=>{
      message = value;
      if (kill && value.type === 'checkpoint') child.kill('SIGKILL');
    });
    child.on('close',(code,signal)=>{
      clearTimeout(deadline);
      try {
        assert.ok(message,`${mode} produced no checkpoint/result: ${stderr}`);
        if (kill) {assert.equal(message.type,'checkpoint');assert.equal(code,null,stderr);assert.equal(signal,'SIGKILL',stderr);}
        else {assert.equal(message.type,'result');assert.equal(code,0,stderr);assert.equal(signal,null,stderr);}
        resolve(message);
      }catch(error){reject(error);}
    });
  });
}
const fileHash = async(file:string)=>hash(await fs.readFile(file));
async function killedWithoutFinally(base:string,mode:string) {
  await assert.rejects(fs.stat(path.join(base,`finally-${mode}`)),{code:'ENOENT'});
}
async function operation(library:string) {
  const storage = path.join(library,'.photo-importer-recovery');
  const [id] = await visible(storage);assert.ok(id);
  return {id,folder:path.join(storage,id)};
}
async function retained(folder:string) {
  const entry = path.join(folder,'originals','0');
  for (const slot of await visible(entry)) {
    const files = await visible(path.join(entry,slot));
    if(files.length)return path.join(entry,slot,files[0]!);
  }
  throw new Error('No retained original');
}

test('SIGKILL import-stage preserves an old partial when a foreign target now requires a different destination',async t=>{
  const mode='import-stage';
  const f = await fixture(t);
  const unowned = path.join(f.destination,'.import-unowned.partial');await fs.writeFile(unowned,'unowned partial');
  const stopped = await worker(t,mode,f.base,true);await killedWithoutFinally(f.base,mode);
  assert.equal(stopped.bytesWritten,4093);assert.ok(stopped.file);
  assert.equal(await fileHash(stopped.file),prefixHash);
  assert.equal(await fileHash(path.join(f.source,'A.bin')),expectedHash);
  // A nonmatching existing target is preserved; the retry selects another name.
  const foreignTarget = mode === 'import-stage' ? path.join(f.destination,'A.bin') : undefined;
  if(foreignTarget)await fs.writeFile(foreignTarget,foreign);
  const before = new Map<string,string>();
  for(const name of await visible(f.destination))before.set(path.join(f.destination,name),await fileHash(path.join(f.destination,name)));
  const retry = await worker(t,'retry-import',f.base);
  assert.deepEqual(retry.result,{copied:1,skipped:0,errors:[]});assert.ok(retry.target);
  assert.notEqual(retry.target,path.join(f.destination,'A.bin'));assert.equal(await fileHash(retry.target),expectedHash);
  for(const [file,digest] of before)assert.equal(await fileHash(file),digest,`Retry changed stale or foreign bytes: ${file}`);
  assert.equal(await fileHash(path.join(f.source,'A.bin')),expectedHash);
});

for(const mode of ['import-stage','import-exclusive'])test(`SIGKILL ${mode} resumes authenticated owned bytes in the same inode in a fresh process`,async t=>{
 const f=await fixture(t),unowned=path.join(f.destination,'.import-unowned.partial');await fs.writeFile(unowned,'foreign partial');
 const stopped=await worker(t,mode,f.base,true);await killedWithoutFinally(f.base,mode);assert.ok(stopped.file);assert.equal(await fileHash(stopped.file),prefixHash);
 const owned=await fs.lstat(stopped.file,{bigint:true});
 const retry=await worker(t,'retry-import',f.base);assert.deepEqual(retry.result,{copied:1,skipped:0,errors:[]});assert.equal(retry.target,path.join(f.destination,'A.bin'));
 assert.equal(await fileHash(retry.target!),expectedHash);assert.equal((await fs.lstat(retry.target!,{bigint:true})).ino,owned.ino);
 assert.deepEqual((await visible(f.destination)).sort(),['.import-unowned.partial','A.bin','keep.txt']);
 assert.equal(await fs.readFile(unowned,'utf8'),'foreign partial');assert.equal(await fs.readFile(path.join(f.destination,'keep.txt'),'utf8'),foreign);assert.equal(await fileHash(path.join(f.source,'A.bin')),expectedHash);
});

for(const mode of ['organization-exclusive','organization-publish','organization-stash'])test(`SIGKILL ${mode} resumes its authenticated journal in a new process`,async t=>{
  const f = await fixture(t),stopped = await worker(t,mode,f.base,true);await killedWithoutFinally(f.base,mode);
  const job = await operation(f.library);
  const unowned = path.join(job.folder,'stage-unowned.partial');await fs.writeFile(unowned,'unowned stage');
  assert.ok(stopped.file);
  if(mode === 'organization-exclusive') {assert.equal(stopped.bytesWritten,4093);assert.equal(await fileHash(f.target),prefixHash);assert.equal(await fileHash(f.original),expectedHash);}
  else {assert.equal(await fileHash(f.target),expectedHash);assert.equal(await fileHash(stopped.file),expectedHash);}
  if(mode === 'organization-publish')assert.equal(await fileHash(f.original),expectedHash);
  if(mode === 'organization-stash')await assert.rejects(fs.stat(f.original),{code:'ENOENT'});
  const retry = await worker(t,'resume-organization',f.base,false,job.id);
  assert.deepEqual(retry.result?.errors,[]);assert.equal(retry.result?.moved,1);assert.equal(retry.jobs?.[0]?.status,'complete');
  assert.equal(await fileHash(f.target),expectedHash);assert.equal(await fileHash(await retained(job.folder)),expectedHash);
  assert.equal(await fs.readFile(unowned,'utf8'),'unowned stage');assert.equal(await fs.readFile(path.join(f.library,'keep.txt'),'utf8'),foreign);
  if(mode === 'organization-exclusive') {
    const incomplete = (await visible(job.folder)).filter(name=>name.startsWith('incomplete-'));
    assert.equal(incomplete.length,1);assert.equal(await fileHash(path.join(job.folder,incomplete[0]!)),prefixHash);
  }
});

for(const mode of ['finalize-intent','finalize-unlink'])test(`SIGKILL ${mode} allows fresh finalization only through its durable intent`,async t=>{
  const f = await fixture(t),prepared = await worker(t,'prepare-organization',f.base);
  const id = prepared.jobs?.[0]?.id;assert.ok(id);assert.equal(prepared.jobs?.[0]?.status,'complete');
  const job = await operation(f.library),saved = await retained(job.folder);
  const unowned = path.join(job.folder,'unowned-original.bin');await fs.writeFile(unowned,foreign);
  const stopped = await worker(t,mode,f.base,true,id);await killedWithoutFinally(f.base,mode);assert.equal(stopped.file,saved);
  assert.equal(await fileHash(f.target),expectedHash);
  if(mode === 'finalize-intent')assert.equal(await fileHash(saved),expectedHash);
  else await assert.rejects(fs.stat(saved),{code:'ENOENT'});
  const events = await Promise.all((await visible(job.folder)).filter(name=>/^event-.*\.json$/.test(name)).map(async name=>JSON.parse(await fs.readFile(path.join(job.folder,name),'utf8'))));
  assert.ok(events.some(event=>event.event==='finalize-intent'));assert.ok(!events.some(event=>event.event==='finalized'));
  const retry = await worker(t,'retry-finalize',f.base,false,id);
  assert.equal(retry.result?.removed,mode === 'finalize-intent'?1:0);assert.equal(retry.result?.finalized,1);assert.equal(retry.jobs?.[0]?.status,'complete');
  await assert.rejects(fs.stat(saved),{code:'ENOENT'});assert.equal(await fileHash(f.target),expectedHash);
  assert.equal(await fs.readFile(unowned,'utf8'),foreign);
  assert.deepEqual((await worker(t,'resume-organization',f.base,false,id)).result?.errors,[]);
});
