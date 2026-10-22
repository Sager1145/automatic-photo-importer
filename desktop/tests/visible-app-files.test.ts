import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {plan,execute,findMisplaced,executeReorganization,configureOrganizationRecovery} from '../core/index';
import {recordPartial} from '../core/import-recovery';
import {DestinationIndex} from '../core/destination-index';
import {ignoredName} from '../core/inventory';
import {findResidue,cleanResidue} from '../core/residue';
import {identity} from '../core/paths';
import type {Metadata} from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
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

test('an import, a drive backup and an organization leave no hidden file on the destination',async t=>{
 const f=await fixture(t);
 assert.deepEqual((await execute((await plan(f.source,[f.root],options,metadata)).plans[0]!)).errors,[]);
 assert.deepEqual(await dotted(f.root),[]);assert.ok(await exists(path.join(f.root,'photo-importer-index.json')));
 const backup=await plan(f.source,[f.root],{...options,backup:true,drive},metadata);
 assert.deepEqual((await execute(backup.plans[0]!)).errors,[]);
 const folder=path.join(f.root,'Drive backups','Travel SSD');
 assert.ok(await exists(path.join(folder,'photo-importer-drive.json')));assert.deepEqual(await dotted(f.root),[]);
 const library=path.join(f.base,'library');await fs.mkdir(path.join(library,'stray'),{recursive:true});await fs.writeFile(path.join(library,'stray','B.JPG'),'bytes of B');
 const reviewed=(await plan(library,[library],{...options,reorganize:true},metadata)).plans[0]!;
 const result=await executeReorganization(reviewed,undefined,undefined,{strategy:'rename'});
 assert.equal(result.moved,1);assert.deepEqual(result.errors,[]);assert.deepEqual(await dotted(library),[]);
 assert.equal((await findMisplaced(library,library,options,metadata)).count,0);
});

test('a hidden drive marker left by an older version is adopted and keeps the folder this drive owns',async t=>{
 const f=await fixture(t),backup=()=>plan(f.source,[f.root],{...options,backup:true,drive},metadata);
 await execute((await backup()).plans[0]!);
 const folder=path.join(f.root,'Drive backups','Travel SSD'),visible=path.join(folder,'photo-importer-drive.json'),legacy=path.join(folder,'.photo-importer-drive.json');
 await fs.rename(visible,legacy);
 const again=(await backup()).plans[0]!;
 assert.ok(again.entries.every(entry=>entry.destination.startsWith(folder+path.sep)),'the folder is still this drive\'s');
 assert.deepEqual(await execute(again),{copied:0,skipped:1,errors:[]});
 assert.ok(await exists(visible));assert.equal(await exists(legacy),false);
 assert.equal(JSON.parse(await fs.readFile(visible,'utf8')).identity,drive.identity);
 // With both present the visible one decides.
 await fs.writeFile(legacy,JSON.stringify({identity:'someone-else'}));
 assert.deepEqual(await execute((await backup()).plans[0]!),{copied:0,skipped:1,errors:[]});
 // Neither marker is user data.
 await fs.writeFile(path.join(f.source,'photo-importer-drive.json'),'{}');await fs.writeFile(path.join(f.source,'.photo-importer-drive.json'),'{}');
 const names=(await plan(f.source,[f.root],{...options,backup:true},metadata)).inventory.files.map(file=>file.relative);
 assert.deepEqual(names,['A.JPG']);
});

test('a hidden destination index left by an older version is read and replaced by the visible one',async t=>{
 const f=await fixture(t),id=await identity(f.root),file=path.join(f.root,'cached.bin');
 await fs.writeFile(file,'cached');await fs.utimes(file,new Date(2020,0,1),new Date(2020,0,1));
 const first=new DestinationIndex(f.root,id);first.remember(file,'a'.repeat(64),await fs.lstat(file,{bigint:true}));await first.flush();
 const visible=path.join(f.root,'photo-importer-index.json'),legacy=path.join(f.root,'.photo-importer-index.json');
 await fs.rename(visible,legacy);
 const loaded=await DestinationIndex.load(f.root,id);
 assert.equal(await loaded.digestOf(file),'a'.repeat(64),'the legacy record is trusted');
 await loaded.flush();
 assert.ok(await exists(visible));assert.equal(await exists(legacy),false);
 assert.equal(await (await DestinationIndex.load(f.root,id)).digestOf(file),'a'.repeat(64));
 assert.deepEqual(await dotted(f.root),[]);
});

test('a hidden staged copy and receipt left by an older version are still resumed',async t=>{
 const f=await fixture(t),transfer=(await plan(f.source,[f.root],options,metadata)).plans[0]!,entry=transfer.entries[0]!;
 await fs.mkdir(path.dirname(entry.destination),{recursive:true});
 const partial=path.join(path.dirname(entry.destination),`.import-${randomUUID()}.partial`);
 await fs.writeFile(partial,f.data.subarray(0,500_000));
 const stat=await fs.lstat(partial,{bigint:true}),receipt=(await recordPartial('stage',partial,stat,entry,transfer,new Map())).journal;
 const legacy=path.join(path.dirname(receipt),path.basename(receipt).replace(/^photo-importer-/,'.import-'));
 await fs.rename(receipt,legacy);
 const result=await execute((await plan(f.source,[f.root],options,metadata)).plans[0]!);
 assert.deepEqual(result,{copied:1,skipped:0,errors:[]});
 assert.deepEqual(await fs.readFile(entry.destination),f.data);
 assert.equal((await fs.lstat(entry.destination,{bigint:true})).ino,stat.ino,'the old bytes were continued, not copied again');
 assert.deepEqual(await fs.readdir(path.dirname(entry.destination)),[path.basename(entry.destination)]);
});

test('residue cleanup and the scanner recognise both the visible and the older hidden names',async t=>{
 const f=await fixture(t),leftovers:string[]=[];
 const folder=path.join(f.root,'2024');await fs.mkdir(folder);
 for(const prefix of ['','.']){
  const id=randomUUID();
  leftovers.push(path.join(folder,prefix?`.import-${id}.partial`:`photo-importer-${id}.partial`));
  leftovers.push(path.join(f.root,`${prefix}photo-importer-index-${id}.tmp`));
 }
 for(const file of leftovers)await fs.writeFile(file,'x');
 const found=await findResidue([f.root]);
 assert.deepEqual(found.items.map(item=>item.path).sort(),[...leftovers].sort());
 await cleanResidue(found);
 for(const file of leftovers)assert.equal(await exists(file),false,file);
 for(const name of ['photo-importer-drive.json','.photo-importer-drive.json','photo-importer-index.json','.photo-importer-index.json',`photo-importer-${UUID_V4}.partial`,`.import-${UUID_V4}.partial`,`photo-importer-stage-${UUID_V4}.json`,`.import-intent-${UUID_V4}.json`,`photo-importer-index-${UUID_V4}.tmp`,`.photo-importer-index-${UUID_V4}.tmp`])
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
