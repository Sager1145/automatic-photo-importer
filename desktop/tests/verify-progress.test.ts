import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {plan} from '../core/index';
import {executeDestinations} from '../core/destinations';
import type {Progress} from '../shared';

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
 const {plans}=await plan(source,[a,b],{backup:true,template:'{camera}',layout:'flat' as const,unknownRules:{}},async()=>({fields:{}}));
 const seen:Progress[]=[];
 await executeDestinations(plans,{signal:new AbortController().signal,reorganize:false,validate:async()=>{},settled:()=>{},progress:(_index,value)=>seen.push({...value})});
 checkVerifying(seen,12);
});

test('video-root: the photo and video plans of one destination do not reset the verifying counter',async t=>{
 const base=await temporary(t),source=path.join(base,'s'),photos=path.join(base,'photos'),videos=path.join(base,'videos');
 for(const folder of [source,photos,videos])await fs.mkdir(folder);
 for(let i=0;i<4;i++)await fs.writeFile(path.join(source,`P${i}.JPG`),Buffer.alloc(128*1024,i+1));
 for(let i=0;i<3;i++)await fs.writeFile(path.join(source,`V${i}.MOV`),Buffer.alloc(256*1024,i+9));
 const {plans}=await plan(source,[photos],{backup:false,template:'{camera}',layout:'video-root' as const,videoRoots:[videos],unknownRules:{}},async()=>({camera:'Cam',fields:{}}));
 const seen:Progress[]=[];
 await executeDestinations(plans,{signal:new AbortController().signal,reorganize:false,validate:async()=>{},settled:()=>{},progress:(_index,value)=>seen.push({...value})});
 checkVerifying(seen,7);
});
