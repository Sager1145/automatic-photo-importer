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

test('releasing duplicates after organizing is on by default and can be turned off',()=>{
 assert.equal(normalizePreferences({}).releaseDuplicatesAfterOrganizing,true);
 assert.equal(normalizePreferences({releaseDuplicatesAfterOrganizing:false}).releaseDuplicatesAfterOrganizing,false);
});

const hiddenFolders=async(root:string)=>{const found:string[]=[];const walk=async(folder:string)=>{for(const entry of await fs.readdir(folder,{withFileTypes:true}))if(entry.isDirectory()){const child=path.join(folder,entry.name);if(entry.name.startsWith('.'))found.push(path.relative(root,child));await walk(child);}};await walk(root);return found;};

test('organization never creates hidden folders; its records folder is visible',async t=>{
 const f=await fixture(t);
 await core.executeReorganization(await prepare(f.root),undefined,undefined,{...rename,releaseDuplicates:false});
 assert.deepEqual(await hiddenFolders(f.root),[]);
 assert.ok((await fs.stat(path.join(f.root,'Photo Importer Data'))).isDirectory());
 assert.equal((await core.findMisplaced(f.root,f.root,options,metadata)).count,0,'the records folder is never organized');
});

test('records an earlier version left in its hidden folder are listed as being converted, and organizing is refused meanwhile',async t=>{
 const f=await fixture(t);
 // The earlier version's folder holding a journal (its manifest) this build did not write and never reads.
 const id='6b1f1b8e-8a9b-4c1d-9e3f-0a1b2c3d4e5f',old=path.join(f.root,'.photo-importer-recovery',id);
 await fs.mkdir(old,{recursive:true});await fs.writeFile(path.join(old,'manifest.json'),'{}');
 const listed=await core.getOrganizationRecovery(f.root);
 assert.deepEqual(listed.map(item=>[item.id,item.converting]),[[id,true]]);
 await assert.rejects(core.executeReorganization(await prepare(f.root),undefined,undefined,{...rename,releaseDuplicates:false}),/being converted/);
 assert.equal(await fs.readFile(f.duplicate,'utf8'),'same bytes','nothing was moved');
 assert.equal(await fs.readFile(path.join(old,'manifest.json'),'utf8'),'{}','the old records are left as they are');
});
