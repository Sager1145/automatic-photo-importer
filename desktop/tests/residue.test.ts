import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {readdirSync,statSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {plan,executeReorganization,configureOrganizationRecovery,getOrganizationRecovery,undoOrganization,finalizeOrganization} from '../core/index';
import {recordPartial,closeReceipts,openReceiptFor,activeSegment,SEGMENT_BYTES,type Receipt} from '../core/import-recovery';
import {appendLines,sealedLine,storeFor} from '../core/app-store';
import {findResidue,cleanResidue,type ResidueItem} from '../core/residue';
import {stagePathFor,openReceiptsFor,segmentsFor} from './fixtures/receipts';
import {journalFolderFor,organizeAs,organizeByCopy} from './fixtures/records';
import {oldReceipt} from './fixtures/old-records';
import type {Metadata} from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}});

async function base(t:test.TestContext,name:string):Promise<string> {
  const folder=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),name)));
  t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  return folder;
}
/** Aborted once `check` holds: a deterministic Stop in the middle of a write. */
const stopWhen=(check:()=>boolean)=>({get aborted(){try{return check();}catch{return false;}}}) as AbortSignal;
const exists=(file:string)=>fs.lstat(file).then(()=>true,()=>false);
const open=async(root:string,rid:string)=>(await openReceiptsFor(root)).has(rid);
const kindOf=(found:{items:ResidueItem[]},file:string)=>found.items.find(item=>item.path===file)?.kind;
/** The smallest "._" file macOS writes for a file with no Finder data: a header, empty Finder info, an empty resource fork. */
function blankAppleDouble(label=false):Buffer {
  const buffer=Buffer.alloc(82);
  buffer.writeUInt32BE(0x00051607,0);buffer.writeUInt32BE(0x00020000,4);buffer.write('Mac OS X',8);buffer.writeUInt16BE(2,24);
  buffer.writeUInt32BE(9,26);buffer.writeUInt32BE(50,30);buffer.writeUInt32BE(32,34);buffer.writeUInt32BE(2,38);buffer.writeUInt32BE(82,42);buffer.writeUInt32BE(0,46);
  if(label)buffer[50+9]=0x0c;
  return buffer;
}
/** Re-record a receipt with some fields changed (closing the original): what a receipt written under other circumstances says. */
async function rerecord(receipt:Receipt,change:Record<string,unknown>):Promise<string>{
  await closeReceipts(receipt.store,[receipt.rid]);
  return openReceiptFor(receipt.store,{...receipt.record,...change} as Receipt['record']);
}

test('Stop while organization copies a file leaves no staged copy in the journal folder',async t=>{
  const root=await base(t,'residue-organize-');
  const original=path.join(root,'incoming','DSC_0001.NEF');
  await fs.mkdir(path.dirname(original));await fs.writeFile(original,Buffer.alloc(3*1024*1024,5));
  const reviewed=(await plan(root,[root],{...options,reorganize:true},metadata)).plans[0]!;
  const organizations=path.join(root,'Photo Importer Data','Organizations');
  const staged=()=>readdirSync(organizations).flatMap(id=>{try{return readdirSync(path.join(organizations,id)).filter(name=>name.startsWith('stage-')).map(name=>path.join(organizations,id,name));}catch{return [];}});
  await assert.rejects(organizeByCopy(reviewed,stopWhen(()=>staged().some(file=>statSync(file).size>0))),{name:'AbortError'});
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
  await fs.writeFile(path.join(card,'DSC_0003.NEF'),Buffer.alloc(3000,3));
  const reviewed=(await plan(card,[root],options,metadata)).plans[0]!;
  const [first,second,third]=reviewed.entries as [typeof reviewed.entries[0],typeof reviewed.entries[0],typeof reviewed.entries[0]];
  const camera=path.dirname(first.destination);await fs.mkdir(camera,{recursive:true});
  const store=await storeFor(root);
  // Resumable: a staged prefix whose sealed receipt still binds it to the unchanged card file.
  const resumable=await stagePathFor(root,randomUUID());await fs.writeFile(resumable,Buffer.alloc(1000,1));
  const resumableReceipt=await recordPartial('stage',resumable,await fs.lstat(resumable,{bigint:true}),first,reviewed,new Map());
  // A staged copy without a receipt, and a receipt whose staged copy is gone.
  const orphan=await stagePathFor(root,randomUUID());await fs.writeFile(orphan,Buffer.alloc(2500,9));
  const gone=await stagePathFor(root,randomUUID());await fs.writeFile(gone,'x');
  const goneReceipt=await recordPartial('stage',gone,await fs.lstat(gone,{bigint:true}),second,reviewed,new Map());await fs.unlink(gone);
  // A publication receipt bound to an incomplete file is how a re-import finishes it: kept.
  await fs.writeFile(second.destination,Buffer.alloc(100,2));
  const bound=await recordPartial('publication',second.destination,await fs.lstat(second.destination,{bigint:true}),{...second,digest:'0'.repeat(64)},reviewed,new Map());
  // A publication receipt whose file is gone protects nothing; one whose file is complete has nothing left to finish.
  const vanished=path.join(camera,'DSC_0009.NEF');await fs.writeFile(vanished,'x');
  const vanishedReceipt=await recordPartial('publication',vanished,await fs.lstat(vanished,{bigint:true}),{...first,destination:vanished,digest:'1'.repeat(64)},reviewed,new Map());await fs.unlink(vanished);
  const bytes=Buffer.alloc(3000,3);await fs.writeFile(third.destination,bytes);
  const completeReceipt=await recordPartial('publication',third.destination,await fs.lstat(third.destination,{bigint:true}),{...third,digest:createHash('sha256').update(bytes).digest('hex')},reviewed,new Map());
  // Index temp files: one left long ago, one a flush may still be writing.
  const libraries=path.join(store.path,'Libraries','backup 00000000');await fs.mkdir(libraries,{recursive:true});
  const oldIndexTemp=path.join(libraries,`index-${randomUUID()}.tmp`);await fs.writeFile(oldIndexTemp,'{}');await fs.utimes(oldIndexTemp,new Date(Date.now()-2*3600e3),new Date(Date.now()-2*3600e3));
  const freshIndexTemp=path.join(libraries,`duplicates-${randomUUID()}.tmp`);await fs.writeFile(freshIndexTemp,'{}');
  // Finder's "._" files in the store: one holding only bookkeeping, one with a label (kept).
  const sidecar=path.join(store.path,'Imports','._receipts-000001.jsonl');await fs.writeFile(sidecar,blankAppleDouble());
  const labelled=path.join(store.path,'._store.json');await fs.writeFile(labelled,blankAppleDouble(true));
  const besideStore=path.join(root,'._Photo Importer Data');await fs.writeFile(besideStore,blankAppleDouble());
  // A deletion set aside and never finished.
  const aside=path.join(store.path,'Organizations',`deleting-${randomUUID()}-${randomUUID()}`);await fs.mkdir(aside,{recursive:true});await fs.writeFile(path.join(aside,'journal.jsonl'),'x');
  // Camera downloads and previews left in the system temporary folder; one still in use.
  const camera1=path.join(temporary,'photo-importer-camera-Ab12Cd');await fs.mkdir(path.join(camera1,'DCIM'),{recursive:true});await fs.writeFile(path.join(camera1,'DCIM','IMG_0001.JPG'),Buffer.alloc(1200));
  const preview=path.join(temporary,'photo-importer-preview-Zz9Yy8');await fs.mkdir(preview);
  // User files that only look similar, and the earlier version's leftovers in the library (Clean up's business only).
  const user=[path.join(camera,`${randomUUID()}.partial`),path.join(camera,`.import-${randomUUID()}.partial.jpg`),path.join(root,'Photo Importer Data notes.txt'),path.join(temporary,'photo-importer-electron-fixtures','keep.txt'),path.join(store.path,'Imports','Staging','notes.txt')];
  for(const file of user){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'user data');}
  const oldPartial=path.join(camera,`photo-importer-${randomUUID()}.partial`);await fs.writeFile(oldPartial,Buffer.alloc(700));
  return {card,root,temporary,store,resumable,resumableReceipt,orphan,goneReceipt,bound,second,third,vanishedReceipt,completeReceipt,oldIndexTemp,freshIndexTemp,sidecar,labelled,besideStore,aside,camera1,preview,user,oldPartial};
}

test('residue lists only the app\'s own leftovers in the records folder, with resumable copies apart',async t=>{
  const f=await littered(t);
  const found=await findResidue([f.root],{temporary:f.temporary});
  assert.equal(kindOf(found,f.resumable),'resumable');
  assert.equal(found.items.find(item=>item.path===f.resumable)?.rid,f.resumableReceipt.rid);
  assert.equal(kindOf(found,f.orphan),'kept');
  for(const receipt of [f.goneReceipt,f.vanishedReceipt,f.completeReceipt])assert.equal(found.items.find(item=>item.rid===receipt.rid)?.kind,'receipt',receipt.record.file);
  assert.ok(!found.items.some(item=>item.rid===f.bound.rid),'a publication receipt bound to an incomplete file is kept');
  assert.equal(kindOf(found,f.oldIndexTemp),'index');assert.equal(kindOf(found,f.freshIndexTemp),undefined,'a temp file under an hour old may still be written');
  assert.equal(kindOf(found,f.sidecar),'sidecar');assert.equal(kindOf(found,f.besideStore),'sidecar');assert.equal(kindOf(found,f.labelled),undefined,'a "._" file with a label is kept');
  assert.equal(kindOf(found,f.aside),'organization');
  assert.equal(kindOf(found,f.camera1),'temporary');assert.equal(kindOf(found,f.preview),'temporary');
  // A receipt to close names its file; the file itself is never residue.
  for(const kept of [f.second.destination,f.third.destination,f.oldPartial,...f.user])assert.ok(!found.items.some(item=>item.path===kept&&!item.rid),`not residue: ${kept}`);
  assert.deepEqual(found.resumable,{files:1,bytes:1000},'only a copy a re-import could continue');
  assert.deepEqual(found.kept,{files:1,bytes:2500},'a copy not proven dead is counted apart');
  // Receipts to close are not files the user has.
  assert.equal(found.files,found.items.filter(item=>!(item.kind==='receipt'&&item.rid)).length);
});

test('cleaning removes the residue and closes receipts; automatic cleaning keeps resumable copies',async t=>{
  const f=await littered(t);
  const automatic=await cleanResidue(await findResidue([f.root],{temporary:f.temporary}),{keepResumable:true});
  assert.ok(automatic.removed.files>0);
  assert.deepEqual(automatic.left.items.map(item=>item.kind).sort(),['kept','resumable']);
  assert.ok(await exists(f.resumable));assert.ok(await exists(f.orphan));assert.ok(await open(f.root,f.resumableReceipt.rid));
  for(const receipt of [f.goneReceipt,f.vanishedReceipt,f.completeReceipt])assert.equal(await open(f.root,receipt.rid),false,receipt.record.file);
  assert.ok(await open(f.root,f.bound.rid));
  for(const removed of [f.oldIndexTemp,f.sidecar,f.besideStore,f.aside,f.camera1,f.preview])assert.equal(await exists(removed),false,removed);
  for(const kept of [f.freshIndexTemp,f.labelled,f.second.destination,f.third.destination,f.oldPartial,...f.user])assert.ok(await exists(kept),kept);
  const manual=await cleanResidue(await findResidue([f.root],{temporary:f.temporary}));
  assert.equal(await exists(f.resumable),false);assert.equal(await exists(f.orphan),false);assert.equal(await open(f.root,f.resumableReceipt.rid),false);
  assert.equal(await exists(f.oldPartial),true,'an earlier version\'s staged copy is never touched');
  assert.equal(manual.left.files,0);
  for(const file of f.user)assert.equal(await fs.readFile(file,'utf8'),'user data');
});

test('a leftover replaced or changed after it was found is not removed',async t=>{
  const f=await littered(t);
  const found=await findResidue([f.root],{temporary:f.temporary});
  await fs.appendFile(f.orphan,'changed');
  await fs.unlink(f.oldIndexTemp);await fs.writeFile(f.oldIndexTemp,'{}');
  const {left}=await cleanResidue(found);
  assert.ok(await exists(f.orphan));assert.ok(await exists(f.oldIndexTemp));
  assert.deepEqual(left.items.map(item=>item.path).filter(item=>item===f.orphan||item===f.oldIndexTemp).sort(),[f.oldIndexTemp,f.orphan].sort());
  assert.equal(await exists(f.aside),false);
});

test('a receipt whose file came back after it was found is not closed',async t=>{
  const f=await littered(t);
  const found=await findResidue([f.root]);
  await fs.writeFile(f.vanishedReceipt.record.file,'x');
  await cleanResidue(found,{keepResumable:true});
  assert.ok(await open(f.root,f.vanishedReceipt.rid));
});

test('a stopped scan or cleanup removes nothing more',async t=>{
  const f=await littered(t);const control=new AbortController();
  const found=await findResidue([f.root],{temporary:f.temporary});control.abort();
  await assert.rejects(cleanResidue(found,{signal:control.signal}),{name:'AbortError'});
  assert.ok(await exists(f.orphan));assert.ok(await exists(f.camera1));
  await assert.rejects(findResidue([f.root],{temporary:f.temporary,signal:control.signal}),{name:'AbortError'});
});

test('camera and preview folders are found and removed through the system temporary path as given',async t=>{
  // os.tmpdir() is not canonical on macOS (/var is /private/var), and mkdtemp returns paths under it.
  const left=await fs.mkdtemp(path.join(os.tmpdir(),'photo-importer-preview-')),reading=await fs.mkdtemp(path.join(os.tmpdir(),'photo-importer-camera-'));
  t.after(async()=>{await fs.rm(left,{recursive:true,force:true});await fs.rm(reading,{recursive:true,force:true});});
  const found=await findResidue([],{temporary:os.tmpdir()});
  const own=found.items.filter(item=>item.path.endsWith(path.sep+path.basename(left)));
  assert.equal(own.length,1);
  const {removed}=await cleanResidue({items:own,files:1,bytes:own[0]!.bytes,resumable:{files:0,bytes:0},kept:{files:0,bytes:0},recoverable:{files:0,bytes:0}});
  assert.equal(removed.files,1);await assert.rejects(fs.lstat(left),{code:'ENOENT'});await fs.lstat(reading);
});

test('a staged copy whose card is not connected is kept as resumable; one whose card changed is dead',async t=>{
  const f=await littered(t);
  await fs.rename(f.card,f.card+'-ejected');
  let found=await findResidue([f.root]);
  assert.equal(kindOf(found,f.resumable),'resumable');
  await fs.rename(f.card+'-ejected',f.card);await fs.appendFile(path.join(f.card,'DSC_0001.NEF'),'edited');
  found=await findResidue([f.root]);
  assert.equal(kindOf(found,f.resumable),'partial');
  await cleanResidue(found,{keepResumable:true});
  assert.equal(await exists(f.resumable),false);assert.equal(await open(f.root,f.resumableReceipt.rid),false);
});

/** One staged copy with a sealed receipt, on plain folders. `full`: the copy holds every byte. */
async function staged(t:test.TestContext,full=false) {
  const folder=await base(t,'residue-keep-');
  const card=path.join(folder,'card'),root=path.join(folder,'backup');
  await fs.mkdir(card);await fs.mkdir(root);
  const source=path.join(card,'DSC_0001.NEF');await fs.writeFile(source,Buffer.alloc(4000,1));
  const reviewed=(await plan(card,[root],options,metadata)).plans[0]!,entry=reviewed.entries[0]!;
  const copy=await stagePathFor(root,randomUUID());await fs.writeFile(copy,Buffer.alloc(full?4000:1000,1));
  const receipt=await recordPartial('stage',copy,await fs.lstat(copy,{bigint:true}),entry,reviewed,new Map());
  return {root,source,copy,receipt,entry,reviewed};
}
const automatic=(root:string)=>findResidue([root]).then(found=>cleanResidue(found,{keepResumable:true}));

test('a staged copy whose receipt shows identity drift is kept by the automatic check and removed by Clean up',async t=>{
  const f=await staged(t);const rid=await rerecord(f.receipt,{fileIdentity:'1:2:3'});
  const found=await findResidue([f.root]);
  assert.equal(kindOf(found,f.copy),'kept');
  const result=await cleanResidue(found,{keepResumable:true});
  assert.equal(result.removed.files,0);assert.ok(await exists(f.copy));assert.ok(await open(f.root,rid));
  const manual=await cleanResidue(await findResidue([f.root]));
  assert.equal(manual.removed.files,1);assert.equal(await exists(f.copy),false);assert.equal(await open(f.root,rid),false);
});

test('an incomplete staged copy whose source on a present card changed or went is removed automatically, with its receipt',async t=>{
  for(const change of ['size','mtime','missing']) {
    const f=await staged(t);
    if(change==='size') await fs.appendFile(f.source,'more');
    else if(change==='mtime') await fs.utimes(f.source,new Date(1e12),new Date(1e12));
    else await fs.unlink(f.source);
    const result=await automatic(f.root);
    assert.equal(result.removed.files,1,change);assert.equal(await exists(f.copy),false,change);assert.equal(await open(f.root,f.receipt.rid),false,change);
  }
});

test('a complete staged copy whose card file changed or vanished is recoverable: neither the automatic check nor Clean up removes it',async t=>{
  for(const change of ['size','missing']) {
    const f=await staged(t,true);
    if(change==='size') await fs.appendFile(f.source,'more');else await fs.unlink(f.source);
    const found=await findResidue([f.root]);
    assert.equal(kindOf(found,f.copy),'recoverable',change);
    assert.deepEqual({files:found.recoverable.files,bytes:found.recoverable.bytes},{files:1,bytes:4000});assert.ok(found.recoverable.folder?.endsWith(path.join('Imports','Staging')));
    await cleanResidue(found,{keepResumable:true});await cleanResidue(await findResidue([f.root,],{}));
    assert.ok(await exists(f.copy),change);assert.ok(await open(f.root,f.receipt.rid),change);
  }
});

test('a staged copy whose card is absent is kept automatically',async t=>{
  const f=await staged(t);
  await fs.rename(path.dirname(f.source),path.dirname(f.source)+'-ejected');
  const result=await automatic(f.root);
  assert.equal(result.removed.files,0);assert.ok(await exists(f.copy));
});

test('a staged copy whose receipt is closed is kept automatically and removed by Clean up',async t=>{
  const f=await staged(t);await closeReceipts(f.receipt.store,[f.receipt.rid]);
  const result=await automatic(f.root);
  assert.equal(result.removed.files,0);assert.ok(await exists(f.copy));
  const manual=await cleanResidue(await findResidue([f.root]));
  assert.equal(manual.removed.files,1);assert.equal(await exists(f.copy),false);
});

test('a receipt line that fails its seal grants nothing: its staged copy is kept even with its source gone',async t=>{
  const f=await staged(t);await closeReceipts(f.receipt.store,[f.receipt.rid]);
  const segment=await activeSegment(f.receipt.store);
  const {kind:_kind,...record}=f.receipt.record;
  await appendLines(segment,[JSON.stringify({v:5,kind:'receipt',op:'open',rid:randomUUID(),type:'stage',...record,seal:'0'.repeat(64)})]);
  await fs.unlink(f.source);
  const result=await automatic(f.root);
  assert.equal(result.removed.files,0);assert.ok(await exists(f.copy));
});

test('a staged copy whose source device had to be rewritten is never dead: only Clean up removes it',async t=>{
  // The receipt names another device number for the card's folder, as after a re-attach, or as when
  // a different card is mounted at the same path: either way the volume is not proven to be the same card.
  const f=await staged(t);
  const [dev,ino]=f.receipt.record.sourceIdentity.split(':'),other=String(BigInt(dev!)+7n);
  const rid=await rerecord(f.receipt,{sourceIdentity:`${other}:${ino}`,sourceStat:{...f.receipt.record.sourceStat,dev:other}});
  await fs.appendFile(f.source,'edited on another card');
  const found=await findResidue([f.root]);
  assert.equal(kindOf(found,f.copy),'kept');
  const result=await cleanResidue(found,{keepResumable:true});
  assert.equal(result.removed.files,0);assert.ok(await exists(f.copy));assert.ok(await open(f.root,rid));
  const manual=await cleanResidue(await findResidue([f.root]));
  assert.equal(manual.removed.files,1);assert.equal(await exists(f.copy),false);
});

test('empty original slots are leftovers only in a finished journal, not a pending one',async t=>{
  for(const finished of [false,true]) {
    const root=await base(t,'residue-slots-');
    const original=path.join(root,'incoming','DSC_0001.NEF');
    await fs.mkdir(path.dirname(original));await fs.writeFile(original,Buffer.alloc(3*1024*1024,5));
    const reviewed=(await plan(root,[root],{...options,reorganize:true},metadata)).plans[0]!;
    const organizations=path.join(root,'Photo Importer Data','Organizations');
    const stagedNow=()=>readdirSync(organizations).flatMap(id=>{try{return readdirSync(path.join(organizations,id)).filter(name=>name.startsWith('stage-'));}catch{return [];}});
    if(finished) await executeReorganization(reviewed,undefined,undefined);
    else await assert.rejects(organizeByCopy(reviewed,stopWhen(()=>stagedNow().length>0)),{name:'AbortError'});
    const [job]=await getOrganizationRecovery(root);
    const slot=path.join(await journalFolderFor(root,job!.id),'originals','0',randomUUID());await fs.mkdir(slot,{recursive:true});
    const found=await findResidue([root]);
    assert.equal(found.items.some(item=>item.path===slot),finished,finished?'finished':'pending');
    await cleanResidue(found,{keepResumable:true});
    assert.equal(await exists(slot),!finished,finished?'finished':'pending');
  }
});

test('receipt segments rotate at 8 MiB; the oldest goes once every receipt it opens is closed, never one with a line that fails its seal',async t=>{
  const f=await staged(t);
  const store=f.receipt.store,first=await activeSegment(store);
  // Fill the first segment past 8 MiB with receipts that are then closed.
  const filler=JSON.stringify({...f.receipt.record,source:f.receipt.record.source+'x'.repeat(20000)});
  const rids:string[]=[];
  while((await fs.stat(first)).size<SEGMENT_BYTES){const rid=randomUUID();rids.push(rid);const {kind:_kind,...record}=JSON.parse(filler);await appendLines(first,[sealedLine('receipt',{op:'open',rid,type:'stage',...record})]);}
  const second=await activeSegment(store);assert.notEqual(second,first,'a new segment once the last holds 8 MiB');
  // The staged copy's receipt is still open in the first segment: it stays.
  await closeReceipts(store,rids);
  let found=await findResidue([f.root]);
  assert.ok(!found.items.some(item=>item.path===first),'a segment with an open receipt stays');
  await closeReceipts(store,[f.receipt.rid]);
  // An append racing the deletion check is never lost.
  found=await findResidue([f.root]);
  assert.equal(kindOf(found,first),'segment');
  const racing=openReceiptFor(store,f.receipt.record);
  await cleanResidue(found,{keepResumable:true});
  const rid=await racing;
  assert.equal(await exists(first),false);assert.ok(await open(f.root,rid),'the racing append is in the log');
  assert.deepEqual(await segmentsFor(f.root),[second]);
  // A segment holding a line that is JSON but fails its seal is never removed.
  const bad=path.join(path.dirname(first),'receipts-000000.jsonl');
  await fs.writeFile(bad,JSON.stringify({v:5,kind:'receipt',op:'close',rid:randomUUID(),seal:'0'.repeat(64)})+'\n');
  await cleanResidue(await findResidue([f.root]),{keepResumable:true});
  assert.ok(await exists(bad));
});

test('ended organizations holding no kept original are deleted automatically, those that name them first; undoable ones and kept originals stay',async t=>{
  // A library inside its own folder: the folders beside it (other tests' temporary folders otherwise) are read as neighbours.
  const root=path.join(await base(t,'residue-ended-'),'library');await fs.mkdir(root);
  const organize=async(name:string,strategy:'rename'|'copy')=>{
    const original=path.join(root,'incoming',name);await fs.mkdir(path.dirname(original),{recursive:true});await fs.writeFile(original,Buffer.alloc(2000,name.length));
    const reviewed=(await plan(root,[root],{...options,reorganize:true,sourceFolders:['incoming']},metadata)).plans[0]!;
    const before=new Set((await getOrganizationRecovery(root,{includeEnded:true})).map(job=>job.id));
    assert.deepEqual((await organizeAs(strategy,reviewed)).errors,[]);
    return (await getOrganizationRecovery(root,{includeEnded:true})).find(job=>!before.has(job.id))!;
  };
  // A finished rename can still be undone: kept.
  const renamed=await organize('A.NEF','rename');
  // A copy whose kept original was released, then fully finalized: ended.
  const copied=await organize('B.NEF','copy');
  const copiedFolder=await journalFolderFor(root,copied.id);
  await finalizeOrganization(root,copied.id);
  // A copy undone completely: ended (its original is back).
  const undone=await organize('C.NEF','copy');
  const undoneFolder=await journalFolderFor(root,undone.id);
  await undoOrganization(root,undone.id);
  // A copy still keeping its original: kept.
  const keeping=await organize('D.NEF','copy');
  const result=await automatic(root);
  assert.ok(result.removed.files>=2);
  assert.equal(await exists(copiedFolder),false,'finalized copy deleted');assert.equal(await exists(undoneFolder),false,'undone copy deleted');
  assert.ok(await exists(await journalFolderFor(root,renamed.id)),'a finished rename stays undoable');
  assert.ok(await exists(await journalFolderFor(root,keeping.id)),'kept originals stay');
  const listed=(await getOrganizationRecovery(root,{includeEnded:true})).map(job=>job.id).sort();
  assert.deepEqual(listed,[renamed.id,keeping.id].sort());
});

test('neither the automatic check nor Clean up walks the library: what an earlier version left there is never listed or removed',async t=>{
  const f=await staged(t);
  const oldPartial=path.join(path.dirname(f.entry.destination),`photo-importer-${randomUUID()}.partial`);await fs.mkdir(path.dirname(oldPartial),{recursive:true});await fs.writeFile(oldPartial,Buffer.alloc(800));
  const receipt=await oldReceipt(oldPartial);
  for(const found of [await findResidue([f.root]),await findResidue([f.root,])]){
    assert.ok(!found.items.some(item=>item.path===oldPartial||item.path===receipt));
    await cleanResidue(found);
  }
  assert.equal(await exists(oldPartial),true);assert.equal(await exists(receipt),true);
});

test('a receipt opened in one segment and closed in the next lets both segments go, oldest first',async t=>{
  const f=await staged(t);await closeReceipts(f.receipt.store,[f.receipt.rid]);
  const imports=path.join(f.receipt.store.path,'Imports'),segment=(n:number)=>path.join(imports,`receipts-${String(n).padStart(6,'0')}.jsonl`);
  for(const file of await fs.readdir(imports))if(file.startsWith('receipts-'))await fs.unlink(path.join(imports,file));
  const {kind:_kind,...record}=f.receipt.record,a=randomUUID(),b=randomUUID();
  // A opens in segment 1 and closes in segment 2 (an import running across a rotation); B is still open in segment 3.
  await fs.writeFile(segment(1),sealedLine('receipt',{op:'open',rid:a,type:'stage',...record})+'\n');
  await fs.writeFile(segment(2),sealedLine('receipt',{op:'close',rid:a})+'\n');
  await fs.writeFile(segment(3),sealedLine('receipt',{op:'open',rid:b,type:'stage',...record})+'\n');
  const found=await findResidue([f.root]);
  assert.deepEqual(found.items.filter(item=>item.kind==='segment').map(item=>path.basename(item.path)),['receipts-000001.jsonl','receipts-000002.jsonl']);
  await cleanResidue(found,{keepResumable:true});
  assert.deepEqual((await segmentsFor(f.root)).map(file=>path.basename(file)),['receipts-000003.jsonl']);
  assert.ok(await open(f.root,b));assert.equal(await open(f.root,a),false);
});

/** A complete staged copy (as large as its source) whose card file then changed or went. */
async function completeStale(t:test.TestContext,change:'size'|'mtime'|'missing') {
  const f=await staged(t,true);
  if(change==='size') await fs.appendFile(f.source,'more');
  else if(change==='mtime') await fs.utimes(f.source,new Date(1e12),new Date(1e12));
  else await fs.unlink(f.source);
  return f;
}

test('a complete staged copy whose card file changed or went is kept by the automatic check and by Clean up, with its receipt',async t=>{
  for(const change of ['size','mtime','missing'] as const) {
    const f=await completeStale(t,change);
    const found=await findResidue([f.root]);
    assert.equal(kindOf(found,f.copy),'recoverable',change);
    assert.deepEqual(found.recoverable,{files:1,bytes:4000,folder:path.dirname(f.copy)},change);
    const automaticResult=await cleanResidue(found,{keepResumable:true});
    assert.equal(automaticResult.removed.files,0,change);assert.ok(await exists(f.copy),change);assert.ok(await open(f.root,f.receipt.rid),change);
    assert.equal(automaticResult.left.recoverable.files,1,change);
    const manual=await cleanResidue(await findResidue([f.root],{}));
    assert.equal(manual.removed.files,0,change);assert.ok(await exists(f.copy),`${change}: Clean up keeps it`);assert.ok(await open(f.root,f.receipt.rid),change);
    assert.equal(manual.left.recoverable.files,1,change);
  }
});
