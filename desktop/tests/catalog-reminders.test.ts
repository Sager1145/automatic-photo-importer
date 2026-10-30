import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openCatalog} from '../catalog/store';
import {bindLibrary,CatalogCoordinator} from '../catalog/coordinator';
import {resolveCatalogFile} from '../catalog/access';
import type {CatalogQuery} from '../catalog/types';

test('rule changes invalidate only placement, reuse original EXIF and keep offline reminders read-only',async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'catalog-reminders-'))),root=path.join(dir,'photos'),catalog=openCatalog(':memory:');
 let reads=0,template='{year}/{camera}';const warnings:unknown[]=[];
 const query=(libraryId:string):CatalogQuery=>({libraryId,filters:[],sort:{field:'name',direction:'asc'},limit:200});
 try{
  const names=['2024/Canon/A.jpg','loose/B.jpg','wrong/C.jpg'];
  for(const name of names){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),'original '+name);}
  const before=await Promise.all(names.map(async name=>{const file=path.join(root,name),stat=await fs.stat(file,{bigint:true});return {name,bytes:(await fs.readFile(file)).toString('hex'),size:stat.size,mtime:stat.mtimeNs,ctime:stat.ctimeNs};}));
  const makeBinding=(scope:string)=>bindLibrary({root,mountPath:dir,volumeId:'photo-disk',name:'Photos',role:'photos',rulesScope:scope,online:true});
  const first=await makeBinding('rules-one');
  const coordinator=new CatalogCoordinator(catalog,{metadata:async file=>{reads++;return path.basename(file)==='B.jpg'?{fields:{}}:{fields:{},camera:path.basename(file)==='A.jpg'?'Canon':'Nikon',date:'2024-02-03T12:00:00',exposure:{aperture:2.8,iso:100}};},options:()=>({template,layout:'flat',reorganize:true,noMetadata:'keep'}),warning:error=>warnings.push(error)});
  await coordinator.configure([first]);await coordinator.refresh(first.library.libraryId,new AbortController().signal);
  let status=await coordinator.status(first.library.libraryId);
  assert.deepEqual([status.total,status.checked,status.misplaced,status.unclassifiable,status.unchecked],[3,3,1,1,0]);
  assert.equal(reads,3);
  template='{camera}/{year}';const next=await makeBinding('rules-two');await coordinator.configure([next]);
  status=await coordinator.status(next.library.libraryId);assert.equal(status.unchecked,3);assert.equal(status.checked,0);
  await coordinator.refresh(next.library.libraryId,new AbortController().signal);
  status=await coordinator.status(next.library.libraryId);assert.equal(reads,3,'A folder-rule change must not read EXIF again');
  assert.deepEqual([status.checked,status.misplaced,status.unclassifiable,status.unchecked],[3,2,1,0]);
  const page=await catalog.query(query(next.library.libraryId));
  assert.equal(page.rows.find(row=>row.name==='A.jpg')?.values.captureDay,'2024-02-03');
  assert.equal(page.rows.find(row=>row.name==='A.jpg')?.placement.expectedRoute?.relativePath,'Canon/2024/A.jpg');
  assert.equal(page.rows.find(row=>row.name==='B.jpg')?.placement.status,'unclassifiable');
  await coordinator.configure([{...next,library:{...next.library,online:false}}]);
  assert.equal((await coordinator.status(next.library.libraryId)).online,false);
  assert.equal((await catalog.query(query(next.library.libraryId))).total,3,'Offline cached results remain available');
  await assert.rejects(resolveCatalogFile(catalog,coordinator.binding(next.library.libraryId),page.rows[0]!.fileId,async()=>true));
  assert.equal(reads,3);assert.equal(warnings.length,0,'Routine rule changes must not create repeated warning popups');
  const after=await Promise.all(names.map(async name=>{const file=path.join(root,name),stat=await fs.stat(file,{bigint:true});return {name,bytes:(await fs.readFile(file)).toString('hex'),size:stat.size,mtime:stat.mtimeNs,ctime:stat.ctimeNs};}));
  assert.deepEqual(after,before,'Classification only changes the local index, never files or their names');
  assert.deepEqual((await fs.readdir(root)).sort(),['2024','loose','wrong']);
 }finally{await catalog.close();await fs.rm(dir,{recursive:true,force:true});}
});
