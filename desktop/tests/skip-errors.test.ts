import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {plan,execute} from '../core';
import {MessageError,filePath,toMessage} from '../messages';
import {normalizePreferences,defaultPreferences} from '../preferences';

/** Destination files without the checksum index and staging/receipt files. */
async function published(root:string):Promise<string[]>{
 const found:string[]=[];
 async function walk(folder:string){for(const item of await fs.readdir(folder,{withFileTypes:true})){const file=path.join(folder,item.name);if(item.isDirectory())await walk(file);else if(!item.name.startsWith('photo-importer-index'))found.push(path.relative(root,file));}}
 await walk(root);return found.sort();
}
async function fixture(t:test.TestContext,names:string[]){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'skip-errors-')));
 t.after(async()=>{await fs.chmod(base,0o700).catch(()=>{});for(const name of names)await fs.chmod(path.join(base,'source',name),0o600).catch(()=>{});await fs.rm(base,{recursive:true,force:true});});
 const source=path.join(base,'source'),root=path.join(base,'destination');await fs.mkdir(source);await fs.mkdir(root);
 for(const name of names)await fs.writeFile(path.join(source,name),`bytes of ${name}`);
 return {source,root};
}
const backup={backup:true,template:'{year}',layout:'flat' as const,unknownRules:{}};

// Planning reads an unknown small file while listing it (Finder alias check), and reads a photo
// when a same-size file already at its destination has to be compared with it.
for(const ext of ['bin','jpg']){
async function unreadable(t:test.TestContext){
 const names=['a','b','c'].map(name=>`${name}.${ext}`),f=await fixture(t,names);
 await fs.writeFile(path.join(f.root,`b.${ext}`),`other of b.${ext}`);await fs.chmod(path.join(f.source,`b.${ext}`),0);
 return f;
}

test(`an unreadable source .${ext} file stops planning when skipping is off`,async t=>{
 const f=await unreadable(t);
 await assert.rejects(plan(f.source,[f.root],backup,async()=>({fields:{}})),/EACCES|permission/i);
 assert.deepEqual(await published(f.root),[`b.${ext}`]);
});

test(`an unreadable source .${ext} file is skipped and reported while the others are copied and verified`,async t=>{
 const f=await unreadable(t);
 const {plans:[transfer],failures}=await plan(f.source,[f.root,],{...backup,skipErrors:true},async()=>({fields:{}}));
 assert.deepEqual(failures.map(item=>item.path),[path.join(f.source,`b.${ext}`)]);
 assert.match(failures[0]!.error.message,/EACCES|permission/i);
 assert.deepEqual(transfer!.entries.map(entry=>path.basename(entry.source)).sort(),[`a.${ext}`,`c.${ext}`]);
 const result=await execute(transfer!);
 assert.deepEqual(result,{copied:2,skipped:0,errors:[]});
 assert.deepEqual(await published(f.root),[`a.${ext}`,`b.${ext}`,`c.${ext}`]);
 assert.equal(await fs.readFile(path.join(f.root,`a.${ext}`),'utf8'),`bytes of a.${ext}`);
 // The existing destination file is never overwritten, and the source stays.
 assert.equal(await fs.readFile(path.join(f.root,`b.${ext}`),'utf8'),`other of b.${ext}`);
 await fs.chmod(path.join(f.source,`b.${ext}`),0o600);
 assert.equal(await fs.readFile(path.join(f.source,`b.${ext}`),'utf8'),`bytes of b.${ext}`);
});
}

async function unreadableJpg(t:test.TestContext){
 const f=await fixture(t,['a.jpg','b.jpg','c.jpg']);
 await fs.writeFile(path.join(f.root,'b.jpg'),'other of b.jpg');await fs.chmod(path.join(f.source,'b.jpg'),0);
 return f;
}

// Metadata is read between two identity checks; a file rewritten then has changed mid-plan.
const changing=(source:string)=>async(file:string)=>{if(path.basename(file)==='b.jpg')await fs.appendFile(path.join(source,'b.jpg'),'more');return {fields:{},camera:'Cam',date:'2024-05-06T07:08:09'};};
const photos={backup:false,template:'{year}',layout:'flat' as const,unknownRules:{}};

test('a file that changes during planning stops the plan when skipping is off',async t=>{
 const f=await fixture(t,['a.jpg','b.jpg','c.jpg']);
 await assert.rejects(plan(f.source,[f.root],photos,changing(f.source)),(error:unknown)=>error instanceof MessageError&&error.key==='error.sourceChanged');
 assert.deepEqual(await published(f.root),[]);
});

test('a file that changes during planning is skipped while the others are copied and verified',async t=>{
 const f=await fixture(t,['a.jpg','b.jpg','c.jpg']);
 const {plans:[transfer],failures}=await plan(f.source,[f.root],{...photos,skipErrors:true},changing(f.source));
 assert.equal(failures.length,1);assert.equal(failures[0]!.path,path.join(f.source,'b.jpg'));
 assert.ok(failures[0]!.error instanceof MessageError&&failures[0]!.error.key==='error.sourceChanged');
 const result=await execute(transfer!);
 assert.deepEqual(result,{copied:2,skipped:0,errors:[]});
 assert.deepEqual(await published(f.root),['2024/a.jpg','2024/c.jpg']);
 // Planning again retries the skipped file: it is no longer changing.
 const again=await plan(f.source,[f.root],{...photos,skipErrors:true},async()=>({fields:{},camera:'Cam',date:'2024-05-06T07:08:09'}));
 assert.deepEqual(again.failures,[]);
 assert.deepEqual(await execute(again.plans[0]!),{copied:1,skipped:2,errors:[]});
 assert.deepEqual(await published(f.root),['2024/a.jpg','2024/b.jpg','2024/c.jpg']);
});

test('a copy that fails is reported while the other files are copied, with skipping on or off',async t=>{
 const f=await fixture(t,['a.bin','b.bin','c.bin']);
 for(const skipErrors of [false,true]){
  const {plans:[transfer]}=await plan(f.source,[f.root],{...backup,skipErrors},async()=>({fields:{}}));
  await fs.chmod(path.join(f.source,'b.bin'),0);
  const result=await execute(transfer!);
  assert.equal(result.copied,2);assert.equal(result.errors.length,1);assert.match(result.errors[0]!,/b\.bin/);
  await fs.chmod(path.join(f.source,'b.bin'),0o600);
  // Neither a partial file nor a staging receipt is left for the failed file.
  assert.deepEqual(await published(f.root),['a.bin','c.bin']);
  if(!skipErrors)for(const name of ['a.bin','c.bin'])await fs.rm(path.join(f.root,name));
 }
});

test('skipping errors is a saved setting that is on unless the user turned it off',()=>{
 assert.equal(defaultPreferences.skipErrors,true);
 assert.equal(normalizePreferences({}).skipErrors,true);
 assert.equal(normalizePreferences({skipErrors:false}).skipErrors,false);
 assert.equal(normalizePreferences({skipErrors:'yes'},{...defaultPreferences,skipErrors:false}).skipErrors,false);
 assert.equal(normalizePreferences({skipErrors:true},{...defaultPreferences,skipErrors:false}).skipErrors,true);
});

test('a skipped file takes its whole family with it, so a sidecar never lands without its photo',async t=>{
 const f=await fixture(t,['a.jpg','a.xmp','c.jpg']);
 const changingA=async(file:string)=>{if(path.basename(file)==='a.jpg')await fs.appendFile(path.join(f.source,'a.jpg'),'more');return {fields:{},camera:'Cam',date:'2024-05-06T07:08:09'};};
 const {plans:[transfer],failures}=await plan(f.source,[f.root],{...photos,skipErrors:true},changingA);
 assert.deepEqual(failures.map(item=>path.basename(item.path)).sort(),['a.jpg','a.xmp']);
 assert.deepEqual(await execute(transfer!),{copied:1,skipped:0,errors:[]});
 assert.deepEqual(await published(f.root),['2024/c.jpg']);
});

test('with skipping off, a planning error names the file so it can be skipped by hand',async t=>{
 const f=await unreadableJpg(t);
 const error=await plan(f.source,[f.root],backup,async()=>({fields:{}})).then(()=>undefined,(caught:unknown)=>caught);
 assert.ok(error instanceof MessageError);assert.match(error.message,/EACCES|permission/i);
 assert.equal(filePath(toMessage(error)),path.join(f.source,'b.jpg'));
 const changed=await fixture(t,['a.jpg','b.jpg']);
 const moved=await plan(changed.source,[changed.root],photos,changing(changed.source)).then(()=>undefined,(caught:unknown)=>caught);
 assert.equal(filePath(toMessage(moved)),path.join(changed.source,'b.jpg'));
});

test('a file the user skips is left out with its family even with skipping off, and the rest is copied',async t=>{
 const f=await unreadableJpg(t);await fs.writeFile(path.join(f.source,'b.xmp'),'sidecar of b');
 const {plans:[transfer],failures}=await plan(f.source,[f.root],{...photos,exclude:[path.join(f.source,'b.jpg')]},async()=>({fields:{},camera:'Cam',date:'2024-05-06T07:08:09'}));
 assert.deepEqual(failures.map(item=>path.basename(item.path)).sort(),['b.jpg','b.xmp']);
 assert.ok(failures.every(item=>item.error instanceof MessageError&&item.error.key==='error.userSkipped'));
 assert.deepEqual(await execute(transfer!),{copied:2,skipped:0,errors:[]});
 assert.deepEqual(await published(f.root),['2024/a.jpg','2024/c.jpg','b.jpg']);
});

test('a mirror backup never skips a file, even one the user asks to skip',async t=>{
 const f=await fixture(t,['a.bin']);
 await assert.rejects(plan(f.source,[f.root],{...backup,drive:{name:'Card',identity:'card-id',mirror:true},exclude:[path.join(f.source,'a.bin')]},async()=>({fields:{}})),/mirror/i);
});

test('a job error in All errors names its job, so its Skip button reaches that job',async()=>{
 const {gatherErrors}=await import('../error-log');
 const error={key:'error.fileFailed' as const,params:{path:'/card/DCIM/B.JPG',error:'EIO'}};
 const [logged]=gatherErrors({jobs:[{id:'job-1',source:{id:'card',name:'Card',path:'/Volumes/Card',transport:'folder'},phase:'error',errors:[error],backup:false,skippablePath:'/card/DCIM/B.JPG'}],sources:[]} as never);
 assert.equal(logged!.jobId,'job-1');assert.equal(filePath(logged!.message),'/card/DCIM/B.JPG');
});
