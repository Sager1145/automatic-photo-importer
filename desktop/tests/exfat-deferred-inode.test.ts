import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { plan, execute, configureOrganizationRecovery } from '../core/index';
import type { Metadata } from '../shared';

const run=promisify(execFile);
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}});
const FILES=14,MEGABYTES=4;

// exFAT volumes of about 1.5 GB and larger keep a temporary (negative) inode on a new file until
// it is synchronized, so these tests need a large sparse image; a small one hides the behavior.
interface Disk {base:string;mount:string;attach():Promise<void>;detach():Promise<void>;}
async function disk(t:test.TestContext):Promise<Disk|undefined> {
  if(process.platform!=='darwin') return undefined;
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'exfat-deferred-')));
  const mount=path.join(base,'mount'),image=path.join(base,'drive.sparseimage');
  const detach=()=>run('hdiutil',['detach','-quiet','-force',mount]).then(()=>{},()=>{});
  const attach=async()=>{await run('hdiutil',['attach','-quiet','-nobrowse','-mountpoint',mount,image]);};
  try {
    await fs.mkdir(mount);
    await run('hdiutil',['create','-quiet','-type','SPARSE','-size','3g','-fs','ExFAT','-volname','DEFERRED',path.join(base,'drive')]);
    await attach();
  } catch { await detach(); await fs.rm(base,{recursive:true,force:true}); return undefined; }
  t.after(async()=>{await detach();await fs.rm(base,{recursive:true,force:true});});
  return {base,mount,attach,detach};
}
async function source(t:test.TestContext):Promise<string> {
  const folder=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'exfat-deferred-source-')));
  t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  for(let i=0;i<FILES;i++) await fs.writeFile(path.join(folder,`DSC_${String(i).padStart(4,'0')}.NEF`),randomBytes((MEGABYTES+(i%3))*1024*1024));
  return folder;
}
async function leftovers(folder:string):Promise<string[]> {
  const found:string[]=[];
  for(const entry of await fs.readdir(folder,{withFileTypes:true,recursive:true}))
    if(/^(?:\.import|photo-importer)-(?!index)/.test(entry.name)) found.push(path.join(entry.parentPath,entry.name));
  return found;
}
async function media(root:string):Promise<string[]> {
  const found:string[]=[];
  for(const entry of await fs.readdir(root,{withFileTypes:true,recursive:true})) if(entry.isFile()&&/^DSC_/.test(entry.name)) found.push(path.join(entry.parentPath,entry.name));
  return found;
}
/** A killed process can leave an empty staging file it had not yet written a receipt for, or a duplicate receipt for a released file; nothing else may remain. */
async function assertOnlyEmptyOrphans(root:string,crashed:boolean) {
  const left=await leftovers(root);
  if(!crashed) return assert.deepEqual(left,[]);
  for(const file of left) {
    if(file.endsWith('.json')) {
      // A kill between writing a new receipt and removing the older one for the same file leaves the
      // older receipt behind, pointing at a file the next import has already released.
      // A receipt cut short by the kill grants no ownership and names nothing.
      const named=await fs.readFile(file,'utf8').then(text=>JSON.parse(text).file as string,()=>undefined);
      if(named===undefined) continue;
      assert.equal(await fs.lstat(named).then(()=>true,()=>false),false,`receipt for a file still there: ${file}`);
    } else assert.equal((await fs.stat(file)).size,0,`non-empty staging file left behind: ${file}`);
  }
}
async function reimport(card:string,root:string,crashed=false) {
  const result=await execute((await plan(card,[root],options,metadata)).plans[0]!);
  assert.deepEqual(result.errors,[]);
  const found=await media(root);
  assert.equal(found.length,FILES);
  assert.deepEqual(found.filter(file=>file.includes('Conflicts')),[]);
  for(const file of found) assert.equal((await fs.stat(file)).size,(await fs.stat(path.join(card,path.basename(file)))).size,path.basename(file));
  await assertOnlyEmptyOrphans(root,crashed);
}
async function crash(card:string,root:string,mode:'copy'|'publish'|'create') {
  const child=new URL('./fixtures/exfat-crash-child.mts',import.meta.url).pathname;
  const signal=await new Promise<string|null>(resolve=>execFile('node',['--import','tsx',child,card,root,mode,'20'],{timeout:90000},error=>resolve((error as {signal?:string}|null)?.signal??null)));
  assert.equal(signal,'SIGKILL','the child process was killed mid-run');
}
/** Detach and attach again, with another image taking the old disk number in between. */
async function reattachOnce(d:Disk,root:string) {
  const before=(await fs.stat(root,{bigint:true})).dev;
  const tag=randomBytes(4).toString('hex'),other=path.join(d.base,'other-'+tag),otherMount=path.join(d.base,'other-mount-'+tag);
  await fs.mkdir(otherMount);
  await run('hdiutil',['create','-quiet','-type','SPARSE','-size','64m','-fs','ExFAT','-volname','OTHER',other]);
  await d.detach();
  // The dummy only tries to take the old disk number; if it cannot attach, the precondition check below decides.
  await run('hdiutil',['attach','-quiet','-nobrowse','-mountpoint',otherMount,other+'.sparseimage']).catch(()=>{});
  try { await d.attach(); } finally { await run('hdiutil',['detach','-quiet','-force',otherMount]).catch(()=>{}); }
  return {before,after:(await fs.stat(root,{bigint:true})).dev};
}
/** The device number is not guaranteed to change, so a re-attach that kept it is repeated (up to 3 times). */
async function reattach(d:Disk,root:string) {
  let devices=await reattachOnce(d,root);
  for(let attempt=1;attempt<3&&devices.after===devices.before;attempt++) devices={before:devices.before,after:(await reattachOnce(d,root)).after};
  return devices;
}
async function ready(t:test.TestContext) {
  const d=await disk(t);
  if(!d){t.skip('large exFAT disk images are unavailable here');return undefined;}
  const card=await source(t),root=path.join(d.mount,'photobackup');await fs.mkdir(root);
  return {d,card,root};
}

test('a Stop while copying to a large exFAT volume leaves no staging file or receipt',async t=>{
  const env=await ready(t);if(!env) return;
  const controller=new AbortController(),reviewed=(await plan(env.card,[env.root],options,metadata)).plans[0]!;
  await assert.rejects(execute(reviewed,controller.signal,progress=>{if(progress.phase==='copying'&&progress.bytes>20*1048576)controller.abort();}),{name:'AbortError'});
  assert.deepEqual(await leftovers(env.root),[]);
});

test('a Stop while publishing to a large exFAT volume is finished by the next import without conflicts',async t=>{
  const env=await ready(t);if(!env) return;
  const controller=new AbortController(),reviewed=(await plan(env.card,[env.root],options,metadata)).plans[0]!;
  const timer=setInterval(()=>{media(env.root).then(async files=>{for(const file of files)if((await fs.stat(file)).size>0){controller.abort();return;}}).catch(()=>{});},3);
  try { await execute(reviewed,controller.signal); } catch(error) { assert.equal((error as Error).name,'AbortError'); } finally { clearInterval(timer); }
  await reimport(env.card,env.root);
});

test('receipts written before a large exFAT volume was attached again still resume and release',async t=>{
  const env=await ready(t);if(!env) return;
  await crash(env.card,env.root,'copy');
  assert.ok((await leftovers(env.root)).some(file=>file.endsWith('.json')),'the killed run left stage receipts');
  const devices=await reattach(env.d,env.root);
  if(devices.after===devices.before) return t.skip('the device number did not change after 3 re-attaches');
  await reimport(env.card,env.root,true);
});

test('a crash while publishing to a large exFAT volume is repaired after attaching it again',async t=>{
  const env=await ready(t);if(!env) return;
  await crash(env.card,env.root,'publish');
  await reattach(env.d,env.root);
  await reimport(env.card,env.root,true);
});

test('a crash right after a published name is created, before any data, is finished in place without conflicts',async t=>{
  const env=await ready(t);if(!env) return;
  await crash(env.card,env.root,'create');
  assert.ok((await media(env.root)).some(file=>file.endsWith('.NEF')),'the killed run left the created name');
  for(const file of await media(env.root)) assert.equal((await fs.stat(file)).size,0,'only an empty file was created');
  await reimport(env.card,env.root,true);
});

test('a crash right after a published name is created is finished in place on any volume',async t=>{
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'exfat-created-')));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const root=path.join(base,'photobackup');await fs.mkdir(root);
  const card=await source(t);
  await crash(card,root,'create');
  for(const file of await media(root)) assert.equal((await fs.stat(file)).size,0,'only an empty file was created');
  assert.ok((await media(root)).length>=1,'the killed run left the created name');
  await reimport(card,root,true);
});
