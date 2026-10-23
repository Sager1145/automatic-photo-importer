import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import * as core from '../core/index';

// Each file is read whole, so reads are counted in whole files: what each flow reads, by role.
core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const SIZE=2*1024*1024;
function countReads(t:test.TestContext,role:(file:string)=>string|undefined){
 const read:Record<string,number>={},open=fs.open.bind(fs);
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args),kind=role(String(args[0]));
  if(kind){const original=handle.read.bind(handle);t.mock.method(handle,'read',async(...values:Parameters<typeof handle.read>)=>{const result=await original(...values);read[kind]=(read[kind]??0)+result.bytesRead;return result;});}
  return handle;
 });syncBuiltinESMExports();
 const stop=()=>{t.mock.restoreAll();syncBuiltinESMExports();};t.after(stop);
 return {stop,files:()=>Object.fromEntries(Object.entries(read).filter(([,bytes])=>bytes).map(([kind,bytes])=>[kind,bytes/SIZE]))};
}
async function folder(t:test.TestContext,name:string){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),name)));t.after(()=>fs.rm(base,{recursive:true,force:true}));return base;
}

const organizing={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{},reorganize:true};
const sony=async()=>({camera:'Sony',date:'2024-02-03',fields:{}});
const recovery=(file:string)=>file.includes(`${path.sep}Photo Importer Recovery${path.sep}`);

// The copy streams and hashes the source once, the stage is read back once, and the hard link publishes that
// verified inode: neither the published name nor the original set aside is read again.
test('an organization copy reads its source once and its destination not at all after a link',async t=>{
 const root=await folder(t,'verify-once-organize-'),original=path.join(root,'incoming','A.JPG'),data=Buffer.alloc(SIZE,5);
 await fs.mkdir(path.dirname(original));await fs.writeFile(original,data);
 const {plans:[transfer]}=await core.plan(root,[root],organizing,sony);
 const destination=transfer!.entries[0]!.destination;
 const reads=countReads(t,file=>file===original?'source':file===destination?'destination':file.endsWith('.partial')?'stage':recovery(file)&&file.endsWith('A.JPG')?'stash':undefined);
 const result=await core.executeReorganization(transfer!);
 reads.stop();
 assert.deepEqual(result.errors,[]);assert.equal(result.moved,1);
 assert.deepEqual(reads.files(),{source:2,stage:1,destination:1});
 assert.deepEqual(await fs.readFile(destination),data);
});

// Between the check and setting the original aside, a copy rewritten in place (same size, so only a read can tell)
// is read again, found different, and the original stays where it is.
test('a destination changed after its check is read again and the original is kept',async t=>{
 const root=await folder(t,'verify-once-changed-'),original=path.join(root,'incoming','A.JPG'),data=Buffer.alloc(SIZE,5);
 await fs.mkdir(path.dirname(original));await fs.writeFile(original,data);
 const {plans:[transfer]}=await core.plan(root,[root],organizing,sony);
 const destination=transfer!.entries[0]!.destination,mkdir=fs.mkdir.bind(fs);let changed=false;
 // The slot for the original is made after the check and before the original is set aside.
 t.mock.method(fs,'mkdir',async(...args:Parameters<typeof fs.mkdir>)=>{
  if(!changed&&String(args[0]).includes(`${path.sep}originals${path.sep}0${path.sep}`)){changed=true;await fs.writeFile(destination,Buffer.alloc(SIZE,6));}
  return mkdir(...args);
 });syncBuiltinESMExports();
 const reads=countReads(t,file=>file===destination?'destination':undefined);
 const result=await core.executeReorganization(transfer!);
 reads.stop();
 assert.equal(changed,true);assert.equal(result.errors.length,1);assert.match(result.errors[0]!,/Destination changed/);
 assert.deepEqual(reads.files(),{destination:2});
 assert.deepEqual(await fs.readFile(original),data);
});
