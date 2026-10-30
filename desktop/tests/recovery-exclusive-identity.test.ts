import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import * as core from '../core';
import {organizeAs} from './fixtures/records';

// exFAT gives a new file a temporary negative inode until its first data is synchronized. The inode recorded for the
// empty file is then useless after a crash, so the one seen after the first synchronized chunk is recorded too.
core.configureOrganizationRecovery('exclusive-identity-host-secret-32bytes');
const data=Buffer.concat([Buffer.from('precious media prefix\n'),Buffer.alloc(20*1024*1024,165),Buffer.from('\nprecious media suffix')]);
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{},reorganize:true as const};
const metadata=async()=>({camera:'FixtureCamera',date:'2024-02-03',fields:{}});

test('an exclusive copy records the identity seen after its first synchronized data, so a crashed partial is still recognized as owned',async t=>{
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'exclusive-identity-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const library=path.join(base,'library'),original=path.join(library,'incoming','A.JPG'),target=path.join(library,'2024','202402','FixtureCamera','JPEG','A.JPG');
 await fs.mkdir(path.dirname(original),{recursive:true});await fs.writeFile(original,data);
 const {plans:[transfer]}=await core.plan(library,[library],options,metadata);
 const open=fs.open.bind(fs),link=fs.link.bind(fs);let written=false,settled=false;
 // The target behaves as on exFAT (no hard links, a temporary inode until the first data is synchronized) and the run is cut off before it publishes.
 t.mock.method(fs,'link',async(from:string,to:string)=>{if(String(to)===target)throw Object.assign(new Error('Fixture filesystem has no hard links'),{code:'ENOTSUP'});return link(from,to);});
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args);if(String(args[0])!==target||args[1]!=='wx')return handle;
  const write=handle.write.bind(handle),sync=handle.sync.bind(handle),stat=handle.stat.bind(handle) as (o?:object)=>Promise<import('node:fs').BigIntStats>;
  Object.defineProperty(handle,'write',{value:async(...a:Parameters<typeof write>)=>{if(settled)throw Object.assign(new Error('Injected interruption after the first chunk'),{code:'EIO'});written=true;return write(...a);}});
  Object.defineProperty(handle,'sync',{value:async()=>{await sync();if(written)settled=true;}});
  Object.defineProperty(handle,'stat',{value:async(o?:object)=>{const real=await stat(o);return settled?real:Object.assign(Object.create(Object.getPrototypeOf(real)),real,{ino:-7n});}});
  return handle;
 });syncBuiltinESMExports();
 const interrupted=await organizeAs('copy',transfer!).catch(error=>({errors:[String(error)]}));
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.ok(settled&&('errors' in interrupted?interrupted.errors.length>0:true),'the injected interruption stopped the organization');
 const partial=await fs.readFile(target);assert.ok(partial.length>0&&partial.length<data.length,'a partial is at the target');assert.ok(data.subarray(0,partial.length).equals(partial));
 const [job]=await core.getOrganizationRecovery(library);assert.ok(job);
 const resumed=await core.resumeOrganization(library,job.id);
 assert.deepEqual(resumed.errors,[]);assert.equal(resumed.moved,1);
 assert.equal(hash(await fs.readFile(target)),hash(data));
 const folder=path.join(library,'Photo Importer Data','Organizations',job.id);
 assert.equal((await fs.readdir(folder)).filter(name=>name.startsWith('incomplete-')).length,1,'the owned partial was recognized and set aside');
});
