import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {plan,execute,findMisplaced,configureOrganizationRecovery} from '../core';
import type {ConflictNaming} from '../shared';
import {organizeAs} from './fixtures/records';
import {parts,put,temporary} from './fixtures/edge';

configureOrganizationRecovery('conflict-naming-host-recovery-secret-32bytes');
const camera='2024/202402/Fixture Camera';
const metadata=async()=>({camera:'Fixture Camera',date:'2024-02-03',fields:{}});
const rules=(conflictNaming?:ConflictNaming)=>({backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{},...(conflictNaming?{conflictNaming}:{})});
async function fixture(t:test.TestContext){
 const base=await temporary(t,'conflict-naming-'),source=path.join(base,'card'),root=path.join(base,'backup');
 await fs.mkdir(source);await fs.mkdir(root);
 const card=async(files:Record<string,string>)=>{await fs.rm(source,{recursive:true,force:true});for(const [name,content] of Object.entries(files))await put(path.join(source,name),content);};
 const prepare=async(naming?:ConflictNaming)=>(await plan(source,[root],rules(naming),metadata)).plans[0]!;
 const filed=async()=>(await fs.readdir(path.join(root,camera))).sort();
 return {base,source,root,card,prepare,filed,at:(name:string)=>path.join(root,camera,name)};
}
const names=(transfer:{entries:{destination:string}[]})=>transfer.entries.map(entry=>path.basename(entry.destination)).sort();

test('by default a different file with a taken name still goes to a Conflicts folder under its original name',async t=>{
 const f=await fixture(t);await put(f.at('IMG_0001.JPG'),'first');await f.card({'IMG_0001.JPG':'second'});
 const transfer=await f.prepare();
 assert.equal(path.relative(path.join(f.root,camera),transfer.entries[0]!.destination).split(path.sep)[0],'Conflicts');
 assert.equal(path.basename(transfer.entries[0]!.destination),'IMG_0001.JPG');
});

test('numbering: the second different file gets (1), the third (2), and importing them again adds nothing',async t=>{
 const f=await fixture(t);
 for(const content of ['first','second','third']){await f.card({'IMG_0001.JPG':content});assert.deepEqual((await execute(await f.prepare('number'))).errors,[]);}
 assert.deepEqual(await f.filed(),['IMG_0001 (1).JPG','IMG_0001 (2).JPG','IMG_0001.JPG']);
 assert.deepEqual(await Promise.all(['IMG_0001.JPG','IMG_0001 (1).JPG','IMG_0001 (2).JPG'].map(name=>fs.readFile(f.at(name),'utf8'))),['first','second','third']);
 for(const content of ['first','second','third']){
  await f.card({'IMG_0001.JPG':content});const again=await f.prepare('number');
  assert.ok(again.entries.every(entry=>entry.skip),content);assert.deepEqual(await execute(again),{copied:0,skipped:1,errors:[]});
 }
 assert.deepEqual(await f.filed(),['IMG_0001 (1).JPG','IMG_0001 (2).JPG','IMG_0001.JPG']);
});

test('numbering: two different same-name files on one card are filed as the name and (1)',async t=>{
 const f=await fixture(t);await f.card({'100CANON/IMG_0001.JPG':'one','101CANON/IMG_0001.JPG':'two'});
 const transfer=await f.prepare('number');assert.deepEqual(names(transfer),['IMG_0001 (1).JPG','IMG_0001.JPG']);
 assert.deepEqual((await execute(transfer)).errors,[]);assert.deepEqual(await f.filed(),['IMG_0001 (1).JPG','IMG_0001.JPG']);
});

test('numbering: a whole family shares one number, so its sidecars stay paired',async t=>{
 const f=await fixture(t);
 await put(f.at('DSC_0001.NEF'),'old raw');await put(f.at('C0004M01.XML'),'old xml');
 await f.card({'DSC_0001.NEF':'raw','DSC_0001.JPG':'jpg','DSC_0001.xmp':'xmp','DSC_0001.NEF.xmp':'acr','C0004.MP4':'clip','C0004M01.XML':'xml'});
 const transfer=await f.prepare('number');
 assert.deepEqual(names(transfer),['C0004 (1).MP4','C0004 (1)M01.XML','DSC_0001 (1).JPG','DSC_0001 (1).NEF','DSC_0001 (1).NEF.xmp','DSC_0001 (1).xmp']);
 assert.deepEqual((await execute(transfer)).errors,[]);
 assert.ok((await f.prepare('number')).entries.every(entry=>entry.skip),'importing the families again copies nothing');
});

test('numbering: a taken (1) with other content moves the whole family to (2)',async t=>{
 const f=await fixture(t);
 await put(f.at('DSC_0001.NEF'),'old raw');await put(f.at('DSC_0001 (1).xmp'),'someone else');
 await f.card({'DSC_0001.NEF':'raw','DSC_0001.xmp':'xmp'});
 assert.deepEqual(names(await f.prepare('number')),['DSC_0001 (2).NEF','DSC_0001 (2).xmp']);
});

test('numbering: a numbered name never exceeds 255 bytes',async t=>{
 const f=await fixture(t),name='é'.repeat(125)+'.JPG';
 await put(f.at(name),'first');await f.card({[name]:'second'});
 const [entry]=(await f.prepare('number')).entries,numbered=path.basename(entry!.destination);
 assert.ok(Buffer.byteLength(numbered)<=255,`${Buffer.byteLength(numbered)} bytes`);assert.match(numbered,/^é+ \(1\)\.JPG$/);
 assert.deepEqual((await execute((await f.prepare('number')))).errors,[]);
});

test('numbering: a serialized plan keeps the rule when another writer takes the name after planning',async t=>{
 const f=await fixture(t);await f.card({'IMG_0001.JPG':'mine'});
 const transfer=JSON.parse(JSON.stringify(await f.prepare('number')));
 await put(f.at('IMG_0001.JPG'),'late foreign file');
 assert.deepEqual(await execute(transfer),{copied:1,skipped:0,errors:[]});
 assert.deepEqual(await f.filed(),['IMG_0001 (1).JPG','IMG_0001.JPG']);assert.equal(await fs.readFile(f.at('IMG_0001 (1).JPG'),'utf8'),'mine');
 assert.deepEqual(await execute(await f.prepare('number')),{copied:0,skipped:1,errors:[]});
});

test('numbering: an interrupted copy to (1) is resumed at (1)',async t=>{
 const f=await fixture(t),data=Buffer.alloc(2*1024*1024+13,7);await put(f.at('IMG_0001.JPG'),'first');
 await fs.writeFile(path.join(f.source,'IMG_0001.JPG'),data);
 const transfer=await f.prepare('number'),destination=transfer.entries[0]!.destination,open=fs.open.bind(fs);let wrote=false;
 assert.equal(path.basename(destination),'IMG_0001 (1).JPG');
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const handle=await open(...args);if(String(args[0])===destination&&args[1]==='wx'){
  const write=handle.write.bind(handle);t.mock.method(handle,'write',async(buffer:Buffer,offset:number,length:number,position:number|null)=>{if(wrote)throw Object.assign(new Error('Injected power interruption'),{code:'EIO'});wrote=true;return write(buffer,offset,Math.min(length,4093),position);});
 }return handle;});syncBuiltinESMExports();
 const interrupted=await execute(transfer,undefined,undefined,{exclusiveCopy:true});t.mock.restoreAll();syncBuiltinESMExports();
 assert.equal(interrupted.errors.length,1);
 const resumed=await f.prepare('number');assert.equal(resumed.entries[0]!.destination,destination);
 assert.deepEqual((await execute(resumed)).errors,[]);assert.deepEqual(await fs.readFile(destination),data);
 assert.deepEqual(await f.filed(),['IMG_0001 (1).JPG','IMG_0001.JPG']);
});

test('numbering: organizing files a same-name file as (1) beside the one already in place, and nothing is left misplaced',async t=>{
 const base=await temporary(t,'conflict-naming-organize-'),library=path.join(base,'photobackup');
 await put(path.join(library,camera,'DSC_0002.JPG'),'in place');await put(path.join(library,'old/DSC_0002.JPG'),'misplaced');await put(path.join(library,'old/DSC_0002.xmp'),'its sidecar');
 const request={...rules('number'),reorganize:true as const};
 const {plans:[transfer]}=await plan(library,[library],request,metadata);
 for(const part of parts(transfer!))assert.deepEqual((await organizeAs('rename',part)).errors,[]);
 assert.deepEqual((await fs.readdir(path.join(library,camera))).sort(),['DSC_0002 (1).JPG','DSC_0002 (1).xmp','DSC_0002.JPG']);
 assert.equal(await fs.readFile(path.join(library,camera,'DSC_0002 (1).JPG'),'utf8'),'misplaced');
 assert.equal((await findMisplaced(library,library,request,metadata)).count,0);
});

test('numbering: a drive backup files a changed drive file as (1) beside the earlier copy',async t=>{
 const f=await fixture(t),backup=async()=>(await plan(f.source,[f.root],{backup:true,unknownRules:{},conflictNaming:'number'},metadata)).plans[0]!;
 await f.card({'DCIM/IMG_0001.JPG':'first'});assert.deepEqual((await execute(await backup())).errors,[]);
 await f.card({'DCIM/IMG_0001.JPG':'changed'});const transfer=await backup();
 assert.deepEqual(names(transfer),['IMG_0001 (1).JPG']);assert.equal(path.basename(path.dirname(transfer.entries[0]!.destination)),'DCIM');
 assert.deepEqual((await execute(transfer)).errors,[]);
});

test('numbering: a family member found elsewhere in the library keeps the rule, so the family never mixes Conflicts and (n)',async t=>{
 const f=await fixture(t);
 await put(f.at('DSC_0001.xmp'),'xmp');await put(path.join(f.root,'older rules/DSC_0001.JPG'),'jpg');
 await f.card({'DSC_0001.JPG':'jpg','DSC_0001.xmp':'xmp'});
 const transfer=await f.prepare('number'),jpg=transfer.entries.find(entry=>entry.source.endsWith('.JPG'))!;
 assert.equal(jpg.destination,path.join(f.root,'older rules/DSC_0001.JPG'),'the JPG is found under the older rules');
 assert.ok(transfer.entries.every(entry=>entry.allocation?.conflictNaming==='number'),JSON.stringify(transfer.entries.map(entry=>entry.allocation)));
});
