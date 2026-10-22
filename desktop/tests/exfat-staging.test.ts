import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { plan, execute, configureOrganizationRecovery } from '../core/index';
import { recordPartial } from '../core/import-recovery';
import { randomUUID } from 'node:crypto';
import type { Metadata } from '../shared';
import files from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

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

test('re-importing onto exFAT reads each file already there once to plan and once to confirm it',async t=>{
  const mount=await exfat(t);
  if(!mount) return t.skip('exFAT disk images are unavailable here');
  const source=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'exfat-reimport-')));
  t.after(()=>fs.rm(source,{recursive:true,force:true}));
  await fs.writeFile(path.join(source,'DSC_0001.NEF'),Buffer.alloc(300_000,7));
  await fs.writeFile(path.join(source,'DSC_0002.JPG'),Buffer.alloc(120_000,9));
  const root=path.join(mount,'photobackup');await fs.mkdir(root);
  assert.equal((await execute((await plan(source,[root],options,metadata)).plans[0]!)).copied,2);
  // exFAT cannot prove a file unchanged from its stat across sessions, so the library is read
  // again, but only by the checks that need it: one comparison to plan and one to confirm.
  const reads=new Map<string,number>(),open=files.open.bind(files);
  t.mock.method(files,'open',async(...args:Parameters<typeof files.open>)=>{
    const handle=await open(...args),file=String(args[0]);
    if(file.startsWith(root+path.sep)&&!path.basename(file).startsWith('.')){const read=handle.read.bind(handle) as (...values:unknown[])=>Promise<{bytesRead:number}>;t.mock.method(handle,'read',async(...values:unknown[])=>{const result=await read(...values);if(result.bytesRead)reads.set(file,(reads.get(file)??0)+result.bytesRead);return result;});}
    return handle;
  });syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const again=(await plan(source,[root],options,metadata)).plans[0]!;
  assert.ok(again.entries.every(entry=>entry.skip));
  const planned=new Map(reads);
  const result=await execute(again);
  t.mock.restoreAll();syncBuiltinESMExports();
  assert.deepEqual(result,{copied:0,skipped:2,errors:[]});
  for(const entry of again.entries) {
    assert.equal(planned.get(entry.destination),entry.size,`planning reads ${path.basename(entry.destination)} once`);
    assert.equal(reads.get(entry.destination),2*entry.size,`copying confirms ${path.basename(entry.destination)} with one more read`);
  }
});
