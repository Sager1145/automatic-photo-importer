import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as core from '../core/index';
import {deleteOriginals} from '../core/originals';
import {removeDuplicates} from '../core/duplicate-removal';
import {cleanResidue,type Residue,type ResidueItem} from '../core/residue';
import {CameraDeleteRefused,onCamera,useCameraCheck} from '../core/camera-guard';
import {digest} from '../core/paths';
import {sourcePolicy} from '../run-policy';
import {offersOriginals} from '../source-eject';
import {normalizePreferences} from '../preferences';
import {classifyMounted,onCameraCard,parseWindowsVolumes,type MountedVolume} from '../platform/volumes';

core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const metadata=async()=>({camera:'Sony',date:'2024-02-03',fields:{}});
const organize={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{},reorganize:true as const};
const exists=(file:string)=>fs.lstat(file).then(()=>true,()=>false);

async function folder(t:test.TestContext,name:string){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),name)));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const put=async(relative:string,contents:string)=>{const file=path.join(root,...relative.split('/'));await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,contents);return file;};
 return {root,put};
}
/** Every folder under `camera` is on a camera card, by the check the app installs at startup (here, a stand-in). */
function cameraAt(t:test.TestContext,...cameras:string[]){
 const restore=useCameraCheck(async target=>cameras.some(camera=>target===camera||target.startsWith(camera+path.sep)));
 t.after(restore);
}

test('a camera check that fails counts as a camera, and without one installed nothing is taken for a camera',async t=>{
 assert.equal(await onCamera(os.tmpdir()),false);
 const restore=useCameraCheck(async()=>{throw new Error('the volume list is unavailable');});t.after(restore);
 assert.equal(await onCamera(os.tmpdir()),true);
});

test('Delete originals never deletes on a camera card, even with every file verified in the backup',async t=>{
 const card=await folder(t,'camera-originals-'),backup=await folder(t,'camera-originals-backup-');
 const original=await card.put('DCIM/100MSDCF/A.JPG','camera bytes'),copy=await backup.put('A.JPG','camera bytes');
 cameraAt(t,card.root);
 const files=[{source:original,size:12,sha256:await digest(original),destinations:[copy]}];
 for(const purpose of ['originals','duplicates'] as const)
  await assert.rejects(deleteOriginals(card.root,files,{purpose}),CameraDeleteRefused,`purpose ${purpose}`);
 assert.equal(await fs.readFile(original,'utf8'),'camera bytes');
 // The offer itself is never made for a USB camera, and a camera import's policy never removes duplicates.
 assert.equal(offersOriginals({transport:'camera'},{deleteOriginalsFolders:true,deleteOriginalsCards:true}),false);
 assert.equal(sourcePolicy('import',undefined,normalizePreferences({duplicateDefaultsVersion:1,removeDuplicatesCamera:true}),'camera').removeSourceDuplicates,false);
});

test('organizing never moves or releases duplicates on a camera card',async t=>{
 const card=await folder(t,'camera-organize-');
 const organized=await card.put('2024/202402/Sony/JPEG/A.JPG','same bytes'),duplicate=await card.put('old card/A.JPG','same bytes');
 const reviewed=(await core.plan(card.root,[card.root],organize,metadata)).plans[0]!;
 cameraAt(t,card.root);
 await assert.rejects(core.executeReorganization(reviewed,undefined,undefined,{releaseDuplicates:true}),CameraDeleteRefused);
 assert.equal(await fs.readFile(duplicate,'utf8'),'same bytes');assert.equal(await fs.readFile(organized,'utf8'),'same bytes');
 assert.deepEqual(await core.getOrganizationRecovery(card.root),[],'no journal was started');
});

test('releasing kept duplicates, or deleting recovery files, refuses an organization whose originals are on a camera card',async t=>{
 const card=await folder(t,'camera-release-');
 const duplicate=await card.put('old card/A.JPG','same bytes');await card.put('2024/202402/Sony/JPEG/A.JPG','same bytes');
 const reviewed=(await core.plan(card.root,[card.root],organize,metadata)).plans[0]!;
 // Organized while the folder was not known as camera media (the duplicate kept for undo); then it reads as a card.
 const result=await core.executeReorganization(reviewed,undefined,undefined,{releaseDuplicates:false});
 assert.deepEqual(result.errors,[]);
 const [job]=await core.getOrganizationRecovery(card.root);assert.ok(job&&(job.retainedFiles??0)>0,'a duplicate is kept for undo');
 cameraAt(t,card.root);
 await assert.rejects(core.finalizeOrganization(card.root,job.id),CameraDeleteRefused);
 await assert.rejects(core.deleteOrganizationRecovery(card.root,job.id),CameraDeleteRefused);
 const after=await core.getOrganizationRecovery(card.root);
 assert.equal(after[0]?.retainedFiles,job.retainedFiles,'the kept duplicate is still kept');
 assert.ok(await exists(duplicate)||(after[0]?.retainedFiles??0)>0);
});

test('Remove duplicates (the Duplicates page) sets nothing aside on a camera card',async t=>{
 const card=await folder(t,'camera-duplicates-');
 await card.put('keep/A.JPG','same'),await card.put('old/A.JPG','same');
 const files=await Promise.all(['keep/A.JPG','old/A.JPG'].map(async relative=>{const file=path.join(card.root,...relative.split('/')),stat=await fs.stat(file,{bigint:true});return {path:relative,size:Number(stat.size),kind:'JPEG' as const,edited:false,birth:Number(stat.birthtimeMs),ctime:Number(stat.ctimeMs),sha256:await digest(file)};}));
 cameraAt(t,card.root);
 await assert.rejects(removeDuplicates(card.root,[{group:{id:'g',strength:'sha',files},keep:'keep/A.JPG',remove:[files[1]!],decided:false,auto:true,suggested:'keep/A.JPG',needsDecision:false}],new Map()),CameraDeleteRefused);
 assert.equal(await fs.readFile(path.join(card.root,'old','A.JPG'),'utf8'),'same');
});

test('Clean up (and the leftovers of a mirrored copy to two disks) removes nothing found on a camera card',async t=>{
 const card=await folder(t,'camera-cleanup-'),disk=await folder(t,'camera-cleanup-disk-');
 const onCard=await card.put('leftover.tmp','partial'),onDisk=await disk.put('leftover.tmp','partial');
 const item=async(file:string,root:string):Promise<ResidueItem>=>({path:file,kind:'direct',bytes:7,root,stat:await fs.lstat(file,{bigint:true})});
 const items=[await item(onCard,card.root),await item(onDisk,disk.root)];
 const residue:Residue={items,files:2,bytes:14,resumable:{files:0,bytes:0},kept:{files:0,bytes:0},recoverable:{files:0,bytes:0}} as unknown as Residue;
 cameraAt(t,card.root);
 const {removed,left}=await cleanResidue(residue);
 assert.equal(await exists(onCard),true,'the card keeps its file');
 assert.equal(await exists(onDisk),false,'the same leftover on the other disk is removed');
 assert.equal(removed.files,1);assert.deepEqual(left.items.map(found=>found.path),[onCard]);
});

test('Windows drive roots read as roots: a library on the computer disk is not a camera card, whatever list the drive script gives',()=>{
 // Earlier the drive script lost its backslash and reported "C:", a folder on C: rather than its root: no library path then
 // matched a drive, an unknown drive counts as a card, and every organization was refused.
 const volumes=parseWindowsVolumes([{Path:'C:',Label:'',DriveType:'Fixed',BusType:'NVMe',FileSystem:'NTFS'},{Path:'D:\\',Label:'',DriveType:'Removable',BusType:'USB',FriendlyName:'Sony DSC USB Device',FileSystem:'exFAT'}]);
 assert.deepEqual(volumes.map(volume=>volume.path),['C:\\','D:\\']);
});

test('a library holding DCIM and "DCIM 2" folders is organized, duplicates released; a card with camera folders at its root is refused',async t=>{
 // Two drives mounted here, each read by the app's own card test: an external library disk (like I:) and a camera card (like D:).
 const disk=await folder(t,'camera-library-disk-'),card=await folder(t,'camera-library-card-');
 const library=path.join(disk.root,'photobackup');
 await disk.put('photobackup/2024/202402/Sony/JPEG/A.JPG','same bytes');
 const duplicate=await disk.put('photobackup/Drive backups/Card/DCIM 2/100MSDCF/A.JPG','same bytes');
 const stray=await disk.put('photobackup/DCIM/100CANON/B.JPG','new bytes');
 const onCard=await card.put('DCIM/100MSDCF/C.JPG','card bytes');
 const volumes:MountedVolume[]=[{path:disk.root,name:'A006',external:true,removable:false},{path:card.root,name:'Card',external:true,removable:false}];
 const restore=useCameraCheck(target=>onCameraCard(target,{volumes:async()=>volumes,classify:volume=>classifyMounted(volume,{cache:new Map()})}));t.after(restore);
 assert.equal(await onCamera(library),false,'camera-named folders inside a library do not make it a card');
 assert.equal(await onCamera(card.root),true,'a card, by its DCIM folder at the root');
 const reviewed=(await core.plan(library,[library],organize,metadata)).plans[0]!;
 const result=await core.executeReorganization(reviewed,undefined,undefined,{releaseDuplicates:true});
 assert.deepEqual(result.errors,[]);
 assert.equal(result.released,1,'the confirmed duplicate in DCIM 2 is released');
 assert.equal(await exists(duplicate),false);assert.equal(await exists(stray),false,'B moved out of the DCIM folder');
 assert.equal(await fs.readFile(path.join(library,'2024','202402','Sony','JPEG','B.JPG'),'utf8'),'new bytes');
 const backup=await disk.put('copies/C.JPG','card bytes');
 await assert.rejects(deleteOriginals(card.root,[{source:onCard,size:10,sha256:await digest(onCard),destinations:[backup]}]),CameraDeleteRefused);
 assert.equal(await fs.readFile(onCard,'utf8'),'card bytes');
});
