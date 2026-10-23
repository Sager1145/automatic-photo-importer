import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as core from '../core/index';
import {journalLines,organizeAs,resealJournalLine} from './fixtures/records';

const secret='fixture-only-host-recovery-secret-32bytes';
core.configureOrganizationRecovery(secret);
const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{},reorganize:true as const};
const metadata=async()=>({camera:'Sony',date:'2024-02-03',fields:{}});

/** What a journal looks like after the drive is mounted again: macOS gives the volume a new
 * device number, so every recorded dev:ino and stat.dev carries the old one. */
async function remount(root:string,id:string,dev:string,manifestToo=true){
 const swap=(identity:string)=>identity.replace(/^\d+:/,`${dev}:`);
 if(manifestToo){
  await resealJournalLine(root,id,0,header=>{header.rootIdentity=swap(header.rootIdentity);header.sourceIdentity=swap(header.sourceIdentity);return header;});
  await resealJournalLine(root,id,1,list=>{for(const entry of list.entries){entry.stat.dev=dev;for(const folder of Object.keys(entry.parents))entry.parents[folder]=swap(entry.parents[folder]);}return list;});
 }
 const count=(await journalLines(root,id)).length;
 for(let index=2;index<count;index++)await resealJournalLine(root,id,index,value=>{if(value.stat?.dev)value.stat.dev=dev;return value;});
}

for(const [strategy,manifestToo] of [['copy',true],['rename',true],['copy',false],['rename',false]] as const)
test(`a ${strategy} organization journal${manifestToo?'':' whose events came from another mount'} can still be listed, rechecked and resumed after the drive is mounted again`,async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'recovery-remount-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const original=path.join(root,'incoming','deep','A.JPG');await fs.mkdir(path.dirname(original),{recursive:true});await fs.writeFile(original,'precious original');
 const p=(await core.plan(root,[root],options,metadata)).plans[0]!;
 assert.equal((await organizeAs(strategy,p)).errors.length,0);
 const [job]=await core.getOrganizationRecovery(root);
 const real=(await fs.lstat(root,{bigint:true})).dev;
 // Events only: the disk got its old device number back after a resume under another mount.
 await remount(root,job!.id,String(real+7n),manifestToo);
 const [after]=await core.getOrganizationRecovery(root);
 assert.equal(after?.error,undefined);assert.equal(after?.status,'complete');assert.equal(after?.completed,1);
 assert.deepEqual((await core.resumeOrganization(root,job!.id)).errors,[]);
 assert.equal(await fs.readFile(p.entries[0]!.destination,'utf8'),'precious original');
});

test('a journal for a different directory is still refused after a remount',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'recovery-remount-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const original=path.join(root,'incoming','A.JPG');await fs.mkdir(path.dirname(original),{recursive:true});await fs.writeFile(original,'precious original');
 const p=(await core.plan(root,[root],options,metadata)).plans[0]!;await core.executeReorganization(p);
 const [job]=await core.getOrganizationRecovery(root);
 // Another folder's inode under the old device number: not this directory, whatever the mount.
 await resealJournalLine(root,job!.id,0,header=>{header.rootIdentity=header.rootIdentity.replace(/:\d+$/,':1');return header;});
 const [after]=await core.getOrganizationRecovery(root);assert.match(after?.error??'',/identity changed/i);
});
