import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import * as core from '../core/index';

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

const organizing={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{},reorganize:true};
const sony=async()=>({camera:'Sony',date:'2024-02-03',fields:{}});
const recovery=(file:string)=>file.includes(`${path.sep}Photo Importer Recovery${path.sep}`);

// The copy streams and hashes the source once, the stage is read back once, and the hard link publishes that
// verified inode: neither the published name nor the original set aside is read again.
test('an organization copy reads its source once and its destination not at all after a link',async t=>{
 const root=await folder(t,'verify-once-organize-'),original=path.join(root,'incoming','A.JPG'),data=Buffer.alloc(SIZE,5);
 await photo(original,data);
 const {plans:[transfer]}=await core.plan(root,[root],organizing,sony);
 const destination=transfer!.entries[0]!.destination;
 const reads=countReads(t,file=>file===original?'source':file===destination?'destination':file.endsWith('.partial')?'stage':recovery(file)&&file.endsWith('A.JPG')?'stash':undefined);
 const result=await core.executeReorganization(transfer!);
 reads.stop();
 assert.deepEqual(result.errors,[]);assert.equal(result.moved,1);
 assert.deepEqual(reads.files(),{source:1,stage:1});
 assert.deepEqual(await fs.readFile(destination),data);
});

// Between the check and setting the original aside, a copy rewritten in place (same size, so only a read can tell)
// is read again, found different, and the original stays where it is. Its first check was the linked stage's proof.
test('a destination changed after its check is read again and the original is kept',async t=>{
 const root=await folder(t,'verify-once-changed-'),original=path.join(root,'incoming','A.JPG'),data=Buffer.alloc(SIZE,5);
 await photo(original,data);
 const {plans:[transfer]}=await core.plan(root,[root],organizing,sony);
 const destination=transfer!.entries[0]!.destination,mkdir=fs.mkdir.bind(fs);let changed=false;
 // The slot for the original is made after the check and before the original is set aside.
 t.mock.method(fs,'mkdir',async(...args:Parameters<typeof fs.mkdir>)=>{
  if(!changed&&String(args[0]).includes(`${path.sep}originals${path.sep}0${path.sep}`)){changed=true;await fs.writeFile(destination,Buffer.alloc(SIZE,6));}
  return mkdir(...args);
 });syncBuiltinESMExports();
 const reads=countReads(t,file=>file===destination?'destination':undefined);
 const result=await core.executeReorganization(transfer!);
 reads.stop();
 assert.equal(changed,true);assert.equal(result.errors.length,1);assert.match(result.errors[0]!,/Destination changed/);
 assert.deepEqual(reads.files(),{destination:1});
 assert.deepEqual(await fs.readFile(original),data);
});

async function organized(t:test.TestContext,name:string){
 const root=await folder(t,name),original=path.join(root,'incoming','A.JPG'),data=Buffer.alloc(SIZE,5);
 await photo(original,data);
 const {plans:[transfer]}=await core.plan(root,[root],organizing,sony);
 assert.deepEqual((await core.executeReorganization(transfer!)).errors,[]);
 const [id]=(await fs.readdir(path.join(root,'Photo Importer Recovery'))).filter(name=>/^[0-9a-f-]{36}$/.test(name));
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
 const result=await deleteOriginals(f.root,[f.file],{onProgress:(_done,_total,_file,_bytes,total)=>{if(total!==undefined)totals.push(total);}});
 reads.stop();
 assert.deepEqual(result.deleted,[{source:f.source,size:SIZE}]);
 assert.deepEqual(reads.files(),{backup:2});
 assert.equal(totals.at(-1),2*SIZE);
});
test('deleting originals reads a source whose change time moved',async t=>{
 const {deleteOriginals}=await import('../core/originals'),f=await originals(t,'verify-once-originals-ctime-');
 await new Promise(resolve=>setTimeout(resolve,20));await fs.chmod(f.source,0o600);
 const reads=countReads(t,f.role);
 const result=await deleteOriginals(f.root,[f.file]);
 reads.stop();
 assert.equal(result.deleted.length,1);
 assert.deepEqual(reads.files(),{source:1,backup:2});
});
test('deleting originals keeps a source whose backup differs, even when the source is unchanged',async t=>{
 const {deleteOriginals}=await import('../core/originals'),f=await originals(t,'verify-once-originals-differs-');
 await fs.writeFile(f.backups[1]!,Buffer.alloc(SIZE,9));
 const result=await deleteOriginals(f.root,[f.file]);
 assert.deepEqual(result.kept,[{source:f.source,reason:'destination-differs'}]);
 await fs.lstat(f.source);
});
