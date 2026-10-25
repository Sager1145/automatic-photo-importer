import test from 'node:test';
import assert from 'node:assert/strict';
import {ejectCommands,ejectVolume,type CommandRunner} from '../platform/eject';
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
test('Linux uses gio and falls back to umount only when gio is not installed',async()=>{
 const first=recorder();
 await ejectVolume('/run/media/me/CARD',first.run,'linux');
 assert.deepEqual(first.calls,[{file:'gio',args:['mount','-e','/run/media/me/CARD']}]);
 const second=recorder(file=>file==='gio'?Object.assign(new Error('spawn gio ENOENT'),{code:'ENOENT'}):undefined);
 await ejectVolume('/run/media/me/CARD',second.run,'linux');
 assert.deepEqual(second.calls.map(call=>call.file),['gio','umount']);
 assert.deepEqual(second.calls[1]!.args,['/run/media/me/CARD']);
 const refused=recorder(()=>refusal('umount: target is busy'));
 assert.equal(await keyOf(ejectVolume('/mnt/x',refused.run,'linux')),'error.ejectBusy');
 assert.equal(refused.calls.length,1,'a refusal is the answer; the fallback is not tried');
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
