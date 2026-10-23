import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

/** What the last folder check (or an import) knew about a destination library: which files sit where the folder
 * rules put them, each with the size, modification time (ns) and inode it had then. The next check skips reading
 * the metadata of a file whose key is unchanged. ctime is not part of the key: staging unlinks change it.
 * A missing, corrupt or differently scoped memory is empty, which only means a full check. */
export interface PlacedFile {relative:string;size:number;mtimeNs:bigint;ino:bigint;}
export type Placement=Map<string,string>;
interface Stored {version:1;scope:string;dirs:string[];d:number[];n:string[];s:number[];m:string[];i:string[];}
const MAX_ENTRIES=400_000,MAX_BYTES=24*1024*1024;
const fileFor=(store:string,id:string)=>path.join(store,'placement-memory',`${id}.json.gz`);
export const placementKey=(size:number,mtimeNs:bigint,ino:bigint)=>`${size}:${mtimeNs.toString(36)}:${ino.toString(36)}`;
const hashOf=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,32);
/** One memory per destination volume and library; the scope is stored inside and must match. */
export const placementId=(volumeId:string,root:string,videoRoot?:string)=>hashOf([volumeId,path.resolve(root),videoRoot?path.resolve(videoRoot):'']);
/** Everything that changes where a file belongs. */
export const placementScope=(parts:{template:string;layout:string;videoTemplate?:string;editedFolder?:string;basePaths:string[]})=>hashOf([parts.template,parts.layout,parts.videoTemplate??'',parts.editedFolder??'',parts.basePaths]);

export async function loadPlacement(store:string,id:string,scope:string):Promise<Placement|undefined> {
  try {
    const file=fileFor(store,id);
    if((await fs.lstat(file)).size>MAX_BYTES) return undefined;
    const stored=JSON.parse(gunzipSync(await fs.readFile(file),{maxOutputLength:8*MAX_BYTES}).toString('utf8')) as Stored;
    if(stored?.version!==1||stored.scope!==scope||!Array.isArray(stored.dirs)||![stored.d,stored.n,stored.s,stored.m,stored.i].every(column=>Array.isArray(column)&&column.length===stored.n.length)) return undefined;
    const memory:Placement=new Map();
    for(let index=0;index<stored.n.length;index++) {
      const dir=stored.dirs[stored.d[index]!],name=stored.n[index];
      if(typeof dir!=='string'||typeof name!=='string'||typeof stored.m[index]!=='string'||typeof stored.i[index]!=='string'||!Number.isSafeInteger(stored.s[index])) return undefined;
      memory.set(dir?`${dir}/${name}`:name,`${stored.s[index]}:${stored.m[index]}:${stored.i[index]}`);
    }
    return memory;
  } catch { return undefined; }
}
// Writers take turns, so an import and a check never overwrite each other's update.
let writing:Promise<void>=Promise.resolve();
function mutate(store:string,id:string,scope:string,change:(current:Placement)=>Placement,fresh=false):Promise<void> {
  const work=writing.catch(()=>{}).then(async()=>{
    const memory=change(fresh?new Map():await loadPlacement(store,id,scope)??new Map()),target=fileFor(store,id);
    // Too large to keep compact: forget it and check fully next time.
    if(!memory.size||memory.size>MAX_ENTRIES) { await fs.unlink(target).catch(()=>{}); return; }
    const dirs:string[]=[],index=new Map<string,number>(),stored:Stored={version:1,scope,dirs,d:[],n:[],s:[],m:[],i:[]};
    for(const [relative,key] of memory) {
      const cut=relative.lastIndexOf('/'),dir=cut<0?'':relative.slice(0,cut);
      let at=index.get(dir);if(at===undefined) {at=dirs.length;dirs.push(dir);index.set(dir,at);}
      const [size,mtime,ino]=key.split(':');
      stored.d.push(at);stored.n.push(relative.slice(cut+1));stored.s.push(Number(size));stored.m.push(mtime!);stored.i.push(ino!);
    }
    const temporary=`${target}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
    try { await fs.writeFile(temporary,gzipSync(JSON.stringify(stored),{level:1}),{mode:0o600}); await fs.rename(temporary,target); }
    catch(error) { await fs.unlink(temporary).catch(()=>{}); throw error; }
  });
  writing=work;return work;
}
const toMap=(files:Iterable<PlacedFile>):Placement=>new Map([...files].map(file=>[file.relative.split(path.sep).join('/'),placementKey(file.size,file.mtimeNs,file.ino)]));
/** A completed check: the files found in place are the whole memory. */
export const replacePlacement=(store:string,id:string,scope:string,files:Iterable<PlacedFile>)=>{const next=toMap(files);return mutate(store,id,scope,()=>next,true);};
/** An import or organization: its placed files join the memory. */
export const addPlacement=(store:string,id:string,scope:string,files:Iterable<PlacedFile>)=>{const added=toMap(files);return mutate(store,id,scope,current=>{for(const [relative,key] of added)current.set(relative,key);return current;});};
/** Whether `relative` is remembered with this exact size, mtime and inode. */
export const placedMatches=(memory:Placement|undefined,relative:string,size:number,mtimeNs:bigint,ino:bigint)=>memory?.get(relative.split(path.sep).join('/'))===placementKey(size,mtimeNs,ino);
/** Adds the entries of an import or organization that now exist as files of their planned size inside `roots`, using their stat after the job
 * published them (library-relative to `source`). Entries that are missing, changed in size or outside the roots are left out. */
export async function rememberEntries(store:string,id:string,scope:string,source:string,roots:string[],entries:{destination:string;size:number}[]):Promise<void> {
  const found:PlacedFile[]=[];let next=0;
  await Promise.all(Array.from({length:Math.min(entries.length,16)},async()=>{
    while(next<entries.length) {
      const entry=entries[next++]!,relative=path.relative(source,entry.destination);
      if(!roots.some(root=>{const inside=path.relative(root,entry.destination);return inside!==''&&!inside.startsWith('..')&&!path.isAbsolute(inside);})) continue;
      const stat=await fs.lstat(entry.destination,{bigint:true}).catch(()=>undefined);
      if(stat?.isFile()&&stat.size===BigInt(entry.size)) found.push({relative,size:entry.size,mtimeNs:stat.mtimeNs,ino:stat.ino});
    }
  }));
  if(found.length) await addPlacement(store,id,scope,found);
}
