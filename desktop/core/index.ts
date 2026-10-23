import * as fs from 'node:fs/promises';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { DuplicateFile, ExecutionIssue, Inventory, InventoryFile, MediaLayout, Metadata, PlanEntry, ProblemFile, Progress, TransferPlan, UnknownDefault, UnknownFileRule } from '../shared';
import { PROBLEM_FILES_FOLDER, PROBLEM_FILE_GROUPS } from '../shared';
import { listingEstimate, type ListingHint } from '../listing-estimate';
import { inventory, extension, stem, rules, nkscEdit, captureOneEdit, unknownRule, type RuleDefaults } from './inventory';
import { destinationIndex, flushIndex, type DestinationIndex, type Digests } from './destination-index';
import { DRIVE_BACKUPS, claimDriveFolder, driveFolder, mirrorChanges, moveMirrorRemovals, type Drive, type ReviewedRemoval } from './drive-backup';
import {applyFileTimestamps,captureTimestamp} from '../platform/file-timestamps';
import { formatFolder, layoutFolders } from '../media-formats';
import { beneath, checkAbort, code, contained, digest, directory, identity, isAbort, makeParent, pathKey, regularHandle, rootUnchanged, safeComponent, sameBirth, sameStat, statKey, unreliableIno, validateRelative, syncDirectory, syncParents, syncFile } from './paths';
export { inventory } from './inventory';
export { removeRedundantFolders, removeOrganizedFolders } from './redundant-folders';
export { allocateDestinations } from './allocation';
import { streams, CHECK_CONCURRENCY } from './devices';
import { hasher } from './hasher';
import { confirmCandidates, type PlanDuplicates } from './duplicates';
import { buildGroups } from '../duplicate-rules';
import { beginOrganization, importRecoveryAvailable, RECOVERY_FOLDER, LEGACY_RECOVERY_FOLDER, type OrganizationEntry } from './recovery';
import { AppleDoubleCleaner, type AppleDoubleReport } from './appledouble';
export type { AppleDoubleReport } from './appledouble';
import {recordPartial,recordCreation,releaseCreations,findPartial,openPartial,clearPartialRecord,type OwnedPartial,type RecoveryIndex} from './import-recovery';
import {MessageError,toMessage} from '../messages';
import type {PlacedFile} from '../platform/placement-memory';
import { log, logDeletion } from '../logger';
export { placedByEarlierJournals, beginDuplicateRemoval, configureOrganizationRecovery, getOrganizationRecovery, resumeOrganization, finalizeOrganization, undoOrganization, deleteOrganizationRecovery, measureOrganizationRecovery, RECOVERY_FOLDER, setMoveObserver } from './recovery';
export type { OrganizationRecovery, ReorganizationResult, OrganizationFinalization, OrganizationProgress, OrganizationStrategy, OrganizationUndo } from './recovery';

/** Files examined at once while planning; ExifTool itself caps its processes. */
const PLAN_CONCURRENCY=Math.max(2,Math.min(8,availableParallelism()));
/** Whole files hashed or copied at once by one job; each device's own limit (devices.ts) still
 * applies, so a spinning disk serves them one at a time. */
const STREAM_CONCURRENCY=4;
/** Bounded worker pool in input order; the first failure stops new work and is rethrown. */
async function pool<T>(items:T[],limit:number,work:(item:T)=>Promise<void>):Promise<void> {
  let next=0,failure:unknown;
  await Promise.all(Array.from({length:Math.min(items.length,limit)},async()=>{
    while(failure===undefined && next<items.length) {const item=items[next++]!;try { await work(item); } catch(error) { failure??=error; }}
  }));
  if(failure!==undefined) throw failure;
}
interface Options {backup:boolean;template:string;layout:MediaLayout;/** video-root: the video folder template (empty or absent: `template`). */videoTemplate?:string;/** video-root: each root's video backup folder on the same destination, by position. */videoRoots?:string[];unknownRules:Record<string,UnknownFileRule>;reorganize?:boolean;/** Organization: move 0-byte files (and their families) into Problem files. */collectProblems?:boolean;editedFolder?:string;sourceFolders?:string[];/** What an earlier listing of this scope found, to estimate how far a listing is. */listingHint?:ListingHint;/** Called when the listing ends with the files and bytes it found. */onListed?:(files:number,bytes:number)=>void;drive?:Drive;unknownDefault?:UnknownDefault;/** SHA-256 remembered for a source whose identity (dev:ino:size:mtimeNs:ctimeNs) is unchanged since it was copied. */sourceDigest?:(file:string,identity:string)=>string|undefined;/** A finished scan of this source, reused while its folders are unchanged. */reuse?:Inventory;/** Library organization: stop after routing and list the files that would move. */misplacedOnly?:boolean;/** misplacedOnly: true for a file already known to be in place (same size, mtime and inode as when it was checked). Its metadata is not read and it is not counted, unless a changed file sits beside it. */inPlace?:(relative:string,size:number,mtimeNs:bigint,ino:bigint)=>boolean;/** A file that cannot be checked, read or allocated is left out of the plan and listed in `failures` instead of failing the whole plan. */skipErrors?:boolean;/** Source files the user chose to skip: left out with their families, whatever skipErrors is. */exclude?:string[];/** Duplicate detection stage 1: hash the files that share a name or EXIF identity right away and report them in `duplicates`. Nothing is ever removed because of it. */duplicates?:boolean;}
interface ReviewedSource {captureTimeMs?:number;stat:import('node:fs').BigIntStats;source:string;destination:string;digest?:string;}
/** Resolves an entry's SHA-256: planned, streamed, or hashed on demand. */
type Resolve=(entry:PlanEntry,signal?:AbortSignal)=>Promise<string>;
// Only a plan produced for an explicit library review can authorize relocation.
// A renderer-provided or reconstructed TransferPlan cannot opt into moving files.
const reorganizationReviews=new WeakMap<TransferPlan,Map<string,ReviewedSource>>();
// Mirror moves are likewise limited to removals found by plan() for that plan.
const mirrorReviews=new WeakMap<TransferPlan,ReviewedRemoval[]>();
const reorganizationScopes=new WeakMap<TransferPlan,{source:string;sourceIdentity:string;root:string;rootIdentity:string;libraries:string[]}>();
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
/** The media a file is filed as: its own, or for a companion its original's. Absent for a file
 * with neither, which stays directly in the camera folder. */
interface Media {video:boolean;format:string;}
/** `camera`: the templated folder (a family's conflict folder lives there); `sub`: the layout's
 * folders inside it; `root`: which backup folder, the video one only in the video-root layout. */
function folder(info:Metadata,mtime:Date,media:Media|undefined,options:Options):{root:'photos'|'videos';camera:string;sub:string} {
  // Capture dates describe the camera's calendar day. Converting an EXIF
  // offset to UTC can move a midnight photo into the previous folder.
  const calendar=info.date?.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/);
  const candidate=calendar ? new Date(`${calendar[1]}-${calendar[2]}-${calendar[3]}T00:00:00Z`):null;
  const validCalendar=!!candidate && Number.isFinite(candidate.getTime()) && candidate.toISOString().slice(0,10)===calendar![0].slice(0,10);
  // Without a capture date, the file's modified time is read on this Mac's calendar, as
  // the camera's clock would have shown it, not in UTC.
  const capture=validCalendar?candidate!:new Date(Date.UTC(mtime.getFullYear(),mtime.getMonth(),mtime.getDate()));
  const year=String(capture.getUTCFullYear()).padStart(4,'0'), month=String(capture.getUTCMonth()+1).padStart(2,'0'), day=String(capture.getUTCDate()).padStart(2,'0');
  // Month names are English whatever the app language; the number first keeps calendar order.
  const monthName=`${month} ${MONTHS[capture.getUTCMonth()]}`;
  const values:Record<string,string>={year,month,day,yyyymm:year+month,yyyyMMdd:year+month+day,monthName,yearMonthName:`${year}-${monthName}`,camera:safeComponent(info.camera?.trim()||info.origin||'Unknown Camera')};
  const editedFolder=options.editedFolder??'editied';
  if(!editedFolder||editedFolder!==safeComponent(editedFolder)||/[{}]/.test(editedFolder)||/[\\/]/.test(editedFolder)||editedFolder==='.'||editedFolder==='..')throw new Error('Choose a single safe folder name for edited exports.');
  const video=options.layout==='video-root'&&!!media?.video;
  const template=info.edited?`{year}/{yyyymm}/${editedFolder}/{camera}`:video&&options.videoTemplate?options.videoTemplate:options.template;
  // The template is checked, not the result: a camera name may itself contain braces.
  if(/[{}]/u.test(template.replace(/\{([^{}]+)\}/g,(token,key:string)=>Object.hasOwn(values,key)?'':token))) throw new MessageError('error.invalidTemplate',{template});
  const result=template.replace(/\{([^{}]+)\}/g,(_token,key:string)=>values[key]!);
  validateRelative(result);
  // Edited exports stay directly in their edited camera folder.
  return {root:video?'videos':'photos',camera:result,sub:media&&!info.edited?path.join(...layoutFolders(options.layout,media.video,media.format)):''};
}
function groups(entries:PlanEntry[]):PlanEntry[][] {
  const families=new Map<string,PlanEntry[]>();
  for(const entry of entries) {const family=families.get(entry.family)??[]; family.push(entry); families.set(entry.family,family);}
  return [...families.values()];
}
// Conflicts/<content id> retains original names and camera/media grouping.
// Allocation metadata is serialized with the plan so review roundtrips preserve
// the same policy if another writer arrives after planning.
function target(entry:PlanEntry,attempt:number,family:PlanEntry[],digests?:Map<string,string>):string {
  const original=entry.allocation??{destination:entry.destination,folder:path.dirname(entry.destination)};
  if(!attempt)return original.destination;
  const content=createHash('sha256').update(JSON.stringify(family.map(member=>[path.basename(member.source),digests!.get(member.id)!]).sort((a,b)=>a[0]!.localeCompare(b[0]!)||a[1]!.localeCompare(b[1]!)))).digest('hex').slice(0,16);
  return path.join(original.folder,'Conflicts',content+(attempt>1?'-'+attempt:''),path.relative(original.folder,original.destination));
}
/** null: nothing there. A different size is a different file without reading
 * anything; equal sizes compare SHA-256 values (the destination via its index). */
async function existingMatches(file:string,size:number,expected:()=>Promise<string>,root:string,index:Digests,signal?:AbortSignal):Promise<boolean|null> {
  await contained(file,root);
  let stat;
  try { stat=await fs.lstat(file,{bigint:true}); } catch(error) { if(code(error)==='ENOENT') return null; throw error; }
  if(!stat.isFile() || stat.size!==BigInt(size)) return false;
  return await index.digestOf(file,signal)===await expected();
}
async function allocate(family:PlanEntry[],root:string,reservations:Map<string,PlanEntry>,recovery:RecoveryIndex,resolve:Resolve,index:Digests,signal?:AbortSignal,known?:Map<string,boolean>):Promise<{entry:PlanEntry;destination:string;skip:boolean}[]> {
  for(let attempt=0;;attempt++) {
    checkAbort(signal);
    // Conflict folders are named by content, so only then is the whole family hashed.
    const digests=attempt?new Map<string,string>():undefined;
    if(digests) for(const member of family) digests.set(member.id,await resolve(member));
    const proposed=new Map<string,PlanEntry>(), allocation=[];
    let conflict=false;
    for(const entry of family) {
      const destination=target(entry,attempt,family,digests), key=pathKey(destination), reserved=proposed.get(key)??reservations.get(key);
      const same=reserved===undefined?undefined:reserved.size===entry.size && await resolve(reserved)===await resolve(entry);
      if(same===false) {log('detailed','plan','destination-check',{source:entry.source,destination,decision:'conflict',reason:`another file in this plan is filed at ${destination} with different content`,attempt});conflict=true;break;}
      const reviewed=known?.get(key),exists=reviewed===undefined?await existingMatches(destination,entry.size,()=>resolve(entry),root,index,signal):reviewed||null;
      const resumable=exists===false&&await findPartial('publication',{...entry,destination,digest:await resolve(entry)},root,recovery,signal);
      log('detailed','plan','destination-check',()=>({source:entry.source,destination,attempt,decision:exists===true||same===true?'skip':exists===false&&!resumable?'conflict':'copy',reason:same===true?`same SHA-256 as another file of this plan filed at ${destination}`:exists===true?`skip: same SHA at path ${destination}`:exists===false?(resumable?'copy: an interrupted copy of this file there is resumed':`conflict: ${destination} holds a different file of the same size or an unrelated one`):'copy: no match at the destination',size:entry.size,sha256:entry.digest}));
      if(exists===false&&!resumable) {conflict=true;break;}
      if(!reserved) proposed.set(key,entry);
      allocation.push({entry,destination,skip:exists===true || same===true});
    }
    if(!conflict) { for(const [key,value] of proposed) reservations.set(key,value); return allocation; }
  }
}
function contradicts(a:Metadata,b:Metadata):boolean {
  if(a.camera?.trim() && b.camera?.trim() && a.camera.trim().toLowerCase()!==b.camera.trim().toLowerCase()) return true;
  const capture=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/;
  const left=a.date?.match(capture),right=b.date?.match(capture);
  if(!left || !right || !!left[3]!==!!right[3]) return false;
  // Missing offsets describe a wall clock, so the host timezone must never
  // supply an instant. Compare explicit offsets only when both are known.
  if(left[3] && right[3]) {
    const leftSecond=Date.parse(left[1]+left[3]),rightSecond=Date.parse(right[1]+right[3]);
    if(!Number.isFinite(leftSecond) || !Number.isFinite(rightSecond)) return false;
    if(leftSecond!==rightSecond) return true;
  } else if(left[1]!==right[1]) return true;
  // Absent fractional digits are unknown precision rather than recorded zeros.
  const precision=Math.min(left[2]?.length??0,right[2]?.length??0);
  return (left[2]??'').slice(0,precision)!==(right[2]??'').slice(0,precision);
}
/** A source file left out of a plan because of `error`; nothing was written for it. */
export interface PlanFailure {path:string;error:Error;}
/** Live Photos: pairs each .mov with the same-stem still (HEIC/HEIF/JPG) whose ContentIdentifier agrees, or, when
 * either lacks one, whose make is Apple, and sets `companionOf` on it. Indexed once by stem, so the cost is linear in
 * the number of files. `dropped` holds Apple videos whose same-stem still is empty and so never imported. */
export function pairLivePhotos(files:InventoryFile[],scanned:InventoryFile[],infos:Map<string,Metadata>,hooks:{signal?:AbortSignal;stemOf?:(file:string)=>string}={}):{paired:Set<string>;dropped:Set<string>} {
  const stemOf=hooks.stemOf??stem,stillExtensions=['heic','heif','jpg','jpeg'],apple=(info?:Metadata)=>/^apple\b/i.test(info?.make??'');
  const stillsByStem=new Map<string,InventoryFile[]>(),emptyStems=new Set<string>(),paired=new Set<string>(),dropped=new Set<string>();
  for(const f of scanned) if(stillExtensions.includes(extension(f.path))) {
    if(f.size===0) emptyStems.add(stemOf(f.path));
  }
  for(const f of files) if(stillExtensions.includes(extension(f.path))) {const key=stemOf(f.path);const list=stillsByStem.get(key);if(list)list.push(f);else stillsByStem.set(key,[f]);}
  for(const list of stillsByStem.values()) list.sort((a,b)=>stillExtensions.indexOf(extension(a.path))-stillExtensions.indexOf(extension(b.path)));
  for(const mov of files) {
    checkAbort(hooks.signal);
    if(mov.kind!=='Videos'||extension(mov.path)!=='mov'||mov.companionOf) continue;
    const own=infos.get(mov.path),key=stemOf(mov.path);
    const still=(stillsByStem.get(key)??[]).find(f=>{const info=infos.get(f.path);return info?.contentId&&own?.contentId?info.contentId===own.contentId:apple(info);});
    if(still) {mov.companionOf=still.path;paired.add(mov.path);}
    // An empty still is never imported, so an Apple video that shares its stem stays beside it.
    else if(apple(own)&&emptyStems.has(key)) dropped.add(mov.path);
  }
  return {paired,dropped};
}
export async function plan(source:string,roots:string[],options:Options,metadata:(file:string)=>Promise<Metadata>,signal?:AbortSignal,onProgress?:PlanProgress):Promise<{inventory:Inventory;plans:TransferPlan[];failures:PlanFailure[];problems:ProblemFile[];duplicates?:PlanDuplicates}> {
  if(!options.reuse) return planOnce(source,roots,options,metadata,signal,onProgress);
  // A file rewritten in place leaves its folder unchanged, so a remembered listing
  // can hold a stale size. List the card again once rather than failing.
  const changed=(error:unknown)=>error instanceof MessageError && error.key==='error.sourceChanged';
  // A skipped change may be the stale listing too, so it is listed again before anything is skipped.
  try { const result=await planOnce(source,roots,options,metadata,signal,onProgress); if(!result.failures.some(failure=>changed(failure.error))) return result; }
  catch(error) { if(isAbort(error) || !changed(error)) throw error; }
  return planOnce(source,roots,{...options,reuse:undefined},metadata,signal,onProgress);
}
/** Read-only check of an organized library: the files in `source` (relative to it) that are not
 * where the folder rules put them under `root` (and the video root of the video-root layout).
 * `source` is the library itself or a folder holding it. Nothing is read beyond names, sizes and metadata. */
export async function findMisplaced(source:string,root:string,options:Omit<Options,'reorganize'|'misplacedOnly'|'backup'|'drive'>&{backup?:boolean},metadata:(file:string)=>Promise<Metadata>,signal?:AbortSignal,onProgress?:PlanProgress):Promise<{count:number;bytes:number;files:string[];placed:PlacedFile[]}> {
  const {plans:[found],placed=[]}=await planOnce(source,[root],{...options,backup:false,reorganize:true,misplacedOnly:true},metadata,signal,onProgress);
  const entries=[...found?.entries??[],...found?.videos?.entries??[]];
  return {count:entries.length,bytes:entries.reduce((sum,entry)=>sum+entry.size,0),files:entries.map(entry=>path.relative(found!.source,entry.source)),placed};
}
/** Planning progress: `count` files of `detail.total` done. Every plan first checks each file
 * (metadata and identity, without reading contents); library organization then reads the files
 * that will move to checksum them. */
/** step 'listing': files found so far (total and share are estimates, see listing-estimate.ts); 'checking': metadata of every file; 'reading': files organization moves;
 * 'comparing': planned files compared with what each destination already holds (bytes: source data read to compare, totalBytes 0). */
export type PlanProgress=(count:number,file:string,detail?:{step:'listing'|'checking'|'reading'|'comparing'|'candidates';total:number;bytes:number;totalBytes:number;share?:number})=>void;
async function planOnce(source:string,roots:string[],options:Options,metadata:(file:string)=>Promise<Metadata>,signal?:AbortSignal,onProgress?:PlanProgress):Promise<{inventory:Inventory;plans:TransferPlan[];failures:PlanFailure[];problems:ProblemFile[];duplicates?:PlanDuplicates;placed?:PlacedFile[]}> {
  checkAbort(signal);
  if(!roots.length)throw new Error('Choose at least one destination.');
  if(options.reorganize&&roots.length!==1)throw new Error('Review one organization destination at a time.');
  const sourceRoot=await directory(source),custom=rules(options.reorganize?{}:options.unknownRules);
  // Library organization never adopts unknown files, whatever the import defaults are.
  const defaults:RuleDefaults=options.reorganize?{fallback:'skip',builtins:false}:{fallback:options.unknownDefault??'skip',builtins:true};
  const videoRoots=!options.backup&&options.layout==='video-root'?options.videoRoots:undefined;
  if(!options.backup&&options.layout==='video-root'&&videoRoots?.length!==roots.length)throw new MessageError('error.videoFolderMissing');
  const sourceIdentity=await identity(sourceRoot),excludedRoots:string[]=[];
  type Root={root:string;identity:string};
  const destinations:(Root&{videos?:Root})[]=[];
  // Each backup folder (and the video one beside it) is checked against the source alike.
  async function backupRoot(root:string):Promise<Root> {
    const destinationRoot=await directory(root);
    if(options.reorganize) {
      if(options.backup || (sourceRoot!==destinationRoot && !beneath(destinationRoot,sourceRoot)) || (await fs.lstat(sourceRoot,{bigint:true})).dev!==(await fs.lstat(destinationRoot,{bigint:true})).dev) throw new Error('Reorganization requires the same library or a base folder beneath it on the same filesystem and cannot use backup mode.');
    } else if(sourceRoot===destinationRoot || beneath(sourceRoot,destinationRoot)) throw new MessageError('error.alreadyInBackup',{source:sourceRoot,root:destinationRoot});
    // A backup folder inside the chosen source is left out of it, so the backup is never copied into itself.
    else if(beneath(destinationRoot,sourceRoot)) excludedRoots.push(destinationRoot);
    return {root:destinationRoot,identity:await identity(destinationRoot)};
  }
  for(const [position,root] of roots.entries()){
    const photos=await backupRoot(root),videos=videoRoots?await backupRoot(videoRoots[position]!):undefined;
    if(videos&&(videos.root===photos.root||beneath(videos.root,photos.root)||beneath(photos.root,videos.root)))throw new MessageError('error.videoFolderNested');
    destinations.push({...photos,...(videos?{videos}:{})});
  }
  const allRoots=destinations.flatMap(item=>[item,...(item.videos?[item.videos]:[])]);
  if(options.drive&&!options.backup)throw new Error('Only drive backups use a drive folder.');
  if(!options.backup) {folder({fields:{}},new Date(0),undefined,options);folder({fields:{}},new Date(0),{video:true,format:'MOV'},options);}
  // Organization leaves drive backups (a copy of each drive's own layout) and conflict copies where they are.
  // The Problem files folder is the app's own, like Drive backups: never organized again, never misplaced.
  if(options.reorganize) excludedRoots.push(...allRoots.flatMap(({root})=>[path.join(root,DRIVE_BACKUPS),path.join(root,PROBLEM_FILES_FOLDER)]));
  const organizationOwned=(file:string)=>options.reorganize===true&&allRoots.some(({root})=>beneath(file,root)&&path.relative(root,path.dirname(file)).split(path.sep).includes('Conflicts'));
  // With skipErrors a failing file is left out and reported; otherwise it fails the plan. A mirror
  // never skips: a file left out of it would read as removed from the drive and its copy moved away.
  // An organization always skips: leaving a file where it is is safe, and one bad file must not stop the rest.
  const skipping=options.reorganize===true||options.skipErrors===true&&!options.drive?.mirror;
  // Otherwise the error names its file, so the user can skip that file by hand.
  const failures=new Map<string,Error>(),unreadable=new Set<string>(),skip=(file:string,error:unknown)=>{if(isAbort(error))throw error;if(['EACCES','EPERM','EIO'].includes(code(error)??''))unreadable.add(file);if(!skipping)throw error instanceof MessageError&&typeof error.params?.path==='string'?error:new MessageError('error.fileFailed',{path:file,error:toMessage(error)});failures.set(file,toError(error));};
  if(options.exclude?.length&&options.drive?.mirror)throw new Error('A mirror backup cannot skip files.');
  for(const file of options.exclude??[])failures.set(file,new MessageError('error.userSkipped'));
  // A file is copied or moved with its whole family (RAW, JPG, sidecars), so a failure leaves the family out.
  const skipFamilies=<T>(items:T[],file:(item:T)=>string,family:(item:T)=>string|undefined)=>{
    const failed=new Map<string,Error>();for(const item of items){const error=failures.get(file(item)),key=family(item);if(error&&key!==undefined&&!failed.has(key))failed.set(key,error);}
    for(const item of items){const key=family(item);if(key!==undefined&&failed.has(key)&&!failures.has(file(item)))failures.set(file(item),failed.get(key)!);}
  };
  const listingStart=performance.now();
  const scan=await inventory(sourceRoot,{...(skipping?{onError:skip}:{}),backup:options.backup,unknownRules:custom,unknownDefault:defaults.fallback,builtinRules:defaults.builtins,folders:options.sourceFolders,reuse:options.reuse,exclude:excludedRoots,onProgress:(found,bytes,top,latest)=>onProgress?.(found,latest??'',{step:'listing',bytes,...listingEstimate(options.listingHint,{files:found,bytes},top)})},signal);
  options.onListed?.(scan.files.length,scan.files.reduce((sum,file)=>sum+file.size,0));
  log('detailed','plan','inventory',()=>{const skipped:Record<string,number>={};for(const item of scan.skipped??[])skipped[item.reason]=(skipped[item.reason]??0)+1;return {source:sourceRoot,folders:scan.listing?.folders.length,files:scan.files.length,media:scan.media,companions:scan.companions,unknown:scan.unknown,systemJunkSkipped:scan.system??0,emptyFiles:scan.empty??0,skipped,bytes:scan.bytes,reusedListing:!!options.reuse,elapsedMs:Math.round(performance.now()-listingStart),scanElapsedMs:scan.elapsedMs,sourceFolders:options.sourceFolders,reorganize:!!options.reorganize,backup:!!options.backup};});
  let files=scan.files.filter(f=>f.included&&!organizationOwned(f.path));
  // 0-byte files and their families are never imported. An organization may collect them (below); every one is reported.
  const problems:ProblemFile[]=[],scanned=new Map(scan.files.map(file=>[file.path,file]));
  for(const item of scan.skipped??[]) if((item.reason==='empty'||item.reason==='emptyPrimary')&&!organizationOwned(item.path)) problems.push({path:item.path,relative:path.relative(sourceRoot,item.path),reason:item.reason,group:'empty',collected:false});
  const listedBytes=files.reduce((sum,file)=>sum+file.size,0);let checkedBytes=0;
  const infos=new Map<string,Metadata>(), hashes=new Map<string,string>(), mtimes=new Map<string,Date>(), sourceStats=new Map<string,import('node:fs').BigIntStats>();
  // Copies hash the bytes they stream, so planning reads file contents only for
  // files library organization will move or when a same-size file already occupies a destination.
  // Metadata reads overlap (ExifTool runs several processes); issues keep file order.
  const issues:{path:string;message:string}[][]=files.map(()=>[]);let done=0,next=0,failure:unknown;
  // A library check skips files remembered as in place. A changed file is checked with its neighbours (same folder or
  // the one above it), so families and companions still see each other's metadata.
  const trusted=new Set<string>();let trustedFiles:InventoryFile[]=[];
  if(options.misplacedOnly&&options.inPlace) {
    let at=0;
    await Promise.all(Array.from({length:Math.min(files.length,CHECK_CONCURRENCY)},async()=>{
      while(at<files.length) {
        const file=files[at++]!;checkAbort(signal);
        try {const stat=await fs.lstat(file.path,{bigint:true});if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===BigInt(file.size)&&options.inPlace!(file.relative,file.size,stat.mtimeNs,stat.ino))trusted.add(file.path);}
        catch(error) {if(isAbort(error))throw error;}
      }
    }));
    const hot=new Set<string>();
    for(const file of files) if(!trusted.has(file.path)) {const dir=path.dirname(file.path);hot.add(dir);hot.add(path.dirname(dir));}
    for(const file of files) if(trusted.has(file.path)) {const dir=path.dirname(file.path);if(hot.has(dir)||hot.has(path.dirname(dir)))trusted.delete(file.path);}
  }
  async function examine(file:InventoryFile,position:number):Promise<void> {
    await contained(file.path,sourceRoot);
    const originalStat=await fs.lstat(file.path,{bigint:true});
    if(!originalStat.isFile() || originalStat.isSymbolicLink() || originalStat.size!==BigInt(file.size)) throw new MessageError('error.sourceChanged',{path:file.path});
    mtimes.set(file.path,originalStat.mtime);
    if(!options.backup && file.kind!=='Other' && !trusted.has(file.path)) {
      try {const info=await metadata(file.path);for(const message of new Set(Object.entries(info.fields).filter(([key,value])=>key.split(':').at(-1)==='Error'&&typeof value==='string'&&value.trim()).map(([,value])=>value as string)))issues[position]!.push({path:file.path,message});infos.set(file.path,{camera:info.camera,origin:info.origin,date:info.date,edited:info.edited,contentId:info.contentId,make:info.make,fingerprint:info.fingerprint,fields:{}});} catch(error) {if(isAbort(error)) throw error;issues[position]!.push({path:file.path,message:error instanceof Error?error.message:String(error)});infos.set(file.path,{fields:{}});}
    }
    if(!sameStat(originalStat,await fs.lstat(file.path,{bigint:true}))) throw new MessageError('error.sourceChanged',{path:file.path});
    sourceStats.set(file.path,originalStat);
    checkedBytes+=file.size;onProgress?.(++done,file.relative,{step:'checking',total:files.length,bytes:checkedBytes,totalBytes:listedBytes});
  }
  await Promise.all(Array.from({length:Math.min(files.length,CHECK_CONCURRENCY)},async()=>{
    while(failure===undefined && next<files.length) {
      const position=next++;
      try { checkAbort(signal); if(!failures.has(files[position]!.path)) await examine(files[position]!,position); } catch(error) { try { skip(files[position]!.path,error); } catch(thrown) { failure??=thrown; } }
    }
  }));
  if(failure!==undefined) throw failure;
  for(const found of issues) if(found.length) (scan.issues??=[]).push(...found);
  if(trusted.size) {trustedFiles=files.filter(file=>trusted.has(file.path));files=files.filter(file=>!trusted.has(file.path));}
  // Live Photos: a .mov beside a same-stem HEIC/HEIF/JPG is that still's companion when their ContentIdentifiers
  // agree. When either lacks one, the stem alone decides, but only for an Apple still. This needs the metadata
  // just read, so it runs here rather than in the inventory.
  const livePaired=new Set<string>(),liveRoot=new Map<string,InventoryFile>();
  if(!options.backup) {
    const {paired,dropped}=pairLivePhotos(files,scan.files,infos,{signal});
    for(const mov of paired) livePaired.add(mov);
    if(dropped.size) {
      const listed=new Map(files.map(f=>[f.path,f]));
      const rootedInDropped=(file:InventoryFile)=>{for(let cur:InventoryFile|undefined=file,hops=0;cur&&hops<16;cur=cur.companionOf?listed.get(cur.companionOf):undefined,hops++)if(dropped.has(cur.path))return true;return false;};
      files=files.filter(file=>{
        if(!rootedInDropped(file)) return true;
        file.included=false;file.companionOf=undefined;
        (scan.skipped??=[]).push({path:file.path,reason:'emptyPrimary'});
        problems.push({path:file.path,relative:path.relative(sourceRoot,file.path),reason:'emptyPrimary',group:'empty',collected:false});
        return false;
      });
    }
    // Companions of a live MOV (its .xmp, .LRV) follow the still: resolve each chain to its root once.
    const listed=new Map(files.map(f=>[f.path,f]));
    for(const file of files) {
      if(!file.companionOf) continue;
      let cur:InventoryFile|undefined=file,viaLive=false;
      for(let hops=0;cur?.companionOf&&hops<16;hops++) {if(livePaired.has(cur.path))viaLive=true;cur=listed.get(cur.companionOf);}
      if(viaLive&&cur) liveRoot.set(file.path,cur);
    }
    scan.companions=scan.files.filter(f=>!!f.companionOf).length;
  }
  const stems=new Map<string,InventoryFile[]>();
  for(const file of files) {const key=stem(file.path); stems.set(key,[...(stems.get(key)??[]),file]);}
  const primaryFor=new Map<string,InventoryFile>(), familyFor=new Map<string,string>();
  for(const [key,members] of stems) {
    const stills=members.filter(f=>f.kind!=='Other' && f.kind!=='Videos'), raws=stills.filter(f=>f.kind==='RAW');
    const primary=raws[0]??stills[0];
    const conflict=stills.some((a,index)=>stills.slice(index+1).some(b=>contradicts(infos.get(a.path)??{fields:{}},infos.get(b.path)??{fields:{}})));
    for(const file of members) {
      if(options.backup) {primaryFor.set(file.path,file);familyFor.set(file.path,file.path);}
      else if(file.kind==='Videos') {primaryFor.set(file.path,file);familyFor.set(file.path,'video:'+file.path);}
      else if(primary && !conflict && (file.kind!=='Other' || file.companionOf)) {primaryFor.set(file.path,primary);familyFor.set(file.path,'still:'+key);}
      else {primaryFor.set(file.path,file);familyFor.set(file.path,file.path);}
    }
  }
  const byPath=new Map(files.map(file=>[file.path,file]));
  for(const file of files) if(!options.backup && file.companionOf) {
    // Video companions, <name>.<ext>.xmp and NKSC_PARAM edits travel in their original's family.
    const primary=liveRoot.get(file.path)??byPath.get(file.companionOf);
    if(primary && (primary.kind==='Videos' || liveRoot.has(file.path) || stem(primary.path)!==stem(file.path))) {primaryFor.set(file.path,primary);familyFor.set(file.path,familyFor.get(primary.path)!);}
  }
  // GoPro splits a long recording into chapters GXzzxxxx/GHzzxxxx (zz the chapter, xxxx the
  // video). They form one family filed by the first chapter, so a recording that crosses
  // midnight or a month stays in one folder; their proxies follow their chapter.
  const chapterLead=new Map<string,InventoryFile>();
  if(!options.backup) {
    const recordings=new Map<string,InventoryFile[]>();
    for(const file of files) {
      const match=/^G([XH])(\d{2})(\d{4})\.mp4$/i.exec(path.basename(file.path));
      if(match&&file.kind==='Videos') {const key=pathKey(path.join(path.dirname(file.path),`G${match[1]!.toUpperCase()}${match[3]}`));recordings.set(key,[...(recordings.get(key)??[]),file]);}
    }
    for(const [key,chapters] of recordings) if(chapters.length>1) {
      const lead=chapters.reduce((first,chapter)=>path.basename(chapter.path).toUpperCase()<path.basename(first.path).toUpperCase()?chapter:first);
      for(const chapter of chapters) {chapterLead.set(chapter.path,lead);familyFor.set(chapter.path,'gopro:'+key);}
    }
    for(const file of files) if(file.companionOf&&chapterLead.has(file.companionOf)) {chapterLead.set(file.path,chapterLead.get(file.companionOf)!);familyFor.set(file.path,familyFor.get(file.companionOf)!);}
  }
  if(failures.size) {skipFamilies(files,file=>file.path,file=>familyFor.get(file.path));files=files.filter(file=>!failures.has(file.path));}
  // Duplicate detection, stage 1: files with the same name or EXIF identity are hashed now to confirm or
  // reject them. The hashes are reused below, so the plan never reads those files twice. Only recorded.
  const early=new Map<string,string>();let duplicates:PlanDuplicates|undefined;
  if(options.duplicates&&!options.backup&&!options.reorganize&&!options.misplacedOnly) {
    const edited=options.editedFolder??'editied';
    const items:DuplicateFile[]=files.filter(file=>file.kind!=='Other'&&(!file.companionOf||livePaired.has(file.path))&&sourceStats.has(file.path)&&file.size>0).map(file=>{
      const stat=sourceStats.get(file.path)!,info=infos.get(file.path),exif=info?.fingerprint;
      return {path:file.path,size:file.size,kind:file.kind,edited:info?.edited===true||file.relative.split(path.sep).slice(0,-1).includes(edited),...(exif&&Object.keys(exif).length?{exif}:{}),birth:Number(stat.birthtimeNs)/1e6,ctime:Number(stat.ctimeNs)/1e6};
    });
    try {
      await confirmCandidates(items,async item=>{
        // A hash remembered for this exact file (identity unchanged) is reused; planning reuses the result below.
        const stat=sourceStats.get(item.path)!,known=options.sourceDigest?.(item.path,statKey(stat));
        if(known) return known;
        const sha=await digest(item.path,signal);
        if(!sameStat(sourceStats.get(item.path)!,await fs.lstat(item.path,{bigint:true}))) throw new MessageError('error.sourceChanged',{path:item.path});
        return sha;
      },{signal,onProgress:progress=>onProgress?.(progress.completed,progress.file,{step:'candidates',total:progress.total,bytes:0,totalBytes:0})});
    } catch(error) { if(isAbort(error)) throw error; }
    for(const item of items) if(item.sha256) early.set(item.path,item.sha256);
    duplicates={files:items,groups:buildGroups(items)};
  }
  // Each ancestor describes only media within its own subtree. Stop at the
  // nearest evidence, including mixed-camera evidence, rather than guessing
  // from another camera elsewhere on the card.
  const contexts=new Map<string,Map<string,{camera:string;dates:Set<string>}>>();
  for(const file of files) {
    if(file.kind==='Other') continue;
    const info=infos.get(file.path),camera=info?.camera?.trim();
    if(!camera) continue;
    const date=info?.date?.match(/^(\d{4}-\d{2}-\d{2})(?:T|$)/)?.[1],calendar=date?new Date(date+'T00:00:00Z'):null;
    const validDate=!!calendar && Number.isFinite(calendar.getTime()) && calendar.toISOString().slice(0,10)===date;
    for(let ancestor=path.dirname(file.path);;ancestor=path.dirname(ancestor)) {
      const context=contexts.get(ancestor)??new Map<string,{camera:string;dates:Set<string>}>(),key=camera.toLowerCase();
      const known=context.get(key)??{camera,dates:new Set<string>()};
      if(validDate) known.dates.add(date!);
      context.set(key,known);contexts.set(ancestor,context);
      if(ancestor===sourceRoot) break;
    }
  }
  function unknownContext(file:InventoryFile):Metadata {
    for(let ancestor=path.dirname(file.path);;ancestor=path.dirname(ancestor)) {
      const context=contexts.get(ancestor);
      if(context) {
        if(context.size!==1) return {fields:{}};
        const known=context.values().next().value!,dates=[...known.dates].sort();
        // A shared month supports the normal monthly layout. For day-based
        // templates select the nearest capture day, with a stable tie break.
        const uniqueMonth=new Set(dates.map(date=>date.slice(0,7))).size===1;
        const mtime=mtimes.get(file.path)!.getTime();
        const closest=uniqueMonth?dates.sort((a,b)=>Math.abs(Date.parse(a+'T00:00:00Z')-mtime)-Math.abs(Date.parse(b+'T00:00:00Z')-mtime)||a.localeCompare(b))[0]:undefined;
        return {fields:{},camera:known.camera,date:closest};
      }
      if(ancestor===sourceRoot) return {fields:{}};
    }
  }
  // `camera`: the family's conflict folder relative to the root, when the layout chose it.
  const prepared:{entry:Omit<PlanEntry,'destination'>;relative:string;root:'photos'|'videos';camera?:string}[]=[];
  for(const file of files) {
    const primary=primaryFor.get(file.path)!, own=infos.get(file.path)??{fields:{}}, paired=infos.get(primary.path)??{fields:{}};
    const rawMembers=(stems.get(stem(file.path))??[]).filter(f=>f.kind==='RAW');
    const inherit=primary.path!==file.path && (file.companionOf || (file.kind!=='Other' && rawMembers.length===1));
    const live=liveRoot.has(file.path),info:Metadata={fields:{},origin:own.origin||(inherit?paired.origin:undefined),camera:(live?paired.camera?.trim():undefined) || own.camera?.trim() || (inherit?paired.camera:undefined),date:(live?paired.date:undefined) || own.date || (inherit?paired.date:undefined),edited:file.kind==='Other'?primary.kind!=='RAW'&&paired.edited:file.kind!=='RAW'&&own.edited};
    const rule=unknownRule(extension(file.path),custom,defaults);
    if(file.kind==='Other' && !file.companionOf && rule!==null && typeof rule==='object' && rule.action==='camera') Object.assign(info,unknownContext(file),{edited:false});
    let relative:string,place:ReturnType<typeof folder>|undefined;
    if(options.backup) relative=file.relative;
    else if(file.kind==='Other' && !file.companionOf && typeof rule==='string') relative=path.join(rule,path.basename(file.path));
    else {
      // Companions (sidecars, video metadata, NX Studio edits) are filed with their original.
      const original=file.companionOf?liveRoot.get(file.path)??byPath.get(file.companionOf)??file:file,nksc=nkscEdit(file.path)&&!!file.companionOf,captureOne=file.companionOf?captureOneEdit(file.path):undefined;
      const lead=chapterLead.get(file.path),route:Metadata=lead?{...info,date:infos.get(lead.path)?.date}:info;
      // An empty companion has no capture metadata of its own. Its primary also
      // supplies the fallback date, so differing mtimes cannot split the family.
      const dated=lead??(nksc||captureOne||live || file.size===0&&file.companionOf?primary:file);
      place=folder(route,mtimes.get(dated.path)!,original.kind==='Other'?undefined:{video:original.kind==='Videos',format:formatFolder(original.path)},options);
      // NX Studio reads NKSC_PARAM beside the original.
      relative=path.join(place.camera,place.sub,nksc?'NKSC_PARAM':captureOne??'',path.basename(file.path));
    }
    log('trace','plan','route',()=>({source:file.path,destination:relative,camera:place?.camera??info.camera,date:info.date,kind:file.kind,companionOf:file.companionOf,reason:options.backup?'drive backup keeps the source layout':file.kind==='Other'&&!file.companionOf&&typeof rule==='string'?`rule for .${extension(file.path)}: folder ${rule}`:place?info.camera&&info.date?'camera and capture date from metadata':info.date?'capture date from metadata, no camera name':info.camera?'camera from metadata, date from the file modification time':'no metadata: file modification time':'filed with its original',origin:info.origin}));
    prepared.push({relative,root:place?.root??'photos',camera:place?.camera,entry:{captureTimeMs:options.backup?undefined:captureTimestamp(info.date),id:file.path,source:file.path,size:file.size,kind:file.kind,sourceIdentity:statKey(sourceStats.get(file.path)!),skip:false,family:(info.edited?'edited:':'')+familyFor.get(file.path)!}});
  }
  const collecting=options.reorganize===true&&options.collectProblems===true&&!options.misplacedOnly;
  if(collecting) for(const item of problems) {
    const file=scanned.get(item.path)!;
    try {
      await contained(file.path,sourceRoot);
      const stat=await fs.lstat(file.path,{bigint:true});
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==BigInt(file.size)) throw new MessageError('error.sourceChanged',{path:file.path});
      sourceStats.set(file.path,stat);
      let primary=file;for(let original=primary.companionOf&&scanned.get(primary.companionOf);original&&original!==primary;original=primary.companionOf&&scanned.get(primary.companionOf))primary=original;
      prepared.push({relative:path.join(PROBLEM_FILES_FOLDER,PROBLEM_FILE_GROUPS[item.group],file.relative),root:'photos',entry:{id:file.path,source:file.path,size:file.size,kind:file.kind,sourceIdentity:statKey(stat),skip:false,family:'problem:'+primary.path}});
      item.collected=true;
    } catch(error) { skip(file.path,error); }
  }
  if(options.reorganize) {
    // Files already where the rules put them need nothing: they are neither read nor planned.
    const library=destinations[0]!,rootOf=(item:{root:'photos'|'videos'})=>item.root==='videos'?library.videos!:library;
    for(let index=prepared.length-1;index>=0;index--) if(pathKey(path.join(rootOf(prepared[index]!).root,prepared[index]!.relative))===pathKey(prepared[index]!.entry.source)) prepared.splice(index,1);
    if(options.misplacedOnly) {
      const listed=(part:Root,kind:'photos'|'videos'):TransferPlan=>({source:sourceRoot,root:part.root,rootIdentity:part.identity,entries:prepared.filter(item=>item.root===kind).map(({entry,relative})=>({...entry,destination:path.join(part.root,relative)}))});
      const moving=new Set(prepared.map(item=>item.entry.source));
      const placed=[...trustedFiles,...files].flatMap(file=>{const stat=sourceStats.get(file.path);return stat&&!failures.has(file.path)&&!moving.has(file.path)?[{relative:file.relative,size:file.size,mtimeNs:stat.mtimeNs,ino:stat.ino}]:[];});
      return {inventory:scan,plans:[{...listed(library,'photos'),...(library.videos?{videos:listed(library.videos,'videos')}:{})}],failures:[...failures].map(([path,error])=>({path,error})),problems:[],placed};
    }
    let position=0,hashed=0,hashedBytes=0;const movingBytes=prepared.reduce((sum,{entry})=>sum+entry.size,0);
    await Promise.all(Array.from({length:Math.min(prepared.length,PLAN_CONCURRENCY)},async()=>{
      while(position<prepared.length) {
        const {entry}=prepared[position++]!;checkAbort(signal);
        // Bytes count as they are read, so a long video moves the bar; the file count rises when it is done.
        const name=path.relative(sourceRoot,entry.source);
        try {
          hashes.set(entry.source,early.get(entry.source)??await digest(entry.source,signal,bytes=>{hashedBytes+=bytes;onProgress?.(hashed,name,{step:'reading',total:prepared.length,bytes:hashedBytes,totalBytes:movingBytes});}));
          if(!sameStat(sourceStats.get(entry.source)!,await fs.lstat(entry.source,{bigint:true}))) throw new MessageError('error.sourceChanged',{path:entry.source});
        } catch(error) { hashes.delete(entry.source); skip(entry.source,error); }
        onProgress?.(++hashed,name,{step:'reading',total:prepared.length,bytes:hashedBytes,totalBytes:movingBytes});
      }
    }));
    // A file that could not be read is not moved: it stays where it is, outside the reviewed batch.
    skipFamilies(prepared,item=>item.entry.source,item=>item.entry.family);
    for(let index=prepared.length-1;index>=0;index--) if(failures.has(prepared[index]!.entry.source)) prepared.splice(index,1);
    for(const {entry} of prepared) entry.digest=hashes.get(entry.source)!;
  }
  const resolved=new Map<string,string>();let readToCompare=0;
  const resolve:Resolve=async (entry,readSignal=signal)=>{
    if(entry.digest) return entry.digest;
    let value=resolved.get(entry.source)??early.get(entry.source)??options.sourceDigest?.(entry.source,statKey(sourceStats.get(entry.source)!));
    if(value!==undefined) resolved.set(entry.source,value);
    else {
      // A same-size file at the destination: the source is read to compare; the bytes count as they stream.
      await contained(entry.source,sourceRoot);value=await digest(entry.source,readSignal,bytes=>{readToCompare+=bytes;comparing(path.relative(sourceRoot,entry.source));});
      if(!sameStat(sourceStats.get(entry.source)!,await fs.lstat(entry.source,{bigint:true}))) throw new MessageError('error.sourceChanged',{path:entry.source});
      resolved.set(entry.source,value);
    }
    return value;
  };
  // One plan per backup folder: the files routed to it, checked against what it already holds.
  // Each file is compared once per destination; the count runs across all of them.
  // bytes: source data read to compare with same-size files already there (how much is not known ahead).
  const comparingTotal=prepared.length*destinations.length;
  let compared=0;
  let lastCompared=files.at(-1)?.relative??'';
  const comparing=(file:string)=>{if(file)lastCompared=file;onProgress?.(compared,file||lastCompared,{step:'comparing',total:comparingTotal,bytes:readToCompare,totalBytes:0});}
  async function rootPlan({root:destinationRoot,identity:rootIdentity}:Root,kind:'photos'|'videos'):Promise<TransferPlan> {
    const pending:PlanEntry[]=[],recovery:RecoveryIndex=new Map(),index=await destinationIndex(destinationRoot,rootIdentity);
    // Drive backups land in the folder this drive owns on each destination.
    const drive=options.drive?{folder:await driveFolder(destinationRoot,options.drive),identity:options.drive.identity,name:options.drive.name}:undefined;
    for(const {entry,relative,root,camera} of prepared){
      if(root!==kind) continue;
      checkAbort(signal);
      const destination=drive?path.join(destinationRoot,DRIVE_BACKUPS,drive.folder,relative):path.join(destinationRoot,relative);
      await contained(destination,destinationRoot);
      pending.push({...entry,destination,allocation:{destination,folder:camera===undefined?path.dirname(destination):path.join(destinationRoot,camera)}});
    }
    const mirror=drive&&options.drive!.mirror?await mirrorChanges(destinationRoot,drive.folder,pending,resolve,index,signal):undefined;
    // A same-size file at a destination is compared by content. Both sides are hashed here, several
    // files at once and outside the publication lock (so other jobs keep publishing meanwhile);
    // allocation below then reuses those digests unless a file changed in between.
    // This is where the comparison spends its time, so each file counts as compared here.
    await pool(pending,STREAM_CONCURRENCY,async entry=>{
      checkAbort(signal);
      try {
        if(mirror?.known.has(pathKey(entry.destination))) return;
        const existing=await fs.lstat(entry.destination,{bigint:true}).catch(()=>undefined);
        if(!existing?.isFile() || existing.size!==BigInt(entry.size)) return;
        // If one side fails, stop the other read and wait for it, so nothing reads a card file after this settles.
        const local=new AbortController(),stopLocal=()=>local.abort();let first:{error:unknown}|undefined;
        if(signal?.aborted) local.abort(); else signal?.addEventListener('abort',stopLocal,{once:true});
        const fail=(error:unknown)=>{first??={error};local.abort();throw error;};
        try {
          await Promise.allSettled([resolve(entry,local.signal).catch(fail),index.hinted.digestOf(entry.destination,local.signal).catch(fail)]);
          if(first) throw first.error;
        } finally { signal?.removeEventListener('abort',stopLocal); }
      }
      catch(error) { if(isAbort(error)) throw error; /* Allocation checks it again and reports it where it always has. */ }
      finally { if(!signal?.aborted) {compared++;comparing(path.relative(sourceRoot,entry.source));} }
    });
    const reservations=new Map<string,PlanEntry>(),entries:PlanEntry[]=[];
    for(const family of groups(pending)) {
      if(family.some(entry=>failures.has(entry.source))) continue;
      let allocation;
      // A family is planned whole or not at all; nothing has been written for it yet.
      try { allocation=await exclusive(()=>allocate(family,destinationRoot,reservations,recovery,resolve,index.hinted,signal,mirror?.known),familyFolders(family),signal); }
      catch(error) { for(const entry of family) skip(entry.source,error); continue; }
      for(const allocated of allocation){const digest=allocated.entry.digest??resolved.get(allocated.entry.source);entries.push({...allocated.entry,destination:allocated.destination,skip:allocated.skip,...(digest?{digest}:{})});}
      comparing(path.relative(sourceRoot,family[0]!.source));
    }
    await flushIndex(index);
    await rootUnchanged(destinationRoot,rootIdentity);
    const transfer:TransferPlan={source:sourceRoot,root:destinationRoot,rootIdentity,entries,...(drive?{drive}:{}),...(mirror?{removals:mirror.removals.map(({path,size,reason})=>({path,size,reason}))}:{})};
    if(mirror)mirrorReviews.set(transfer,mirror.removals);
    if(options.reorganize){
      await rootUnchanged(sourceRoot,sourceIdentity);
      reorganizationReviews.set(transfer,new Map(entries.map(entry=>[entry.id,{captureTimeMs:entry.captureTimeMs,stat:sourceStats.get(entry.source)!,source:entry.source,destination:entry.destination,digest:entry.digest}])));
      reorganizationScopes.set(transfer,{source:sourceRoot,sourceIdentity,root:destinationRoot,rootIdentity,libraries:allRoots.map(({root})=>root).filter(root=>root!==destinationRoot)});
    }
    return transfer;
  }
  let plans:TransferPlan[]=[];comparing('');
  // A family that fails on a later destination was already reserved on earlier ones, where it could
  // send another family to a conflict folder; those destinations are planned again without it.
  for(let known=-1;known!==failures.size;) {
    known=failures.size;plans=[];
    for(const destination of destinations){
      const transfer=await rootPlan(destination,'photos');
      if(destination.videos) transfer.videos=await rootPlan(destination.videos,'videos');
      plans.push(transfer);
    }
    if(destinations.length<2) break;
  }
  // A file that failed for one destination is left out of every destination, so each holds the same files.
  if(failures.size&&!options.reorganize)for(const transfer of plans.flatMap(item=>[item,...(item.videos?[item.videos]:[])]))transfer.entries=transfer.entries.filter(entry=>!failures.has(entry.source));
  for(const file of unreadable) if(!organizationOwned(file)&&!problems.some(item=>item.path===file)) problems.push({path:file,relative:path.relative(sourceRoot,file),reason:'unreadable',group:'unreadable',collected:false});
  // Problem files collected only if their move is in the plan; a family dropped by a failure stays in place.
  const planned=new Set(plans.flatMap(item=>[item,...(item.videos?[item.videos]:[])]).flatMap(item=>item.entries.map(entry=>entry.source)));
  for(const item of problems) item.collected=item.collected&&planned.has(item.path);
  log('detailed','plan','plan-done',()=>({source:sourceRoot,destinations:plans.length,files:plans.reduce((sum,item)=>sum+item.entries.length,0),toCopy:plans.reduce((sum,item)=>sum+item.entries.filter(entry=>!entry.skip).length,0),alreadyThere:plans.reduce((sum,item)=>sum+item.entries.filter(entry=>entry.skip).length,0),failedFiles:failures.size,problemFiles:problems.length,reorganize:!!options.reorganize}));
  return {inventory:scan,plans,failures:[...failures].map(([path,error])=>({path,error})),problems,...(duplicates?{duplicates}:{})};
}

// Destination checks, publication and staging-link cleanup share this lock:
// linking/unlinking a staging file changes the destination inode's ctime.
// Staging remains independent so jobs can read/copy concurrently.
// A hold names the paths it decides about (files, or folders for everything beneath them) and
// waits only for earlier holds that overlap them; a hold without paths (drive folders, mirror
// moves, organization) overlaps everything. Waiting only on earlier holds cannot deadlock.
// No overwrite ever depends on it: publication creates names with link or O_EXCL.
const holds=new Set<{keys?:string[];done:Promise<void>}>();
const overlaps=(a?:string[],b?:string[])=>!a||!b||a.some(left=>b.some(right=>left===right||left.startsWith(right+path.sep)||right.startsWith(left+path.sep)));
/** With `signal`, Stop ends the wait for the lock at once. */
async function exclusive<T>(work:()=>Promise<T>,paths?:string[],signal?:AbortSignal):Promise<T> {
  const keys=paths?.map(pathKey),earlier=[...holds].filter(hold=>overlaps(hold.keys,keys));
  let release!:()=>void;
  const hold={keys,done:new Promise<void>(resolve=>{release=resolve;})};holds.add(hold);
  try { await abortable(Promise.all(earlier.map(item=>item.done)),signal); return await work(); } finally { holds.delete(hold);release(); }
}
/** The paths a family's allocation can touch: its destinations, or, when one is already taken
 * and a conflict folder may be needed, the whole folder it is filed in. */
const familyFolders=(family:PlanEntry[])=>family.map(entry=>entry.allocation?.folder??path.dirname(entry.destination));
async function familyPaths(family:PlanEntry[]):Promise<string[]|undefined> {
  const taken=await Promise.all(family.map(entry=>fs.lstat(entry.destination).then(()=>true,()=>false)));
  return taken.includes(true)||new Set(family.map(entry=>pathKey(entry.destination))).size<family.length?undefined:family.map(entry=>entry.destination);
}
/** Thrown inside a hold on exact paths when allocation needs a conflict folder after all. */
const WIDEN=Symbol('widen');
interface Staged {streamDigest?:string;sourceStat?:import('node:fs').BigIntStats;verifiedStat?:import('node:fs').BigIntStats;file:string;dev:bigint;ino:bigint;birthtime:bigint;record?:OwnedPartial;recovery:RecoveryIndex;}
const claimedStages=new Set<string>();
interface StageTarget {entry:PlanEntry;transfer:TransferPlan;recovery:RecoveryIndex;onBytes:(bytes:number)=>void;}
interface OpenStage {target:StageTarget;staged:Staged;output:Awaited<ReturnType<typeof fs.open>>;initialSize:number;error?:unknown;}
/** Wait for `work`, or stop waiting (without stopping it) as soon as `signal` aborts. */
function abortable<T>(work:Promise<T>,signal?:AbortSignal):Promise<T> {
  checkAbort(signal);
  // Callers may pass any object with `aborted` (all checkAbort needs); only a real signal can be listened to.
  if(typeof signal?.addEventListener!=='function') return work;
  let stop!:()=>void;
  const stopped=new Promise<never>((_resolve,reject)=>{stop=()=>reject(new DOMException('Import stopped','AbortError'));signal.addEventListener('abort',stop,{once:true});});
  return Promise.race([work,stopped]).finally(()=>signal.removeEventListener('abort',stop));
}
const sourceChanged=(entry:PlanEntry)=>new MessageError('error.sourceChanged',{path:entry.source});
async function openStage(target:StageTarget,signal:AbortSignal|undefined):Promise<OpenStage> {
  const {entry,transfer,recovery}=target;
  checkAbort(signal); await rootUnchanged(transfer.root,transfer.rootIdentity); await contained(entry.source,transfer.source); await makeParent(entry.destination,transfer.root,transfer.rootIdentity);
  const candidate=await findPartial('stage',entry,transfer.root,recovery,signal);
  const recovered=candidate&&!claimedStages.has(candidate.file)?candidate:undefined;
  if(recovered)claimedStages.add(recovered.file);
  const file=recovered?.file??path.join(path.dirname(entry.destination),`photo-importer-${randomUUID()}.partial`);
  let output:Awaited<ReturnType<typeof fs.open>>;
  try{output=recovered?await openPartial(recovered,transfer.root):await fs.open(file,'wx',0o600);}catch(error){claimedStages.delete(file);throw error;}
  claimedStages.add(file);
  let outputStat;
  try{outputStat=await output.stat({bigint:true});}catch(error){await output.close().catch(()=>{});claimedStages.delete(file);if(!recovered){await fs.unlink(file).then(()=>logDeletion('staging',file,'staging file whose identity could not be read','created by this call with exclusive open (wx) a moment ago, nothing was written',{error}),()=>{});}throw error;}
  log('detailed','exec','stage-open',{source:entry.source,stage:file,resumedBytes:Number(outputStat.size),recovered:!!recovered,destination:entry.destination});
  return {target,output,initialSize:Number(outputStat.size),staged:{file,dev:outputStat.dev,ino:outputStat.ino,birthtime:outputStat.birthtimeNs,record:recovered,recovery}};
}
/** exFAT gives an empty file a temporary inode and assigns the real one (its first cluster)
 * when data is written, so the staging identity is re-read through the open descriptor,
 * which can only name this staging file. */
async function settle(output:Awaited<ReturnType<typeof fs.open>>):Promise<{stat:import('node:fs').BigIntStats;synced:boolean}> {
  const stat=await output.stat({bigint:true});
  // On larger exFAT volumes the real inode only arrives when the data is flushed.
  if(stat.size===0n||(stat.ino>=0n&&stat.ino<2n**63n)) return {stat,synced:false};
  await output.sync();return {stat:await output.stat({bigint:true}),synced:true};
}
const settled=async(output:Awaited<ReturnType<typeof fs.open>>)=>(await settle(output)).stat;
async function rebindStage(open:OpenStage):Promise<void> {
  const stat=await settled(open.output);
  open.staged.dev=stat.dev;open.staged.ino=stat.ino;open.staged.birthtime=stat.birthtimeNs;
}
/** A receipt names its file by inode. The temporary inode exFAT gives an empty file (see above)
 * is gone after the first write, and APFS may lower birthtime when an older date is applied, so
 * the receipt is rewritten for the file as it now is: a later run can then resume or release it. */
async function rebound(owned:OwnedPartial,output:Awaited<ReturnType<typeof fs.open>>,entry:PlanEntry,transfer:TransferPlan,recovery:RecoveryIndex):Promise<OwnedPartial> {
  const {stat:now,synced}=await settle(output);
  if(now.dev===owned.stat.dev&&now.ino===owned.stat.ino&&now.birthtimeNs===owned.stat.birthtimeNs) return owned;
  // Settling already synced when it read the real inode; sync only when it did not.
  if(!synced) await output.sync();
  const next=await recordPartial(owned.record.kind,owned.file,synced?now:await output.stat({bigint:true}),entry,transfer,recovery);
  await clearPartialRecord(owned,transfer.root,recovery);
  return next;
}
async function abandonStage(open:OpenStage,error:unknown):Promise<void> {
  open.error??=error;log('normal','exec','stage-abandoned',{source:open.target.entry.source,stage:open.staged.file,error});
  await rebindStage(open).catch(()=>{});
  await open.output.close().catch(()=>{});
  await cleanStage(open.staged,open.target.transfer.root);
}
/** Stream one source once into a staging file on every target. SHA-256 is taken
 * from the buffers that are written. A failing destination is dropped while the
 * others continue; a source problem fails them all. */
async function stageMany(targets:StageTarget[],signal:AbortSignal|undefined):Promise<(Staged|Error)[]> {
  const entry=targets[0]!.entry,opened:OpenStage[]=[],failures=new Map<StageTarget,unknown>(),began=performance.now();
  for(const target of targets) try { opened.push(await openStage(target,signal)); } catch(error) { if(isAbort(error)) {for(const open of opened)await abandonStage(open,error);throw error;} log('normal','exec','stage-open-failed',{source:entry.source,destination:target.entry.destination,error});failures.set(target,error); }
  let input:Awaited<ReturnType<typeof regularHandle>>|undefined;
  try {
    // One stream slot on the source's and each destination's device for the whole copy.
    if(opened.length) await streams.run([entry.source,...opened.map(open=>open.staged.file)],async chunk=>{
      input=await regularHandle(entry.source);
      const before=await input.stat({bigint:true});
      if(before.size!==BigInt(entry.size) || (entry.sourceIdentity!==undefined && statKey(before)!==entry.sourceIdentity)) throw sourceChanged(entry);
      for(const open of opened) if(!open.staged.record&&importRecoveryAvailable()) try { await open.output.sync(); open.staged.record=await recordPartial('stage',open.staged.file,await open.output.stat({bigint:true}),open.target.entry,open.target.transfer,open.target.recovery); } catch(error) { await abandonStage(open,error); }
      // SHA-256 of exactly the bytes written, computed on a worker thread (the chunk is copied first).
      const hash=hasher(), buffer=Buffer.allocUnsafe(chunk);let position=0,streamDigest:string;
      try {
        for(;;) {
          checkAbort(signal);
          if(opened.every(open=>open.error)) break;
          const {bytesRead}=await input.read(buffer,0,buffer.length,null);
          if(!bytesRead) break;
          await hash.update(buffer.subarray(0,bytesRead));
          for(const open of opened) {
            if(open.error) continue;
            try {
              // A resumed partial already holds a verified prefix of these bytes.
              let offset=Math.max(0,Math.min(bytesRead,open.initialSize-position));
              while(offset<bytesRead) { const {bytesWritten}=await open.output.write(buffer,offset,bytesRead-offset,position+offset); if(!bytesWritten) throw new Error('Unable to write staged file'); offset+=bytesWritten; }
              if(!position&&open.staged.record) open.staged.record=await rebound(open.staged.record,open.output,open.target.entry,open.target.transfer,open.target.recovery);
              open.target.onBytes(bytesRead);
            } catch(error) { await abandonStage(open,error); }
          }
          position+=bytesRead;
        }
        streamDigest=await hash.digest();
      } finally { hash.drop(); }
      const streamed=performance.now();
      const after=await input.stat({bigint:true}), pathname=await fs.lstat(entry.source,{bigint:true});
      if(!opened.every(open=>open.error) && (position!==entry.size || !sameStat(before,after) || !sameStat(after,pathname))) throw sourceChanged(entry);
      for(const open of opened) {
        if(open.error) continue;
        try {
          const {output,staged,target}=open;
          staged.streamDigest=streamDigest;staged.sourceStat=after;
          const stamping=performance.now();const exact=await applyFileTimestamps(output,before,target.entry.captureTimeMs);const stamped=performance.now();
          await rebindStage(open);
          // The one sync after the last write: data and timestamps reach the disk together.
          const syncing=performance.now();await output.sync();const synced=performance.now();
          if(staged.record)staged.record=await rebound(staged.record,output,target.entry,target.transfer,staged.recovery);
          await output.close();
          log('detailed','exec','staged',{source:entry.source,stage:staged.file,destination:target.entry.destination,bytes:position,sha256:streamDigest,streamMs:Math.round(streamed-began),timestampsMs:Math.round(stamped-stamping),captureDateApplied:exact,syncMs:Math.round(synced-syncing),receipt:!!staged.record});
        } catch(error) { await abandonStage(open,error); }
      }
    },signal);
  } catch(error) {
    for(const open of opened) if(!open.error) await abandonStage(open,error);
    if(isAbort(error)) throw error;
  } finally { await input?.close(); }
  return targets.map(target=>{
    if(failures.has(target)) return toError(failures.get(target));
    const open=opened.find(item=>item.target===target)!;
    return open.error?toError(open.error):open.staged;
  });
}
const toError=(error:unknown)=>error instanceof Error?error:new Error(String(error));
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
/** `sync:false`: the caller synchronizes the folder once after removing many stages. */
export async function cleanStage(staged:Staged,root:string,sync=true,note:(text:string,issue?:ExecutionIssue)=>void=text=>console.warn(text)):Promise<void> {
  claimedStages.delete(staged.file);
  try {
    await contained(staged.file,root);
    const current=await fs.lstat(staged.file,{bigint:true});
    if(!current.isFile()) return;
    const exact=current.dev===staged.dev&&current.ino===staged.ino&&sameBirth(staged.birthtime,current.birthtimeNs);
    // A temporary (negative) inode is replaced by the real one on exFAT; device and birth time still name the file.
    const temporary=staged.ino<0n&&current.dev===staged.dev&&sameBirth(staged.birthtime,current.birthtimeNs)&&current.nlink===1n;
    if(exact||temporary) {await fs.unlink(staged.file);logDeletion('staging',staged.file,'staging file of a copy (published, stopped or failed)',exact?`same device and inode as when this app created it (${staged.dev}:${staged.ino}) and birth time matches`:`temporary exFAT inode replaced by the real one: same device and birth time, single link`,{bytes:Number(current.size)});if(staged.record)await clearPartialRecord(staged.record,root,staged.recovery,sync);}
    else{
      const detail=`expected ${staged.dev}:${staged.ino}:${staged.birthtime} found ${current.dev}:${current.ino}:${current.birthtimeNs}`;
      log('normal','exec','clean-stage-left',{path:staged.file,reason:'identity differs',expected:{dev:String(staged.dev),ino:String(staged.ino),birthtime:String(staged.birthtime)},found:{dev:String(current.dev),ino:String(current.ino),birthtime:String(current.birthtimeNs)}});
      note(`Staging file left in place, identity differs: ${staged.file} ${detail}`,{code:'staging-left',severity:'warning',path:staged.file,detail});
    }
  } catch(error) { log('detailed','exec','clean-stage-skipped',{path:staged.file,error}); /* An unavailable/replaced destination is never followed or removed. */ }
}
/** A complete staged copy left by an interrupted run is released once the published file is
 * known to match: it must be this app's signed stage for the same source and destination, hold
 * every byte, hash to the published checksum and be unchanged until it is removed. */
async function releaseStaleStage(entry:PlanEntry,root:string,recovery:RecoveryIndex,signal?:AbortSignal):Promise<void> {
  const stale=await findPartial('stage',entry,root,recovery,signal);
  if(!stale||claimedStages.has(stale.file)) return;
  // Reserved while it is checked, so a copy starting meanwhile cannot resume into it.
  claimedStages.add(stale.file);
  try {
    if(stale.stat.size!==BigInt(entry.size)||await digest(stale.file,signal)!==entry.digest) return;
    if(!sameStat(stale.stat,await fs.lstat(stale.file,{bigint:true}))) return;
    await fs.unlink(stale.file);
    logDeletion('staging',stale.file,'complete staged copy left by an interrupted run, now released',`this app's signed receipt for the same source and destination; ${stale.stat.size} bytes equal the plan size; SHA-256 equals the published checksum ${entry.digest}; unchanged until removal`,{bytes:entry.size});
    await clearPartialRecord(stale,root,recovery);
  } finally { claimedStages.delete(stale.file); }
}
export interface ExecutionOptions {
  /** Use journaled exclusive copies for a filesystem known not to support hard links. */
  exclusiveCopy?:boolean;
  /** Re-read each copy and compare its SHA-256 before it is published (default true). When off,
   * the SHA-256 of the streamed source bytes and the source-unchanged checks still apply. */
  verify?:boolean;
  /** Called for every file whose copy is verified or confirmed already present, with the
   * plan-time source identity, so a later plan can recognise the unchanged source. */
  onVerified?:(source:string,sha256:string,identity:string)=>void;
  /** Remove the macOS "._" file beside each published file (see appledouble.ts); results are in ExecutionResult.appleDouble. */
  removeAppleDouble?:boolean;
}
/** The file just published: unlinking a hard-linked stage moves its ctime, so identity here is device, inode (birth time where no inode is reliable), size and modification time. */
const samePlaced=(a:import('node:fs').BigIntStats,b:import('node:fs').BigIntStats)=>a.dev===b.dev&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&(unreliableIno(a)&&unreliableIno(b)?a.birthtimeNs===b.birthtimeNs:a.ino===b.ino);
/** Folders no "._" cleanup touches: recovery storage, Problem files and Drive backups. */
export const appleDoubleCleaner=()=>new AppleDoubleCleaner([PROBLEM_FILES_FOLDER,DRIVE_BACKUPS,RECOVERY_FOLDER,LEGACY_RECOVERY_FOLDER]);
/** Returns the destination stat that verification was bound to, or undefined when
 * none can be named; only that stat may vouch for the published bytes later. */
async function publish(staged:Staged,destination:string,entry:PlanEntry,transfer:TransferPlan,options:ExecutionOptions,recovery:RecoveryIndex,signal?:AbortSignal):Promise<import('node:fs').BigIntStats|undefined> {
  await rootUnchanged(transfer.root,transfer.rootIdentity); await makeParent(destination,transfer.root,transfer.rootIdentity); await contained(staged.file,transfer.root);
  const verified=staged.verifiedStat;
  if(!verified || !sameStat(verified,await fs.lstat(staged.file,{bigint:true}))) throw new Error(`Staged file changed: ${entry.source}`);
  const publicationEntry={...entry,destination};
  let owned=await findPartial('publication',publicationEntry,transfer.root,recovery,signal);
  const publishing=performance.now();let copy=!!owned||(options.exclusiveCopy??false),bound:import('node:fs').BigIntStats|undefined,fallback:string|undefined;
  const method=()=>!copy?'link':(owned||options.exclusiveCopy)&&!fallback?'direct':'copy';
  if(!copy) {
    try {
      await fs.link(staged.file,destination);
      // The link names the inode whose contents were already hashed after sync;
      // rereading it through another name cannot detect anything new.
      const linked=await fs.lstat(destination,{bigint:true});
      // Some network/FUSE filesystems report another identity for a new link;
      // only then fall back to reading the published bytes.
      if(linked.dev===verified.dev&&linked.ino===verified.ino&&linked.size===verified.size&&linked.mtimeNs===verified.mtimeNs) bound=verified;
      else {
        if(await digest(destination,signal)!==entry.digest)throw new Error(`Destination verification failed: ${destination}`);
        const after=await fs.lstat(destination,{bigint:true});if(sameStat(linked,after))bound=after;
      }
    }
    catch(error) {
      if(!['EXDEV','ENOSYS','EPERM','ENOTSUP','EOPNOTSUPP'].includes(code(error)??'')) throw error;
      copy=true;fallback=code(error);
    }
  }
  if(copy) {
    // Exclusive descriptors bind recovery permission to the created inode.
    // Neither COPYFILE_EXCL nor a path/hash intent alone proves ownership.
    // The receipt naming the destination is durable before the name exists, so a crash right after
    // creating it leaves an empty file the next import owns; it is then rebound to the file's identity.
    let creating:import('./import-recovery').Receipt|undefined=owned?.record.fileIdentity==='creating'?owned:undefined;
    if(!owned||owned.absent) { creating??=await recordCreation(destination,publicationEntry,transfer,recovery); owned=undefined; }
    let output;
    try { output=owned?await openPartial(owned,transfer.root):await fs.open(destination,'wx',0o600); }
    catch(error) { if(creating&&!owned) await clearPartialRecord(creating,transfer.root,recovery).catch(()=>{}); throw error; }
    try {
      if(!owned||creating){
        await output.sync();owned=await recordPartial('publication',destination,await output.stat({bigint:true}),publicationEntry,transfer,recovery);
        // The creation receipt only covers receipt -> wx -> this receipt; its name-only binding ends here.
        if(creating) await clearPartialRecord(creating,transfer.root,recovery);
      }
      await streams.run([staged.file,destination],async chunk=>{
      const input=await regularHandle(staged.file),buffer=Buffer.allocUnsafe(chunk);let position=Number((await output.stat({bigint:true})).size);
      try {for(;;){checkAbort(signal);const {bytesRead}=await input.read(buffer,0,buffer.length,position);if(!bytesRead)break;let offset=0;
        while(offset<bytesRead){const {bytesWritten}=await output.write(buffer,offset,bytesRead-offset,position+offset);if(!bytesWritten)throw new Error('Unable to publish exclusive copy');offset+=bytesWritten;}
        if(!position&&owned)owned=await rebound(owned,output,publicationEntry,transfer,recovery);position+=bytesRead;
      }const stat=await input.stat({bigint:true});await applyFileTimestamps(output,stat,entry.captureTimeMs);await output.sync();
      if(owned)owned=await rebound(owned,output,publicationEntry,transfer,recovery);}finally{await input.close();}
      },signal);
      const stat=await output.stat({bigint:true});if(!sameStat(stat,await fs.lstat(destination,{bigint:true})))throw new Error('Destination changed while publishing');
    }finally{await output.close();}
  }
  await rootUnchanged(transfer.root,transfer.rootIdentity); await contained(destination,transfer.root);
  // A copy was already synced after its last write and timestamps.
  if(!copy) await syncFile(destination);
  if(copy&&options.verify===false) bound=undefined;
  else if(copy) {
    const before=await fs.lstat(destination,{bigint:true});
    if(await digest(destination)!==entry.digest) throw new Error(`Destination verification failed: ${destination}`);
    const after=await fs.lstat(destination,{bigint:true});bound=sameStat(before,after)?after:undefined;
  }
  await syncParents(destination,transfer.root);
  // One step: every publication receipt for this destination goes, so a crash cannot leave one beside the finished file.
  await releaseCreations(publicationEntry,transfer.root,recovery);
  if(owned)await clearPartialRecord(owned,transfer.root,recovery).catch(error=>{if(code(error)!=='ENOENT')throw error;});
  log('detailed','exec','published',{source:entry.source,destination,bytes:entry.size,sha256:entry.digest,method:method(),...(fallback?{linkRefused:fallback}:{}),bound:!!bound,verified:options.verify!==false,ms:Math.round(performance.now()-publishing)});
  return bound;
}
export interface ExecutionResult {copied:number;skipped:number;removed?:number;errors:string[];/** Cleanup leftovers and other notes that left the data safe; never failures. */warnings?:ExecutionIssue[];appleDouble?:AppleDoubleReport;}
export async function execute(transfer:TransferPlan,signal?:AbortSignal,onProgress?:(progress:Progress)=>void,options:ExecutionOptions={}):Promise<ExecutionResult> {
  const [result]=await executeMany([transfer],signal,onProgress&&((_index,value)=>onProgress(value)),options);
  if(result instanceof Error) throw result;
  return result!;
}
interface Run {
  transfer:TransferPlan;result:ExecutionResult;recovery:RecoveryIndex;index?:DestinationIndex;error?:Error;appleDouble?:AppleDoubleCleaner;
  batches:{family:PlanEntry[];staged:Map<string,Staged>;failed:boolean;errors:string[]}[];pending:Set<string>;
  bytes:number;completed:number;failed:number;counted:Set<string>;phase:NonNullable<Progress['phase']>;started:number;totalBytes:number;
  /** Bytes of the files staged for this run, of those published so far, and whether any was published by copying instead of linking. */
  stagedBytes:number;verifiedBytes:number;publishCopy:boolean;
}
/** Copy the same reviewed entries to several destinations. Each source file is
 * read once for all of them; checks, publication and errors stay per destination.
 * A destination that cannot start returns an Error in its slot; Stop throws. */
const skippedOf=(transfer:TransferPlan)=>{const skipped=transfer.entries.filter(e=>e.skip).length;return skipped?{skipped}:{};};
export async function executeMany(transfers:TransferPlan[],signal?:AbortSignal,onProgress?:(index:number,progress:Progress)=>void,options:ExecutionOptions={},onSettled?:(index:number)=>void):Promise<(ExecutionResult|Error)[]> {
  const runs:Run[]=transfers.map(transfer=>({transfer,result:{copied:0,skipped:0,errors:[]},recovery:new Map(),batches:groups(transfer.entries).map(family=>({family,staged:new Map<string,Staged>(),failed:false,errors:[] as string[]})),pending:new Set<string>(),bytes:0,completed:0,failed:0,counted:new Set<string>(),phase:'copying',started:performance.now(),totalBytes:transfer.entries.filter(e=>!e.skip).reduce((sum,e)=>sum+e.size,0),stagedBytes:0,verifiedBytes:0,publishCopy:false,
    // A drive backup mirrors a drive as it is: nothing in it is removed.
    ...(options.removeAppleDouble&&!transfer.drive?{appleDouble:appleDoubleCleaner()}:{})}));
  for(const run of runs)if(run.appleDouble)run.result.appleDouble=run.appleDouble.report;
  const progress=(position:number,file:string)=>{const run=runs[position]!;onProgress?.(position,{phase:run.phase,completed:run.completed,failed:run.failed,total:run.transfer.entries.length,bytes:run.bytes,totalBytes:Math.max(run.totalBytes,run.bytes),...skippedOf(run.transfer),speed:run.phase==='copying'?run.bytes/Math.max((performance.now()-run.started)/1000,0.001):0,file,
   // What the time-left estimate counts: copying moves bytes; verifying publishes the staged files (bytes of files already in the backup add files only).
   work:run.phase==='copying'?{files:run.completed,bytes:run.bytes,totalFiles:run.transfer.entries.length,totalBytes:Math.max(run.totalBytes,run.bytes)}:{files:run.completed,bytes:run.verifiedBytes,totalFiles:run.transfer.entries.length,totalBytes:run.stagedBytes,...(run.publishCopy?{publishCopy:true}:{})}});};
  // A failed group stops counting as done and is reported as failed, once.
  const fail=(run:Run,batch:Run['batches'][number],error:unknown)=>{if(!batch.failed){run.failed+=batch.family.length;for(const entry of batch.family)if(run.counted.delete(entry.id))run.completed--;}batch.failed=true;batch.errors.push(`${path.basename(batch.family[0]!.source)}: ${message(error)}`);};
  // Errors of families handled side by side, in file order.
  const report=(run:Run)=>{for(const batch of run.batches){run.result.errors.push(...batch.errors);batch.errors=[];}};
  const settled=new Set<number>();
  try {
    // Setup per destination: mirror moves, then the duplicate preflight. A
    // reviewed skip is only a hint: a removed/replaced duplicate is staged again.
    for(const [position,run] of runs.entries()) try {
      const {transfer}=run;
      // Before the first copy: which planned files the destination already holds, verified. Counts files; no bytes move.
      let checked=0;
      const existing=(file:string)=>onProgress?.(position,{phase:'planning',step:'existing',completed:checked,total:transfer.entries.length,bytes:0,totalBytes:0,speed:0,file});
      existing('');
      checkAbort(signal); await rootUnchanged(transfer.root,transfer.rootIdentity);
      const removals=mirrorReviews.get(transfer);
      if(transfer.removals&&(!removals||!transfer.drive))throw new Error('Mirror changes require the reviewed backup plan.');
      run.index=await destinationIndex(transfer.root,transfer.rootIdentity);
      if(transfer.drive){const drive=transfer.drive;await exclusive(()=>claimDriveFolder(transfer.root,drive,transfer.rootIdentity));}
      if(removals){run.result.removed=removals.length?await exclusive(()=>moveMirrorRemovals(transfer.root,transfer.drive!,removals,signal,transfer.rootIdentity,(completed,bytes,file)=>onProgress?.(position,{phase:'copying',step:'removing',completed,total:removals.length,bytes,totalBytes:removals.reduce((sum,item)=>sum+item.size,0),speed:0,file,renames:true}))):0;for(const removal of removals)run.index.forget(removal.path);}
      for(const batch of run.batches) try {
        for(const entry of batch.family){
          checkAbort(signal);await contained(entry.source,transfer.source);await contained(entry.destination,transfer.root);
          // A hint: the verification phase reads the destination again before trusting it.
          const present=!!entry.digest&&await exclusive(()=>existingMatches(entry.destination,entry.size,async()=>entry.digest!,transfer.root,run.index!.hinted,signal),[entry.destination],signal)===true;
          log('detailed','exec','preflight',{source:entry.source,destination:entry.destination,decision:present?'skip':'copy',reason:present?'destination already holds this checksum':entry.digest?'no matching file at the destination':'no checksum planned'});
          if(!present)run.pending.add(entry.id);
          checked++;existing(path.basename(entry.source));
        }
      } catch(error) { if(isAbort(error))throw error; fail(run,batch,error); }
      checked=transfer.entries.length;existing('');
      report(run);
      // Files already verified at their destination need no copy and count as done.
      for(const batch of run.batches)if(!batch.failed)for(const entry of batch.family)if(!run.pending.has(entry.id)){run.counted.add(entry.id);run.completed++;}
    } catch(error) { if(isAbort(error))throw error; run.error=toError(error); }
    // One read per source file, written to every destination still waiting for it.
    const order:string[]=[],seen=new Set<string>(),owners=runs.map(()=>new Map<string,{batch:Run['batches'][number];entry:PlanEntry}>());
    runs.forEach((run,position)=>{for(const batch of run.batches)for(const entry of batch.family){owners[position]!.set(entry.id,{batch,entry});if(!seen.has(entry.id)){seen.add(entry.id);order.push(entry.id);}}});
    // Several files stream at once (one each on a spinning disk), hiding each file's open,
    // receipt and sync latency behind the others' transfers.
    await pool(order,STREAM_CONCURRENCY,async id=>{
      checkAbort(signal);
      const targets:{run:Run;position:number;batch:Run['batches'][number];entry:PlanEntry}[]=[];
      runs.forEach((run,position)=>{if(run.error||!run.pending.has(id))return;const {batch,entry}=owners[position]!.get(id)!;if(!batch.failed)targets.push({run,position,batch,entry});});
      if(!targets.length) return;
      const results=await stageMany(targets.map(({run,position,entry})=>({entry,transfer:run.transfer,recovery:run.recovery,onBytes:count=>{run.bytes+=count;progress(position,path.basename(entry.source));}})),signal);
      results.forEach((value,slot)=>{const {run,position,batch,entry}=targets[slot]!;if(value instanceof Error)fail(run,batch,value);else{batch.staged.set(entry.id,value);if(!batch.failed){run.counted.add(entry.id);run.completed++;}run.stagedBytes+=entry.size;progress(position,path.basename(entry.source));}});
    });
    for(const run of runs)report(run);
    // Destinations are verified one after another; within one, families run side by side and
    // their errors are reported in file order.
    for(const [position,run] of runs.entries()) {
      if(run.error){settled.add(position);onSettled?.(position);continue;}
      const {transfer,recovery,index,result}=run;
      run.phase='verifying';run.completed=0;run.counted.clear();progress(position,'');
      // Check all members of a family before publishing it. Publication then checks
      // inode/stat identity, avoiding another full staging hash.
      const check=async({family,staged}:Run['batches'][number])=>{
        const verifiedSources=new Map<string,import('node:fs').BigIntStats>(),effective=new Map<string,PlanEntry>();
        for(const entry of family){
          await contained(entry.source,transfer.source);
          const temporary=staged.get(entry.id);
          if(temporary){
            if(entry.digest!==undefined&&temporary.streamDigest!==entry.digest)throw sourceChanged(entry);
            const streamed=temporary.streamDigest!;
            const before=await fs.lstat(temporary.file,{bigint:true});
            const verifying=performance.now();
            if(options.verify!==false&&await digest(temporary.file,signal)!==streamed)throw new Error(`Staged file verification failed: ${entry.source}`);
            log('detailed','exec','verified',{source:entry.source,stage:temporary.file,bytes:entry.size,sha256:streamed,reread:options.verify!==false,hashMs:Math.round(performance.now()-verifying)});
            const after=await fs.lstat(temporary.file,{bigint:true});if(!sameStat(before,after))throw new Error(`Staged file changed: ${entry.source}`);
            temporary.verifiedStat=after;effective.set(entry.id,{...entry,digest:streamed});
          } else {
            // Preflight matched a planned checksum. It still describes the source
            // while the plan-time stat identity holds; otherwise hash it again.
            if(entry.digest===undefined)throw new Error(`Destination changed after copy preparation; retry: ${entry.destination}`);
            effective.set(entry.id,entry);
          }
          const before=await fs.lstat(entry.source,{bigint:true});
          if(temporary?!sameStat(temporary.sourceStat!,before):!(entry.sourceIdentity!==undefined&&statKey(before)===entry.sourceIdentity)&&await digest(entry.source,signal)!==entry.digest)throw sourceChanged(entry);
          const after=await fs.lstat(entry.source,{bigint:true});if(!sameStat(before,after))throw sourceChanged(entry);
          verifiedSources.set(entry.id,after);
        }
        return {verifiedSources,members:family.map(entry=>effective.get(entry.id)!)};
      };
      // Several families are checked and published at once; each holds the lock only for the
      // paths it decides about, so families filed apart publish side by side.
      await pool(run.batches,STREAM_CONCURRENCY,async batch=>{
        const {family,staged,failed}=batch;
        checkAbort(signal);
        const published:{file:string;sha256:string;stat:import('node:fs').BigIntStats}[]=[],placed:{file:string;stat:import('node:fs').BigIntStats}[]=[];
        if(!failed)try{
          const {verifiedSources,members}=await check(batch),known:Resolve=async entry=>entry.digest!;
          // A destination taken meanwhile sends the family to a conflict folder: then it gives
          // up its hold on the exact paths and decides again holding the whole folder.
          const exact=await familyPaths(members);
          const decide=(keys:string[])=>exclusive(async()=>{
            checkAbort(signal);await rootUnchanged(transfer.root,transfer.rootIdentity);
            const outside=(items:{destination:string}[])=>keys===exact&&items.some(item=>!keys.includes(item.destination));
            // Allocation and the final duplicate check decide together under this lock: a file
            // the first read is not read again by the second while its stat is unchanged.
            const checks=index!.section();
            let allocated=await allocate(members,transfer.root,new Map(),recovery,known,checks,signal);
            if(outside(allocated))throw WIDEN;
            for(let i=0;i<allocated.length;){
              checkAbort(signal);const item=allocated[i]!,entry=item.entry;
              await contained(entry.source,transfer.source);await rootUnchanged(transfer.root,transfer.rootIdentity);
              if(!sameStat(verifiedSources.get(entry.id)!,await fs.lstat(entry.source,{bigint:true})))throw sourceChanged(entry);
              if(await existingMatches(item.destination,entry.size,async()=>entry.digest!,transfer.root,checks,signal)===true){log('detailed','exec','already-present',{source:entry.source,destination:item.destination,sha256:entry.digest});await syncFile(item.destination);await syncParents(item.destination,transfer.root);if(entry.sourceIdentity)options.onVerified?.(entry.source,entry.digest!,entry.sourceIdentity);const recovered=await findPartial('publication',{...entry,destination:item.destination},transfer.root,recovery,signal);if(recovered)await clearPartialRecord(recovered,transfer.root,recovery);await releaseCreations({...entry,destination:item.destination},transfer.root,recovery);await releaseStaleStage({...entry,destination:item.destination},transfer.root,recovery,signal);result.skipped++;i++;continue;}
              const temporary=staged.get(entry.id);
              // Do not silently restart copying inside validation if an external
              // writer removes a duplicate after preflight; a fresh retry is safe.
              if(!temporary)throw new Error(`Destination changed after copy preparation; retry: ${item.destination}`);
              if(run.appleDouble)await run.appleDouble.noteExisting(item.destination);
              try{const bound=await publish(temporary,item.destination,entry,transfer,options,recovery,signal);if(bound!==temporary.verifiedStat)run.publishCopy=true;if(bound)published.push({file:item.destination,sha256:entry.digest!,stat:bound});if(run.appleDouble){const now=await fs.lstat(item.destination,{bigint:true}).catch(()=>undefined);if(now?.isFile())placed.push({file:item.destination,stat:now});}if(entry.sourceIdentity&&options.verify!==false)options.onVerified?.(entry.source,entry.digest!,entry.sourceIdentity);result.copied++;i++;}
              catch(error){if(code(error)==='EEXIST'&&published.length===0&&i===0){allocated=await allocate(members,transfer.root,new Map(),recovery,known,checks,signal);if(outside(allocated))throw WIDEN;continue;}throw error;}
            }
          },keys,signal);
          try { await decide(exact??familyFolders(members)); }
          catch(error) { if(error!==WIDEN) throw error; await decide(familyFolders(members)); }
          run.completed+=family.length;
        }catch(error){if(isAbort(error))throw error;run.failed+=family.length;batch.errors.push(`${path.basename(family[0]!.source)}: ${message(error)}`);log('normal','exec','file-failed',{source:family[0]!.source,files:family.length,error});}
        await exclusive(async()=>{
          for(const temporary of staged.values())await cleanStage(temporary,transfer.root,true,(line,issue)=>{if(issue)(run.result.warnings??=[]).push(issue);else batch.errors.push(line);});
          // Unlinking a hard-linked stage moves the published file's ctime. Index it
          // afterwards, and only while it is still the inode and bytes just published.
          for(const item of published){const now=await fs.lstat(item.file,{bigint:true}).catch(()=>undefined);if(now?.isFile()&&now.dev===item.stat.dev&&now.ino===item.stat.ino&&now.size===item.stat.size&&now.mtimeNs===item.stat.mtimeNs)index!.remember(item.file,item.sha256,now);}
          // After the last write, timestamps, sync and the staged copy's removal: the "._" beside each file just published, while it is still that file.
          if(run.appleDouble)for(const item of placed)await run.appleDouble.besideFile(item.file,transfer.root,now=>samePlaced(now,item.stat));
        },[...[...staged.values()].map(temporary=>temporary.file),...published.map(item=>item.file),...placed.map(item=>item.file)]);
        if(!batch.failed)run.verifiedBytes+=family.reduce((sum,entry)=>sum+(staged.has(entry.id)?entry.size:0),0);
        staged.clear();
        progress(position,path.basename(family[family.length-1]!.source));
      });
      report(run);
      await flushIndex(index!);
      settled.add(position);onSettled?.(position);
    }
  } finally {
    // After Stop every file staged so far is removed: many at once, each folder synchronized
    // once rather than once per file, so stopping during verification returns promptly.
    for(const run of runs) {
      const stages=run.batches.flatMap(batch=>[...batch.staged.values()]);
      await exclusive(async()=>{
        await pool(stages,16,temporary=>cleanStage(temporary,run.transfer.root,false,(line,issue)=>{if(issue)(run.result.warnings??=[]).push(issue);else run.result.errors.push(line);}));
        for(const folder of new Set(stages.map(temporary=>path.dirname(temporary.file))))await syncDirectory(folder).catch(()=>{});
      // Keyed by folder: unlinking a stage still linked to its published file changes that file.
      },[...new Set(stages.map(temporary=>path.dirname(temporary.file)))]);
    }
    for(const run of runs) if(run.index) await flushIndex(run.index);
    runs.forEach((_run,position)=>{if(!settled.has(position))onSettled?.(position);});
  }
  checkAbort(signal);
  return runs.map(run=>run.error??run.result);
}
export async function executeReorganization(transfer:TransferPlan,signal?:AbortSignal,onProgress?:(progress:Progress)=>void,options:{strategy?:import('./recovery').OrganizationStrategy;keepSourceFolders?:boolean;/** After a clean run, remove the confirmed duplicates kept in recovery storage. */releaseDuplicates?:boolean;/** Remove macOS "._" files beside moved files and in the library (see appledouble.ts). */removeAppleDouble?:boolean}={}):Promise<import('./recovery').ReorganizationResult> {
  const review=reorganizationReviews.get(transfer),scope=reorganizationScopes.get(transfer);
  if(!review || !scope || scope.source!==transfer.source || scope.root!==transfer.root || scope.rootIdentity!==transfer.rootIdentity || (transfer.source!==transfer.root && !beneath(transfer.root,transfer.source)) || review.size!==transfer.entries.length || transfer.entries.some(entry=>{
    const original=review.get(entry.id);
    return !original || original.source!==entry.source || original.destination!==entry.destination || original.digest!==entry.digest || original.captureTimeMs!==entry.captureTimeMs;
  })) throw new Error('Reorganization requires the unchanged in-memory library plan shown during review.');
  if(transfer.entries.some(entry=>!entry.digest)) throw new Error('Reorganization requires checksums for every reviewed file.');
  const index=await destinationIndex(transfer.root,transfer.rootIdentity);
  const result=await exclusive(async()=>{
    checkAbort(signal);await rootUnchanged(transfer.root,transfer.rootIdentity);await rootUnchanged(transfer.source,scope.sourceIdentity);
    const entries:OrganizationEntry[]=[],reservations=new Map<string,PlanEntry>(),recovery:RecoveryIndex=new Map();
    for(const family of groups(transfer.entries)) for(const allocated of await allocate(family,transfer.root,reservations,recovery,async entry=>entry.digest!,index,signal)) {
      const entry=allocated.entry,original=review.get(entry.id)!;
      entries.push({captureTimeMs:entry.captureTimeMs,source:entry.source,destination:allocated.destination,digest:entry.digest!,size:entry.size,stat:original.stat,
        move:allocated.destination===original.destination && pathKey(entry.source)!==pathKey(allocated.destination)});
    }
    // Organization renames files; drop the cached checksums for this library.
    index.clear();
    return beginOrganization(transfer,entries,signal,onProgress,options.strategy,options.keepSourceFolders,scope.libraries,options.releaseDuplicates,options.removeAppleDouble?appleDoubleCleaner():undefined);
  });
  await flushIndex(index);
  return result;
}
