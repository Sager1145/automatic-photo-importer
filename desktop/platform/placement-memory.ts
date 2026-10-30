import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readCacheFile, serialized, writeCacheFile } from './user-caches';
import { beneath } from '../core/paths';
import { mapPool } from '../core/devices';

/** What the last folder check (or an import) knew about a destination library: which files sit where the folder
 * rules put them, each with the size, modification time (ns) and inode it had then. The next check skips reading
 * the metadata of a file whose key is unchanged. ctime is not part of the key: staging unlinks change it.
 * A missing, corrupt or differently scoped memory is empty, which only means a full check. The scope is routing-options.ts
 * rulesScope; the library's folders are in its id. The record's scope is also the one fact "this library was last filled under
 * these rules": a header with no files (an organization, or too many files to keep) still holds it. `rulesClaimed` marks a
 * record written by the guarded paths (a clean import, a check that found nothing misplaced, an organization): an older build wrote the scope
 * without those guards, so such a record's scope is not trusted (its entries still are). */
export interface PlacedFile {relative:string;size:number;mtimeNs:bigint;ino:bigint;}
export type Placement=Map<string,string>;
interface Stored {version:1;scope:string;rulesClaimed?:true;dirs:string[];d:number[];n:string[];s:number[];m:string[];i:string[];}
const MAX_ENTRIES=400_000,MAX_BYTES=24*1024*1024;
const fileFor=(store:string,id:string)=>path.join(store,'placement-memory',`${id}.json.gz`);
export const placementKey=(size:number,mtimeNs:bigint,ino:bigint)=>`${size}:${mtimeNs.toString(36)}:${ino.toString(36)}`;
const hashOf=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,32);
/** One memory per destination volume and library; the scope is stored inside and must match. */
export const placementId=(volumeId:string,root:string,videoRoot?:string)=>hashOf([volumeId,path.resolve(root),videoRoot?path.resolve(videoRoot):'']);

const readStored=(store:string,id:string)=>readCacheFile<Stored>(fileFor(store,id),'placement',1,{maxBytes:MAX_BYTES,gzip:true});
// The header of each record, so asking which rules a library was filled under does not read and unzip the whole file again.
const headers=new Map<string,{scope?:string;claimed:boolean}>();
/** The folder rules the library of memory `id` was last filled under (the record's header); undefined when none is recorded or the record does not claim them. */
export async function placementScope(store:string,id:string):Promise<string|undefined> {
  const key=fileFor(store,id);let header=headers.get(key);
  if(!header){
    const stored=await readStored(store,id);
    header={...(typeof stored?.scope==='string'?{scope:stored.scope}:{}),claimed:stored?.rulesClaimed===true};
    // A write that finished while this read ran has already set the newer header.
    if(stored&&!headers.has(key))headers.set(key,header);else if(headers.has(key))header=headers.get(key)!;
  }
  return header.claimed?header.scope:undefined;
}
export async function loadPlacement(store:string,id:string,scope:string):Promise<Placement|undefined> {
  const stored=await readStored(store,id);
  if(!stored||stored.scope!==scope||!Array.isArray(stored.dirs)||![stored.d,stored.n,stored.s,stored.m,stored.i].every(column=>Array.isArray(column)&&column.length===stored.n.length)) return undefined;
  const memory:Placement=new Map();
  for(let index=0;index<stored.n.length;index++) {
    const dir=stored.dirs[stored.d[index]!],name=stored.n[index];
    if(typeof dir!=='string'||typeof name!=='string'||typeof stored.m[index]!=='string'||typeof stored.i[index]!=='string'||!Number.isSafeInteger(stored.s[index])) return undefined;
    memory.set(dir?`${dir}/${name}`:name,`${stored.s[index]}:${stored.m[index]}:${stored.i[index]}`);
  }
  return memory;
}
/** Forgets the library's record altogether (no rules are recorded for it afterwards). */
export const forgetPlacement=(store:string,id:string)=>serialized(fileFor(store,id),async()=>{headers.delete(fileFor(store,id));await fs.unlink(fileFor(store,id)).catch(()=>{});});
// Writers of one file take turns, so an import and a check never overwrite each other's update.
function mutate(store:string,id:string,scope:string,change:(current:Placement)=>Placement,fresh=false):Promise<void> {
  const target=fileFor(store,id);
  return serialized(target,async()=>{
    let memory=change(fresh?new Map():await loadPlacement(store,id,scope)??new Map());
    // Too many to keep compact: keep only the header, so the rules stay recorded and the next check reads everything.
    if(memory.size>MAX_ENTRIES) memory=new Map();
    const dirs:string[]=[],index=new Map<string,number>(),stored:Stored={version:1,scope,rulesClaimed:true,dirs,d:[],n:[],s:[],m:[],i:[]};
    for(const [relative,key] of memory) {
      const cut=relative.lastIndexOf('/'),dir=cut<0?'':relative.slice(0,cut);
      let at=index.get(dir);if(at===undefined) {at=dirs.length;dirs.push(dir);index.set(dir,at);}
      const [size,mtime,ino]=key.split(':');
      stored.d.push(at);stored.n.push(relative.slice(cut+1));stored.s.push(Number(size));stored.m.push(mtime!);stored.i.push(ino!);
    }
    headers.delete(target);
    await writeCacheFile(target,'placement',stored as unknown as Record<string,unknown>,{gzip:true});
    headers.set(target,{scope,claimed:true});
  });
}
const toMap=(files:Iterable<PlacedFile>):Placement=>new Map([...files].map(file=>[file.relative.split(path.sep).join('/'),placementKey(file.size,file.mtimeNs,file.ino)]));
/** A completed check: the files found in place are the whole memory. */
export const replacePlacement=(store:string,id:string,scope:string,files:Iterable<PlacedFile>)=>{const next=toMap(files);return mutate(store,id,scope,()=>next,true);};
/** An import or organization: its placed files join the memory. */
export const addPlacement=(store:string,id:string,scope:string,files:Iterable<PlacedFile>)=>{const added=toMap(files);return mutate(store,id,scope,current=>{for(const [relative,key] of added)current.set(relative,key);return current;});};
/** Whether `relative` is remembered with this exact size, mtime and inode. */
export const placedMatches=(memory:Placement|undefined,relative:string,size:number,mtimeNs:bigint,ino:bigint)=>memory?.get(relative.split(path.sep).join('/'))===placementKey(size,mtimeNs,ino);
/** Where an import's files actually are on destination `slot`, as outcomes report them: a file found where older rules
 * filed it (`routed`) is not where the rules put it, so it is not placed. */
export function placedOutcomes(outcomes:Iterable<readonly {destinationSlot:number;disposition:string;destination:string;size:number}[]>,slot:number):{destination:string;size:number}[] {
  return [...outcomes].flat().filter(item=>item.destinationSlot===slot&&item.disposition!=='routed');
}
/** Adds the entries of an import or organization that now exist as files of their planned size inside `roots`, using their stat after the job
 * published them (library-relative to `source`). Entries that are missing, changed in size or outside the roots are left out. */
export async function rememberEntries(store:string,id:string,scope:string,source:string,roots:string[],entries:{destination:string;size:number}[]):Promise<void> {
  const found:PlacedFile[]=[];
  await mapPool(entries,16,async entry=>{
    const relative=path.relative(source,entry.destination);
    if(!roots.some(root=>beneath(entry.destination,root))) return;
    const stat=await fs.lstat(entry.destination,{bigint:true}).catch(()=>undefined);
    if(stat?.isFile()&&stat.size===BigInt(entry.size)) found.push({relative,size:entry.size,mtimeNs:stat.mtimeNs,ino:stat.ino});
  });
  // Nothing new still records the scope the library was filled under.
  if(found.length||await placementScope(store,id)!==scope) await addPlacement(store,id,scope,found);
}
