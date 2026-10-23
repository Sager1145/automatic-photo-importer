import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {plan,execute} from '../core/index';
import {executeDestinations} from '../core/destinations';
import type {Progress} from '../shared';
import {configureOrganizationRecovery} from '../core/index';
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');

const temporary=async(t:test.TestContext)=>{const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'verify-progress-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));return base;};

/** The verifying counter of a job with several pieces counts only verified files: it starts at 0, never decreases and ends at the total. */
function checkVerifying(seen:Progress[],total:number){
 const verifying=seen.filter(value=>value.phase==='verifying'&&!value.step);
 assert.ok(verifying.length>0);
 assert.equal(verifying[0]!.completed,0);
 for(let i=1;i<verifying.length;i++)assert.ok(verifying[i]!.completed>=verifying[i-1]!.completed,`completed went back: ${verifying[i-1]!.completed} -> ${verifying[i]!.completed}`);
 assert.equal(verifying.at(-1)!.completed,total);
 assert.ok(verifying.every(value=>value.total===total));
}

test('two destinations: the verifying counter starts at 0 and never decreases',async t=>{
 const base=await temporary(t),source=path.join(base,'s'),a=path.join(base,'a'),b=path.join(base,'b');
 for(const folder of [source,a,b])await fs.mkdir(folder);
 for(let i=0;i<6;i++)await fs.writeFile(path.join(source,`f${i}.bin`),Buffer.alloc(256*1024,i+1));
 const {plans}=await plan(source,[a,b],{backup:true,unknownRules:{}},async()=>({fields:{}}));
 const seen:Progress[]=[];
 await executeDestinations(plans,{signal:new AbortController().signal,reorganize:false,validate:async()=>{},settled:()=>{},progress:(_index,value)=>seen.push({...value})});
 checkVerifying(seen,12);
});

test('video-root: the photo and video plans of one destination do not reset the verifying counter',async t=>{
 const base=await temporary(t),source=path.join(base,'s'),photos=path.join(base,'photos'),videos=path.join(base,'videos');
 for(const folder of [source,photos,videos])await fs.mkdir(folder);
 for(let i=0;i<4;i++)await fs.writeFile(path.join(source,`P${i}.JPG`),Buffer.alloc(128*1024,i+1));
 for(let i=0;i<3;i++)await fs.writeFile(path.join(source,`V${i}.MOV`),Buffer.alloc(256*1024,i+9));
 const {plans}=await plan(source,[photos],{backup:false as const,template:'{camera}',layout:'video-root' as const,videoRoots:[videos],unknownRules:{}},async()=>({camera:'Cam',fields:{}}));
 const seen:Progress[]=[];
 await executeDestinations(plans,{signal:new AbortController().signal,reorganize:false,validate:async()=>{},settled:()=>{},progress:(_index,value)=>seen.push({...value})});
 checkVerifying(seen,7);
});

const options={backup:true as const,unknownRules:{}};
const metadata=async()=>({fields:{}});
async function run(source:string,root:string){
 const {plans}=await plan(source,[root],options,metadata),seen:Progress[]=[];
 await execute(plans[0]!,undefined,value=>seen.push({...value}));
 return seen.filter(value=>value.phase==='verifying'&&!value.step);
}

test('verify work counts the staged bytes published; files already in the backup add files only',async t=>{
 const base=await temporary(t),source=path.join(base,'s'),root=path.join(base,'r');
 await fs.mkdir(source);await fs.mkdir(root);
 for(let i=0;i<4;i++)await fs.writeFile(path.join(source,`a${i}.bin`),Buffer.alloc(1000*(i+1),i+1));
 const first=await run(source,root);
 assert.equal(first[0]!.work!.bytes,0);
 assert.equal(first.at(-1)!.work!.bytes,10000);
 assert.equal(first.at(-1)!.work!.totalBytes,10000);
 assert.equal(first.at(-1)!.work!.totalFiles,4);
 assert.equal(first.at(-1)!.work!.publishCopy,undefined,'a same-volume link is not a copy');
 await fs.writeFile(path.join(source,'new0.bin'),Buffer.alloc(300,9));await fs.writeFile(path.join(source,'new1.bin'),Buffer.alloc(200,8));
 const second=await run(source,root);
 const last=second.at(-1)!.work!;
 assert.equal(last.totalFiles,6);
 assert.equal(last.files,6);
 assert.equal(last.totalBytes,500,'only the two new files were staged');
 assert.equal(last.bytes,500);
 assert.equal(second[0]!.work!.bytes,0);
});

test('publishing by copying (a file system without hard links) is reported',async t=>{
 const base=await temporary(t),source=path.join(base,'s'),root=path.join(base,'r');
 await fs.mkdir(source);await fs.mkdir(root);
 for(let i=0;i<3;i++)await fs.writeFile(path.join(source,`a${i}.bin`),Buffer.alloc(2000,i+1));
 t.mock.method(fs,'link',async()=>{throw Object.assign(new Error('not permitted'),{code:'EPERM'});});
 syncBuiltinESMExports();
 const verifying=await run(source,root);
 assert.equal(verifying.at(-1)!.work!.publishCopy,true);
 assert.equal(verifying.at(-1)!.work!.bytes,6000);
});
