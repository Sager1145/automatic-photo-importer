import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { Inventory, InventoryFile, SkippedFile, UnknownDefault, UnknownFileRule } from '../shared';
import { finderAliasFile, knownSystemFile } from './known-files';
import { mediaKindForPath } from '../media-formats';
import { checkAbort, contained, directory, pathKey, validateRelative } from './paths';

/** Entries of a folder looked at (lstat) at once. */
const LISTING_STATS=8;
export const sidecars=new Set('xmp aae thm xml moi wav bwf m4a mp3 aac srt dop cos pp3 comask on1 acr dr4 vrd rmd sidecar bim'.split(' '));
const videoOnly=new Set('xml moi srt thm wav bwf m4a mp3 aac bim'.split(' '));
/** Low-resolution proxies: real video, kept with their original or imported alone. */
const proxies=new Set(['lrf','lrv']);
/** Stems a proxy's original may have: its own (DJI LRF), GoPro GL… → GX…/GH… (same chapter and
 * number), Insta360 LRV_<date>_<time>_<lens>1_<seq> → VID_<date>_<time>_<lens>0_<seq>. */
function proxyOriginals(file:string):string[] {
  const folder=path.dirname(file),name=path.basename(file,path.extname(file)),names=[name];
  const gopro=/^GL(\d{6})$/i.exec(name);if(gopro)names.push('GX'+gopro[1],'GH'+gopro[1]);
  const insta=/^LRV(_\d{8}_\d{6}_\d)1(_\d+)$/i.exec(name);if(insta)names.push(`VID${insta[1]}0${insta[2]}`);
  return names.map(item=>pathKey(path.join(folder,item)));
}
const audio=new Set('wav bwf m4a mp3 aac'.split(' '));
const artifacts=new Set(['.photo-importer-recovery','photo-importer-drive.json','.photo-importer-drive.json','photo-importer-index.json','photo-importer-duplicates.json','photo importer recovery','.ds_store','.fseventsd','.documentrevisions-v100','.spotlight-v100','.trashes','.temporaryitems','$recycle.bin','system volume information','thumbs.db','desktop.ini']);
const importArtifact=/^(?:\.import|photo-importer)-(?:(?:stage|intent)-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.partial)$/i;
const duplicatesTemporary=/^photo-importer-duplicates-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/i;
const indexTemporary=/^photo-importer-index-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/i;
/** Filesystem service files and this app's own recovery artifacts. */
export function ignoredName(name:string):boolean {return artifacts.has(name.toLowerCase()) || importArtifact.test(name) || indexTemporary.test(name) || duplicatesTemporary.test(name) || name.startsWith('._') || name.startsWith('.photo-importer-index');}
export function extension(file:string):string {return path.extname(file).slice(1).toLowerCase();}
export function stem(file:string):string {return pathKey(path.join(path.dirname(file),path.basename(file,path.extname(file))));}
/** NX Studio keeps edits in NKSC_PARAM/<original name>.nksc beside the original. */
export function nkscEdit(file:string):boolean {return extension(file)==='nksc' && path.basename(path.dirname(file)).toLowerCase()==='nksc_param';}
/** Capture One keeps <name>.<ext>.cos|comask in <folder>/CaptureOne/Settings<n>/ for the original in <folder>. */
const captureOneSettings=/^(.*)[\\/](CaptureOne[\\/]Settings\d+)[\\/]([^\\/]+)\.(?:cos|comask)$/i;
/** The CaptureOne/Settings<n> folder (as written on the card) of a Capture One settings file. */
export function captureOneEdit(file:string):string|undefined {const match=captureOneSettings.exec(file);return match?path.join(...match[2]!.split(/[\\/]/)):undefined;}
export interface RuleDefaults {fallback:UnknownDefault;builtins:boolean;}
/** The rule for a file no format or companion claims: an explicit rule wins, then
 * unpaired camera audio goes to its camera folder, then the user's default. */
export function unknownRule(ext:string,custom:Record<string,UnknownFileRule>,defaults:RuleDefaults):UnknownFileRule|undefined {
  if(ext in custom) return custom[ext];
  if(defaults.builtins && audio.has(ext)) return {action:'camera'};
  if(defaults.fallback==='other') return /^[\p{L}\p{N}_-]+$/u.test(ext)?`Other files/${ext}`:'Other files';
  return undefined;
}
export function rules(input:Record<string,UnknownFileRule>={}):Record<string,UnknownFileRule> {
  const result:Record<string,UnknownFileRule>=Object.create(null);
  for(const [ext,folder] of Object.entries(input)) {
    if(typeof folder==='string') validateRelative(folder);
    else if(folder!==null && (!folder || typeof folder!=='object' || Array.isArray(folder) || folder.action!=='camera' || Object.keys(folder).length!==1)) throw new Error('Invalid unknown file rule.');
    result[ext.trim().replace(/^\.+/,'').toLowerCase()]=folder;
  }
  return result;
}
export async function inventory(source:string,options:{backup?:boolean;unknownRules?:Record<string,UnknownFileRule>;unknownDefault?:UnknownDefault;builtinRules?:boolean;folders?:string[];onProgress?:(files:number,bytes:number,topLevel?:{done:number;total:number},/** The file found last, relative to the source root. */file?:string)=>void;reuse?:Inventory;exclude?:string[];/** Folders with these names are never listed, at any depth. */excludeNames?:string[];/** A file that cannot be read while listing is reported here instead of failing the listing. */onError?:(file:string,error:unknown)=>void}={},signal?:AbortSignal):Promise<Inventory> {
  const started=performance.now(), root=await directory(source), custom=rules(options.unknownRules);
  const defaults:RuleDefaults={fallback:options.unknownDefault??'skip',builtins:options.builtinRules??true};
  const files:InventoryFile[]=[];
  // Listing a large card takes a while; report what has been found so far.
  let listedBytes=0,reported=0,reportedAt=0,topDone=0,topTotal=0;
  const report=(final=false)=>{if(!options.onProgress||(!final&&files.length-reported<500&&performance.now()-reportedAt<100))return;reported=files.length;reportedAt=performance.now();options.onProgress(files.length,listedBytes,topTotal>0?{done:topDone,total:topTotal}:undefined,files.at(-1)?.relative);};
  const listedFolders:[string,string,string[]?][]=[];
  const folderKey=(stat:import('node:fs').BigIntStats)=>`${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
  // The last listing of the same scope, per folder: a folder whose identity is
  // unchanged (adding, removing or renaming an entry changes it) keeps its entries
  // from that listing, so only changed folders are read again.
  // A folder is reused when its identity is unchanged (same mount, this session) or, failing that,
  // when its entry names are unchanged. Names are what a listing remembered across a remount is
  // checked by: camera firmware may add files without updating a folder's stored timestamp.
  const remembered=new Map<string,{key:string;names?:string[];files:InventoryFile[];folders:string[]}>();
  if(options.reuse?.listing && !options.folders && options.reuse.listing.backup===!!options.backup) {
    for(const [relative,key,names] of options.reuse.listing.folders) remembered.set(relative,{key,names,files:[],folders:[]});
    const parent=(relative:string)=>{const folder=path.dirname(relative);return folder==='.'?'':folder;};
    for(const [relative] of options.reuse.listing.folders) if(relative) remembered.get(parent(relative))?.folders.push(relative);
    for(const file of options.reuse.files) remembered.get(parent(file.relative))?.files.push(file);
  }
  const add=(file:string,size:number)=>{files.push({path:file,relative:path.relative(root,file),size,kind:mediaKindForPath(file),included:false});listedBytes+=size;report();};
  // Folders never listed, such as a backup folder inside the chosen source.
  const excluded=new Set((options.exclude??[]).map(folder=>pathKey(path.resolve(folder)))),excludedNames=new Set((options.excludeNames??[]).map(pathKey));
  async function walk(folder:string,isRoot=false):Promise<void> {
    checkAbort(signal);
    if(excluded.has(pathKey(folder)))return;
    await contained(path.join(folder,'.inventory-path-check'),root);
    // Taken before listing: an entry added meanwhile changes it and forces a new listing later.
    const relative=path.relative(root,folder),key=folderKey(await fs.lstat(folder,{bigint:true})),known=remembered.get(relative);
    const reuse=async(names:string[]|undefined)=>{
      listedFolders.push([relative,key,names]);
      // Same name order as a fresh listing.
      const children=[...known!.files.map(file=>({name:path.basename(file.relative),file})),...known!.folders.map(child=>({name:path.basename(child),file:undefined}))].sort((a,b)=>a.name.localeCompare(b.name));
      if(isRoot)topTotal=children.filter(child=>!child.file).length;
      for(const child of children) {checkAbort(signal);if(child.file)add(path.join(folder,child.name),child.file.size);else{await walk(path.join(folder,child.name));if(isRoot){topDone++;report(true);}}}
    };
    if(known && known.key===key) return reuse(known.names);
    const entries=await fs.readdir(folder,{withFileTypes:true}),names=entries.map(entry=>entry.name).sort();
    if(known?.names && known.names.length===names.length && known.names.every((name,index)=>name===names[index])) return reuse(names);
    listedFolders.push([relative,key,names]);
    entries.sort((a,b)=>a.name.localeCompare(b.name));
    if(isRoot)topTotal=entries.filter(entry=>entry.isDirectory()&&!ignoredName(entry.name)).length;
    // The entries that need a look, in name order. Their lstats run LISTING_STATS at a time (one at a time
    // leaves a drive idle between calls); each is judged in order, and an error is raised at its own turn.
    const wanted=entries.filter(entry=>!(ignoredName(entry.name) || entry.isSymbolicLink() || (!options.backup && /\.(?:downloading|part|partial|crdownload|tmp)$/i.test(entry.name))));
    for(let start=0;start<wanted.length;start+=LISTING_STATS) {
      checkAbort(signal);
      const chunk=wanted.slice(start,start+LISTING_STATS);
      const looked=await Promise.allSettled(chunk.map(entry=>fs.lstat(path.join(folder,entry.name))));
      for(const [position,entry] of chunk.entries()) {
        checkAbort(signal);
        const outcome=looked[position]!;
        if(outcome.status==='rejected') throw outcome.reason;
        const file=path.join(folder,entry.name), stat=outcome.value;
        if(stat.isSymbolicLink()) continue;
        if(stat.isDirectory()){if(excludedNames.has(pathKey(entry.name)))continue;await walk(file);if(isRoot){topDone++;report(true);}}
        else if(stat.isFile()) add(file,stat.size);
      }
    }
  }
  if(options.folders){
    const selected:string[]=[];
    for(const relative of options.folders){validateRelative(relative);const requested=path.join(root,relative);await contained(path.join(requested,'.inventory-scope-check'),root);const folder=await directory(requested);if(!selected.some(parent=>folder===parent||folder.startsWith(parent+path.sep))){for(let index=selected.length-1;index>=0;index--)if(selected[index].startsWith(folder+path.sep))selected.splice(index,1);selected.push(folder);}}
    topTotal=selected.length;
    for(const folder of selected){await walk(folder);topDone++;report(true);}
  }else await walk(root,true);
  report(true);
  // Camera bookkeeping that looks like media (a thumbnail JPG) is a system file, never a photo.
  for(const file of files) if(file.kind!=='Other') {const system=knownSystemFile(file.relative);if(system){file.system=system;file.kind='Other';}}
  const media=new Map<string,InventoryFile[]>(),byPath=new Map<string,InventoryFile>();
  for(const file of files) if(file.kind!=='Other') { const key=stem(file.path); {const list=media.get(key);if(list)list.push(file);else media.set(key,[file]);} byPath.set(pathKey(file.path),file); }
  for(const file of files) {
    checkAbort(signal);
    if(file.kind==='Other') try { file.system=knownSystemFile(file.relative) ?? await finderAliasFile(file.path,file.size); } catch(error) { if(!options.onError) throw error; options.onError(file.path,error); }
    if(file.system) { file.included=!!options.backup; continue; }
    // Proxies (DJI LRF, GoPro and Insta360 LRV) contain real video and remain importable on their
    // own. An unambiguous original in the same directory supplies routing/family context.
    if(proxies.has(extension(file.path))) {
      const originals=proxyOriginals(file.path).flatMap(name=>media.get(name)??[]).filter(candidate=>candidate.kind==='Videos'&&!proxies.has(extension(candidate.path)));
      if(originals.length===1)file.companionOf=originals[0].path;
    }
    if(file.kind==='Other' && sidecars.has(extension(file.path))) {
      const ext=extension(file.path),dir=path.dirname(file.path),name=path.basename(file.path,path.extname(file.path));
      // A family member of these stems: a still wins unless a video sidecar sits beside a video.
      const choose=(matches:InventoryFile[]):InventoryFile|undefined => {
        const stills=matches.filter(f=>f.kind!=='Videos'), videos=matches.filter(f=>f.kind==='Videos');
        const originals=videos.filter(video=>!proxies.has(extension(video.path))),videoCandidates=originals.length?originals:videos;
        if(stills.length && !(videoOnly.has(ext) && videos.length)) return stills.find(f=>f.kind==='RAW')??stills[0];
        return videoCandidates.length===1?videoCandidates[0]:undefined;
      };
      // A Sony CnnnnR01.BIM belongs to its clip alone; its stem is never matched as-is.
      let primary=ext==='bim'?undefined:choose(media.get(stem(file.path))??[]);
      if(!primary && ext==='xml' && /^C\d+M\d{2}$/i.test(name)) {
        const videos=(media.get(stem(file.path).slice(0,-3))??[]).filter(f=>f.kind==='Videos');
        const originals=videos.filter(video=>!proxies.has(extension(video.path))),candidates=originals.length?originals:videos;
        if(candidates.length===1) primary=candidates[0];
      }
      // Lightroom, Camera Raw, ACR and RawTherapee write <name>.<original extension>.<sidecar>.
      primary??=byPath.get(stem(file.path));
      if(!primary && ext==='pp3' && /\.out$/i.test(name)) primary=byPath.get(pathKey(path.join(dir,name.slice(0,-4))));
      // darktable duplicates: <name>_<nn>.<ext>.xmp belongs to <name>.<ext> when no exact match exists.
      if(!primary && ext==='xmp') {const duplicate=/^(.*)_\d{2}\.(\w+)$/.exec(name);if(duplicate)primary=byPath.get(pathKey(path.join(dir,`${duplicate[1]}.${duplicate[2]}`)));}
      if(!primary && (ext==='cos'||ext==='comask') && captureOneEdit(file.path)) primary=byPath.get(pathKey(path.join(path.dirname(path.dirname(dir)),name)));
      if(!primary && audio.has(ext) && name.startsWith('_')) primary=choose(media.get(pathKey(path.join(dir,name.slice(1))))??[]);
      if(!primary && ext==='bim') {const clip=/^(C\d{4})R01$/i.exec(name);if(clip)primary=choose(media.get(pathKey(path.join(dir,clip[1]!)))??[]);}
      if(!primary && ext==='aae') {const edit=/^(IMG_)O(\d+)$/i.exec(name);if(edit)primary=choose(media.get(pathKey(path.join(dir,edit[1]!+edit[2]!)))??[]);}
      file.companionOf=primary?.path;
    }
    if(nkscEdit(file.path)) file.companionOf=byPath.get(pathKey(path.join(path.dirname(path.dirname(file.path)),path.basename(file.path,path.extname(file.path)))))?.path;
    const rule=unknownRule(extension(file.path),custom,defaults);
    file.included=!!options.backup || file.kind!=='Other' || !!file.companionOf || typeof rule==='string' || (!!rule && rule.action==='camera');
  }
  // Nothing is dropped silently: every file left out is listed with its reason.
  const skipped:SkippedFile[]=[],systemKinds:Record<string,number>={};
  for(const file of files) {
    if(file.system) systemKinds[file.system.id]=(systemKinds[file.system.id]??0)+1;
    // Resolve links only after every companion is identified: a sidecar can belong
    // to a proxy which itself belongs to an original listed later. Empty companions
    // travel with that original; an empty original leaves the whole family in place.
    if(!options.backup && !file.system) {
      let primary=file;
      while(primary.companionOf) {const original=byPath.get(pathKey(primary.companionOf));if(!original)break;primary=original;}
      if(primary.size===0) {file.included=false;skipped.push({path:file.path,reason:primary===file?'empty':'emptyPrimary'});continue;}
    }
    if(file.included) continue;
    const rule=file.system?undefined:unknownRule(extension(file.path),custom,defaults);
    skipped.push(file.system?{path:file.path,reason:'system',label:file.system.label}:{path:file.path,reason:rule===null?'unknown-rule':defaults.fallback==='ask'?'unknown-ask':'unknown-skip'});
  }
  const unknown=files.filter(f=>f.kind==='Other' && !f.companionOf && !f.system && (options.backup || f.size>0)), unknownExtensions:Record<string,number>={};
  for(const file of unknown) {const ext=extension(file.path); unknownExtensions[ext]=(unknownExtensions[ext]??0)+1;}
  return {files,media:files.filter(f=>f.kind!=='Other').length,companions:files.filter(f=>!!f.companionOf).length,unknown:unknown.length,bytes:files.filter(f=>f.included).reduce((sum,f)=>sum+f.size,0),unknownExtensions,...(options.folders?{}:{listing:{backup:!!options.backup,folders:listedFolders}}),system:files.filter(f=>!!f.system).length,empty:skipped.filter(item=>item.reason==='empty').length,systemKinds,skipped,elapsedMs:performance.now()-started};
}
