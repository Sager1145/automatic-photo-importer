import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import * as core from '../core';
import {organizeAs} from './fixtures/records';

// exFAT gives an empty new file a temporary negative inode until its first data is synchronized, while its birth time stays put.
// A crash before that first data sync leaves a partial whose inode differs from the only recorded (negative) one: it is owned by device and birth time.
core.configureOrganizationRecovery('exclusive-birth-host-secret-32bytes');
const data=Buffer.concat([Buffer.from('precious media prefix\n'),Buffer.alloc(20*1024*1024,165),Buffer.from('\nprecious media suffix')]);
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{},reorganize:true as const};
const metadata=async()=>({camera:'FixtureCamera',date:'2024-02-03',fields:{}});

/** Organize with a linkless target whose inode is negative until the first synced data, cut off by an I/O error at that first data sync. `hideBirth` models a journal written before birth times were recorded. */
async function interrupted(t:test.TestContext,hideBirth=false){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'exclusive-birth-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const library=path.join(base,'library'),original=path.join(library,'incoming','A.JPG'),target=path.join(library,'2024','202402','FixtureCamera','JPEG','A.JPG');
 await fs.mkdir(path.dirname(original),{recursive:true});await fs.writeFile(original,data);
 const {plans:[transfer]}=await core.plan(library,[library],options,metadata);
 const open=fs.open.bind(fs),link=fs.link.bind(fs);let written=false,failed=false;
 t.mock.method(fs,'link',async(from:string,to:string)=>{if(String(to)===target)throw Object.assign(new Error('Fixture filesystem has no hard links'),{code:'ENOTSUP'});return link(from,to);});
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args);if(String(args[0])!==target||args[1]!=='wx')return handle;
  const write=handle.write.bind(handle),sync=handle.sync.bind(handle),stat=handle.stat.bind(handle) as (o?:object)=>Promise<import('node:fs').BigIntStats>;
  Object.defineProperty(handle,'write',{value:async(...a:Parameters<typeof write>)=>{written=true;return write(...a);}});
  Object.defineProperty(handle,'sync',{value:async()=>{if(written&&!failed){failed=true;throw Object.assign(new Error('Injected interruption before the first data sync'),{code:'EIO'});}return sync();}});
  Object.defineProperty(handle,'stat',{value:async(o?:object)=>{const real=await stat(o);return Object.assign(Object.create(Object.getPrototypeOf(real)),real,{ino:-7n},hideBirth?{birthtimeNs:undefined}:{});}});
  return handle;
 });syncBuiltinESMExports();
 await organizeAs('copy',transfer!).catch(()=>undefined);
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.ok(failed,'the injected interruption stopped the organization');
 const partial=await fs.readFile(target);assert.ok(partial.length>0&&partial.length<data.length,'a partial is at the target');
 const [job]=await core.getOrganizationRecovery(library);assert.ok(job);
 return {library,original,target,job,folder:path.join(library,'Photo Importer Data','Organizations',job.id)};
}
const setAside=async(folder:string)=>(await fs.readdir(folder)).filter(name=>name.startsWith('incomplete-')).length;

test('a partial left before the first data sync is owned by its birth time and resume completes',async t=>{
 const {job,target,folder}=await interrupted(t);
 const resumed=await core.resumeOrganization(path.dirname(path.dirname(path.dirname(folder))),job.id);
 assert.deepEqual(resumed.errors,[]);assert.equal(resumed.moved,1);
 assert.equal(hash(await fs.readFile(target)),hash(data));
 assert.equal(await setAside(folder),1);
});

test('undo of an interrupted exclusive publication removes the owned partial and leaves the original intact',async t=>{
 const {library,job,target,original}=await interrupted(t);
 await core.undoOrganization(library,job.id);
 assert.equal(await fs.stat(target).then(()=>true,()=>false),false,'no truncated file stays at the library path');
 assert.equal(hash(await fs.readFile(original)),hash(data));
});

test('a foreign file with a different birth time is not owned: resume retains the original and undo leaves the file alone',async t=>{
 const {library,job,target,original,folder}=await interrupted(t);
 const foreign=Buffer.from('somebody else\'s file');
 await fs.rm(target);await fs.writeFile(target,foreign);
 const resumed=await core.resumeOrganization(library,job.id).catch(error=>({errors:[String(error)]}));
 assert.ok(resumed.errors.length>0);
 assert.deepEqual(await fs.readFile(target),foreign);assert.equal(await setAside(folder),0);
 await core.undoOrganization(library,job.id).catch(()=>undefined);
 assert.deepEqual(await fs.readFile(target),foreign,'an unowned file is never touched');
 assert.equal(hash(await fs.readFile(original)),hash(data));
});

test('a journal without a recorded birth time keeps the exact-inode rule',async t=>{
 const {library,job,target,original,folder}=await interrupted(t,true);
 const before=await fs.readFile(target);
 const resumed=await core.resumeOrganization(library,job.id).catch(error=>({errors:[String(error)]}));
 assert.ok(resumed.errors.length>0,'the partial is not recognized without a birth time');
 assert.deepEqual(await fs.readFile(target),before);assert.equal(await setAside(folder),0);
 assert.equal(hash(await fs.readFile(original)),hash(data));
});
