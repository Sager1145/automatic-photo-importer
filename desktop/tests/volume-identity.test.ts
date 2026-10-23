import test from 'node:test';
import assert from 'node:assert/strict';
import {realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {folderDrive,otherMacMounts,volumeAt,parseLinuxVolumes,parseMacVolume,parseWindowsVolumes,rememberVolumes,singleFlight,volumeOf,type MountedVolume} from '../platform/volumes';

const known:MountedVolume={path:'/',name:'Macintosh HD',volumeId:'A551DA84-858E-4A31-A7FA-16BD0FCEC7CE',physicalId:'disk3'};
const failed=(reason='diskutil timed out'):PromiseSettledResult<MountedVolume>=>({status:'rejected',reason:new Error(reason)});

test('a transient diskutil failure keeps the identity of the same mounted filesystem',()=>{
 const memory=new Map();
 assert.deepEqual(rememberVolumes(['/'],[{status:'fulfilled',value:known}],['fs-a'],memory),[known]);
 assert.deepEqual(rememberVolumes(['/'],[failed()],['fs-a'],memory),[known]);
});

test('a different filesystem at the same mount never inherits the remembered identity',()=>{
 const memory=new Map();
 rememberVolumes(['/Volumes/Backup'],[{status:'fulfilled',value:{...known,path:'/Volumes/Backup'}}],['fs-a'],memory);
 assert.deepEqual(rememberVolumes(['/Volumes/Backup'],[failed()],['fs-b'],memory),[{path:'/Volumes/Backup',name:'Backup'}]);
 assert.deepEqual(rememberVolumes(['/Volumes/Backup'],[failed()],[undefined],memory),[{path:'/Volumes/Backup',name:'Backup'}]);
});

test('concurrent volume lookups share one in-flight sweep and later lookups start fresh',async()=>{
 let calls=0,release!:(value:string)=>void;
 const shared=singleFlight(()=>{calls++;return new Promise<string>(resolve=>{release=resolve;});});
 const first=shared(),second=shared(),third=shared();
 assert.equal(calls,1);
 release('volumes');
 assert.deepEqual(await Promise.all([first,second,third]),['volumes','volumes','volumes']);
 const later=shared();assert.equal(calls,2);release('again');assert.equal(await later,'again');
 const failing=singleFlight(async()=>{calls++;throw new Error('diskutil failed');});
 await assert.rejects(failing(),/diskutil failed/);await assert.rejects(failing(),/diskutil failed/);
 assert.equal(calls,4,'a failure is not cached');
});

test('one diskutil description per mount: its plist names the kind, and only a UUID names the volume',()=>{
 const card={MountPoint:'/Volumes/CARD',VolumeName:'CARD',DeviceIdentifier:'disk4s1',ParentWholeDisk:'disk4',FilesystemType:'exfat',Internal:false};
 assert.equal(parseMacVolume({...card,BusProtocol:'Secure Digital'},'/Volumes/CARD').kind,'card');
 assert.equal(parseMacVolume({...card,RemovableMedia:true,SolidState:true},'/Volumes/CARD').kind,'card');
 assert.equal(parseMacVolume({...card,BusProtocol:'USB',SolidState:true},'/Volumes/CARD').kind,'ssd');
 assert.equal(parseMacVolume({...card,BusProtocol:'USB',SolidState:false},'/Volumes/CARD').kind,'hdd');
 assert.equal(parseMacVolume({...card,BusProtocol:'USB'},'/Volumes/CARD').kind,undefined);
 assert.equal(parseMacVolume(card,'/Volumes/CARD').volumeId,undefined,'a diskN identifier never stands in for a UUID');
 assert.equal(parseMacVolume({...card,DiskUUID:'D1'},'/Volumes/CARD').volumeId,'D1');
 assert.equal(parseMacVolume({...card,VolumeUUID:'V1',DiskUUID:'D1'},'/Volumes/CARD').volumeId,'V1');
});

test('Linux and Windows volumes carry no volume id without a UUID; lsblk names the kind',()=>{
 const linux=parseLinuxVolumes({blockdevices:[
  {name:'mmcblk0',path:'/dev/mmcblk0',rm:false,tran:'mmc',children:[{path:'/dev/mmcblk0p1',mountpoints:['/media/card']}]},
  {name:'sda',path:'/dev/sda',rota:true,tran:'sata',children:[{path:'/dev/sda1',mountpoints:['/data'],uuid:'disk-uuid'}]},
  {name:'nvme0n1',path:'/dev/nvme0n1',rota:false,tran:'nvme',children:[{path:'/dev/nvme0n1p1',mountpoints:['/']}]}]});
 assert.deepEqual(linux.map(v=>[v.path,v.volumeId,v.kind]),[['/media/card',undefined,'card'],['/data','disk-uuid','hdd'],['/',undefined,'ssd']]);
 assert.deepEqual(parseWindowsVolumes([{Path:'E:\\',DriveType:2}]).map(v=>v.volumeId),[undefined],'a drive letter is not a volume id');
});

test('every path resolves to the deepest mounted volume holding it',()=>{
 const volumes:MountedVolume[]=[{path:'/'},{path:'/Volumes/A'},{path:'/Volumes/A/Nested'}];
 assert.equal(volumeOf(volumes,'/Volumes/A/DCIM/100')?.path,'/Volumes/A');
 assert.equal(volumeOf(volumes,'/Volumes/A/Nested')?.path,'/Volumes/A/Nested');
 assert.equal(volumeOf(volumes,'/Volumes/AB/x')?.path,'/');
 assert.equal(volumeOf([{path:'/Volumes/A'}],'/Users/me'),undefined);
});

test('a chosen folder takes its volume, disk and medium from the mount snapshot',async()=>{
 const folder=await realpath(tmpdir());
 const drive=await folderDrive(folder,[{path:'/',volumeId:'ROOT-UUID',kind:'ssd'},{path:folder,name:'Scratch',volumeId:'SCRATCH-UUID',physicalId:'disk9',kind:'hdd'}]);
 assert.deepEqual(drive,{volumeId:'SCRATCH-UUID',name:'Scratch',mount:folder,physicalId:'disk9',kind:'hdd'});
});

test('the macOS snapshot also holds local disks mounted outside /Volumes, so their paths are not taken for the startup disk',()=>{
 const table=['/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)','devfs on /dev (devfs, local, nobrowse)',
  '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)','map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
  '/dev/disk7s1 on /Volumes/Untitled (exfat, local, nodev, nosuid, noowners, noatime, fskit)',
  '/dev/disk5s1 on /private/var/folders/T/exfat (2)/m (exfat, local, nodev, nosuid, noowners, noatime, nobrowse, fskit, mounted by me)',
  '//me@nas/photos on /Users/me/nas (smbfs, nodev, nosuid, mounted by me)'].join('\n');
 assert.deepEqual(otherMacMounts(table),['/private/var/folders/T/exfat (2)/m']);
});

test('one path\'s volume is described from its own mount, not a sweep of every disk',async()=>{
 const described:string[][]=[];
 const describe=async(mounts:string[])=>{described.push(mounts);return mounts.map(mount=>({path:mount,volumeId:`${mount}-UUID`,kind:'hdd' as const,fsType:'exfat'}));};
 const mounts=async()=>['/','/Volumes/A','/Volumes/AB','/Volumes/A/Nested'];
 assert.deepEqual(await volumeAt('/Volumes/A/DCIM/100',{mounts,describe}),{path:'/Volumes/A',volumeId:'/Volumes/A-UUID',kind:'hdd',fsType:'exfat'});
 assert.deepEqual(described,[['/Volumes/A']]);
 assert.equal((await volumeAt('/Users/me',{mounts,describe}))?.path,'/');
});

test('a volume another process described is adopted for its mount, and used only while the mount is the same filesystem',async()=>{
 const {adoptVolumes,describeChanged}=await import('../platform/volumes');
 const memory=new Map(),card:MountedVolume={path:'/Volumes/CARD',name:'CARD',volumeId:'CARD-UUID',kind:'card',fsType:'exfat'};
 await adoptVolumes([card],async()=>'fs-card',memory);
 const never=async():Promise<MountedVolume>=>{throw new Error('described again');};
 const [same]=await describeChanged([card.path],['fs-card'],never,async()=>7,memory);
 assert.deepEqual(same,{status:'fulfilled',value:{...card,free:7}});
 const [other]=await describeChanged([card.path],['fs-other'],never,async()=>7,memory);
 assert.equal(other!.status,'rejected');
});
