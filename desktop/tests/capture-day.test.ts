import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {plan} from '../core/index';
import {captureTimestamp} from '../capture-time';
import {formatCaptureDateTime} from '../renderer/metadata-display';

const options={backup:false as const,template:'{year}/{yyyyMMdd}',layout:'flat' as const,unknownRules:{}};
async function folderFor(t:test.TestContext,date:string):Promise<string> {
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'capture-day-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'card'),root=path.join(base,'library');await fs.mkdir(source);await fs.mkdir(root);await fs.writeFile(path.join(source,'A.JPG'),'bytes');
 const {plans:[transfer]}=await plan(source,[root],options,async()=>({date,camera:'Camera',fields:{}}));
 return path.relative(root,path.dirname(transfer!.entries[0]!.destination));
}

test('an offset-less capture keeps one calendar day in its folder, its file timestamp and its display',async t=>{
 const previous=process.env.TZ;t.after(()=>{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;});
 // Fourteen hours ahead of UTC: any UTC reading of this wall clock lands on the day before.
 process.env.TZ='Pacific/Kiritimati';
 const date='2024-03-01T00:30:00';
 assert.equal(await folderFor(t,date),path.join('2024','20240301'));
 const local=new Date(captureTimestamp(date)!);
 assert.deepEqual([local.getFullYear(),local.getMonth()+1,local.getDate(),local.getHours(),local.getMinutes()],[2024,3,1,0,30]);
 assert.deepEqual(formatCaptureDateTime(date,'en'),{date:'Mar 1, 2024',time:'00:30:00'});
});

test('an offset written without a colon is read the same way by the timestamp and the display',()=>{
 const date='2024-03-01T00:30:00+0800';
 assert.equal(captureTimestamp(date),Date.parse('2024-02-29T16:30:00Z'));
 assert.deepEqual(formatCaptureDateTime(date,'en'),{date:'Mar 1, 2024',time:'00:30:00',timezone:'UTC+08:00'});
});
