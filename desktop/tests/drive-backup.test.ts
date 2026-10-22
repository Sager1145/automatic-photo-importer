import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {plan,execute} from '../core/index';
import {driveIdentity} from '../platform/volumes';

const base={backup:true,template:'{year}',layout:'flat' as const,unknownRules:{}};
const noMetadata=async()=>{throw new Error('Backup must not read metadata');};
async function fixture(t:test.TestContext){
 const folder=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'photo-drive-backup-')));
 t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const source=path.join(folder,'source'),root=path.join(folder,'destination');
 await fs.mkdir(source);await fs.mkdir(root);
 const put=async(relative:string,contents='original')=>{const file=path.join(source,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,contents);return file;};
 return {source,root,put};
}
async function backup(source:string,root:string,drive:{name:string;identity:string;mirror:boolean}){
 return (await plan(source,[root],{...base,drive},noMetadata)).plans[0]!;
}
async function files(folder:string):Promise<string[]>{
 const found:string[]=[];
 async function walk(current:string){for(const entry of await fs.readdir(current,{withFileTypes:true})){const file=path.join(current,entry.name);if(entry.isDirectory())await walk(file);else found.push(path.relative(folder,file));}}
 await walk(folder);return found.sort();
}

test('each drive backs up into its own folder and same-named drives never share one',async t=>{
 const {source,root,put}=await fixture(t);
 await put('DCIM/A.JPG','a');await put('notes.txt','n');
 const first=await backup(source,root,{name:'Untitled',identity:'volume-1',mirror:false});
 assert.deepEqual(first.entries.map(entry=>path.relative(root,entry.destination)).sort(),['Drive backups/Untitled/DCIM/A.JPG','Drive backups/Untitled/notes.txt']);
 assert.deepEqual(await execute(first),{copied:2,skipped:0,errors:[]});
 const again=await backup(source,root,{name:'Untitled',identity:'volume-1',mirror:false});
 assert.ok(again.entries.every(entry=>entry.skip&&entry.destination.startsWith(path.join(root,'Drive backups','Untitled')+path.sep)));
 const other=await backup(source,root,{name:'Untitled',identity:'volume-2',mirror:false});
 assert.ok(other.entries.every(entry=>entry.destination.startsWith(path.join(root,'Drive backups','Untitled 2')+path.sep)));
 await fs.mkdir(path.join(root,'Drive backups','Manual'),{recursive:true});await fs.writeFile(path.join(root,'Drive backups','Manual','mine.txt'),'mine');
 const unmarked=await backup(source,root,{name:'Manual',identity:'volume-3',mirror:true});
 assert.ok(unmarked.entries.every(entry=>entry.destination.startsWith(path.join(root,'Drive backups','Manual 2')+path.sep)));
 assert.deepEqual(unmarked.removals,[]);
});

test('additive backup keeps destination files after they are deleted from the source',async t=>{
 const {source,root,put}=await fixture(t);
 const removed=await put('old.txt','keep me');await put('new.txt','new');
 await execute(await backup(source,root,{name:'Card',identity:'card',mirror:false}));
 await fs.rm(removed);
 const second=await backup(source,root,{name:'Card',identity:'card',mirror:false});
 assert.equal(second.removals,undefined);
 await execute(second);
 assert.equal(await fs.readFile(path.join(root,'Drive backups/Card/old.txt'),'utf8'),'keep me');
});

test('mirror review lists extra and changed files, then moves them to a dated holding folder instead of deleting',async t=>{
 const {source,root,put}=await fixture(t);
 const gone=await put('DCIM/gone.JPG','gone bytes');await put('DCIM/changed.txt','version 1');await put('same.txt','same');
 await execute(await backup(source,root,{name:'Card',identity:'card',mirror:true}));
 await fs.rm(gone);await put('DCIM/changed.txt','version 2');
 const folder=path.join(root,'Drive backups/Card');
 const review=await backup(source,root,{name:'Card',identity:'card',mirror:true});
 assert.deepEqual(review.removals?.map(item=>[path.relative(folder,item.path),item.reason]).sort(),[['DCIM/changed.txt','changed'],['DCIM/gone.JPG','missing']]);
 assert.equal(review.entries.find(entry=>entry.source.endsWith('changed.txt'))?.destination,path.join(folder,'DCIM/changed.txt'));
 assert.deepEqual(await execute(review),{copied:1,skipped:1,removed:2,errors:[]});
 assert.deepEqual((await files(folder)).filter(file=>!file.startsWith('.photo-importer-drive')),['DCIM/changed.txt','same.txt']);
 assert.equal(await fs.readFile(path.join(folder,'DCIM/changed.txt'),'utf8'),'version 2');
 const held=await files(path.join(root,'Drive backups/.mirror-removed'));
 assert.equal(held.length,2);
 assert.ok(held.every(file=>file.split(path.sep)[1]==='Card'));
 assert.equal(await fs.readFile(path.join(root,'Drive backups/.mirror-removed',held.find(file=>file.endsWith('gone.JPG'))!),'utf8'),'gone bytes');
 assert.equal(await fs.readFile(path.join(root,'Drive backups/.mirror-removed',held.find(file=>file.endsWith('changed.txt'))!),'utf8'),'version 1');
});

test('mirror refuses to move a destination file that changed after review',async t=>{
 const {source,root,put}=await fixture(t);
 const gone=await put('gone.txt','reviewed');
 await execute(await backup(source,root,{name:'Card',identity:'card',mirror:true}));
 await fs.rm(gone);
 const review=await backup(source,root,{name:'Card',identity:'card',mirror:true});
 const target=path.join(root,'Drive backups/Card/gone.txt');
 await fs.writeFile(target,'edited after review');
 await assert.rejects(execute(review),/changed after review/i);
 assert.equal(await fs.readFile(target,'utf8'),'edited after review');
});

test('drive identity uses the volume UUID plus the folder inside it, never the mount path alone',()=>{
 const volume={path:'/Volumes/Samsung T7',volumeId:'6A1F-UUID-ONE'};
 assert.deepEqual(driveIdentity('/Volumes/Samsung T7',volume),{identity:'volume:6A1F-UUID-ONE:',stable:true});
 assert.deepEqual(driveIdentity('/Volumes/Samsung T7/Photos/2024',volume),{identity:'volume:6A1F-UUID-ONE:Photos/2024',stable:true});
 assert.notEqual(driveIdentity('/Volumes/Samsung T7',{...volume,volumeId:'7B2E-UUID-TWO'}).identity,driveIdentity('/Volumes/Samsung T7',volume).identity);
 for(const weak of [undefined,{path:'/Volumes/Card',volumeId:'/Volumes/Card'},{path:'/media/card',volumeId:'/dev/sdb1'},{path:'/Volumes/Card',volumeId:'disk4s1'}])
  assert.equal(driveIdentity('/Volumes/Card',weak).stable,false);
});

test('each destination keeps the folder this drive already owns',async t=>{
 const {source,root,put}=await fixture(t);
 const second=path.join(path.dirname(root),'second');await fs.mkdir(second);
 await put('A.JPG','a');
 await execute((await plan(source,[root],{...base,drive:{name:'Card',identity:'mine',mirror:false}},noMetadata)).plans[0]!);
 await execute((await plan(source,[second],{...base,drive:{name:'Card',identity:'other',mirror:false}},noMetadata)).plans[0]!);
 const {plans}=await plan(source,[root,second],{...base,drive:{name:'Card',identity:'mine',mirror:true}},noMetadata);
 assert.equal(plans[0]!.drive?.folder,'Card');assert.ok(plans[0]!.entries.every(entry=>entry.skip));
 assert.equal(plans[1]!.drive?.folder,'Card 2');
 assert.deepEqual(plans.map(item=>item.removals),[[],[]]);
});

test('a folder created by someone else between review and copy is never adopted',async t=>{
 const {source,root,put}=await fixture(t);
 await put('A.JPG','a');
 const review=await backup(source,root,{name:'Card',identity:'card',mirror:true});
 await fs.mkdir(path.join(root,'Drive backups/Card'),{recursive:true});await fs.writeFile(path.join(root,'Drive backups/Card/mine.txt'),'mine');
 await assert.rejects(execute(review),/another drive|without/i);
 assert.deepEqual(await files(path.join(root,'Drive backups/Card')),['mine.txt']);
});
