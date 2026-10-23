import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { plan, execute, executeReorganization, configureOrganizationRecovery } from '../core/index';
import { AppleDoubleCleaner, inspectAppleDouble, APPLEDOUBLE_MAX_BYTES } from '../core/appledouble';
import { defaultPreferences, normalizePreferences } from '../preferences';
import { lockedPreferenceKeys } from '../settings-lock';
import type { Metadata } from '../shared';

const run=promisify(execFile);
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const metadata=async():Promise<Metadata>=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}});

/** An AppleDouble file laid out as macOS writes it: Finder info, an ATTR block of extended attributes, a padded resource fork entry. */
function appleDouble(attributes:[string,Buffer][],options:{finder?:Buffer;fork?:Buffer;magic?:number}={}):Buffer {
  const names=attributes.map(([name])=>Buffer.from(name+'\0')),table=names.reduce((sum,name)=>sum+((11+name.length+3)&~3),0);
  const dataTotal=attributes.reduce((sum,[,data])=>sum+data.length,0);
  const finderLength=32+2+36+table+dataTotal;
  const buffer=Buffer.alloc(4096);
  buffer.writeUInt32BE(options.magic??0x00051607,0);buffer.writeUInt32BE(0x00020000,4);buffer.write('Mac OS X',8);
  buffer.writeUInt16BE(2,24);
  buffer.writeUInt32BE(9,26);buffer.writeUInt32BE(50,30);buffer.writeUInt32BE(finderLength,34);
  buffer.writeUInt32BE(2,38);buffer.writeUInt32BE(50+finderLength,42);buffer.writeUInt32BE(options.fork?.length??4096-50-finderLength,46);
  (options.finder??Buffer.alloc(32)).copy(buffer,50);
  buffer.write('ATTR',84);buffer.writeUInt16BE(attributes.length,84+34);
  let at=84+36,data=84+36+table;
  for(const [index,[,value]] of attributes.entries()){
    buffer.writeUInt32BE(data,at);buffer.writeUInt32BE(value.length,at+4);buffer[at+10]=names[index]!.length;names[index]!.copy(buffer,at+11);
    value.copy(buffer,data);data+=value.length;at+=(11+names[index]!.length+3)&~3;
  }
  if(options.fork)options.fork.copy(buffer,50+finderLength);
  return buffer;
}
const provenance:[string,Buffer]=['com.apple.provenance',Buffer.from([1,2,0,0x4c,0x91,0xe1,0x96,0x9e,0xb2,0x6f,0xd8])];
const tags:[string,Buffer]=['com.apple.metadata:_kMDItemUserTags',Buffer.from('red')];

test('an AppleDouble file with only the provenance attribute is safe to remove',()=>{
  assert.deepEqual(inspectAppleDouble(appleDouble([provenance])),{safe:true});
  assert.deepEqual(inspectAppleDouble(appleDouble([])),{safe:true});
});
test('Finder tags, comments, quarantine and other attributes keep the file',()=>{
  for(const name of ['com.apple.metadata:_kMDItemUserTags','com.apple.metadata:kMDItemWhereFroms','com.apple.metadata:kMDItemFinderComment','com.apple.quarantine','com.apple.lastuseddate#PS','com.apple.macl'])
    assert.equal(inspectAppleDouble(appleDouble([provenance,[name,Buffer.from('x')]])).safe,false,name);
});
test('Finder info that is set keeps the file, a zero FinderInfo attribute does not',()=>{
  const label=Buffer.alloc(32);label[9]=0x0c;
  assert.equal(inspectAppleDouble(appleDouble([provenance],{finder:label})).safe,false);
  assert.equal(inspectAppleDouble(appleDouble([provenance,['com.apple.FinderInfo',Buffer.alloc(32)]])).safe,true);
  assert.equal(inspectAppleDouble(appleDouble([provenance,['com.apple.FinderInfo',Buffer.alloc(32,1)]])).safe,false);
});
test('a resource fork with content keeps the file',()=>{
  assert.equal(inspectAppleDouble(appleDouble([provenance],{fork:Buffer.from('fork data')})).safe,false);
});
test('a wrong magic, a truncated file and an oversized file are kept',()=>{
  assert.equal(inspectAppleDouble(appleDouble([provenance],{magic:0x00051600})).safe,false);
  assert.equal(inspectAppleDouble(appleDouble([provenance]).subarray(0,60)).safe,false);
  assert.equal(inspectAppleDouble(Buffer.alloc(APPLEDOUBLE_MAX_BYTES+1)).safe,false);
});

test('a symbolic link, an oversized file and a tagged file are kept; a plain one is removed',async t=>{
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'appledouble-')));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const media=['A.JPG','B.JPG','C.JPG','D.JPG'];
  for(const name of media)await fs.writeFile(path.join(dir,name),'x');
  await fs.writeFile(path.join(dir,'._A.JPG'),appleDouble([provenance]));
  await fs.writeFile(path.join(dir,'target'),appleDouble([provenance]));
  await fs.symlink('target',path.join(dir,'._B.JPG'));
  await fs.writeFile(path.join(dir,'._C.JPG'),Buffer.alloc(APPLEDOUBLE_MAX_BYTES+1));
  await fs.writeFile(path.join(dir,'._D.JPG'),appleDouble([provenance,tags]));
  const cleaner=new AppleDoubleCleaner();
  for(const name of media)await cleaner.besideFile(path.join(dir,name),dir,()=>true);
  assert.deepEqual({removed:cleaner.report.removed,kept:cleaner.report.kept,warnings:cleaner.report.warnings},{removed:1,kept:3,warnings:[]});
  assert.deepEqual((await fs.readdir(dir)).sort(),['A.JPG','B.JPG','C.JPG','D.JPG','target','._B.JPG','._C.JPG','._D.JPG'].sort());
});

test('a sidecar that was there before an import is kept, and one beside a changed file is not touched',async t=>{
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'appledouble-')));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dir,'A.JPG'),'x');await fs.writeFile(path.join(dir,'B.JPG'),'x');
  for(const name of ['._A.JPG','._B.JPG'])await fs.writeFile(path.join(dir,name),appleDouble([provenance]));
  const cleaner=new AppleDoubleCleaner();
  await cleaner.noteExisting(path.join(dir,'A.JPG'));
  await cleaner.besideFile(path.join(dir,'A.JPG'),dir,()=>true);
  await cleaner.besideFile(path.join(dir,'B.JPG'),dir,()=>false);
  assert.deepEqual([cleaner.report.removed,cleaner.report.kept],[0,1]);
  assert.equal((await fs.readdir(dir)).filter(name=>name.startsWith('._')).length,2);
});

test('the setting is on by default, persists, and is locked while a job runs',()=>{
  assert.equal(defaultPreferences.removeAppleDouble,true);
  assert.equal(normalizePreferences({}).removeAppleDouble,true);
  assert.equal(normalizePreferences({removeAppleDouble:false}).removeAppleDouble,false);
  assert.deepEqual(lockedPreferenceKeys({removeAppleDouble:false}),['removeAppleDouble']);
});

async function exfat(t:test.TestContext):Promise<string|undefined> {
  if(process.platform!=='darwin')return undefined;
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'appledouble-disk-')));
  const image=path.join(base,'drive.dmg'),mount=path.join(base,'mount');
  await fs.mkdir(mount);
  try{
    await run('hdiutil',['create','-quiet','-size','32m','-fs','ExFAT','-volname','ADTEST',image]);
    await run('hdiutil',['attach','-quiet','-nobrowse','-mountpoint',mount,image]);
  }catch{await fs.rm(base,{recursive:true,force:true});return undefined;}
  t.after(async()=>{await run('hdiutil',['detach','-quiet','-force',mount]).catch(()=>{});await fs.rm(base,{recursive:true,force:true});});
  return mount;
}
// Only those beside files: macOS also makes one for each folder, which this feature does not touch.
const sidecars=async(folder:string)=>(await fs.readdir(folder,{recursive:true})).filter(name=>/^\._.*\.[A-Za-z0-9]+$/.test(path.basename(name))).sort();
async function card(t:test.TestContext){
  const source=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'appledouble-card-')));
  t.after(()=>fs.rm(source,{recursive:true,force:true}));
  await fs.writeFile(path.join(source,'DSC_0001.NEF'),Buffer.alloc(300_000,7));
  await fs.writeFile(path.join(source,'DSC_0002.JPG'),Buffer.alloc(120_000,9));
  return source;
}
const importOptions={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};

test('an import on exFAT leaves no ._ file beside the published files',async t=>{
  const mount=await exfat(t);
  if(!mount)return t.skip('exFAT disk images are unavailable here');
  const root=path.join(mount,'photobackup');await fs.mkdir(root);
  const reviewed=(await plan(await card(t),[root],importOptions,metadata)).plans[0]!;
  const result=await execute(reviewed,undefined,undefined,{removeAppleDouble:true});
  assert.deepEqual(result.errors,[]);assert.equal(result.copied,2);
  assert.deepEqual(await sidecars(root),[]);
  assert.ok(result.appleDouble&&result.appleDouble.warnings.length===0);
});

test('with the setting off the sidecars macOS made are left alone',async t=>{
  const mount=await exfat(t);
  if(!mount)return t.skip('exFAT disk images are unavailable here');
  const root=path.join(mount,'photobackup');await fs.mkdir(root);
  const reviewed=(await plan(await card(t),[root],importOptions,metadata)).plans[0]!;
  const result=await execute(reviewed);
  assert.equal(result.appleDouble,undefined);
  if(!(await sidecars(root)).length)return t.skip('this macOS made no ._ files on exFAT');
  assert.ok((await sidecars(root)).length>=2);
});

test('an orphan present before an import stays; organization removes moved-file sidecars and swept orphans',async t=>{
  const mount=await exfat(t);
  if(!mount)return t.skip('exFAT disk images are unavailable here');
  const root=path.join(mount,'photobackup');await fs.mkdir(root);
  const reviewed=(await plan(await card(t),[root],importOptions,metadata)).plans[0]!;
  const first=reviewed.entries[0]!;
  await fs.mkdir(path.dirname(first.destination),{recursive:true});
  const orphan=path.join(path.dirname(first.destination),'._'+path.basename(first.destination));
  await fs.writeFile(orphan,appleDouble([provenance]));
  const imported=await execute(reviewed,undefined,undefined,{removeAppleDouble:true});
  assert.deepEqual(imported.errors,[]);
  assert.ok(await fs.lstat(orphan).then(()=>true,()=>false),'the pre-existing sidecar is kept during the import');
  assert.equal(imported.appleDouble!.kept,1);
  // Organization: a misfiled photo, a kept (tagged) sidecar, and an orphan.
  const library=path.join(mount,'library');await fs.mkdir(path.join(library,'incoming'),{recursive:true});
  await fs.writeFile(path.join(library,'incoming','M.JPG'),Buffer.alloc(5000,3));
  await fs.writeFile(path.join(library,'incoming','._M.JPG'),appleDouble([provenance]));
  await fs.writeFile(path.join(library,'._GONE.JPG'),appleDouble([provenance]));
  await fs.writeFile(path.join(library,'._TAGGED.JPG'),appleDouble([provenance,tags]));
  const review=(await plan(library,[library],{...importOptions,reorganize:true},metadata)).plans[0]!;
  const result=await executeReorganization(review,undefined,undefined,{strategy:'rename',removeAppleDouble:true});
  assert.deepEqual(result.errors,[]);
  assert.deepEqual((await sidecars(library)).filter(name=>!name.startsWith('Photo Importer Recovery')).map(name=>path.basename(name)),['._TAGGED.JPG'],'recovery storage is never touched');
  assert.ok(result.appleDouble!.orphans>=1&&result.appleDouble!.removed>=1);
});
