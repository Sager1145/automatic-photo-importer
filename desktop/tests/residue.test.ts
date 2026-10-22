import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {readdirSync,statSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {plan,execute,executeReorganization,configureOrganizationRecovery} from '../core/index';
import {recordPartial} from '../core/import-recovery';
import {findResidue,cleanResidue} from '../core/residue';
import type {Metadata} from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}});

async function base(t:test.TestContext,name:string):Promise<string> {
  const folder=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),name)));
  t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  return folder;
}
async function names(folder:string):Promise<string[]> {
  return (await fs.readdir(folder,{recursive:true})).map(String).sort();
}
/** Aborted once `check` holds: a deterministic Stop in the middle of a write. */
const stopWhen=(check:()=>boolean)=>({get aborted(){try{return check();}catch{return false;}}}) as AbortSignal;

test('Stop while organization copies a file leaves no staged copy in the journal folder',async t=>{
  const root=await base(t,'residue-organize-');
  const original=path.join(root,'incoming','DSC_0001.NEF');
  await fs.mkdir(path.dirname(original));await fs.writeFile(original,Buffer.alloc(3*1024*1024,5));
  const reviewed=(await plan(root,[root],{...options,reorganize:true},metadata)).plans[0]!;
  const storage=path.join(root,'Photo Importer Recovery');
  const staged=()=>readdirSync(storage).flatMap(id=>{try{return readdirSync(path.join(storage,id)).filter(name=>name.startsWith('stage-')).map(name=>path.join(storage,id,name));}catch{return [];}});
  await assert.rejects(executeReorganization(reviewed,stopWhen(()=>staged().some(file=>statSync(file).size>0)),undefined,{strategy:'copy'}),{name:'AbortError'});
  assert.deepEqual(staged(),[]);
  assert.equal((await fs.stat(original)).size,3*1024*1024);
});

/** A destination as interrupted imports and organizations leave it, beside user files with similar names. */
async function littered(t:test.TestContext) {
  const folder=await base(t,'residue-');
  const card=path.join(folder,'card'),root=path.join(folder,'backup'),temporary=path.join(folder,'tmp');
  await fs.mkdir(card);await fs.mkdir(root);await fs.mkdir(temporary);
  await fs.writeFile(path.join(card,'DSC_0001.NEF'),Buffer.alloc(4000,1));
  await fs.writeFile(path.join(card,'DSC_0002.NEF'),Buffer.alloc(5000,2));
  const reviewed=(await plan(card,[root],options,metadata)).plans[0]!;
  const [first,second]=reviewed.entries as [typeof reviewed.entries[0],typeof reviewed.entries[0]];
  const camera=path.dirname(first.destination);await fs.mkdir(camera,{recursive:true});
  // Resumable: a staged prefix whose signed receipt still binds it to the unchanged card file.
  const resumable=path.join(camera,`photo-importer-${randomUUID()}.partial`);
  await fs.writeFile(resumable,Buffer.alloc(1000,1));
  const resumableReceipt=(await recordPartial('stage',resumable,await fs.lstat(resumable,{bigint:true}),first,reviewed,new Map())).journal;
  // Orphans: a staged copy without a receipt, and a receipt whose staged copy is gone.
  const orphan=path.join(camera,`.import-${randomUUID()}.partial`);await fs.writeFile(orphan,Buffer.alloc(2500,9));
  const gone=path.join(camera,`photo-importer-${randomUUID()}.partial`);await fs.writeFile(gone,'x');
  const goneReceipt=(await recordPartial('stage',gone,await fs.lstat(gone,{bigint:true}),second,reviewed,new Map())).journal;await fs.unlink(gone);
  // A publication receipt still bound to its file is the existing recovery path: kept.
  await fs.writeFile(second.destination,Buffer.alloc(100,2));
  const bound=(await recordPartial('publication',second.destination,await fs.lstat(second.destination,{bigint:true}),{...second,digest:'0'.repeat(64)},reviewed,new Map())).journal;
  // A publication receipt whose file is gone protects nothing.
  const vanished=path.join(camera,'DSC_0009.NEF');await fs.writeFile(vanished,'x');
  const vanishedReceipt=(await recordPartial('publication',vanished,await fs.lstat(vanished,{bigint:true}),{...first,digest:'1'.repeat(64)},reviewed,new Map())).journal;await fs.unlink(vanished);
  // A receipt that does not authenticate with this host's key is not this app's to judge.
  const foreign=path.join(camera,`photo-importer-stage-${randomUUID()}.json`);await fs.writeFile(foreign,JSON.stringify({version:1,kind:'stage',file:orphan,seal:'0'.repeat(64)}));
  const indexTemp=path.join(root,`.photo-importer-index-${randomUUID()}.tmp`);await fs.writeFile(indexTemp,'{}');
  const visibleIndexTemp=path.join(root,`photo-importer-index-${randomUUID()}.tmp`);await fs.writeFile(visibleIndexTemp,'{}');
  // Organization journal: a staged copy and a preserved incomplete copy, an emptied slot, and a kept original.
  const job=path.join(root,'.photo-importer-recovery',randomUUID());
  await fs.mkdir(path.join(job,'originals','0',randomUUID()),{recursive:true});
  const kept=path.join(job,'originals','1',randomUUID(),'DSC_0003.NEF');await fs.mkdir(path.dirname(kept),{recursive:true});await fs.writeFile(kept,'kept for undo');
  await fs.writeFile(path.join(job,'manifest.json'),'{}');await fs.writeFile(path.join(job,'events.log'),'');
  const organizationStage=path.join(job,`stage-${randomUUID()}.partial`);await fs.writeFile(organizationStage,Buffer.alloc(3000));
  const incomplete=path.join(job,`incomplete-${randomUUID()}`);await fs.writeFile(incomplete,Buffer.alloc(700));
  // Camera downloads and previews left in the system temporary folder; one still in use.
  const camera1=path.join(temporary,'photo-importer-camera-Ab12Cd');await fs.mkdir(path.join(camera1,'DCIM'),{recursive:true});await fs.writeFile(path.join(camera1,'DCIM','IMG_0001.JPG'),Buffer.alloc(1200));
  const preview=path.join(temporary,'photo-importer-preview-Zz9Yy8');await fs.mkdir(preview);
  const inUse=path.join(temporary,'photo-importer-preview-InUse1');await fs.mkdir(inUse);
  // User files that only look similar.
  const user=[path.join(camera,'.import-holiday.partial'),path.join(camera,`import-${randomUUID()}.partial`),path.join(camera,`.import-${randomUUID()}.partial.jpg`),path.join(camera,`.import-stage-${randomUUID()}.json.bak`),path.join(root,'.photo-importer-index.json'),path.join(temporary,'photo-importer-electron-fixtures','keep.txt'),path.join(job,'notes.txt')];
  for(const file of user){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'user data');}
  const hidden=path.join(root,'.Trashes',`.import-${randomUUID()}.partial`);await fs.mkdir(path.dirname(hidden));await fs.writeFile(hidden,'not looked at');
  return {card,root,temporary,inUse,resumable,resumableReceipt,orphan,goneReceipt,vanishedReceipt,bound,second,foreign,indexTemp,visibleIndexTemp,kept,organizationStage,incomplete,camera1,preview,user,hidden,emptySlot:path.join(job,'originals','0')};
}

test('residue lists only the app\'s own leftovers, with resumable copies apart',async t=>{
  const f=await littered(t);
  const found=await findResidue([f.root],{temporary:f.temporary,inUse:()=>[f.inUse]});
  const listed=new Map(found.items.map(item=>[item.path,item.kind]));
  assert.equal(listed.get(f.resumable),'resumable');assert.equal(listed.get(f.resumableReceipt),'resumable');
  assert.equal(listed.get(f.orphan),'partial');assert.equal(listed.get(f.goneReceipt),'receipt');assert.equal(listed.get(f.vanishedReceipt),'receipt');
  assert.equal(listed.get(f.indexTemp),'index');assert.equal(listed.get(f.visibleIndexTemp),'index');
  assert.equal(listed.get(f.organizationStage),'organization');assert.equal(listed.get(f.incomplete),'organization');
  assert.equal(listed.get(f.camera1),'temporary');assert.equal(listed.get(f.preview),'temporary');
  assert.ok([...listed.keys()].some(item=>item.startsWith(f.emptySlot+path.sep)),'an emptied original slot is listed');
  for(const kept of [f.bound,f.second.destination,f.foreign,f.kept,f.inUse,f.hidden,...f.user])assert.ok(!listed.has(kept),`not residue: ${kept}`);
  assert.ok(![...listed.keys()].some(item=>f.kept.startsWith(item+path.sep)),'no folder holding a kept original is listed');
  assert.deepEqual(found.resumable,{files:2,bytes:found.items.filter(item=>item.kind==='resumable').reduce((sum,item)=>sum+item.bytes,0)});
  assert.equal(found.files,found.items.length);assert.equal(found.bytes,found.items.reduce((sum,item)=>sum+item.bytes,0));
  assert.ok(found.bytes>=1000+2500+3000+700+1200);
});

test('cleaning removes the residue and nothing else; automatic cleaning keeps resumable copies',async t=>{
  const f=await littered(t);
  const automatic=await cleanResidue(await findResidue([f.root],{temporary:f.temporary,inUse:()=>[f.inUse]}),{keepResumable:true});
  assert.ok(automatic.removed.files>0);
  assert.deepEqual(automatic.left.items.map(item=>item.kind),['resumable','resumable']);
  await fs.lstat(f.resumable);await fs.lstat(f.resumableReceipt);
  for(const removed of [f.orphan,f.goneReceipt,f.vanishedReceipt,f.indexTemp,f.visibleIndexTemp,f.organizationStage,f.incomplete,f.camera1,f.preview,f.emptySlot])await assert.rejects(fs.lstat(removed),{code:'ENOENT'},removed);
  const left=await findResidue([f.root],{temporary:f.temporary,inUse:()=>[f.inUse]});
  assert.deepEqual(left.items.map(item=>item.kind),['resumable','resumable']);
  const manual=await cleanResidue(left);
  assert.deepEqual(manual.removed,{files:2,bytes:left.bytes});assert.equal(manual.left.files,0);
  assert.equal((await findResidue([f.root],{temporary:f.temporary,inUse:()=>[f.inUse]})).files,0);
  for(const kept of [f.bound,f.second.destination,f.foreign,f.kept,f.inUse,f.hidden,...f.user])await fs.lstat(kept);
  assert.equal(await fs.readFile(f.kept,'utf8'),'kept for undo');
  for(const file of f.user)assert.equal(await fs.readFile(file,'utf8'),'user data');
});

test('a leftover replaced or changed after it was found is not removed',async t=>{
  const f=await littered(t);
  const found=await findResidue([f.root],{temporary:f.temporary});
  await fs.appendFile(f.orphan,'changed');
  await fs.unlink(f.indexTemp);await fs.writeFile(f.indexTemp,'{}');
  const {left}=await cleanResidue(found);
  await fs.lstat(f.orphan);await fs.lstat(f.indexTemp);
  assert.deepEqual(left.items.map(item=>item.path).filter(item=>item===f.orphan||item===f.indexTemp).sort(),[f.indexTemp,f.orphan].sort());
  await assert.rejects(fs.lstat(f.incomplete),{code:'ENOENT'});
});

test('a stopped scan or cleanup removes nothing more',async t=>{
  const f=await littered(t);const control=new AbortController();
  const found=await findResidue([f.root],{temporary:f.temporary});control.abort();
  await assert.rejects(cleanResidue(found,{signal:control.signal}),{name:'AbortError'});
  await fs.lstat(f.orphan);await fs.lstat(f.camera1);
  await assert.rejects(findResidue([f.root],{signal:control.signal}),{name:'AbortError'});
});


test('camera and preview folders are found and removed through the system temporary path as given',async t=>{
  // os.tmpdir() is not canonical on macOS (/var is /private/var), and mkdtemp returns paths under it.
  const left=await fs.mkdtemp(path.join(os.tmpdir(),'photo-importer-preview-')),reading=await fs.mkdtemp(path.join(os.tmpdir(),'photo-importer-camera-'));
  t.after(async()=>{await fs.rm(left,{recursive:true,force:true});await fs.rm(reading,{recursive:true,force:true});});
  const found=await findResidue([],{temporary:os.tmpdir(),inUse:()=>[reading]});
  const own=found.items.filter(item=>item.path.endsWith(path.sep+path.basename(left)));
  assert.equal(own.length,1);assert.ok(!found.items.some(item=>item.path.endsWith(path.sep+path.basename(reading))),'a folder in use is not listed');
  const {removed}=await cleanResidue({items:own,files:1,bytes:own[0]!.bytes,resumable:{files:0,bytes:0}});
  assert.equal(removed.files,1);await assert.rejects(fs.lstat(left),{code:'ENOENT'});await fs.lstat(reading);
});

test('a staged copy whose card is not connected is kept as resumable; one whose card changed is not',async t=>{
  const f=await littered(t);
  const card=f.card;
  // The card is ejected: its folder is gone, so nothing says the copy cannot continue.
  await fs.rename(card,card+'-ejected');
  let found=await findResidue([f.root]);
  assert.equal(found.items.find(item=>item.path===f.resumable)?.kind,'resumable');
  // The same card is back with that file changed: the copy can no longer continue.
  await fs.rename(card+'-ejected',card);await fs.appendFile(path.join(card,'DSC_0001.NEF'),'edited');
  found=await findResidue([f.root]);
  assert.equal(found.items.find(item=>item.path===f.resumable)?.kind,'partial');
});

test('a preview folder that starts being used after the listing is not removed',async t=>{
  const f=await littered(t);const inUse:string[]=[];
  const found=await findResidue([f.root],{temporary:f.temporary,inUse:()=>inUse});
  inUse.push(f.preview);
  await cleanResidue(found,{inUse:()=>inUse});
  await fs.lstat(f.preview);await assert.rejects(fs.lstat(f.camera1),{code:'ENOENT'});
});
