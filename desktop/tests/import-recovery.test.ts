import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {plan,execute,configureOrganizationRecovery} from '../core';

configureOrganizationRecovery('import-fixture-host-authentication-secret-32bytes');
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{}};
const metadata=async()=>({camera:'Fixture Camera',date:'2024-02-03',fields:{}});
async function fixture(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'import-resume-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),root=path.join(base,'destination');await fs.mkdir(source);await fs.mkdir(root);
 const data=Buffer.alloc(2*1024*1024+13);for(let i=0;i<data.length;i++)data[i]=(i*31+Math.floor(i/4093))%251;
 const original=path.join(source,'A.JPG');await fs.writeFile(original,data);
 const prepare=async()=>(await plan(source,[root],options,metadata)).plans[0]!;
 return {base,source,root,data,original,prepare};
}
async function interrupt(t:test.TestContext,f:Awaited<ReturnType<typeof fixture>>){
 const transfer=await f.prepare(),destination=transfer.entries[0]!.destination,open=fs.open.bind(fs);let wrote=false;
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const handle=await open(...args);if(String(args[0])===destination&&args[1]==='wx'){
  const write=handle.write.bind(handle);t.mock.method(handle,'write',async(buffer:Buffer,offset:number,length:number,position:number|null)=>{if(wrote)throw Object.assign(new Error('Injected power interruption'),{code:'EIO'});wrote=true;return write(buffer,offset,Math.min(length,4093),position);});
 }return handle;});syncBuiltinESMExports();
 const result=await execute(transfer,undefined,undefined,{exclusiveCopy:true});t.mock.restoreAll();syncBuiltinESMExports();
 assert.equal(result.copied,0);assert.equal(result.errors.length,1);assert.deepEqual(await fs.readFile(destination),f.data.subarray(0,4093));
 return {destination,stat:await fs.lstat(destination,{bigint:true})};
}

test('verified owned exclusive partial resumes the same inode and removes its recovery record',async t=>{
 const f=await fixture(t),stopped=await interrupt(t,f),retry=await f.prepare();
 assert.equal(retry.entries[0]!.destination,stopped.destination);assert.equal(retry.entries[0]!.skip,false);
 assert.deepEqual(await execute(retry,undefined,undefined,{exclusiveCopy:true}),{copied:1,skipped:0,errors:[]});
 assert.equal((await fs.lstat(stopped.destination,{bigint:true})).ino,stopped.stat.ino);assert.deepEqual(await fs.readFile(stopped.destination),f.data);
 assert.deepEqual(await fs.readdir(path.dirname(stopped.destination)),['A.JPG']);assert.deepEqual(await fs.readFile(f.original),f.data);
 assert.deepEqual(await execute(await f.prepare()),{copied:0,skipped:1,errors:[]});
});

for(const change of ['prefix','replacement','source replacement','journal authentication','hard link'])test(`an owned partial with ${change} changed is preserved instead of resumed`,async t=>{
 const f=await fixture(t),{destination}=await interrupt(t,f);
 if(change==='prefix'){const handle=await fs.open(destination,'r+');try{await handle.write(Buffer.from('foreign'),0,7,0);}finally{await handle.close();}}
 if(change==='replacement'){await fs.rename(destination,destination+'.saved');await fs.writeFile(destination,f.data.subarray(0,4093));}
 if(change==='source replacement'){await fs.rename(f.original,f.original+'.saved');await fs.writeFile(f.original,f.data);}
 if(change==='hard link')await fs.link(destination,path.join(f.base,'foreign-link'));
 if(change==='journal authentication'){const name=(await fs.readdir(path.dirname(destination))).find(name=>name.startsWith('photo-importer-intent-'))!;const journal=path.join(path.dirname(destination),name),record=JSON.parse(await fs.readFile(journal,'utf8'));record.seal='0'.repeat(64);await fs.writeFile(journal,JSON.stringify(record));}
 const before=await fs.readFile(destination),retry=await f.prepare();assert.notEqual(retry.entries[0]!.destination,destination);assert.ok(retry.entries[0]!.destination.includes(path.sep+'Conflicts'+path.sep));
 assert.deepEqual(await execute(retry),{copied:1,skipped:0,errors:[]});assert.deepEqual(await fs.readFile(destination),before);assert.deepEqual(await fs.readFile(retry.entries[0]!.destination),f.data);
});

test('a replaced partial symlink never redirects resumed writes',async t=>{
 const f=await fixture(t),{destination}=await interrupt(t,f),outside=path.join(f.base,'foreign');await fs.writeFile(outside,'precious');await fs.rename(destination,destination+'.saved');await fs.symlink(outside,destination);
 await assert.rejects(f.prepare(),/symbolic|unsafe/i);assert.equal(await fs.readFile(outside,'utf8'),'precious');
});

test('different contents move the entire incoming family beneath camera Conflicts and repeated imports skip it',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.source,'A.ARW'),'new RAW');await fs.writeFile(path.join(f.source,'A.XMP'),'new sidecar');
 const existing=path.join(f.root,'2024/202402/Fixture Camera/ARW/A.ARW');await fs.mkdir(path.dirname(existing),{recursive:true});await fs.writeFile(existing,'old RAW');
 const transfer=await f.prepare();assert.equal(transfer.entries.length,3);
 const folders=transfer.entries.map(entry=>path.relative(path.join(f.root,'2024/202402/Fixture Camera'),entry.destination).split(path.sep));
 assert.ok(folders.every(parts=>parts[0]==='Conflicts'));assert.equal(new Set(folders.map(parts=>parts[1])).size,1);
 assert.deepEqual(transfer.entries.map(entry=>path.basename(entry.destination)).sort(),['A.ARW','A.JPG','A.XMP']);
 assert.deepEqual(await execute(transfer),{copied:3,skipped:0,errors:[]});assert.equal(await fs.readFile(existing,'utf8'),'old RAW');
 assert.deepEqual(await execute(await f.prepare()),{copied:0,skipped:3,errors:[]});
});

test('metadata read failures are returned with the inventory while original bytes still import',async t=>{
 const f=await fixture(t);const prepared=await plan(f.source,[f.root],options,async()=>{throw new Error('Truncated JPEG segment');});
 assert.deepEqual(prepared.inventory.issues,[{path:f.original,message:'Truncated JPEG segment'}]);
 assert.deepEqual(await execute(prepared.plans[0]!),{copied:1,skipped:0,errors:[]});
 const returned=await plan(f.source,[f.root],options,async()=>({fields:{Error:'Unable to read JPEG'}}));
 assert.deepEqual(returned.inventory.issues,[{path:f.original,message:'Unable to read JPEG'}]);
 const absent=await plan(f.source,[f.root],options,async()=>({fields:{}}));assert.deepEqual(absent.inventory.issues??[],[]);
});

test('serialized plans retain camera conflict routing when another writer arrives after planning',async t=>{
 const f=await fixture(t),transfer=JSON.parse(JSON.stringify(await f.prepare()));
 const destination=transfer.entries[0].destination;await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,'late foreign file');
 assert.deepEqual(await execute(transfer),{copied:1,skipped:0,errors:[]});assert.equal(await fs.readFile(destination,'utf8'),'late foreign file');
 const camera=path.join(f.root,'2024/202402/Fixture Camera'),[bucket]=await fs.readdir(path.join(camera,'Conflicts'));assert.ok(bucket);
 assert.deepEqual(await fs.readFile(path.join(camera,'Conflicts',bucket,'JPEG/A.JPG')),f.data);
 assert.deepEqual(await execute(await f.prepare()),{copied:0,skipped:1,errors:[]});
});

test('service receipts are excluded from organization and backup inventories while unrelated hidden user files remain',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.source,'.import-stage-11111111-1111-4111-8111-111111111111.json'),'service receipt');await fs.writeFile(path.join(f.source,'.import-11111111-1111-4111-8111-111111111111.partial'),'service partial');await fs.writeFile(path.join(f.source,'.import-user-notes.json'),'user notes');
 const prepared=await plan(f.source,[f.root],{...options,backup:true},metadata);
 assert.deepEqual(prepared.inventory.files.map(file=>file.relative).sort(),['.import-user-notes.json','A.JPG']);
});

test('concurrent imports of the same source never share an active owned staging file',async t=>{
 const f=await fixture(t),transfer=await f.prepare(),open=fs.open.bind(fs);let release!:()=>void,notice!:()=>void,paused=false;
 const waiting=new Promise<void>(resolve=>{notice=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const handle=await open(...args);if(String(args[0]).endsWith('.partial')&&args[1]==='wx'&&!paused){paused=true;const write=handle.write.bind(handle);t.mock.method(handle,'write',async(...writeArgs:Parameters<typeof handle.write>)=>{notice();await released;return write(...writeArgs);});}return handle;});syncBuiltinESMExports();
 const first=execute(transfer);await waiting;
 let second:Awaited<ReturnType<typeof execute>>;try{second=await execute(transfer);}finally{release();}
 const results=[await first,second];t.mock.restoreAll();syncBuiltinESMExports();
 assert.ok(results.every(result=>result.errors.length===0),JSON.stringify(results));assert.equal(results.reduce((n,result)=>n+result.copied,0),1);assert.equal(results.reduce((n,result)=>n+result.skipped,0),1);
 assert.deepEqual(await fs.readFile(transfer.entries[0]!.destination),f.data);assert.deepEqual(await fs.readdir(path.dirname(transfer.entries[0]!.destination)),['A.JPG']);
});

test('receipt indexing enumerates a camera directory once per operation while importing many files',async t=>{
 const f=await fixture(t);for(let i=0;i<12;i++)await fs.writeFile(path.join(f.source,`P${i}.JPG`),`photo ${i}`);
 const folder=path.join(f.root,'2024/202402/Fixture Camera/JPEG'),readdir=fs.readdir.bind(fs);let enumerations=0;
 t.mock.method(fs,'readdir',async(...args:Parameters<typeof fs.readdir>)=>{if(String(args[0])===folder)enumerations++;return readdir(...args);});syncBuiltinESMExports();
 const transfer=await f.prepare();assert.deepEqual(await execute(transfer),{copied:13,skipped:0,errors:[]});
 t.mock.restoreAll();syncBuiltinESMExports();assert.ok(enumerations<=2,`Directory was enumerated ${enumerations} times`);
});
