// One drive's records shared by every computer that uses it (docs/shared-records.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import * as store from '../core/app-store';
import {parseReceiptLine} from '../core/import-recovery';
import {getOrganizationRecovery} from '../core/index';
import {otherComputer} from './fixtures/other-computer';

const SECRET='fixture-only-host-recovery-secret-32bytes';
store.configureHostKey(SECRET);
const mine=store.keyId(Buffer.from(SECRET));

async function drive(t:test.TestContext){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'shared-records-')));
 t.after(async()=>{store.registerDestinations([]);await fs.rm(root,{recursive:true,force:true});});
 await fs.mkdir(path.join(root,'Photo Importer Data','Imports'),{recursive:true});
 return {root,data:path.join(root,'Photo Importer Data'),file:path.join(root,'Photo Importer Data','store.json')};
}
const readRecord=async(file:string)=>JSON.parse(await fs.readFile(file,'utf8'));
const closeLine=(computer:ReturnType<typeof otherComputer>)=>computer.line('receipt',{op:'close',rid:randomUUID()});
/** The app on another computer, in its own process with its own key, writing to the store at `base`. */
function onComputer(key:Buffer,base:string):{verified:boolean;joined:boolean}{
 const module=pathToFileURL(path.resolve('desktop/core/app-store.ts')).href;
 const script=`import {configureHostKey,ensureStore} from ${JSON.stringify(module)};
 configureHostKey(Buffer.from(${JSON.stringify(key.toString('base64'))},'base64'));
 const made=await ensureStore(${JSON.stringify(base)});process.stdout.write(JSON.stringify({verified:made.verified,joined:made.joined}));`;
 const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:process.cwd(),encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);
 return JSON.parse(child.stdout);
}

test('a store lists every computer that writes to it; their records verify once the store is read',async t=>{
 const {root,file}=await drive(t),other=otherComputer(),base=await fs.lstat(root,{bigint:true});
 await fs.writeFile(file,JSON.stringify(other.storeRecord('/Volumes/A006',store.storeIdentity(base))));
 const line=closeLine(other);
 assert.deepEqual(parseReceiptLine(line),{op:'bad'},'a computer no store has listed yet');
 assert.deepEqual((await store.storesFor(root)).map(item=>[item.verified,item.joined]),[[true,false]]);
 assert.equal(parseReceiptLine(line)?.op,'close');
 // Writing joins: this computer is listed after the other one, whose key and identity stay.
 const joined=await store.ensureStore(root);assert.equal(joined.joined,true);
 const record=await readRecord(file);
 assert.deepEqual(record.computers.map((item:{id:string})=>item.id),[other.id,mine]);
 assert.equal(record.identities[process.platform],store.storeIdentity(base));
 assert.equal(record.base,root,'the base is written as this system names it');
 assert.equal(parseReceiptLine(store.sealedLine('receipt',{op:'close',rid:randomUUID()}))?.op,'close');
 const before=await fs.lstat(file,{bigint:true});
 assert.equal((await store.ensureStore(root)).joined,true);
 assert.equal((await fs.lstat(file,{bigint:true})).ino,before.ino,'joined once, not rewritten again');
});

test('an earlier store another computer sealed is history here, is joined on the first write, and is shared once that computer joins too',async t=>{
 const {root,data,file}=await drive(t),mac=otherComputer('darwin'),base=await fs.lstat(root,{bigint:true});
 const legacy=mac.legacyStoreRecord('/Volumes/A006',`${base.dev}:${base.ino}`);
 await fs.writeFile(file,JSON.stringify(legacy));
 const line=closeLine(mac);await fs.writeFile(path.join(data,'Imports','receipts-000001.jsonl'),line+'\n');
 // Readable, never refused, but nothing in it verifies here.
 const [found]=await store.storesFor(root);assert.equal(found!.verified,false);
 assert.deepEqual(parseReceiptLine(line),{op:'bad'});
 await fs.mkdir(path.join(root,'photobackup'));
 const id=randomUUID(),journal=path.join(data,'Organizations',id,'journal.jsonl');await fs.mkdir(path.dirname(journal),{recursive:true});
 await fs.writeFile(journal,mac.line('organization',{id,root:path.join(root,'photobackup')})+'\n');
 // Its journals are listed as unreadable, never undone or finalized here.
 const jobs=await getOrganizationRecovery(path.join(root,'photobackup'));
 assert.deepEqual(jobs.map(job=>[job.id,job.undoable,job.finalizable]),[[id,false,false]]);assert.match(jobs[0]!.error!,/authentication failed/);
 // An import onto the drive goes on: the library's store is joined.
 const library=path.join(root,'photobackup');store.registerDestinations([root]);
 const made=await store.storeFor(library);assert.equal(made.path,data);assert.deepEqual([made.verified,made.joined],[true,true]);
 let record=await readRecord(file);
 assert.deepEqual(record.computers.map((item:{id:string})=>item.id),[mine]);
 assert.deepEqual(record.legacy,legacy,'the earlier record is kept exactly as it was');
 assert.deepEqual(Object.keys(record.identities),[process.platform]);
 assert.deepEqual(parseReceiptLine(line),{op:'bad'},'still unverified: the computer that sealed it has not joined');
 // That computer opens the drive with this version: it recognizes its earlier record and joins.
 assert.deepEqual(onComputer(mac.key,root),{verified:true,joined:true});
 record=await readRecord(file);
 assert.deepEqual(record.computers.map((item:{id:string})=>item.id),[mine,mac.id]);
 assert.deepEqual(record.legacy,legacy);
 // Here, its key is learned with the store, and every record it ever wrote on the drive verifies.
 assert.deepEqual((await store.storesFor(root)).map(item=>[item.verified,item.joined]),[[true,true]]);
 assert.equal(parseReceiptLine(line)?.op,'close');
});

test('the computer that made an earlier store still checks its identity, and joins it',async t=>{
 const {root,file}=await drive(t),me=otherComputer(process.platform,Buffer.from(SECRET)),base=await fs.lstat(root,{bigint:true});
 const legacy=me.legacyStoreRecord(root,`${base.dev}:${base.ino}`);await fs.writeFile(file,JSON.stringify(legacy));
 assert.deepEqual((await store.storesFor(root)).map(item=>[item.verified,item.joined]),[[true,false]]);
 const copy=path.join(root,'copy');await fs.mkdir(copy);
 await fs.cp(path.dirname(file),path.join(copy,'Photo Importer Data'),{recursive:true});
 await assert.rejects(store.storesFor(copy),/copied from another folder/);
 assert.equal((await store.ensureStore(root)).joined,true);
 const record=await readRecord(file);
 assert.deepEqual(record.legacy,legacy);assert.equal(record.identities[process.platform],store.storeIdentity(base));
});

test('a store record whose listed key ids do not match their keys is damaged',async t=>{
 const {root,file}=await drive(t),other=otherComputer(),base=await fs.lstat(root,{bigint:true});
 const record=other.storeRecord(root,store.storeIdentity(base)) as Record<string,any>;
 const {seal:_seal,v:_v,kind:_kind,...rest}=record;
 await fs.writeFile(file,JSON.stringify(other.seal('store',{...rest,computers:[{...rest.computers[0],id:'0'.repeat(16)}]})));
 await assert.rejects(store.storesFor(root),/Damaged Photo Importer Data record/);
});

test('a connected drive is joined without waiting for a write, and a drive with no store is left alone',async t=>{
 const {root,file}=await drive(t),mac=otherComputer('darwin'),base=await fs.lstat(root,{bigint:true});
 const empty=path.join(root,'empty');await fs.mkdir(empty);
 assert.equal(await store.joinStore(empty),false);assert.deepEqual(await fs.readdir(empty),[]);
 await fs.writeFile(file,JSON.stringify(mac.legacyStoreRecord('/Volumes/A006',`${base.dev}:${base.ino}`)));
 assert.equal(await store.joinStore(root),true);
 assert.equal(await store.joinStore(root),false,'already joined');
 assert.deepEqual((await readRecord(file)).computers.map((item:{id:string})=>item.id),[mine]);
});

test('a path a record names under any place the drive has had is read under its place here',async t=>{
 const {root}=await drive(t),here={base:root,bases:['/Volumes/A006','I:\\','E:\\']};
 assert.equal(store.recordedPath(here,'/Volumes/A006/photobackup/2024'),path.join(root,'photobackup','2024'));
 assert.equal(store.recordedPath(here,String.raw`i:\PhotoBackup\2024`),path.join(root,'PhotoBackup','2024'));
 assert.equal(store.recordedPath(here,path.join(root,'videobackup')),path.join(root,'videobackup'));
 assert.equal(store.recordedPath(here,'/Users/someone/Pictures'),undefined);
 assert.equal(store.recordedPath(here,String.raw`F:\photobackup`),undefined);
});

test('each system keeps its own index and duplicate store for a library, so moving the drive never rebuilds the other one',()=>{
 const partition=store.libraryPartition({base:path.join(os.tmpdir(),'A006')},path.join(os.tmpdir(),'A006','photo','backup'));
 const darwin=store.hash8('photo/backup'),system=store.hash8(`${process.platform}\nphoto/backup`);
 assert.equal(partition,`backup ${process.platform==='darwin'?darwin:system}`,'macOS keeps the name earlier versions gave it');
});
