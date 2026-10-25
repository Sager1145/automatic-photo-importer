import test from 'node:test';
import assert from 'node:assert/strict';
import {ejectCommands,ejectVolume,wholeDisk,type CommandRunner} from '../platform/eject';
import {MessageError} from '../messages';

/** A runner that records its calls and never touches a real volume. */
const recorder=(fail?:(file:string)=>unknown) => {
 const calls:{file:string;args:string[]}[]=[];
 const run:CommandRunner=async (file,args)=>{calls.push({file,args});const error=fail?.(file);if(error)throw error;return {stdout:'',stderr:''};};
 return {calls,run};
};
const refusal=(stderr:string,code:unknown=1)=>Object.assign(new Error('Command failed'),{code,stderr});
const keyOf=async (promise:Promise<unknown>)=>promise.then(()=>undefined,error=>(error as MessageError).key);

test('macOS ejects the mount point with diskutil',async()=>{
 const {calls,run}=recorder();
 assert.deepEqual(await ejectVolume('/Volumes/NIKON Z',run,'darwin'),{ok:true});
 assert.deepEqual(calls,[{file:'/usr/sbin/diskutil',args:['eject','/Volumes/NIKON Z']}]);
});
test('Linux uses gio and tries umount when gio fails for any reason, reporting the last error',async()=>{
 const first=recorder();
 await ejectVolume('/run/media/me/CARD',first.run,'linux');
 assert.deepEqual(first.calls,[{file:'gio',args:['mount','-e','/run/media/me/CARD']}]);
 const second=recorder(file=>file==='gio'?Object.assign(new Error('spawn gio ENOENT'),{code:'ENOENT'}):undefined);
 await ejectVolume('/run/media/me/CARD',second.run,'linux');
 assert.deepEqual(second.calls.map(call=>call.file),['gio','umount']);
 assert.deepEqual(second.calls[1]!.args,['/run/media/me/CARD']);
 const third=recorder(file=>file==='gio'?refusal('gio: Containing mount for file /mnt/x not found'):undefined);
 await ejectVolume('/mnt/x',third.run,'linux');
 assert.deepEqual(third.calls.map(call=>call.file),['gio','umount'],'a gio refusal (not only a missing tool) tries umount');
 const refused=recorder(file=>file==='umount'?refusal('umount: target is busy'):refusal('gio: Containing mount for file /mnt/x not found'));
 assert.equal(await keyOf(ejectVolume('/mnt/x',refused.run,'linux')),'error.ejectBusy','umount\'s error is the one reported');
 assert.equal(refused.calls.length,2);
 const noUmount=recorder(file=>file==='umount'?Object.assign(new Error('spawn umount ENOENT'),{code:'ENOENT'}):refusal('gio: target is busy'));
 assert.equal(await keyOf(ejectVolume('/mnt/x',noUmount.run,'linux')),'error.ejectBusy','gio\'s error when umount is not installed');
});
test('"Containing mount not found" is not "no longer connected" while the path still exists',async()=>{
 const run=recorder(()=>refusal('gio: Containing mount for file /mnt/x not found')).run;
 const present=async()=>true,absent=async()=>false;
 const error=await ejectVolume('/mnt/x',run,'linux',{exists:present}).catch(item=>item as MessageError);
 assert.equal((error as MessageError).key,'error.ejectFailed');
 const gone=recorder(()=>refusal('Unable to find disk for /Volumes/A')).run;
 assert.equal(await keyOf(ejectVolume('/Volumes/A',gone,'darwin',{exists:absent})),'error.ejectNotFound');
 assert.equal(await keyOf(ejectVolume('/Volumes/A',gone,'darwin',{exists:present})),'error.ejectFailed','a path that is still there is not reported as unplugged');
});
test('Windows ejects the drive letter through the Shell.Application Eject verb',async()=>{
 const {calls,run}=recorder();
 await ejectVolume('e:\\',run,'win32');
 const [call]=calls;
 assert.equal(call!.file,'powershell.exe');
 assert.match(call!.args.at(-1)!,/Namespace\(17\)\.ParseName\('E:'\).*InvokeVerb\('Eject'\)/);
 assert.ok(!ejectCommands("E:'; Remove-Item *",'win32')[0]!.args.at(-1)!.includes('Remove-Item'),'only the drive letter is put in the script');
 assert.equal(ejectCommands('E:\\','win32').length,1);
 assert.equal(await keyOf(ejectVolume('\\\\server\\share',run,'win32')),'error.ejectNotFound');
});
test('failures map to busy, not found, unsupported or the system text',async()=>{
 const run=(error:unknown)=>recorder(()=>error).run;
 assert.equal(await keyOf(ejectVolume('/Volumes/A',run(refusal('Volume A on disk4 failed to eject; at least one volume could not be unmounted\nDissented by PID 55')),'darwin')),'error.ejectBusy');
 assert.equal(await keyOf(ejectVolume('/Volumes/A',run(refusal('Unable to find disk for /Volumes/A')),'darwin')),'error.ejectNotFound');
 assert.equal(await keyOf(ejectVolume('/Volumes/A',run(Object.assign(new Error('spawn ENOENT'),{code:'ENOENT'})),'darwin')),'error.ejectUnsupported');
 assert.equal(await keyOf(ejectVolume('E:\\',run(refusal('',3)),'win32')),'error.ejectNotFound');
 const other=await ejectVolume('/Volumes/A',run(refusal('Something odd happened\nmore')),'darwin').catch(error=>error as MessageError);
 assert.equal((other as MessageError).key,'error.ejectFailed');assert.deepEqual((other as MessageError).params,{error:'Something odd happened'});
 assert.equal(await keyOf(ejectVolume('/x',recorder().run,'freebsd' as NodeJS.Platform)),'error.ejectUnsupported');
 assert.equal(await keyOf(ejectVolume('',recorder().run,'darwin')),'error.ejectNotFound');
});

const plist=(parent:string,device:string)=>`<?xml version="1.0"?><plist><dict><key>DeviceIdentifier</key><string>${device}</string><key>ParentWholeDisk</key><string>${parent}</string></dict></plist>`;
/** A runner that answers `diskutil info` from a table of path -> plist and records the eject. */
const disks=(table:Record<string,string>)=>{
 const calls:string[][]=[];
 const run:CommandRunner=async (file,args)=>{calls.push(args);if(args[0]==='info'){const answer=table[args[2]!];if(!answer)throw refusal('Could not find disk');return {stdout:answer,stderr:''};}return {stdout:'',stderr:''};};
 return {calls,run};
};
test('macOS refuses to eject a disk that also holds a backup folder, and ejects otherwise',async()=>{
 const same=disks({'/Volumes/CARD':plist('disk4','disk4s1'),'/Volumes/BACKUP/photos':plist('disk4','disk4s2')});
 assert.equal(await keyOf(ejectVolume('/Volumes/CARD',same.run,'darwin',{destinations:['/Volumes/BACKUP/photos']})),'error.ejectSharedDisk');
 assert.ok(!same.calls.some(args=>args[0]==='eject'),'diskutil eject is never run');
 const apart=disks({'/Volumes/CARD':plist('disk4','disk4s1'),'/Users/me/Backup':plist('disk1','disk1s1')});
 await ejectVolume('/Volumes/CARD',apart.run,'darwin',{destinations:['/Users/me/Backup']});
 assert.deepEqual(apart.calls.at(-1),['eject','/Volumes/CARD']);
 assert.equal(await wholeDisk('/Volumes/CARD',disks({'/Volumes/CARD':'<key>DeviceIdentifier</key><string>disk9</string>'}).run),'disk9','the device identifier when there is no parent');
 assert.equal(await wholeDisk('/Volumes/X',disks({}).run),undefined);
});
test('Windows maps a drive that is still there after the Eject verb to busy',async()=>{
 const [call]=ejectCommands('E:\\','win32');
 assert.match(call!.args.at(-1)!,/InvokeVerb\('Eject'\);.*Test-Path -LiteralPath 'E:\\'.*exit 4/);
 assert.equal(await keyOf(ejectVolume('E:\\',recorder(()=>refusal('',4)).run,'win32')),'error.ejectBusy');
});
