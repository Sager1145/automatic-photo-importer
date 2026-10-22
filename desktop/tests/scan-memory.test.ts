import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inventory} from '../core';
import {loadScanMemory,saveScanMemory,rememberImported,loadImported} from '../platform/scan-memory';
import type {Metadata} from '../shared';

async function fixture(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'scan-memory-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const store=path.join(base,'user-data'),mount=path.join(base,'NIKON Z F'),folder=path.join(mount,'DCIM','100NCZ_F');
 await fs.mkdir(folder,{recursive:true});
 for(let index=0;index<3;index++)await fs.writeFile(path.join(folder,`DSC${index}.NEF`),`raw ${index}`);
 return {base,store,mount,folder};
}
const routingFor=async(file:string,camera:string):Promise<[string,Metadata]>=>{const stat=await fs.lstat(file,{bigint:true});return [`${file}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,{camera,fields:{}}];};

test('a card remembered under its UUID is reused at a new mount path after a restart',async t=>{
 const f=await fixture(t);
 const scan=await inventory(f.mount,{});
 const routing=[await routingFor(path.join(f.folder,'DSC0.NEF'),'NIKON Z f')];
 await saveScanMemory(f.store,'CARD-UUID',f.mount,scan,routing);
 // Remounted under another name, as a second card with the same label would be.
 const moved=path.join(f.base,'NIKON Z F 1');await fs.rename(f.mount,moved);
 const memory=await loadScanMemory(f.store,'CARD-UUID',moved);
 assert.ok(memory);
 const again=await inventory(moved,{reuse:memory.inventory});
 assert.deepEqual(again.files.map(file=>file.relative),scan.files.map(file=>file.relative));
 assert.ok(again.files.every(file=>file.path.startsWith(moved+path.sep)));
 const [key,value]=memory.routing[0]!;
 assert.deepEqual([key,value.camera],(await routingFor(path.join(moved,'DCIM','100NCZ_F','DSC0.NEF'),'NIKON Z f')).map((item,index)=>index?(item as Metadata).camera:item));
});

test('remembered EXIF results are offered only for files that are unchanged',async t=>{
 const f=await fixture(t),file=path.join(f.folder,'DSC1.NEF');
 await saveScanMemory(f.store,'CARD-UUID',f.mount,await inventory(f.mount,{}),[await routingFor(file,'NIKON Z f')]);
 await fs.writeFile(file,'rewritten raw with another size');
 const memory=await loadScanMemory(f.store,'CARD-UUID',f.mount);
 const current=await routingFor(file,'x');
 assert.ok(!memory!.routing.some(([key])=>key===current[0]),'a changed file never matches its old entry');
});

test('a corrupt, foreign or missing memory is ignored',async t=>{
 const f=await fixture(t);
 assert.equal(await loadScanMemory(f.store,'NO-SUCH-UUID',f.mount),undefined);
 await saveScanMemory(f.store,'CARD-UUID',f.mount,await inventory(f.mount,{}),[]);
 const [name]=await fs.readdir(path.join(f.store,'scan-memory'));
 const file=path.join(f.store,'scan-memory',name!);
 const stored=JSON.parse(await fs.readFile(file,'utf8'));
 await fs.writeFile(file,JSON.stringify({...stored,volume:'OTHER-UUID'}));
 assert.equal(await loadScanMemory(f.store,'CARD-UUID',f.mount),undefined);
 await fs.writeFile(file,'{broken');
 assert.equal(await loadScanMemory(f.store,'CARD-UUID',f.mount),undefined);
});

test('checksums of imported card files are remembered per card and offered only for unchanged files',async t=>{
 const f=await fixture(t),file=path.join(f.folder,'DSC0.NEF'),stat=await fs.lstat(file,{bigint:true});
 const identity=`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
 await rememberImported(f.store,'CARD-UUID',f.mount,{[file]:{sha256:'a'.repeat(64),identity}});
 const moved=path.join(f.base,'NIKON Z F 1');await fs.rename(f.mount,moved);
 const known=await loadImported(f.store,'CARD-UUID',moved),again=await fs.lstat(path.join(moved,'DCIM','100NCZ_F','DSC0.NEF'),{bigint:true});
 assert.equal(known(path.join(moved,'DCIM','100NCZ_F','DSC0.NEF'),`${again.dev}:${again.ino}:${again.size}:${again.mtimeNs}:${again.ctimeNs}`),'a'.repeat(64));
 assert.equal(known(path.join(moved,'DCIM','100NCZ_F','DSC0.NEF'),`${again.dev}:${again.ino}:${again.size+1n}:${again.mtimeNs}:${again.ctimeNs}`),undefined);
});

test('a scan remembered before the current DJI camera names is not reused',async t=>{
 const f=await fixture(t);
 await saveScanMemory(f.store,'CARD-UUID',f.mount,await inventory(f.mount,{}),[await routingFor(path.join(f.folder,'DSC0.NEF'),'NIKON Z f')]);
 const dir=path.join(f.store,'scan-memory'),[name]=(await fs.readdir(dir)).filter(file=>!file.includes('.imported.'));
 const stored=JSON.parse(await fs.readFile(path.join(dir,name!),'utf8'));await fs.writeFile(path.join(dir,name!),JSON.stringify({...stored,version:2}));
 assert.equal(await loadScanMemory(f.store,'CARD-UUID',f.mount),undefined);
});
