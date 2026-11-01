// "Clean up Mac system files" (the removeAppleDouble preference): imports skip Finder's .DS_Store and "._" files on
// sources while it is on, and imports and organizations remove .DS_Store from the folders they write to or move out of.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { plan, execute, executeReorganization, configureOrganizationRecovery, appleDoubleCleaner } from '../core/index';
import { appArtifactName, ignoredName, inventory, macSystemName } from '../core/inventory';
import { addAppleDoubleReport, emptyAppleDoubleReport } from '../core/appledouble';
import { defaultPreferences } from '../preferences';
import type { Metadata } from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const metadata=async():Promise<Metadata>=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}});
const importOptions={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
/** A real .DS_Store begins with version 1 and the "Bud1" magic. */
const finder=()=>Buffer.concat([Buffer.from([0,0,0,1]),Buffer.from('Bud1'),Buffer.alloc(4088)]);
const exists=(file:string)=>fs.lstat(file).then(()=>true,()=>false);
async function temp(t:test.TestContext,prefix:string){
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),prefix)));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  return base;
}
async function card(t:test.TestContext){
  const source=await temp(t,'mac-files-card-');
  await fs.mkdir(path.join(source,'DCIM'));
  await fs.writeFile(path.join(source,'DCIM','DSC_0001.JPG'),Buffer.alloc(120_000,9));
  await fs.writeFile(path.join(source,'DCIM','.DS_Store'),finder());
  await fs.writeFile(path.join(source,'DCIM','._DSC_0001.JPG'),Buffer.alloc(4096,1));
  return source;
}

test('the setting is on by default on every platform',()=>{
  assert.equal(defaultPreferences.removeAppleDouble,true);
});

test('app artifacts are always ignored; Mac system files only while the setting is on',()=>{
  for(const name of ['.DS_Store','.ds_store','._A.JPG','._x']){assert.ok(macSystemName(name),name);assert.ok(!appArtifactName(name),name);assert.ok(ignoredName(name),name);assert.ok(!ignoredName(name,true),name);}
  for(const name of ['Photo Importer Data','photo-importer-index.json','Thumbs.db','$RECYCLE.BIN']){assert.ok(appArtifactName(name),name);assert.ok(ignoredName(name,true),name);}
  assert.ok(!macSystemName('A.JPG')&&!macSystemName('_A.JPG'));
});

test('on: a listing skips .DS_Store and "._" files; off: they are listed as Mac system files, never as photos',async t=>{
  const source=await card(t);
  const on=await inventory(source,{});
  assert.deepEqual(on.files.map(file=>path.basename(file.path)),['DSC_0001.JPG']);
  const off=await inventory(source,{keepMacFiles:true});
  const mac=off.files.filter(file=>macSystemName(path.basename(file.path)));
  assert.deepEqual(mac.map(file=>path.basename(file.path)).sort(),['.DS_Store','._DSC_0001.JPG']);
  for(const file of mac){assert.equal(file.kind,'Other');assert.equal(file.system?.id,'macos-system');assert.equal(file.included,false,'an import skips them');}
  assert.equal(off.media,1,'"._DSC_0001.JPG" is not a photo');
  assert.ok((off.skipped??[]).filter(item=>item.reason==='system').length===2,'nothing is dropped silently');
  const backup=await inventory(source,{keepMacFiles:true,backup:true});
  assert.ok(backup.files.filter(file=>macSystemName(path.basename(file.path))).every(file=>file.included),'a backup listing takes them');
});

test('a remembered listing made with the other setting is never reused',async t=>{
  const source=await card(t);
  const first=await inventory(source,{});
  assert.equal(first.listing!.keepMacFiles,undefined);
  const off=await inventory(source,{keepMacFiles:true,reuse:first.listing});
  assert.equal(off.files.length,3,'listed again with the Mac files');
  assert.equal(off.listing!.keepMacFiles,true);
  const on=await inventory(source,{reuse:off.listing});
  assert.equal(on.files.length,1,'listed again without them');
});

test('planning and a Files & folders import follow the setting',async t=>{
  const source=await card(t),destination=await temp(t,'mac-files-dest-');
  const skipped=(await plan(source,[destination],{...importOptions},metadata)).inventory;
  assert.equal(skipped.files.length,1);
  const listed=(await plan(source,[destination],{...importOptions,keepMacFiles:true},metadata)).inventory;
  assert.equal(listed.files.length,3);
  // A Files & folders import takes every file: kept Mac files go with the rest, never as photos.
  const everything=(await plan(source,[destination],{...importOptions,everyFile:true,keepMacFiles:true},metadata)).plans[0]!;
  assert.deepEqual(everything.entries.map(entry=>path.basename(entry.source)).sort(),['.DS_Store','._DSC_0001.JPG','DSC_0001.JPG']);
  const skipping=(await plan(source,[destination],{...importOptions,everyFile:true},metadata)).plans[0]!;
  assert.deepEqual(skipping.entries.map(entry=>path.basename(entry.source)),['DSC_0001.JPG']);
});

test('an import removes .DS_Store from each folder it wrote to, once, and never from the source',async t=>{
  const source=await card(t),destination=await temp(t,'mac-files-dest-');
  const reviewed=(await plan(source,[destination],importOptions,metadata)).plans[0]!;
  const folder=path.dirname(reviewed.entries[0]!.destination);
  await fs.mkdir(folder,{recursive:true});
  await fs.writeFile(path.join(folder,'.DS_Store'),finder());
  // An untouched folder keeps its own.
  await fs.mkdir(path.join(destination,'other'));await fs.writeFile(path.join(destination,'other','.DS_Store'),finder());
  const result=await execute(reviewed,undefined,undefined,{removeAppleDouble:true});
  assert.deepEqual(result.errors,[]);assert.equal(result.copied,1);
  assert.equal(await exists(path.join(folder,'.DS_Store')),false);
  assert.equal(result.appleDouble!.dsStore,1);
  assert.ok(await exists(path.join(destination,'other','.DS_Store')));
  assert.ok(await exists(path.join(source,'DCIM','.DS_Store')),'the source is never touched');
  assert.ok(await exists(path.join(source,'DCIM','._DSC_0001.JPG')),'the source is never touched');
});

test('with the setting off an import leaves .DS_Store where it is',async t=>{
  const source=await card(t),destination=await temp(t,'mac-files-dest-');
  const reviewed=(await plan(source,[destination],importOptions,metadata)).plans[0]!;
  const folder=path.dirname(reviewed.entries[0]!.destination);
  await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'.DS_Store'),finder());
  const result=await execute(reviewed,undefined,undefined,{removeAppleDouble:false});
  assert.deepEqual(result.errors,[]);
  assert.ok(await exists(path.join(folder,'.DS_Store')));
  assert.equal(result.appleDouble,undefined);
});

test('organization removes .DS_Store from the folders it moves files into and out of',async t=>{
  const root=path.join(await temp(t,'mac-files-org-'),'library');
  await fs.mkdir(path.join(root,'incoming'),{recursive:true});await fs.mkdir(path.join(root,'unrelated'));
  await fs.writeFile(path.join(root,'incoming','M.JPG'),Buffer.alloc(5000,3));
  await fs.writeFile(path.join(root,'incoming','notes.txt'),'keeps the folder');
  await fs.writeFile(path.join(root,'incoming','.DS_Store'),finder());
  await fs.writeFile(path.join(root,'unrelated','notes.txt'),'not media');
  await fs.writeFile(path.join(root,'unrelated','.DS_Store'),finder());
  const review=(await plan(root,[root],{...importOptions,reorganize:true},metadata)).plans[0]!;
  assert.ok(!review.entries.some(entry=>path.basename(entry.source)==='.DS_Store'),'organization never moves a .DS_Store');
  const into=path.dirname(review.entries[0]!.destination);
  await fs.mkdir(into,{recursive:true});await fs.writeFile(path.join(into,'.DS_Store'),finder());
  const result=await executeReorganization(review,undefined,undefined,{removeAppleDouble:true});
  assert.deepEqual(result.errors,[]);
  assert.equal(await exists(path.join(root,'incoming','.DS_Store')),false,'where the file used to be');
  assert.equal(await exists(path.join(into,'.DS_Store')),false,'where the file went');
  assert.ok(await exists(path.join(root,'unrelated','.DS_Store')),'a folder it did not touch');
  assert.equal(result.appleDouble!.dsStore,2);
});

test('protected folders, a file that is not a .DS_Store, and links named .DS_Store are left alone',async t=>{
  const root=await temp(t,'mac-files-safety-'),cleaner=appleDoubleCleaner(),placed=()=>true;
  for(const name of ['Photo Importer Data','Photo Importer Recovery','Problem files']){
    const folder=path.join(root,name,'2024');await fs.mkdir(folder,{recursive:true});
    await fs.writeFile(path.join(folder,'A.JPG'),'a');await fs.writeFile(path.join(folder,'.DS_Store'),finder());
    await cleaner.besideFile(path.join(folder,'A.JPG'),root,placed);
    assert.ok(await exists(path.join(folder,'.DS_Store')),name);
  }
  const fake=path.join(root,'fake');await fs.mkdir(fake);
  await fs.writeFile(path.join(fake,'A.JPG'),'a');await fs.writeFile(path.join(fake,'.DS_Store'),'my own notes');
  await cleaner.besideFile(path.join(fake,'A.JPG'),root,placed);
  assert.equal(await fs.readFile(path.join(fake,'.DS_Store'),'utf8'),'my own notes','no .DS_Store magic: kept');
  const linked=path.join(root,'linked'),target=path.join(root,'target.bin');await fs.mkdir(linked);
  await fs.writeFile(path.join(linked,'A.JPG'),'a');await fs.writeFile(target,finder());
  try{await fs.symlink(target,path.join(linked,'.DS_Store'),'file');}
  catch(error){if((error as NodeJS.ErrnoException).code==='EPERM')return t.skip('file symbolic links need Developer Mode on this Windows');throw error;}
  await cleaner.besideFile(path.join(linked,'A.JPG'),root,placed);
  assert.ok((await fs.lstat(path.join(linked,'.DS_Store'))).isSymbolicLink(),'the link stays');
  assert.ok(await exists(target),'and so does what it points to');
  assert.equal(cleaner.report.dsStore,0);
});

test('reports add up, and older reports without the count still merge',()=>{
  const total=emptyAppleDoubleReport();
  addAppleDoubleReport(total,{...emptyAppleDoubleReport(),dsStore:2});
  addAppleDoubleReport(total,{removed:1,kept:0,orphans:0,warnings:[],folderWarnings:[],keptFiles:[],failures:[]} as unknown as ReturnType<typeof emptyAppleDoubleReport>);
  assert.equal(total.dsStore,2);assert.equal(total.removed,1);
});
