import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { plan, execute, executeReorganization, getOrganizationRecovery, configureOrganizationRecovery } from '../core/index';
import fsDefault from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
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
  // macOS may write them a moment after the file is closed: wait for them before deciding this drive makes none.
  for(let wait=0;wait<20&&(await sidecars(root)).length<2;wait++)await new Promise(resolve=>setTimeout(resolve,100));
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
  // The folder keeps a file: macOS removes a folder's ._ files itself when it removes the emptied folder.
  await fs.writeFile(path.join(library,'incoming','notes.txt'),'keep');
  await fs.writeFile(path.join(library,'incoming','._M.JPG'),appleDouble([provenance]));
  await fs.writeFile(path.join(library,'incoming','._GONE.JPG'),appleDouble([provenance]));
  await fs.writeFile(path.join(library,'incoming','._TAGGED.JPG'),appleDouble([provenance,tags]));
  const review=(await plan(library,[library],{...importOptions,reorganize:true},metadata)).plans[0]!;
  const result=await executeReorganization(review,undefined,undefined,{strategy:'rename',removeAppleDouble:true});
  assert.deepEqual(result.errors,[]);
  assert.deepEqual((await sidecars(library)).filter(name=>!name.startsWith('Photo Importer Recovery')).map(name=>path.basename(name)).filter(name=>name!=='._notes.txt'),['._TAGGED.JPG']);
  assert.ok(result.appleDouble!.orphans>=1&&result.appleDouble!.removed>=1);
});

// The 286-byte "intentionally left blank" resource fork macOS writes into every "._" file, as dumped from a real exFAT volume.
const STUB=Buffer.from('0000010000000100000000000000001e54686973207265736f7572636520666f726b20696e74656e74696f6e616c6c79206c65667420626c616e6b2020200000'+'00'.repeat(256-16-46-2)+'0000010000000100000000000000001e0000000000000000001c001effff','hex');
test('only the exact blank resource fork stub is accepted',()=>{
  assert.equal(STUB.length,286);
  assert.equal(inspectAppleDouble(appleDouble([provenance],{fork:STUB})).safe,true);
  const changed=Buffer.from(STUB);changed[100]=1;
  assert.equal(inspectAppleDouble(appleDouble([provenance],{fork:changed})).safe,false,'one byte changed');
  assert.equal(inspectAppleDouble(appleDouble([provenance],{fork:Buffer.concat([STUB,Buffer.from([1])])})).safe,false,'stub plus extra');
  const map=Buffer.from(STUB);map[270]=9;
  assert.equal(inspectAppleDouble(appleDouble([provenance],{fork:map})).safe,false,'non-empty map');
});
test('malformed extended attribute data is kept',()=>{
  const damage=(change:(buffer:Buffer)=>void)=>{const buffer=appleDouble([provenance]);change(buffer);return inspectAppleDouble(buffer).safe;};
  assert.equal(damage(buffer=>{buffer[84+36+10]=0;}),false,'name length 0');
  assert.equal(damage(buffer=>{buffer.writeUInt32BE(5000,84+36);}),false,'data past the end');
  assert.equal(damage(buffer=>{buffer.writeUInt32BE(40,34);}),false,'FinderInfo shorter than 34 bytes');
  assert.equal(damage(buffer=>{buffer.writeUInt32BE(100,34);}),false,'truncated table');
  assert.equal(damage(buffer=>{buffer.writeUInt16BE(40,84+34);}),false,'more attributes than the table holds');
  assert.equal(damage(buffer=>{buffer.writeUInt32BE(4,38);buffer[4000]=1;}),false,'unknown entry with content');
  assert.equal(damage(buffer=>{buffer.writeUInt32BE(60,30);}),false,'Finder info not at offset 50');
});

test('besideGone removes the sidecar only once the main file is gone',async t=>{
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'appledouble-')));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dir,'HERE.JPG'),'x');
  for(const name of ['._HERE.JPG','._GONE.JPG'])await fs.writeFile(path.join(dir,name),appleDouble([provenance]));
  const cleaner=new AppleDoubleCleaner();
  await cleaner.besideGone(path.join(dir,'HERE.JPG'),dir);
  await cleaner.besideGone(path.join(dir,'GONE.JPG'),dir);
  assert.deepEqual((await fs.readdir(dir)).sort(),['._HERE.JPG','HERE.JPG']);
  assert.equal(cleaner.report.removed,1);
});

test('a sweep skips protected folders at depth, symlinked folders and other volumes, and looks only at the folders it is given',async t=>{
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'appledouble-sweep-')));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const root=path.join(base,'root');
  const folders=['Photo Importer Recovery/a','Problem files/Empty files','Drive backups/A/deep','real','other','linked'];
  for(const folder of folders.slice(0,5)){
    await fs.mkdir(path.join(root,folder),{recursive:true});
    await fs.writeFile(path.join(root,folder,'X.JPG'),'x');await fs.writeFile(path.join(root,folder,'._X.JPG'),appleDouble([provenance]));
    await fs.writeFile(path.join(root,folder,'._ORPHAN.JPG'),appleDouble([provenance]));
  }
  await fs.mkdir(path.join(base,'outside'));await fs.writeFile(path.join(base,'outside','._Y.JPG'),appleDouble([provenance]));
  await fs.symlink(path.join(base,'outside'),path.join(root,'linked'));
  const cleaner=new AppleDoubleCleaner(['Photo Importer Recovery','Problem files','Drive backups']);
  await cleaner.sweep(root,folders.map(folder=>path.join(root,folder)));
  const left=async(folder:string)=>(await fs.readdir(path.join(root,folder))).filter(name=>name.startsWith('._'));
  for(const folder of folders.slice(0,3))assert.deepEqual(await left(folder),['._ORPHAN.JPG','._X.JPG'],folder);
  assert.deepEqual(await left('real'),[]);
  assert.deepEqual(await left('other'),[]);
  assert.deepEqual(await fs.readdir(path.join(base,'outside')),['._Y.JPG'],'a linked folder is never entered');
  assert.deepEqual([cleaner.report.removed,cleaner.report.orphans],[2,2]);
  assert.ok(cleaner.report.folderWarnings.length>=1,'the linked folder is reported');
});

test('a sweep does not cross onto another volume',async t=>{
  const mount=await exfat(t);
  if(!mount)return t.skip('exFAT disk images are unavailable here');
  const parent=path.dirname(mount);
  await fs.writeFile(path.join(mount,'Z.JPG'),'x');await fs.writeFile(path.join(mount,'._Z.JPG'),appleDouble([provenance]));
  const cleaner=new AppleDoubleCleaner();
  await cleaner.sweep(parent,[mount]);
  assert.equal(cleaner.report.removed,0);
  assert.ok(await fs.lstat(path.join(mount,'._Z.JPG')).then(()=>true,()=>false));
});

async function library(t:test.TestContext){
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'appledouble-org-')));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const root=path.join(base,'library');
  await fs.mkdir(path.join(root,'incoming'),{recursive:true});await fs.mkdir(path.join(root,'unrelated'));
  await fs.writeFile(path.join(root,'incoming','M.JPG'),Buffer.alloc(5000,3));
  await fs.writeFile(path.join(root,'incoming','._M.JPG'),appleDouble([provenance]));
  await fs.writeFile(path.join(root,'incoming','._GONE.JPG'),appleDouble([provenance]));
  await fs.writeFile(path.join(root,'unrelated','notes.txt'),'not media');
  await fs.writeFile(path.join(root,'unrelated','._U.JPG'),appleDouble([provenance]));
  const review=(await plan(root,[root],{...importOptions,reorganize:true},metadata)).plans[0]!;
  return {root,review};
}
const organize={strategy:'rename' as const,removeAppleDouble:true};

test('organizing one file looks only at the folders it touched',async t=>{
  const {root,review}=await library(t);
  const read:string[]=[],readdir=fsDefault.readdir.bind(fsDefault);
  t.mock.method(fsDefault,'readdir',(async(...args:unknown[])=>{read.push(String(args[0]));return (readdir as (...values:unknown[])=>Promise<unknown>)(...args);}) as unknown as typeof fsDefault.readdir);
  syncBuiltinESMExports();
  try{
    const result=await executeReorganization(review,undefined,undefined,organize);
    assert.deepEqual(result.errors,[]);
    assert.ok(!read.some(folder=>folder.startsWith(path.join(root,'unrelated'))),'the unrelated folder was not read');
    assert.ok(await fs.lstat(path.join(root,'unrelated','._U.JPG')).then(()=>true,()=>false),'its orphan sidecar is left');
    assert.equal(await fs.lstat(path.join(root,'incoming','._GONE.JPG')).then(()=>true,()=>false),false,'a swept orphan beside the moved file went');
    assert.equal(result.appleDouble!.orphans,1);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('a sweep that fails is a warning: the organization is still complete',async t=>{
  const {root,review}=await library(t);
  const readdir=fsDefault.readdir.bind(fsDefault);
  t.mock.method(fsDefault,'readdir',(async(...args:unknown[])=>{if(args[1]&&String(args[0]).endsWith('incoming'))throw Object.assign(new Error('EIO: sweep failed'),{code:'EIO'});return (readdir as (...values:unknown[])=>Promise<unknown>)(...args);}) as unknown as typeof fsDefault.readdir);
  syncBuiltinESMExports();
  try{
    const result=await executeReorganization(review,undefined,undefined,organize);
    assert.deepEqual(result.errors,[]);
    assert.ok(result.appleDouble!.folderWarnings.length>=1);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
  assert.equal((await getOrganizationRecovery(root))[0]!.status,'complete');
});

test('Stop during the sweep still leaves a complete organization',async t=>{
  const {root,review}=await library(t);
  const stop=new AbortController(),readdir=fsDefault.readdir.bind(fsDefault);
  t.mock.method(fsDefault,'readdir',(async(...args:unknown[])=>{if(args[1]&&String(args[0]).endsWith('incoming'))stop.abort();return (readdir as (...values:unknown[])=>Promise<unknown>)(...args);}) as unknown as typeof fsDefault.readdir);
  syncBuiltinESMExports();
  try{await executeReorganization(review,stop.signal,undefined,organize).catch(()=>undefined);}
  finally{t.mock.restoreAll();syncBuiltinESMExports();}
  assert.equal((await getOrganizationRecovery(root))[0]!.status,'complete');
  assert.ok(await fs.lstat(path.join(root,'2024')).then(()=>true,()=>false)||(await fs.readdir(root)).length>0);
});

test('kept and failed "._" files become grouped warnings, never errors',async()=>{
  const {appleDoubleIssues,errorTotal,recordIssues}=await import('../job-issues');
  const {emptyAppleDoubleReport}=await import('../core/appledouble');
  const report=emptyAppleDoubleReport();
  report.keptFiles.push('/lib/._A.JPG','/lib/._B.JPG');
  report.failures.push({path:'/lib/._C.JPG',detail:'EACCES'},{path:'/lib/x',detail:'EPERM',folder:true});
  const job={errors:[],groups:undefined as any} as any;
  recordIssues(job,appleDoubleIssues(report));
  assert.deepEqual(job.groups.map((g:any)=>[g.code,g.severity,g.count]),[['appledouble-kept','warning',2],['appledouble-failed','warning',2]]);
  assert.equal(errorTotal(job),0);
  assert.deepEqual(appleDoubleIssues(undefined),[]);
});
