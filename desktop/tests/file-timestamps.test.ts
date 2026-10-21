import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {configureOrganizationRecovery,execute,executeReorganization,getOrganizationRecovery,plan,resumeOrganization} from '../core/index';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false,template:'{year}/{yyyymm}/{camera}',separateMedia:true,unknownRules:{}};
const capture='2024-02-03T12:34:56.123+09:00';
const captureMs=1706931296123;
async function fixture(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'import-timestamps-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),root=path.join(base,'destination');await fs.mkdir(source);await fs.mkdir(root);
 const original=path.join(source,'A.JPG');await fs.writeFile(original,'original fixture bytes');await fs.utimes(original,new Date('2020-01-01T00:00:00Z'),new Date('2020-01-01T00:00:00Z'));
 return {base,source,root,original};
}
function close(actual:number,want:number){assert.ok(Math.abs(actual-want)<2,`Expected timestamp ${want}; got ${actual}`);}
for(const exclusiveCopy of [false,true])test(`import sets Created and Modified to capture time (${exclusiveCopy?'exclusive copy':'hard link'})`,async t=>{
 const {source,root,original}=await fixture(t),before=await fs.stat(original);
 const {plans:[transfer]}=await plan(source,[root],options,async()=>({date:capture,camera:'Camera',fields:{}}));
 assert.deepEqual(await execute(transfer!,undefined,undefined,{exclusiveCopy}),{copied:1,skipped:0,errors:[]});
 const destination=await fs.stat(transfer!.entries[0]!.destination);close(destination.mtimeMs,captureMs);if(process.platform==='darwin')close(destination.birthtimeMs,captureMs);
 const after=await fs.stat(original);close(after.mtimeMs,before.mtimeMs);close(after.birthtimeMs,before.birthtimeMs);assert.equal(await fs.readFile(original,'utf8'),'original fixture bytes');
});
test('backup and absent/invalid capture metadata preserve source filesystem timestamps',async t=>{
 const {source,root,original}=await fixture(t);await fs.utimes(original,new Date('2030-01-01T00:00:00Z'),new Date('2030-01-01T00:00:00Z'));const before=await fs.stat(original);
 for(const [index,date]of [undefined,'2024-02-30T12:00:00Z','2024-02-03'].entries()){
  const destination=path.join(root,String(index));await fs.mkdir(destination);
  const {plans:[transfer]}=await plan(source,[destination],options,async()=>({date,fields:{}}));
  assert.deepEqual(await execute(transfer!),{copied:1,skipped:0,errors:[]});const copied=await fs.stat(transfer!.entries[0]!.destination);close(copied.mtimeMs,before.mtimeMs);if(process.platform==='darwin')close(copied.birthtimeMs,before.birthtimeMs);
 }
 const destination=path.join(root,'backup');await fs.mkdir(destination);
 const {plans:[transfer]}=await plan(source,[destination],{...options,backup:true},async()=>{throw new Error('Backup must not read metadata');});
 assert.deepEqual(await execute(transfer!,undefined,undefined,{exclusiveCopy:true}),{copied:1,skipped:0,errors:[]});const copied=await fs.stat(transfer!.entries[0]!.destination);close(copied.mtimeMs,before.mtimeMs);if(process.platform==='darwin')close(copied.birthtimeMs,before.birthtimeMs);
});
test('timezone-free capture timestamps use local wall clock once during planning',async t=>{
 const previous=process.env.TZ;t.after(()=>{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;});process.env.TZ='America/Toronto';
 const {source,root}=await fixture(t);const {plans:[transfer]}=await plan(source,[root],options,async()=>({date:'2024-02-03T12:34:56',fields:{}}));
 process.env.TZ='Asia/Tokyo';assert.deepEqual(await execute(JSON.parse(JSON.stringify(transfer))),{copied:1,skipped:0,errors:[]});close((await fs.stat(transfer!.entries[0]!.destination)).mtimeMs,1706981696000);
});
test('organization recovery retains capture timestamps without rereading metadata',async t=>{
 const {source,original}=await fixture(t);const {plans:[transfer]}=await plan(source,[source],{...options,reorganize:true},async()=>({date:capture,camera:'Camera',fields:{}}));
 const result=await executeReorganization(transfer!);assert.equal(result.errors.length,0);assert.equal(result.moved,1);
 const [job]=await getOrganizationRecovery(source);const destination=transfer!.entries[0]!.destination;
 close((await fs.stat(destination)).mtimeMs,captureMs);if(process.platform==='darwin')close((await fs.stat(destination)).birthtimeMs,captureMs);
 await fs.unlink(destination);{const resumed=await resumeOrganization(source,job!.id);assert.deepEqual({...resumed,retainedBytes:undefined},{copied:1,skipped:0,errors:[],moved:1,retained:1,retainedBytes:undefined});}
 close((await fs.stat(destination)).mtimeMs,captureMs);if(process.platform==='darwin')close((await fs.stat(destination)).birthtimeMs,captureMs);
 await assert.rejects(fs.stat(original));
});
