import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as core from '../core/index';
import {removeEmptiedFolders} from '../core/redundant-folders';
import {identity} from '../core/paths';
import {journalLines,organizeByCopy} from './fixtures/records';

core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
async function library(t:test.TestContext){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'redundant-folders-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const put=async(relative:string,contents:string|Buffer='x')=>{const file=path.join(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,contents);};
 const exists=(relative:string)=>fs.lstat(path.join(root,relative)).then(()=>true,()=>false);
 return {root,put,exists};
}
/** A minimal AppleDouble header with no entries: bookkeeping only. */
const blankSidecar=()=>{const b=Buffer.alloc(26);b.writeUInt32BE(0x00051607,0);b.writeUInt32BE(0x00020000,4);return b;};
/** One Finder info entry with a colour label set: real user data. */
const taggedSidecar=()=>{const b=Buffer.alloc(26+12+32);b.writeUInt32BE(0x00051607,0);b.writeUInt32BE(0x00020000,4);b.writeUInt16BE(1,24);b.writeUInt32BE(9,26);b.writeUInt32BE(38,30);b.writeUInt32BE(32,34);b[38+9]=0x0c;return b;};
const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{},reorganize:true as const};
const metadata=async()=>({camera:'Sony',date:'2024-02-03',fields:{}});

test('only folders holding nothing but OS bookkeeping go; a labelled "._" file, a link, a protected folder or a replaced folder keeps its folder',async t=>{
 const l=await library(t),at=(relative:string)=>path.join(l.root,relative);
 await l.put('a/.DS_Store');await l.put('a/._A.JPG',blankSidecar());
 await l.put('b/._B.JPG',taggedSidecar());
 await fs.mkdir(at('c'));await fs.symlink(at('a'),at('c/link'));
 await fs.mkdir(at('kept'));await fs.mkdir(at('moved'));
 const expected=new Map([[at('moved'),await identity(at('moved'))]]);
 await fs.rm(at('moved'),{recursive:true});await fs.mkdir(at('moved'));
 const removed=await removeEmptiedFolders(l.root,['a','b','c','kept','moved'].map(at),{protect:[at('kept')],identities:expected,area:'test',after:'testing'});
 assert.equal(removed,1);
 assert.deepEqual(await Promise.all(['a','b/._B.JPG','c/link','kept','moved'].map(l.exists)),[false,true,true,true,true]);
});

test('with bookkeeping off only folders that are already empty go',async t=>{
 const l=await library(t),at=(relative:string)=>path.join(l.root,relative);
 await l.put('a/b/.DS_Store');await fs.mkdir(at('c/d'),{recursive:true});
 const removed=await removeEmptiedFolders(l.root,['a/b','a','c/d','c'].map(at),{bookkeeping:false,area:'test',after:'testing'});
 assert.equal(removed,2);
 assert.deepEqual(await Promise.all(['a/b/.DS_Store','c'].map(l.exists)),[true,false]);
});

test('an organization removes the chosen folders it emptied, bookkeeping included, reports how many, and stays inside its signed scope',async t=>{
 const l=await library(t);
 await l.put('shoots/2023/a/A.JPG','one');await l.put('shoots/2023/a/.DS_Store');await l.put('shoots/2023/a/._A.JPG',blankSidecar());
 await l.put('shoots/2023/b/B.JPG','two');await l.put('shoots/2023/b/._B.JPG',taggedSidecar());
 const {plans:[p]}=await core.plan(l.root,[l.root],{...options,sourceFolders:['shoots/2023']},metadata);
 const result=await core.executeReorganization(p!);
 assert.deepEqual(result.errors,[]);assert.equal(result.moved,2);
 assert.equal(result.foldersRemoved,1,'only shoots/2023/a held nothing else');
 assert.deepEqual(await Promise.all(['shoots/2023/a','shoots/2023/b/._B.JPG','shoots'].map(l.exists)),[false,true,true]);
 const [job]=await core.getOrganizationRecovery(l.root);
 assert.deepEqual(JSON.parse((await journalLines(l.root,job!.id))[0]!).cleanupScope,[path.join(l.root,'shoots/2023')]);
});

test('the scope bounds the cleanup: a folder above the chosen one stays even when it is left empty',async t=>{
 const l=await library(t);
 await l.put('shoots/2023/A.JPG','one');
 const {plans:[p]}=await core.plan(l.root,[l.root],{...options,sourceFolders:['shoots/2023']},metadata);
 const result=await core.executeReorganization(p!);
 assert.deepEqual(result.errors,[]);assert.equal(result.foldersRemoved,1);
 assert.deepEqual(await Promise.all(['shoots/2023','shoots'].map(l.exists)),[false,true]);
});

test('a journal recorded without a cleanup scope keeps removing only folders already empty',async t=>{
 const l=await library(t);
 await l.put('incoming/a/A.JPG','one');await l.put('incoming/a/.DS_Store');await l.put('incoming/b/B.JPG','two');
 const {plans:[p]}=await core.plan(l.root,[l.root],options,metadata);
 const result=await organizeByCopy(p!);
 assert.deepEqual(result.errors,[]);assert.equal(result.foldersRemoved,1);
 assert.deepEqual(await Promise.all(['incoming/a/.DS_Store','incoming/b'].map(l.exists)),[true,false]);
});

test('an organization asked to keep source folders leaves the emptied folders in place',async t=>{
 const l=await library(t);await l.put('incoming/A.JPG','original');
 const {plans:[p]}=await core.plan(l.root,[l.root],options,metadata);
 const result=await core.executeReorganization(p!,undefined,undefined,{keepSourceFolders:true});
 assert.deepEqual(result.errors,[]);assert.equal(result.moved,1);assert.equal(result.foldersRemoved??0,0);
 assert.equal(await l.exists('incoming'),true);
 const [job]=await core.getOrganizationRecovery(l.root);
 assert.deepEqual((await core.resumeOrganization(l.root,job!.id)).errors,[]);
 assert.equal(await l.exists('incoming'),true,'a resumed run keeps honouring the choice');
});

test('after a video-root backup organization both backup folders stay and only emptied folders inside them go',async t=>{
 const l=await library(t),photos=path.join(l.root,'photobackup'),videos=path.join(l.root,'videobackup');
 await l.put('photobackup/2024/202402/Sony A7/RAW/A.ARW');await l.put('photobackup/old/C.MOV');await l.put('photobackup/old/.DS_Store');
 await l.put('videobackup/stray/B.JPG');await l.put('elsewhere/D.JPG');
 const layout={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'video-root' as const,videoRoots:[videos],unknownRules:{},sourceFolders:['photobackup','videobackup']};
 const {plans}=await core.plan(l.root,[photos],{...layout,reorganize:true},async()=>({camera:'Sony A7',date:'2024-02-03T12:00:00',fields:{}}));
 let removed=0;
 for(const part of [plans[0]!,plans[0]!.videos!]){const result=await core.executeReorganization(part);assert.deepEqual(result.errors,[]);removed+=result.foldersRemoved??0;}
 assert.equal(removed,3,'old, stray and the emptied RAW folder');
 assert.deepEqual(await Promise.all(['photobackup','videobackup','photobackup/old','videobackup/stray','elsewhere/D.JPG','videobackup/2024/202402/Sony A7/C.MOV','photobackup/2024/202402/Sony A7/B.JPG','photobackup/2024/202402/Sony A7/RAW'].map(l.exists)),[true,true,false,false,true,true,true,false]);
});
