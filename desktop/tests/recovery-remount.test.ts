import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHmac} from 'node:crypto';
import * as core from '../core/index';

const secret='fixture-only-host-recovery-secret-32bytes';
core.configureOrganizationRecovery(secret);
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{},reorganize:true};
const metadata=async()=>({camera:'Sony',date:'2024-02-03',fields:{}});

/** What a journal looks like after the drive is mounted again: macOS gives the volume a new
 * device number, so every recorded dev:ino and stat.dev carries the old one. */
async function remount(root:string,id:string,dev:string,manifestToo=true){
 const job=path.join(root,'.photo-importer-recovery',id);
 const seal=(value:Record<string,unknown>)=>{delete value.seal;value.seal=createHmac('sha256',Buffer.from(secret,'utf8')).update(JSON.stringify(value)).digest('hex');return value;};
 const swap=(identity:string)=>identity.replace(/^\d+:/,`${dev}:`);
 const event=(value:Record<string,unknown>)=>{const stat=value.stat as {dev?:string}|undefined;if(stat?.dev)stat.dev=dev;return seal(value);};
 const manifest=JSON.parse(await fs.readFile(path.join(job,'manifest.json'),'utf8'));
 if(manifestToo){manifest.rootIdentity=swap(manifest.rootIdentity);manifest.sourceIdentity=swap(manifest.sourceIdentity);
 for(const entry of manifest.entries){entry.stat.dev=dev;for(const folder of Object.keys(entry.parents))entry.parents[folder]=swap(entry.parents[folder]);}
 await fs.writeFile(path.join(job,'manifest.json'),JSON.stringify(seal(manifest)));}
 for(const name of await fs.readdir(job)){
  const file=path.join(job,name);
  if(name==='event-log.jsonl')await fs.writeFile(file,(await fs.readFile(file,'utf8')).split('\n').map(line=>line?JSON.stringify(event(JSON.parse(line))):line).join('\n'));
  else if(/^event-.*\.json$/.test(name))await fs.writeFile(file,JSON.stringify(event(JSON.parse(await fs.readFile(file,'utf8')))));
 }
}

for(const [strategy,manifestToo] of [['copy',true],['rename',true],['copy',false],['rename',false]] as const)
test(`a ${strategy} organization journal${manifestToo?'':' whose events came from another mount'} can still be listed, rechecked and resumed after the drive is mounted again`,async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'recovery-remount-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const original=path.join(root,'incoming','deep','A.JPG');await fs.mkdir(path.dirname(original),{recursive:true});await fs.writeFile(original,'precious original');
 const p=(await core.plan(root,[root],options,metadata)).plans[0]!;
 assert.equal((await core.executeReorganization(p,undefined,undefined,{strategy})).errors.length,0);
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
 const [job]=await core.getOrganizationRecovery(root),manifestFile=path.join(root,'.photo-importer-recovery',job!.id,'manifest.json');
 const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
 // Another folder's inode under the old device number: not this directory, whatever the mount.
 manifest.rootIdentity=manifest.rootIdentity.replace(/:\d+$/,':1');delete manifest.seal;
 manifest.seal=createHmac('sha256',Buffer.from(secret,'utf8')).update(JSON.stringify(manifest)).digest('hex');
 await fs.writeFile(manifestFile,JSON.stringify(manifest));
 const [after]=await core.getOrganizationRecovery(root);assert.match(after?.error??'',/identity changed/i);
});
