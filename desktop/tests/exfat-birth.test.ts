import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import files from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {plan,execute,cleanStage,configureOrganizationRecovery} from '../core/index';
import {recordPartial,findPartial,leftoverReceipt} from '../core/import-recovery';
import {sameBirth} from '../core/paths';
import type {Metadata} from '../shared';

const run=promisify(execFile);
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=(date:string)=>async():Promise<Metadata>=>({camera:'Nikon Z f',date,fields:{}});
const SECOND=1_000_000_000n;
type Stat=import('node:fs').BigIntStats;

test('sameBirth: a whole-second record matches its own second, everything else is exact',()=>{
  const t=1_700_000_000n*SECOND;
  assert.equal(sameBirth(t,t),true);
  assert.equal(sameBirth(t,t+370_000_000n),true,'same second, fraction found');
  assert.equal(sameBirth(t,t+SECOND),false,'one second apart');
  assert.equal(sameBirth(t,t-1n),false,'previous second');
  assert.equal(sameBirth(t+370_000_000n,t+380_000_000n),false,'a recorded fraction is exact');
  assert.equal(sameBirth(t+370_000_000n,t),false,'a recorded fraction does not match a whole second');
  assert.equal(sameBirth(t+1n,t+1n),true);
});

async function fixture(t:test.TestContext) {
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'exfat-birth-')));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const card=path.join(base,'card'),root=path.join(base,'backup');
  await fs.mkdir(card);await fs.mkdir(root);
  await fs.writeFile(path.join(card,'DSC_0001.NEF'),Buffer.alloc(4000,1));
  const reviewed=(await plan(card,[root],options,metadata('2024-02-03T12:00:00Z'))).plans[0]!,entry=reviewed.entries[0]!;
  await fs.mkdir(path.dirname(entry.destination),{recursive:true});
  const copy=path.join(path.dirname(entry.destination),`photo-importer-${randomUUID()}.partial`);
  await fs.copyFile(entry.source,copy);
  return {base,card,root,reviewed,entry,copy};
}
// A file recorded with the whole second, while the disk now reports a fraction of it.
const withBirth=(stat:Stat,birthtimeNs:bigint,ino:bigint=stat.ino)=>Object.assign(Object.create(Object.getPrototypeOf(stat)) as Stat,stat,{birthtimeNs,ino});
const whole=(stat:Stat)=>withBirth(stat,stat.birthtimeNs/SECOND*SECOND);
const fraction=(stat:Stat)=>stat.birthtimeNs/SECOND*SECOND+370_000_000n;
const present=(file:string)=>fs.lstat(file).then(()=>true,()=>false);
/** The disk reports `found` for `file` (what a re-read exFAT file looks like). */
function report(t:test.TestContext,file:string,found:Stat) {
  const real=files.lstat.bind(files);
  t.mock.method(files,'lstat',async(name:string,opts?:object)=>String(name)===file?found:real(name,opts as never));syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
}
const unreport=()=>{(files.lstat as unknown as {mock?:{restore():void}}).mock?.restore();syncBuiltinESMExports();};

test('cleanStage releases a stage recorded with a whole-second birth time that is found with a fraction, and still refuses a +1n or a +1 s mismatch',async t=>{
  const f=await fixture(t),stat=await fs.lstat(f.copy,{bigint:true}),notes:string[]=[];
  const index=new Map(),owned=await recordPartial('stage',f.copy,whole(stat),f.entry,f.reviewed,index);
  report(t,f.copy,withBirth(stat,fraction(stat)));
  await cleanStage({file:f.copy,dev:stat.dev,ino:stat.ino,birthtime:whole(stat).birthtimeNs+SECOND,record:owned,recovery:index},f.root,true,text=>notes.push(text));
  assert.equal(notes.length,1,'another second is refused');
  assert.equal(await present(f.copy),true);
  // A recorded fraction is exact: one nanosecond off is refused.
  await cleanStage({file:f.copy,dev:stat.dev,ino:stat.ino,birthtime:fraction(stat)+1n,recovery:new Map()},f.root,true,text=>notes.push(text));
  assert.equal(notes.length,2,'+1n on a recorded fraction is refused');
  assert.equal(await present(f.copy),true);
  notes.length=1;
  await cleanStage({file:f.copy,dev:stat.dev,ino:stat.ino,birthtime:whole(stat).birthtimeNs,record:owned,recovery:index},f.root,true,text=>notes.push(text));
  unreport();
  assert.equal(notes.length,1);
  assert.equal(await present(f.copy),false,'the stage is released');
  assert.equal(await present(owned.journal),false,'and so is its receipt');
});

test('cleanStage with a temporary inode and a whole-second birth time releases a file found with a fraction',async t=>{
  const f=await fixture(t),stat=await fs.lstat(f.copy,{bigint:true});
  report(t,f.copy,withBirth(stat,fraction(stat)));
  await cleanStage({file:f.copy,dev:stat.dev,ino:-4n,birthtime:whole(stat).birthtimeNs,recovery:new Map()},f.root);
  unreport();
  assert.equal(await present(f.copy),false);
});

test('a whole-second receipt binds a file whose birth time has a fraction; a recorded fraction or another second does not',async t=>{
  const f=await fixture(t),stat=await fs.lstat(f.copy,{bigint:true}),index=new Map();
  const wholeReceipt=await recordPartial('stage',f.copy,whole(stat),f.entry,f.reviewed,index);
  const fractionReceipt=await recordPartial('stage',f.copy,withBirth(stat,fraction(stat)+10_000_000n),f.entry,f.reviewed,index);
  const otherSecond=await recordPartial('stage',f.copy,withBirth(stat,whole(stat).birthtimeNs+SECOND),f.entry,f.reviewed,index);
  report(t,f.copy,withBirth(stat,fraction(stat)));
  assert.equal((await leftoverReceipt(wholeReceipt.journal,f.root)).bound,true);
  assert.equal((await leftoverReceipt(fractionReceipt.journal,f.root)).bound,false);
  assert.equal((await leftoverReceipt(otherSecond.journal,f.root)).bound,false);
  await fs.unlink(fractionReceipt.journal);await fs.unlink(otherSecond.journal);
  const entry={...f.entry,digest:createHash('sha256').update(await fs.readFile(f.copy)).digest('hex')};
  assert.equal((await findPartial('stage',entry,f.root,new Map()))?.file,f.copy);
});

test('binds and cleanStage refuse what is not the same file, even in the same second',async t=>{
  const f=await fixture(t),stat=await fs.lstat(f.copy,{bigint:true}),index=new Map();
  const otherIno=await recordPartial('stage',f.copy,withBirth(whole(stat),whole(stat).birthtimeNs,stat.ino+1n),f.entry,f.reviewed,index);
  const otherDev=await recordPartial('stage',f.copy,withBirth(whole(stat),whole(stat).birthtimeNs,-7n),f.entry,f.reviewed,index);
  report(t,f.copy,withBirth(stat,fraction(stat)));
  assert.equal((await leftoverReceipt(otherIno.journal,f.root)).bound,false,'a different positive inode');
  assert.equal((await leftoverReceipt(otherDev.journal,f.root)).bound,true,'a temporary inode in the same second binds');
  unreport();
  // The file as another device reports it: the same temporary-inode receipt no longer binds.
  report(t,f.copy,Object.assign(withBirth(stat,fraction(stat)),{dev:stat.dev+1n}));
  assert.equal((await leftoverReceipt(otherDev.journal,f.root)).bound,false,'a temporary inode on another device');
  unreport();
  const notes:string[]=[],note=(text:string)=>notes.push(text);
  // A temporary inode is released only for one link and the same second.
  report(t,f.copy,Object.assign(withBirth(stat,fraction(stat)),{nlink:2n}));
  await cleanStage({file:f.copy,dev:stat.dev,ino:-4n,birthtime:whole(stat).birthtimeNs,recovery:new Map()},f.root,true,note);
  unreport();
  assert.equal(await present(f.copy),true,'two links: refused');
  report(t,f.copy,withBirth(stat,fraction(stat)));
  await cleanStage({file:f.copy,dev:stat.dev,ino:-4n,birthtime:whole(stat).birthtimeNs-SECOND,recovery:new Map()},f.root,true,note);
  unreport();
  assert.equal(await present(f.copy),true,'another second: refused');
  assert.equal(notes.length,2);
});

// ---- exFAT disk image ----
const bridge=process.env.IMPORTER_NATIVE_BRIDGE||path.join(process.cwd(),'build','native','NativeCameraBridge');
async function exfat(t:test.TestContext){
  if(process.platform!=='darwin'||!await present(bridge)) return undefined;
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'exfat-birth-disk-')));
  const image=path.join(base,'drive.dmg'),mount=path.join(base,'mount');
  await fs.mkdir(mount);
  try {
    await run('hdiutil',['create','-quiet','-size','32m','-fs','ExFAT','-volname','BIRTHTEST',image]);
    await run('hdiutil',['attach','-quiet','-nobrowse','-mountpoint',mount,image]);
  } catch { await fs.rm(base,{recursive:true,force:true}); return undefined; }
  const prior=process.env.IMPORTER_NATIVE_BRIDGE;process.env.IMPORTER_NATIVE_BRIDGE=bridge;
  t.after(async()=>{if(prior===undefined)delete process.env.IMPORTER_NATIVE_BRIDGE;else process.env.IMPORTER_NATIVE_BRIDGE=prior;await run('hdiutil',['detach','-quiet','-force',mount]).catch(()=>{});await fs.rm(base,{recursive:true,force:true});});
  return {mount,image};
}
async function leftovers(folder:string){
  const found:string[]=[];
  for(const entry of await fs.readdir(folder,{withFileTypes:true,recursive:true})) if(/^photo-importer-(?!index)/.test(entry.name)) found.push(path.join(entry.parentPath,entry.name));
  return found;
}

test('exFAT: a stage dated with a sub-second capture time is released after the volume is re-attached before publishing',async t=>{
  const disk=await exfat(t);
  if(!disk) return t.skip('exFAT disk images or the native bridge are unavailable here');
  const source=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'exfat-birth-source-')));
  t.after(()=>fs.rm(source,{recursive:true,force:true}));
  await fs.writeFile(path.join(source,'DSC_0001.NEF'),Buffer.alloc(300_000,7));
  const root=path.join(disk.mount,'photobackup');await fs.mkdir(root);
  const reviewed=(await plan(source,[root],options,metadata('2024-02-03T12:00:00.370Z'))).plans[0]!;
  const link=files.link.bind(files);let cycled=false,devChanged=false;
  t.mock.method(files,'link',async(...args:Parameters<typeof files.link>)=>{
    if(!cycled){
      cycled=true;
      const before=(await fs.stat(disk.mount)).dev;
      const cycle=async()=>{await run('hdiutil',['detach','-quiet',disk.mount]);await run('hdiutil',['attach','-quiet','-nobrowse','-mountpoint',disk.mount,disk.image]);};
      await cycle();
      // A remount may get another device number, which no receipt can survive; try once more.
      if((await fs.stat(disk.mount)).dev!==before){await cycle();devChanged=(await fs.stat(disk.mount)).dev!==before;}
    }
    return link(...args);
  });syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const result=await execute(reviewed,undefined,undefined,{direct:false});
  t.mock.restoreAll();syncBuiltinESMExports();
  assert.equal(cycled,true);
  if(devChanged) return t.skip('the re-attached image got another device number, so the stage cannot be identified');
  assert.deepEqual(result.errors,[]);assert.equal(result.copied,1);
  assert.deepEqual(await leftovers(root),[]);
});

test('exFAT: a stage left behind with an old-style whole-second receipt is released after hashing on a re-import',async t=>{
  const disk=await exfat(t);
  if(!disk) return t.skip('exFAT disk images or the native bridge are unavailable here');
  const source=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'exfat-birth-source-')));
  t.after(()=>fs.rm(source,{recursive:true,force:true}));
  await fs.writeFile(path.join(source,'DSC_0001.NEF'),Buffer.alloc(300_000,7));
  const root=path.join(disk.mount,'photobackup');await fs.mkdir(root);
  const date=metadata('2024-02-03T12:00:00.370Z');
  const first=(await plan(source,[root],options,date)).plans[0]!,entry=first.entries[0]!;
  assert.equal((await execute(first)).copied,1);
  // The stage an old run left: a complete copy and a receipt recording the whole second its handle reported.
  const partial=path.join(path.dirname(entry.destination),`photo-importer-${randomUUID()}.partial`);
  await fs.copyFile(entry.destination,partial);
  const stat=await fs.lstat(partial,{bigint:true});
  await recordPartial('stage',partial,whole(stat),entry,first,new Map());
  assert.equal((await leftovers(root)).length,2);
  const again=(await plan(source,[root],options,date)).plans[0]!;
  assert.ok(again.entries.every(item=>item.skip));
  const result=await execute(again);
  assert.deepEqual(result.errors,[]);assert.equal(result.skipped,1);
  assert.deepEqual(await leftovers(root),[]);
});
