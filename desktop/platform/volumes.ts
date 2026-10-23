import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, readFile, realpath, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DestinationStatus, Source } from '../shared';
import type { DeviceKind } from '../core/devices';
import { within } from '../core/paths';
import { MessageError } from '../messages';
import { cameraSources } from './camera-bridge';

const exec = promisify(execFile);
const commandOptions = { timeout: 8000, maxBuffer: 4 * 1024 * 1024, windowsHide: true };
/** One mounted volume as the snapshot describes it. `volumeId` is the volume or partition UUID only: mount paths, drive
 * letters and diskN or /dev names are reused by other disks. `kind` is the medium, for the stream limits. */
export interface MountedVolume { path:string; name?:string; volumeId?:string; physicalId?:string; kind?:DeviceKind; removable?:boolean; external?:boolean; virtual?:boolean; diskImage?:boolean; readOnly?:boolean; total?:number; free?:number; /** File system type (exfat, msdos, apfs, ntfs...), lowercase; used to predict how files are published. */fsType?:string; }

/** Only camera directory layouts or OS-identified removable media are automatic sources. */
export function classifyVolume(volume:MountedVolume, children:string[]) {
  // macOS /private and user folders on internal filesystems are not camera layouts.
  // Only an external/removable volume can override an explicit internal-disk classification.
  if(volume.diskImage || volume.path==='/' || (volume.external===false && volume.removable!==true))return {camera:false,source:false};
  const names = new Set(children.map(name=>name.toUpperCase()));
  const camera = ['DCIM','PRIVATE','AVCHD','MP_ROOT','M4ROOT','CONTENTS','XDROOT'].some(name=>names.has(name));
  return { camera, source:camera || volume.removable === true };
}
function bool(value:unknown):boolean {return value===true || value===1 || value==='1';}
function objects(value:unknown):Record<string,any>[] { return Array.isArray(value) ? value : value && typeof value==='object' ? [value as Record<string,any>] : []; }
export function parseLinuxVolumes(data:unknown):MountedVolume[] {
  const result:MountedVolume[]=[];
  function walk(device:Record<string,any>, parent?:Record<string,any>) {
    const disk=parent ?? device;
    for (const mount of (Array.isArray(device.mountpoints) ? device.mountpoints : [device.mountpoint])) {
      if(typeof mount!=='string' || !mount.startsWith('/')) continue;
      const card=disk.tran==='mmc' || /^mmcblk\d/.test(String(disk.name??''));
      result.push({path:mount,name:device.label || path.basename(mount),volumeId:device.uuid || undefined,physicalId:disk.path || `/dev/${disk.name}`,kind:card?'card':disk.rota===undefined||disk.rota===null?undefined:bool(disk.rota)?'hdd':'ssd',removable:bool(disk.rm)||disk.tran==='mmc',external:bool(disk.hotplug)||disk.tran==='usb',readOnly:bool(device.ro),total:finite(device.size),free:finite(device.fsavail),fsType:fsType(device.fstype)});
    }
    for(const child of objects(device.children)) walk(child,disk);
  }
  for(const device of objects((data as any)?.blockdevices)) walk(device);
  return result;
}
export function parseWindowsVolumes(data:unknown):MountedVolume[] {
  return objects(data).filter(v=>typeof v.Path==='string' && v.Path).map(v=>({path:v.Path,name:v.Label || v.Path,volumeId:v.VolumeId || undefined,physicalId:v.UniqueId || (v.DiskNumber!==undefined?`disk:${v.DiskNumber}`:undefined),removable:v.DriveType===2 || v.DriveType==='Removable' || /^(SD|MMC)$/i.test(String(v.BusType)) || /card reader|SDHC|SDXC/i.test(String(v.FriendlyName??'')),external:/^(USB|SD|MMC)$/i.test(String(v.BusType)),readOnly:bool(v.IsReadOnly),total:finite(v.Size),free:finite(v.SizeRemaining),fsType:fsType(v.FileSystem)}));
}
function fsType(value:unknown):string|undefined {return typeof value==='string'&&value.trim()?value.trim().toLowerCase():undefined;}
function finite(value:unknown):number|undefined {const n=Number(value); return value!==null && value!==undefined && value!=='' && Number.isFinite(n) && n>=0 ? n : undefined;}
function plistJSON(plist:string):Promise<any> {
  return new Promise((resolve,reject)=>{
    const child=spawn('/usr/bin/plutil',['-convert','json','-o','-','-'],{stdio:['pipe','pipe','pipe']});
    const chunks:Buffer[]=[]; let size=0; let error='';
    const timer=setTimeout(()=>child.kill(),8000);
    child.on('error',reject);
    child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>4*1024*1024)child.kill();else chunks.push(chunk);});
    child.stderr.on('data',(chunk:Buffer)=>{if(error.length<4096)error+=chunk.toString();});
    child.on('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error(error||'Volume information conversion failed'));else try{resolve(JSON.parse(Buffer.concat(chunks).toString()));}catch(error){reject(error);}});
    child.stdin.on('error',()=>{}); child.stdin.end(plist);
  });
}
/** APFS synthesized containers need physical-store identity for mirror independence checks. */
export function parseMacPhysicalStores(data:unknown):Map<string,string> {
  const result=new Map<string,string>();
  for(const container of objects((data as any)?.Containers)) {
    const stores=objects(container.PhysicalStores).map(store=>String(store.DeviceIdentifier??'').replace(/s\d+$/,'' )).filter(Boolean).sort();
    if(stores.length && container.ContainerReference)result.set(container.ContainerReference,stores.join('+'));
  }
  return result;
}
export function resolveMacPhysicalIdentity(volume:MountedVolume, stores:Map<string,string>):string|undefined {
  if(!volume.physicalId)return undefined;
  // Synthesized APFS disk numbers identify containers, not independent physical drives.
  return volume.virtual ? stores.get(volume.physicalId) : volume.physicalId;
}
/** The one description of a mounted volume, from `diskutil info -plist`: identity, capacity and medium together. */
export function parseMacVolume(info:Record<string,any>, mount:string):MountedVolume {
  const kind:DeviceKind|undefined=info.BusProtocol==='Secure Digital' || bool(info.RemovableMedia) ? 'card' : info.SolidState===true ? 'ssd' : info.SolidState===false ? 'hdd' : undefined;
  return {path:info.MountPoint || mount,name:info.VolumeName || path.basename(mount),volumeId:info.VolumeUUID || info.DiskUUID || undefined,...(kind?{kind}:{}),physicalId:info.APFSContainerReference || info.ParentWholeDisk || info.DeviceIdentifier,diskImage:/disk image/i.test(String(info.BusProtocol??'')),virtual:/virtual/i.test(String(info.VirtualOrPhysical??'')) || /apfs/i.test(String(info.FilesystemType??info.FileSystemPersonality??'')) || !!info.APFSContainerReference,removable:bool(info.RemovableMedia)||bool(info.Removable),external:info.Internal===false,readOnly:info.Writable===false||bool(info.ReadOnlyVolume),total:finite(info.VolumeTotalSpace??info.TotalSize),free:finite(info.VolumeFreeSpace),fsType:fsType(info.FilesystemType??info.FileSystemType)};
}
async function macVolume(mount:string):Promise<MountedVolume> {
  const {stdout}=await exec('/usr/sbin/diskutil',['info','-plist',mount],commandOptions);
  return parseMacVolume(await plistJSON(stdout),mount);
}
async function linuxVolumes():Promise<MountedVolume[]> {
  try {
    const {stdout}=await exec('lsblk',['--json','--bytes','--output','NAME,PATH,TYPE,RM,ROTA,HOTPLUG,TRAN,RO,MOUNTPOINTS,UUID,LABEL,SIZE,FSAVAIL,FSTYPE'],commandOptions);
    return parseLinuxVolumes(JSON.parse(stdout));
  } catch {
    // util-linux may be absent or older. Mounted filesystem roots still support camera discovery.
    const mounts=await readFile('/proc/self/mountinfo','utf8');
    return mounts.split('\n').filter(Boolean).map(line=>{const fields=line.split(' ');return {path:fields[4].replace(/\\([0-7]{3})/g,(_,octal)=>String.fromCharCode(parseInt(octal,8))),readOnly:fields[5]?.split(',').includes('ro')};});
  }
}
async function windowsVolumes():Promise<MountedVolume[]> {
  // This script is constant: no filesystem paths or other user input enter PowerShell code.
  const script=`$ErrorActionPreference='Stop'; $items=@(Get-Volume | Where-Object {$_.DriveLetter} | ForEach-Object { $v=$_; $p=Get-Partition -DriveLetter $v.DriveLetter -ErrorAction SilentlyContinue | Select-Object -First 1; $d=$null; if($p){$d=Get-Disk -Number $p.DiskNumber -ErrorAction SilentlyContinue}; [pscustomobject]@{Path=([string]$v.DriveLetter+':\\');Label=$v.FileSystemLabel;VolumeId=$v.UniqueId;DriveType=[int]$v.DriveType;Size=$v.Size;SizeRemaining=$v.SizeRemaining;DiskNumber=$d.Number;UniqueId=$d.UniqueId;BusType=[string]$d.BusType;FriendlyName=$d.FriendlyName;FileSystem=[string]$v.FileSystem;IsReadOnly=$d.IsReadOnly}}); ConvertTo-Json -InputObject $items -Compress`;
  const encoded=Buffer.from(script,'utf16le').toString('base64');
  const {stdout}=await exec('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],commandOptions);
  return parseWindowsVolumes(JSON.parse(stdout.replace(/^\uFEFF/,'')));
}
/** Successful diskutil answers per mount for this session. Under heavy load diskutil
 * can time out; without this the same disk would fall back to a different identity
 * (filesystem:<dev>) and a correct destination would be refused as "changed". */
const describedVolumes=new Map<string,{fingerprint:string;volume:MountedVolume}>();
/** dev, root inode and birth time, and size identify one mounted filesystem. */
async function mountFingerprint(mount:string):Promise<string|undefined> {
  try { const root=await stat(mount,{bigint:true}),space=await statfs(mount,{bigint:true}); return `${root.dev}:${root.ino}:${root.birthtimeNs}:${space.blocks}:${space.bsize}`; }
  catch { return undefined; }
}
/** Use a remembered description only while the mount is provably the same filesystem. */
export function rememberVolumes(mounts:string[],results:PromiseSettledResult<MountedVolume>[],fingerprints:(string|undefined)[],memory=describedVolumes):MountedVolume[] {
  return mounts.map((mount,index)=>{
    const result=results[index]!,fingerprint=fingerprints[index];
    if(result.status==='fulfilled'){if(fingerprint)memory.set(mount,{fingerprint,volume:result.value});return result.value;}
    const remembered=memory.get(mount);
    // Retain mount roots when DiskManagement is restricted so camera-layout protection still works.
    return fingerprint&&remembered?.fingerprint===fingerprint?remembered.volume:{path:mount,name:path.basename(mount)};
  });
}
/** Free bytes of a mount from statfs, which is cheap; diskutil's figure is only as fresh as its last run. */
async function freeBytes(mount:string):Promise<number|undefined> {
  try { const space=await statfs(mount,{bigint:true}); return Number(space.bavail*space.bsize); } catch { return undefined; }
}
/** Ask `describe` (diskutil) only for mounts that are new or whose fingerprint changed since they were described;
 * an unchanged mount keeps its remembered description with its free space read afresh. */
export async function describeChanged(mounts:string[],fingerprints:(string|undefined)[],describe:(mount:string)=>Promise<MountedVolume>,free:(mount:string)=>Promise<number|undefined>,memory=describedVolumes):Promise<PromiseSettledResult<MountedVolume>[]> {
  return Promise.all(mounts.map(async(mount,index):Promise<PromiseSettledResult<MountedVolume>>=>{
    const remembered=memory.get(mount),fingerprint=fingerprints[index];
    if(fingerprint&&remembered?.fingerprint===fingerprint){
      const now=await free(mount);
      return {status:'fulfilled',value:now===undefined?remembered.volume:{...remembered.volume,free:now}};
    }
    return describe(mount).then(value=>({status:'fulfilled',value}) as PromiseSettledResult<MountedVolume>,reason=>({status:'rejected',reason}) as PromiseSettledResult<MountedVolume>);
  }));
}
/** The APFS container map changes only when the set of mounts does. */
let physicalMemory:{key:string;stores:Map<string,string>}|undefined;
export async function physicalStores(mounts:string[],fingerprints:(string|undefined)[],list:()=>Promise<Map<string,string>>):Promise<Map<string,string>> {
  const key=JSON.stringify(mounts.map((mount,index)=>[mount,fingerprints[index]]).sort());
  if(physicalMemory?.key===key)return physicalMemory.stores;
  const stores=await list();physicalMemory={key,stores};return stores;
}
async function describeVolumes(mounts:string[]):Promise<MountedVolume[]> {
  const fingerprints=await Promise.all(mounts.map(mountFingerprint));
  const results=await describeChanged(mounts,fingerprints,macVolume,freeBytes);
  // One retry, one mount at a time, for calls that failed while many ran together.
  for(const [index,result] of results.entries()) if(result.status==='rejected') results[index]=await macVolume(mounts[index]!).then(value=>({status:'fulfilled',value}),reason=>({status:'rejected',reason}));
  return rememberVolumes(mounts,results,fingerprints);
}
/** Callers that arrive while a call is running share its result; the next call starts fresh. */
export function singleFlight<T>(work:()=>Promise<T>):()=>Promise<T> {
  let running:Promise<T>|undefined;
  return ()=>running??=work().finally(()=>{running=undefined;});
}
/** Every import job, its validation and the refresh loop enumerate volumes. Under heavy
 * load one diskutil sweep over all mounts takes seconds; concurrent sweeps multiply it. */
const sharedVolumes=singleFlight(enumerateVolumes);
export async function mountedVolumes():Promise<MountedVolume[]> {return [...await sharedVolumes()];}
/** Local disks mounted outside /Volumes and the system's own volumes (a disk image attached with
 * -mountpoint, an fstab entry), from `mount` output: without them a path on such a disk would be
 * taken for the startup disk. */
export function otherMacMounts(table:string):string[] {
  return table.split('\n').flatMap(line=>{
    const mount=line.match(/^\/dev\/disk\S+ on (.+?) \([^()]*\)$/)?.[1];
    return mount && mount!=='/' && !/^\/(?:Volumes|System\/Volumes)(?:\/|$)/.test(mount) ? [mount] : [];
  });
}
/** Every macOS mount a source or destination can be on, apart from `/`: the entries of /Volumes and the other local disks. */
async function macMounts():Promise<string[]> {
  const entries=await readdir('/Volumes',{withFileTypes:true});
  return [...entries.filter(e=>e.isDirectory()||e.isSymbolicLink()).map(e=>path.join('/Volumes',e.name)),...otherMacMounts((await exec('/sbin/mount',[],commandOptions)).stdout)];
}
/** The volume holding `target`, for its UUID, file system and medium: on macOS only the mount it is on is described
 * (through the same per-mount memory as the snapshot), so a fresh process does not sweep every disk for one path.
 * The physical disk of an APFS volume is not resolved here; take it from mountedVolumes(). */
export async function volumeAt(target:string,deps?:{mounts:()=>Promise<string[]>;describe:(mounts:string[])=>Promise<MountedVolume[]>}):Promise<Pick<MountedVolume,'path'|'volumeId'|'kind'|'fsType'>|undefined> {
  // Linux and Windows list every volume in one call.
  if(!deps&&process.platform!=='darwin')return volumeOf(await mountedVolumes(),target);
  const {mounts,describe}=deps??{mounts:async()=>['/',...await macMounts()],describe:describeVolumes};
  const mount=volumeOf((await mounts()).map(item=>({path:item})),target)?.path;
  if(!mount)return undefined;
  const [volume]=await describe([mount]);
  return volume&&{path:volume.path,volumeId:volume.volumeId,kind:volume.kind,fsType:volume.fsType};
}
async function enumerateVolumes():Promise<MountedVolume[]> {
  if(process.platform==='darwin') {
    const mounts=await macMounts();
    const volumes=await describeVolumes(mounts);
    // Include the system filesystem for destination identity, but never as an automatic source.
    if(!volumes.some(v=>v.path==='/')){const [root]=await describeVolumes(['/']);if(root?.volumeId)volumes.push(root);}
    let physical=new Map<string,string>();
    try {
      const all=volumes.map(volume=>volume.path);
      physical=await physicalStores(all,await Promise.all(all.map(mountFingerprint)),async()=>{
        const {stdout}=await exec('/usr/sbin/diskutil',['apfs','list','-plist'],commandOptions);
        return parseMacPhysicalStores(await plistJSON(stdout));
      });
    }catch{/* A virtual filesystem without physical-store resolution cannot prove drive independence. */}
    // Copies: the described volumes are remembered between refreshes, and a resolved identity must not be resolved again.
    return volumes.map(volume=>({...volume,physicalId:resolveMacPhysicalIdentity(volume,physical)}));
  }
  if(process.platform==='win32')return windowsVolumes();
  if(process.platform==='linux')return linuxVolumes();
  return [{path:path.parse(process.cwd()).root}];
}
type Classification=ReturnType<typeof classifyVolume>&{layoutUnavailable?:boolean};
/** Names of the folders at the top of a volume. */
async function listFolders(volume:MountedVolume):Promise<string[]> {
  // macOS privacy checks can block a directory open indefinitely. Keep these
  // probes outside Node's shared filesystem pool so one volume cannot freeze
  // all drive discovery, settings writes and shutdown.
  if(process.platform==='darwin') {
    const {stdout}=await exec('/bin/ls',['-1AF','--',volume.path],{...commandOptions,timeout:1500,killSignal:'SIGKILL',env:{...process.env,LC_ALL:'C',CLICOLOR:'',CLICOLOR_FORCE:''}});
    return stdout.split('\n').filter(name=>name.endsWith('/')).map(name=>name.slice(0,-1));
  }
  return (await readdir(volume.path,{withFileTypes:true})).filter(e=>e.isDirectory()).map(e=>e.name);
}
/** What was found at each mount, valid while the mount is provably the same filesystem: a
 * card is read once when it appears, not on every refresh (each read wakes the drive). */
const classified=new Map<string,{fingerprint:string;result:Classification}>();
export interface ClassifyDeps {list?:(volume:MountedVolume)=>Promise<string[]>;fingerprint?:(mount:string)=>Promise<string|undefined>;cache?:Map<string,{fingerprint:string;result:Classification}>;}
export async function classifyMounted(volume:MountedVolume,deps:ClassifyDeps={}):Promise<Classification> {
  const baseline=classifyVolume(volume,[]);
  if(volume.diskImage || volume.path==='/' || (volume.external===false&&volume.removable!==true))return baseline;
  const cache=deps.cache??classified,print=await (deps.fingerprint??mountFingerprint)(volume.path),fingerprint=print&&`${volume.volumeId??''}|${print}`;
  const known=fingerprint?cache.get(volume.path):undefined;
  if(known&&known.fingerprint===fingerprint)return known.result;
  try {
    const result=classifyVolume(volume,await (deps.list??listFolders)(volume));
    if(fingerprint)cache.set(volume.path,{fingerprint,result});
    return result;
  }catch{return {...baseline,layoutUnavailable:true};}
}
/** `destinations`: drives and folders chosen as destinations are never sources, so they are not read at all. */
export async function getSources(volumes:MountedVolume[],options:ClassifyDeps&{destinations?:Pick<DestinationStatus,'path'|'volumeId'>[]}={}):Promise<Source[]> {
  const cache=options.cache??classified,present=new Set(volumes.map(volume=>volume.path));
  for(const mount of [...cache.keys()])if(!present.has(mount))cache.delete(mount);
  const sources=await Promise.all(volumes.map(async volume=>{
    // The operating system root is never an automatic camera source.
    if(volume.path===path.parse(volume.path).root && process.platform!=='win32')return null;
    if(options.destinations?.some(d=>(!!volume.volumeId&&d.volumeId===volume.volumeId)||within(volume.path,d.path)||within(d.path,volume.path)))return null;
    const classification=await classifyMounted(volume,options); if(!classification.source)return null;
    try {
      const capacity=await statfs(volume.path);return {id:volume.volumeId||volume.path,name:volume.name||path.basename(volume.path),path:volume.path,transport:'storage' as const,camera:classification.camera,total:Number(capacity.bsize)*Number(capacity.blocks),free:Number(capacity.bsize)*Number(capacity.bavail)};
    } catch {return null;}
  }));
  // A camera-protocol failure must not hide working mounted camera cards.
  let cameras:Source[]=[];try{cameras=await cameraSources();}catch{/* Mounted storage remains available. */}
  return [...sources.filter((source):source is NonNullable<typeof source>=>source!==null),...cameras].sort((a,b)=>a.name.localeCompare(b.name));
}
/** The deepest volume in `volumes` holding `target`: the one lookup from a path to its mounted volume. */
export function volumeOf<V extends Pick<MountedVolume,'path'>>(volumes:readonly V[], target:string):V|undefined {
  let found:V|undefined;
  for(const volume of volumes)if(within(target,volume.path)&&(!found||volume.path.length>found.path.length))found=volume;
  return found;
}
export async function existingAncestor(target:string):Promise<string> {
  let current=path.resolve(target);
  for(;;){try{await stat(current);return current;}catch(error){if(!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))throw error;const parent=path.dirname(current);if(parent===current)throw error;current=parent;}}
}
async function canonical(target:string):Promise<string> {const ancestor=await existingAncestor(target); return path.resolve(await realpath(ancestor),path.relative(ancestor,path.resolve(target)));}
async function requireMountedRoot(target:string):Promise<void> {
  // An unplugged macOS mount must never silently fall back to the internal /Volumes filesystem.
  if(process.platform==='darwin') {
    const match=path.resolve(target).match(/^\/Volumes\/[^/]+/);
    if(match)try{await stat(match[0]);}catch{throw new Error('The destination volume is not mounted or available.');}
  }
}
/** A backed-up drive or folder is identified by its volume UUID and the folder inside it. A
 * volume without one is known only by its path, which other disks reuse, so it is reported
 * unstable and must not authorize mirror moves. */
export function driveIdentity(resolved:string, volume?:Pick<MountedVolume,'path'|'volumeId'>):{identity:string;stable:boolean} {
  const id=volume?.volumeId;
  if(!volume || !id) return {identity:`path:${resolved}`,stable:false};
  return {identity:`volume:${id}:${path.relative(volume.path,resolved).split(path.sep).join('/')}`,stable:true};
}
export async function backupDriveIdentity(target:string, volumes?:MountedVolume[]):Promise<{identity:string;stable:boolean}> {
  const resolved=await realpath(target);
  let volume:MountedVolume|undefined;
  try {volume=volumeOf(volumes??await mountedVolumes(),resolved);} catch {}
  return driveIdentity(resolved,volume);
}
/** Total and free space of the volume a chosen source folder lives on; empty when it cannot be read. */
export async function folderCapacity(folder:string):Promise<{total?:number;free?:number}> {
  try {const capacity=await statfs(folder);return {total:Number(capacity.bsize)*Number(capacity.blocks),free:Number(capacity.bsize)*Number(capacity.bavail)};}
  catch {return {};}
}
/** The volume, physical disk and medium a chosen folder lives on, from the mount snapshot (the
 * filesystem id groups folders on a volume no snapshot entry names). */
export async function folderDrive(folder:string, volumes?:MountedVolume[]):Promise<NonNullable<Source['drive']>> {
  const resolved=await realpath(folder),dev=(await stat(resolved,{bigint:true})).dev;
  let volume:MountedVolume|undefined;
  try {volume=volumeOf(volumes??await mountedVolumes(),resolved);} catch {}
  const volumeId=volume?.volumeId ?? `filesystem:${dev}`,mount=volume?.path ?? path.parse(resolved).root;
  return {volumeId,name:volume?.name || path.basename(mount) || mount,mount,...(volume?.physicalId?{physicalId:volume.physicalId}:{}),kind:volume?.kind??'unknown'};
}
export async function volumeInfo(target:string, volumes?:MountedVolume[]):Promise<DestinationStatus> {
  try {
    await requireMountedRoot(target);
    const ancestor=await existingAncestor(target);const resolved=await realpath(ancestor);const capacity=await statfs(ancestor);
    let volume:MountedVolume|undefined;
    try {volume=volumeOf(volumes??await mountedVolumes(),resolved);} catch {}
    return {path:target,available:true,total:Number(capacity.bsize)*Number(capacity.blocks),free:Number(capacity.bsize)*Number(capacity.bavail),volumeId:volume?.volumeId ?? `filesystem:${(await stat(ancestor)).dev}`,physicalId:volume?.physicalId,detail:volume?.readOnly && !(process.platform==='darwin' && volume.path==='/')?'Read-only filesystem':undefined};
  } catch(error){return {path:target,available:false,detail:(error as Error).message};}
}
/** Pass `identity` to require the saved volume: a destination is a particular disk, not a reusable path. */
export async function validateDestination(target:string, knownSources:Source[], options:{identity?:string; volumes?:MountedVolume[]}={}):Promise<DestinationStatus> {
  if(!target || !path.isAbsolute(target))throw new MessageError('error.destinationRelative');
  await requireMountedRoot(target);
  const resolved=await canonical(target);
  for(const source of knownSources) {
    let sourcePath:string;try{sourcePath=await canonical(source.path);}catch{sourcePath=path.resolve(source.path);}
    if(within(resolved,sourcePath))throw new MessageError('error.destinationInSource');
  }
  const snapshot=options.volumes??await mountedVolumes();
  for(const volume of snapshot)if(within(resolved,volume.path)) {
    const classification=await classifyMounted(volume);
    if(classification.source)throw new MessageError('error.destinationOnCard');
    if(classification.layoutUnavailable)throw new MessageError('error.destinationUninspectable');
    // macOS sealed '/' contains writable Data-volume firmlinks such as /Users and /private.
    // access(W_OK) below checks the actual destination filesystem rather than the sealed ancestor.
    if(volume.readOnly && !(process.platform==='darwin' && volume.path==='/'))throw new MessageError('error.destinationReadOnly');
  }
  const ancestor=await existingAncestor(resolved);
  if(!(await stat(ancestor)).isDirectory())throw new MessageError('error.destinationNotFolder');
  await access(ancestor,constants.W_OK);
  const info=await volumeInfo(target,snapshot);if(!info.available)throw info.detail?new Error(info.detail):new MessageError('error.destinationUnavailable');
  if(options.identity!==undefined&&(!options.identity||options.identity!==info.volumeId))throw new MessageError('error.destinationChanged');
  return info;
}
