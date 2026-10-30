import path from 'node:path';
import type {InventoryFile,MediaLayout,Metadata,NoMetadataHandling,NoMetadataReason,UnknownDefault,UnknownFileRule} from '../shared';
import {LEGACY_UNKNOWN_CAMERA_FOLDER,PROBLEM_FILES_FOLDER,UNKNOWN_FILES_FOLDER} from '../shared';
import type {CatalogPlacement} from '../catalog/types';
import {noMetadataFolderName} from '../no-metadata';
import {captureTimestamp,parseCapture} from '../capture-time';
import {formatFolder,layoutFolders} from '../media-formats';
import {CONFLICTS_FOLDER,DEFAULT_EDITED_FOLDER,editedTemplate,expandTemplate,inEditedFolder,safeComponent,templateValues,validateRelative,validFolderName} from '../folder-template';
import {MessageError} from '../messages';
import {extension,stem,rules,nkscEdit,captureOneEdit,unknownRule,ignoredName,type RuleDefaults} from './inventory';
import {beneath,checkAbort,pathKey} from './paths';
import {DRIVE_BACKUPS} from './drive-backup';
import {log} from '../logger';

/** The folder rules of a library: where each media file goes under its backup folder. */
export interface FolderRules {
  template:string;layout:MediaLayout;/** video-root: the video folder template (empty or absent: `template`). */videoTemplate?:string;
  /** video-root: each root's video backup folder on the same destination, by position. */videoRoots?:string[];editedFolder?:string;
  /** Files with no capture date, no camera and no known origin, or unreadable metadata: keep (stay where they are, an import does not copy them), folder (filed under `noMetadataFolder` in each library root) or fileDate (filed by file time). Unset: fileDate. */noMetadata?:NoMetadataHandling;
  /** The folder for `noMetadata: 'folder'`; default "Unknown files". */noMetadataFolder?:string;
}
/** The media a file is filed as: its own, or for a companion its original's. Absent for a file
 * with neither, which stays directly in the camera folder. */
export interface Media {video:boolean;format:string;}
/** `camera`: the templated folder (a family's conflict folder lives there); `sub`: the layout's
 * folders inside it; `root`: which backup folder, the video one only in the video-root layout. */
export function expectedFolder(info:Metadata,mtime:Date,media:Media|undefined,options:FolderRules):{root:'photos'|'videos';camera:string;sub:string} {
  // Capture dates describe the camera's calendar day. Converting an EXIF
  // offset to UTC can move a midnight photo into the previous folder.
  const day=parseCapture(info.date)?.day;
  // Without a capture date, the file's modified time is read on this Mac's calendar, as
  // the camera's clock would have shown it, not in UTC.
  const capture=day?new Date(day+'T00:00:00Z'):new Date(Date.UTC(mtime.getFullYear(),mtime.getMonth(),mtime.getDate()));
  const values=templateValues(capture,safeComponent(info.camera?.trim()||info.origin||options.noMetadataFolder?.trim()||UNKNOWN_FILES_FOLDER));
  const editedFolder=options.editedFolder??DEFAULT_EDITED_FOLDER;
  if(!validFolderName(editedFolder))throw new MessageError('error.editedFolderName');
  const video=options.layout==='video-root'&&!!media?.video;
  const template=info.edited?editedTemplate(editedFolder):video&&options.videoTemplate?options.videoTemplate:options.template;
  // The template is checked, not the result: a camera name may itself contain braces.
  if(/[{}]/u.test(template.replace(/\{([^{}]+)\}/g,(token,key:string)=>Object.hasOwn(values,key)?'':token))) throw new MessageError('error.invalidTemplate',{template});
  const result=expandTemplate(template,values);
  validateRelative(result);
  // Edited exports stay directly in their edited camera folder.
  return {root:video?'videos':'photos',camera:result,sub:media&&!info.edited?path.join(...layoutFolders(options.layout,media.video,media.format)):''};
}
function contradicts(a:Metadata,b:Metadata):boolean {
  if(a.camera?.trim() && b.camera?.trim() && a.camera.trim().toLowerCase()!==b.camera.trim().toLowerCase()) return true;
  const left=parseCapture(a.date),right=parseCapture(b.date);
  if(!left?.clock || !right?.clock || !!left.zone!==!!right.zone) return false;
  // Missing offsets describe a wall clock, so the host timezone must never
  // supply an instant. Compare explicit offsets only when both are known.
  if(left.zone && right.zone) {
    if(captureTimestamp(left.clock+left.zone)!==captureTimestamp(right.clock+right.zone)) return true;
  } else if(left.clock!==right.clock) return true;
  // Absent fractional digits are unknown precision rather than recorded zeros.
  const precision=Math.min(left.fraction.length,right.fraction.length);
  return left.fraction.slice(0,precision)!==right.fraction.slice(0,precision);
}
/** Live Photos: pairs each .mov with the same-stem still (HEIC/HEIF/JPG) whose ContentIdentifier agrees, or, when
 * either lacks one, whose make is Apple, and sets `companionOf` on it. Indexed once by stem, so the cost is linear in
 * the number of files. `dropped` holds Apple videos whose same-stem still is empty and so never imported. */
export function pairLivePhotos(files:InventoryFile[],scanned:readonly InventoryFile[],infos:ReadonlyMap<string,Metadata>,hooks:{signal?:AbortSignal;stemOf?:(file:string)=>string}={}):{paired:Set<string>;dropped:Set<string>} {
  const stemOf=hooks.stemOf??stem,stillExtensions=['heic','heif','jpg','jpeg'],apple=(info?:Metadata)=>/^apple\b/i.test(info?.make??'');
  const emptyStems=new Set<string>(),paired=new Set<string>(),dropped=new Set<string>();
  for(const f of scanned) if(stillExtensions.includes(extension(f.path))) {
    if(f.size===0) emptyStems.add(stemOf(f.path));
  }
  const stillsByStem=Map.groupBy(files.filter(f=>stillExtensions.includes(extension(f.path))),f=>stemOf(f.path));
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
/** Whether `file` is an edited export. An existing edited folder records the user's classification even when an export lost its editor tags;
 * source folder names do not classify new imports. Routing (companions use their original's answer) and the duplicate records both ask this,
 * so a record always matches how its file is filed. RAW files are never edited exports: callers apply that rule. */
export function isEditedFile(file:InventoryFile,info:Metadata|undefined,options:{reorganize?:boolean;editedFolder?:string}):boolean {
  return info?.edited===true||options.reorganize===true&&inEditedFolder(file.relative.split(path.sep).slice(0,-1),options.editedFolder);
}
/** Pure routing input: inventory relationships and raw metadata are never overwritten.
 * Include the entire chosen scope so camera context and families match import planning. */
export interface RoutingInput {
  sourceRoot:string;
  files:readonly InventoryFile[];
  scanned?:readonly InventoryFile[];
  metadata:ReadonlyMap<string,Metadata>;
  mtimes:ReadonlyMap<string,Date>;
  unreadableMetadata?:ReadonlySet<string>;
  failed?:ReadonlySet<string>;
  roots?:readonly {root:string;role:'photos'|'videos'}[];
  options:Partial<FolderRules>&{backup?:boolean;reorganize?:boolean;unknownRules?:Record<string,UnknownFileRule>;unknownDefault?:UnknownDefault};
  signal?:AbortSignal;
}
export interface RouteDecision {
  file:InventoryFile;
  family:string;
  root:'photos'|'videos';
  relative?:string;
  camera?:string;
  /** Inheritance and chapter date changes apply only here; capture/exposure stay in input.metadata. */
  effectiveMetadata:Metadata;
  /** File-time fallback used by the template, possibly from the companion's primary. */
  effectiveMtime?:Date;
  captureTimeMs?:number;
  reason:'route'|'keep'|'exempt'|'emptyPrimary'|'failed';
  noMetadataReason?:NoMetadataReason;
  exemption?:string;
}
/** Policy-owned directories are accepted by library checks rather than routed as ordinary media.
 * Drive backups/Problem files are root-level; Conflicts can sit under any camera template. */
export function placementExemption(file:string,roots:readonly {root:string}[]):string|undefined {
  for(const {root} of roots) {
    if(!beneath(file,root))continue;
    const parts=path.relative(root,file).split(path.sep),parents=parts.slice(0,-1);
    if(parts[0]===DRIVE_BACKUPS||parts[0]===PROBLEM_FILES_FOLDER)return parts[0];
    if(parents.includes(CONFLICTS_FOLDER))return CONFLICTS_FOLDER;
    if(parts.some(ignoredName))return 'application or system files';
  }
  return undefined;
}
export type PlacementDecision=CatalogPlacement;
export interface PlacementInput {
  route?:RouteDecision;
  actual:{root:'photos'|'videos';relativePath:string};
  rulesScope:string;
  /** A saved decision from another rules scope is unchecked until it is evaluated again. */
  evaluatedRulesScope?:string;
}
export function classifyPlacement({route,actual,rulesScope,evaluatedRulesScope}:PlacementInput):PlacementDecision {
  const base={actualRelativePath:actual.relativePath,rulesScope};
  if(!route||evaluatedRulesScope!==undefined&&evaluatedRulesScope!==rulesScope)return {...base,status:'unchecked',reason:'rules changed or not checked'};
  if(route.reason==='exempt')return {...base,status:'inPlace',reason:route.exemption};
  if(route.reason!=='route'||route.relative===undefined)return {...base,status:'unclassifiable',reason:route.reason==='keep'?`keep: ${route.noMetadataReason}`:route.reason};
  const expectedRoute={role:route.root,relativePath:route.relative};
  const same=actual.root===route.root&&pathKey(actual.relativePath)===pathKey(route.relative);
  return {...base,status:same?'inPlace':'misplaced',expectedRoute,reason:same?'matches folder rules':'folder rules choose another path'};
}
/** Shared complete route evaluation; hashing, collision allocation and publication stay in the planner. */
export function evaluateRoutes(input:RoutingInput):RouteDecision[] {
  const {sourceRoot,options,signal}=input,infos=input.metadata,mtimes=input.mtimes,unreadableMeta=input.unreadableMetadata??new Set<string>();
  const folderRules=options.backup?undefined:options as FolderRules;
  const custom=rules(options.reorganize?{}:options.unknownRules),defaults:RuleDefaults=options.reorganize?{fallback:'skip',builtins:false}:{fallback:options.unknownDefault??'skip',builtins:true};
  const unknownMode:NoMetadataHandling=options.backup?'fileDate':options.noMetadata??'fileDate',unknownFolder=unknownMode==='folder'?noMetadataFolderName(options.noMetadataFolder,[options.editedFolder??DEFAULT_EDITED_FOLDER]):options.noMetadataFolder??UNKNOWN_FILES_FOLDER;
  const decisions:RouteDecision[]=[];
  // Inventory excludes an empty original together with its companions from moves. They still
  // need a completed catalog classification, without adopting other excluded unknown files.
  if(!options.backup) {
    const scanned=new Map((input.scanned??input.files).map(file=>[pathKey(file.path),file]));
    for(const file of input.files) {
      if(file.included)continue;
      let primary=file;
      for(let hops=0;primary.companionOf&&hops<16;hops++) {
        const original=scanned.get(pathKey(primary.companionOf));if(!original)break;primary=original;
      }
      if(primary.size!==0||primary.kind==='Other')continue;
      const exemption=options.reorganize?placementExemption(file.path,input.roots??[]):undefined;
      const root=input.roots?.find(part=>beneath(file.path,part.root))?.role??(options.layout==='video-root'&&primary.kind==='Videos'?'videos':'photos');
      decisions.push({file:{...file},family:'empty:'+primary.path,root,effectiveMetadata:{fields:{}},reason:exemption?'exempt':'emptyPrimary',...(exemption?{exemption}:{})});
    }
  }
  let files=input.files.filter(file=>file.included).map(file=>({...file}));
  if(options.reorganize)files=files.filter(file=>{const exemption=placementExemption(file.path,input.roots??[]);if(!exemption)return true;decisions.push({file,family:file.path,root:'photos',effectiveMetadata:{fields:{}},reason:'exempt',exemption});return false;});
  // Live Photos: a .mov beside a same-stem HEIC/HEIF/JPG is that still's companion when their ContentIdentifiers
  // agree. When either lacks one, the stem alone decides, but only for an Apple still. This needs the metadata
  // just read, so it runs here rather than in the inventory.
  const livePaired=new Set<string>(),liveRoot=new Map<string,InventoryFile>();
  if(!options.backup) {
    const {paired,dropped}=pairLivePhotos(files,input.scanned??input.files,infos,{signal});
    for(const mov of paired) livePaired.add(mov);
    if(dropped.size) {
      const listed=new Map(files.map(f=>[f.path,f]));
      const rootedInDropped=(file:InventoryFile)=>{for(let cur:InventoryFile|undefined=file,hops=0;cur&&hops<16;cur=cur.companionOf?listed.get(cur.companionOf):undefined,hops++)if(dropped.has(cur.path))return true;return false;};
      files=files.filter(file=>{
        if(!rootedInDropped(file)) return true;
        decisions.push({file,family:file.path,root:'photos',effectiveMetadata:{fields:{}},reason:'emptyPrimary'});
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

  }
  const stems=Map.groupBy(files,file=>stem(file.path));
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
  const failedFamilies=new Set(files.filter(file=>input.failed?.has(file.path)).map(file=>familyFor.get(file.path)));
  files=files.filter(file=>{if(!failedFamilies.has(familyFor.get(file.path)))return true;decisions.push({file,family:familyFor.get(file.path)!,root:'photos',effectiveMetadata:{fields:{}},reason:'failed'});return false;});
  // Each ancestor describes only media within its own subtree. Stop at the
  // nearest evidence, including mixed-camera evidence, rather than guessing
  // from another camera elsewhere on the card.
  const contexts=new Map<string,Map<string,{camera:string;dates:Set<string>}>>();
  for(const file of files) {
    if(file.kind==='Other') continue;
    const info=infos.get(file.path),camera=info?.camera?.trim();
    if(!camera) continue;
    const date=parseCapture(info?.date)?.day;
    for(let ancestor=path.dirname(file.path);;ancestor=path.dirname(ancestor)) {
      const context=contexts.get(ancestor)??new Map<string,{camera:string;dates:Set<string>}>(),key=camera.toLowerCase();
      const known=context.get(key)??{camera,dates:new Set<string>()};
      if(date) known.dates.add(date);
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
  // Unknown files: no capture date, no camera and no known origin, or metadata that could not be read. A family is
  // decided by its primary, so it is kept or filed apart whole.
  const unknownReason=(file:InventoryFile,primary:InventoryFile,cameraRule:boolean,context?:Metadata):NoMetadataReason|undefined=>{
    if(unknownMode==='fileDate'||options.backup||(file.kind==='Other'&&!file.companionOf&&!cameraRule))return undefined;
    const root=liveRoot.get(file.path)??chapterLead.get(file.path)??primary,info=cameraRule?context:infos.get(root.path);
    if(root.kind==='Other'&&!cameraRule)return undefined;
    if(unreadableMeta.has(root.path))return 'unreadable';
    if(!parseCapture(info?.date))return 'noDate';
    return !info?.camera?.trim()&&!info?.origin?'noCamera':undefined;
  };
  const libraryParts=input.roots??[];
  /** Where an unknown file goes under the folder: its subfolders as they are (below the library root when it is in one), minus the folder itself and the legacy Unknown Camera folders. */
  const unknownRelative=(file:InventoryFile)=>{
    const owner=options.reorganize?libraryParts.find(part=>beneath(file.path,part.root)):undefined;
    const sub=(owner?path.relative(owner.root,path.dirname(file.path)):path.dirname(file.relative)).split(path.sep).filter(part=>part&&part!=='.');
    if(sub[0]?.toLowerCase()===unknownFolder.toLowerCase())sub.shift();
    return path.join(unknownFolder,...sub.filter(part=>part.toLowerCase()!==LEGACY_UNKNOWN_CAMERA_FOLDER.toLowerCase()),path.basename(file.path));
  };
  const isEdited=(file:InventoryFile)=>isEditedFile(file,infos.get(file.path),options);
  for(const file of files) {
    const primary=primaryFor.get(file.path)!, own=infos.get(file.path)??{fields:{}}, paired=infos.get(primary.path)??{fields:{}};
    const rawMembers=(stems.get(stem(file.path))??[]).filter(f=>f.kind==='RAW');
    const inherit=primary.path!==file.path && (file.companionOf || (file.kind!=='Other' && rawMembers.length===1));
    const live=liveRoot.has(file.path),info:Metadata={fields:{},origin:own.origin||(inherit?paired.origin:undefined),camera:(live?paired.camera?.trim():undefined) || own.camera?.trim() || (inherit?paired.camera:undefined),date:(live?paired.date:undefined) || own.date || (inherit?paired.date:undefined),edited:file.kind==='Other'?primary.kind!=='RAW'&&isEdited(primary):file.kind!=='RAW'&&isEdited(file)};
    const rule=unknownRule(extension(file.path),custom,defaults);
    if(file.kind==='Other' && !file.companionOf && rule!==null && typeof rule==='object' && rule.action==='camera') Object.assign(info,unknownContext(file),{edited:false});
    let effectiveMetadata=info,effectiveMtime=mtimes.get(file.path)!;
    let relative:string,place:ReturnType<typeof expectedFolder>|undefined,forcedRoot:'photos'|'videos'|undefined;
    const unknown=unknownReason(file,primary,file.kind==='Other'&&!file.companionOf&&rule!==null&&typeof rule==='object'&&rule.action==='camera',info);
    if(unknown) {
      log('detailed','plan','no-metadata',{source:file.path,reason:unknown,decision:unknownMode,...(unknownMode==='folder'?{destination:unknownRelative(file)}:{})});
      if(unknownMode==='keep') {decisions.push({file,family:(info.edited?'edited:':'')+familyFor.get(file.path)!,root:'photos',effectiveMetadata:info,effectiveMtime,reason:'keep',noMetadataReason:unknown});continue;}
    }
    if(unknown) {
      // Every unknown file, videos and companions included, is filed under the photo library root, also in the video-root layout.
      relative=unknownRelative(file);forcedRoot='photos';
    }
    else if(!folderRules) relative=file.relative;
    else if(file.kind==='Other' && !file.companionOf && typeof rule==='string') relative=path.join(rule,path.basename(file.path));
    else {
      // Companions (sidecars, video metadata, NX Studio edits) are filed with their original.
      const original=file.companionOf?liveRoot.get(file.path)??byPath.get(file.companionOf)??file:file,nksc=nkscEdit(file.path)&&!!file.companionOf,captureOne=file.companionOf?captureOneEdit(file.path):undefined;
      const lead=chapterLead.get(file.path),route:Metadata=lead?{...info,date:infos.get(lead.path)?.date}:info;
      // An empty companion has no capture metadata of its own. Its primary also
      // supplies the fallback date, so differing mtimes cannot split the family.
      const dated=lead??(nksc||captureOne||live || file.size===0&&file.companionOf?primary:file);
      effectiveMetadata=route;effectiveMtime=mtimes.get(dated.path)!;
      place=expectedFolder(route,effectiveMtime,original.kind==='Other'?undefined:{video:original.kind==='Videos',format:formatFolder(original.path)},folderRules);
      // NX Studio reads NKSC_PARAM beside the original.
      relative=path.join(place.camera,place.sub,nksc?'NKSC_PARAM':captureOne??'',path.basename(file.path));
    }
    log('trace','plan','route',()=>({source:file.path,destination:relative,camera:place?.camera??info.camera,date:info.date,kind:file.kind,companionOf:file.companionOf,reason:options.backup?'drive backup keeps the source layout':file.kind==='Other'&&!file.companionOf&&typeof rule==='string'?`rule for .${extension(file.path)}: folder ${rule}`:place?info.camera&&info.date?'camera and capture date from metadata':info.date?'capture date from metadata, no camera name':info.camera?'camera from metadata, date from the file modification time':'no metadata: file modification time':'filed with its original',origin:info.origin}));
    decisions.push({file,relative,root:forcedRoot??place?.root??'photos',camera:place?.camera,effectiveMetadata,effectiveMtime,captureTimeMs:options.backup?undefined:captureTimestamp(info.date),family:(info.edited?'edited:':'')+familyFor.get(file.path)!,reason:'route',...(unknown?{noMetadataReason:unknown}:{})});
  }
  return decisions;
}
