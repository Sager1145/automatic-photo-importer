import test from 'node:test';
import assert from 'node:assert/strict';
import {rememberVolumes,singleFlight,type MountedVolume} from '../platform/volumes';

const known:MountedVolume={path:'/',name:'Macintosh HD',volumeId:'A551DA84-858E-4A31-A7FA-16BD0FCEC7CE',physicalId:'disk3'};
const failed=(reason='diskutil timed out'):PromiseSettledResult<MountedVolume>=>({status:'rejected',reason:new Error(reason)});

test('a transient diskutil failure keeps the identity of the same mounted filesystem',()=>{
 const memory=new Map();
 assert.deepEqual(rememberVolumes(['/'],[{status:'fulfilled',value:known}],['fs-a'],memory),[known]);
 assert.deepEqual(rememberVolumes(['/'],[failed()],['fs-a'],memory),[known]);
});

test('a different filesystem at the same mount never inherits the remembered identity',()=>{
 const memory=new Map();
 rememberVolumes(['/Volumes/Backup'],[{status:'fulfilled',value:{...known,path:'/Volumes/Backup'}}],['fs-a'],memory);
 assert.deepEqual(rememberVolumes(['/Volumes/Backup'],[failed()],['fs-b'],memory),[{path:'/Volumes/Backup',name:'Backup'}]);
 assert.deepEqual(rememberVolumes(['/Volumes/Backup'],[failed()],[undefined],memory),[{path:'/Volumes/Backup',name:'Backup'}]);
});

test('concurrent volume lookups share one in-flight sweep and later lookups start fresh',async()=>{
 let calls=0,release!:(value:string)=>void;
 const shared=singleFlight(()=>{calls++;return new Promise<string>(resolve=>{release=resolve;});});
 const first=shared(),second=shared(),third=shared();
 assert.equal(calls,1);
 release('volumes');
 assert.deepEqual(await Promise.all([first,second,third]),['volumes','volumes','volumes']);
 const later=shared();assert.equal(calls,2);release('again');assert.equal(await later,'again');
 const failing=singleFlight(async()=>{calls++;throw new Error('diskutil failed');});
 await assert.rejects(failing(),/diskutil failed/);await assert.rejects(failing(),/diskutil failed/);
 assert.equal(calls,4,'a failure is not cached');
});
