import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import * as core from '../core/index';
import {organizeByCopy} from './fixtures/records';
import type {DestinationOutcome} from '../core/destinations';

// Each file is read whole, so reads are counted in whole files: what each flow reads, by role.
core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const SIZE=2*1024*1024;
function countReads(t:test.TestContext,role:(file:string)=>string|undefined){
 const read:Record<string,number>={},open=fs.open.bind(fs);
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args),kind=role(String(args[0]));
  if(kind){const original=handle.read.bind(handle);t.mock.method(handle,'read',async(...values:Parameters<typeof handle.read>)=>{const result=await original(...values);read[kind]=(read[kind]??0)+result.bytesRead;return result;});}
  return handle;
 });syncBuiltinESMExports();
 const stop=()=>{t.mock.restoreAll();syncBuiltinESMExports();};t.after(stop);
 return {stop,files:()=>Object.fromEntries(Object.entries(read).filter(([,bytes])=>bytes).map(([kind,bytes])=>[kind,bytes/SIZE]))};
}
// A file whose dates were set (as a copied photo's are) has a change time apart from its modified time, which is
// what lets a proof be held for it on APFS; a file just written has both equal, like every file on exFAT.
async function photo(file:string,data:Buffer){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,data);await fs.utimes(file,new Date('2024-02-03T10:00:00Z'),new Date('2024-02-03T10:00:00Z'));}
async function folder(t:test.TestContext,name:string){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),name)));t.after(()=>fs.rm(base,{recursive:true,force:true}));return base;
}

// exFAT reports a change time equal to the modified time, so no stat there proves a file unchanged. Files under
// `drive` get exactly that, from every stat call; mock this before counting reads.
function simulateExfat(t:test.TestContext,drive:string){
 const exfat=<T,>(file:string,stat:T):T=>{const value=stat as {mtimeNs?:bigint;ctimeNs?:bigint;mtimeMs?:number;ctimeMs?:number};if(typeof value?.mtimeNs==='bigint'&&file.startsWith(drive+path.sep)){value.ctimeNs=value.mtimeNs;value.ctimeMs=value.mtimeMs;}return stat;};
 const lstat=fs.lstat.bind(fs),stat=fs.stat.bind(fs),open=fs.open.bind(fs);
 t.mock.method(fs,'lstat',async(...args:Parameters<typeof fs.lstat>)=>exfat(String(args[0]),await lstat(...args)));
 t.mock.method(fs,'stat',async(...args:Parameters<typeof fs.stat>)=>exfat(String(args[0]),await stat(...args)));
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args),file=String(args[0]),own=handle.stat.bind(handle);
  t.mock.method(handle,'stat',async(...values:Parameters<typeof handle.stat>)=>exfat(file,await own(...values)));
  return handle;
 });syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
}

const organizing={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{},reorganize:true as const};
const sony=async()=>({camera:'Sony',date:'2024-02-03',fields:{}});
const recovery=(file:string)=>file.includes(`${path.sep}Photo Importer Data${path.sep}Organizations${path.sep}`);

// The copy streams and hashes the source once, the stage is read back once, and the hard link publishes that
// verified inode: neither the published name nor the original set aside is read again.
test('an organization copy reads its source once and its destination not at all after a link',async t=>{
 const root=await folder(t,'verify-once-organize-'),original=path.join(root,'incoming','A.JPG'),data=Buffer.alloc(SIZE,5);
 await photo(original,data);
 const {plans:[transfer]}=await core.plan(root,[root],organizing,sony);
 const destination=transfer!.entries[0]!.destination;
 const reads=countReads(t,file=>file===original?'source':file===destination?'destination':file.endsWith('.partial')?'stage':recovery(file)&&file.endsWith('A.JPG')?'stash':undefined);
 const result=await organizeByCopy(transfer!);
 reads.stop();
 assert.deepEqual(result.errors,[]);assert.equal(result.moved,1);
 assert.deepEqual(reads.files(),{source:1,stage:1});
 assert.deepEqual(await fs.readFile(destination),data);
});

// Between the check and setting the original aside, a copy rewritten in place with its size and modified time kept
// (only the change time tells, and only a read proves it) is read again, found different, and the original stays where
// it is. Its first check was the linked stage's proof.
test('a destination changed after its check is read again and the original is kept',async t=>{
 const root=await folder(t,'verify-once-changed-'),original=path.join(root,'incoming','A.JPG'),data=Buffer.alloc(SIZE,5);
 await photo(original,data);
 const {plans:[transfer]}=await core.plan(root,[root],organizing,sony);
 const destination=transfer!.entries[0]!.destination,mkdir=fs.mkdir.bind(fs);let changed=false;
 // The slot for the original is made after the check and before the original is set aside.
 t.mock.method(fs,'mkdir',async(...args:Parameters<typeof fs.mkdir>)=>{
  if(!changed&&String(args[0]).includes(`${path.sep}originals${path.sep}0${path.sep}`)){changed=true;const {atime,mtime}=await fs.lstat(destination);await fs.writeFile(destination,Buffer.alloc(SIZE,6));await fs.utimes(destination,atime,mtime);}
  return mkdir(...args);
 });syncBuiltinESMExports();
 const reads=countReads(t,file=>file===destination?'destination':undefined);
 const result=await organizeByCopy(transfer!);
 reads.stop();
 assert.equal(changed,true);assert.equal(result.errors.length,1);assert.match(result.errors[0]!,/Destination changed/);
 assert.deepEqual(reads.files(),{destination:1});
 assert.deepEqual(await fs.readFile(original),data);
});

async function organized(t:test.TestContext,name:string){
 const root=await folder(t,name),original=path.join(root,'incoming','A.JPG'),data=Buffer.alloc(SIZE,5);
 await photo(original,data);
 const {plans:[transfer]}=await core.plan(root,[root],organizing,sony);
 assert.deepEqual((await organizeByCopy(transfer!)).errors,[]);
 const id=(await core.getOrganizationRecovery(root))[0]?.id;
 const role=(file:string)=>file===original?'source':file===transfer!.entries[0]!.destination?'destination':recovery(file)&&file.endsWith('A.JPG')?'stash':undefined;
 return {root,id:id!,original,data,destination:transfer!.entries[0]!.destination,role};
}
// Every file is checked before the first release; the release itself re-reads nothing unchanged since.
test('releasing kept originals reads each file once',async t=>{
 const f=await organized(t,'verify-once-release-');
 const reads=countReads(t,f.role);
 const released=await core.finalizeOrganization(f.root,f.id);
 reads.stop();
 assert.equal(released.removed,1);
 assert.deepEqual(reads.files(),{stash:1,destination:1});
});
// On exFAT no stat proves a file unchanged between a check and its release, so the check before the first release
// looks at stats only and each kept original and its copy are read once, right before that file is released.
test('on exFAT releasing kept originals reads each file once, right before releasing it',async t=>{
 const f=await organized(t,'verify-once-exfat-release-');
 simulateExfat(t,f.root);
 const reads=countReads(t,f.role);
 const released=await core.finalizeOrganization(f.root,f.id);
 reads.stop();
 assert.equal(released.removed,1);
 assert.deepEqual(reads.files(),{stash:1,destination:1});
});
test('on exFAT a copy that changed is found before its original is released, and that original is kept',async t=>{
 const f=await organized(t,'verify-once-exfat-release-changed-');
 const store=path.join(f.root,'Photo Importer Data','Organizations');
 const stashed=(await fs.readdir(store,{recursive:true})).map(name=>path.join(store,String(name))).filter(file=>file.endsWith('A.JPG'));
 assert.equal(stashed.length,1);
 // Same size, same dates, different bytes: only a read can tell.
 const {mtime}=await fs.stat(f.destination);await fs.writeFile(f.destination,Buffer.alloc(SIZE,9));await fs.utimes(f.destination,mtime,mtime);
 simulateExfat(t,f.root);
 await assert.rejects(core.finalizeOrganization(f.root,f.id));
 assert.deepEqual(await fs.readFile(stashed[0]!),f.data,'the kept original is still there');
});
// The kept original is read in the check before anything changes; put back by this undo, it is not read again.
test('an undo reads the kept original once and the copy it removes once',async t=>{
 const f=await organized(t,'verify-once-undo-');
 const reads=countReads(t,f.role);
 const undone=await core.undoOrganization(f.root,f.id);
 reads.stop();
 assert.deepEqual(undone,{restored:1,removed:1,handedOff:0});
 assert.deepEqual(reads.files(),{stash:1,destination:1});
 assert.deepEqual(await fs.readFile(f.original),f.data);
});

// The scan's checksums are in the library's index: the removal confirms each pair with one read of each file,
// right before the duplicate is set aside, and does not read it again to set it aside.
test('removing a duplicate reads it and the copy kept once each',async t=>{
 const {scanDuplicates}=await import('../core/duplicates'),{removeDuplicates}=await import('../core/duplicate-removal');
 const {destinationIndex}=await import('../core/destination-index'),{identity}=await import('../core/paths'),{resolveGroups}=await import('../duplicate-rules');
 const lib=await folder(t,'verify-once-duplicates-'),keeper=path.join(lib,'2024','202405','Z','k.jpg'),removed=path.join(lib,'Imported','k.jpg'),data=Buffer.alloc(SIZE,3);
 await photo(keeper,data);await photo(removed,data);
 const index=await destinationIndex(lib,await identity(lib));
 const scan=await scanDuplicates(lib,{metadata:async()=>({fields:{}}),index});
 const reads=countReads(t,file=>recovery(file)&&file.endsWith('k.jpg')?'stash':file===keeper?'keeper':file===removed?'removed':undefined);
 const removal=await removeDuplicates(lib,resolveGroups(scan.groups,2),scan.companions,{index});
 reads.stop();
 assert.equal(removal.removed,1);assert.deepEqual(removal.result?.errors,[]);
 assert.deepEqual(reads.files(),{keeper:1,removed:1});
 await assert.rejects(fs.lstat(removed),{code:'ENOENT'});
});

// The import read the source under the identity it recorded; while the source keeps that exact, provable identity
// it is not read again. Every backup copy is always read, and a change of identity means the source is read too.
async function originals(t:test.TestContext,name:string){
 const {statKey}=await import('../core/paths');
 const base=await folder(t,name),source=path.join(base,'card','A.JPG'),backups=[path.join(base,'one','A.JPG'),path.join(base,'two','A.JPG')],data=Buffer.alloc(SIZE,8);
 await photo(source,data);for(const backup of backups)await photo(backup,data);
 const {createHash}=await import('node:crypto');
 const file={source,size:SIZE,sha256:createHash('sha256').update(data).digest('hex'),destinations:backups,identity:statKey(await fs.lstat(source,{bigint:true}))};
 return {root:path.join(base,'card'),source,backups,file,role:(name:string)=>name===source?'source':backups.includes(name)?'backup':undefined};
}
test('deleting originals reads an unchanged source not at all and every backup once',async t=>{
 const {deleteOriginals}=await import('../core/originals'),f=await originals(t,'verify-once-originals-');
 const totals:number[]=[],reads=countReads(t,f.role);
 const result=await deleteOriginals(f.root,[f.file],{changeTimes:true,onProgress:(_done,_total,_file,_bytes,total)=>{if(total!==undefined)totals.push(total);}});
 reads.stop();
 assert.deepEqual(result.deleted,[{source:f.source,size:SIZE}]);
 assert.deepEqual(reads.files(),{backup:2});
 // The byte total is planned before the first read and never changes.
 assert.ok(totals.length>1);assert.deepEqual(new Set(totals),new Set([2*SIZE]));
});
// Only a volume known to keep real change times (APFS, HFS+) lets an identity stand in for a read; on exFAT the
// change time equals the modified time, and without word about the volume the source is read.
for(const [name,exfat,changeTimes] of [['the volume is not known to keep change times',false,false],['on exFAT',true,true]] as const)test(`deleting originals reads an unchanged source when ${name}`,async t=>{
 const {deleteOriginals}=await import('../core/originals'),{statKey}=await import('../core/paths'),f=await originals(t,'verify-once-originals-volume-');
 if(exfat){simulateExfat(t,path.dirname(f.root));f.file.identity=statKey(await fs.lstat(f.source,{bigint:true}));}
 const reads=countReads(t,f.role);
 const result=await deleteOriginals(f.root,[f.file],{changeTimes});
 reads.stop();
 assert.equal(result.deleted.length,1);
 assert.deepEqual(reads.files(),{source:1,backup:2});
});
test('deleting originals reads a source whose change time moved',async t=>{
 const {deleteOriginals}=await import('../core/originals'),f=await originals(t,'verify-once-originals-ctime-');
 await new Promise(resolve=>setTimeout(resolve,20));await fs.chmod(f.source,0o600);
 const reads=countReads(t,f.role);
 const result=await deleteOriginals(f.root,[f.file],{changeTimes:true});
 reads.stop();
 assert.equal(result.deleted.length,1);
 assert.deepEqual(reads.files(),{source:1,backup:2});
});
test('deleting originals keeps a source whose backup differs, even when the source is unchanged',async t=>{
 const {deleteOriginals}=await import('../core/originals'),f=await originals(t,'verify-once-originals-differs-');
 await fs.writeFile(f.backups[1]!,Buffer.alloc(SIZE,9));
 const result=await deleteOriginals(f.root,[f.file],{changeTimes:true});
 assert.deepEqual(result.kept,[{source:f.source,reason:'destination-differs'}]);
 await fs.lstat(f.source);
});

// A stopped import keeps the checksums of the files it verified (main.ts remembers them in a finally after the copy),
// so the next plan of the same card recognises those files by identity without reading them.
test('a stopped import still remembers its checksums, and the next plan does not read those files',async t=>{
 const {rememberImported,loadImported}=await import('../platform/scan-memory');
 const base=await folder(t,'verify-once-stopped-'),card=path.join(base,'card'),root=path.join(base,'backup'),store=path.join(base,'store');
 const first=path.join(card,'A.bin'),second=path.join(card,'B.bin');await photo(first,Buffer.alloc(SIZE,1));await photo(second,Buffer.alloc(SIZE,2));await fs.mkdir(root);
 const options={backup:true as const,template:'{camera}',layout:'flat' as const,unknownRules:{}},none=async()=>({fields:{}});
 const {plans:[transfer]}=await core.plan(card,[root],options,none);
 const control=new AbortController(),verified:Record<string,{sha256:string;identity:string}>={};
 const stopped=await core.execute(transfer!,control.signal,undefined,{onFileOutcome:outcome=>{verified[outcome.source]={sha256:outcome.sha256,identity:outcome.sourceIdentity!};control.abort();}}).then(()=>false,error=>{if(error?.name!=='AbortError')throw error;return true;}).finally(()=>rememberImported(store,'card-volume',card,verified));
 assert.equal(stopped,true);assert.ok(Object.keys(verified).length>0);
 const other=path.join(base,'other');await fs.mkdir(other);
 const reads=countReads(t,file=>file===first?'first':file===second?'second':undefined);
 await core.plan(card,[other],{...options,sourceDigest:await loadImported(store,'card-volume',card)},none);
 reads.stop();
 assert.deepEqual(reads.files(),Object.fromEntries([['first',first],['second',second]].filter(([,file])=>!verified[file!]).map(([name])=>[name,1])));
});

// exFAT reports a change time equal to the modified time, so no stat proves a file unchanged: a job that finds
// the copy already there still reads it once to plan and once to confirm, as before, in a later session too.
test('on exFAT the destination is still read twice per job that skips it',async t=>{
 const {dropDestinationIndexes}=await import('../core/destination-index');
 const base=await folder(t,'verify-once-exfat-'),card=path.join(base,'card'),drive=path.join(base,'exfat'),source=path.join(card,'A.bin');
 await photo(source,Buffer.alloc(SIZE,4));await fs.mkdir(drive);
 simulateExfat(t,drive);
 // The app's own records (Photo Importer Data: receipts, index) are not the destination file.
 const reads=countReads(t,file=>file.startsWith(drive+path.sep)&&!file.endsWith('.partial')&&!file.includes(`${path.sep}Photo Importer Data${path.sep}`)?'destination':undefined);
 const options={backup:true as const,template:'{camera}',layout:'flat' as const,unknownRules:{}},none=async()=>({fields:{}});
 const job=async()=>{const before=reads.files().destination??0;const {plans:[transfer]}=await core.plan(card,[drive],options,none);return {result:await core.execute(transfer!,undefined,undefined,{exclusiveCopy:true}),reads:(reads.files().destination??0)-before};};
 assert.equal((await job()).result.copied,1);
 for(const later of [false,true]){
  if(later)dropDestinationIndexes();
  const {result,reads}=await job();
  assert.deepEqual({skipped:result.skipped,reads},{skipped:1,reads:2});
 }
});

// Only a source this job read itself (a streamed copy) carries its identity into Delete originals. A file found
// already in the backup was matched by a checksum from planning, so its source is read again before deletion.
test('delete originals reads the source of a file the import found already in the backup',async t=>{
 const {deleteOriginals,verifiedOriginals}=await import('../core/originals');
 const base=await folder(t,'verify-once-skipped-'),card=path.join(base,'card'),root=path.join(base,'backup'),source=path.join(card,'A.JPG');
 await photo(source,Buffer.alloc(SIZE,7));await fs.mkdir(root);
 const options={backup:true as const,template:'{camera}',layout:'flat' as const,unknownRules:{}},none=async()=>({fields:{}});
 const job=async()=>{
  const {plans:[transfer]}=await core.plan(card,[root],options,none),outcomes=new Map<string,DestinationOutcome[]>();
  const result=await core.execute(transfer!,undefined,undefined,{onFileOutcome:outcome=>{outcomes.set(outcome.source,[{...outcome,destinationSlot:0}]);}});
  return {result,files:verifiedOriginals(outcomes,[transfer!]).files};
 };
 const copied=await job(),skipped=await job();
 assert.equal(copied.result.copied,1);assert.equal(skipped.result.skipped,1);
 assert.equal(typeof copied.files[0]!.identity,'string');assert.equal(skipped.files[0]!.identity,undefined);
 const reads=countReads(t,file=>file===source?'source':undefined);
 assert.equal((await deleteOriginals(card,skipped.files)).deleted.length,1);
 reads.stop();
 assert.deepEqual(reads.files(),{source:1});
});

// On exFAT no stat proves a file unchanged between the check and setting the original aside, so both are read
// again after the stash intent, as before.
test('on exFAT an organization reads the original and the copy again before setting the original aside',async t=>{
 const root=await folder(t,'verify-once-exfat-organize-'),original=path.join(root,'incoming','A.JPG'),data=Buffer.alloc(SIZE,5);
 await photo(original,data);
 simulateExfat(t,root);
 const {plans:[transfer]}=await core.plan(root,[root],organizing,sony);
 const destination=transfer!.entries[0]!.destination;
 const reads=countReads(t,file=>file===original?'source':file===destination?'destination':file.endsWith('.partial')?'stage':recovery(file)&&file.endsWith('A.JPG')?'stash':undefined);
 const result=await organizeByCopy(transfer!);
 reads.stop();
 assert.deepEqual(result.errors,[]);assert.equal(result.moved,1);
 assert.deepEqual(reads.files(),{source:3,stage:1,destination:3});
});

// Without hard links the copy is streamed out of the stage into a new file, which is read back once. A link that is
// not exactly the stage plus one name (another name appeared) is read back too, and again before stashing: removing
// the stage's name moved the shared inode's change time.
for(const [name,expected,link] of [
 ['links are unsupported',1,async()=>{throw Object.assign(new Error('links unsupported'),{code:'ENOTSUP'});}],
 ['another name appears beside the link',2,async(from:string,to:string,original:(a:string,b:string)=>Promise<void>)=>{await original(from,to);await original(to,`${to}.other`);}],
] as const)test(`an organization copy reads its published copy back when ${name}`,async t=>{
 const root=await folder(t,'verify-once-fallback-'),original=path.join(root,'incoming','A.JPG'),data=Buffer.alloc(SIZE,5);
 await photo(original,data);
 const {plans:[transfer]}=await core.plan(root,[root],organizing,sony);
 const destination=transfer!.entries[0]!.destination,real=fs.link.bind(fs);
 t.mock.method(fs,'link',async(from:string,to:string)=>String(from).endsWith('.partial')?(link as (a:string,b:string,c:typeof real)=>Promise<void>)(String(from),String(to),real):real(from,to));syncBuiltinESMExports();
 const reads=countReads(t,file=>file===destination?'destination':undefined);
 const result=await organizeByCopy(transfer!);
 reads.stop();
 assert.deepEqual(result.errors,[]);assert.equal(result.moved,1);
 assert.deepEqual(reads.files(),{destination:expected});
 assert.deepEqual(await fs.readFile(destination),data);
});
