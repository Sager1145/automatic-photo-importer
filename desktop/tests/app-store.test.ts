import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHmac} from 'node:crypto';
import * as store from '../core/app-store';

store.configureHostKey('fixture-only-host-recovery-secret-32bytes');

async function drive(t:test.TestContext){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'app-store-')));
 t.after(async()=>{store.registerDestinations([]);await fs.rm(root,{recursive:true,force:true});});
 return root;
}

test('a v5 seal covers its kind: a record of one kind never opens as another, nor a v1 seal',()=>{
 const sealed=store.sealV5('event',{id:'x',event:'complete'});
 assert.deepEqual(store.openV5('event',sealed),{v:5,kind:'event',id:'x',event:'complete'});
 assert.throws(()=>store.openV5('pointer',{...sealed,kind:'pointer'}),store.SealError);
 assert.throws(()=>store.openV5('event',{...sealed,event:'undo-complete'}),store.SealError);
 // A seal the earlier version wrote (HMAC over the plain JSON) never verifies.
 const unsigned={v:5,kind:'event',id:'x',event:'complete'};
 const v1=createHmac('sha256',Buffer.from('fixture-only-host-recovery-secret-32bytes')).update(JSON.stringify(unsigned)).digest('hex');
 assert.throws(()=>store.openV5('event',{...unsigned,seal:v1}),store.SealError);
});

test('the base is the configured destination a library lies beneath, else the library itself',async t=>{
 const root=await drive(t),destination=path.join(root,'A006'),library=path.join(destination,'photobackup');
 await fs.mkdir(library,{recursive:true});
 assert.equal(await store.baseFor(library),library,'no destination registered: the library itself');
 store.registerDestinations([destination]);
 assert.equal(await store.baseFor(library),destination);
 assert.equal(await store.baseFor(destination),destination,'the destination itself is its own base');
 const made=await store.storeFor(library);
 assert.equal(made.path,path.join(destination,'Photo Importer Data'));
 assert.ok((await fs.lstat(path.join(made.path,'store.json'))).isFile());
 assert.deepEqual((await store.storesFor(library)).map(item=>item.path),[made.path]);
});

test('an unwritable destination leaves the records in the library',async t=>{
 const root=await drive(t),destination=path.join(root,'locked'),library=path.join(destination,'photos');
 await fs.mkdir(library,{recursive:true});await fs.chmod(destination,0o555);
 try{store.registerDestinations([destination]);assert.equal(await store.baseFor(library),library);}finally{await fs.chmod(destination,0o755);}
});

test('readers find every store from the folder up to the top of its drive; a linked store is skipped',async t=>{
 const root=await drive(t),library=path.join(root,'a','b');await fs.mkdir(library,{recursive:true});
 const outer=await store.ensureStore(root),inner=await store.ensureStore(library);
 assert.deepEqual((await store.storesFor(library)).map(item=>item.path),[inner.path,outer.path]);
 const elsewhere=await fs.mkdtemp(path.join(root,'x-'));await fs.mkdir(path.join(root,'a','Photo Importer Data'));
 await fs.rm(path.join(root,'a','Photo Importer Data'),{recursive:true});await fs.symlink(elsewhere,path.join(root,'a','Photo Importer Data'));
 assert.deepEqual((await store.storesFor(library)).map(item=>item.path),[inner.path,outer.path]);
});

test('a store whose record another Mac sealed, or that was copied from another folder, is refused',async t=>{
 const root=await drive(t),one=path.join(root,'one'),two=path.join(root,'two');await fs.mkdir(one);await fs.mkdir(two);
 await store.ensureStore(one);
 await fs.cp(path.join(one,'Photo Importer Data'),path.join(two,'Photo Importer Data'),{recursive:true});
 await assert.rejects(store.storesFor(two),/copied from another folder/);
 await fs.writeFile(path.join(one,'Photo Importer Data','store.json'),JSON.stringify({v:5,kind:'store',base:one,seal:'0'.repeat(64)}));
 await assert.rejects(store.storesFor(one),/another Mac or is damaged/);
});

test('store unchanged: replacing the folder with another one is noticed',async t=>{
 const root=await drive(t),made=await store.ensureStore(root);
 await store.storeUnchanged(made);
 await fs.rename(made.path,made.path+' old');await fs.mkdir(made.path);
 await assert.rejects(store.storeUnchanged(made),/changed/);
});

test('the streaming reader returns whole lines, hands over a torn tail, skips over-cap junk and refuses an over-cap record',async t=>{
 const root=await drive(t),file=path.join(root,'log.jsonl');
 const junk='\0'.repeat(5000);
 await fs.writeFile(file,`{"a":1}\n${junk}\n{"b":2}\n{"c":`);
 const handle=await fs.open(file,'r');t.after(()=>handle.close());
 const lines:string[]=[],tails:string[]=[];
 const {end}=await store.readLines(handle,file,0,()=>2048,text=>{lines.push(text);},{onTail:text=>{tails.push(text);}});
 assert.deepEqual(lines,['{"a":1}','{"b":2}']);assert.deepEqual(tails,['{"c":']);
 assert.equal(end,(await fs.stat(file)).size-'{"c":'.length);
 const big=path.join(root,'big.jsonl');await fs.writeFile(big,JSON.stringify({x:'y'.repeat(5000)})+'\n');
 const other=await fs.open(big,'r');t.after(()=>other.close());
 await assert.rejects(store.readLines(other,big,0,()=>2048,()=>{}),store.RecordTooLarge);
});

test('the streaming reader never reads more than 1 MiB at a time and handles lines across chunks',async t=>{
 const root=await drive(t),file=path.join(root,'long.jsonl');
 const records=Array.from({length:3000},(_,i)=>JSON.stringify({i,pad:'p'.repeat(900)}));
 await fs.writeFile(file,records.join('\n')+'\n');
 const handle=await fs.open(file,'r');t.after(()=>handle.close());
 const read=handle.read.bind(handle);let largest=0;
 (handle as unknown as {read:typeof handle.read}).read=((buffer:Buffer,offset:number,length:number,position:number)=>{largest=Math.max(largest,length);return read(buffer,offset,length,position);}) as typeof handle.read;
 const seen:number[]=[];await store.readLines(handle,file,0,()=>2048,text=>{seen.push(JSON.parse(text).i);});
 assert.equal(seen.length,3000);assert.deepEqual(seen.slice(0,3),[0,1,2]);assert.ok(largest<=1024*1024);
});

test('group commit: concurrent appends become one write and one file sync; the folder is synchronized when the log is created',async t=>{
 const root=await drive(t),file=path.join(root,'group.jsonl');
 const before={...store.logStats};
 await Promise.all(Array.from({length:40},(_,i)=>store.appendLines(file,[JSON.stringify({i})])));
 assert.equal(store.logStats.writes-before.writes,1);
 assert.equal(store.logStats.fileSyncs-before.fileSyncs,1);
 assert.equal(store.logStats.folderSyncs-before.folderSyncs,1);
 assert.equal((await fs.readFile(file,'utf8')).trim().split('\n').length,40);
 // A later group on the existing log: the file alone (design r2 T1: a synchronized file keeps its size on FSKit exFAT).
 const later={...store.logStats};
 await Promise.all(Array.from({length:5},(_,i)=>store.appendLines(file,[JSON.stringify({later:i})])));
 assert.equal(store.logStats.writes-later.writes,1);assert.equal(store.logStats.fileSyncs-later.fileSyncs,1);
 assert.equal(store.logStats.folderSyncs-later.folderSyncs,store.SYNC_LOG_FOLDER_EACH_GROUP?1:0);
 // A torn last line is closed off before the next append.
 await fs.appendFile(file,'{"torn":');await store.appendLines(file,['{"next":1}']);
 assert.match(await fs.readFile(file,'utf8'),/\{"torn":\n\{"next":1\}\n$/);
});

test('group commit: an append whose check fails is refused alone',async t=>{
 const root=await drive(t),file=path.join(root,'check.jsonl');
 const results=await Promise.allSettled([store.appendLines(file,['{"a":1}']),store.appendLines(file,['{"b":1}'],async()=>{throw new Error('moved');}),store.appendLines(file,['{"c":1}'])]);
 assert.deepEqual(results.map(item=>item.status),['fulfilled','rejected','fulfilled']);
 assert.equal(await fs.readFile(file,'utf8'),'{"a":1}\n{"c":1}\n');
});

test('holding a log: appends wait until the hold ends',async t=>{
 const root=await drive(t),file=path.join(root,'hold.jsonl');await fs.writeFile(file,'');
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const held=store.holdLog(file,async()=>{await gate;return (await fs.readFile(file,'utf8')).length;});
 const append=store.appendLines(file,['{"late":1}']);
 await new Promise(resolve=>setTimeout(resolve,20));
 release();assert.equal(await held,0);await append;
 assert.equal(await fs.readFile(file,'utf8'),'{"late":1}\n');
});

test('both names: the target must be absent; a moved file is checked; two names for one file stop with nothing unlinked',async t=>{
 const root=await drive(t),a=path.join(root,'a'),b=path.join(root,'b'),c=path.join(root,'c');
 await fs.writeFile(a,'one');await fs.writeFile(b,'two');
 await assert.rejects(store.renameChecked(a,b),store.FirstAidError);
 assert.equal(await fs.readFile(a,'utf8'),'one');assert.equal(await fs.readFile(b,'utf8'),'two');
 assert.equal(await store.renameChecked(a,c),'done');
 assert.equal(await store.bothNames(a,c),'target');
 // APFS hard link: one file under two names.
 await fs.link(c,a);
 assert.equal(await store.bothNames(a,c),'both-same');
 await assert.rejects(store.renameChecked(a,c),store.FirstAidError);
 assert.equal((await fs.lstat(a)).nlink,2);
 await fs.unlink(a);assert.equal(await store.bothNames(a,c),'target');
 assert.equal(await store.bothNames(a,path.join(root,'none')),'none');
 assert.equal(await store.bothNames(b,path.join(root,'none')),'source');
 assert.equal(await store.bothNames(b,c),'both');
});

test('partitions are stable per folder, case and composition insensitive',()=>{
 const base={base:'/Volumes/A006'};
 assert.equal(store.libraryPartition(base,'/Volumes/A006/photobackup'),store.libraryPartition(base,'/Volumes/A006/PhotoBackup').replace('PhotoBackup','photobackup'));
 assert.match(store.libraryPartition(base,'/Volumes/A006/photobackup'),/^photobackup [0-9a-f]{8}$/);
 assert.equal(store.pointerPartition('/Volumes/A006/2023').split(' ')[1],store.pointerPartition('/Volumes/A006/2023'.normalize('NFD')).split(' ')[1]);
 assert.match(store.libraryPartition({base:'/Volumes/A006'},'/Volumes/A006'),/^A006 /);
});

test('many callers making the same store at once share one creation',async t=>{
 const root=await drive(t);
 const stores=await Promise.all(Array.from({length:20},()=>store.ensureStore(root)));
 assert.ok(stores.every(item=>item.path===stores[0]!.path&&item.ino===stores[0]!.ino));
 assert.deepEqual((await fs.readdir(path.join(root,'Photo Importer Data'))).sort(),['store.json']);
});
