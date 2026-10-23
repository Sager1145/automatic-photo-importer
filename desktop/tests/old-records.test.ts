import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import patched from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import * as core from '../core/index';
import {acknowledgeOldRecords,findOldRecords,refuseOldRecords} from '../core/old-records';
import {beginDuplicateRemoval} from '../core/recovery';
import {openV5,storeFor} from '../core/app-store';
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
