import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {destinationRoots,sourceInsideBackup} from '../platform/destination-roots';
import {volumeInfo} from '../platform/volumes';
import type {Preferences,Source} from '../shared';

async function fixture(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'photo-destination-roots-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const destination=path.join(base,'Photos'),source=path.join(destination,'Card');
 await fs.mkdir(source,{recursive:true});
 const info=await volumeInfo(destination);
 const prefs=(basePath:string)=>({copyMode:'single',destinations:[destination],destinationIds:[info.volumeId??''],basePath} as unknown as Preferences);
 const card:Source={id:`folder:${source}`,name:'Card',path:source,transport:'folder'};
 return {destination,source,card,prefs};
}

test('a source inside the backup folder is refused before any folder is created',async t=>{
 const {destination,prefs}=await fixture(t);
 const inside:Source={id:'folder:inside',name:'Inside',path:path.join(destination,'photobackup','2025'),transport:'folder'};
 await fs.mkdir(inside.path,{recursive:true});
 await assert.rejects(destinationRoots(prefs('photobackup'),[inside],inside),/already in your backup/i);
});

test('another connected source inside the backup folder does not block this import',async t=>{
 const {destination,card,prefs}=await fixture(t);
 const inside:Source={id:'folder:inside',name:'Inside',path:path.join(destination,'photobackup','2025'),transport:'folder'};
 await fs.mkdir(inside.path,{recursive:true});
 const {roots}=await destinationRoots(prefs('photobackup'),[card,inside],card);
 assert.deepEqual(roots,[path.join(destination,'photobackup')]);
});

test('a backup folder beside the source is created as before',async t=>{
 const {destination,card,prefs}=await fixture(t);
 const {roots}=await destinationRoots(prefs('photobackup'),[card],card);
 assert.deepEqual(roots,[path.join(destination,'photobackup')]);
 assert.ok((await fs.stat(roots[0]!)).isDirectory());
});

test('only a source inside a backup folder is refused when chosen; one that contains it is allowed',()=>{
 const destinations=['/Volumes/A006'];
 assert.equal(sourceInsideBackup('/Volumes/A006/photobackup',destinations,'photobackup')?.key,'error.alreadyInBackup');
 assert.equal(sourceInsideBackup('/Volumes/A006/photobackup/2025',destinations,'photobackup')?.key,'error.alreadyInBackup');
 assert.equal(sourceInsideBackup('/Volumes/A006',destinations,'photobackup'),undefined,'the backup folder is left out instead');
 assert.equal(sourceInsideBackup('/Volumes/A006/2024',destinations,'photobackup'),undefined);
 assert.equal(sourceInsideBackup('/Volumes/A006/photobackup-old',destinations,'photobackup'),undefined);
});
