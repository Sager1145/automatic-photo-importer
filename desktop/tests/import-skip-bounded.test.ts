import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {plan} from '../core';
import type {Metadata} from '../shared';

const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2024-02-03T12:00:00Z',fields:{}});
const SIZE=200_000;
/** An uncompressed-RAW-like file: the same first 64 KB for every `seed`, different afterwards. */
const raw=(seed:number)=>{const data=Buffer.alloc(SIZE,1);data.fill(seed&255,70_000);data[SIZE-1]=seed>>8;return data;};
/** Different from the very first byte. */
const early=(seed:number)=>{const data=Buffer.alloc(SIZE,2);data.fill(seed&255,0,100);data[10]=seed>>8;data[0]=seed&255;return data;};
async function fixture(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'skip-bounded-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),root=path.join(base,'backup'),old=path.join(root,'2024/202402/Unknown Camera');
 await fs.mkdir(source);await fs.mkdir(old,{recursive:true});
 return {base,source,root,old};
}
const opens=(t:test.TestContext,folder:string)=>{
 const counts=new Map<string,number>(),original=fs.open.bind(fs);
 t.mock.method(fs,'open',(async(...args:Parameters<typeof fs.open>)=>{const name=String(args[0]);if(name.startsWith(folder))counts.set(name,(counts.get(name)??0)+1);return original(...args);}) as typeof fs.open);
 syncBuiltinESMExports();
 return counts;
};

test('many same-size candidates are each read at most twice (prefix, then in full) however many files share the size',async t=>{
 const f=await fixture(t);
 for(let i=0;i<3;i++)await fs.writeFile(path.join(f.source,`S${i}.ARW`),raw(100+i));
 for(let i=0;i<30;i++)await fs.writeFile(path.join(f.old,`C${i}.ARW`),raw(i));
 const reads=opens(t,f.old);
 const {plans,failures}=await plan(f.source,[f.root],options,metadata);
 assert.deepEqual(failures,[]);
 assert.ok(plans[0]!.entries.every(entry=>!entry.skip),'no candidate has the same bytes');
 assert.equal(reads.size,30);
 for(const [file,count] of reads) assert.ok(count<=2,`${file} was opened ${count} times`);
});

test('a candidate that differs in its first 64 KB is never read in full',async t=>{
 const f=await fixture(t);
 for(let i=0;i<3;i++)await fs.writeFile(path.join(f.source,`S${i}.ARW`),raw(100+i));
 for(let i=0;i<10;i++)await fs.writeFile(path.join(f.old,`C${i}.ARW`),early(i));
 const reads=opens(t,f.old);
 await plan(f.source,[f.root],options,metadata);
 for(const [file,count] of reads) assert.equal(count,1,`${file} was opened ${count} times`);
});

test('the full SHA-256 stays the proof: equal prefix and size, other bytes, is copied; identical bytes are found among many',async t=>{
 const f=await fixture(t);
 await fs.writeFile(path.join(f.source,'S.ARW'),raw(7));
 for(let i=0;i<20;i++)await fs.writeFile(path.join(f.old,`C${i}.ARW`),raw(i===13?7:1000+i));
 const {plans}=await plan(f.source,[f.root],options,metadata);
 const [entry]=plans[0]!.entries;
 assert.equal(entry!.skip,true);assert.equal(entry!.destination,path.join(f.old,'C13.ARW'));
 assert.equal(entry!.digest,createHash('sha256').update(raw(7)).digest('hex'));
});

test('a size group over the candidate limit is skipped and reported, and nothing in it is read',async t=>{
 const f=await fixture(t);
 await fs.writeFile(path.join(f.source,'S.ARW'),raw(7));
 for(let i=0;i<10;i++)await fs.writeFile(path.join(f.old,`C${i}.ARW`),raw(i===3?7:i));
 const reads=opens(t,f.old);
 const {plans,elsewhere}=await plan(f.source,[f.root],{...options,elsewhereLimits:{candidates:5}},metadata);
 assert.equal(plans[0]!.entries[0]!.skip,false);
 assert.deepEqual(elsewhere!.skipped,[{size:SIZE,candidates:10}]);
 assert.equal(reads.size,0);
});

test('a size group whose projected bytes exceed the limit is skipped and reported',async t=>{
 const f=await fixture(t);
 await fs.writeFile(path.join(f.source,'S.ARW'),raw(7));
 for(let i=0;i<4;i++)await fs.writeFile(path.join(f.old,`C${i}.ARW`),raw(i===3?7:i));
 const {plans,elsewhere}=await plan(f.source,[f.root],{...options,elsewhereLimits:{bytes:3*SIZE}},metadata);
 assert.equal(plans[0]!.entries[0]!.skip,false);assert.equal(elsewhere!.skipped.length,1);
 const within=await plan(f.source,[f.root],{...options,elsewhereLimits:{bytes:4*SIZE}},metadata);
 assert.equal(within.plans[0]!.entries[0]!.skip,true);assert.deepEqual(within.elsewhere!.skipped,[]);
});

test('a file that stays keeps the checksum the lookup computed',async t=>{
 const f=await fixture(t),data=raw(7);
 await fs.writeFile(path.join(f.source,'S.ARW'),data);await fs.writeFile(path.join(f.old,'C.ARW'),raw(8));
 const {plans}=await plan(f.source,[f.root],options,metadata);
 assert.equal(plans[0]!.entries[0]!.skip,false);assert.equal(plans[0]!.entries[0]!.digest,createHash('sha256').update(data).digest('hex'));
});

test('a copy in a Conflicts folder is not proof',async t=>{
 const f=await fixture(t),data=raw(7);
 await fs.writeFile(path.join(f.source,'S.ARW'),data);
 await fs.mkdir(path.join(f.old,'Conflicts/abc'),{recursive:true});await fs.writeFile(path.join(f.old,'Conflicts/abc/S.ARW'),data);
 const {plans}=await plan(f.source,[f.root],options,metadata);
 assert.equal(plans[0]!.entries[0]!.skip,false);assert.equal(plans[0]!.entries[0]!.routed,undefined);
});
