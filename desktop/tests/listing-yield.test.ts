import test from 'node:test';
import assert from 'node:assert/strict';
import {deferredRefresh} from '../deferred-refresh';

test('a refresh that gives way to planning stays deferred, stops its run and starts again once nothing plans',async()=>{
 let planning=false,runs=0,stopped=0;
 const refresh=deferredRefresh({planning:()=>planning,run:signal=>new Promise<void>(resolve=>{runs++;signal.addEventListener('abort',()=>{stopped++;resolve();},{once:true});})});
 assert.equal(refresh.request(),true);assert.equal(runs,1);
 planning=true;refresh.pause();
 assert.equal(stopped,1);assert.equal(refresh.deferred,true);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(refresh.running,false);
 refresh.resume();assert.equal(runs,1,'not while a job plans');
 planning=false;refresh.resume();assert.equal(runs,2,'resumes once nothing plans');
 refresh.pause();refresh.pause();assert.equal(stopped,2,'pausing twice stops the run once');
});
