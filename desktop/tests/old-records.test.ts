import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import patched from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import * as core from '../core/index';
import {acknowledgeOldRecords,findOldRecords,OldRecordsNotice,onOldRecordsFound,refuseOldRecords} from '../core/old-records';
import {beginDuplicateRemoval,storePointerLeftover,deleteOrganizationRecovery,finalizeOrganization,resumeOrganization,undoOrganization} from '../core/recovery';
import {findResidue} from '../core/residue';
import {openV5,sealV5,storeFor} from '../core/app-store';
import {appendJournalLine,journalFileFor,journalFolderFor,organizeByCopy,pointerFor,resealJournalLine,sealedEvent,sealedRecord} from './fixtures/records';
import {identity} from '../core/paths';
import {OLD_HIDDEN_FOLDER,OLD_FOLDER,oldJournal,oldPointer,oldReceipt} from './fixtures/old-records';

core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{},reorganize:true};
const metadata=async()=>({camera:'Sony',date:'2024-02-03',fields:{}});
const OTHER_KEY='another-macs-host-recovery-secret-32bytes';

async function fixture(t:test.TestContext){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'old-records-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'incoming'));await fs.writeFile(path.join(root,'incoming/A.JPG'),'an original');
 return root;
}
/** Every file and folder under `folder` with what proves it unchanged. */
async function snapshot(folder:string):Promise<string[]>{
 const found:string[]=[];
 const walk=async(current:string)=>{for(const entry of await fs.readdir(current,{withFileTypes:true})){
  const file=path.join(current,entry.name),stat=await fs.lstat(file,{bigint:true});
  found.push(`${path.relative(folder,file)}|${stat.ino}|${stat.size}|${stat.mtimeNs}|${entry.isFile()?createHash('sha256').update(await fs.readFile(file)).digest('hex'):''}`);
  if(entry.isDirectory())await walk(file);
 }};
 await walk(folder);return found.sort();
}

test('only old records that authenticate with this Mac\'s key are found: journals, pointers and receipts',async t=>{
 const root=await fixture(t);
 const mine=await oldJournal(root),hidden=await oldJournal(root,{folder:OLD_HIDDEN_FOLDER});
 await oldJournal(root,{key:OTHER_KEY});
 // Not even JSON, and not sealed at all.
 const garbage=path.join(root,OLD_FOLDER,'11111111-1111-4111-8111-111111111111');await fs.mkdir(garbage);await fs.writeFile(path.join(garbage,'manifest.json'),'{"version":1');
 const unsigned=path.join(root,OLD_FOLDER,'22222222-2222-4222-8222-222222222222');await fs.mkdir(unsigned);await fs.writeFile(path.join(unsigned,'manifest.json'),JSON.stringify({version:1}));
 const pointer=await oldPointer(root),foreign=await oldPointer(path.join(root,'incoming'),{key:OTHER_KEY});
 const found=(await findOldRecords(root)).map(item=>item.path).sort();
 assert.deepEqual(found,[mine.manifest,hidden.manifest,pointer].sort());
 assert.ok(!found.includes(foreign));
 for(const item of await findOldRecords(root))assert.deepEqual(Object.keys(item).sort(),['dev','ino','mtimeNs','path','size']);
});
test('a folder without old records, or with only another Mac\'s, has no notice',async t=>{
 const root=await fixture(t);
 assert.deepEqual(await findOldRecords(root),[]);
 await oldJournal(root,{key:OTHER_KEY});
 assert.deepEqual(await findOldRecords(root),[]);
 await refuseOldRecords(root);
});
test('an inventory that meets an old receipt reports it, when the receipt authenticates',async t=>{
 const root=await fixture(t),file=path.join(root,'incoming/A.JPG');
 const mine=await oldReceipt(file),foreign=await oldReceipt(file,{key:OTHER_KEY});
 const listed=await core.inventory(root,{backup:true});
 assert.ok(!listed.files.some(item=>path.basename(item.path).startsWith('photo-importer-')),'receipts are never listed as media');
 assert.deepEqual((await findOldRecords(root)).map(item=>item.path),[mine]);
 assert.ok(foreign);
});
test('detection reads no event, changes nothing and deletes nothing, and never fails on damaged old files',async t=>{
 const root=await fixture(t);
 const job=await oldJournal(root);await oldPointer(root);
 await fs.writeFile(path.join(root,OLD_FOLDER,'journal-not-a-uuid.json'),'\u0000\u0000');
 await fs.mkdir(path.join(root,OLD_FOLDER,'33333333-3333-4333-8333-333333333333'));
 await fs.symlink(root,path.join(root,OLD_FOLDER,'44444444-4444-4444-8444-444444444444'));
 const before=await snapshot(path.join(root,OLD_FOLDER));
 const opened:string[]=[],changed:string[]=[];
 const real={open:patched.open,readFile:patched.readFile,unlink:patched.unlink,rm:patched.rm,rmdir:patched.rmdir,rename:patched.rename,writeFile:patched.writeFile,truncate:patched.truncate,utimes:patched.utimes};
 const watch=(name:'unlink'|'rm'|'rmdir'|'rename'|'writeFile'|'truncate'|'utimes')=>{(patched as any)[name]=async(...args:any[])=>{changed.push(`${name} ${String(args[0])}`);return (real[name] as any)(...args);};};
 (patched as any).open=async(...args:any[])=>{opened.push(String(args[0]));return real.open(...(args as [any]));};
 (patched as any).readFile=async(...args:any[])=>{opened.push(String(args[0]));return (real.readFile as any)(...args);};
 for(const name of ['unlink','rm','rmdir','rename','writeFile','truncate','utimes'] as const)watch(name);
 try{await findOldRecords(root);await findOldRecords(root);}
 finally{Object.assign(patched,real);}
 assert.deepEqual(changed.filter(item=>item.includes(OLD_FOLDER)),[],'nothing old is written, renamed or deleted');
 assert.deepEqual(opened.filter(file=>file.includes(OLD_FOLDER)&&!/manifest\.json$|journal-[^/]*\.json$/.test(file)),[],'only a manifest or a pointer is read, to authenticate it');
 assert.ok(!opened.some(file=>/event-/.test(file)),'no event is read');
 assert.deepEqual(await snapshot(path.join(root,OLD_FOLDER)),before);
 assert.ok(job.id);
});
test('acknowledging writes the sealed reviewed list with exact identities, and the notice stops for exactly those items',async t=>{
 const root=await fixture(t);
 const first=await oldJournal(root);
 const items=await findOldRecords(root);assert.equal(items.length,1);
 assert.equal(await acknowledgeOldRecords(root),1);
 const store=await storeFor(root),file=path.join(store.path,'reviewed-leftovers.json');
 const saved=openV5('reviewed',JSON.parse(await fs.readFile(file,'utf8')));
 assert.deepEqual(saved.items,items.map(item=>({path:item.path,dev:item.dev,ino:item.ino,size:item.size,mtimeNs:item.mtimeNs})));
 assert.deepEqual(await findOldRecords(root),[],'the notice stops');
 // Another run (nothing cached) still sees it as reviewed; the old files are untouched.
 assert.equal((await fs.readFile(first.manifest,'utf8')).length>0,true);
 assert.deepEqual(await findOldRecords(root),[]);
 // A new old record, or a reviewed one that changed, is not covered.
 const second=await oldJournal(root);
 assert.deepEqual((await findOldRecords(root)).map(item=>item.path),[second.manifest]);
 await fs.appendFile(first.manifest,' ');
 assert.deepEqual((await findOldRecords(root)).map(item=>item.path).sort(),[first.manifest,second.manifest].sort(),'a reviewed item that changed is not the one reviewed');
});
test('a reviewed list that this Mac did not seal does not stop the notice',async t=>{
 const root=await fixture(t);
 const job=await oldJournal(root);
 await acknowledgeOldRecords(root);
 const file=path.join((await storeFor(root)).path,'reviewed-leftovers.json'),text=await fs.readFile(file,'utf8');
 const forged=JSON.parse(text);forged.seal='0'.repeat(64);
 await fs.writeFile(file,JSON.stringify(forged));
 assert.deepEqual((await findOldRecords(root)).map(item=>item.path),[job.manifest]);
});
test('organizing is refused on a library with unacknowledged old records, and allowed after acknowledging',async t=>{
 const root=await fixture(t);
 const job=await oldJournal(root);
 const before=await snapshot(path.join(root,OLD_FOLDER));
 const run=async()=>core.executeReorganization((await core.plan(root,[root],options,metadata)).plans[0]!);
 await assert.rejects(run(),(error:any)=>error.key==='error.oldRecords'&&/Old records from an earlier version are on .+\. Use records-migrator-v5 to convert them; they were left untouched\./.test(error.message));
 assert.equal(await fs.readFile(path.join(root,'incoming/A.JPG'),'utf8'),'an original','nothing was organized');
 assert.deepEqual(await snapshot(path.join(root,OLD_FOLDER)),before,'refusing changes nothing');
 await acknowledgeOldRecords(root);
 const result=await run();
 assert.equal(result.moved,1);
 assert.equal((await fs.lstat(job.manifest)).isFile(),true,'the old records stay untouched');
 assert.deepEqual(await snapshot(path.join(root,OLD_FOLDER)),before);
});
test('Remove duplicates is refused on a library with unacknowledged old records, and allowed after acknowledging',async t=>{
 const root=await fixture(t);
 await oldJournal(root);
 const rootIdentity=await identity(root);
 await assert.rejects(beginDuplicateRemoval({root,rootIdentity},[]),(error:any)=>error.key==='error.oldRecords');
 await acknowledgeOldRecords(root);
 await beginDuplicateRemoval({root,rootIdentity},[]);
});
test('a library whose old records are another Mac\'s is not refused',async t=>{
 const root=await fixture(t);
 await oldJournal(root,{key:OTHER_KEY});
 const result=await core.executeReorganization((await core.plan(root,[root],options,metadata)).plans[0]!);
 assert.equal(result.moved,1);
});

test('an acknowledged item stays acknowledged when the drive is mounted again with another device number',async t=>{
 const root=await fixture(t);
 const job=await oldJournal(root);
 await acknowledgeOldRecords(root);
 const file=path.join((await storeFor(root)).path,'reviewed-leftovers.json');
 const saved=openV5('reviewed',JSON.parse(await fs.readFile(file,'utf8')));
 const items=(saved.items as {dev:string}[]).map(item=>({...item,dev:String(Number(item.dev)+7)}));
 await fs.writeFile(file,JSON.stringify(sealV5('reviewed',{items})));
 assert.deepEqual(await findOldRecords(root),[]);
 await refuseOldRecords(root);
 assert.ok(job.id);
});
test('acknowledged items are not read again: they cost an lstat',async t=>{
 const root=await fixture(t);
 const job=await oldJournal(root);
 await acknowledgeOldRecords(root);
 const opened:string[]=[];const real=patched.open;
 (patched as any).open=async(...args:any[])=>{opened.push(String(args[0]));return (real as any)(...args);};
 try{assert.deepEqual(await findOldRecords(root),[]);}finally{patched.open=real;}
 assert.deepEqual(opened.filter(file=>file.includes(OLD_FOLDER)),[]);
 assert.ok(job.id);
});
test('a failed acknowledgement leaves no temporary file in the store',async t=>{
 const root=await fixture(t);
 await oldJournal(root);
 const real=patched.rename;
 (patched as any).rename=async(...args:any[])=>{if(String(args[1]).endsWith('reviewed-leftovers.json'))throw new Error('disk full');return (real as any)(...args);};
 try{await assert.rejects(acknowledgeOldRecords(root),/disk full/);}finally{patched.rename=real;}
 const store=(await storeFor(root)).path;
 assert.deepEqual((await fs.readdir(store)).filter(name=>name.startsWith('reviewed')),[]);
 assert.equal((await findOldRecords(root)).length,1,'still not acknowledged');
});
test('a library found to hold old receipts while listing tells the app, so the notice and Acknowledge appear; a refusal does too',async t=>{
 const root=await fixture(t),file=path.join(root,'incoming/A.JPG');
 let told=0;onOldRecordsFound(()=>{told++;});
 try{
  assert.equal(told,0);
  const receipt=await oldReceipt(file);
  await core.inventory(root,{backup:true});
  assert.ok(told>=1,'the inventory met a receipt');
  const before=told;
  await assert.rejects(refuseOldRecords(root),(error:any)=>error.key==='error.oldRecords');
  assert.ok(told>before,'a refusal tells it too');
  assert.deepEqual((await findOldRecords(root)).map(item=>item.path),[receipt],'there is something to acknowledge');
  assert.equal(await acknowledgeOldRecords(root),1);
  await refuseOldRecords(root);
 }finally{onOldRecordsFound(undefined);}
});
test('a journal converted only in part is an old record: in the notice, refused by resume, undo, finalize and delete, and kept by the automatic cleanup',async t=>{
 const root=await fixture(t);
 const done=await organizeByCopy((await core.plan(root,[root],options,metadata)).plans[0]!);
 assert.equal(done.errors.length,0);
 const [job]=await core.getOrganizationRecovery(root);const id=job!.id;
 assert.deepEqual(await findOldRecords(root),[]);
 await resealJournalLine(root,id,0,value=>({...value,convertedFrom:{path:path.join(root,OLD_FOLDER,id),records:3,sha256:'0'.repeat(64)}}));
 const found=await findOldRecords(root);
 assert.deepEqual(found.map(item=>item.path),[await journalFileFor(root,id)]);
 const refused=(error:any)=>error.key==='error.oldRecords';
 await assert.rejects(resumeOrganization(root,id),refused);
 await assert.rejects(undoOrganization(root,id),refused);
 await assert.rejects(finalizeOrganization(root,id),refused);
 await assert.rejects(deleteOrganizationRecovery(root,id),refused);
 assert.ok(!(await findResidue([root])).items.some(item=>item.kind==='journal'),'not deleted automatically');
 // Acknowledging stops the notice, but the journal itself stays unusable.
 await acknowledgeOldRecords(root);
 assert.deepEqual(await findOldRecords(root),[]);
 await assert.rejects(undoOrganization(root,id),refused);
 // Once the migrator's own end marker is there it is an ordinary journal again.
 await appendJournalLine(root,id,sealedEvent({id,root,event:'migration-complete',at:new Date().toISOString()}));
 assert.deepEqual((await resumeOrganization(root,id)).errors,[]);
 assert.equal((await undoOrganization(root,id)).restored>=0,true);
});
test('a refusal on an unconfigured sibling folder makes the notice appear for its drive, and acknowledging through the app\'s own path unblocks the delete',async t=>{
 const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'old-records-neighbours-')));
 t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const root=path.join(parent,'library'),neighbour=path.join(parent,'OldLibrary');
 await fs.mkdir(path.join(root,'incoming'),{recursive:true});await fs.mkdir(neighbour);
 await fs.writeFile(path.join(root,'incoming/A.JPG'),'an original');
 await organizeByCopy((await core.plan(root,[root],options,metadata)).plans[0]!);
 const [job]=await core.getOrganizationRecovery(root);const id=job!.id;
 await undoOrganization(root,id);
 // The app knows only the library's drive (the destination); the sibling is not configured anywhere.
 const notice=new OldRecordsNotice(async()=>[{drive:root,key:'library',roots:[root]}]);
 onOldRecordsFound(folder=>{if(folder)notice.note(folder);});
 try{
  await notice.scan(true);
  assert.deepEqual(notice.drives,[],'nothing is known yet: the sibling is not configured');
  await oldJournal(neighbour);
  await assert.rejects(deleteOrganizationRecovery(root,id),(error:any)=>error.key==='error.oldRecords');
  assert.ok(!(await findResidue([root])).items.some(item=>item.kind==='journal'),'the automatic cleanup keeps it');
  assert.equal(await notice.scan(true),true,'the refusal named the folder, so the next look finds it');
  assert.deepEqual(notice.drives,[root],'the notice names the library\'s drive');
  assert.equal(await notice.acknowledge(root),1);
  assert.deepEqual(notice.drives,[]);
  await deleteOrganizationRecovery(root,id);
 }finally{onOldRecordsFound(undefined);}
});
test('the automatic cleanup keeps the empty slots and the pointers of a half-converted journal',async t=>{
 const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'old-records-pointers-')));
 t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const root=path.join(parent,'library'),sibling=path.join(parent,'sibling');
 await fs.mkdir(path.join(root,'incoming'),{recursive:true});await fs.mkdir(sibling);
 await fs.writeFile(path.join(root,'incoming/A.JPG'),'an original');
 await core.executeReorganization((await core.plan(root,[root],options,metadata)).plans[0]!,undefined,undefined);
 const [job]=await core.getOrganizationRecovery(root);const id=job!.id;
 const slot=path.join(await journalFolderFor(root,id),'originals','0','5b1f1b8e-8a9b-4c1d-9e3f-0a1b2c3d4e5f');await fs.mkdir(slot,{recursive:true});
 const pointer=await pointerFor(sibling,id);await fs.mkdir(path.dirname(pointer),{recursive:true});
 await fs.writeFile(pointer,sealedRecord('pointer',{library:sibling,root,id}));
 const store=await storeFor(sibling);
 assert.equal(await storePointerLeftover(store,pointer),true,'a finished journal\'s pointer is a leftover');
 assert.ok((await findResidue([root])).items.some(item=>item.path===slot),'and so is its empty slot');
 await resealJournalLine(root,id,0,value=>({...value,convertedFrom:{path:path.join(root,OLD_FOLDER,id),records:3,sha256:'0'.repeat(64)}}));
 assert.equal(await storePointerLeftover(store,pointer),false,'a half-converted journal keeps its pointer');
 assert.ok(!(await findResidue([root])).items.some(item=>item.path===slot),'and its empty slots');
});

test('a source holding sealed old receipts never gets a notice, and acknowledging creates no store in it',async t=>{
 const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'old-records-source-')));
 t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const library=path.join(parent,'library'),source=path.join(parent,'card');
 await fs.mkdir(library);await fs.mkdir(path.join(source,'DCIM'),{recursive:true});
 const photo=path.join(source,'DCIM','A.JPG');await fs.writeFile(photo,'x');
 await oldReceipt(photo);await oldReceipt(photo,{kind:'intent'});
 const notice=new OldRecordsNotice(async()=>[{drive:library,key:'library',roots:[library]}]);
 let told=0;onOldRecordsFound(folder=>{told++;if(folder)notice.note(folder);});
 try{
  await core.inventory(source,{backup:false});
  assert.ok(told>=1,'the listener hears of the hit');
  assert.equal(notice.extra.size,0,'an inventory adds no folder');
  await notice.scan(true);
  assert.deepEqual(notice.drives,[],'no notice for a source');
  assert.equal(await notice.acknowledge(library),0);
  assert.equal(await fs.lstat(path.join(source,'Photo Importer Data')).then(()=>true,()=>false),false,'no store in the source');
  assert.equal(await fs.lstat(path.join(source,'DCIM','Photo Importer Data')).then(()=>true,()=>false),false);
  // Only a refusal names a folder.
  await oldJournal(library);
  await assert.rejects(refuseOldRecords(library),(error:any)=>error.key==='error.oldRecords');
  assert.deepEqual([...notice.extra],[library]);
 }finally{onOldRecordsFound(undefined);}
});
test('a folder named after a scan is looked at by the next scan, though the drive was already checked',async t=>{
 const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'old-records-race-')));
 t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const library=path.join(parent,'library'),sibling=path.join(parent,'OldLibrary');
 await fs.mkdir(library);await fs.mkdir(sibling);await oldJournal(sibling);
 const notice=new OldRecordsNotice(async()=>[{drive:library,key:'library',roots:[library]}]);
 await notice.scan(false);
 assert.deepEqual(notice.drives,[]);
 assert.equal(await notice.scan(false),false,'already checked');
 notice.note(sibling);
 assert.equal(await notice.scan(false),true,'naming a folder makes the drive be looked at again');
 assert.deepEqual(notice.drives,[library]);
});
test('a library folder reached through a link never refuses a delete (it could never get a notice)',async t=>{
 const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'old-records-link-')));
 t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const outside=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'old-records-linked-'))),root=path.join(parent,'library'),elsewhere=path.join(outside,'elsewhere');
 t.after(()=>fs.rm(outside,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'incoming'),{recursive:true});await fs.mkdir(elsewhere);
 await fs.writeFile(path.join(root,'incoming/A.JPG'),'an original');
 await organizeByCopy((await core.plan(root,[root],options,metadata)).plans[0]!);
 const [job]=await core.getOrganizationRecovery(root);const id=job!.id;
 await undoOrganization(root,id);
 const link=path.join(root,'link');await fs.symlink(elsewhere,link);
 await oldJournal(elsewhere);
 await resealJournalLine(root,id,0,value=>({...value,libraries:[link]}));
 await deleteOrganizationRecovery(root,id);
});
