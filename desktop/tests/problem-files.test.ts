import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {plan,execute,executeReorganization,getOrganizationRecovery,undoOrganization,findMisplaced,configureOrganizationRecovery} from '../core/index';
import type {Metadata} from '../shared';
import {diskImage,parts,temporary} from './fixtures/edge';
import {slash} from './fixtures/os';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Camera',date:'2022-05-06T12:00:00Z',fields:{}});

async function fixture(t:test.TestContext,parent?:string) {
  const base=parent??await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'problem-files-')));
  if(!parent)t.after(()=>fs.rm(base,{recursive:true,force:true}));
  // Broken files go to the library's other-files folder beside it.
  const library=path.join(base,'library'),other=path.join(base,'library-otherfiles');await fs.mkdir(library,{recursive:true});
  const put=async(relative:string,contents:string)=>{const file=path.join(library,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,contents);await fs.utimes(file,new Date('2020-01-01Z'),new Date('2020-01-01Z'));return file;};
  return {base,library,other,put};
}
const organize=async(library:string,collectProblems:boolean)=>{
  const found=await plan(library,[library],{...options,reorganize:true,collectProblems},metadata);
  let moved=false;
  for(const part of parts(found.plans[0]!)){const result=await executeReorganization(part,undefined,undefined);assert.deepEqual(result.errors,[]);moved||=!!result.moved;}
  return {found,result:{moved}};
};
const undoAll=async(...roots:string[])=>{for(const root of roots)for(const job of await getOrganizationRecovery(root))await undoOrganization(root,job.id);};
const exists=(file:string)=>fs.lstat(file).then(()=>true,()=>false);

async function populate(f:Awaited<ReturnType<typeof fixture>>) {
  await f.put('old/trip/EMPTY.CR3','');
  await f.put('old/trip/EMPTY.xmp','companion bytes');
  await f.put('old/clip/CLIP.MP4','');
  await f.put('old/REAL.JPG','real bytes');
}

test('an organization collects 0-byte files and their families under Broken files/Empty files beside the library, not by their old folders',async t=>{
  const f=await fixture(t);await populate(f);
  const {found,result}=await organize(f.library,true);
  const home=path.join(f.other,'Broken files','Empty files');
  assert.deepEqual(found.problems.map(item=>[slash(item.relative),item.reason,item.group,item.collected]).sort(),[
    ['old/clip/CLIP.MP4','empty','empty',true],['old/trip/EMPTY.CR3','empty','empty',true],['old/trip/EMPTY.xmp','emptyPrimary','empty',true]]);
  assert.equal((await fs.stat(path.join(home,'EMPTY.CR3'))).size,0);
  assert.equal(await fs.readFile(path.join(home,'EMPTY.xmp'),'utf8'),'companion bytes');
  assert.equal((await fs.stat(path.join(home,'CLIP.MP4'))).size,0);
  assert.equal(await fs.readFile(path.join(f.library,'2022/202205/Camera/REAL.JPG'),'utf8'),'real bytes');
  assert.ok(result.moved);
  // Emptied source folders are removed as usual.
  assert.equal(await exists(path.join(f.library,'old')),false);
});

test('undo puts collected problem files back where they were',async t=>{
  const f=await fixture(t);await populate(f);
  await organize(f.library,true);
  await undoAll(f.other,f.library);
  assert.equal((await fs.stat(path.join(f.library,'old/trip/EMPTY.CR3'))).size,0);
  assert.equal(await fs.readFile(path.join(f.library,'old/trip/EMPTY.xmp'),'utf8'),'companion bytes');
  assert.equal((await fs.stat(path.join(f.library,'old/clip/CLIP.MP4'))).size,0);
  assert.equal(await fs.readFile(path.join(f.library,'old/REAL.JPG'),'utf8'),'real bytes');
  assert.equal(await exists(path.join(f.other,'Broken files','Empty files','EMPTY.CR3')),false);
});

test('a later organization and the misplaced check find nothing more to do once broken files are out of the library',async t=>{
  const f=await fixture(t);await populate(f);
  await organize(f.library,true);
  const later=await plan(f.library,[f.library],{...options,reorganize:true,collectProblems:true},metadata);
  assert.deepEqual(parts(later.plans[0]!).flatMap(part=>part.entries),[]);
  assert.deepEqual(later.problems,[]);
  const {placed:_placed,...found}=await findMisplaced(f.library,f.library,options,metadata);assert.deepEqual(found,{count:0,bytes:0,files:[],failures:0});
  // A new 0-byte file under the same name is merged as an identical one, never overwriting.
  await f.put('old/trip/EMPTY.CR3','');
  const again=await organize(f.library,true);
  assert.equal(again.found.problems.filter(item=>item.collected).length,1);
  assert.equal((await fs.stat(path.join(f.other,'Broken files/Empty files/EMPTY.CR3'))).size,0);
});

test('an earlier version\'s Problem files folder moves out too: by date when its folders name one, else flat, never rebuilding Drive backups',async t=>{
  const f=await fixture(t);
  await f.put('Problem files/Empty files/photobackup/Drive backups/photobackup/DCIM 2/EMPTY.JPG','');
  await f.put('Problem files/Empty files/2022/202203/Camera/DATED.JPG','');
  await organize(f.library,true);
  assert.equal(await exists(path.join(f.library,'Problem files')),false,'the emptied folder goes');
  assert.equal((await fs.stat(path.join(f.other,'Broken files/Empty files/EMPTY.JPG'))).size,0);
  assert.equal((await fs.stat(path.join(f.other,'Broken files/Empty files/2022/202203/DATED.JPG'))).size,0);
  const written=await fs.readdir(f.other,{recursive:true});
  assert.ok(!written.some(name=>name.includes('Drive backups')),written.join(', '));
});

test('with collecting off, problem files stay in place and are still reported',async t=>{
  const f=await fixture(t);await populate(f);
  const {found}=await organize(f.library,false);
  assert.equal(found.problems.length,3);assert.ok(found.problems.every(item=>!item.collected));
  assert.equal(await exists(f.other),false,'nothing went beside the library');
  assert.equal((await fs.stat(path.join(f.library,'old/trip/EMPTY.CR3'))).size,0);
  assert.equal(await fs.readFile(path.join(f.library,'old/trip/EMPTY.xmp'),'utf8'),'companion bytes');
});

test('an import never copies problem files and lists each with its reason',async t=>{
  const f=await fixture(t);await populate(f);
  const destination=path.join(f.base,'destination');await fs.mkdir(destination);
  const found=await plan(f.library,[destination],{...options,collectProblems:true},metadata);
  assert.deepEqual(found.plans[0]!.entries.map(entry=>path.basename(entry.source)),['REAL.JPG']);
  assert.deepEqual(found.problems.map(item=>[slash(item.relative),item.reason,item.collected]).sort(),[['old/clip/CLIP.MP4','empty',false],['old/trip/EMPTY.CR3','empty',false],['old/trip/EMPTY.xmp','emptyPrimary',false]]);
  assert.deepEqual((await execute(found.plans[0]!)).errors,[]);
  assert.equal(await exists(path.join(f.base,'destination-otherfiles')),false);
  assert.equal((await fs.stat(path.join(f.library,'old/trip/EMPTY.CR3'))).size,0);
});

test('a file that cannot be read is listed as unreadable and left in place',{skip:process.platform==='win32'||process.getuid?.()===0},async t=>{
  const f=await fixture(t);
  const locked=await f.put('old/LOCKED.JPG','secret');await f.put('old/OK.JPG','fine');
  await fs.chmod(locked,0);t.after(()=>fs.chmod(locked,0o644).catch(()=>{}));
  const found=await plan(f.library,[f.library],{...options,reorganize:true,collectProblems:true},metadata);
  assert.deepEqual(found.problems.map(item=>[slash(item.relative),item.reason,item.group,item.collected]),[['old/LOCKED.JPG','unreadable','unreadable',false]]);
  assert.deepEqual(found.plans[0]!.entries.map(entry=>path.basename(entry.source)),['OK.JPG']);
});

test('on exFAT, 0-byte files keep their identity through collection and undo',{skip:process.platform!=='darwin'},async t=>{
  const root=await temporary(t,'problem-exfat-'),mount=await diskImage(root,'64m','ExFAT','PROBLEMS');
  if(!mount){t.skip('hdiutil unavailable');return;}
  const f=await fixture(t,mount);await populate(f);
  await organize(f.library,true);
  const home=path.join(f.other,'Broken files','Empty files');
  assert.equal((await fs.stat(path.join(home,'EMPTY.CR3'))).size,0);
  assert.equal(await fs.readFile(path.join(home,'EMPTY.xmp'),'utf8'),'companion bytes');
  await undoAll(f.other,f.library);
  assert.equal((await fs.stat(path.join(f.library,'old/trip/EMPTY.CR3'))).size,0);
  assert.equal((await fs.stat(path.join(f.library,'old/clip/CLIP.MP4'))).size,0);
});
