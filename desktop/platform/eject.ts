import {execFile} from 'node:child_process';
import * as fs from 'node:fs/promises';
import {promisify} from 'node:util';
import {MessageError} from '../messages';

/** Runs one command and resolves with its output; rejects (like execFile) with `code`, `stdout` and `stderr` on failure.
 * Injected by tests, so no real volume is ever ejected from a unit test. */
export type CommandRunner=(file:string,args:string[],options:{timeout:number;windowsHide:boolean})=>Promise<{stdout:string;stderr:string}>;
const run:CommandRunner=promisify(execFile) as unknown as CommandRunner;
const present=(target:string)=>fs.access(target).then(()=>true,()=>false);
const options={timeout:20000,windowsHide:true};

/** The command that ejects (or unmounts) a volume on each platform. Ejecting never writes to the volume.
 * - macOS: `diskutil eject <mount point>` unmounts every volume of the disk and powers it down for removal.
 * - Linux: `gio mount -e <mount point>` (GVfs, no device lookup or root needed); when gio is not installed, plain
 *   `umount <mount point>` (works for user mounts and removable media in fstab).
 * - Windows: the Explorer "Eject" verb on the drive letter, through PowerShell and Shell.Application, then a check that
 *   the drive is really gone (exit 4 when it is still there).
 * The mount point is passed as one argument, never through a shell; a Windows drive letter is validated before it is
 * put in the script. */
export function ejectCommands(mountPath:string,platform:NodeJS.Platform=process.platform):{file:string;args:string[]}[] {
 if(!mountPath)throw new MessageError('error.ejectNotFound');
 if(platform==='darwin')return [{file:'/usr/sbin/diskutil',args:['eject',mountPath]}];
 if(platform==='linux')return [{file:'gio',args:['mount','-e',mountPath]},{file:'umount',args:[mountPath]}];
 if(platform==='win32'){
  const drive=/^([A-Za-z]):/.exec(mountPath);if(!drive)throw new MessageError('error.ejectNotFound');
  const script=`$d=(New-Object -ComObject Shell.Application).Namespace(17).ParseName('${drive[1]!.toUpperCase()}:');if(-not $d){exit 3};$d.InvokeVerb('Eject');for($i=0;$i -lt 10;$i++){if(-not (Test-Path -LiteralPath '${drive[1]!.toUpperCase()}:\\')){exit 0};Start-Sleep -Milliseconds 500};exit 4`;
  return [{file:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script]}];
 }
 throw new MessageError('error.ejectUnsupported');
}

const busy=/busy|dissented|in use|could not be unmounted|failed to eject|being used/i;
// GVfs says "Containing mount ... not found" for a path that exists but is not a GVfs mount: that is not a disconnected drive.
const notAMount=/containing mount/i;
const missing=/not found|no such|unable to find|not a valid|not mounted|not a mount|does not exist|no mount/i;
/** A failed eject as a message: busy (something still has files open), not found (already removed), or the system's own text. */
export function ejectError(error:unknown):MessageError {
 const detail=error as {code?:unknown;stderr?:unknown;stdout?:unknown;message?:unknown};
 const output=[detail?.stderr,detail?.stdout,detail?.message].filter((item):item is string=>typeof item==='string'&&item.trim()!=='').join('\n').trim();
 if(detail?.code===3&&!(typeof detail.stderr==='string'&&detail.stderr.trim()))return new MessageError('error.ejectNotFound');
 // PowerShell exit 4: the Eject verb ran but the drive letter is still there.
 if(detail?.code===4&&!(typeof detail.stderr==='string'&&detail.stderr.trim()))return new MessageError('error.ejectBusy');
 if(busy.test(output))return new MessageError('error.ejectBusy');
 if(missing.test(output)&&!notAMount.test(output))return new MessageError('error.ejectNotFound');
 return new MessageError('error.ejectFailed',{error:output.split('\n')[0]?.slice(0,300)||'unknown error'});
}

const diskOf=/<key>(ParentWholeDisk|DeviceIdentifier)<\/key>\s*<string>([^<]+)<\/string>/g;
/** The physical (whole) disk a path is on, from `diskutil info -plist`; undefined when diskutil cannot say. */
export async function wholeDisk(target:string,runner:CommandRunner=run):Promise<string|undefined> {
 try{
  const {stdout}=await runner('/usr/sbin/diskutil',['info','-plist',target],options);
  const found:Record<string,string>={};for(const match of stdout.matchAll(diskOf))found[match[1]!]??=match[2]!;
  return found.ParentWholeDisk??found.DeviceIdentifier;
 }catch{return undefined;}
}

export interface EjectOptions {
 /** Backup folders: ejecting the disk that holds one of them is refused. */
 destinations?:readonly string[];
 /** Whether a path still exists; injected by tests. */
 exists?:(target:string)=>Promise<boolean>;
}

/** Ejects the volume mounted at `mountPath`. Resolves when the system accepts it; rejects with a MessageError:
 * error.ejectBusy, error.ejectNotFound, error.ejectUnsupported, error.ejectSharedDisk or error.ejectFailed.
 * On macOS the whole physical disk is ejected, so a destination on the same disk refuses it first. */
export async function ejectVolume(mountPath:string,runner:CommandRunner=run,platform:NodeJS.Platform=process.platform,{destinations=[],exists=present}:EjectOptions={}):Promise<{ok:true}> {
 const commands=ejectCommands(mountPath,platform);
 if(platform==='darwin'&&destinations.length){
  const disk=await wholeDisk(mountPath,runner);
  if(disk)for(const destination of destinations)if(destination&&await wholeDisk(destination,runner)===disk)throw new MessageError('error.ejectSharedDisk');
 }
 let last:unknown;
 for(const [index,command] of commands.entries()){
  try{await runner(command.file,command.args,options);return {ok:true};}
  catch(error){
   const missingTool=(error as {code?:unknown})?.code==='ENOENT';
   // A refusal ends macOS and Windows; on Linux any failure of gio (not only a missing tool) tries umount, and the last error is reported.
   if(index<commands.length-1&&(platform==='linux'||missingTool)){last=missingTool?last:error;continue;}
   if(missingTool&&last===undefined)throw new MessageError('error.ejectUnsupported');
   throw await refined(missingTool?last:error,mountPath,exists);
  }
 }
 throw ejectError(last);
}
/** The mapped error, except that "not found" is not reported while the path is still there. */
async function refined(error:unknown,mountPath:string,exists:(target:string)=>Promise<boolean>):Promise<MessageError> {
 const mapped=ejectError(error);
 if(mapped.key!=='error.ejectNotFound'||!(await exists(mountPath)))return mapped;
 const detail=error as {stderr?:unknown;message?:unknown};
 const text=[detail?.stderr,detail?.message].find((item):item is string=>typeof item==='string'&&item.trim()!=='')??'';
 return new MessageError('error.ejectFailed',{error:text.trim().split('\n')[0]?.slice(0,300)||'unknown error'});
}
