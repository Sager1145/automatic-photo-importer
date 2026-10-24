import test from 'node:test';
import assert from 'node:assert/strict';
import {misplacedScope,staleMisplaced,touchedMisplaced} from '../misplaced-results';
import {defaultPreferences} from '../preferences';
import type {DestinationStatus,MisplacedFiles,Preferences} from '../shared';

const prefs:Preferences={...defaultPreferences,destinations:['/Volumes/A','/Volumes/B'],destinationIds:['a','b']};
const status=(path:string,id:string,available=true)=>({path,available,volumeId:id}) as DestinationStatus;
const infos=[status('/Volumes/A','a'),status('/Volumes/B','b')];
const result=(index:number,p=prefs,s=infos):MisplacedFiles=>({count:2,bytes:10,checkedAt:'2026-10-23T10:00:00Z',scope:misplacedScope(p,index,s)});

test('a result stays while the folder rules, destination and drive are the ones it was computed for',()=>{
  const results={'/Volumes/A':result(0),'/Volumes/B':result(1)};
  assert.deepEqual(staleMisplaced(results,prefs,infos),[]);
});

test('a result goes stale when the rules, the drive or the destination change, and only for the destination concerned',()=>{
  const results={'/Volumes/A':result(0),'/Volumes/B':result(1)};
  assert.deepEqual(staleMisplaced(results,{...prefs,template:'{year}'},infos).sort(),['/Volumes/A','/Volumes/B']);
  assert.deepEqual(staleMisplaced(results,prefs,[status('/Volumes/A','a',false),infos[1]!]),['/Volumes/A']);
  assert.deepEqual(staleMisplaced(results,prefs,[status('/Volumes/A','other'),infos[1]!]),['/Volumes/A']);
  assert.deepEqual(staleMisplaced(results,{...prefs,destinations:['/Volumes/B']},infos).sort(),['/Volumes/A','/Volumes/B']);
  assert.deepEqual(staleMisplaced({'/Volumes/A':{count:1,bytes:1,checkedAt:'x'}},prefs,infos),['/Volumes/A'],'a result with no scope cannot be trusted');
});

test('a job that wrote to a backup folder invalidates that destination only',()=>{
  const results={'/Volumes/A':result(0),'/Volumes/B':result(1)};
  assert.deepEqual(touchedMisplaced(results,['/Volumes/A/photobackup']),['/Volumes/A']);
  assert.deepEqual(touchedMisplaced(results,['/Volumes/B','/Volumes/elsewhere/x']),['/Volumes/B']);
  assert.deepEqual(touchedMisplaced(results,[]),[]);
});
