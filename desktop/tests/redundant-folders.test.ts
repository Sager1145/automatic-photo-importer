import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as core from '../core/index';

core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
async function library(t:test.TestContext){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'redundant-folders-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const put=async(relative:string,contents='x')=>{const file=path.join(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,contents);};
 const exists=(relative:string)=>fs.lstat(path.join(root,relative)).then(()=>true,()=>false);
 return {root,put,exists};
}

test('folders left with nothing but service files are removed; folders holding a user file are kept',async t=>{
 const l=await library(t);
 await l.put('2024/202402/Sony/._A.JPG');await l.put('2024/202402/.DS_Store');
 await l.put('2024/202403/empty/.keepout/._B');
 await l.put('2025/notes/readme.txt');await l.put('2025/notes/._readme.txt');
 await fs.mkdir(path.join(l.root,'2026/a/b/c'),{recursive:true});
 await l.put('photobackup/2024/202402/Sony/A.JPG');await fs.mkdir(path.join(l.root,'photobackup/empty'),{recursive:true});
 await l.put('outside/._lonely');
 await fs.symlink(path.join(l.root,'outside'),path.join(l.root,'2026/link'));
 const removed=await core.removeRedundantFolders(l.root,['2024','2025','2026'].map(folder=>path.join(l.root,folder)),[path.join(l.root,'photobackup')]);
 assert.equal(await l.exists('2024'),false,'a year folder holding only service files goes away');
 assert.equal(await l.exists('2025/notes/readme.txt'),true);assert.equal(await l.exists('2025/notes/._readme.txt'),true,'service files next to user files stay');
 assert.equal(await l.exists('2026'),true,'a folder holding a symbolic link is kept');assert.equal(await l.exists('2026/a'),false);
 assert.equal(await l.exists('photobackup/empty'),true,'the backup folder is never touched');
 assert.equal(await l.exists('outside/._lonely'),true,'nothing outside the chosen folders is touched');
 assert.ok(removed>=6,`removed ${removed}`);
});

test('the chosen folders must be inside the library and never the library itself or the backup',async t=>{
 const l=await library(t);
 await assert.rejects(core.removeRedundantFolders(l.root,[l.root],[]),/library|root/i);
 await assert.rejects(core.removeRedundantFolders(l.root,[path.join(l.root,'photobackup')],[path.join(l.root,'photobackup')]),/backup/i);
 await assert.rejects(core.removeRedundantFolders(l.root,[path.dirname(l.root)],[]),/inside/i);
});

test('an organization asked to keep source folders leaves the emptied folders in place',async t=>{
 const l=await library(t);await l.put('incoming/A.JPG','original');
 const {plans:[p]}=await core.plan(l.root,[l.root],{backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{},reorganize:true},async()=>({camera:'Sony',date:'2024-02-03',fields:{}}));
 const result=await core.executeReorganization(p!,undefined,undefined,{strategy:'rename',keepSourceFolders:true});
 assert.deepEqual(result.errors,[]);assert.equal(result.moved,1);
 assert.equal(await l.exists('incoming'),true);
 const [job]=await core.getOrganizationRecovery(l.root);
 assert.deepEqual((await core.resumeOrganization(l.root,job!.id)).errors,[]);
 assert.equal(await l.exists('incoming'),true,'a resumed run keeps honouring the choice');
});

test('after a video-root backup organization both backup folders stay and only emptied folders inside them go',async t=>{
 const l=await library(t),photos=path.join(l.root,'photobackup'),videos=path.join(l.root,'videobackup');
 await l.put('photobackup/2024/202402/Sony A7/RAW/A.ARW');await l.put('photobackup/old/C.MOV');await l.put('photobackup/old/.DS_Store');
 await l.put('videobackup/stray/B.JPG');await l.put('elsewhere/D.JPG');
 const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'video-root' as const,videoRoots:[videos],unknownRules:{},sourceFolders:['photobackup','videobackup']};
 const metadata=async()=>({camera:'Sony A7',date:'2024-02-03T12:00:00',fields:{}});
 const {plans}=await core.plan(l.root,[photos],{...options,reorganize:true},metadata);
 for(const part of [plans[0]!,plans[0]!.videos!])assert.deepEqual((await core.executeReorganization(part,undefined,undefined,{strategy:'rename',keepSourceFolders:true})).errors,[]);
 assert.equal(await core.removeOrganizedFolders(l.root,plans,options.sourceFolders),3,'old, stray and the emptied RAW folder');
 assert.deepEqual(await Promise.all(['photobackup','videobackup','photobackup/old','videobackup/stray','elsewhere/D.JPG','videobackup/2024/202402/Sony A7/C.MOV','photobackup/2024/202402/Sony A7/B.JPG','photobackup/2024/202402/Sony A7/RAW'].map(l.exists)),[true,true,false,false,true,true,true,false]);
});
