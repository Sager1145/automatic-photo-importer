import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import * as core from '../core/index';
import {plan,execute,executeReorganization,configureOrganizationRecovery,type ImportRequest,type OrganizeRequest} from '../core/index';
import type {Metadata} from '../shared';
import {put,temporary} from './fixtures/edge';
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');

// A library never holds a "Drive backups" folder. Files & folders imports file every file into the library (photos and
// videos by date and camera, everything else in Unknown files of its date), and Library organization files what an
// earlier version left in Drive backups the same way, journaled and undoable, then removes the emptied folder.
const rules={template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const importing:ImportRequest={...rules,backup:false,everyFile:true,noMetadata:'folder'};
const organizing:OrganizeRequest={...rules,backup:false,reorganize:true,noMetadata:'folder'};
const metadata=async():Promise<Metadata>=>({camera:'ILCE-7M4',date:'2026-10-25T10:00:00',fields:{}});
/** A Finder alias: a bookmark file macOS names "<name>的替身" in Chinese. */
const alias=Buffer.concat([Buffer.from('book\0\0\0\0mark','latin1'),Buffer.alloc(200,7)]);
/** A "._" sidecar holding nothing (no entries): bookkeeping only. */
const emptyAppleDouble=Buffer.concat([Buffer.from([0,5,0x16,7,0,2,0,0]),Buffer.from('Mac OS X        '),Buffer.from([0,0])]);
/** Files other than photos and videos are dated by their modified time, read on this computer's calendar. */
const october=new Date(2026,9,25,12);
async function dated(folder:string){for(const entry of await fs.readdir(folder,{withFileTypes:true,recursive:true}))if(entry.isFile())await fs.utimes(path.join(entry.parentPath,entry.name),october,october);}
/** Every file under `folder` with its contents, "/" separated, without the app's records folder. */
async function files(folder:string):Promise<Record<string,string>> {
 const found:Record<string,string>={};
 for(const entry of await fs.readdir(folder,{withFileTypes:true,recursive:true})){
  const file=path.join(entry.parentPath,entry.name),relative=path.relative(folder,file).split(path.sep).join('/');
  if(entry.isFile()&&!relative.startsWith('Photo Importer Data/'))found[relative]=(await fs.readFile(file)).toString('latin1');
 }
 return found;
}
const exists=(file:string)=>fs.lstat(file).then(()=>true,()=>false);

test('Files & folders files photos by date and camera and every other file in Unknown files, never in Drive backups',async t=>{
 const base=await temporary(t,'files-folders-'),source=path.join(base,'card'),root=path.join(base,'photobackup');
 await put(path.join(source,'DCIM/100MSDCF/DSC00001.ARW'),'raw 1');await put(path.join(source,'DCIM/100MSDCF/DSC00001.JPG'),'jpg 1');
 await put(path.join(source,'DCIM/100MSDCF/NC_FLLST.DAT'),'nikon list');await put(path.join(source,'archive.zip'),'zip');await put(path.join(source,'notes.txt'),'notes');
 await put(path.join(source,'JPG的替身'),alias);
 await put(path.join(source,'DCIM/100MSDCF/._DSC00001.ARW'),emptyAppleDouble);await put(path.join(source,'.DS_Store'),'finder');
 await fs.mkdir(root);await dated(source);
 const {plans}=await plan(source,[root],importing,metadata);
 assert.deepEqual((await execute(plans[0]!)).errors,[]);
 assert.deepEqual(await files(root),{
  '2026/202610/ILCE-7M4/DSC00001.ARW':'raw 1','2026/202610/ILCE-7M4/DSC00001.JPG':'jpg 1',
  '2026/202610/Unknown files/NC_FLLST.DAT':'nikon list','2026/202610/Unknown files/archive.zip':'zip','2026/202610/Unknown files/notes.txt':'notes',
  '2026/202610/Unknown files/JPG的替身':alias.toString('latin1'),
 },'camera bookkeeping and the Finder alias are kept as files; "._" and .DS_Store are not copied');
 assert.equal(await exists(path.join(root,'Drive backups')),false);
 // Importing again finds everything verified; a file deleted from the drive stays in the library (nothing is removed or moved aside).
 await fs.rm(path.join(source,'notes.txt'));
 const again=(await plan(source,[root],importing,metadata)).plans[0]!;
 assert.ok(again.entries.length>0&&again.entries.every(entry=>entry.skip));
 assert.deepEqual((await execute(again)).errors,[]);
 assert.equal(await fs.readFile(path.join(root,'2026/202610/Unknown files/notes.txt'),'utf8'),'notes');
 assert.equal(await exists(path.join(root,'Drive backups')),false);
 // Without `everyFile` (a Media import) the same card brings photos and videos only.
 await fs.mkdir(path.join(base,'media'));
 const media=(await plan(source,[path.join(base,'media')],{...importing,everyFile:false},metadata)).plans[0]!;
 assert.deepEqual(media.entries.map(entry=>path.basename(entry.destination)).sort(),['DSC00001.ARW','DSC00001.JPG']);
});

/** A library as an earlier version left it: a drive copied unsorted into Drive backups, with its marker, Finder's and
 * macOS's bookkeeping, a file Mirror set aside, and one photo already in the library. */
async function retiredLibrary(t:test.TestContext){
 const root=path.join(await temporary(t,'drive-backups-migration-'),'photobackup'),drive=path.join(root,'Drive backups','photobackup');
 await put(path.join(drive,'photo-importer-drive.json'),JSON.stringify({version:5,kind:'drive',sealed:'from another computer'}));
 await put(path.join(drive,'DCIM/100MSDCF/DSC00001.ARW'),'raw 1');await put(path.join(drive,'DCIM/100MSDCF/DSC00001.JPG'),'jpg 1');
 await put(path.join(drive,'DCIM/100MSDCF/DSC00002.ARW'),'raw 2');await put(path.join(drive,'DCIM/100MSDCF/NC_FLLST.DAT'),'nikon list');
 await put(path.join(drive,'files.zip'),'zip');await put(path.join(drive,'JPG的替身'),alias);
 await put(path.join(drive,'DCIM/100MSDCF/._DSC00001.ARW'),emptyAppleDouble);await put(path.join(drive,'._files.zip'),emptyAppleDouble);await put(path.join(drive,'.DS_Store'),'finder');
 await put(path.join(root,'Drive backups','Removed by mirror','2026-10-25T00-00-00-000Z-abcd1234','photobackup','old.txt'),'held by mirror');
 await put(path.join(root,'2026/202610/ILCE-7M4/DSC00002.ARW'),'raw 2');
 await dated(root);
 return {root,drive};
}

test('organization migrates a Drive backups folder into the library, keeps duplicates for undo, removes the emptied folder, and undo puts it back',async t=>{
 const {root}=await retiredLibrary(t);
 const before=await files(root);
 // The library check sees the Drive backups files as misplaced, so organizing is offered.
 assert.ok((await core.findMisplaced(root,root,rules,metadata)).count>=1);
 const reviewed=(await plan(root,[root],organizing,metadata)).plans[0]!;
 assert.ok(reviewed.entries.every(entry=>!entry.destination.split(path.sep).includes('Drive backups')),'nothing is filed into Drive backups');
 const result=await executeReorganization(reviewed,undefined,undefined,{removeAppleDouble:true});
 assert.deepEqual(result.errors,[]);
 assert.equal(result.retained,1,'the photo already in the library is a duplicate kept in recovery storage, not deleted');
 assert.deepEqual(await files(root),{
  '2026/202610/ILCE-7M4/DSC00001.ARW':'raw 1','2026/202610/ILCE-7M4/DSC00001.JPG':'jpg 1','2026/202610/ILCE-7M4/DSC00002.ARW':'raw 2',
  '2026/202610/Unknown files/NC_FLLST.DAT':'nikon list','2026/202610/Unknown files/files.zip':'zip','2026/202610/Unknown files/JPG的替身':alias.toString('latin1'),
  '2026/202610/Unknown files/old.txt':'held by mirror',
 });
 assert.equal(await exists(path.join(root,'Drive backups')),false,'the emptied folder, its marker and bookkeeping are gone');
 assert.equal((await core.findMisplaced(root,root,rules,metadata)).count,0);
 // Undo restores every file where it was (the marker is app bookkeeping nothing reads any more).
 const [job]=await core.getOrganizationRecovery(root);
 assert.ok(job?.undoable,JSON.stringify(job));
 await core.undoOrganization(root,job!.id);
 const restored=await files(root),expected={...before};
 for(const name of Object.keys(expected))if(/photo-importer-drive\.json$|\/\._|\.DS_Store$/.test(name))delete expected[name];
 for(const name of Object.keys(restored))if(/\/\._|\.DS_Store$/.test(name))delete restored[name];
 assert.deepEqual(restored,expected);
});

test('a Drive backups file that cannot be judged keeps its folder, and nothing in it is lost',async t=>{
 const {root,drive}=await retiredLibrary(t);
 // A "._" with Finder info (an alias's type and creator) is not bookkeeping only: it stays, so its folder does too.
 const finder=Buffer.alloc(82);finder.writeUInt32BE(0x00051607,0);finder.writeUInt32BE(0x00020000,4);finder.writeUInt16BE(1,24);finder.writeUInt32BE(9,26);finder.writeUInt32BE(50,30);finder.writeUInt32BE(32,34);finder.write('alisMACS',50,'latin1');
 await put(path.join(drive,'._JPG的替身'),finder);
 // A file that only looks like a marker (a user's file of that name in a subfolder) is not one.
 await put(path.join(drive,'DCIM','photo-importer-drive.json'),'[1,2,3]');
 const reviewed=(await plan(root,[root],organizing,metadata)).plans[0]!;
 const result=await executeReorganization(reviewed,undefined,undefined,{removeAppleDouble:true});
 assert.deepEqual(result.errors,[]);
 assert.ok(await exists(path.join(drive,'._JPG的替身')),'the sidecar with Finder info is kept');
 assert.equal(await fs.readFile(path.join(root,'2026/202610/Unknown files/JPG的替身'),'latin1'),alias.toString('latin1'));
 assert.deepEqual(Object.keys(await files(path.join(root,'Drive backups'))).sort(),['photobackup/.DS_Store','photobackup/._JPG的替身','photobackup/DCIM/photo-importer-drive.json','photobackup/photo-importer-drive.json'],'only what could not be judged is left, nothing removed');
});
