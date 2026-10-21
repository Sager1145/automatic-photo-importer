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
