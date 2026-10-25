import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {MessageError} from '../messages';

/** Runs one command and resolves with its output; rejects (like execFile) with `code`, `stdout` and `stderr` on failure.
 * Injected by tests, so no real volume is ever ejected from a unit test. */
export type CommandRunner=(file:string,args:string[],options:{timeout:number;windowsHide:boolean})=>Promise<{stdout:string;stderr:string}>;
const run:CommandRunner=promisify(execFile) as unknown as CommandRunner;
const options={timeout:20000,windowsHide:true};

/** The command that ejects (or unmounts) a volume on each platform. Ejecting never writes to the volume.
 * - macOS: `diskutil eject <mount point>` unmounts every volume of the disk and powers it down for removal.
 * - Linux: `gio mount -e <mount point>` (GVfs, no device lookup or root needed); when gio is not installed, plain
 *   `umount <mount point>` (works for user mounts and removable media in fstab).
 * - Windows: the Explorer "Eject" verb on the drive letter, through PowerShell and Shell.Application.
 * The mount point is passed as one argument, never through a shell; a Windows drive letter is validated before it is
 * put in the script. */
export function ejectCommands(mountPath:string,platform:NodeJS.Platform=process.platform):{file:string;args:string[]}[] {
 if(!mountPath)throw new MessageError('error.ejectNotFound');
 if(platform==='darwin')return [{file:'/usr/sbin/diskutil',args:['eject',mountPath]}];
 if(platform==='linux')return [{file:'gio',args:['mount','-e',mountPath]},{file:'umount',args:[mountPath]}];
 if(platform==='win32'){
  const drive=/^([A-Za-z]):/.exec(mountPath);if(!drive)throw new MessageError('error.ejectNotFound');
  const script=`$d=(New-Object -ComObject Shell.Application).Namespace(17).ParseName('${drive[1]!.toUpperCase()}:');if(-not $d){exit 3};$d.InvokeVerb('Eject')`;
  return [{file:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script]}];
 }
 throw new MessageError('error.ejectUnsupported');
}

const busy=/busy|dissented|in use|could not be unmounted|failed to eject|being used/i;
const missing=/not found|no such|unable to find|not a valid|not mounted|not a mount|does not exist|no mount/i;
/** A failed eject as a message: busy (something still has files open), not found (already removed), or the system's own text. */
export function ejectError(error:unknown):MessageError {
 const detail=error as {code?:unknown;stderr?:unknown;stdout?:unknown;message?:unknown};
 const output=[detail?.stderr,detail?.stdout,detail?.message].filter((item):item is string=>typeof item==='string'&&item.trim()!=='').join('\n').trim();
 if(detail?.code===3&&!(typeof detail.stderr==='string'&&detail.stderr.trim()))return new MessageError('error.ejectNotFound');
 if(busy.test(output))return new MessageError('error.ejectBusy');
 if(missing.test(output))return new MessageError('error.ejectNotFound');
 return new MessageError('error.ejectFailed',{error:output.split('\n')[0]?.slice(0,300)||'unknown error'});
}

/** Ejects the volume mounted at `mountPath`. Resolves when the system accepts it; rejects with a MessageError:
 * error.ejectBusy, error.ejectNotFound, error.ejectUnsupported or error.ejectFailed. */
export async function ejectVolume(mountPath:string,runner:CommandRunner=run,platform:NodeJS.Platform=process.platform):Promise<{ok:true}> {
 const commands=ejectCommands(mountPath,platform);
 let last:unknown;
 for(const [index,command] of commands.entries()){
  try{await runner(command.file,command.args,options);return {ok:true};}
  catch(error){
   last=error;
   // Only a missing tool tries the next command; a refusal is the answer.
   if((error as {code?:unknown})?.code==='ENOENT'&&index<commands.length-1)continue;
   if((error as {code?:unknown})?.code==='ENOENT')throw new MessageError('error.ejectUnsupported');
   throw ejectError(error);
  }
 }
 throw ejectError(last);
}
