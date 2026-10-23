import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {plan,execute,findMisplaced,executeReorganization,configureOrganizationRecovery} from '../core/index';
import {DestinationIndex} from '../core/destination-index';
import {openReceiptsFor,stagingFor} from './fixtures/receipts';
import {ignoredName} from '../core/inventory';
import {findResidue,cleanResidue} from '../core/residue';
import {identity} from '../core/paths';
import type {Metadata} from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}});
const drive={name:'Travel SSD',identity:'volume-visible-1',mirror:false};
async function fixture(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'visible-files-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),root=path.join(base,'destination');await fs.mkdir(source);await fs.mkdir(root);
 const data=Buffer.alloc(2*1024*1024+13);for(let i=0;i<data.length;i++)data[i]=(i*31+Math.floor(i/4093))%251;
 await fs.writeFile(path.join(source,'A.JPG'),data);
 return {base,source,root,data};
}
const dotted=async(root:string)=>(await fs.readdir(root,{recursive:true})).map(String).filter(name=>path.basename(name).startsWith('.'));
const exists=(file:string)=>fs.lstat(file).then(()=>true,()=>false);
const UUID_V4='11111111-1111-4111-8111-111111111111';

/** Files directly in `folder` or beneath it that the app names photo-importer-* (records the earlier version kept beside media). */
const appNamed=async(folder:string)=>(await fs.readdir(folder,{recursive:true})).map(String).filter(name=>!name.split(path.sep).includes('Photo Importer Data')&&/^(?:\.?photo-importer-(?!drive\.json)|\.import-)/.test(path.basename(name)));
test('an import, a drive backup and an organization leave no hidden file, and no record beside the media: every record is in the one Photo Importer Data folder',async t=>{
 const f=await fixture(t);
 assert.deepEqual((await execute((await plan(f.source,[f.root],options,metadata)).plans[0]!)).errors,[]);
 assert.deepEqual(await dotted(f.root),[]);assert.deepEqual(await appNamed(f.root),[]);
 assert.equal(await exists(path.join(f.root,'photo-importer-index.json')),false,'the index is in the records folder');
 assert.ok((await fs.readdir(path.join(f.root,'Photo Importer Data','Libraries'))).length,'the index is in the records folder');
 assert.deepEqual(await fs.readdir(await stagingFor(f.root)),[],'no staged copy left');assert.equal((await openReceiptsFor(f.root)).size,0,'no receipt left open');
 const backup=await plan(f.source,[f.root],{...options,backup:true,drive},metadata);
 assert.deepEqual((await execute(backup.plans[0]!)).errors,[]);
 const folder=path.join(f.root,'Drive backups','Travel SSD');
 assert.ok(await exists(path.join(folder,'photo-importer-drive.json')));assert.deepEqual(await dotted(f.root),[]);
 const library=path.join(f.base,'library');await fs.mkdir(path.join(library,'stray'),{recursive:true});await fs.writeFile(path.join(library,'stray','B.JPG'),'bytes of B');
 const reviewed=(await plan(library,[library],{...options,reorganize:true},metadata)).plans[0]!;
 const result=await executeReorganization(reviewed,undefined,undefined);
 assert.equal(result.moved,1);assert.deepEqual(result.errors,[]);assert.deepEqual(await dotted(library),[]);assert.deepEqual(await appNamed(library),[]);
 assert.deepEqual((await fs.readdir(library)).sort(),['2024','Photo Importer Data'],'the journal is in the records folder, the emptied folder is gone');
 assert.equal((await findMisplaced(library,library,options,metadata)).count,0);
});

test('neither drive marker name is user data',async t=>{
 const f=await fixture(t);
 await fs.writeFile(path.join(f.source,'photo-importer-drive.json'),'{}');await fs.writeFile(path.join(f.source,'.photo-importer-drive.json'),'{}');
 const names=(await plan(f.source,[f.root],{...options,backup:true},metadata)).inventory.files.map(file=>file.relative);
 assert.deepEqual(names,['A.JPG']);
});

test('the destination index is sealed in the records folder: one sealed by another Mac is not trusted',async t=>{
 const f=await fixture(t),id=await identity(f.root),file=path.join(f.root,'cached.bin');
 await fs.writeFile(file,'cached');await fs.utimes(file,new Date(2020,0,1),new Date(2020,0,1));
 const first=new DestinationIndex(f.root,id);first.remember(file,'a'.repeat(64),await fs.lstat(file,{bigint:true}));await first.flush();
 assert.equal(await (await DestinationIndex.load(f.root,id)).digestOf(file),'a'.repeat(64));
 const [partition]=await fs.readdir(path.join(f.root,'Photo Importer Data','Libraries'));
 const stored=path.join(f.root,'Photo Importer Data','Libraries',partition!,'index.json');
 const record=JSON.parse(await fs.readFile(stored,'utf8'));record.files['cached.bin'].sha256='b'.repeat(64);
 await fs.writeFile(stored,JSON.stringify(record));
 assert.notEqual(await (await DestinationIndex.load(f.root,id)).digestOf(file),'b'.repeat(64),'a changed record is read again from the file');
 assert.deepEqual(await dotted(f.root),[]);
});

test('residue cleanup never walks the library, and the scanner recognises both the visible and the older hidden names',async t=>{
 const f=await fixture(t),leftovers:string[]=[];
 const folder=path.join(f.root,'2024');await fs.mkdir(folder);
 for(const prefix of ['','.']){
  const id=randomUUID();
  leftovers.push(path.join(folder,prefix?`.import-${id}.partial`:`photo-importer-${id}.partial`));
  leftovers.push(path.join(f.root,`${prefix}photo-importer-index-${id}.tmp`));
 }
 for(const file of leftovers)await fs.writeFile(file,'x');
 // What an earlier version left in the library is never listed, cleaned or deleted: only the records folder is looked at.
 const found=await findResidue([f.root]);
 assert.deepEqual(found.items,[]);
 await cleanResidue(found);
 for(const file of leftovers)assert.equal(await exists(file),true,file);
 for(const name of ['Photo Importer Data','photo importer data','photo-importer-drive.json','.photo-importer-drive.json','photo-importer-index.json','.photo-importer-index.json',`photo-importer-${UUID_V4}.partial`,`.import-${UUID_V4}.partial`,`photo-importer-stage-${UUID_V4}.json`,`.import-intent-${UUID_V4}.json`,`photo-importer-index-${UUID_V4}.tmp`,`.photo-importer-index-${UUID_V4}.tmp`])
  assert.ok(ignoredName(name),name);
 for(const name of ['photo-importer-notes.json','photo-importer-index-notes.tmp','photo-importer-holiday.partial','photo-importer-stage-1.json','photo-importer-index.json.bak','my photo-importer-drive.json'])
  assert.equal(ignoredName(name),false,name);
});

test('a user file whose name only resembles an app file is still imported',async t=>{
 const f=await fixture(t);
 await fs.writeFile(path.join(f.source,'photo-importer-notes.json'),'my notes');
 const prepared=await plan(f.source,[f.root],{...options,backup:true},metadata);
 assert.deepEqual(prepared.inventory.files.map(file=>file.relative).sort(),['A.JPG','photo-importer-notes.json']);
 assert.deepEqual((await execute(prepared.plans[0]!)).errors,[]);
 assert.equal(await fs.readFile(path.join(f.root,'photo-importer-notes.json'),'utf8'),'my notes');
});
