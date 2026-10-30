import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { mediaKindForPath } from '../media-formats';
import { sidecars } from './inventory';
import { code, contained, markFolderChanged, sameStat , unlinkEntry } from './paths';
import { log, logDeletion } from '../logger';

/**
 * macOS AppleDouble "._<name>" files. On exFAT, FAT and other volumes without extended attributes, macOS
 * writes a "._<name>" file beside every file it attaches an attribute to; the kernel attaches
 * com.apple.provenance to everything this app writes, so the app cannot prevent them. This module
 * removes only the ones that carry nothing but that bookkeeping.
 */
export const APPLEDOUBLE_MAX_BYTES=64*1024;
const MAGIC=0x00051607,VERSION=0x00020000,ATTR_MAGIC=0x41545452;
const RESOURCE_FORK=2,FINDER_INFO=9,FINDER_INFO_SIZE=32,HEADER_SIZE=26,ENTRY_SIZE=12;
/** The only extended attribute that is pure bookkeeping (the kernel attaches it to every file this app writes). Quarantine, last-used date, macl and the rest may carry meaning, so a sidecar holding them stays. com.apple.FinderInfo only counts while it is all zero. */
const BOOKKEEPING=new Set(['com.apple.provenance']);
const FINDER_INFO_ATTRIBUTE='com.apple.FinderInfo';

/** The 286-byte resource fork macOS writes into every "._" file that has none: a resource header, "This resource fork intentionally left blank", and an empty map. */
const BLANK_FORK=Buffer.concat([Buffer.from('00000100000001000000000000' + '00001e','hex'),Buffer.from('This resource fork intentionally left blank   '),Buffer.alloc(256-16-46),Buffer.from('0000010000000100000000000000001e0000000000000000001c001effff','hex')]);
export type AppleDoubleVerdict={safe:true}|{safe:false;reason:string};
const unsafe=(reason:string):AppleDoubleVerdict=>({safe:false,reason});
const zeroed=(buffer:Buffer,start:number,end:number)=>{for(let index=start;index<end;index++)if(buffer[index]!==0)return false;return true;};

/** Whether an AppleDouble file holds nothing worth keeping: no resource fork content, no Finder info
 * (tags, labels), no comments, and only bookkeeping extended attributes. Anything unreadable is not safe. */
export function inspectAppleDouble(buffer:Buffer):AppleDoubleVerdict {
  if(buffer.length>APPLEDOUBLE_MAX_BYTES)return unsafe('larger than 64 KiB');
  if(buffer.length<HEADER_SIZE)return unsafe('too short');
  if(buffer.readUInt32BE(0)!==MAGIC)return unsafe('not an AppleDouble file');
  if(buffer.readUInt32BE(4)!==VERSION)return unsafe('unknown AppleDouble version');
  const count=buffer.readUInt16BE(24);
  if(HEADER_SIZE+count*ENTRY_SIZE>buffer.length)return unsafe('entry table is cut off');
  for(let slot=0;slot<count;slot++){
    const at=HEADER_SIZE+slot*ENTRY_SIZE,id=buffer.readUInt32BE(at),offset=buffer.readUInt32BE(at+4),length=buffer.readUInt32BE(at+8);
    if(offset+length>buffer.length)return unsafe('entry runs past the end of the file');
    // macOS always writes a resource fork entry: empty, zero padding, or Apple's stub "left blank" fork. Anything else is a real one.
    if(id===RESOURCE_FORK){if(length>0&&!zeroed(buffer,offset,offset+length)&&!buffer.subarray(offset,offset+length).equals(BLANK_FORK))return unsafe('has a resource fork');continue;}
    if(id===FINDER_INFO){if(offset!==50)return unsafe('unexpected Finder info layout');const verdict=inspectFinderInfo(buffer,offset,length);if(!verdict.safe)return verdict;continue;}
    if(!zeroed(buffer,offset,offset+length))return unsafe(`has AppleDouble entry ${id}`);
  }
  return {safe:true};
}
/** The Finder info entry: 32 bytes of Finder info, 2 of padding, then the extended attributes (an "ATTR" block). */
function inspectFinderInfo(buffer:Buffer,offset:number,length:number):AppleDoubleVerdict {
  const end=offset+length;
  // 32 bytes alone, or 32 + 2 padding + an attribute block; anything in between is not a layout macOS writes.
  if(length!==FINDER_INFO_SIZE&&length<FINDER_INFO_SIZE+2)return unsafe('unexpected Finder info length');
  if(!zeroed(buffer,offset,Math.min(end,offset+FINDER_INFO_SIZE)))return unsafe('has Finder info (tags or label)');
  if(zeroed(buffer,offset,end))return {safe:true};
  const header=offset+FINDER_INFO_SIZE+2;
  if(header+36>end||buffer.readUInt32BE(header)!==ATTR_MAGIC)return unsafe('has unrecognised Finder data');
  const attributes=buffer.readUInt16BE(header+34);
  let at=header+36;
  for(let index=0;index<attributes;index++){
    if(at+11>end)return unsafe('attribute table is cut off');
    const dataOffset=buffer.readUInt32BE(at),dataLength=buffer.readUInt32BE(at+4),nameLength=buffer[at+10]!;
    if(nameLength<1||at+11+nameLength>end||buffer[at+10+nameLength]!==0)return unsafe('attribute name is damaged');
    if(dataOffset+dataLength>buffer.length)return unsafe('attribute data is cut off');
    const name=buffer.toString('utf8',at+11,at+10+nameLength);
    if(name===FINDER_INFO_ATTRIBUTE){if(!zeroed(buffer,dataOffset,dataOffset+dataLength))return unsafe('has Finder info (tags or label)');}
    else if(!BOOKKEEPING.has(name))return unsafe(`has the attribute ${name}`);
    at+=(11+nameLength+3)&~3;
  }
  return {safe:true};
}

export interface AppleDoubleReport {
  /** "._" files of files this job placed or moved (or found beside media and companions) that were removed. */
  removed:number;
  /** Kept because they might hold something: tags, comments, a resource fork, or anything unrecognised. */
  kept:number;
  /** Removed "._" files whose main file no longer exists. */
  orphans:number;
  /** Failures to look at or remove one; the job goes on and the file stays. */
  warnings:string[];
  /** Folders the sweep could not read. */
  folderWarnings:string[];
  /** Per-file detail for the job's grouped issues: the "._" files kept (the first MAX_DETAILS) and those or folders that failed. */
  keptFiles:string[];
  failures:{path:string;detail:string;folder?:boolean}[];
}
const MAX_WARNINGS=20,MAX_DETAILS=1000;
export const emptyAppleDoubleReport=():AppleDoubleReport=>({removed:0,kept:0,orphans:0,warnings:[],folderWarnings:[],keptFiles:[],failures:[]});
export function addAppleDoubleReport(total:AppleDoubleReport,part:AppleDoubleReport|undefined):void {
  if(!part)return;
  total.removed+=part.removed;total.kept+=part.kept;total.orphans+=part.orphans;
  for(const warning of part.warnings)if(total.warnings.length<MAX_WARNINGS)total.warnings.push(warning);
  for(const warning of part.folderWarnings)if(total.folderWarnings.length<MAX_WARNINGS)total.folderWarnings.push(warning);
  for(const file of part.keptFiles)if(total.keptFiles.length<MAX_DETAILS)total.keptFiles.push(file);
  for(const failure of part.failures)if(total.failures.length<MAX_DETAILS)total.failures.push(failure);
}
export const appleDoubleActivity=(report:AppleDoubleReport)=>report.removed+report.kept+report.orphans+report.warnings.length+report.folderWarnings.length>0;

/** "._" + name, in the same folder; undefined for a name that already is one. */
export const sidecarOf=(file:string)=>{const name=path.basename(file);return name.startsWith('._')?undefined:path.join(path.dirname(file),'._'+name);};
const text=(error:unknown)=>error instanceof Error?error.message:String(error);

/**
 * Removes "._" files under a job's roots. Every operation is bounded by the root it is given, never
 * follows a link, never throws for a file it cannot judge or remove (that becomes a warning and the file
 * stays), and leaves folders in `protectedNames` (recovery storage, Problem files, Drive backups) alone.
 */
export class AppleDoubleCleaner {
  readonly report:AppleDoubleReport=emptyAppleDoubleReport();
  private readonly protectedNames:Set<string>;
  private readonly existed=new Set<string>();
  constructor(protectedNames:Iterable<string>=[]){this.protectedNames=new Set([...protectedNames].map(name=>name.toLowerCase()));}
  private protects(file:string,root:string):boolean {
    return path.relative(root,path.dirname(file)).split(path.sep).some(part=>this.protectedNames.has(part.toLowerCase()));
  }
  /** A "._" file that could not be judged or removed: it stays. */
  warn(file:string,error:unknown){log('normal','appledouble','warning',{path:file,code:code(error)??'error',error});if(this.report.warnings.length<MAX_WARNINGS)this.report.warnings.push(`${file}: ${text(error)}`);if(this.report.failures.length<MAX_DETAILS)this.report.failures.push({path:file,detail:text(error)});}
  private keep(sidecar:string,why='not provably bookkeeping only'){log('detailed','appledouble','kept',{path:sidecar,reason:why});this.report.kept++;if(this.report.keptFiles.length<MAX_DETAILS)this.report.keptFiles.push(sidecar);}
  /** A folder that could not be read, so its "._" files were not looked at. */
  warnFolder(folder:string,error:unknown){log('normal','appledouble','folder-warning',{path:folder,code:code(error)??'error',error});this.report.folderWarnings.push(`${folder}: ${text(error)}`);this.report.folderWarnings.splice(MAX_WARNINGS);if(this.report.failures.length<MAX_DETAILS)this.report.failures.push({path:folder,detail:text(error),folder:true});}
  /** Import: call before the file is created. A "._" already there is not ours (an orphan from earlier): it is kept, counted, and never removed by this job. */
  async noteExisting(file:string):Promise<void> {
    const sidecar=sidecarOf(file);
    if(!sidecar||this.existed.has(sidecar))return;
    try{await fs.lstat(sidecar);this.existed.add(sidecar);this.keep(sidecar);}
    catch(error){if(code(error)!=='ENOENT')this.warn(sidecar,error);}
  }
  /** Removes the "._" file beside `file` while `file` is still the one just placed: `placed` judges its current stat. */
  async besideFile(file:string,root:string,placed:(stat:import('node:fs').BigIntStats)=>boolean):Promise<void> {
    const sidecar=sidecarOf(file);
    if(!sidecar||this.protects(sidecar,root)||this.existed.has(sidecar))return;
    try{
      const stat=await fs.lstat(file,{bigint:true}).catch(error=>{if(code(error)==='ENOENT')return undefined;throw error;});
      if(!stat||!stat.isFile()||!placed(stat))return;
      await this.remove(sidecar,root,'removed');
    }catch(error){this.warn(sidecar,error);}
  }
  /** Removes the "._" file left where `file` used to be, once `file` is truly gone from there. */
  async besideGone(file:string,root:string):Promise<void> {
    const sidecar=sidecarOf(file);
    if(!sidecar||this.protects(sidecar,root))return;
    try{
      if(await fs.lstat(file).then(()=>true,error=>{if(code(error)==='ENOENT')return false;throw error;}))return;
      await this.remove(sidecar,root,'removed');
    }catch(error){this.warn(sidecar,error);}
  }
  /** "._X" files in the given folders (not below them) whose X is a media or companion file beside them, or is gone altogether
   * (orphans). Never throws: a folder that cannot be read is reported and skipped, and a stop ends the sweep quietly. */
  async sweep(root:string,folders:Iterable<string>,signal?:AbortSignal,onFolder?:(done:number,folder:string)=>void):Promise<void> {
    let device:bigint;
    try{device=(await fs.lstat(root,{bigint:true})).dev;}catch(error){this.warnFolder(root,error);return;}
    let done=0;
    for(const folder of folders){
      if(signal?.aborted)return;
      onFolder?.(++done,folder);
      if(this.protects(path.join(folder,'.x'),root))continue;
      try{
        await contained(path.join(folder,'.x'),root);
        if((await fs.lstat(folder,{bigint:true})).dev!==device)continue;
        await this.sweepFolder(folder,root);
      }catch(error){if(code(error)!=='ENOENT')this.warnFolder(folder,error);}
    }
  }
  private async sweepFolder(folder:string,root:string):Promise<void> {
    const entries=await fs.readdir(folder,{withFileTypes:true});
    const names=new Set(entries.map(entry=>entry.name.normalize('NFC').toLowerCase()));
    for(const entry of entries){
      if(!entry.name.startsWith('._')||entry.name.length<3||!entry.isFile())continue;
      const file=path.join(folder,entry.name),main=entry.name.slice(2);
      if(names.has(main.normalize('NFC').toLowerCase())){
        // The main file is there: only media and their companions count, and it must be a plain file.
        if(mediaKindForPath(main)==='Other'&&!sidecars.has(path.extname(main).slice(1).toLowerCase()))continue;
        try{if(!(await fs.lstat(path.join(folder,main))).isFile())continue;}catch(error){this.warn(file,error);continue;}
        await this.remove(file,root,'removed');
      } else {
        // Gone from the listing: confirm with the filesystem before treating it as an orphan.
        try{await fs.lstat(path.join(folder,main));continue;}catch(error){if(code(error)!=='ENOENT'){this.warn(file,error);continue;}}
        await this.remove(file,root,'orphans');
      }
    }
  }
  /** The safety check and the removal of one "._" file; a missing file is nothing to do. */
  private async remove(sidecar:string,root:string,count:'removed'|'orphans'):Promise<void> {
    try{
      const before=await fs.lstat(sidecar,{bigint:true}).catch(error=>{if(code(error)==='ENOENT')return undefined;throw error;});
      if(!before)return;
      if(!before.isFile()||before.size>BigInt(APPLEDOUBLE_MAX_BYTES)){this.keep(sidecar);return;}
      await contained(sidecar,root);
      const handle=await fs.open(sidecar,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
      let verdict:AppleDoubleVerdict;
      try{
        const opened=await handle.stat({bigint:true});
        if(!opened.isFile()||!sameStat(before,opened)){this.keep(sidecar);return;}
        verdict=inspectAppleDouble(await handle.readFile());
      }finally{await handle.close();}
      if(!verdict.safe){this.keep(sidecar);return;}
      // Unchanged since it was read, so what is removed is what was judged.
      if(!sameStat(before,await fs.lstat(sidecar,{bigint:true}))){this.keep(sidecar);return;}
      await unlinkEntry(sidecar);
      logDeletion('appledouble',sidecar,count==='removed'?'AppleDouble sidecar beside its media file':'orphan AppleDouble sidecar: its main file is gone',`inspectAppleDouble: safe (bookkeeping attributes only); ${before.size} bytes; unchanged between reading and removal; lstat of the main file ${count==='removed'?'found a plain file':'found nothing'}`,{bytes:Number(before.size),kind:count});
      this.report[count]++;
      markFolderChanged(path.dirname(sidecar));
    }catch(error){this.warn(sidecar,error);}
  }
}
