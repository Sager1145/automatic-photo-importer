import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as core from '../core/index';
import {normalizePreferences} from '../preferences';

core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{},reorganize:true};
const metadata=async()=>({camera:'Sony',date:'2024-02-03',fields:{}});
const rename={strategy:'rename' as const};

// A library where a stray copy of an already organized file sits in an old folder,
// next to a stray file that is not organized yet.
async function fixture(t:test.TestContext){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'organization-duplicates-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const put=async(relative:string,contents:string)=>{const file=path.join(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,contents);return file;};
 const organized=await put('2024/202402/Sony/JPEG/A.JPG','same bytes');
 const duplicate=await put('old card/A.JPG','same bytes');
 const stray=await put('old card/B.JPG','new bytes');
 return {root,organized,duplicate,stray};
}
const prepare=async(root:string)=>(await core.plan(root,[root],options,metadata)).plans[0]!;

test('organizing with duplicate release removes a confirmed duplicate from its original place',async t=>{
 const f=await fixture(t);
 const result=await core.executeReorganization(await prepare(f.root),undefined,undefined,{...rename,releaseDuplicates:true});
 assert.deepEqual(result.errors,[]);
 assert.equal(result.released,1);assert.equal(result.releasedBytes,Buffer.byteLength('same bytes'));
 assert.equal(result.retained,0);assert.equal(result.retainedBytes,0);
 await assert.rejects(fs.lstat(f.duplicate),{code:'ENOENT'});
 assert.equal(await fs.readFile(f.organized,'utf8'),'same bytes','the organized copy stays');
 assert.equal(await fs.readFile(path.join(f.root,'2024/202402/Sony/JPEG/B.JPG'),'utf8'),'new bytes');
 const [job]=await core.getOrganizationRecovery(f.root);
 assert.equal(job!.retainedFiles,0,'no duplicate is left in recovery storage');
});

test('without duplicate release a confirmed duplicate is kept in recovery storage',async t=>{
 const f=await fixture(t);
 const result=await core.executeReorganization(await prepare(f.root),undefined,undefined,rename);
 assert.deepEqual(result.errors,[]);
 assert.equal(result.released??0,0);assert.equal(result.retained,1);
 const [job]=await core.getOrganizationRecovery(f.root);
 assert.equal(job!.retainedFiles,1);assert.equal(job!.finalizable,true);
});

test('duplicates are not released when the organization reports an error',async t=>{
 const f=await fixture(t);
 const reviewed=await prepare(f.root);
 // Another file changes after review, so the run stops with an error.
 await fs.writeFile(f.stray,'changed after review');
 const result=await core.executeReorganization(reviewed,undefined,undefined,{...rename,releaseDuplicates:true}).catch(error=>({errors:[String(error)],released:0}));
 assert.notDeepEqual(result.errors,[]);
 assert.equal(result.released??0,0);
 const kept=await fs.readFile(f.duplicate,'utf8').catch(()=>undefined);
 const [job]=await core.getOrganizationRecovery(f.root).catch(()=>[]);
 assert.ok(kept==='same bytes'||(job?.retainedFiles??0)>0,'the original is still on the drive');
});

test('releasing duplicates after organizing is an opt-in preference',()=>{
 assert.equal(normalizePreferences({}).releaseDuplicatesAfterOrganizing,false);
 assert.equal(normalizePreferences({releaseDuplicatesAfterOrganizing:true}).releaseDuplicatesAfterOrganizing,true);
});
