import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {plan} from '../core';

async function drive(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'backup-exclusion-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const put=async(relative:string)=>{const file=path.join(base,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,relative);return file;};
 return {base,root:path.join(base,'photobackup'),put};
}
const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async()=>({camera:'Camera',date:'2024-02-03T12:00:00',fields:{}});

test('choosing the whole backup drive as a source leaves the backup folder out automatically',async t=>{
 const d=await drive(t);
 await d.put('DCIM/100CAMERA/NEW.JPG');
 await d.put('photobackup/2024/202402/Camera/OLD.JPG');
 await d.put('photobackup/Photo Importer Recovery/x/originals/0/a/KEPT.JPG');
 const {plans:[transfer],inventory}=await plan(d.base,[d.root],options,metadata);
 assert.deepEqual(transfer!.entries.map(entry=>path.basename(entry.source)),['NEW.JPG']);
 assert.ok(inventory.files.every(file=>!file.relative.startsWith('photobackup')),'nothing inside the backup is even listed');
});

test('a drive backup of the backup drive also leaves the backup folder out',async t=>{
 const d=await drive(t);
 await d.put('Documents/notes.txt');await d.put('photobackup/2024/202402/Camera/OLD.JPG');
 const {plans:[transfer]}=await plan(d.base,[d.root],{...options,backup:true},async()=>({fields:{}}));
 assert.deepEqual(transfer!.entries.map(entry=>path.relative(d.base,entry.source)),[path.join('Documents','notes.txt')]);
});

test('a source inside the backup folder is refused',async t=>{
 const d=await drive(t);await d.put('photobackup/2024/202402/Camera/OLD.JPG');
 await assert.rejects(plan(path.join(d.root,'2024'),[d.root],options,metadata),/already in your backup/i);
});
