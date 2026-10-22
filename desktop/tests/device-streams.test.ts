import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {DeviceStreams,STREAMS,CHUNK,type DeviceKind} from '../core/devices';
import {plan,execute,configureOrganizationRecovery} from '../core';

// Receipts on, as the app runs: every staged copy then has one to remove.
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
import {dropDestinationIndexes} from '../core/destination-index';

async function folder(t:test.TestContext,name:string):Promise<string> {
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),name)));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 return base;
}
/** Peak number of `work` calls running at once through `streams`, on files of one device. */
async function peak(streams:DeviceStreams,files:string[]):Promise<number> {
 await streams.kind(files[0]!);
 let active=0,most=0;
 await Promise.all(files.map(file=>streams.run([file],async()=>{active++;most=Math.max(most,active);await new Promise(resolve=>setTimeout(resolve,15));active--;})));
 return most;
}

test('a spinning disk serves one whole-file stream at a time, however many jobs ask',async t=>{
 const base=await folder(t,'streams-hdd-'),files=Array.from({length:5},(_,index)=>path.join(base,`${index}.bin`));
 assert.equal(await peak(new DeviceStreams(async()=>'hdd'),files),1);
 // A file that does not exist yet (a copy's destination) counts on its folder's device.
 assert.equal(await peak(new DeviceStreams(async()=>'hdd'),[...files,path.join(base,'new','later.bin')]),1);
});

test('SSDs and SD cards stream several files at once, up to their own limit',async t=>{
 const base=await folder(t,'streams-flash-'),files=Array.from({length:8},(_,index)=>path.join(base,`${index}.bin`));
 for(const kind of ['ssd','card','unknown'] as DeviceKind[]) {
  const most=await peak(new DeviceStreams(async()=>kind),files);
  assert.equal(most,STREAMS[kind],`${kind} peak ${most}`);
 }
 assert.ok(STREAMS.ssd>STREAMS.card&&STREAMS.card>STREAMS.hdd);
});

test('a stream reads in the size suited to its device and frees its slot when it fails',async t=>{
 const base=await folder(t,'streams-chunk-'),file=path.join(base,'a.bin'),streams=new DeviceStreams(async()=>'hdd');
 await streams.kind(file);
 assert.equal(await streams.run([file],async chunk=>chunk),CHUNK.hdd);
 assert.ok(CHUNK.hdd>CHUNK.ssd);
 await assert.rejects(streams.run([file],async()=>{throw new Error('read failed');}),/read failed/);
 // The failed stream's slot is free again: this would wait forever otherwise.
 assert.equal(await streams.run([file],async()=>'next'),'next');
});

test('a slow classification never holds up the first streams, and its limit applies once known',async t=>{
 const base=await folder(t,'streams-slow-'),files=Array.from({length:6},(_,index)=>path.join(base,`${index}.bin`));
 let answer!:(kind:DeviceKind)=>void;const streams=new DeviceStreams(()=>new Promise(resolve=>{answer=resolve;}));
 // Not yet classified: the middle setting, without waiting.
 assert.equal(await peak2(streams,files),STREAMS.unknown);
 answer('hdd');await streams.kind(files[0]!);
 assert.equal(await peak2(streams,files),1);
});
/** Like peak, without waiting for the device to be classified first. */
async function peak2(streams:DeviceStreams,files:string[]):Promise<number> {
 let active=0,most=0;
 await Promise.all(files.map(file=>streams.run([file],async()=>{active++;most=Math.max(most,active);await new Promise(resolve=>setTimeout(resolve,15));active--;})));
 return most;
}

test('a device is classified once and every stream on it shares the answer',async t=>{
 const base=await folder(t,'streams-classify-');let asked=0;
 const streams=new DeviceStreams(async()=>{asked++;return 'ssd';});
 await Promise.all(Array.from({length:6},(_,index)=>streams.run([path.join(base,`${index}.bin`)],async()=>{})));
 assert.equal(asked,1);
});

const options={backup:true,template:'{camera}',layout:'flat' as const,unknownRules:{}};
const noMetadata=async()=>({fields:{}});

test('planning compares a library already at the destination several files at once',async t=>{
 const base=await folder(t,'plan-overlap-'),source=path.join(base,'card'),root=path.join(base,'library');
 await fs.mkdir(source);await fs.mkdir(root);
 for(let index=0;index<6;index++)await fs.writeFile(path.join(source,`IMG_${index}.JPG`),Buffer.alloc(512*1024,index+1));
 assert.equal((await execute((await plan(source,[root],options,noMetadata)).plans[0]!)).copied,6);
 // A new session: nothing is remembered, so both sides of every same-size pair are read.
 dropDestinationIndexes();
 let active=0,most=0;const open=fs.open.bind(fs);
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args);
  if(String(args[0]).startsWith(source+path.sep)){active++;most=Math.max(most,active);const close=handle.close.bind(handle);handle.close=async()=>{await new Promise(resolve=>setTimeout(resolve,10));active--;return close();};}
  return handle;
 });syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const {plans:[again]}=await plan(source,[root],options,noMetadata);
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.ok(again!.entries.every(entry=>entry.skip),'every file is recognised as already copied');
 assert.ok(most>1,`source files hashed at once: ${most}`);
});

test('independent files are published side by side, each still verified and synchronized',async t=>{
 const base=await folder(t,'publish-parallel-'),source=path.join(base,'card'),root=path.join(base,'library');
 await fs.mkdir(source);await fs.mkdir(root);
 for(let index=0;index<6;index++)await fs.writeFile(path.join(source,`IMG_${index}.JPG`),Buffer.alloc(256*1024,index+1));
 const reviewed=(await plan(source,[root],options,noMetadata)).plans[0]!;
 let active=0,most=0;const link=fs.link.bind(fs);
 t.mock.method(fs,'link',async(...args:Parameters<typeof fs.link>)=>{active++;most=Math.max(most,active);try{await new Promise(resolve=>setTimeout(resolve,20));return await link(...args);}finally{active--;}});
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const result=await execute(reviewed);
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.deepEqual(result,{copied:6,skipped:0,errors:[]});
 assert.ok(most>1,`publications at once: ${most}`);
 for(let index=0;index<6;index++)assert.deepEqual(await fs.readFile(path.join(root,`IMG_${index}.JPG`)),Buffer.alloc(256*1024,index+1));
 assert.deepEqual((await fs.readdir(root)).filter(name=>name.startsWith('.import-')),[]);
});

test('two files claiming one destination name at once never overwrite each other',async t=>{
 const base=await folder(t,'publish-race-'),root=path.join(base,'library');await fs.mkdir(root);
 const sources=[path.join(base,'a'),path.join(base,'b')];
 for(const [index,source] of sources.entries()){await fs.mkdir(source);await fs.writeFile(path.join(source,'IMG_0001.JPG'),Buffer.alloc(300*1024,index+1));}
 // Both reviews saw an empty library; their copies then run at the same time.
 const reviews=await Promise.all(sources.map(async source=>(await plan(source,[root],options,noMetadata)).plans[0]!));
 const results=await Promise.all(reviews.map(review=>execute(review)));
 assert.equal(results.reduce((sum,result)=>sum+result.copied,0),2);
 assert.deepEqual(results.flatMap(result=>result.errors),[]);
 // One keeps the name; the other, different content, goes to a conflict folder beside it.
 const kept=await fs.readFile(path.join(root,'IMG_0001.JPG')),conflicts=await fs.readdir(path.join(root,'Conflicts'));
 assert.equal(conflicts.length,1);
 const other=await fs.readFile(path.join(root,'Conflicts',conflicts[0]!,'IMG_0001.JPG'));
 assert.deepEqual(new Set([kept[0],other[0]]),new Set([1,2]));
});

test('Stop ends a wait for a busy disk at once and leaves the slot to the others',async t=>{
 const base=await folder(t,'streams-stop-'),file=path.join(base,'a.bin'),streams=new DeviceStreams(async()=>'hdd');
 await streams.kind(file);
 let finish!:()=>void;const busy=streams.run([file],()=>new Promise<void>(resolve=>{finish=resolve;}));
 await new Promise(resolve=>setTimeout(resolve,5));
 const control=new AbortController(),started=performance.now(),waiting=streams.run([file],async()=>'should not run',control.signal);
 control.abort();
 await assert.rejects(waiting,{name:'AbortError'});
 assert.ok(performance.now()-started<100,'the stopped wait returns without waiting for the busy stream');
 finish();await busy;
 assert.equal(await streams.run([file],async()=>'next'),'next');
});

test('stopping during verification removes every staged copy and syncs their folder once, not once per file',async t=>{
 const base=await folder(t,'stop-verify-'),source=path.join(base,'card'),root=path.join(base,'library');
 await fs.mkdir(source);await fs.mkdir(root);
 for(let index=0;index<24;index++)await fs.writeFile(path.join(source,`IMG_${index}.JPG`),Buffer.alloc(64*1024,index+1));
 const reviewed=(await plan(source,[root],options,noMetadata)).plans[0]!,control=new AbortController();
 let stopped=false,syncsAfterStop=0;const open=fs.open.bind(fs);
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args);
  if(String(args[0])===root){const sync=handle.sync.bind(handle);handle.sync=async()=>{if(stopped)syncsAfterStop++;return sync();};}
  return handle;
 });syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 await assert.rejects(execute(reviewed,control.signal,progress=>{if(progress.phase==='verifying'&&!stopped){stopped=true;control.abort();}}),{name:'AbortError'});
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.ok(stopped);
 assert.deepEqual((await fs.readdir(root)).filter(name=>name.startsWith('.import-')),[],'no staged copy or receipt is left behind');
 assert.ok(syncsAfterStop<=2,`folder synced ${syncsAfterStop} times while stopping`);
});
