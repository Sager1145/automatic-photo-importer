import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openCatalog} from '../catalog/store';
import {CatalogCoordinator,bindLibrary} from '../catalog/coordinator';
import {resolveCatalogFile} from '../catalog/access';
test('preview resolution requires online authorized current library, volume identity, and containment',async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'catalog-access-'))),root=path.join(dir,'photos'),c=openCatalog(':memory:');
 try{
  await fs.mkdir(root);await fs.writeFile(path.join(root,'A.jpg'),'photo');await fs.writeFile(path.join(dir,'outside.jpg'),'private');
  const binding=await bindLibrary({root,mountPath:dir,volumeId:'disk',name:'Photos',role:'photos',rulesScope:'r',online:true});const coordinator=new CatalogCoordinator(c,{metadata:async()=>({fields:{}}),options:()=>({template:'{year}/{camera}',layout:'flat'})});await coordinator.configure([binding]);await coordinator.refresh(binding.library.libraryId,new AbortController().signal);
  const file=(await c.query({libraryId:binding.library.libraryId,filters:[],sort:{field:'name',direction:'asc'},limit:1})).rows[0];
  assert.equal(await resolveCatalogFile(c,binding,file.fileId,async()=>true),path.join(root,'A.jpg'));
  await assert.rejects(resolveCatalogFile(c,undefined,file.fileId,async()=>true));await assert.rejects(resolveCatalogFile(c,{...binding,library:{...binding.library,online:false}},file.fileId,async()=>true));await assert.rejects(resolveCatalogFile(c,binding,file.fileId,async()=>false));await assert.rejects(resolveCatalogFile(c,binding,'unknown',async()=>true));
  await fs.unlink(path.join(root,'A.jpg'));await fs.symlink(path.join(dir,'outside.jpg'),path.join(root,'A.jpg'));await assert.rejects(resolveCatalogFile(c,binding,file.fileId,async()=>true));
  await fs.rename(root,path.join(dir,'old'));await fs.mkdir(root);await fs.writeFile(path.join(root,'A.jpg'),'other volume');await assert.rejects(resolveCatalogFile(c,binding,file.fileId,async()=>true));
 }finally{await c.close();await fs.rm(dir,{recursive:true,force:true});}
});
