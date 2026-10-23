import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { plan, execute, executeReorganization, configureOrganizationRecovery } from '../core/index';
import type { Metadata } from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Camera',date:'2022-05-06T12:00:00Z',fields:{}});

async function fixture(t:test.TestContext,reorganize=false) {
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'empty-family-')));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const source=path.join(base,'source'),root=reorganize?source:path.join(base,'destination');
  const old=path.join(source,'old');await fs.mkdir(old,{recursive:true});await fs.mkdir(root,{recursive:true});
  const put=async(name:string,contents:string)=>{const file=path.join(old,name);await fs.writeFile(file,contents);await fs.utimes(file,new Date('2020-01-01Z'),new Date('2020-01-01Z'));return file;};
  return {source,root,old,put};
}

for(const reorganize of [true,false]) {
  const operation=reorganize?'organization':'import';
  for(const [primary,companion] of [['A.CR3','A.xmp'],['GX010001.MP4','GX010001.LRF']]) {
    test(`${operation} leaves an empty ${primary} and its non-empty ${companion} together`,async t=>{
      const f=await fixture(t,reorganize);
      const original=await f.put(primary!,''),sidecar=await f.put(companion!,'companion bytes');
      await f.put('B.JPG','photo bytes');
      const found=await plan(f.source,[f.root],{...options,reorganize},metadata);
      assert.deepEqual(found.failures,[]);
      assert.deepEqual(found.inventory.skipped?.slice().sort((a,b)=>a.path.localeCompare(b.path)),[{path:original,reason:'empty'},{path:sidecar,reason:'emptyPrimary'}].sort((a,b)=>a.path.localeCompare(b.path)));
      assert.equal(found.inventory.empty,1);
      assert.deepEqual(found.plans[0]!.entries.map(entry=>path.basename(entry.source)),['B.JPG']);
      const result=reorganize?await executeReorganization(found.plans[0]!,undefined,undefined):await execute(found.plans[0]!);
      assert.deepEqual(result.errors,[]);
      assert.equal((await fs.stat(original)).size,0);
      assert.equal(await fs.readFile(sidecar,'utf8'),'companion bytes');
      assert.equal(await fs.readFile(path.join(f.root,'2022/202205/Camera/B.JPG'),'utf8'),'photo bytes');
      if(reorganize) assert.deepEqual((await fs.readdir(f.old)).sort(),[primary,companion].sort());
    });
  }

  test(`${operation} carries empty XMP and WAV companions with non-empty media`,async t=>{
    const f=await fixture(t,reorganize);
    await f.put('A.CR3','raw bytes');await f.put('A.xmp','');await f.put('A.wav','');
    // Without a capture date, companions still use the primary's modification
    // time rather than their own older timestamp when choosing a folder.
    await fs.utimes(path.join(f.old,'A.CR3'),new Date('2022-05-06T12:00:00Z'),new Date('2022-05-06T12:00:00Z'));
    const found=await plan(f.source,[f.root],{...options,reorganize},async()=>({camera:'Camera',fields:{}}));
    assert.deepEqual(found.failures,[]);assert.deepEqual(found.inventory.skipped,[]);
    const entries=found.plans[0]!.entries;
    assert.deepEqual(entries.map(entry=>path.basename(entry.source)).sort(),['A.CR3','A.wav','A.xmp']);
    assert.equal(new Set(entries.map(entry=>entry.family)).size,1);
    const result=reorganize?await executeReorganization(found.plans[0]!,undefined,undefined):await execute(found.plans[0]!);
    assert.deepEqual(result.errors,[]);
    for(const name of ['A.CR3','A.wav','A.xmp']) assert.equal(await fs.readFile(path.join(f.root,'2022/202205/Camera',name),'utf8'),name==='A.CR3'?'raw bytes':'');
    if(reorganize) await assert.rejects(fs.stat(f.old),{code:'ENOENT'});
    else assert.deepEqual((await fs.readdir(f.old)).sort(),['A.CR3','A.wav','A.xmp']);
  });
}

test('backup copies empty primaries and companions with the original folder layout',async t=>{
  const f=await fixture(t);
  const contents:Record<string,string>={'A.CR3':'','A.xmp':'edits','GX010001.MP4':'','GX010001.LRF':'proxy','B.CR3':'raw','B.xmp':'','B.wav':'','empty.txt':''};
  for(const [name,body] of Object.entries(contents)) await f.put(name,body);
  const found=await plan(f.source,[f.root],{...options,backup:true},metadata);
  assert.deepEqual(found.failures,[]);assert.deepEqual(found.inventory.skipped,[]);
  assert.equal(found.plans[0]!.entries.length,Object.keys(contents).length);
  const result=await execute(found.plans[0]!);
  assert.deepEqual(result.errors,[]);assert.equal(result.copied,Object.keys(contents).length);
  for(const [name,body] of Object.entries(contents)) {
    assert.equal(await fs.readFile(path.join(f.root,'old',name),'utf8'),body);
    assert.equal(await fs.readFile(path.join(f.old,name),'utf8'),body);
  }
});
