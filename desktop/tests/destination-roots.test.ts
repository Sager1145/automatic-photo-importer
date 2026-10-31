import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chosenFolders,destinationRoots,libraryAnchor,libraryRoots,sourceInsideBackup} from '../platform/destination-roots';
import {volumeInfo} from '../platform/volumes';
import {defaultPreferences} from '../preferences';
import type {Preferences,Source} from '../shared';

async function fixture(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'photo-destination-roots-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const destination=path.join(base,'Photos'),source=path.join(destination,'Card');
 await fs.mkdir(source,{recursive:true});
 const info=await volumeInfo(destination),id=info.volumeId??'';
 const prefs=(photo:string,video?:string)=>({...defaultPreferences,copyMode:'single',mediaLayout:video===undefined?'format':'video-root',destinations:[path.join(destination,photo)],destinationIds:[id],videoDestinations:video===undefined?[]:[path.join(destination,video)],videoDestinationIds:video===undefined?[]:[id]} as Preferences);
 const card:Source={id:`folder:${source}`,name:'Card',path:source,transport:'folder'};
 return {base,destination,source,card,prefs,id};
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

test('a chosen backup folder that is not there yet is created',async t=>{
 const {destination,card,prefs}=await fixture(t);
 const {roots}=await destinationRoots(prefs('fresh/photobackup'),[card],card);
 assert.deepEqual(roots,[path.join(destination,'fresh','photobackup')]);
 assert.ok((await fs.stat(roots[0]!)).isDirectory());
});

test('only a source inside a backup folder is refused when chosen; one that contains it is allowed',()=>{
 const roots=['/Volumes/A006/photobackup'];
 assert.equal(sourceInsideBackup('/Volumes/A006/photobackup',roots)?.key,'error.alreadyInBackup');
 assert.equal(sourceInsideBackup('/Volumes/A006/photobackup/2025',roots)?.key,'error.alreadyInBackup');
 assert.equal(sourceInsideBackup('/Volumes/A006',roots),undefined,'the backup folder is left out instead');
 assert.equal(sourceInsideBackup('/Volumes/A006/2024',roots),undefined);
 assert.equal(sourceInsideBackup('/Volumes/A006/photobackup-old',roots),undefined);
});

test('the video layout uses the video folder chosen for each destination',async t=>{
 const {destination,card,prefs}=await fixture(t);
 const video=prefs('photobackup','videobackup');
 assert.deepEqual(libraryRoots(video,0),[path.join(destination,'photobackup'),path.join(destination,'videobackup')]);
 assert.deepEqual(libraryRoots({...video,mediaLayout:'format'},0),[path.join(destination,'photobackup')],'other layouts keep one backup folder');
 assert.deepEqual(chosenFolders({...video,mediaLayout:'format'}).map(folder=>folder.role),['photos']);
 assert.deepEqual(chosenFolders({...video,mediaLayout:'format'},true).map(folder=>folder.role),['photos','videos'],'a kept video folder is still listed for its journals');
 const {roots,videoRoots}=await destinationRoots(video,[card],card);
 assert.deepEqual(roots,[path.join(destination,'photobackup')]);
 assert.deepEqual(videoRoots,[path.join(destination,'videobackup')]);
 assert.ok((await fs.stat(videoRoots![0]!)).isDirectory());
 assert.equal((await destinationRoots(prefs('photobackup'),[card],card)).videoRoots,undefined);
});

test('the photo and video folders may be in different places, and on different drives',async t=>{
 const {destination,card,prefs}=await fixture(t);
 const apart=prefs('Archive/photos','Media/Clips/videos');
 const {roots,videoRoots,videoInfos}=await destinationRoots(apart,[card],card);
 assert.deepEqual(roots,[path.join(destination,'Archive','photos')]);
 assert.deepEqual(videoRoots,[path.join(destination,'Media','Clips','videos')]);
 assert.equal(videoInfos?.length,1);
 assert.equal(libraryAnchor(apart,0),destination,'one drive: organized from the folder holding both');
 assert.equal(libraryAnchor({...apart,videoDestinationIds:['another-volume']},0),undefined,'two drives: not one library');
 assert.equal(libraryAnchor(prefs('photobackup'),0),path.join(destination,'photobackup'));
 // A video folder chosen on another volume is checked against that volume.
 await assert.rejects(destinationRoots({...apart,videoDestinationIds:['another-volume']},[card],card),{key:'error.destinationChanged'} as never);
});

test('a source inside the video backup folder is refused, and the folders must differ',async t=>{
 const {destination,prefs}=await fixture(t);
 const video=prefs('photobackup','videobackup');
 const inside:Source={id:'folder:inside',name:'Inside',path:path.join(destination,'videobackup','2025'),transport:'folder'};
 await fs.mkdir(inside.path,{recursive:true});
 await assert.rejects(destinationRoots(video,[inside],inside),/already in your backup/i);
 const card:Source={id:'folder:card',name:'Card',path:path.join(destination,'Card'),transport:'folder'};
 for(const folder of ['photobackup','photobackup/videos'])await assert.rejects(destinationRoots(prefs('photobackup',folder),[card],card),{key:'error.videoFolderNested'} as never,folder);
 await assert.rejects(destinationRoots(prefs('photobackup/photos','photobackup'),[card],card),{key:'error.videoFolderNested'} as never,'a photo folder inside the video folder');
 await assert.rejects(destinationRoots({...video,videoDestinations:[]},[card],card),{key:'error.videoFolderMissing'} as never);
});

test('a backup folder may not be or lie in the app\'s records folder, and the unknown files folder may not be named after it',async t=>{
 const {destination,card,prefs}=await fixture(t);
 for(const folder of ['Photo Importer Data','Photo Importer Data/photos','Photo Importer Recovery'])await assert.rejects(destinationRoots(prefs(folder),[card],card),{key:'error.backupFolderPath'} as never,folder);
 await assert.rejects(fs.lstat(path.join(destination,'Photo Importer Data')),{code:'ENOENT'},'nothing was created');
 const {validNoMetadataFolder}=await import('../no-metadata');
 for(const name of ['Photo Importer Data','photo importer data'])assert.equal(validNoMetadataFolder(name),false,name);
});
