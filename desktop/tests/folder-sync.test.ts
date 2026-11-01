import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {commitFolder, dirtyFolder, DIRECTORY_SYNC_SUPPORTED, flushFolders} from '../core/paths';

// These count folder flushes (handle.sync on a folder); Windows has none, so there is nothing to group or fail.
const skip=DIRECTORY_SYNC_SUPPORTED?false:'Windows does not flush folders (DIRECTORY_SYNC_SUPPORTED)';

type Proto={sync:()=>Promise<void>};
/** Replaces every handle.sync until `restore`; `hook` runs in place of each flush (it may wait or fail). */
async function instrument(hook:(count:number)=>Promise<void>|void) {
  const probe=await fs.open(os.tmpdir(),'r'),proto=Object.getPrototypeOf(probe) as Proto;await probe.close();
  const original=proto.sync;let count=0;
  proto.sync=async function(this:unknown){const mine=++count;await hook(mine);return original.call(this);};
  return {count:()=>count,restore:()=>{proto.sync=original;}};
}
async function folder(t:test.TestContext) {
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'folder-sync-')));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  return base;
}

test('many commits of one folder made together share fewer flushes than requests',{skip},async t=>{
  const base=await folder(t),probe=await instrument(()=>new Promise(resolve=>setTimeout(resolve,20)));
  t.after(probe.restore);
  await Promise.all(Array.from({length:12},()=>commitFolder(base)));
  assert.ok(probe.count()<12,`${probe.count()} flushes for 12 commits`);
  assert.ok(probe.count()>=1);
});

test('a commit never joins a flush that has already started: the change it covers may have come after it began',{skip},async t=>{
  const base=await folder(t);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const probe=await instrument(count=>count===1?gate:undefined);
  t.after(probe.restore);
  const first=commitFolder(base);
  while(probe.count()<1) await new Promise(resolve=>setTimeout(resolve,2));
  // The first flush is under way and blocked: these must wait for a flush of their own that starts after it.
  const second=commitFolder(base),third=commitFolder(base);
  let secondDone=false;void second.then(()=>{secondDone=true;});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(secondDone,false,'it waits for a later flush, not the one in progress');
  assert.equal(probe.count(),1,'the later flush has not started while the first is running');
  release();
  await Promise.all([first,second,third]);
  assert.equal(probe.count(),2,'two later requests share one more flush');
});

test('a failed flush fails every commit that waited for it, and a later commit can succeed',{skip},async t=>{
  const base=await folder(t);
  const probe=await instrument(count=>{if(count===1)throw Object.assign(new Error('EIO'),{code:'EIO'});});
  t.after(probe.restore);
  const results=await Promise.allSettled([commitFolder(base),commitFolder(base),commitFolder(base)]);
  assert.ok(results.some(result=>result.status==='rejected'),'at least the first group fails');
  const failed=results.filter(result=>result.status==='rejected').length;
  assert.ok(failed>=1);
  await commitFolder(base);
});

test('a lazily marked folder is flushed by the timer and by flushFolders',{skip},async t=>{
  const base=await folder(t),probe=await instrument(()=>{});
  t.after(probe.restore);
  dirtyFolder(base);
  await new Promise(resolve=>setTimeout(resolve,600));
  assert.equal(probe.count(),1,'the timer flushed it');
  dirtyFolder(base);dirtyFolder(base);
  await flushFolders();
  assert.equal(probe.count(),2,'flushFolders flushed it once');
  await flushFolders();
  assert.equal(probe.count(),2,'nothing is dirty any more');
});

test('a commit covers a lazily marked folder, so it is not flushed again',{skip},async t=>{
  const base=await folder(t),probe=await instrument(()=>{});
  t.after(probe.restore);
  dirtyFolder(base);
  await commitFolder(base);
  await flushFolders();
  assert.equal(probe.count(),1);
});
