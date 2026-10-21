import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {inventory,plan,execute} from '../core';
import type {Metadata,UnknownFileRule} from '../shared';

const options={backup:false,template:'{year}/{yyyymm}/{camera}',separateMedia:false,unknownRules:{}};
const cameraRule={action:'camera' as const};
async function fixture(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'photo-unknown-camera-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),root=path.join(base,'destination');
 await fs.mkdir(source);await fs.mkdir(root);
 const put=async(relative:string,contents='original')=>{const file=path.join(source,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,contents);await fs.utimes(file,new Date('2020-12-15T12:00:00Z'),new Date('2020-12-15T12:00:00Z'));return file;};
 return {source,root,put};
}
const metadata=async():Promise<Metadata>=>({camera:'Nikon Z6',date:'2024-02-03T12:00:00',fields:{}});

test('unknown camera files remain excluded until an explicit camera rule includes and copies them',async t=>{
 const {source,root,put}=await fixture(t);await put('DCIM/100NIKON/A.NEF','raw');const unknown=await put('DCIM/100NIKON/INDEX01.DSC','camera data');
 const defaultPlan=await plan(source,[root],options,metadata);
 assert.equal(defaultPlan.inventory.files.find(file=>file.path===unknown)?.included,false);
 assert.equal(defaultPlan.plans[0].entries.length,1);
 const {inventory:scan,plans}=await plan(source,[root],{...options,unknownRules:{dsc:cameraRule}},metadata);
 assert.equal(scan.files.find(file=>file.path===unknown)?.included,true);
 assert.equal(plans[0].entries.find(entry=>entry.source===unknown)?.destination,path.join(root,'2024/202402/Nikon Z6/INDEX01.DSC'));
 assert.deepEqual(await execute(plans[0]),{copied:2,skipped:0,errors:[]});
 assert.equal(await fs.readFile(path.join(root,'2024/202402/Nikon Z6/INDEX01.DSC'),'utf8'),'camera data');
 assert.equal(await fs.readFile(unknown,'utf8'),'camera data');
});

test('inventory includes explicit camera rules while null rules leave unknown files excluded',async t=>{
 const {source,put}=await fixture(t);await put('INDEX01.DSC');await put('INDEX.DAT');
 const scan=await inventory(source,{unknownRules:{'.DSC':cameraRule,dat:null}});
 assert.equal(scan.files.find(file=>file.relative==='INDEX01.DSC')?.included,true);
 assert.equal(scan.files.find(file=>file.relative==='INDEX.DAT')?.included,false);
 assert.equal(scan.unknown,2);
});

test('camera-card inventory applies camera, folder and exclusion rules the same way as folder sources',async t=>{
 const {source,put}=await fixture(t);await put('INDEX01.DSC');await put('INDEX.DAT');await put('NOTES.TXT');
 const scan=await inventory(source,{unknownRules:{dsc:cameraRule,dat:'Custom/Files',txt:null}});
 assert.equal(scan.files.find(file=>file.relative==='INDEX01.DSC')?.included,true);
 assert.equal(scan.files.find(file=>file.relative==='INDEX.DAT')?.included,true);
 assert.equal(scan.files.find(file=>file.relative==='NOTES.TXT')?.included,false);
});

test('unknown files route to their own DCIM camera and mixed card root files stay unknown',async t=>{
 const {source,root,put}=await fixture(t);
 await put('DCIM/100NIKON/A.NEF');const nikon=await put('DCIM/100NIKON/INDEX.DSC');
 await put('DCIM/200SONY/A.ARW');const sony=await put('DCIM/200SONY/INDEX.DSC');
 const mixed=await put('INDEX.DSC');
 const {plans}=await plan(source,[root],{...options,unknownRules:{dsc:cameraRule}},async file=>({camera:file.endsWith('.NEF')?'Nikon Z6':'Sony A7',date:file.endsWith('.NEF')?'2024-02-03T12:00:00':'2025-03-04T12:00:00',fields:{}}));
 const destination=(source:string)=>plans[0].entries.find(entry=>entry.source===source)?.destination;
 assert.equal(destination(nikon),path.join(root,'2024/202402/Nikon Z6/INDEX.DSC'));
 assert.equal(destination(sony),path.join(root,'2025/202503/Sony A7/INDEX.DSC'));
 assert.equal(destination(mixed),path.join(root,'2020/202012/Unknown Camera/INDEX.DSC'));
});

test('a single-camera card supplies context for root unknowns without treating them as edited exports',async t=>{
 const {source,root,put}=await fixture(t);await put('DCIM/100NIKON/A.JPG');const unknown=await put('INDEX01.DSC');
 const {plans}=await plan(source,[root],{...options,separateMedia:true,unknownRules:{dsc:cameraRule}},async()=>({...await metadata(),edited:true}));
 assert.equal(plans[0].entries.find(entry=>entry.source===unknown)?.destination,path.join(root,'2024/202402/Nikon Z6/Other/INDEX01.DSC'));
 assert.ok(plans[0].entries.find(entry=>entry.kind==='JPEG')?.destination.includes('editied'));
 assert.ok(!plans[0].entries.find(entry=>entry.source===unknown)?.family.startsWith('edited:'));
});

test('unknown-only cards use Unknown Camera and the unknown file modification month',async t=>{
 const {source,root,put}=await fixture(t);const unknown=await put('INDEX01.DSC');
 const {plans}=await plan(source,[root],{...options,unknownRules:{dsc:cameraRule}},async()=>{throw new Error('Unknown files must not be inspected as media');});
 assert.equal(plans[0].entries[0]?.source,unknown);
 assert.equal(plans[0].entries[0]?.destination,path.join(root,'2020/202012/Unknown Camera/INDEX01.DSC'));
});

test('one camera spanning capture months supplies its camera but falls back to unknown file date',async t=>{
 const {source,root,put}=await fixture(t);await put('DCIM/A.NEF');await put('DCIM/B.NEF');const unknown=await put('DCIM/INDEX01.DSC');
 const {plans}=await plan(source,[root],{...options,unknownRules:{dsc:cameraRule}},async file=>({...await metadata(),date:file.endsWith('A.NEF')?'2024-02-03T12:00:00':'2024-03-04T12:00:00'}));
 assert.equal(plans[0].entries.find(entry=>entry.source===unknown)?.destination,path.join(root,'2020/202012/Nikon Z6/INDEX01.DSC'));
});

test('camera imports honor chosen folders and library organization still excludes unknowns',async t=>{
 const {source,root,put}=await fixture(t);await put('A.NEF');await put('INDEX01.DSC');await put('INDEX.DAT');
 const {plans}=await plan(source,[root],{...options,unknownRules:{dsc:'Custom/Files',dat:cameraRule}},metadata);
 assert.deepEqual(plans[0].entries.map(entry=>path.relative(root,entry.destination)).sort(),['2024/202402/Nikon Z6/A.NEF','2024/202402/Nikon Z6/INDEX.DAT','Custom/Files/INDEX01.DSC']);
 const organization=await plan(source,[source],{...options,reorganize:true,unknownRules:{dsc:cameraRule,dat:'Custom/Files'}},metadata);
 assert.deepEqual(organization.plans[0].entries.map(entry=>path.basename(entry.source)),['A.NEF']);
});

test('corrupt unknown rules are rejected instead of enabling camera imports',async t=>{
 const {source,root,put}=await fixture(t);await put('INDEX01.DSC');
 for(const corrupt of [{action:'copy'},{action:'camera',folder:'Custom'},[],true,42]){
  const unknownRules={dsc:corrupt} as unknown as Record<string,UnknownFileRule>;
  await assert.rejects(inventory(source,{unknownRules}),/Invalid unknown file rule/);
  await assert.rejects(plan(source,[root],{...options,unknownRules},metadata),/Invalid unknown file rule/);
 }
});

test('invalid media capture dates never supply a month for unknown camera files',async t=>{
 const {source,root,put}=await fixture(t);await put('A.NEF');const unknown=await put('INDEX01.DSC');
 const {plans}=await plan(source,[root],{...options,unknownRules:{dsc:cameraRule}},async()=>({...await metadata(),date:'2024-02-03invalid'}));
 assert.equal(plans[0].entries.find(entry=>entry.source===unknown)?.destination,path.join(root,'2020/202012/Nikon Z6/INDEX01.DSC'));
});
