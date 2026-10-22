import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {resolveFolderSources} from '../folder-sources';

async function drive(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'folder-sources-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const dir=async(relative:string)=>{const folder=path.join(base,relative);await fs.mkdir(folder,{recursive:true});return folder;};
 return {base,dir};
}

test('every folder chosen in one dialog becomes its own source',async t=>{
 const d=await drive(t);
 const a=await d.dir('Trip A'),b=await d.dir('Trip B');
 const {sources,rejected}=await resolveFolderSources([a,b],{sources:[],registered:new Map(),destinations:[],backupFolders:['photobackup'],backup:false});
 assert.deepEqual(sources.map(({total,free,...source})=>source),[{id:`folder:${a}`,name:'Trip A',path:a,transport:'folder'},{id:`folder:${b}`,name:'Trip B',path:b,transport:'folder'}]);
 // Each new folder source carries the capacity of the volume it is on.
 assert.ok(sources.every(source=>typeof source.total==='number'&&typeof source.free==='number'));
 assert.deepEqual(rejected,[]);
});

test('a folder inside the backup is rejected without dropping the others',async t=>{
 const d=await drive(t);
 const good=await d.dir('Cards/1'),bad=await d.dir('photobackup/2024');
 const {sources,rejected}=await resolveFolderSources([bad,good],{sources:[],registered:new Map(),destinations:[d.base],backupFolders:['photobackup'],backup:false});
 assert.deepEqual(sources.map(source=>source.path),[good]);
 assert.deepEqual(rejected.map(item=>item.key),['error.alreadyInBackup']);
});

test('folders already added in the same mode, or picked twice, are skipped',async t=>{
 const d=await drive(t);
 const a=await d.dir('A'),b=await d.dir('B'),link=path.join(d.base,'B link');
 await fs.symlink(b,link);
 const existing={id:`folder:${a}`,name:'A',path:a,transport:'folder' as const};
 const {sources}=await resolveFolderSources([a,b,link],{sources:[existing],registered:new Map([[existing.id,{backup:false}]]),destinations:[],backupFolders:['photobackup'],backup:false});
 assert.deepEqual(sources.map(source=>source.path),[b]);
});

test('a connected drive or a folder in the other mode is reused, so it can switch mode',async t=>{
 const d=await drive(t);
 const card=await d.dir('CARD'),folder=await d.dir('Folder');
 const drive_={id:'volume:1',name:'CARD',path:card,transport:'storage' as const};
 const added={id:`folder:${folder}`,name:'Folder',path:folder,transport:'folder' as const};
 const {sources}=await resolveFolderSources([card,folder],{sources:[drive_,added],registered:new Map([[added.id,{backup:false}]]),destinations:[],backupFolders:['photobackup'],backup:true});
 assert.deepEqual(sources,[drive_,added]);
});
