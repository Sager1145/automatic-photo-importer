import test from 'node:test';
import assert from 'node:assert/strict';
import {orderSources,nextRunnable,moveToFront,queueOrder} from '../queue-order';

test('sources moved to the top come first, most recent move first, others keep their order',()=>{
 const sources=['a','b','c','d'].map(id=>({id}));
 let order:string[]=[];
 order=moveToFront(order,'c');order=moveToFront(order,'d');
 assert.deepEqual(orderSources(sources,order).map(item=>item.id),['d','c','a','b']);
 assert.deepEqual(orderSources(sources.filter(item=>item.id!=='d'),order).map(item=>item.id),['c','a','b'],'a disconnected source is skipped');
 assert.deepEqual(moveToFront(order,'c'),['c','d']);
});

const job=(id:string,source:string,phase='queued',organization=false)=>({id,phase,organization,source:{id:source}});

test('queued jobs start in card order: moved drives first, most recent move first, then the longest waiting',()=>{
 // state.jobs holds the newest job first.
 const jobs=[job('jc','c'),job('jrun','a','copying'),job('jb','b')];
 assert.deepEqual(queueOrder(jobs,[]),['jb','jc']);
 assert.equal(nextRunnable(jobs,[],()=>true)?.id,'jb');
 assert.deepEqual(queueOrder(jobs,['c']),['jc','jb'],'already queued, then moved');
 assert.equal(nextRunnable([job('x','x','complete')],[],()=>true),undefined);
});

test('a drive moved while idle or paused keeps its priority for the job it starts later',()=>{
 // A: B is queued, idle D is moved to the top, then imported.
 const a=[job('jd','d'),job('jb','b')];
 assert.deepEqual(queueOrder(a,['d']),['jd','jb']);
 // C: B is queued, paused C is moved to the top, then continued (a new job, the newest).
 const c=[job('jc2','c'),job('jc1','c','stopped'),job('jb','b')];
 assert.equal(nextRunnable(c,['c'],()=>true)?.id,'jc2');
});

test('organization jobs and drives never moved keep their oldest-first order after moved drives',()=>{
 const jobs=[job('jorg','library:/Volumes/A006/photobackup','queued',true),job('ja','a'),job('jb','b'),job('jold','c')];
 assert.deepEqual(queueOrder(jobs,['b','library:/Volumes/A006/photobackup']),['jb','jold','ja','jorg']);
});
