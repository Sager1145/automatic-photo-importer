import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PriorTable,PriorStore,layeredBook,driveClass,type PriorContext} from '../eta-priors';
import {defaultBook} from '../eta-model';

const SALT='c2FsdHNhbHRzYWx0c2FsdA';
const card={id:'UUID-CARD-1234-ABCD',transport:'usb',fsType:'exfat',external:true},backup={id:'UUID-BACKUP-9999',transport:'usb',fsType:'exfat',external:true};
const context:PriorContext={source:card,destinations:[backup]};
const summary=(over:Partial<{a:number;b:number;T:number;F:number;G:number;observed:number;shared:number}>={})=>({a:0.1,b:40,T:600,F:3000,G:12,observed:600,shared:0,...over});

test('a finished step is remembered per drive pair and per drive class',()=>{
 const table=new PriorTable(SALT);
 table.update('verifying:copy',context,summary(),'2026-10-22');
 const exact=table.lookup('verifying:copy',context,'exact');
 assert.ok(exact&&Math.abs(exact.a-0.1)<1e-9&&Math.abs(exact.b-40)<1e-9&&exact.runs===1);
 // another card of the same kind on the same destination: class history only
 const other:PriorContext={source:{...card,id:'OTHER'},destinations:[backup]};
 assert.equal(table.lookup('verifying:copy',other,'exact'),undefined);
 assert.ok(table.lookup('verifying:copy',other,'class'));
 assert.equal(table.lookup('copying',context,'exact'),undefined);
});

test('a folder source is remembered by class only',()=>{
 const table=new PriorTable(SALT),folder:PriorContext={source:{transport:'folder',fsType:'apfs',external:false},destinations:[backup]};
 table.update('copying',folder,summary(),'2026-10-22');
 assert.equal(table.lookup('copying',folder,'exact'),undefined);
 assert.ok(table.lookup('copying',folder,'class'));
});

test('log blending moves toward new runs at weight max(0.25, 1/(runs+1))',()=>{
 const table=new PriorTable(SALT);
 table.update('copying',context,summary({a:0.02,b:10}),'2026-10-20');
 table.update('copying',context,summary({a:0.08,b:40}),'2026-10-21');
 const second=table.lookup('copying',context,'exact')!;
 // runs=1 -> w=0.5: geometric mean
 assert.ok(Math.abs(second.a-Math.sqrt(0.02*0.08))<1e-9&&Math.abs(second.b-20)<1e-9,`${second.a} ${second.b}`);
 assert.equal(second.runs,2);
 for(let i=0;i<10;i++)table.update('copying',context,summary({a:0.02,b:10}),'2026-10-22');
 const w=0.25,before=table.lookup('copying',context,'exact')!;
 table.update('copying',context,summary({a:0.16,b:80}),'2026-10-22');
 const after=table.lookup('copying',context,'exact')!;
 assert.ok(Math.abs(after.b-Math.exp((1-w)*Math.log(before.b)+w*Math.log(80)))<1e-9);
});

test('short, small or shared steps are not saved',()=>{
 const table=new PriorTable(SALT);
 table.update('copying',context,summary({observed:29}),'2026-10-22');
 table.update('copying',context,summary({F:19,G:0.5}),'2026-10-22');
 table.update('copying',context,summary({shared:0.21}),'2026-10-22');
 assert.equal(table.size,0);
 table.update('copying',context,summary({F:10,G:1}),'2026-10-22');
 assert.equal(table.size,2,'one gigabyte is enough: exact and class entries');
});

test('runs that differ in bytes per file refit the coefficients from the summaries',()=>{
 const table=new PriorTable(SALT);
 // truth: a=0.01 s/file, b=10 s/GB
 const run=(F:number,G:number)=>{const T=0.01*F+10*G;table.update('copying',context,summary({a:0.5,b:0.5,T,F,G,observed:T}),'2026-10-22');};
 run(10000,1);
 run(1000,40);
 const fit=table.lookup('copying',context,'exact')!;
 assert.ok(Math.abs(fit.a-0.01)<0.002&&Math.abs(fit.b-10)<0.5,`${fit.a} ${fit.b}`);
 assert.ok(fit.a>=0&&fit.b>=0);
});

test('the table holds at most 200 entries and evicts the least recently updated',()=>{
 const table=new PriorTable(SALT);
 for(let i=0;i<250;i++)table.update('copying',{source:{...card,id:'S'+i},destinations:[backup]},summary(),new Date(Date.UTC(2026,0,1+i)).toISOString().slice(0,10));
 assert.equal(table.size,200);
 table.update('copying',{source:{...card,id:'NEWEST'},destinations:[backup]},summary(),'2026-10-22');
 assert.ok(table.size<=200);
 assert.equal(table.lookup('copying',{source:{...card,id:'S0'},destinations:[backup]},'exact'),undefined,'the oldest is gone');
 assert.ok(table.lookup('copying',{source:{...card,id:'NEWEST'},destinations:[backup]},'exact'),'the newest survives');
 assert.equal(table.toJSON().v,5);assert.equal(table.toJSON().kind,'eta');
});

test('the saved file has no paths, names or raw ids, and round trips',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'eta-priors-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'eta-priors.json'),store=new PriorStore(file,()=>SALT);
 await store.load();
 store.table.update('verifying:copy',context,summary(),'2026-10-22');
 await store.save();
 const text=await fs.readFile(file,'utf8');
 for(const forbidden of ['/','\\','UUID-CARD','UUID-BACKUP','CARD','BACKUP'])assert.ok(!text.includes(forbidden),`file contains ${forbidden}: ${text}`);
 assert.equal((await fs.stat(file)).mode&0o777,0o600);
 assert.deepEqual((await fs.readdir(dir)).sort(),['eta-priors.json'],'no temporary file is left');
 const again=new PriorStore(file,()=>'other');await again.load();
 assert.ok(again.table.lookup('verifying:copy',context,'exact'),'the same salt maps the same ids');
});

test('unreadable, garbage or wrongly shaped files give empty defaults and never throw',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'eta-priors-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 for(const content of ['','not json','{"version":2}','{"version":1,"salt":5,"entries":[]}','{"version":1,"salt":"x","entries":{"a|b":{"a":"x"}}}','null']){
  const file=path.join(dir,'p.json');await fs.writeFile(file,content);
  const store=new PriorStore(file,()=>SALT);await store.load();
  assert.equal(store.table.size,0,content);
 }
 const missing=new PriorStore(path.join(dir,'nope','p.json'),()=>SALT);await missing.load();
 assert.equal(missing.table.size,0);
 await missing.save().catch(()=>{});
});

test('saving is limited to once per 30 s and only when something changed',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'eta-priors-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'p.json'),store=new PriorStore(file,()=>SALT);await store.load();
 assert.equal(await store.maybeSave(0),false,'nothing changed');
 store.table.update('copying',context,summary(),'2026-10-22');
 assert.equal(await store.maybeSave(1000),true);
 store.table.update('verifying:copy',context,summary(),'2026-10-22');
 assert.equal(await store.maybeSave(20_000),false,'too soon');
 assert.equal(await store.maybeSave(31_000),true);
});

test('the book looks up session exact, saved exact, session class, saved class, then defaults',()=>{
 const session=new PriorTable('a'),saved=new PriorTable('b');
 const book=()=>layeredBook(context,session,saved,defaultBook()).lookup('copying');
 assert.equal(book().level,'default');
 saved.update('copying',{source:{...card,id:'X'},destinations:[backup]},summary({a:0.3,b:30}),'2026-10-01');
 assert.equal(book().level,'class');assert.ok(Math.abs(book().coef.b-30)<1e-9);
 session.update('copying',{source:{...card,id:'Y'},destinations:[backup]},summary({a:0.2,b:20}),'2026-10-02');
 assert.ok(Math.abs(book().coef.b-20)<1e-9,'session class before saved class');
 saved.update('copying',context,summary({a:0.1,b:10}),'2026-10-03');
 assert.ok(Math.abs(book().coef.b-10)<1e-9);assert.equal(book().level,'exact');
 session.update('copying',context,summary({a:0.05,b:5}),'2026-10-04');
 assert.ok(Math.abs(book().coef.b-5)<1e-9,'session exact first');
 assert.equal(book().T0,20,'one run is weighted as defaults');
 session.update('copying',context,summary({a:0.05,b:5}),'2026-10-05');
 assert.equal(book().T0,60,'two runs count for more');
});

test('drive classes name the transport, the file system and whether it is external',()=>{
 assert.equal(driveClass({transport:'USB',fsType:'ExFAT',external:true}),'usb:exfat:ext');
 assert.equal(driveClass({}),'unknown:unknown:int');
 assert.ok(!driveClass({transport:'a/b',fsType:'c\\d'}).match(/[\\/]/));
});
