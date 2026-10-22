import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {classifyMounted,getSources,type MountedVolume} from '../platform/volumes';
import {closeCameraBridge} from '../platform/camera-bridge';
import {stopScanChild,type ScanChild} from '../scan-stop';

test.after(()=>closeCameraBridge());
const card:MountedVolume={path:'/Volumes/CARD',name:'CARD',volumeId:'uuid-card',external:true,removable:true};
const backup:MountedVolume={path:'/Volumes/BACKUP',name:'BACKUP',volumeId:'uuid-backup',external:true,removable:true};

test('a mounted card is listed once per mount fingerprint, not on every refresh',async()=>{
 const cache=new Map(),calls:string[]=[];let print='a';
 const deps={cache,list:async(volume:MountedVolume)=>{calls.push(volume.path);return ['DCIM'];},fingerprint:async()=>print};
 for(let round=0;round<4;round++){
  await getSources([card],deps);
 }
 assert.deepEqual(calls,['/Volumes/CARD']);
 // The same mount path with a different filesystem is listed again.
 print='b';await classifyMounted(card,deps);
 assert.equal(calls.length,2);
 // A failed listing is not remembered.
 const failing={...deps,cache:new Map(),list:async()=>{calls.push('fail');throw new Error('timeout');}};
 assert.equal((await classifyMounted(card,failing)).layoutUnavailable,true);
 await classifyMounted(card,failing);
 assert.equal(calls.filter(call=>call==='fail').length,2);
});

test('an unmounted card is forgotten, so reinserting it lists it again',async()=>{
 const cache=new Map(),calls:string[]=[];
 const deps={cache,list:async(volume:MountedVolume)=>{calls.push(volume.path);return ['DCIM'];},fingerprint:async()=>'same'};
 await getSources([card],deps);await getSources([],deps);await getSources([card],deps);
 assert.equal(calls.length,2);
});

test('destination drives are never listed',async()=>{
 const calls:string[]=[];
 const deps={cache:new Map(),list:async(volume:MountedVolume)=>{calls.push(volume.path);return ['DCIM'];},fingerprint:async()=>'x'};
 await getSources([card,backup],{...deps,destinations:[{path:'/Volumes/BACKUP/Photos',volumeId:'uuid-backup'}]});
 assert.deepEqual(calls,['/Volumes/CARD']);
 calls.length=0;
 await getSources([backup],{...deps,cache:new Map(),destinations:[{path:'/Volumes/BACKUP',volumeId:undefined}]});
 assert.deepEqual(calls,[]);
});

/** A stand-in for a utility process: exits when told, after a delay, or only when killed. */
function fakeChild(behaviour:{exitOnStop?:number;exitOnKill?:boolean}) {
 const events=new EventEmitter(),log:string[]=[];let exit:()=>void=()=>{};
 const exited=new Promise<void>(resolve=>{exit=resolve;});
 const child:ScanChild&{pid?:number}={pid:4242,
  postMessage:message=>{log.push(`message:${(message as {type:string}).type}`);if(behaviour.exitOnStop!==undefined)setTimeout(()=>{log.push('exit');exit();},behaviour.exitOnStop);},
  kill:()=>{log.push('kill');if(behaviour.exitOnKill){log.push('exit');exit();}return true;},
  once:(event,listener)=>events.once(event,listener)};
 return {child,exited,log};
}

test('a scan process that stops when asked is never killed, and the stop waits for its exit',async()=>{
 const {child,exited,log}=fakeChild({exitOnStop:20});
 const killed:number[]=[];
 await stopScanChild(child,exited,{graceMs:200,killMs:50,sigkill:pid=>killed.push(pid)});
 assert.deepEqual(log,['message:stop','exit']);
 assert.deepEqual(killed,[]);
});

test('a scan process that ignores stop is killed after the grace period, then forced',async()=>{
 const {child,exited,log}=fakeChild({});
 const killed:number[]=[];
 const stopped=stopScanChild(child,exited,{graceMs:30,killMs:30,sigkill:pid=>killed.push(pid)});
 await new Promise(resolve=>setTimeout(resolve,150));
 assert.deepEqual(log,['message:stop','kill']);
 assert.deepEqual(killed,[4242]);
 // It resolves only once the process has actually exited.
 let done=false;void stopped.then(()=>{done=true;});
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(done,false);
 const {child:next,exited:nextExited,log:nextLog}=fakeChild({exitOnKill:true});
 await stopScanChild(next,nextExited,{graceMs:10,killMs:500,sigkill:pid=>killed.push(pid)});
 assert.deepEqual(nextLog,['message:stop','kill','exit']);
 assert.deepEqual(killed,[4242]);
});
