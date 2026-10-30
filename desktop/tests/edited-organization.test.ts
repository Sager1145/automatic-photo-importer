import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {plan,executeReorganization,configureOrganizationRecovery,getOrganizationRecovery,resumeOrganization} from '../core/index';
import {organizeByCopy} from './fixtures/records';
import type {MediaLayout} from '../shared';
configureOrganizationRecovery('edited-organization-fixture-key-32bytes');
const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
async function fixture(t:test.TestContext){const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'edited-organization-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));const source=path.join(base,'library'),target=path.join(source,'photobackup');await fs.mkdir(target,{recursive:true});const put=async(relative:string,contents='original')=>{const file=path.join(source,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,contents);return file;};return{base,source,target,put};}
const metadata=async(file:string)=>({camera:'ILCE-7M5',date:'2025-06-26T13:50:35+08:00',edited:file.endsWith('.JPG')||file.endsWith('.ARW'),fields:{}});
const originalMetadata=async()=>({camera:'ILCE-7M5',date:'2025-06-26T13:50:35+08:00',fields:{}});

for(const layout of ['flat','format','type-format','photos-flat','videos-flat','video-root'] as MediaLayout[])test(`${layout}: organization preserves exports already in the edited folder without editor metadata`,async t=>{
 const{source,target,put}=await fixture(t),editedFolder=layout==='video-root'?'Finished photos':'editied';
 const edited=`photobackup/2025/202506/${editedFolder}/ILCE-7M5`;
 for(const name of ['A.ARW','A.XMP','A.JPG','B.JPG','B.XMP'])await put(`${edited}/${name}`);
 const videos=path.join(source,'videobackup');await fs.mkdir(videos);
 const {plans:[transfer],failures}=await plan(source,[target],{...options,reorganize:true,layout,...(layout==='video-root'?{editedFolder}:{}),videoRoots:[videos]},originalMetadata);
 assert.deepEqual(failures,[]);
 assert.deepEqual(transfer.entries.map(entry=>path.basename(entry.source)).sort(),['A.ARW','A.XMP'],'JPEG exports and their sidecars stay in place');
 const raw=transfer.entries.find(entry=>entry.source.endsWith('.ARW'))!,sidecar=transfer.entries.find(entry=>entry.source.endsWith('.XMP'))!;
 assert.ok(!path.relative(target,raw.destination).split(path.sep).includes(editedFolder),'RAW remains an original');
 assert.equal(path.dirname(sidecar.destination),path.dirname(raw.destination),'RAW sidecar follows its original');
 if(layout==='flat'){
  assert.deepEqual((await executeReorganization(transfer)).errors,[]);
  for(const name of ['A.JPG','B.JPG','B.XMP'])assert.equal(await fs.readFile(path.join(source,edited,name),'utf8'),'original');
  const again=await plan(source,[target],{...options,reorganize:true},originalMetadata);
  assert.deepEqual(again.failures,[]);assert.deepEqual(again.plans[0].entries,[],'a second organization has nothing left to move');
 }
});

test('an import source folder named editied does not classify unedited media as exports',async t=>{
 const{source,base,put}=await fixture(t),target=path.join(base,'external');await fs.mkdir(target);
 await put('editied/A.JPG');await put('editied/A.XMP');
 const {plans:[transfer],failures}=await plan(source,[target],options,originalMetadata);
 assert.deepEqual(failures,[]);
 assert.deepEqual(transfer.entries.map(entry=>path.relative(target,entry.destination)).sort(),['2025/202506/ILCE-7M5/A.JPG','2025/202506/ILCE-7M5/A.XMP']);
});

test('a duplicate record is edited exactly when its file is routed as an edited export',async t=>{
 const{source,base,put}=await fixture(t),target=path.join(base,'external');await fs.mkdir(target);
 await put('editied/A.JPG','one');await put('other/A.JPG','two');
 const {plans:[transfer],duplicates,failures}=await plan(source,[target],{...options,duplicates:true},originalMetadata);
 assert.deepEqual(failures,[]);
 assert.ok(transfer.entries.every(entry=>!path.relative(target,entry.destination).split(path.sep).includes('editied')),'a source folder name does not route an import to the edited folder');
 assert.deepEqual(duplicates!.files.map(file=>file.edited),[false,false],'the records say the same');
 const exported=await plan(source,[target],{...options,duplicates:true},async file=>({camera:'ILCE-7M5',date:'2025-06-26T13:50:35+08:00',edited:file.includes('other'),fields:{}}));
 for(const file of exported.duplicates!.files)assert.equal(file.edited,file.path.includes('other'));
 assert.ok(exported.plans[0].entries.every(entry=>entry.source.includes('other')===path.relative(target,entry.destination).split(path.sep).includes('editied')));
});

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
 const {plans}=await plan(source,[target],{...options,reorganize:true},metadata);const result=await organizeByCopy(plans[0]);assert.deepEqual(result.errors,[]);
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


test('catalog classification and the read-only check agree for edited exports without editor metadata',async t=>{
 const{source,target,put}=await fixture(t),relative='2025/202506/editied/ILCE-7M5/A.JPG',file=await put(`photobackup/${relative}`);
 const {evaluateRoutes,classifyPlacement}=await import('../core/folder-rules'),{findMisplaced}=await import('../core/index');
 const stat=await fs.stat(file),info=await originalMetadata(),entry={path:file,relative:path.relative(source,file),size:stat.size,kind:'JPEG' as const,included:true};
 const [route]=evaluateRoutes({sourceRoot:source,files:[entry],metadata:new Map([[file,info]]),mtimes:new Map([[file,stat.mtime]]),roots:[{root:target,role:'photos'}],options:{...options,reorganize:true}});
 assert.equal(classifyPlacement({route,actual:{root:'photos',relativePath:relative},rulesScope:'current'}).status,'inPlace');
 assert.equal((await findMisplaced(source,target,options,originalMetadata)).count,0);
});
