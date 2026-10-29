import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {BigIntStats} from 'node:fs';
import type {FileOutcome} from '../core';
import {inventory,rules,unknownRule,extension} from '../core/inventory';
import {evaluateRoutes,classifyPlacement,type RoutingInput} from '../core/folder-rules';
import {within} from '../core/paths';
import {isRecordFolderName} from '../core/legacy-names';
import {mediaKindForPath} from '../media-formats';
import type {Listing,Metadata} from '../shared';
import type {Catalog,CatalogLibrary,CatalogRecord,CatalogScanEvent,CatalogStat,CatalogStatus,CatalogMoveEvent,CatalogChange} from './types';
import {catalogNameSortKey,catalogValues} from './values';
export const CATALOG_METADATA_VERSION=1;
/** Reviewed source identity lets metadata follow bytes only when the cache describes that source. */
export type CatalogMoveObservation=CatalogMoveEvent&{reviewedStat?:CatalogStat};
const slash=(value:string)=>value.split(path.sep).join('/');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const directoryIdentity=(stat:BigIntStats)=>`${stat.dev}:${stat.ino}`;
export const catalogStat=(stat:BigIntStats):CatalogStat=>({dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs)});
const sameStat=(a:CatalogStat,b:CatalogStat)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
const statIdentity=(stat:BigIntStats)=>`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
export interface LibraryBinding {library:CatalogLibrary;root:string;rootIdentity?:string;}
export interface LibrarySpec {root:string;mountPath:string;volumeId?:string;fallbackId?:string;name:string;role:'photos'|'videos';rulesScope:string;online:boolean;destinationIndex?:number;}
/** Reads identity only. An absent library never causes photo directories to be created. */
export async function bindLibrary(spec:LibrarySpec):Promise<LibraryBinding>{
 const mountPath=await fs.realpath(spec.mountPath).catch(()=>path.resolve(spec.mountPath)),root=await fs.realpath(spec.root).catch(()=>path.resolve(mountPath,path.relative(spec.mountPath,spec.root)));if(!within(root,mountPath))throw new Error('Library must be inside its volume.');
 const volumeId=spec.volumeId??`connection:${spec.fallbackId??randomUUID()}`,relativeRoot=slash(path.relative(mountPath,root));
 let rootIdentity:string|undefined,online=false;
 if(spec.online)try{const real=await fs.realpath(root),mount=await fs.realpath(mountPath),stat=await fs.lstat(root,{bigint:true});if(real===root&&within(real,mount)&&stat.isDirectory()&&!stat.isSymbolicLink()){rootIdentity=directoryIdentity(stat);online=true;}}catch{/* Empty/unavailable until the actual photo root exists. */}
 return {root,rootIdentity,library:{libraryId:hash(`${volumeId}\0${relativeRoot}`),volumeId,trustedVolumeId:!!spec.volumeId,relativeRoot,mountPath,name:spec.name,role:spec.role,online,rulesScope:spec.rulesScope,revision:0,...(spec.destinationIndex===undefined?{}:{destinationIndex:spec.destinationIndex})}};
}
export async function bindingUnchanged(binding:LibraryBinding):Promise<boolean>{
 if(!binding.library.online||!binding.rootIdentity)return false;
 try{const stat=await fs.lstat(binding.root,{bigint:true});return stat.isDirectory()&&!stat.isSymbolicLink()&&directoryIdentity(stat)===binding.rootIdentity&&await fs.realpath(binding.root)===binding.root;}catch{return false;}
}
interface Options {
 metadata(file:string):Promise<Metadata>;
 cachedMetadata?(file:string,identity:string):Metadata|undefined;
 options():RoutingInput['options'];
 validate?(binding:LibraryBinding):Promise<boolean>;
 changed?(libraryId:string):void;
 warning?(error:unknown,libraryId?:string):void;
}
/** Owns bounded ingestion and cancellable, read-only refreshes. Querying the catalog does no media I/O. */
export class CatalogCoordinator {
 private bindings=new Map<string,LibraryBinding>();
 /** Libraries in the latest configure() call; removed ones keep catalog records but claim no subtree. */
 private configured=new Set<string>();
 private listings=new Map<string,Listing>();
 private scans=new Map<string,string>();
 private refreshing=new Map<string,{control:AbortController;task:Promise<void>}>();
 private states=new Map<string,Partial<CatalogStatus>>();
 private dirty=new Set<string>();
 private queue:({outcome:FileOutcome;move?:never}|{move:CatalogMoveObservation;outcome?:never})[]=[];
 private moveTasks=new Set<Promise<void>>();
 private pendingCompanions=new Map<string,{libraryId:string;primary:string;companion:string}>();
 private publications=new Map<string,{libraryId:string;sourceFileId:string;destination:string;stat:CatalogStat}>();
 private movedIds=new Map<string,{libraryId:string;fileId:string}>();
 private flushTimer:ReturnType<typeof setTimeout>|undefined;
 private draining:Promise<void>|undefined;
 constructor(readonly catalog:Catalog,private deps:Options){}
 get libraries():CatalogLibrary[]{return [...this.bindings.values()].map(binding=>binding.library);}
 get running():boolean{return this.refreshing.size>0||!!this.draining||this.queue.length>0||this.moveTasks.size>0;}
 async configure(bindings:LibraryBinding[]):Promise<string[]>{
  const changed:string[]=[],next=new Map(bindings.map(binding=>[binding.library.libraryId,binding]));
  for(const [id,old] of this.bindings)if(!next.has(id))next.set(id,{...old,library:{...old.library,online:false}});
  for(const [id,binding] of next){const old=this.bindings.get(id);if(!old||old.root!==binding.root||old.rootIdentity!==binding.rootIdentity||old.library.online!==binding.library.online||old.library.rulesScope!==binding.library.rulesScope){this.refreshing.get(id)?.control.abort();this.listings.delete(id);if(binding.library.online){this.dirty.add(id);changed.push(id);}}if(!binding.library.online)this.refreshing.get(id)?.control.abort();}
  const invalidations=bindings.filter(binding=>{const old=this.bindings.get(binding.library.libraryId);return old&&old.library.rulesScope!==binding.library.rulesScope;}).map(binding=>({kind:'invalidatePlacement' as const,libraryId:binding.library.libraryId,rulesScope:binding.library.rulesScope,mutationRevision:0}));
  this.bindings=next;this.configured=new Set(bindings.map(binding=>binding.library.libraryId));await this.catalog.configure(this.libraries);for(let offset=0;offset<invalidations.length;offset+=256)await this.catalog.apply(invalidations.slice(offset,offset+256));return changed;
 }
 binding(id:string):LibraryBinding|undefined{return this.bindings.get(id);}
 needsRefresh():string[]{return [...this.dirty].filter(id=>this.bindings.get(id)?.library.online);}
 markDirty(id?:string):void{for(const library of this.libraries)if(!id||id===library.libraryId)this.dirty.add(library.libraryId);}
 async status(id:string):Promise<CatalogStatus>{return {...await this.catalog.status(id),...this.states.get(id),...(this.dirty.has(id)?{dirty:true}:{})};}
 stop(id?:string):void{for(const [key,work] of this.refreshing)if(!id||key===id)work.control.abort();}
 async settled():Promise<void>{do{await Promise.allSettled([...this.refreshing.values()].map(work=>work.task));await this.flush();await Promise.resolve();}while(this.running);}
 private async valid(binding:LibraryBinding):Promise<boolean>{return await bindingUnchanged(binding)&&(!this.deps.validate||await this.deps.validate(binding));}
 /** Events are target-library records only. Source-card inventories never enter this API. */
 async observeScan(event:CatalogScanEvent):Promise<void>{
  if(event.kind==='begin'){const binding=this.bindings.get(event.libraryId);if(!binding||!await this.valid(binding))throw new Error('Library is unavailable.');this.scans.set(event.libraryId,await this.catalog.beginScan(event.libraryId,event.scope));}
  else if(event.kind==='records'){for(let offset=0;offset<event.records.length;offset+=256)await this.catalog.ingest(this.scans.get(event.runId)??event.runId,event.records.slice(offset,offset+256));}
  else{await this.catalog.endScan(this.scans.get(event.runId)??event.runId,event.result);this.scans.delete(event.runId);}
 }
 /** Observes completed existing operations; never performs media mutations. The queue is bounded and failures are cache warnings only. */
 observeMove(event:CatalogMoveObservation):Promise<void>{return this.enqueue({move:event});}
 observeOutcome(outcome:FileOutcome):Promise<void>{return this.enqueue({outcome});}
 private enqueue(item:typeof this.queue[number]):Promise<void>{
  if(this.queue.length>=4096){this.markDirty();return Promise.resolve();}
  let resolve!:()=>void;const task=new Promise<void>(done=>{resolve=done;});this.moveTasks.add(task);
  this.queue.push(item);this.resolvers.set(item,()=>{this.moveTasks.delete(task);resolve();});
  if(this.queue.length>=256&&!this.draining){if(this.flushTimer)clearTimeout(this.flushTimer);this.flushTimer=undefined;void this.flush();}else if(!this.flushTimer&&!this.draining)this.flushTimer=setTimeout(()=>{this.flushTimer=undefined;void this.flush();},250);
  return task;
 }
 private resolvers=new Map<typeof this.queue[number],()=>void>();
 private normalBinding(file:string):LibraryBinding|undefined{
  return [...this.bindings.values()].filter(item=>this.configured.has(item.library.libraryId)&&within(file,item.root)&&!path.relative(item.root,file).split(path.sep).some(name=>isRecordFolderName(name)||name.toLowerCase()==='drive backups')).sort((a,b)=>b.root.length-a.root.length)[0];
 }
 async flush():Promise<void>{
  if(this.draining){const active=this.draining;await active;if(this.draining&&this.draining!==active||this.queue.length)await this.flush();return;}
  if(this.flushTimer){clearTimeout(this.flushTimer);this.flushTimer=undefined;}
  this.draining=(async()=>{while(this.queue.length){const batch=this.queue.splice(0,256),changes:CatalogChange[]=[];
   const apply=async()=>{if(!changes.length)return;const current=changes.splice(0);await this.catalog.apply(current);for(const id of new Set(current.map(change=>change.libraryId)))this.deps.changed?.(id);};
   for(const item of batch)try{
    if(item.move){await apply();await this.applyMove(item.move);continue;}
    const outcome=item.outcome,actual=await fs.realpath(outcome.destination).catch(()=>undefined);if(!actual)continue;const binding=this.normalBinding(actual);if(!binding||!await this.valid(binding))continue;
    const id=binding.library.libraryId;this.dirty.add(id);
    const stat=await fs.lstat(actual,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||outcome.finalIdentity&&outcome.finalIdentity!==statIdentity(stat))continue;
    const raw=outcome.sourceIdentity?this.deps.cachedMetadata?.(outcome.source,outcome.sourceIdentity):undefined;
    changes.push({kind:'upsert',libraryId:id,record:this.record(binding,slash(path.relative(binding.root,actual)),catalogStat(stat),raw),mutationRevision:0});
   }catch(error){this.markDirty();this.warn(error);}
   try{await apply();}catch(error){this.markDirty();this.warn(error);}finally{for(const item of batch){this.resolvers.get(item)?.();this.resolvers.delete(item);}}
  }})().finally(()=>{this.draining=undefined;if(this.queue.length)void this.flush();});await this.draining;if(this.moveTasks.size||this.queue.length)await this.flush();
 }
 private warn(error:unknown):void{try{this.deps.warning?.(error);}catch{/* A diagnostic cannot fail the file operation. */}}
 private async applyMove(event:CatalogMoveObservation):Promise<void>{
  const from=path.resolve(event.oldRoot,event.oldRelativePath);let to=event.newRoot!==undefined&&event.newRelativePath!==undefined?path.resolve(event.newRoot,event.newRelativePath):undefined;
  let oldBinding=this.normalBinding(from),nextBinding=to?this.normalBinding(to):undefined;
  for(const binding of [oldBinding,nextBinding])if(binding){this.dirty.add(binding.library.libraryId);this.listings.delete(binding.library.libraryId);}
  // These events always identify an actual, successful destination, including an excluded recovery slot.
  if(!to||!event.stat)return;let finalStat=event.stat;
  const actual=await fs.realpath(to).catch(()=>undefined);if(actual!==to)return;
  const final=await fs.lstat(to,{bigint:true});if(!final.isFile()||final.isSymbolicLink()||!sameStat(finalStat,catalogStat(final)))return;
  if(nextBinding&&!await this.valid(nextBinding)||oldBinding&&!await this.valid(oldBinding))return;
  let oldRelative=oldBinding?slash(path.relative(oldBinding.root,from)):undefined;
  let old=oldBinding&&oldRelative?(await this.catalog.records(oldBinding.library.libraryId,[oldRelative]))[0]:undefined;
  const sourcePresent=await fs.lstat(from).then(()=>true,()=>false),changes:CatalogChange[]=[];
  let replacePublication=false,pendingPublication:{libraryId:string;sourceFileId:string;destination:string;stat:CatalogStat}|undefined;
  // Publication can settle before the source is retained. Preserve both physical rows until stashing
  // succeeds, then replace the provisional copy identity with the original's stable logical identity.
  const publication=this.publications.get(from);
  if(!nextBinding&&oldBinding&&old&&!sourcePresent&&publication?.libraryId===oldBinding.library.libraryId&&publication.sourceFileId===old.fileId){
   const copy=await fs.lstat(publication.destination,{bigint:true}).catch(()=>undefined);
   if(copy?.isFile()&&!copy.isSymbolicLink()&&sameStat(publication.stat,catalogStat(copy))&&await fs.realpath(publication.destination)===publication.destination){to=publication.destination;nextBinding=oldBinding;finalStat=catalogStat(copy);replacePublication=true;}
   this.publications.delete(from);
  }
  if(oldBinding&&oldRelative&&!sourcePresent)changes.push({kind:'missing',libraryId:oldBinding.library.libraryId,relativePath:oldRelative,mutationRevision:0});
  if(nextBinding){
   const id=nextBinding.library.libraryId,relative=slash(path.relative(nextBinding.root,to)),sameName=path.basename(from)===path.basename(to);
   const target=(await this.catalog.records(id,[relative]))[0],unchangedTarget=target&&sameStat(target.stat,finalStat);
   const raw=unchangedTarget?target.routingMetadata:sameName?(event.metadata??(old?.metadataVersion===CATALOG_METADATA_VERSION&&event.reviewedStat&&sameStat(old.stat,event.reviewedStat)?old.routingMetadata:undefined)):undefined;
   const record=this.record(nextBinding,relative,finalStat,raw),moving=old&&oldBinding===nextBinding&&!sourcePresent&&(!target||target.fileId===old.fileId||replacePublication||event.action==='undo')?old:undefined;
   if(unchangedTarget){record.familyId=target.familyId;record.companionOf=target.companionOf;}
   if(old&&sameName&&old.companionOf){const primary=this.movedIds.get(old.companionOf);if(primary?.libraryId===id)record.companionOf=primary.fileId;}
   if(moving){
    changes.length=0;if(target&&target.fileId!==moving.fileId)changes.push({kind:'missing',libraryId:id,relativePath:relative,mutationRevision:0});changes.push({kind:'move',libraryId:id,fileId:moving.fileId,oldRelativePath:moving.relativePath,relativePath:relative,stat:finalStat,mutationRevision:0});
    if(target&&target.fileId!==moving.fileId)changes.push({kind:'relinkCompanions',libraryId:id,fromFileId:target.fileId,toFileId:moving.fileId,mutationRevision:0});
    record.fileId=moving.fileId;if(sameName){record.familyId=moving.familyId;record.companionOf=moving.companionOf;}
   }
   // The live primary first, then where it moved; failing both, it may already be stashed and marked missing (its publication was applied first), and its name still finds the keeper.
   if(old?.companionOf&&sameName&&oldBinding){
    const movedPrimary=this.movedIds.get(old.companionOf),originalPrimary=await this.catalog.file(oldBinding.library.libraryId,old.companionOf)??(movedPrimary?await this.catalog.file(movedPrimary.libraryId,movedPrimary.fileId):undefined)??await this.catalog.file(oldBinding.library.libraryId,old.companionOf,{includeMissing:true});
    if(originalPrimary){
     const candidate=path.posix.join(record.parentPath,originalPrimary.name),primary=(await this.catalog.records(id,[candidate]))[0];
     if(primary&&!primary.companionOf)record.companionOf=primary.fileId;
     else{this.pendingCompanions.set(`${id}\0${relative}`,{libraryId:id,primary:candidate,companion:relative});while(this.pendingCompanions.size>4096)this.pendingCompanions.delete(this.pendingCompanions.keys().next().value!);}
    }
   }
   if(old&&sourcePresent&&oldBinding===nextBinding&&!target)pendingPublication={libraryId:id,sourceFileId:old.fileId,destination:to,stat:finalStat};
   // A restored tombstone already owns its previous id; store upsert preserves it.
   changes.push({kind:'upsert',libraryId:id,record,mutationRevision:0});
  }
  if(changes.length){
   await this.catalog.apply(changes);
   if(pendingPublication){this.publications.set(from,pendingPublication);while(this.publications.size>4096)this.publications.delete(this.publications.keys().next().value!);}
   if(nextBinding){
    const id=nextBinding.library.libraryId,relative=slash(path.relative(nextBinding.root,to));
    if(old&&!sourcePresent){const actual=(await this.catalog.records(id,[relative]))[0];if(actual){this.movedIds.delete(old.fileId);this.movedIds.set(old.fileId,{libraryId:id,fileId:actual.fileId});while(this.movedIds.size>4096)this.movedIds.delete(this.movedIds.keys().next().value!);}}
    const waiting=[...this.pendingCompanions.entries()].filter(([,item])=>item.libraryId===id&&item.primary===relative);
    if(waiting.length){const primary=(await this.catalog.records(id,[relative]))[0];if(primary&&!primary.companionOf)for(let offset=0;offset<waiting.length;offset+=256){const chunk=waiting.slice(offset,offset+256),companions=await this.catalog.records(id,chunk.map(([,item])=>item.companion));await this.catalog.apply(companions.map(record=>({kind:'upsert' as const,libraryId:id,record:{...record,companionOf:primary.fileId},mutationRevision:0})));for(const [key] of chunk)this.pendingCompanions.delete(key);}}
   }
   for(const id of new Set(changes.map(change=>change.libraryId)))this.deps.changed?.(id);
  }
 }
 private record(binding:LibraryBinding,relative:string,stat:CatalogStat,raw?:Metadata):CatalogRecord{
  const name=path.posix.basename(relative);return {fileId:randomUUID(),libraryId:binding.library.libraryId,relativePath:relative,parentPath:path.posix.dirname(relative)==='.'?'':path.posix.dirname(relative),name,nameSortKey:catalogNameSortKey(name),nameInitial:/^[a-z]/i.test(name)?name[0]!.toUpperCase():/^\d/.test(name)?'0–9':'其他',stat,mediaKind:mediaKindForPath(name)??'Other',extension:path.extname(name).slice(1).toLowerCase(),metadataVersion:CATALOG_METADATA_VERSION,values:raw?catalogValues(raw):{metadataStatus:'pending'},...(raw?{routingMetadata:raw}:{}),placement:{status:'unchecked',actualRelativePath:relative,rulesScope:binding.library.rulesScope}};
 }
 refresh(id:string,signal:AbortSignal):Promise<void>{
  const previous=this.refreshing.get(id);if(previous)return previous.task;
  const control=new AbortController(),abort=()=>control.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)control.abort();
  const task=this.readLibrary(id,control.signal).finally(()=>{signal.removeEventListener('abort',abort);this.refreshing.delete(id);this.deps.changed?.(id);});
  this.refreshing.set(id,{control,task});return task;
 }
 private async readLibrary(id:string,signal:AbortSignal):Promise<void>{
  const binding=this.bindings.get(id);if(!binding||!await this.valid(binding))return;
  let run:string|undefined,completed=false;const progress={discovered:0,read:0,failed:0};
  this.states.set(id,{state:'scanning',progress});this.deps.changed?.(id);
  try{
   signal.throwIfAborted();run=await this.catalog.beginScan(id,['']);let partial=false;
   const found=await inventory(binding.root,{unknownDefault:'other',unknownRules:this.deps.options().unknownRules,reuse:this.listings.get(id),excludeNames:['Drive backups'],onError:()=>{partial=true;}},signal);
   if(found.listing)this.listings.set(id,found.listing);
   const files=found.files.filter(file=>!file.system&&this.normalBinding(file.path)?.library.libraryId===id),raw=new Map<string,Metadata>(),mtimes=new Map<string,Date>(),records:CatalogRecord[]=[],unreadable=new Set<string>();
   progress.discovered=files.length;
   for(let offset=0;offset<files.length;offset+=256){
    signal.throwIfAborted();if(!await this.valid(binding))throw new Error('Library identity changed.');
    const chunk=files.slice(offset,offset+256),saved=new Map((await this.catalog.records(id,chunk.map(file=>slash(file.relative)))).map(record=>[record.relativePath,record]));
    const prepared:{file:typeof files[number];record:CatalogRecord;cached?:Metadata}[]=[];
    let pending:CatalogRecord[]=[],flushedAt=Date.now();
    const flush=async(force=false)=>{if(pending.length&&(force||pending.length>=256||Date.now()-flushedAt>=250)){await this.catalog.ingest(run!,pending);pending=[];flushedAt=Date.now();this.deps.changed?.(id);}};
    for(const file of chunk){signal.throwIfAborted();try{
     const before=await fs.lstat(file.path,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||!within(await fs.realpath(file.path),binding.root)){partial=true;continue;}
     file.size=Number(before.size);
     const relative=slash(file.relative),stat=catalogStat(before),old=saved.get(relative);
     const cached=old?.metadataVersion===CATALOG_METADATA_VERSION&&old.values.metadataStatus==='ready'&&old.routingMetadata&&sameStat(old.stat,stat)?old.routingMetadata:undefined;
     const record=this.record(binding,relative,stat,cached);if(old)record.fileId=old.fileId;records.push(record);prepared.push({file,record,cached});mtimes.set(file.path,new Date(Number(before.mtimeMs)));pending.push({...record});await flush();
    }catch(error){if(signal.aborted)throw error;partial=true;progress.failed++;}}
    // Names become available as pending before their first metadata read completes.
    await flush(true);
    for(const {file,record,cached} of prepared){signal.throwIfAborted();let info=cached;
     if(!info)try{info=await this.deps.metadata(file.path);signal.throwIfAborted();if(!sameStat(record.stat,catalogStat(await fs.lstat(file.path,{bigint:true})))){partial=true;this.dirty.add(id);info=undefined;}}
     catch(error){if(signal.aborted)throw error;info={fields:{Error:error instanceof Error?error.message:String(error)}};progress.failed++;}
     if(info){raw.set(file.path,info);record.routingMetadata=info;record.values=catalogValues(info);if(record.values.metadataStatus==='error')unreadable.add(file.path);}
     progress.read++;pending.push({...record});await flush();
    }
    await flush(true);
   }
   // Cached listings preserve names, not current size-based inclusion. Recheck the whole family
   // after every fresh stat so empty originals and their companions transition together.
   const byPath=new Map(files.map(file=>[file.path,file])),custom=rules(this.deps.options().unknownRules);
   for(const file of files){const rule=unknownRule(extension(file.path),custom,{fallback:'other',builtins:true});file.included=file.kind!=='Other'||!!file.companionOf||typeof rule==='string'||!!rule&&rule.action==='camera';let primary=file;for(let hops=0;primary.companionOf&&hops<16;hops++){const parent=byPath.get(primary.companionOf);if(!parent)break;primary=parent;}if(primary.size===0)file.included=false;}
   signal.throwIfAborted();const routes=new Map(evaluateRoutes({sourceRoot:binding.root,files,scanned:files,metadata:raw,mtimes,unreadableMetadata:unreadable,roots:[{root:binding.root,role:binding.library.role}],options:{...this.deps.options(),backup:false,reorganize:true},signal}).map(route=>[route.file.path,route]));
   const recordIds=new Map(records.map(record=>[record.relativePath,record.fileId]));
   for(const record of records){const route=routes.get(path.join(binding.root,record.relativePath));record.familyId=route?.family;record.companionOf=route?.file.companionOf?recordIds.get(slash(path.relative(binding.root,route.file.companionOf))):undefined;record.placement=record.values.metadataStatus==='pending'?record.placement:classifyPlacement({route,actual:{root:binding.library.role,relativePath:record.relativePath},rulesScope:binding.library.rulesScope});}
   for(let offset=0;offset<records.length;offset+=256){signal.throwIfAborted();await this.catalog.ingest(run,records.slice(offset,offset+256));}
   if(!await this.valid(binding))throw new Error('Library identity changed.');
   await this.catalog.endScan(run,partial?'partial':'complete');completed=true;if(!partial)this.dirty.delete(id);else this.dirty.add(id);this.states.set(id,{state:'idle',progress});
  }catch(error){this.dirty.add(id);this.states.set(id,{state:signal.aborted?'paused':'error',progress,...(signal.aborted?{}:{error:error instanceof Error?error.message:String(error)})});if(!signal.aborted)this.deps.warning?.(error,id);}
  finally{if(run&&!completed)await this.catalog.endScan(run,signal.aborted?'cancelled':'partial').catch(error=>this.deps.warning?.(error,id));}
 }
}
