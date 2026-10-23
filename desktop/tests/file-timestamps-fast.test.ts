import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {applyFileTimestamps} from '../platform/file-timestamps';

test('uses descriptor utimes without launching a helper when filesystem already sets capture Created date',{skip:process.platform!=='darwin'},async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'timestamp-fast-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const file=path.join(base,'owned'),output=await fs.open(file,'wx');t.after(()=>output.close());await output.writeFile('fixture');const source=await output.stat({bigint:true});
 const capture=1577836800000;await output.utimes(capture/1000,capture/1000);
 if(Math.abs((await output.stat()).birthtimeMs-capture)>1){t.skip('Filesystem does not lower Created when setting older Modified dates');return;}
 const original=childProcess.spawn;let launches=0;
 childProcess.spawn=((...args:Parameters<typeof childProcess.spawn>)=>{launches++;return original(...args);}) as typeof childProcess.spawn;
 try{await applyFileTimestamps(output,source,capture);}finally{childProcess.spawn=original;}
 assert.equal(launches,0);const stat=await output.stat();assert.equal(stat.mtimeMs,capture);assert.equal(stat.birthtimeMs,capture);
});

test('a missing native helper fails the capture date instead of falling back to the source dates',{skip:process.platform!=='darwin'},async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'timestamp-helper-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const output=await fs.open(path.join(base,'owned'),'wx');t.after(()=>output.close());await output.writeFile('fixture');const source=await output.stat({bigint:true});
 // A capture after the file's birth: descriptor utimes cannot raise Created, so only the helper can.
 const previous=process.env.IMPORTER_NATIVE_BRIDGE;process.env.IMPORTER_NATIVE_BRIDGE=path.join(base,'missing-helper');
 t.after(()=>{if(previous===undefined)delete process.env.IMPORTER_NATIVE_BRIDGE;else process.env.IMPORTER_NATIVE_BRIDGE=previous;});
 await assert.rejects(applyFileTimestamps(output,source,Date.now()+86400000),/native helper/);
});

test('a file that is not exclusively linked fails instead of taking the source dates',async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'timestamp-link-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const file=path.join(base,'owned'),output=await fs.open(file,'wx');t.after(()=>output.close());await output.writeFile('fixture');await fs.link(file,path.join(base,'second'));
 await assert.rejects(applyFileTimestamps(output,await output.stat({bigint:true}),1577836800000),/exclusively owned/);
});

test('a capture date the filesystem cannot store falls back to the source dates',{skip:process.platform!=='darwin'},async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'timestamp-range-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const output=await fs.open(path.join(base,'owned'),'wx');t.after(()=>output.close());await output.writeFile('fixture');
 const sourceTime=1609459200000;await output.utimes(sourceTime/1000,sourceTime/1000);const source=await output.stat({bigint:true});
 // APFS keeps 1677–2262: a year-9999 date is clamped, so it is not stored.
 assert.equal(await applyFileTimestamps(output,source,Date.parse('9999-12-31T23:59:59Z')),false);
 assert.equal((await output.stat()).mtimeMs,sourceTime);
});
