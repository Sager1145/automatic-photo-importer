import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import type {BigIntStats} from 'node:fs';
import * as core from '../core/index';
import {migrateDrive,SimulatedCrash} from '../core/migrate/index';
import {DestinationIndex} from '../core/destination-index';
import {findResidue} from '../core/residue';
import {identity} from '../core/paths';
import {openV5} from '../core/app-store';
import {pointerFilesFor,journalFolderFor} from './fixtures/records';
import {openReceiptsFor,stagingFor} from './fixtures/receipts';
import {toLegacy,legacyReceipt,signV1,FIXTURE_KEY} from './fixtures/legacy-records';
import type {Metadata,PlanEntry,TransferPlan} from '../shared';

core.configureOrganizationRecovery(FIXTURE_KEY);
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2026-10-03T12:00:00',fields:{}});
const base={backup:false,template:'{year}/{yyyymm}/{camera}',unknownRules:{}};
const exists=(file:string)=>fs.lstat(file).then(()=>true,()=>false);
const stopAfterFirstMove=()=>{const controller=new AbortController();return {signal:controller.signal,progress:(value:{step?:string;completed:number})=>{if(value.step==='moving'&&value.completed>=1)controller.abort();}};};
async function drive(t:test.TestContext,name:string){
 const folder=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),name)));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 // The drive inside its own folder: other tests' folders are never its neighbours.
 const root=path.join(folder,'drive');await fs.mkdir(root);return root;
}

// ---- P1: sibling pointers ----
/** A video-root split stopped after its first move: its journal (in videobackup) keeps a pointer in photobackup. */
async function stoppedSplit(t:test.TestContext){
 const root=await drive(t,'migrate-pointers-');
 const photos=path.join(root,'photobackup'),videos=path.join(root,'videobackup');
 for(const folder of [photos,videos])await fs.mkdir(folder,{recursive:true});
 for(const name of ['C0016.MOV','C0017.MOV','A.JPG','B.JPG'])await fs.writeFile(path.join(photos,name),'bytes of '+name);
 const {plans:[split]}=await core.plan(root,[photos],{...base,layout:'video-root',videoRoots:[videos],sourceFolders:['photobackup','videobackup'],reorganize:true},metadata);
 const stop=stopAfterFirstMove();
 await assert.rejects(core.executeReorganization(split!.videos!,stop.signal,stop.progress,{strategy:'rename'}),{name:'AbortError'});
 const [stopped]=await core.getOrganizationRecovery(videos);
 assert.equal((await pointerFilesFor(photos)).length,1);
 return {root,photos,videos,id:stopped!.id,split:split!};
}
const legacyPointer=(photos:string,id:string)=>path.join(photos,'Photo Importer Recovery',`journal-${id}.json`);

test('P1: the pointer of a converted, still live journal is written again in the store, then the old one goes',async t=>{
 const f=await stoppedSplit(t);
 await toLegacy(f.videos,f.id);
 assert.ok(await exists(legacyPointer(f.photos,f.id)));assert.deepEqual(await pointerFilesFor(f.photos),[]);
 const result=await migrateDrive([f.photos,f.videos]);
 assert.deepEqual(result.problems,[]);
 assert.equal(await exists(legacyPointer(f.photos,f.id)),false);assert.equal(await exists(path.join(f.photos,'Photo Importer Recovery')),false);
 const [pointer]=await pointerFilesFor(f.photos);
 assert.equal(path.basename(pointer!),`journal-${f.id}.json`);
 assert.deepEqual({...openV5('pointer',JSON.parse(await fs.readFile(pointer!,'utf8')))},{v:5,kind:'pointer',library:f.photos,root:f.videos,id:f.id});
 // It still protects the live journal: organizing the photo folder is refused until that one is finished.
 const again=(await core.plan(f.root,[f.photos],{...base,layout:'flat',reorganize:true,sourceFolders:['photobackup']},metadata)).plans[0]!;
 assert.match((await core.executeReorganization(again,undefined,undefined,{strategy:'rename'})).errors.join(' '),new RegExp(`Finish organization ${f.id}`));
});

test('P1: a stop after the new pointer is written is finished by the next run',async t=>{
 const f=await stoppedSplit(t);
 await toLegacy(f.videos,f.id);
 await assert.rejects(migrateDrive([f.photos,f.videos],{crash:at=>{if(at==='P1:written')throw new SimulatedCrash(at);}}),SimulatedCrash);
 assert.ok(await exists(legacyPointer(f.photos,f.id)));assert.equal((await pointerFilesFor(f.photos)).length,1);
 assert.deepEqual((await migrateDrive([f.photos,f.videos])).problems,[]);
 assert.equal(await exists(legacyPointer(f.photos,f.id)),false);assert.equal((await pointerFilesFor(f.photos)).length,1);
});

test('P1: a pointer whose journal finished, is gone, or was copied from another folder is removed; a damaged one is kept and reported',async t=>{
 const f=await stoppedSplit(t);
 assert.deepEqual((await core.resumeOrganization(f.videos,f.id)).errors,[]);
 await toLegacy(f.videos,f.id);
 // The journal finished: its pointer (rewritten by toLegacy from the v5 one the finish removed) is not there; plant one.
 const storage=path.join(f.photos,'Photo Importer Recovery');await fs.mkdir(storage,{recursive:true});
 await fs.writeFile(legacyPointer(f.photos,f.id),JSON.stringify(signV1({kind:'sibling-journal',library:f.photos,root:f.videos,id:f.id})));
 const gone=randomUUID();await fs.writeFile(legacyPointer(f.photos,gone),JSON.stringify(signV1({kind:'sibling-journal',library:f.photos,root:f.videos,id:gone})));
 const copied=randomUUID();await fs.writeFile(legacyPointer(f.photos,copied),JSON.stringify(signV1({kind:'sibling-journal',library:path.join(f.root,'elsewhere'),root:f.videos,id:copied})));
 const damaged=randomUUID();await fs.writeFile(legacyPointer(f.photos,damaged),'{"kind":"sibling-');
 const temporary=path.join(storage,`journal-${gone}-${randomUUID()}.tmp`);await fs.writeFile(temporary,'x');
 const result=await migrateDrive([f.photos,f.videos]);
 for(const id of [f.id,gone,copied])assert.equal(await exists(legacyPointer(f.photos,id)),false,id);
 assert.equal(await exists(temporary),false);
 assert.ok(await exists(legacyPointer(f.photos,damaged)),'a damaged pointer is kept');
 assert.ok(result.problems.some(problem=>problem.includes(`journal-${damaged}.json`)),result.problems.join('; '));
 assert.deepEqual(await pointerFilesFor(f.photos),[],'no pointer for a finished journal');
});

// ---- R: import receipts and staged copies ----
const snapshot=(stat:BigIntStats)=>({dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtime:String(stat.mtimeNs),ctime:String(stat.ctimeNs)});
/** A card and a destination with one planned file, and the earlier version's receipt record for it. */
async function card(t:test.TestContext,bytes=Buffer.alloc(4000,7)){
 const root=await drive(t,'migrate-receipts-');
 const source=path.join(root,'card'),destination=path.join(root,'backup');await fs.mkdir(source);await fs.mkdir(destination);
 await fs.writeFile(path.join(source,'DSC_0001.NEF'),bytes);
 const transfer=(await core.plan(source,[destination],{...base,layout:'flat'},async()=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}}))).plans[0]!;
 const entry=transfer.entries[0]!;await fs.mkdir(path.dirname(entry.destination),{recursive:true});
 const record=async(kind:'stage'|'publication',file:string,extra:Record<string,unknown>={})=>{
  const stat=await fs.lstat(file,{bigint:true}).catch(()=>undefined);
  return {kind,file,source:entry.source,destination:entry.destination,sha256:'',sourceStat:snapshot(await fs.lstat(entry.source,{bigint:true})),root:transfer.root,rootIdentity:transfer.rootIdentity,sourceRoot:transfer.source,sourceIdentity:await identity(transfer.source),parentIdentity:await identity(path.dirname(file)),fileIdentity:stat?`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`:'creating',...extra};
 };
 return {root,source,destination,transfer:transfer as TransferPlan,entry:entry as PlanEntry,bytes,record};
}
const oldStage=(entry:PlanEntry)=>path.join(path.dirname(entry.destination),`photo-importer-${randomUUID()}.partial`);

for(const point of [undefined,'R1','R2'] as const)test(`R: a staged copy bound by its receipt moves into the staging folder${point?` (stopped after ${point}, finished by the next run)`:''} and the next import continues it`,async t=>{
 const f=await card(t);
 const partial=oldStage(f.entry);await fs.writeFile(partial,f.bytes.subarray(0,1500));
 const inode=(await fs.lstat(partial,{bigint:true})).ino;
 const receipt=await legacyReceipt(await f.record('stage',partial));
 if(point)await assert.rejects(migrateDrive([f.destination],{crash:at=>{if(at===point)throw new SimulatedCrash(at);}}),SimulatedCrash);
 assert.deepEqual((await migrateDrive([f.destination])).problems,[]);
 assert.equal(await exists(partial),false);assert.equal(await exists(receipt),false);
 const staged=await fs.readdir(await stagingFor(f.destination));assert.equal(staged.length,1);
 const open=[...(await openReceiptsFor(f.destination)).values()];
 assert.equal(open.length,1,'exactly one open receipt');assert.equal(open[0]!.file,path.join(await stagingFor(f.destination),staged[0]!));
 const result=await core.execute((await core.plan(path.dirname(f.entry.source),[f.destination],{...base,layout:'flat'},async()=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}}))).plans[0]!);
 assert.deepEqual(result,{copied:1,skipped:0,errors:[]});
 assert.deepEqual(await fs.readFile(f.entry.destination),f.bytes);
 assert.equal((await fs.lstat(f.entry.destination,{bigint:true})).ino,inode,'continued, not copied again');
 assert.equal((await openReceiptsFor(f.destination)).size,0);
});

test('R: a dead incomplete copy goes with its receipt; a dead complete one is kept as recoverable; an empty one goes; a receipt naming nothing goes',async t=>{
 const f=await card(t);
 const dead=oldStage(f.entry);await fs.writeFile(dead,f.bytes.subarray(0,1000));const deadReceipt=await legacyReceipt(await f.record('stage',dead));
 const complete=oldStage(f.entry);await fs.writeFile(complete,f.bytes);const completeReceipt=await legacyReceipt(await f.record('stage',complete));
 const empty=oldStage(f.entry);await fs.writeFile(empty,'');const emptyReceipt=await legacyReceipt(await f.record('stage',empty));
 const nothing=oldStage(f.entry);const nothingReceipt=await legacyReceipt(await f.record('stage',nothing));
 // The card file changed: the copies can no longer continue.
 await fs.appendFile(f.entry.source,'edited');
 assert.deepEqual((await migrateDrive([f.destination])).problems,[]);
 for(const file of [dead,deadReceipt,empty,emptyReceipt,nothingReceipt,complete,completeReceipt])assert.equal(await exists(file),false,file);
 const staged=await fs.readdir(await stagingFor(f.destination));assert.equal(staged.length,1,'the complete copy is in the staging folder');
 assert.deepEqual(await fs.readFile(path.join(await stagingFor(f.destination),staged[0]!)),f.bytes);
 const found=await findResidue([f.destination]);
 assert.equal(found.items.find(item=>item.path.endsWith(staged[0]!))?.kind,'recoverable');
});

test('R: publication receipts: gone or complete file → removed; any other file there → moved into the log, the file left in place',async t=>{
 const f=await card(t);
 const complete=path.join(path.dirname(f.entry.destination),'DONE.NEF');await fs.writeFile(complete,f.bytes);
 const completeReceipt=await legacyReceipt(await f.record('publication',complete,{destination:complete,sha256:createHash('sha256').update(f.bytes).digest('hex')}));
 const absent=path.join(path.dirname(f.entry.destination),'GONE.NEF');const absentReceipt=await legacyReceipt(await f.record('publication',absent,{destination:absent}));
 await fs.writeFile(f.entry.destination,f.bytes.subarray(0,10));
 const partialReceipt=await legacyReceipt(await f.record('publication',f.entry.destination,{sha256:createHash('sha256').update(f.bytes).digest('hex')}));
 const foreign=path.join(path.dirname(f.entry.destination),`photo-importer-intent-${randomUUID()}.json`);await fs.writeFile(foreign,JSON.stringify({version:1,kind:'publication',file:f.entry.destination,seal:'0'.repeat(64)}));
 assert.deepEqual((await migrateDrive([f.destination])).problems,[]);
 for(const file of [completeReceipt,absentReceipt,partialReceipt])assert.equal(await exists(file),false,file);
 assert.ok(await exists(foreign),'a receipt that does not authenticate is left for Clean up');
 assert.ok(await exists(complete));assert.ok(await exists(f.entry.destination),'the file stays');
 const open=[...(await openReceiptsFor(f.destination)).values()];
 assert.deepEqual(open.map(record=>[record.kind,record.file]),[['publication',f.entry.destination]]);
 // A second run finds nothing more to do.
 assert.deepEqual((await migrateDrive([f.destination])).problems,[]);
 assert.equal((await openReceiptsFor(f.destination)).size,1);
});

// ---- C: caches ----
test('C: the earlier version\'s index, duplicate store and drive markers are moved into the store, sealed; the old files go',async t=>{
 for(const point of [undefined,'C:written'] as const){
  const root=await drive(t,'migrate-caches-'),id=await identity(root),file=path.join(root,'cached.bin');
  await fs.writeFile(file,'cached');await fs.utimes(file,new Date(2020,0,1),new Date(2020,0,1));
  const stat=await fs.lstat(file,{bigint:true});
  const files={'cached.bin':{dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtime:String(stat.mtimeNs),ctime:String(stat.ctimeNs),sha256:'a'.repeat(64)}};
  await fs.writeFile(path.join(root,'.photo-importer-index.json'),JSON.stringify({version:1,rootIdentity:id,files}));
  await fs.writeFile(path.join(root,'photo-importer-duplicates.json'),JSON.stringify({version:2,rootIdentity:id,updated:'x',complete:true,files:{},groups:[]}));
  const backups=path.join(root,'Drive backups','Card');await fs.mkdir(backups,{recursive:true});
  await fs.writeFile(path.join(backups,'.photo-importer-drive.json'),JSON.stringify({identity:'volume-1',name:'Card'}));
  const oldTemp=path.join(root,`photo-importer-index-${randomUUID()}.tmp`);await fs.writeFile(oldTemp,'{}');await fs.utimes(oldTemp,new Date(Date.now()-7200e3),new Date(Date.now()-7200e3));
  if(point)await assert.rejects(migrateDrive([root],{crash:at=>{if(at===point)throw new SimulatedCrash(at);}}),SimulatedCrash);
  assert.deepEqual((await migrateDrive([root])).problems,[]);
  for(const name of ['.photo-importer-index.json','photo-importer-duplicates.json',path.basename(oldTemp),path.join('Drive backups','Card','.photo-importer-drive.json')])assert.equal(await exists(path.join(root,name)),false,name);
  assert.equal(await (await DestinationIndex.load(root,id)).digestOf(file),'a'.repeat(64),'the converted index is trusted');
  const marker=JSON.parse(await fs.readFile(path.join(backups,'photo-importer-drive.json'),'utf8'));
  assert.equal(openV5('drive',marker).identity,'volume-1');
  const [partition]=await fs.readdir(path.join(root,'Photo Importer Data','Libraries'));
  assert.ok(await exists(path.join(root,'Photo Importer Data','Libraries',partition!,'duplicates.json')));
 }
});

// ---- F: the old record folders ----
test('F: the old record folder goes once only Finder\'s bookkeeping is left, with its own "._" file',async t=>{
 const root=await drive(t,'migrate-folders-');
 const storage=path.join(root,'Photo Importer Recovery');await fs.mkdir(storage);
 const blank=Buffer.alloc(82);blank.writeUInt32BE(0x00051607,0);blank.writeUInt32BE(0x00020000,4);blank.write('Mac OS X',8);blank.writeUInt16BE(2,24);blank.writeUInt32BE(9,26);blank.writeUInt32BE(50,30);blank.writeUInt32BE(32,34);blank.writeUInt32BE(2,38);blank.writeUInt32BE(82,42);
 await fs.writeFile(path.join(storage,'.DS_Store'),'x');await fs.writeFile(path.join(storage,'._journal-x.json'),blank);await fs.writeFile(path.join(root,'._Photo Importer Recovery'),blank);
 const aside=path.join(storage,`deleting-${randomUUID()}-${randomUUID()}`);await fs.mkdir(path.join(aside,'originals'),{recursive:true});
 assert.deepEqual((await migrateDrive([root])).problems,[]);
 assert.equal(await exists(storage),false);assert.equal(await exists(path.join(root,'._Photo Importer Recovery')),false);
});

test('a library organized with the earlier version: journal, pointers, receipts and caches all converted in one run, then nothing is left to do',async t=>{
 const f=await stoppedSplit(t);
 await toLegacy(f.videos,f.id);
 await fs.writeFile(path.join(f.photos,'photo-importer-index.json'),JSON.stringify({version:1,rootIdentity:await identity(f.photos),files:{}}));
 const result=await migrateDrive([f.photos,f.videos]);
 assert.deepEqual(result.problems,[]);assert.equal(result.converted,1);assert.equal(result.pending,0);
 assert.ok(await exists(await journalFolderFor(f.videos,f.id)));
 for(const folder of [f.photos,f.videos])assert.deepEqual((await fs.readdir(folder)).filter(name=>/photo.importer/i.test(name)&&name!=='Photo Importer Data'),[],folder);
 const again=await migrateDrive([f.photos,f.videos]);
 assert.deepEqual(again,{converted:0,pending:0,problems:[]});
 assert.deepEqual((await core.resumeOrganization(f.videos,f.id)).errors,[]);
});

test('R: a resumed conversion whose earlier v5 receipt names the same file as the old staged copy (two names) stops for First Aid and renames nothing',async t=>{
 const f=await card(t);
 const partial=oldStage(f.entry);await fs.writeFile(partial,f.bytes.subarray(0,1500));
 const receipt=await legacyReceipt(await f.record('stage',partial));
 await assert.rejects(migrateDrive([f.destination],{crash:at=>{if(at==='R1')throw new SimulatedCrash(at);}}),SimulatedCrash);
 const [earlier]=[...(await openReceiptsFor(f.destination)).values()];
 // The staging name the earlier receipt chose and the old staged copy are one file (an APFS hard link).
 await fs.link(partial,earlier!.file);
 const result=await migrateDrive([f.destination]);
 assert.ok(result.problems.some(problem=>/First Aid/.test(problem)),result.problems.join('; '));
 assert.ok(await exists(partial));assert.ok(await exists(earlier!.file));assert.ok(await exists(receipt));
 assert.equal((await fs.readdir(await stagingFor(f.destination))).length,1,'no fresh name was tried');
});

test('R: the receipt log is read once per walk, not once per converted receipt',async t=>{
 const f=await card(t);
 for(let index=0;index<25;index++){const partial=oldStage(f.entry);await fs.writeFile(partial,f.bytes.subarray(0,100+index));await legacyReceipt(await f.record('stage',partial));}
 const files=(await import('node:fs/promises')).default,{syncBuiltinESMExports}=await import('node:module');
 const open=files.open.bind(files);let reads=0;
 t.mock.method(files,'open',async(...args:Parameters<typeof files.open>)=>{if(/receipts-\d{6}\.jsonl$/.test(String(args[0]))&&(args[1]===undefined||args[1]==='r'||args[1]===0||typeof args[1]==='number'&&!(args[1]&1)&&!(args[1]&2)))reads++;return open(...args);});
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 assert.deepEqual((await migrateDrive([f.destination])).problems,[]);
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.equal((await openReceiptsFor(f.destination)).size,25);
 assert.ok(reads<=3,`segment reads: ${reads}`);
});

test('R: a card file that cannot be looked at (not missing) proves nothing: the staged copy and its receipt stay and are reported',async t=>{
 const f=await card(t);
 const partial=oldStage(f.entry);await fs.writeFile(partial,f.bytes.subarray(0,1500));
 const receipt=await legacyReceipt(await f.record('stage',partial));
 // The card folder itself is there, but its files cannot be looked at (EACCES, not ENOENT).
 await fs.chmod(f.source,0o600);
 let result;try{result=await migrateDrive([f.destination]);}finally{await fs.chmod(f.source,0o755);}
 assert.ok(await exists(partial),'the staged copy stays');assert.ok(await exists(receipt),'its receipt stays');
 assert.ok(result.problems.some(problem=>problem.includes(path.basename(receipt))),result.problems.join('; '));
});
