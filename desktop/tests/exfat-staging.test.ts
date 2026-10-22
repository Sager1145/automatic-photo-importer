import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { plan, execute, configureOrganizationRecovery } from '../core/index';
import { recordPartial } from '../core/import-recovery';
import { randomUUID } from 'node:crypto';
import type { Metadata } from '../shared';

const run=promisify(execFile);
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}});

/** A small exFAT disk image mounted privately, as camera backup drives usually are. */
async function exfat(t:test.TestContext):Promise<string|undefined> {
  if(process.platform!=='darwin') return undefined;
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'exfat-staging-')));
  const image=path.join(base,'drive.dmg'),mount=path.join(base,'mount');
  await fs.mkdir(mount);
  try {
    await run('hdiutil',['create','-quiet','-size','32m','-fs','ExFAT','-volname','STAGETEST',image]);
    await run('hdiutil',['attach','-quiet','-nobrowse','-mountpoint',mount,image]);
  } catch { await fs.rm(base,{recursive:true,force:true}); return undefined; }
  t.after(async()=>{await run('hdiutil',['detach','-quiet','-force',mount]).catch(()=>{});await fs.rm(base,{recursive:true,force:true});});
  return mount;
}
async function leftovers(folder:string):Promise<string[]> {
  const found:string[]=[];
  for(const entry of await fs.readdir(folder,{withFileTypes:true,recursive:true}))
    if(entry.name.startsWith('.import-')) found.push(path.join(entry.parentPath,entry.name));
  return found;
}

test('a copy published on exFAT leaves no staging file or stage record behind',async t=>{
  const mount=await exfat(t);
  if(!mount) return t.skip('exFAT disk images are unavailable here');
  const source=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'exfat-source-')));
  t.after(()=>fs.rm(source,{recursive:true,force:true}));
  await fs.writeFile(path.join(source,'DSC_0001.NEF'),Buffer.alloc(300_000,7));
  await fs.writeFile(path.join(source,'DSC_0002.JPG'),Buffer.alloc(120_000,9));
  const root=path.join(mount,'photobackup');await fs.mkdir(root);
  const reviewed=(await plan(source,[root],options,metadata)).plans[0]!;
  const result=await execute(reviewed);
  assert.deepEqual(result.errors,[]);
  assert.equal(result.copied,2);
  assert.deepEqual(await leftovers(root),[]);
  for(const entry of reviewed.entries) assert.equal((await fs.stat(entry.destination)).size,entry.size);
});

test('a re-import releases a staged copy left by a crashed run once the published file matches',async t=>{
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'stale-stage-')));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const source=path.join(base,'card'),root=path.join(base,'photobackup'),original=path.join(source,'DSC_0001.NEF');
  await fs.mkdir(source);await fs.mkdir(root);
  await fs.writeFile(original,Buffer.alloc(300_000,7));
  const first=(await plan(source,[root],options,metadata)).plans[0]!,entry=first.entries[0]!;
  // What a crash between staging and cleanup leaves: a complete staged copy and its signed stage record.
  await fs.mkdir(path.dirname(entry.destination),{recursive:true});
  const partial=path.join(path.dirname(entry.destination),`.import-${randomUUID()}.partial`);
  await fs.copyFile(original,partial);
  await recordPartial('stage',partial,await fs.lstat(partial,{bigint:true}),entry,first,new Map());
  // The file reached the backup anyway (published before the crash, or by an earlier version).
  await fs.copyFile(original,entry.destination);
  assert.equal((await leftovers(root)).length,2);
  const again=(await plan(source,[root],options,metadata)).plans[0]!;
  const result=await execute(again);
  assert.deepEqual(result.errors,[]);assert.equal(result.skipped,1);
  assert.deepEqual(await leftovers(root),[]);
  assert.equal((await fs.stat(entry.destination)).size,300_000);
});

test('a copy stopped while publishing on exFAT is finished in place by the next import, not copied again',async t=>{
  const mount=await exfat(t);
  if(!mount) return t.skip('exFAT disk images are unavailable here');
  const source=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'exfat-source-')));
  t.after(()=>fs.rm(source,{recursive:true,force:true}));
  await fs.writeFile(path.join(source,'DSC_0001.NEF'),Buffer.alloc(3*1024*1024,7));
  const root=path.join(mount,'photobackup');await fs.mkdir(root);
  const first=(await plan(source,[root],options,metadata)).plans[0]!,destination=first.entries[0]!.destination;
  // exFAT gives the new, empty file a temporary inode; its receipt must name the inode the bytes went to.
  const stopped={get aborted(){try{return statSync(destination).size>0;}catch{return false;}}} as AbortSignal;
  await assert.rejects(execute(first,stopped),{name:'AbortError'});
  assert.ok((await fs.stat(destination)).size<3*1024*1024);
  const again=(await plan(source,[root],options,metadata)).plans[0]!;
  assert.equal(again.entries[0]!.destination,destination);
  assert.deepEqual(await execute(again),{copied:1,skipped:0,errors:[]});
  assert.equal((await fs.stat(destination)).size,3*1024*1024);
  assert.deepEqual(await leftovers(root),[]);
});
