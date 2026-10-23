import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {plan,executeReorganization,configureOrganizationRecovery,getOrganizationRecovery,resumeOrganization} from '../core/index';
configureOrganizationRecovery('edited-organization-fixture-key-32bytes');
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
async function fixture(t:test.TestContext){const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'edited-organization-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));const source=path.join(base,'library'),target=path.join(source,'photobackup');await fs.mkdir(target,{recursive:true});const put=async(relative:string,contents='original')=>{const file=path.join(source,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,contents);return file;};return{base,source,target,put};}
const metadata=async(file:string)=>({camera:'ILCE-7M5',date:'2025-06-26T13:50:35+08:00',edited:file.endsWith('.JPG')||file.endsWith('.ARW'),fields:{}});

test('editor exports use monthly editable folder while RAW and its XMP remain originals',async t=>{
 const{source,target,put}=await fixture(t);await put('2025/wrong/DSC0001.ARW');await put('2025/wrong/DSC0001.XMP');await put('2025/wrong/DSC0001.JPG');
 const prepared=await plan(source,[target],{...options,reorganize:true},metadata);
 const relative=Object.fromEntries(prepared.plans[0].entries.map(entry=>[path.extname(entry.source),path.relative(target,entry.destination)]));
 assert.equal(relative['.ARW'],'2025/202506/ILCE-7M5/DSC0001.ARW');assert.equal(relative['.XMP'],'2025/202506/ILCE-7M5/DSC0001.XMP');assert.equal(relative['.JPG'],'2025/202506/editied/ILCE-7M5/DSC0001.JPG');
 const custom=await plan(source,[target],{...options,reorganize:true,editedFolder:'Finished photos'},metadata);
 assert.ok(custom.plans[0].entries.find(entry=>entry.source.endsWith('.JPG'))?.destination.includes('/202506/Finished photos/'));
 await assert.rejects(plan(source,[target],{...options,reorganize:true,editedFolder:'../escape'},metadata));
});

test('camera-card planning honors remembered folder rules for nonmedia and keeps associated metadata',async t=>{
 const{source,put,base}=await fixture(t);const target=path.join(base,'external');await fs.mkdir(target);await put('DCIM/A.ARW');await put('DCIM/A.XMP');await put('DCIM/INDEX01.DSC');await put('DCIM/INDEX.DAT');await put('DCIM/._A.JPG');
 const result=await plan(source,[target],{...options,unknownRules:{dsc:'Camera indexes',dat:null}},metadata);
 const destinations=new Map(result.plans[0].entries.map(entry=>[path.basename(entry.source),path.relative(target,entry.destination)]));
 assert.deepEqual([...destinations.keys()].sort(),['A.ARW','A.XMP','INDEX01.DSC']);
 assert.equal(destinations.get('INDEX01.DSC'),path.join('Camera indexes','INDEX01.DSC'));
});

test('organization merges exact duplicates, retains different content and removes only empty obsolete folders; resume still verifies',async t=>{
 const{source,target,put}=await fixture(t);const original=await put('2025/Wrong camera/A.ARW','same');const conflict=await put('2025/Wrong camera/B.ARW','different');await put('2025/Keep notes/readme.txt','keep');
 await put('photobackup/2025/202506/ILCE-7M5/A.ARW','same');await put('photobackup/2025/202506/ILCE-7M5/B.ARW','existing');
 const {plans}=await plan(source,[target],{...options,reorganize:true},metadata);const result=await executeReorganization(plans[0]);assert.deepEqual(result.errors,[]);
 await assert.rejects(fs.stat(original),{code:'ENOENT'});await assert.rejects(fs.stat(conflict),{code:'ENOENT'});await assert.rejects(fs.stat(path.dirname(original)),{code:'ENOENT'});
 assert.equal(await fs.readFile(path.join(source,'2025/Keep notes/readme.txt'),'utf8'),'keep');
 assert.equal(await fs.readFile(path.join(target,'2025/202506/ILCE-7M5/B.ARW'),'utf8'),'existing');
 const recoveries=await getOrganizationRecovery(target);assert.equal(recoveries[0].status,'complete');assert.deepEqual((await resumeOrganization(target,recoveries[0].id)).errors,[]);
 const contents:string[]=[];async function walk(folder:string){for(const entry of await fs.readdir(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory())await walk(file);else contents.push(await fs.readFile(file,'utf8'));}}await walk(path.join(target,'Photo Importer Data','Organizations'));assert.ok(contents.includes('same'));assert.ok(contents.includes('different'));
});

test('a selected legacy-folder scope excludes unrelated roots and rejects traversal',async t=>{
 const{source,target,put}=await fixture(t);await put('2024/A.ARW');await put('2025/B.ARW');await put('untouched/C.ARW');
 const selected=await plan(source,[target],{...options,reorganize:true,sourceFolders:['2024','2025']},metadata);
 assert.deepEqual(selected.plans[0].entries.map(entry=>path.basename(entry.source)).sort(),['A.ARW','B.ARW']);
 await assert.rejects(plan(source,[target],{...options,reorganize:true,sourceFolders:['../']},metadata));
});

test('selected folder scope rejects symbolic-link aliases instead of widening its scan',async t=>{
 const{source,target,put}=await fixture(t);await put('2024/A.ARW');await put('untouched/B.ARW');await fs.symlink(source,path.join(source,'alias'),'dir');
 await assert.rejects(plan(source,[target],{...options,reorganize:true,sourceFolders:['alias']},metadata),/symbolic link/i);
});
