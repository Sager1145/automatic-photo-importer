import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {plan,execute} from '../core';
import {destinationIndex} from '../core/destination-index';
import {identity} from '../core/paths';
import {configureOrganizationRecovery} from '../core/index';
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');

const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
async function temporary(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'index-safety-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));return base;
}
/** Run `change` once, when the first handle opened on `file` is closed. */
function onFirstClose(t:test.TestContext,file:string,change:()=>Promise<void>){
 const open=fs.open.bind(fs);let fired=false;
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args);
  if(String(args[0])===file&&!fired){const close=handle.close.bind(handle);t.mock.method(handle,'close',async()=>{await close();if(!fired){fired=true;await change();}});}
  return handle;
 });syncBuiltinESMExports();
 return ()=>{t.mock.restoreAll();syncBuiltinESMExports();return fired;};
}
const rewrite=(file:string,data:Buffer)=>async()=>{const handle=await fs.open(file,'r+');try{await handle.write(data,0,data.length,0);}finally{await handle.close();}};

test('a file changed right after hashing is never indexed with the old checksum',async t=>{
 const root=await temporary(t),file=path.join(root,'a.bin'),first=Buffer.alloc(4096,1),second=Buffer.alloc(4096,2);
 await fs.writeFile(file,first);
 const index=await destinationIndex(root,await identity(root));
 const stop=onFirstClose(t,file,rewrite(file,second));
 assert.equal(await index.digestOf(file),sha(first));
 assert.equal(stop(),true);
 assert.equal(await index.digestOf(file),sha(second));
});

test('a destination rewritten after publication is not trusted as the copied bytes',async t=>{
 const base=await temporary(t),source=path.join(base,'card'),root=path.join(base,'disk'),original=path.join(source,'DCIM','a.bin'),copy=path.join(root,'DCIM','a.bin');
 await fs.mkdir(path.dirname(original),{recursive:true});await fs.mkdir(root);await fs.writeFile(original,Buffer.alloc(65536,1));
 const options={backup:true as const,template:'{camera}',layout:'flat' as const,unknownRules:{}},none=async()=>({fields:{}});
 const {plans:[first]}=await plan(source,[root],options,none);
 // The copy is rewritten (through its still-linked staging name) just before the staged copy is removed, which is before the index remembers it.
 const unlink=fs.unlink.bind(fs);let fired=false;
 t.mock.method(fs,'unlink',async(...args:Parameters<typeof fs.unlink>)=>{if(!fired&&String(args[0]).endsWith('.partial')){fired=true;await rewrite(copy,Buffer.alloc(16,9))();}return unlink(...args);});syncBuiltinESMExports();
 const stop=()=>{t.mock.restoreAll();syncBuiltinESMExports();return fired;};
 assert.equal((await execute(first!)).copied,1);
 assert.equal(stop(),true);
 const {plans:[again]}=await plan(source,[root],options,none);
 assert.equal(again!.entries[0]!.skip,false,'changed bytes must not be skipped as a verified copy');
});

test('a file whose change time equals its modification time is always hashed',async t=>{
 const root=await temporary(t),file=path.join(root,'a.bin');
 await fs.writeFile(file,Buffer.alloc(1024,3));
 const stat=await fs.lstat(file,{bigint:true});
 if(stat.ctimeNs!==stat.mtimeNs)return t.skip('this filesystem reports distinct change and modification times');
 const index=await destinationIndex(root,await identity(root));
 await index.digestOf(file);
 const reads={count:0},open=fs.open.bind(fs);
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{if(String(args[0])===file)reads.count++;return open(...args);});syncBuiltinESMExports();
 await index.digestOf(file);
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.equal(reads.count,1,'FAT-style timestamps cannot prove unchanged contents');
});
