import test from 'node:test';
import assert from 'node:assert/strict';
import {deferredRefresh} from '../deferred-refresh';

test('a listing requested while planning waits until planning ends',async()=>{
 let planning=true,runs=0;
 const refresh=deferredRefresh({planning:()=>planning,run:async()=>{runs++;}});
 assert.equal(refresh.request(),false);assert.equal(runs,0);assert.equal(refresh.deferred,true);
 refresh.resume();assert.equal(runs,0,'still planning');
 planning=false;refresh.resume();
 assert.equal(runs,1);
 await new Promise(resolve=>setImmediate(resolve));
 refresh.resume();assert.equal(runs,1,'a deferred request runs once');
});

test('one listing at a time, and a failing listing does not block the next',async()=>{
 let runs=0,release=()=>{};
 const refresh=deferredRefresh({planning:()=>false,run:()=>{runs++;return new Promise<void>((_,reject)=>{release=()=>reject(new Error('x'));});}});
 assert.equal(refresh.request(),true);assert.equal(refresh.request(),false);assert.equal(runs,1);
 release();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(refresh.running,false);assert.equal(refresh.request(),true);assert.equal(runs,2);
});

test('with nothing planning a request starts at once',()=>{
 let runs=0;
 const refresh=deferredRefresh({planning:()=>false,run:async()=>{runs++;}});
 assert.equal(refresh.request(),true);assert.equal(runs,1);
});
