// "Clean up Mac system files": the "._" files macOS makes for everything the app creates, moves or renames on a
// volume without extended attributes (folders, records, stages), not only the ones beside published photos.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { plan, execute, executeReorganization, configureOrganizationRecovery, getOrganizationRecovery, undoOrganization } from '../core/index';
import { registerDestinations } from '../core/app-store';
import { emptyAppleDoubleReport } from '../core/appledouble';
import { removeEmptiedFolders } from '../core/redundant-folders';
import { bookkeepingSidecar, labelledSidecar, sidecarsUnder, simulateMacSidecars } from './fixtures/mac-sidecars';
import type { Metadata } from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const metadata=async():Promise<Metadata>=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}});
const importOptions={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const exists=(file:string)=>fs.lstat(file).then(()=>true,()=>false);
async function temp(t:test.TestContext,prefix:string){
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),prefix)));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  return base;
}
/** A drive whose records live at its top, as on the user's SSD: <drive>/Photo Importer Data and <drive>/photobackup. */
async function drive(t:test.TestContext){
  const top=await temp(t,'own-drive-'),library=path.join(top,'photobackup');await fs.mkdir(library);
  registerDestinations([top]);t.after(()=>registerDestinations([]));
  return {top,library};
}
async function card(t:test.TestContext){
  const source=await temp(t,'own-card-');
  await fs.writeFile(path.join(source,'DSC_0001.NEF'),Buffer.alloc(300_000,7));
  await fs.writeFile(path.join(source,'DSC_0002.JPG'),Buffer.alloc(120_000,9));
  return source;
}

test('an import leaves no "._" file beside the folders, records and stages it created',async t=>{
  const {top,library}=await drive(t),source=await card(t);
  simulateMacSidecars(t,top);
  const reviewed=(await plan(source,[library],importOptions,metadata)).plans[0]!;
  const result=await execute(reviewed,undefined,undefined,{removeAppleDouble:true});
  assert.deepEqual(result.errors,[]);assert.equal(result.copied,2);
  assert.deepEqual(await sidecarsUnder(top),[]);
  // The year, month and camera folders, the records folder and its subfolders, and the photos.
  assert.ok(result.appleDouble!.removed>=6,`removed ${result.appleDouble!.removed}`);
  assert.deepEqual(result.appleDouble!.warnings,[]);
});

test('with the setting off the simulated macOS sidecars stay, so the test above proves the cleanup',async t=>{
  const {top,library}=await drive(t),source=await card(t);
  simulateMacSidecars(t,top);
  const result=await execute((await plan(source,[library],importOptions,metadata)).plans[0]!);
  assert.deepEqual(result.errors,[]);
  const left=await sidecarsUnder(top);
  assert.ok(left.includes('photobackup/._2024')&&left.includes('._Photo Importer Data'),left.join(', '));
});

test('a "._" that was there before the import made its folder is kept and reported',async t=>{
  const {top,library}=await drive(t),source=await card(t);
  await fs.writeFile(path.join(library,'._2024'),bookkeepingSidecar());
  simulateMacSidecars(t,top);
  const result=await execute((await plan(source,[library],importOptions,metadata)).plans[0]!,undefined,undefined,{removeAppleDouble:true});
  assert.deepEqual(result.errors,[]);
  assert.deepEqual(await sidecarsUnder(top),['photobackup/._2024']);
  assert.ok(result.appleDouble!.kept>=1&&result.appleDouble!.keptFiles.includes(path.join(library,'._2024')));
});

test('an organization cleans its records and folders, keeps a tagged "._", and can still be undone',async t=>{
  const {top,library}=await drive(t);
  const incoming=path.join(library,'incoming');await fs.mkdir(incoming);
  await fs.writeFile(path.join(incoming,'M.JPG'),Buffer.alloc(5000,3));await fs.writeFile(path.join(incoming,'notes.txt'),'keep');
  // Left by a Mac earlier: the library's own "._", and one holding a Finder label.
  await fs.writeFile(path.join(top,'._photobackup'),bookkeepingSidecar());
  await fs.writeFile(path.join(incoming,'._TAGGED.JPG'),labelledSidecar());
  const review=(await plan(library,[library],{...importOptions,reorganize:true},metadata)).plans[0]!;
  simulateMacSidecars(t,top);
  const result=await executeReorganization(review,undefined,undefined,{removeAppleDouble:true});
  assert.deepEqual(result.errors,[]);assert.equal(result.moved,1);
  assert.deepEqual(await sidecarsUnder(top),['photobackup/incoming/._TAGGED.JPG']);
  assert.ok(result.appleDouble!.kept>=1);
  const [job]=await getOrganizationRecovery(library);
  const undone=await undoOrganization(library,job!.id);
  assert.ok(await exists(path.join(incoming,'M.JPG')),`undo put the photo back: ${JSON.stringify(undone)}`);
});

test('a folder emptied by an organization goes with its bookkeeping "._" files, inside and beside it',async t=>{
  const {top,library}=await drive(t);
  const incoming=path.join(library,'incoming');await fs.mkdir(incoming);
  await fs.writeFile(path.join(incoming,'M.JPG'),Buffer.alloc(5000,3));
  await fs.writeFile(path.join(incoming,'._GONE.JPG'),bookkeepingSidecar());await fs.writeFile(path.join(library,'._incoming'),bookkeepingSidecar());
  const review=(await plan(library,[library],{...importOptions,reorganize:true},metadata)).plans[0]!;
  const result=await executeReorganization(review,undefined,undefined,{removeAppleDouble:true});
  assert.deepEqual(result.errors,[]);
  assert.equal(await exists(incoming),false);assert.equal(result.foldersRemoved,1);
  assert.equal(await exists(path.join(library,'._incoming')),false);
  assert.deepEqual(await sidecarsUnder(top),[]);
  assert.ok(result.appleDouble!.orphans+result.appleDouble!.removed>=2);
});

test('emptied-folder removal: only bookkeeping "._" files go, and the folder\'s own one only while the setting is on',async t=>{
  const root=await temp(t,'own-emptied-');
  for(const name of ['on','off','tagged']){await fs.mkdir(path.join(root,name));await fs.writeFile(path.join(root,name,'._x'),name==='tagged'?labelledSidecar():bookkeepingSidecar());await fs.writeFile(path.join(root,'._'+name),bookkeepingSidecar());}
  const report=emptyAppleDoubleReport();
  assert.equal(await removeEmptiedFolders(root,[path.join(root,'on'),path.join(root,'tagged')],{area:'test',after:'a test',appleDouble:report}),1);
  assert.equal(await removeEmptiedFolders(root,[path.join(root,'off')],{area:'test',after:'a test'}),1);
  assert.deepEqual((await fs.readdir(root)).sort(),['._off','._tagged','tagged']);
  assert.deepEqual(await fs.readdir(path.join(root,'tagged')),['._x'],'a labelled "._" keeps its folder');
  assert.equal(report.orphans,2);
});

test('library organization removes the "._" files earlier runs left in the records folder, keeping a labelled one',async t=>{
  const {top,library}=await drive(t),source=await card(t);
  assert.deepEqual((await execute((await plan(source,[library],importOptions,metadata)).plans[0]!)).errors,[]);
  // Left by an earlier run on a Mac, in folders this session never wrote to.
  const store=path.join(top,'Photo Importer Data'),old=path.join(store,'Organizations','11111111-1111-4111-8111-111111111111','originals','0','slot');
  await fs.mkdir(old,{recursive:true});await fs.writeFile(path.join(old,'A.JPG'),'kept original');
  for(const file of [path.join(old,'._A.JPG'),path.join(old,'..','._slot'),path.join(old,'..','..','._0'),path.join(store,'._store.json'),path.join(top,'._Photo Importer Data')])await fs.writeFile(file,bookkeepingSidecar());
  await fs.writeFile(path.join(store,'._labelled'),labelledSidecar());
  const incoming=path.join(library,'incoming');await fs.mkdir(incoming);await fs.writeFile(path.join(incoming,'M.JPG'),Buffer.alloc(5000,3));
  const review=(await plan(library,[library],{...importOptions,reorganize:true},metadata)).plans[0]!;
  const result=await executeReorganization(review,undefined,undefined,{removeAppleDouble:true});
  assert.deepEqual(result.errors,[]);
  assert.deepEqual(await sidecarsUnder(top),['Photo Importer Data/._labelled']);
  assert.ok(await exists(path.join(old,'A.JPG')),'the kept original itself is never touched');
  assert.ok(result.appleDouble!.kept>=1);
});
