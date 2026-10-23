import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {raiseThreadpool,THREADPOOL_SIZE} from '../threadpool';

test('raiseThreadpool lifts a missing or smaller size and keeps a larger one',()=>{
 const env:NodeJS.ProcessEnv={};raiseThreadpool(env);assert.equal(env.UV_THREADPOOL_SIZE,String(THREADPOOL_SIZE));
 env.UV_THREADPOOL_SIZE='4';raiseThreadpool(env);assert.equal(env.UV_THREADPOOL_SIZE,String(THREADPOOL_SIZE));
 env.UV_THREADPOOL_SIZE='32';raiseThreadpool(env);assert.equal(env.UV_THREADPOOL_SIZE,'32');
});
// The probe itself, so the in-app QA check (codex-smoke) can be trusted: it must tell 4 threads from 16.
test('the pool probe tells the default pool of 4 from a pool of 16',{skip:process.platform==='win32'},()=>{
 const probe=path.join(import.meta.dirname,'../qa/thread-pool.ts');
 const run=(size:string|undefined)=>execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',
  `const {threadpoolExceeds}=await import(${JSON.stringify(probe)});console.log(JSON.stringify([await threadpoolExceeds(4),await threadpoolExceeds(15)]));`],
  {env:{...process.env,UV_THREADPOOL_SIZE:size},encoding:'utf8',cwd:path.join(import.meta.dirname,'../..')}).trim().split('\n').pop();
 assert.equal(run(undefined),'[false,false]');
 assert.equal(run('16'),'[true,true]');
});
