import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {plan,execute} from '../core';
/** Directory listing without the destination checksum index, which every copy may refresh. */
const visible=async(folder:string)=>(await fs.readdir(folder)).filter(name=>!name.startsWith('photo-importer-index'));


const options={backup:true,template:'{year}/{camera}',layout:'flat' as const,unknownRules:{}};
async function fixture(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'transfer-failures-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),root=path.join(base,'destination');await fs.mkdir(source);await fs.mkdir(root);
 const original=path.join(source,'original.bin'),data=Buffer.alloc(3*1024*1024);
 // Position-dependent bytes expose skipped/repeated short-write segments.
 for(let index=0;index<data.length;index++)data[index]=(index*31+Math.floor(index/4093)*17)%251;
 await fs.writeFile(original,data);await fs.writeFile(path.join(root,'keep.txt'),'pre-existing destination');
 const prepare=async()=>(await plan(source,[root],options,async()=>{throw new Error('Every-file backup must not request metadata');})).plans[0];
 const unchanged=async()=>{assert.deepEqual(await fs.readFile(original),data);assert.equal(await fs.readFile(path.join(root,'keep.txt'),'utf8'),'pre-existing destination');};
 const retry=async()=>{assert.deepEqual(await execute(await prepare()),{copied:1,skipped:0,errors:[]});assert.deepEqual(await fs.readFile(path.join(root,'original.bin')),data);await unchanged();assert.deepEqual((await visible(root)).sort(),['keep.txt','original.bin']);};
 return {source,root,original,data,prepare,unchanged,retry};
}
function fault(code:string){return Object.assign(new Error(`Injected filesystem ${code}`),{code});}
function handles(t:test.TestContext,configure:(file:string,flags:unknown,handle:FileHandle)=>void){
 const open=fs.open.bind(fs);
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const handle=await open(...args);configure(String(args[0]),args[1],handle);return handle;});
 syncBuiltinESMExports();
 const restore=()=>{t.mock.restoreAll();syncBuiltinESMExports();};t.after(restore);return restore;
}
function writing(file:string,flags:unknown,root:string){return file.startsWith(root+path.sep)&&typeof flags==='string'&&flags.includes('w');}

for(const code of ['EIO','ENODEV','EACCES'])test(`source ${code} after streaming starts preserves originals and permits a clean retry`,async t=>{
 const f=await fixture(t),prepared=await f.prepare();let streamed=0,injected=false;
 const restore=handles(t,(file,_flags,handle)=>{if(file!==f.original)return;const read=handle.read.bind(handle);t.mock.method(handle,'read',async(...args:Parameters<typeof handle.read>)=>{if(streamed>0&&!injected){injected=true;throw fault(code);}return read(...args);});});
 const result=await execute(prepared,undefined,progress=>{streamed=progress.bytes;});restore();
 assert.equal(injected,true);assert.ok(streamed>0);assert.equal(result.copied,0);assert.equal(result.errors.length,1);assert.match(result.errors[0],new RegExp(code));
 await f.unchanged();assert.deepEqual(await visible(f.root),['keep.txt']);await f.retry();
});

for(const code of ['ENOSPC','EIO','ENODEV','EACCES'])test(`destination ${code} mid-write never publishes an incomplete file or changes existing files`,async t=>{
 const f=await fixture(t),prepared=await f.prepare();let written=0,injected=false;
 const restore=handles(t,(file,flags,handle)=>{if(!writing(file,flags,f.root))return;const write=handle.write.bind(handle);t.mock.method(handle,'write',async(buffer:Buffer,offset:number,length:number,position:number|null)=>{if(written>0&&!injected){injected=true;throw fault(code);}const result=await write(buffer,offset,length,position);written+=result.bytesWritten;return result;});});
 const result=await execute(prepared);restore();
 assert.equal(injected,true);assert.ok(written>0);assert.equal(result.copied,0);assert.equal(result.errors.length,1);assert.match(result.errors[0],new RegExp(code));
 await f.unchanged();assert.deepEqual(await visible(f.root),['keep.txt']);await f.retry();
});

test('a destination fsync failure preserves originals, reports failure and can be retried',async t=>{
 const f=await fixture(t),prepared=await f.prepare();let injected=false;
 const restore=handles(t,(file,flags,handle)=>{if(!writing(file,flags,f.root))return;const sync=handle.sync.bind(handle);t.mock.method(handle,'sync',async()=>{if(!injected){injected=true;throw fault('EIO');}return sync();});});
 const result=await execute(prepared);restore();
 assert.equal(injected,true);assert.equal(result.copied,0);assert.equal(result.errors.length,1);assert.match(result.errors[0],/EIO/);
 await f.unchanged();assert.deepEqual(await visible(f.root),['keep.txt']);await f.retry();
});

test('corrupted staged destination bytes are detected before publication and remain retryable',async t=>{
 const f=await fixture(t),prepared=await f.prepare();let injected=false;
 const restore=handles(t,(file,flags,handle)=>{if(!writing(file,flags,f.root))return;const sync=handle.sync.bind(handle),write=handle.write.bind(handle);t.mock.method(handle,'sync',async()=>{await sync();if(!injected){injected=true;await write(Buffer.from([66]),0,1,0);}});});
 const result=await execute(prepared);restore();
 assert.equal(injected,true);assert.equal(result.copied,0);assert.equal(result.errors.length,1);assert.match(result.errors[0],/verification failed/i);
 await f.unchanged();assert.deepEqual(await visible(f.root),['keep.txt']);await f.retry();
});

test('short filesystem writes are completed without losing or duplicating bytes',async t=>{
 const f=await fixture(t),prepared=await f.prepare();let shortWrites=0;
 const restore=handles(t,(file,flags,handle)=>{if(!writing(file,flags,f.root))return;const write=handle.write.bind(handle);t.mock.method(handle,'write',async(buffer:Buffer,offset:number,length:number,position:number|null)=>{if(length>4093)shortWrites++;return write(buffer,offset,Math.min(length,4093),position);});});
 const result=await execute(prepared);restore();
 assert.ok(shortWrites>0);assert.deepEqual(result,{copied:1,skipped:0,errors:[]});assert.deepEqual(await fs.readFile(path.join(f.root,'original.bin')),f.data);await f.unchanged();
});

test('a zero-progress filesystem write fails without publishing partial contents',async t=>{
 const f=await fixture(t),prepared=await f.prepare();let injected=false;
 const restore=handles(t,(file,flags,handle)=>{if(!writing(file,flags,f.root))return;const write=handle.write.bind(handle);t.mock.method(handle,'write',async(buffer:Buffer,offset:number,length:number,position:number|null)=>{if(!injected){injected=true;return {bytesWritten:0,buffer};}return write(buffer,offset,length,position);});});
 const result=await execute(prepared);restore();
 assert.equal(injected,true);assert.equal(result.copied,0);assert.equal(result.errors.length,1);assert.match(result.errors[0],/Unable to write/);
 await f.unchanged();assert.deepEqual(await visible(f.root),['keep.txt']);await f.retry();
});

test('one full destination cannot prevent the other copy, and retry verifies the healthy destination',async t=>{
 const f=await fixture(t),healthy=path.join(path.dirname(f.root),'healthy-destination');await fs.mkdir(healthy);await fs.writeFile(path.join(healthy,'keep.txt'),'healthy pre-existing file');
 const prepare=()=>plan(f.source,[f.root,healthy],options,async()=>{throw new Error('Backup must not read metadata');});
 const prepared=await prepare();let written=0,injected=false;
 const restore=handles(t,(file,flags,handle)=>{if(!writing(file,flags,f.root))return;const write=handle.write.bind(handle);t.mock.method(handle,'write',async(buffer:Buffer,offset:number,length:number,position:number|null)=>{if(written>0&&!injected){injected=true;throw fault('ENOSPC');}const value=await write(buffer,offset,length,position);written+=value.bytesWritten;return value;});});
 const [failed,successful]=await Promise.all(prepared.plans.map(transfer=>execute(transfer)));restore();
 assert.equal(injected,true);assert.equal(failed.copied,0);assert.equal(failed.errors.length,1);assert.match(failed.errors[0],/ENOSPC/);assert.deepEqual(successful,{copied:1,skipped:0,errors:[]});
 const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');assert.equal(hash(await fs.readFile(path.join(healthy,'original.bin'))),hash(f.data));
 assert.deepEqual(await visible(f.root),['keep.txt']);await f.unchanged();assert.equal(await fs.readFile(path.join(healthy,'keep.txt'),'utf8'),'healthy pre-existing file');
 const retry=await prepare();assert.equal(retry.plans[0].entries[0].skip,false);assert.equal(retry.plans[1].entries[0].skip,true);
 assert.deepEqual(await Promise.all(retry.plans.map(transfer=>execute(transfer))),[{copied:1,skipped:0,errors:[]},{copied:0,skipped:1,errors:[]}]);
 for(const root of [f.root,healthy])assert.equal(hash(await fs.readFile(path.join(root,'original.bin'))),hash(f.data));await f.unchanged();assert.equal(await fs.readFile(path.join(healthy,'keep.txt'),'utf8'),'healthy pre-existing file');
});

test('corruption during exclusive publication is reported with its intent retained and retry preserves the corrupt output',async t=>{
 const f=await fixture(t),prepared=await f.prepare(),destination=prepared.entries[0].destination;
 let injected=false;
 const restoreHandles=handles(t,(file,flags,handle)=>{if(file!==destination||flags!=='wx')return;const sync=handle.sync.bind(handle);t.mock.method(handle,'sync',async()=>{if((await handle.stat()).size===f.data.length&&!injected){injected=true;await handle.write(Buffer.from([66]),0,1,0);}await sync();});});
 const restore=()=>{t.mock.restoreAll();syncBuiltinESMExports();};t.after(restore);
 const result=await execute(prepared,undefined,undefined,{exclusiveCopy:true});restoreHandles();restore();
 assert.equal(injected,true);assert.equal(result.copied,0);assert.equal(result.errors.length,1);assert.match(result.errors[0],/Destination verification failed/);
 const corrupted=await fs.readFile(destination);assert.equal(corrupted.length,f.data.length);assert.equal(corrupted[0],66);assert.notDeepEqual(corrupted,f.data);await f.unchanged();
 const names=await visible(f.root),intentName=names.find(name=>name.startsWith('photo-importer-intent-'));assert.ok(intentName);assert.equal(names.some(name=>name.endsWith('.partial')),false);
 const intentBytes=await fs.readFile(path.join(f.root,intentName));const intent=JSON.parse(intentBytes.toString());assert.equal(intent.source,f.original);assert.equal(intent.destination,destination);assert.equal(intent.sha256,createHash('sha256').update(f.data).digest('hex'));
 const retry=await f.prepare();assert.notEqual(retry.entries[0].destination,destination);assert.deepEqual(await execute(retry,undefined,undefined,{exclusiveCopy:true}),{copied:1,skipped:0,errors:[]});
 assert.deepEqual(await fs.readFile(retry.entries[0].destination),f.data);assert.deepEqual(await fs.readFile(destination),corrupted);assert.deepEqual(await fs.readFile(path.join(f.root,intentName)),intentBytes);await f.unchanged();
});

test('verified copying preserves pre-existing malformed media bytes and does not claim to validate the image format',async t=>{
 const f=await fixture(t),file=path.join(f.source,'damaged.JPG'),truncated=Buffer.from([0xff,0xd8,0xff,0xe1,0x00,0x20,0x00]);await fs.writeFile(file,truncated);
 let inspected=false;const prepared=await plan(f.source,[f.root],{...options,backup:false},async()=>{inspected=true;throw new Error('JPEG ends inside its EXIF segment');});
 assert.equal(inspected,true);assert.equal(prepared.plans[0].entries.length,1);assert.equal(prepared.plans[0].entries[0].source,file);
 assert.deepEqual(await execute(prepared.plans[0]),{copied:1,skipped:0,errors:[]});assert.deepEqual(await fs.readFile(prepared.plans[0].entries[0].destination),truncated);assert.deepEqual(await fs.readFile(file),truncated);await f.unchanged();
});

test('directory-sync failure does not acknowledge a valid publication and retry synchronizes the existing copy',async t=>{
 const f=await fixture(t),prepared=await f.prepare();let injected=false;
 const restore=handles(t,(file,_flags,handle)=>{if(file===f.root)t.mock.method(handle,'sync',async()=>{injected=true;throw fault('EIO');});});
 const result=await execute(prepared);restore();
 assert.equal(injected,true);assert.equal(result.copied,0);assert.equal(result.skipped,0);assert.equal(result.errors.length,1);assert.match(result.errors[0],/EIO/);
 assert.deepEqual(await fs.readFile(prepared.entries[0].destination),f.data);await f.unchanged();
 let synchronized=false;const retry=await f.prepare();assert.equal(retry.entries[0].skip,true);
 const restoreRetry=handles(t,(file,_flags,handle)=>{if(file===f.root){const sync=handle.sync.bind(handle);t.mock.method(handle,'sync',async()=>{await sync();synchronized=true;});}});
 const repeated=await execute(retry);restoreRetry();
 assert.equal(synchronized,true);assert.deepEqual(repeated,{copied:0,skipped:1,errors:[]});await f.unchanged();
});

test('unsupported directory synchronization cannot be reported as a completed backup',async t=>{
 const f=await fixture(t),prepared=await f.prepare();let injected=false;
 const restore=handles(t,(file,_flags,handle)=>{if(file===f.root)t.mock.method(handle,'sync',async()=>{injected=true;throw fault('ENOTSUP');});});
 const result=await execute(prepared);restore();
 assert.equal(injected,true);assert.equal(result.copied,0);assert.equal(result.errors.length,1);assert.match(result.errors[0],/ENOTSUP/);
 assert.deepEqual(await fs.readFile(prepared.entries[0].destination),f.data);await f.unchanged();
});

test('new nested destination bindings are synchronized through the selected root before completion',async t=>{
 const f=await fixture(t),relative='2026/202607/Camera/photo.JPG',source=path.join(f.source,relative);await fs.mkdir(path.dirname(source),{recursive:true});await fs.writeFile(source,'nested original');
 const prepared=await f.prepare(),expected=[path.join(f.root,'2026/202607/Camera'),path.join(f.root,'2026/202607'),path.join(f.root,'2026'),f.root],synced=new Set<string>();let acknowledged=false;
 const restore=handles(t,(file,_flags,handle)=>{if(expected.includes(file)){const sync=handle.sync.bind(handle);t.mock.method(handle,'sync',async()=>{await sync();synced.add(file);});}});
 const result=await execute(prepared,undefined,progress=>{if(progress.phase==='verifying'&&progress.completed===2){acknowledged=true;assert.ok(expected.every(folder=>synced.has(folder)),'Every directory binding must be synchronized before completion');}});restore();
 assert.equal(acknowledged,true);assert.deepEqual(result,{copied:2,skipped:0,errors:[]});assert.equal(await fs.readFile(path.join(f.root,relative),'utf8'),'nested original');await f.unchanged();
});

test('exclusive publication durably records intent before copying and releases it after the destination binding is synchronized',async t=>{
 const f=await fixture(t);await fs.rename(f.original,path.join(f.source,'photo.JPG'));
 const prepared=(await plan(f.source,[f.root],{...options,backup:false,template:'{year}/{yyyymm}/{camera}'},async()=>({camera:'Fixture Camera',date:'2026-07-01T12:00:00+08:00',fields:{}}))).plans[0];
 const expected=[path.join(f.root,'2026/202607/Fixture Camera'),path.join(f.root,'2026/202607'),path.join(f.root,'2026'),f.root],synced=new Set<string>();let directorySyncs=0,started=false,released=false;
 const restore=handles(t,(file,_flags,handle)=>{if(expected.includes(file)){const sync=handle.sync.bind(handle);t.mock.method(handle,'sync',async()=>{await sync();synced.add(file);if(file===path.dirname(prepared.entries[0].destination))directorySyncs++;});}});
 const open=fs.open.bind(fs),unlink=fs.unlink.bind(fs);
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const handle=await open(...args);if(String(args[0])===prepared.entries[0].destination&&args[1]==='wx'){const write=handle.write.bind(handle);t.mock.method(handle,'write',async(...writeArgs:Parameters<typeof handle.write>)=>{assert.ok(expected.every(folder=>synced.has(folder)),'Intent and all new ancestor bindings must be synchronized before copying');assert.ok(directorySyncs>=1);started=true;return write(...writeArgs);});}return handle;});
 t.mock.method(fs,'unlink',async(file:Parameters<typeof fs.unlink>[0])=>{if(String(file).includes('photo-importer-intent-')){assert.ok(directorySyncs>=2,'Published destination must be synchronized before intent removal');assert.deepEqual(await fs.readFile(prepared.entries[0].destination),f.data);released=true;}await unlink(file);});syncBuiltinESMExports();
 const result=await execute(prepared,undefined,undefined,{exclusiveCopy:true});restore();
 assert.equal(started,true);assert.equal(released,true);assert.ok(directorySyncs>=3,'Intent removal directory entry must also be synchronized');assert.deepEqual(result,{copied:1,skipped:0,errors:[]});assert.deepEqual(await fs.readFile(path.join(f.source,'photo.JPG')),f.data);assert.equal(await fs.readFile(path.join(f.root,'keep.txt'),'utf8'),'pre-existing destination');
});

test('premature source EOF cannot pass verification merely because its file identity and size are unchanged',async t=>{
 const f=await fixture(t),prepared=await f.prepare();let streamed=0,injected=false;
 const restore=handles(t,(file,_flags,handle)=>{if(file!==f.original)return;const read=handle.read.bind(handle);t.mock.method(handle,'read',async(...args:Parameters<typeof handle.read>)=>{if(streamed>0&&!injected){injected=true;return {bytesRead:0,buffer:args[0]};}return read(...args);});});
 const result=await execute(prepared,undefined,progress=>{streamed=progress.bytes;});restore();
 assert.equal(injected,true);assert.ok(streamed>0);assert.equal(result.copied,0);assert.equal(result.errors.length,1);assert.match(result.errors[0],/Source changed/);assert.deepEqual(await visible(f.root),['keep.txt']);await f.unchanged();await f.retry();
});
