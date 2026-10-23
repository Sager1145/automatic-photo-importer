import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { plan, execute, configureOrganizationRecovery } from '../core/index';
import type { Metadata } from '../shared';

// Reported: after a clean import of fake MP4s without a capture date to exFAT, most left their staging
// file and stage record behind. exFAT rounds times to 10 ms (and creation time to 10 ms), which could
// defeat the identity cleanup relies on.
const run=promisify(execFile);
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const undated=async():Promise<Metadata>=>({camera:'Unknown',fields:{}});

test('a clean import of undated videos to exFAT leaves no staging file or receipt behind',async t=>{
 if(process.platform!=='darwin')return t.skip('exFAT disk images need macOS');
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'exfat-undated-')));
 const image=path.join(base,'drive.dmg'),mount=path.join(base,'mount');
 await fs.mkdir(mount);
 try{
  await run('hdiutil',['create','-quiet','-size','32m','-fs','ExFAT','-volname','UNDATED',image]);
  await run('hdiutil',['attach','-quiet','-nobrowse','-mountpoint',mount,image]);
 }catch{await fs.rm(base,{recursive:true,force:true});return t.skip('exFAT disk images are unavailable here');}
 t.after(async()=>{await run('hdiutil',['detach','-quiet','-force',mount]).catch(()=>{});await fs.rm(base,{recursive:true,force:true});});
 const source=path.join(base,'card'),root=path.join(mount,'photobackup');
 await fs.mkdir(source);await fs.mkdir(root);
 for(let index=0;index<12;index++)await fs.writeFile(path.join(source,`CLIP${index}.MP4`),Buffer.alloc(40_000+index*1000,index+1));
 const result=await execute((await plan(source,[root],options,undated)).plans[0]!);
 assert.deepEqual(result.errors,[]);
 assert.equal(result.copied,12);
 const left:string[]=[];
 for(const entry of await fs.readdir(root,{withFileTypes:true,recursive:true}))if(/^photo-importer-(?!index)/.test(entry.name))left.push(path.join(entry.parentPath,entry.name));
 assert.deepEqual(left,[]);
});
