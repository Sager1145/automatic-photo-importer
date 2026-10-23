import test from 'node:test';
import assert from 'node:assert/strict';
import {DisplayHold,bucketLowerEdge,bucketSeconds,remainingBucket,remainingRange} from '../eta-format';

test('buckets match the wording formatRemaining has always used',()=>{
 assert.deepEqual(remainingBucket(20),{unit:'under'});
 assert.deepEqual(remainingBucket(7*60+20),{unit:'min',minutes:7});
 assert.deepEqual(remainingBucket(43*60),{unit:'min',minutes:45});
 assert.deepEqual(remainingBucket(59*60),{unit:'h',hours:1});
 assert.deepEqual(remainingBucket(2*3600+14*60),{unit:'hm',hours:2,minutes:15});
 assert.deepEqual(remainingBucket(14.4*3600),{unit:'h',hours:14});
 assert.deepEqual(remainingBucket(Number.NaN),{unit:'under'});
});

test('a bucket has a lower edge: the smallest time that reads the same',()=>{
 for(const seconds of [61,100,7*60+20,12*60,43*60,59*60,2*3600+14*60,14.4*3600]){
  const edge=bucketLowerEdge(seconds);
  assert.equal(bucketSeconds(edge),bucketSeconds(seconds));
  assert.notEqual(bucketSeconds(edge-0.01),bucketSeconds(seconds));
  assert.ok(edge<=seconds);
 }
 assert.equal(bucketLowerEdge(10),0);
});

test('the shown value changes at most every 5 seconds and not for small moves',()=>{
 const hold=new DisplayHold();
 assert.equal(hold.next(3600,0),3600);
 for(let t=1;t<=60;t++)assert.equal(hold.next(3600-t*0.3+(t%2?20:-20),t*1000),3600);
});

test('it goes down only after 5 s below the bucket edge, or at once below half',()=>{
 const hold=new DisplayHold();
 hold.next(3600,0);
 const edge=bucketLowerEdge(3600);
 assert.equal(hold.next(edge-30,10_000),3600);
 assert.equal(hold.next(edge-30,14_000),3600);
 assert.equal(hold.next(edge-30,15_000),bucketSeconds(edge-30));
 const fast=new DisplayHold();
 fast.next(3600,0);
 assert.equal(fast.next(1700,6000),bucketSeconds(1700));
 const brief=new DisplayHold();
 brief.next(3600,0);
 brief.next(edge-30,10_000);
 brief.next(3600,12_000);
 assert.equal(brief.next(edge-30,16_000),3600,'the dwell restarts when the value comes back');
});

test('it goes up only after 20 s at 1.15x and +60 s, and once a minute',()=>{
 const hold=new DisplayHold();
 hold.next(1800,0);
 assert.equal(hold.next(1800*1.1,10_000),1800);
 assert.equal(hold.next(1800*1.1,40_000),1800,'below 1.15x never rises');
 assert.equal(hold.next(1800*1.3,41_000),1800);
 assert.equal(hold.next(1800*1.3,60_000),1800);
 assert.equal(hold.next(1800*1.3,61_000),bucketSeconds(1800*1.3));
 const shown=hold.value!;
 assert.equal(hold.next(shown*1.5,70_000),shown);
 assert.equal(hold.next(shown*1.5,95_000),shown,'a second rise waits for a minute since the first');
 assert.ok(hold.next(shown*1.5,125_000)!>shown);
 const small=new DisplayHold();
 small.next(100,0);
 assert.equal(small.next(150,30_000),bucketSeconds(100),'1.5x but only +50 s');
});

test('no value resets the hold',()=>{
 const hold=new DisplayHold();
 hold.next(3600,0);
 assert.equal(hold.next(undefined,1000),undefined);
 assert.equal(hold.next(900,2000),900);
});

test('a range appears only while wide and long enough',()=>{
 assert.deepEqual(remainingRange(3*3600,2*3600,4*3600),{unit:'h',low:2,high:4});
 assert.deepEqual(remainingRange(30*60,20*60,40*60),{unit:'min',low:20,high:40});
 assert.equal(remainingRange(30*60,25*60,35*60),undefined,'narrow');
 assert.equal(remainingRange(9*60,4*60,14*60),undefined,'under 10 min');
 assert.equal(remainingRange(3600,0,100),undefined);
});
