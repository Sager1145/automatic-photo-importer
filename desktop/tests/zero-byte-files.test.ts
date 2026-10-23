import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { plan, execute, executeReorganization, configureOrganizationRecovery } from '../core/index';
import { MessageError } from '../messages';
import type { Metadata } from '../shared';

const run=promisify(execFile);
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Canon R6',date:'2022-05-06T12:00:00Z',fields:{}});

async function exfat(t:test.TestContext):Promise<string|undefined> {
  if(process.platform!=='darwin') return undefined;
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'exfat-empty-')));
  const image=path.join(base,'drive.dmg'),mount=path.join(base,'mount');
  await fs.mkdir(mount);
  try {
    await run('hdiutil',['create','-quiet','-size','32m','-fs','ExFAT','-volname','EMPTYTEST',image]);
    await run('hdiutil',['attach','-quiet','-nobrowse','-mountpoint',mount,image]);
  } catch { await fs.rm(base,{recursive:true,force:true}); return undefined; }
  t.after(async()=>{await run('hdiutil',['detach','-quiet','-force',mount]).catch(()=>{});await fs.rm(base,{recursive:true,force:true});});
  return mount;
}
async function temp(t:test.TestContext,name:string):Promise<string> {
  const folder=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),name)));
  t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  return folder;
}

test('on exFAT an organization skips 0-byte files, reports them and still moves the rest',async t=>{
  const mount=await exfat(t);
  if(!mount) return t.skip('exFAT disk images are unavailable here');
  const root=path.join(mount,'library');
  const stray=path.join(root,'stray');await fs.mkdir(stray,{recursive:true});
  const zero=['_R6_00 (520).CR3','_R6_00 (521).CR3','_R6_00 (522).CR3'].map(name=>path.join(stray,name));
  for(const file of zero) await fs.writeFile(file,'');
  await fs.writeFile(path.join(stray,'A.CR3'),Buffer.alloc(50_000,1));
  await fs.writeFile(path.join(stray,'B.JPG'),Buffer.alloc(20_000,2));
  const {inventory,plans,failures}=await plan(root,[root],{...options,reorganize:true},metadata);
  assert.deepEqual(failures,[]);
  assert.equal(inventory.empty,3);
  assert.deepEqual(inventory.skipped!.filter(item=>item.reason==='empty').map(item=>item.path).sort(),[...zero].sort());
  assert.deepEqual(plans[0]!.entries.map(entry=>path.basename(entry.source)).sort(),['A.CR3','B.JPG']);
  const result=await executeReorganization(plans[0]!,undefined,undefined);
  assert.deepEqual(result.errors,[]);assert.equal(result.moved,2);
  for(const file of zero) assert.equal((await fs.stat(file)).size,0);
  await assert.rejects(fs.stat(path.join(stray,'A.CR3')),{code:'ENOENT'});
});

test('on exFAT an import skips 0-byte files, reports them and copies the rest',async t=>{
  const mount=await exfat(t);
  if(!mount) return t.skip('exFAT disk images are unavailable here');
  const source=path.join(mount,'DCIM');await fs.mkdir(source);
  const zero=['_R6_00 (520).CR3','_R6_00 (521).CR3'].map(name=>path.join(source,name));
  for(const file of zero) await fs.writeFile(file,'');
  await fs.writeFile(path.join(source,'A.CR3'),Buffer.alloc(50_000,1));
  await fs.writeFile(path.join(source,'B.JPG'),Buffer.alloc(20_000,2));
  const root=path.join(await temp(t,'empty-import-'),'photobackup');await fs.mkdir(root);
  const {inventory,plans,failures}=await plan(source,[root],options,metadata);
  assert.deepEqual(failures,[]);
  assert.equal(inventory.empty,2);
  assert.ok(inventory.skipped!.some(item=>item.reason==='empty'&&item.path===zero[0]));
  assert.equal(plans[0]!.entries.length,2);
  const result=await execute(plans[0]!);
  assert.deepEqual(result.errors,[]);assert.equal(result.copied,2);
  for(const file of zero) assert.equal((await fs.stat(file)).size,0);
});

test('an empty file is not planned for import on any filesystem',async t=>{
  const source=await temp(t,'empty-source-');
  await fs.writeFile(path.join(source,'E.CR3'),'');await fs.writeFile(path.join(source,'A.CR3'),'raw bytes');
  const root=path.join(await temp(t,'empty-dest-'),'photobackup');await fs.mkdir(root);
  const found=await plan(source,[root],options,metadata);
  assert.equal(found.inventory.empty,1);
  assert.deepEqual(found.plans[0]!.entries.map(entry=>path.basename(entry.source)),['A.CR3']);
});

test('an organization goes on without a file that changes between checking and reading, and reports it',async t=>{
  const library=await temp(t,'changing-library-');
  const stray=path.join(library,'stray');await fs.mkdir(stray);
  for(const name of ['A.CR3','B.CR3','C.CR3','D.CR3']) await fs.writeFile(path.join(stray,name),Buffer.alloc(30_000,name.charCodeAt(0)));
  // A changes while it is being checked, B while its contents are read.
  const changing=async(file:string):Promise<Metadata>=>{if(path.basename(file)==='A.CR3')appendFileSync(file,'more');return metadata();};
  let touched=false;
  const {plans,failures}=await plan(library,[library],{...options,reorganize:true},changing,undefined,(_count,file,detail)=>{
    if(detail?.step==='reading'&&path.basename(file)==='B.CR3'&&detail.bytes>0&&!touched){touched=true;appendFileSync(path.join(stray,'B.CR3'),'more');}
  });
  assert.ok(touched);
  assert.deepEqual(failures.map(item=>path.basename(item.path)).sort(),['A.CR3','B.CR3']);
  const first=failures.find(item=>path.basename(item.path)==='A.CR3')!.error;
  assert.ok(first instanceof MessageError&&first.key==='error.sourceChanged');
  assert.match(failures.find(item=>path.basename(item.path)==='B.CR3')!.error.message,/changed/i);
  assert.deepEqual(plans[0]!.entries.map(entry=>path.basename(entry.source)).sort(),['C.CR3','D.CR3']);
  const result=await executeReorganization(plans[0]!,undefined,undefined);
  assert.deepEqual(result.errors,[]);assert.equal(result.moved,2);
  await fs.stat(path.join(stray,'A.CR3'));await fs.stat(path.join(stray,'B.CR3'));
});

test('an organization goes on without a file that vanishes before it is read',async t=>{
  const library=await temp(t,'vanishing-library-');
  const stray=path.join(library,'stray');await fs.mkdir(stray);
  for(const name of ['A.CR3','B.CR3']) await fs.writeFile(path.join(stray,name),Buffer.alloc(30_000,1));
  const {plans,failures}=await plan(library,[library],{...options,reorganize:true},async file=>{if(path.basename(file)==='A.CR3')await fs.rm(file);return metadata();});
  assert.deepEqual(failures.map(item=>path.basename(item.path)),['A.CR3']);
  assert.deepEqual(plans[0]!.entries.map(entry=>path.basename(entry.source)),['B.CR3']);
});

test('an import still stops on a changed file unless errors are skipped',async t=>{
  const source=await temp(t,'changing-source-');
  await fs.writeFile(path.join(source,'A.CR3'),'aaaa');await fs.writeFile(path.join(source,'B.CR3'),'bbbb');
  const root=path.join(await temp(t,'changing-dest-'),'photobackup');await fs.mkdir(root);
  const changing=async(file:string):Promise<Metadata>=>{if(path.basename(file)==='A.CR3')appendFileSync(file,'more');return metadata();};
  await assert.rejects(plan(source,[root],options,changing),{key:'error.sourceChanged'});
});
