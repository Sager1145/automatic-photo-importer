import test from 'node:test';
import assert from 'node:assert/strict';
import {createDetailStore} from '../renderer/duplicate-details';
import type {Metadata,Thumbnail} from '../shared';

/** A reader whose every read waits until the test settles it. */
function controlled(){
 const reads:{part:'thumbnail'|'exif';root:string;path:string;resolve:(value:unknown)=>void;reject:(error:Error)=>void}[]=[];
 const read=(part:'thumbnail'|'exif')=>(root:string,path:string)=>new Promise<never>((resolve,reject)=>{reads.push({part,root,path,resolve:resolve as (value:unknown)=>void,reject});});
 const store=createDetailStore({thumbnail:read('thumbnail'),exif:read('exif')});
 const pending=(root:string,path:string)=>reads.filter(entry=>entry.root===root&&entry.path===path);
 /** Settles both reads of a file with values derived from its root and path. */
 const finish=async(root:string,path:string)=>{
  for(const entry of pending(root,path))entry.resolve(entry.part==='thumbnail'?thumb(root,path):meta(root,path));
  reads.splice(0,reads.length,...reads.filter(entry=>!(entry.root===root&&entry.path===path)));
  await flush();
 };
 return {store,reads,finish,pending};
}
const thumb=(root:string,path:string):Thumbnail=>({src:`data:${root}/${path}`,via:'system'});
const meta=(root:string,path:string):Metadata=>({camera:`${root}/${path}`,fields:{}});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const started=(reads:{root:string;path:string}[])=>[...new Set(reads.map(entry=>`${entry.root}:${entry.path}`))];

test('at most three files are read at once, two reads per file, the rest wait their turn',async()=>{
 const {store,reads,finish}=controlled();
 store.show('/a',1,['1','2','3','4','5']);
 assert.equal(reads.length,6);assert.deepEqual(started(reads),['/a:1','/a:2','/a:3']);
 await finish('/a','1');
 assert.deepEqual(started(reads),['/a:2','/a:3','/a:4']);
 assert.deepEqual(store.view('/a',1)['1'],{thumbnail:{value:thumb('/a','1')},exif:{value:meta('/a','1')}});
});

test('paging A → B → A reuses what page A loaded and keeps reads already under way',async()=>{
 const {store,reads,finish}=controlled();
 const pageA=['a1','a2','a3','a4','a5'];
 const leaveA=store.show('/a',1,pageA);
 await finish('/a','a1');
 leaveA();
 // a2, a3 and a4 are still being read and still count against the cap; a5 was only waiting and is dropped.
 const leaveB=store.show('/a',1,['b1','b2']);
 assert.deepEqual(started(reads),['/a:a2','/a:a3','/a:a4']);
 await finish('/a','a4');
 assert.deepEqual(started(reads),['/a:a2','/a:a3','/a:b1']);
 leaveB();
 store.show('/a',1,pageA);
 assert.deepEqual(started(reads),['/a:a2','/a:a3','/a:b1'],'back on page A nothing new starts while three files are read');
 await finish('/a','a2');
 assert.ok(store.view('/a',1).a2?.thumbnail,'a read that outlived its page still lands');
 assert.deepEqual(started(reads),['/a:a3','/a:b1','/a:a5'],'only the dropped file is read again');
 assert.ok(store.view('/a',1).a4?.exif);
});

test('the same path under another root or revision is a different file: nothing of the old generation shows',async()=>{
 const {store,reads,finish}=controlled();
 store.show('/a',1,['x.NEF']);await finish('/a','x.NEF');
 assert.ok(store.view('/a',1)['x.NEF']);
 assert.deepEqual(store.view('/b',1),{},'a new root shows nothing before it is loaded');
 assert.deepEqual(store.view('/a',2),{},'a new revision shows nothing before it is loaded');
 store.show('/b',1,['x.NEF']);
 assert.deepEqual(started(reads),['/b:x.NEF']);
 await finish('/b','x.NEF');
 assert.deepEqual(store.view('/b',1)['x.NEF'],{thumbnail:{value:thumb('/b','x.NEF')},exif:{value:meta('/b','x.NEF')}});
});

test('a late result of an old generation never lands in the new one, and its end never clears the new read',async()=>{
 const {store,reads,finish}=controlled();
 store.show('/a',1,['x']);
 store.show('/a',2,['x']);
 assert.equal(reads.filter(entry=>entry.path==='x').length,4,'the new revision reads x itself');
 // Settle only the revision-1 reads (the first two).
 reads[0]!.resolve(thumb('/a','old'));reads[1]!.resolve(meta('/a','old'));reads.splice(0,2);await flush();
 assert.deepEqual(store.view('/a',2),{});assert.deepEqual(store.view('/a',1),{});
 const total=reads.length;
 store.show('/a',2,['x']);
 assert.equal(reads.length,total,'x is still in flight for revision 2');
 await finish('/a','x');
 assert.equal((store.view('/a',2).x?.thumbnail as {value:Thumbnail}).value.src,'data:/a/x');
});

test('StrictMode setup, cleanup, setup reads each file once',async()=>{
 const {store,reads,finish}=controlled();
 const cleanup=store.show('/a',1,['1','2','3','4']);cleanup();
 store.show('/a',1,['1','2','3','4']);
 assert.equal(reads.length,6);assert.deepEqual(started(reads),['/a:1','/a:2','/a:3']);
 await finish('/a','1');
 assert.deepEqual(started(reads),['/a:2','/a:3','/a:4']);
 assert.equal(reads.length,6);
});

test('after unmount no new reads start and late results reach no listener',async()=>{
 const {store,reads,finish}=controlled();
 let calls=0;const unsubscribe=store.subscribe(()=>{calls++;});
 const release=store.show('/a',1,['1','2','3','4']);
 release();unsubscribe();
 await finish('/a','1');await finish('/a','2');await finish('/a','3');
 assert.equal(calls,0);assert.equal(reads.length,0,'file 4 was never read');
});

test('a failed read is recorded as an error for its own half, not retried by itself, and Retry reads only that half',async()=>{
 const {store,reads,finish,pending}=controlled();
 let calls=0;store.subscribe(()=>{calls++;});
 store.show('/a',1,['x','y']);
 const [thumbRead,exifRead]=pending('/a','x');
 thumbRead!.reject(new Error('busy'));exifRead!.resolve(meta('/a','x'));
 reads.splice(0,2);await flush();await finish('/a','y');
 assert.ok(calls>0);
 assert.deepEqual(store.view('/a',1).x,{thumbnail:{error:'busy'},exif:{value:meta('/a','x')}});
 store.show('/a',1,['x','y']);
 assert.equal(reads.length,0,'showing the page again does not retry by itself');
 store.retry('/a',1,'x');
 assert.deepEqual(reads.map(entry=>entry.part),['thumbnail']);
 assert.deepEqual(store.view('/a',1).x,{exif:{value:meta('/a','x')}},'the failed half shows as loading again');
 store.retry('/a',1,'x');assert.equal(reads.length,1,'a second Retry while reading adds nothing');
 await finish('/a','x');
 assert.deepEqual(store.view('/a',1).x,{thumbnail:{value:thumb('/a','x')},exif:{value:meta('/a','x')}});
 store.retry('/a',1,'y');assert.equal(reads.length,0,'nothing to retry for a file that loaded');
});
