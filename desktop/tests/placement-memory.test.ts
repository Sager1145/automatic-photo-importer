import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import { findMisplaced } from '../core/index';
import { addPlacement, loadPlacement, placedMatches, placementId, rememberEntries, replacePlacement } from '../platform/placement-memory';
import { ruleOptions, rulesScope } from '../routing-options';
import { defaultPreferences } from '../preferences';
import type { Metadata } from '../shared';

const options = {backup:false, template:'{year}/{yyyymm}/{camera}', layout:'format' as const, unknownRules:{}};
const scopeOf = (template:string) => rulesScope(ruleOptions({...defaultPreferences, template, mediaLayout:'format', unknownRules:{}}));
async function fixture(t:test.TestContext) {
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'photo-placement-')));
  t.after(async()=>{await fs.rm(base,{recursive:true,force:true});});
  const root=path.join(base,'library'),store=path.join(base,'store');await fs.mkdir(root);
  const put=async (relative:string)=>{const p=path.join(root,relative);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,'bytes of '+relative);return p;};
  let reads=0;
  const metadata=async ():Promise<Metadata>=>{reads++;return {camera:'Sony A7',date:'2024-02-03T12:00:00Z',fields:{}};};
  const id=placementId('volume-1',root);
  // The check as the app runs it: remembered files are skipped, and a completed check replaces the memory.
  const check=async (scope:string,template=options.template)=>{
    const memory=await loadPlacement(store,id,scope);
    reads=0;
    const found=await findMisplaced(root,root,{...options,template,inPlace:(relative,size,mtimeNs,ino)=>placedMatches(memory,relative,size,mtimeNs,ino)},metadata);
    await replacePlacement(store,id,scope,found.placed);
    return {found,reads};
  };
  return {root,store,id,put,check,reads:()=>reads};
}

test('a seeded memory skips the metadata of every matched file',async t=>{
  const {put,check}=await fixture(t);
  for(let n=0;n<5;n++) await put(`2024/202402/Sony A7/JPEG/IMG_${n}.JPG`);
  const scope=scopeOf(options.template);
  const first=await check(scope);
  assert.equal(first.reads,5);assert.equal(first.found.count,0);assert.equal(first.found.placed.length,5);
  const second=await check(scope);
  assert.equal(second.reads,0);assert.equal(second.found.count,0);assert.equal(second.found.placed.length,5);
});

test('only a new file in the library goes to metadata',async t=>{
  const {put,check}=await fixture(t);
  for(let n=0;n<3;n++) await put(`2024/202402/Sony A7/JPEG/IMG_${n}.JPG`);
  const scope=scopeOf(options.template);
  await check(scope);
  await put('2023/202301/Sony A7/JPEG/NEW.JPG');
  const again=await check(scope);
  assert.equal(again.reads,1);
});

test('one new file beside 1,000 remembered ones re-reads only its own family',async t=>{
  const {put,check}=await fixture(t);
  for(let n=0;n<1000;n++) await put(`2024/202402/Sony A7/JPEG/IMG_${n}.JPG`);
  const scope=scopeOf(options.template);
  await check(scope);
  await put('2024/202402/Sony A7/JPEG/NEW.JPG');await put('2024/202402/Sony A7/JPEG/NEW.RAF');
  const again=await check(scope);
  assert.ok(again.reads>=1&&again.reads<=3,`reads ${again.reads}`);
});

for(const [name,sidecar] of [['an NKSC_PARAM sidecar','NKSC_PARAM/IMG_3.JPG.nksc'],['a CaptureOne Settings sidecar','CaptureOne/Settings1/IMG_3.JPG.cos']] as const) {
  test(`a new ${name} re-reads its original and nothing else`,async t=>{
    const {put,check}=await fixture(t);
    for(let n=0;n<20;n++) await put(`2024/202402/Sony A7/JPEG/IMG_${n}.JPG`);
    const scope=scopeOf(options.template);
    await check(scope);
    await put(`2024/202402/Sony A7/JPEG/${sidecar}`);
    const again=await check(scope);
    assert.equal(again.reads,1,'the original, whose companion routing needs its metadata');
  });
}

test('a file moved by hand is still flagged',async t=>{
  const {root,put,check}=await fixture(t);
  await put('2024/202402/Sony A7/JPEG/A.JPG');await put('2024/202402/Sony A7/JPEG/B.JPG');
  const scope=scopeOf(options.template);
  await check(scope);
  await fs.mkdir(path.join(root,'misc'));
  await fs.rename(path.join(root,'2024/202402/Sony A7/JPEG/A.JPG'),path.join(root,'misc/A.JPG'));
  const again=await check(scope);
  assert.deepEqual(again.found.files,['misc/A.JPG']);
  assert.equal(again.found.placed.length,1);
});

test('a file changed in place is looked at again',async t=>{
  const {put,check}=await fixture(t);
  const file=await put('2024/202402/Sony A7/JPEG/A.JPG');
  const scope=scopeOf(options.template);
  await check(scope);
  await fs.writeFile(file,'different and longer contents');
  assert.equal((await check(scope)).reads,1);
});

test('a template change forces a full check',async t=>{
  const {put,check}=await fixture(t);
  for(let n=0;n<4;n++) await put(`2024/202402/Sony A7/JPEG/IMG_${n}.JPG`);
  await check(scopeOf(options.template));
  const other='{year}/{camera}';
  const changed=await check(scopeOf(other),other);
  assert.equal(changed.reads,4);
  assert.equal(changed.found.count,4);
});

test('a corrupt memory file means a full check without throwing',async t=>{
  const {store,id,put,check}=await fixture(t);
  await put('2024/202402/Sony A7/JPEG/A.JPG');
  const scope=scopeOf(options.template);
  await check(scope);
  const file=path.join(store,'placement-memory',`${id}.json.gz`);
  for(const garbage of [Buffer.from('not gzip at all'),gzipSync('{"version":1,"scope":"x"'),gzipSync(JSON.stringify({version:1,scope,dirs:[],d:[0],n:['a'],s:[1],m:[],i:[]}))]) {
    await fs.writeFile(file,garbage);
    assert.equal(await loadPlacement(store,id,scope),undefined);
    assert.equal((await check(scope)).reads,1);
  }
});

test('the memory file is private, compact and replaced atomically',async t=>{
  const {store,id}=await fixture(t);
  const files=Array.from({length:84_000},(_,n)=>({relative:`2024/202402/Sony A7/JPEG/${Math.floor(n/300)}/IMG_${String(n).padStart(6,'0')}.JPG`,size:5_000_000+n,mtimeNs:1_700_000_000_123_456_789n+BigInt(n)*1_000_000_000n,ino:100_000n+BigInt(n)}));
  await replacePlacement(store,id,'scope',files);
  const file=path.join(store,'placement-memory',`${id}.json.gz`),stat=await fs.stat(file);
  assert.equal(stat.mode&0o777,0o600);
  assert.ok(stat.size<10*1024*1024/2,`size ${stat.size}`);
  assert.deepEqual(await fs.readdir(path.dirname(file)),[path.basename(file)]);
  const loaded=await loadPlacement(store,id,'scope');
  assert.equal(loaded?.size,84_000);
  const sample=files[1234]!;
  assert.ok(placedMatches(loaded,sample.relative,sample.size,sample.mtimeNs,sample.ino));
  assert.ok(!placedMatches(loaded,sample.relative,sample.size,sample.mtimeNs+1n,sample.ino));
  await addPlacement(store,id,'scope',[{relative:'x/new.JPG',size:1,mtimeNs:2n,ino:3n}]);
  assert.equal((await loadPlacement(store,id,'scope'))?.size,84_001);
  assert.equal(await loadPlacement(store,id,'other scope'),undefined);
});

test('an import adds the entries it placed, and only those that exist inside the library',async t=>{
  const {root,store,id,put,check}=await fixture(t);
  const scope=scopeOf(options.template);
  const placed=await put('2024/202402/Sony A7/JPEG/IMG_1.JPG'),stat=await fs.lstat(placed,{bigint:true});
  const entries=[
    {destination:placed,size:'bytes of 2024/202402/Sony A7/JPEG/IMG_1.JPG'.length},
    {destination:path.join(root,'2024/202402/Sony A7/JPEG/never-written.JPG'),size:10},
    {destination:placed,size:1},
    {destination:path.join(path.dirname(root),'outside.JPG'),size:1},
  ];
  await fs.writeFile(path.join(path.dirname(root),'outside.JPG'),'x');
  await rememberEntries(store,id,scope,root,[root],entries);
  const memory=await loadPlacement(store,id,scope);
  assert.equal(memory?.size,1);
  assert.ok(placedMatches(memory,'2024/202402/Sony A7/JPEG/IMG_1.JPG',entries[0]!.size,stat.mtimeNs,stat.ino));
  // The next check then reads nothing for it.
  const next=await check(scope);
  assert.equal(next.reads,0);
});
