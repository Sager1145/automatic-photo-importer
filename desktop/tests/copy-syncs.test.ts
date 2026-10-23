import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {plan,execute,configureOrganizationRecovery} from '../core/index';
import type {Metadata} from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}});
const FILES=6;

/** Counts every file and folder flush (handle.sync) made while `work` runs. */
async function syncs(work:()=>Promise<void>):Promise<number> {
  const probe=await fs.open(os.tmpdir(),'r'),proto=Object.getPrototypeOf(probe) as {sync:()=>Promise<void>};await probe.close();
  const original=proto.sync;let count=0;
  proto.sync=function(this:unknown){count++;return original.call(this);};
  try { await work(); } finally { proto.sync=original; }
  return count;
}
async function fixture(t:test.TestContext) {
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'copy-syncs-')));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const card=path.join(base,'card'),root=path.join(base,'backup');
  await fs.mkdir(card);await fs.mkdir(root);
  for(let i=0;i<FILES;i++) await fs.writeFile(path.join(card,`DSC_${String(i).padStart(4,'0')}.NEF`),Buffer.alloc(200_000+i,i+1));
  return {card,root};
}

test('a staged copy that is linked into place flushes at most 9 times per file',async t=>{
  const f=await fixture(t),reviewed=(await plan(f.card,[f.root],options,metadata)).plans[0]!;
  let result;
  const count=await syncs(async()=>{result=await execute(reviewed);});
  assert.deepEqual(result,{copied:FILES,skipped:0,errors:[]});
  console.log('link path syncs/file',count/FILES);
  assert.ok(count<=9*FILES,`${count/FILES} flushes per file`);
});

test('a staged copy published by copying flushes at most 17 times per file',async t=>{
  const f=await fixture(t),reviewed=(await plan(f.card,[f.root],options,metadata)).plans[0]!;
  let result;
  const count=await syncs(async()=>{result=await execute(reviewed,undefined,undefined,{exclusiveCopy:true});});
  assert.deepEqual(result,{copied:FILES,skipped:0,errors:[]});
  console.log('copy path syncs/file',count/FILES);
  assert.ok(count<=17*FILES,`${count/FILES} flushes per file`);
});
