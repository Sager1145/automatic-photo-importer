import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {plan,cleanStage,configureOrganizationRecovery} from '../core/index';
import {recordPartial,leftoverReceipt,rebaseMount} from '../core/import-recovery';
import type {Metadata} from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}});

async function fixture(t:test.TestContext) {
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'exfat-identity-')));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const card=path.join(base,'card'),root=path.join(base,'backup');
  await fs.mkdir(card);await fs.mkdir(root);
  await fs.writeFile(path.join(card,'DSC_0001.NEF'),Buffer.alloc(4000,1));
  const reviewed=(await plan(card,[root],options,metadata)).plans[0]!,entry=reviewed.entries[0]!;
  await fs.mkdir(path.dirname(entry.destination),{recursive:true});
  const copy=path.join(path.dirname(entry.destination),`photo-importer-${randomUUID()}.partial`);
  await fs.writeFile(copy,Buffer.alloc(1000,1));
  return {base,card,root,reviewed,entry,copy};
}

test('a receipt with a temporary inode binds by device and birth time, and not when the birth time differs',async t=>{
  const f=await fixture(t),stat=await fs.lstat(f.copy,{bigint:true});
  const same=await recordPartial('stage',f.copy,{...stat,ino:-5n} as typeof stat,f.entry,f.reviewed,new Map());
  assert.equal((await leftoverReceipt(same.journal,f.root)).bound,true,'the same birth time is bound');
  const other=await recordPartial('stage',f.copy,{...stat,ino:-5n,birthtimeNs:stat.birthtimeNs+1n} as typeof stat,f.entry,f.reviewed,new Map());
  assert.equal((await leftoverReceipt(other.journal,f.root)).bound,false,'a different birth time is not bound');
});

test('a receipt whose root inode differs is not rebased, one with only another device number is',async t=>{
  const f=await fixture(t),root=await fs.lstat(f.root,{bigint:true});
  const record=(rootIdentity:string)=>({root:f.root,rootIdentity,parentIdentity:`${root.dev}:1`,fileIdentity:`${root.dev}:2:3`,sourceRoot:path.join(f.base,'missing'),sourceIdentity:'1:2',sourceStat:undefined}) as unknown as Parameters<typeof rebaseMount>[0];
  const foreign=record(`${root.dev+1n}:${root.ino+1n}`);
  assert.equal((await rebaseMount(foreign)).rootIdentity,foreign.rootIdentity,'another root inode keeps its identity');
  assert.equal((await rebaseMount(foreign)).fileIdentity,foreign.fileIdentity);
  const moved=record(`${root.dev+1n}:${root.ino}`),rebased=await rebaseMount(moved);
  assert.equal(rebased.rootIdentity,`${root.dev}:${root.ino}`);
  assert.equal(rebased.fileIdentity,`${root.dev}:2:3`);
});

test('cleanStage leaves a file with a different birth time in place and says its identity differs',async t=>{
  const f=await fixture(t),stat=await fs.lstat(f.copy,{bigint:true}),notes:string[]=[];
  await cleanStage({file:f.copy,dev:stat.dev,ino:stat.ino,birthtime:stat.birthtimeNs+1n,recovery:new Map()},f.root,true,text=>notes.push(text));
  assert.ok(await fs.lstat(f.copy).then(()=>true,()=>false),'the file is still there');
  assert.equal(notes.length,1);assert.match(notes[0]!,/identity differs/);
  // A temporary inode with a different birth time is no better.
  await cleanStage({file:f.copy,dev:stat.dev,ino:-3n,birthtime:stat.birthtimeNs+1n,recovery:new Map()},f.root,true,text=>notes.push(text));
  assert.ok(await fs.lstat(f.copy).then(()=>true,()=>false));assert.equal(notes.length,2);
  // The matching identity does remove it.
  await cleanStage({file:f.copy,dev:stat.dev,ino:stat.ino,birthtime:stat.birthtimeNs,recovery:new Map()},f.root,true,text=>notes.push(text));
  assert.equal(await fs.lstat(f.copy).then(()=>true,()=>false),false);
});
