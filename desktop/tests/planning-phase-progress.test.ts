import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {plan,execute,configureOrganizationRecovery} from '../core/index';
import {dropDestinationIndexes,indexTarget} from '../core/destination-index';
import type {PlanProgress} from '../core/index';

// "Everything must update": the phases of planning that used to report nothing now count their own work.
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const base={backup:true as const,template:'{year}',layout:'flat' as const,unknownRules:{}};
const noMetadata=async()=>{throw new Error('Backup must not read metadata');};
type Call={count:number;file:string;detail?:Parameters<PlanProgress>[2]};
async function fixture(t:test.TestContext,count=12){
 const folder=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'planning-phases-')));
 t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const source=path.join(folder,'source'),root=path.join(folder,'destination');
 await fs.mkdir(source);await fs.mkdir(root);
 for(let index=0;index<count;index++)await fs.writeFile(path.join(source,`F${index}.JPG`),'bytes '+index);
 return {source,root};
}
const record=(calls:Call[]):PlanProgress=>(count,file,detail)=>{calls.push({count,file,detail});};

test('the planner counts "Preparing destinations" file by file up to the total',async t=>{
 const {source,root}=await fixture(t);
 const calls:Call[]=[];
 await plan(source,[root],{...base},noMetadata,undefined,record(calls));
 const preparing=calls.filter(call=>call.detail?.step==='preparing');
 assert.ok(preparing.length>=12,'one report per file');
 assert.equal(preparing[0]!.count,0);
 assert.equal(preparing.at(-1)!.count,12);assert.equal(preparing.at(-1)!.detail!.total,12);
 for(let index=1;index<preparing.length;index++)assert.ok(preparing[index]!.count>=preparing[index-1]!.count);
});

test('a drive backup also counts the comparison of the backup with the drive',async t=>{
 const {source,root}=await fixture(t,6);
 const drive={name:'Card',identity:'mine',mirror:true};
 await execute((await plan(source,[root],{...base,drive},noMetadata)).plans[0]!);
 const calls:Call[]=[];
 await plan(source,[root],{...base,drive},noMetadata,undefined,record(calls));
 const mirroring=calls.filter(call=>call.detail?.step==='mirroring');
 assert.ok(mirroring.length>=6,'reported while the drive folder is walked');
 assert.equal(mirroring.at(-1)!.count,6);assert.equal(mirroring.at(-1)!.detail!.total,6);
});

test('loading a destination index reports the bytes read, up to its size',async t=>{
 const {source,root}=await fixture(t,40);
 await execute((await plan(source,[root],{...base},noMetadata)).plans[0]!);
 await t.test('index file exists',async()=>assert.ok((await fs.lstat(await indexTarget(root,'index.json'))).isFile()));
 dropDestinationIndexes();
 const calls:Call[]=[];
 await plan(source,[root],{...base},noMetadata,undefined,record(calls));
 const loading=calls.filter(call=>call.detail?.step==='index');
 assert.ok(loading.length>=2,'the start and the end of the read');
 const last=loading.at(-1)!.detail!;assert.ok(last.totalBytes>0);assert.equal(last.bytes,last.totalBytes);
});
