import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inventory} from '../core';

test('the inventory walk reports growing file and byte counts that end at its totals',async t=>{
 const source=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'scan-progress-')));
 t.after(()=>fs.rm(source,{recursive:true,force:true}));
 for(let folder=0;folder<3;folder++){await fs.mkdir(path.join(source,'DCIM',`10${folder}TEST`),{recursive:true});for(let index=0;index<400;index++)await fs.writeFile(path.join(source,'DCIM',`10${folder}TEST`,`DSC${index}.JPG`),Buffer.alloc(index%7+1));}
 const reports:{files:number;bytes:number}[]=[];
 const scan=await inventory(source,{onProgress:(files,bytes)=>reports.push({files,bytes})});
 assert.ok(reports.length>=2,`reports: ${reports.length}`);
 for(let index=1;index<reports.length;index++){assert.ok(reports[index]!.files>=reports[index-1]!.files);assert.ok(reports[index]!.bytes>=reports[index-1]!.bytes);}
 assert.deepEqual(reports.at(-1),{files:scan.files.length,bytes:scan.files.reduce((sum,file)=>sum+file.size,0)});
});

test('an import reuses a finished scan listing and lists again only when a folder changed',async t=>{
 const source=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'scan-reuse-')));
 t.after(()=>fs.rm(source,{recursive:true,force:true}));
 await fs.mkdir(path.join(source,'DCIM','100TEST'),{recursive:true});
 for(let index=0;index<5;index++)await fs.writeFile(path.join(source,'DCIM','100TEST',`DSC${index}.JPG`),'photo');
 const scan=await inventory(source,{});
 const listed:string[]=[],readdir=fs.readdir.bind(fs);
 t.mock.method(fs,'readdir',async(...args:Parameters<typeof fs.readdir>)=>{listed.push(String(args[0]));return (readdir as (...values:unknown[])=>Promise<unknown>)(...args);});
 const {syncBuiltinESMExports}=await import('node:module');syncBuiltinESMExports();
 const reused=await inventory(source,{reuse:scan.listing});
 assert.deepEqual(listed,[],'an unchanged card is not listed again');
 assert.deepEqual(reused.files.map(file=>file.relative),scan.files.map(file=>file.relative));
 await new Promise(resolve=>setTimeout(resolve,20));
 await fs.writeFile(path.join(source,'DCIM','100TEST','DSC9.JPG'),'new photo');
 const fresh=await inventory(source,{reuse:scan.listing});
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.ok(listed.length>0,'a changed folder is listed again');
 assert.ok(fresh.files.some(file=>file.relative.endsWith('DSC9.JPG')));
});

test('after a change only the changed folder is listed again; unchanged folders come from the last listing',async t=>{
 const source=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'scan-incremental-')));
 t.after(()=>fs.rm(source,{recursive:true,force:true}));
 for(const folder of ['100TEST','101TEST']){await fs.mkdir(path.join(source,'DCIM',folder),{recursive:true});for(let index=0;index<3;index++)await fs.writeFile(path.join(source,'DCIM',folder,`DSC${index}.JPG`),'photo');}
 const scan=await inventory(source,{});
 await new Promise(resolve=>setTimeout(resolve,20));
 await fs.writeFile(path.join(source,'DCIM','100TEST','DSC9.JPG'),'new photo');
 const listed:string[]=[],readdir=fs.readdir.bind(fs);
 t.mock.method(fs,'readdir',async(...args:Parameters<typeof fs.readdir>)=>{listed.push(path.relative(source,String(args[0])));return (readdir as (...values:unknown[])=>Promise<unknown>)(...args);});
 const {syncBuiltinESMExports}=await import('node:module');syncBuiltinESMExports();
 const again=await inventory(source,{reuse:scan.listing});
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.deepEqual(listed,[path.join('DCIM','100TEST')]);
 assert.deepEqual(again.files.map(file=>file.relative).sort(),[...scan.files.map(file=>file.relative),path.join('DCIM','100TEST','DSC9.JPG')].sort());
 const third=await inventory(source,{reuse:again.listing});
 assert.equal(third.files.length,again.files.length,'the refreshed listing is remembered for the next import');
});

test('a file rewritten in place after the scan is re-read with its folder in the same plan, and that size is planned',async t=>{
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'scan-stale-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'card'),root=path.join(base,'disk'),photo=path.join(source,'DCIM','DSC0.JPG'),other=path.join(source,'MISC','A.JPG');
 await fs.mkdir(path.dirname(photo),{recursive:true});await fs.mkdir(path.dirname(other),{recursive:true});await fs.mkdir(root);
 await fs.writeFile(photo,'short');await fs.writeFile(other,'other');
 const scan=await inventory(source,{});
 await fs.writeFile(photo,'a longer rewritten photo');
 const listed:string[]=[],readdir=fs.readdir.bind(fs);
 t.mock.method(fs,'readdir',async(...args:Parameters<typeof fs.readdir>)=>{listed.push(path.relative(source,String(args[0])));return (readdir as (...values:unknown[])=>Promise<unknown>)(...args);});
 const {syncBuiltinESMExports}=await import('node:module');syncBuiltinESMExports();
 const {plan}=await import('../core');
 const read:string[]=[];
 const {plans:[transfer],listing}=await plan(source,[root],{backup:false,template:'{year}',layout:'flat' as const,unknownRules:{},reuse:scan.listing},async file=>{read.push(file);return {fields:{}};});
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.equal(transfer!.entries.find(entry=>entry.source===photo)!.size,Buffer.byteLength('a longer rewritten photo'));
 assert.deepEqual(listed.filter(folder=>!folder.startsWith('..')),['DCIM'],'only the stale file\'s folder is read again');
 assert.deepEqual(read.sort(),[photo,other].sort(),'each file is checked once: the plan is not run again');
 assert.equal(listing!.files.find(file=>file.relative===path.join('DCIM','DSC0.JPG'))!.size,Buffer.byteLength('a longer rewritten photo'),'the listing remembered for next time has the new size');
});

test('a folder-scoped listing reuses the whole-card record and returns no record of its own',async t=>{
 const source=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'scan-scoped-')));
 t.after(()=>fs.rm(source,{recursive:true,force:true}));
 for(const folder of ['100TEST','101TEST']){await fs.mkdir(path.join(source,'DCIM',folder),{recursive:true});for(let index=0;index<3;index++)await fs.writeFile(path.join(source,'DCIM',folder,`DSC${index}.JPG`),'photo');}
 const scan=await inventory(source,{});
 const listed:string[]=[],readdir=fs.readdir.bind(fs);
 t.mock.method(fs,'readdir',async(...args:Parameters<typeof fs.readdir>)=>{listed.push(String(args[0]));return (readdir as (...values:unknown[])=>Promise<unknown>)(...args);});
 const {syncBuiltinESMExports}=await import('node:module');syncBuiltinESMExports();
 const scoped=await inventory(source,{folders:[path.join('DCIM','101TEST')],reuse:scan.listing});
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.deepEqual(listed,[],'the unchanged folder comes from the whole-card record');
 assert.deepEqual(scoped.files.map(file=>file.relative).sort(),[0,1,2].map(index=>path.join('DCIM','101TEST',`DSC${index}.JPG`)));
 assert.equal(scoped.listing,undefined,'a partial listing never replaces the whole-card record');
 assert.equal(Object.hasOwn(scoped,'listing'),false);
});

test('a remembered folder whose names are unchanged is reused even when its timestamps moved, and a new name is never missed',async t=>{
 const source=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'scan-names-')));
 t.after(()=>fs.rm(source,{recursive:true,force:true}));
 const folder=path.join(source,'DCIM','100TEST');await fs.mkdir(folder,{recursive:true});
 for(let index=0;index<3;index++)await fs.writeFile(path.join(folder,`DSC${index}.JPG`),'photo');
 const scan=await inventory(source,{});
 const stamp=new Date('2026-01-01T00:00:00Z');
 await fs.utimes(folder,stamp,stamp);
 const lstat=fs.lstat.bind(fs),checked:string[]=[];
 t.mock.method(fs,'lstat',async(...args:Parameters<typeof fs.lstat>)=>{checked.push(String(args[0]));return (lstat as (...values:unknown[])=>Promise<unknown>)(...args);});
 const {syncBuiltinESMExports}=await import('node:module');syncBuiltinESMExports();
 const same=await inventory(source,{reuse:scan.listing});
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.deepEqual(same.files.map(file=>file.relative),scan.files.map(file=>file.relative));
 assert.ok(!checked.some(file=>file.endsWith('.JPG')),'unchanged names reuse the remembered files without a stat each');
 // A camera may add a file without updating the folder's stored timestamp.
 await fs.writeFile(path.join(folder,'DSC7.JPG'),'shot later');await fs.utimes(folder,stamp,stamp);
 const later=await inventory(source,{reuse:same.listing});
 assert.ok(later.files.some(file=>file.relative.endsWith('DSC7.JPG')));
});

test('a file emptied in place after the scan is not planned from the old listing',async t=>{
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'scan-emptied-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'card'),root=path.join(base,'disk'),photo=path.join(source,'DCIM','DSC0.JPG');
 await fs.mkdir(path.dirname(photo),{recursive:true});await fs.mkdir(root);await fs.writeFile(photo,'a photo');
 const scan=await inventory(source,{});
 await fs.writeFile(photo,'');
 const {plan}=await import('../core');
 const {plans:[transfer],failures}=await plan(source,[root],{backup:false,template:'{year}',layout:'flat' as const,unknownRules:{},reuse:scan.listing,skipErrors:true},async()=>({fields:{}}));
 assert.ok(!transfer!.entries.some(entry=>entry.source===photo),'an empty file is never imported');
 assert.ok(failures.some(failure=>failure.path===photo),'it is reported as changed');
});
