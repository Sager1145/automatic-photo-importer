import * as fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {BigIntStats} from 'node:fs';
import {hostKeyConfigured,maybeLstat,sealV5,writeNewFile} from '../app-store';
import {indexLocations,indexTarget,INDEX_FILE,LEGACY_INDEX_NAMES} from '../destination-index';
import {DUPLICATES_FILE,LEGACY_DUPLICATES_NAME} from '../duplicates';
import {DRIVE_BACKUPS,DRIVE_MARKER,LEGACY_DRIVE_MARKER,markerIdentity,markerText} from '../drive-backup';
import {code,contained,identity,sameStat,syncDirectory} from '../paths';
import {hit,message,passThrough,type MigrationContext} from './common';

const MAX_BYTES=256*1024*1024,TEMPORARY_AGE_MS=60*60*1000;
const legacyTemporary=/^\.?photo-importer-(?:index|duplicates)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
/** Remove a file only while it is still the one looked at. */
async function removeIfSame(file:string,stat:BigIntStats,scope:string):Promise<void>{
 await contained(file,scope);const now=await maybeLstat(file);
 if(now?.isFile()&&sameStat(now,stat)){await fs.unlink(file);await syncDirectory(path.dirname(file));}
}
/** One earlier-version cache of `root` (index or duplicate store): written sealed into the store unless the store
 * already has one, then the old file removed while unchanged. One for another folder (another root identity) is
 * only removed: nothing would read it. */
async function convertCache(root:string,file:string,kind:'index'|'duplicates',version:number,context:MigrationContext):Promise<void>{
 const before=await maybeLstat(file);if(!before?.isFile())return;
 const name=kind==='index'?INDEX_FILE:DUPLICATES_FILE;
 const present=await Promise.all((await indexLocations(root,name)).map(location=>maybeLstat(location)));
 if(!present.some(Boolean)&&before.size<=BigInt(MAX_BYTES)){
  let data:Record<string,unknown>|undefined;
  try{data=JSON.parse(await fs.readFile(file,'utf8'));}catch{data=undefined;}
  const now=await identity(root);
  // The same folder: its inode (a device number changes between mounts).
  if(data&&data.version===version&&typeof data.rootIdentity==='string'&&data.rootIdentity.split(':')[1]===now.split(':')[1]&&data.files&&typeof data.files==='object'){
   const {version:_version,rootIdentity:_identity,...rest}=data;
   const target=await indexTarget(root,name),temporary=path.join(path.dirname(target),`${kind}-${randomUUID()}.tmp`);
   await writeNewFile(temporary,JSON.stringify(sealV5(kind,{rootIdentity:now,...rest})));
   await fs.rename(temporary,target);await syncDirectory(path.dirname(target));
   await hit(context,'C:written');
  }
 }
 await removeIfSame(file,before,root);
 await hit(context,'C');
}
/** The earlier version's drive marker in one drive's backup folder: rewritten sealed, then the hidden one removed. */
async function convertMarker(folder:string,root:string,context:MigrationContext):Promise<void>{
 const visible=path.join(folder,DRIVE_MARKER),hidden=path.join(folder,LEGACY_DRIVE_MARKER);
 const read=async(file:string)=>{const stat=await maybeLstat(file);if(!stat?.isFile())return undefined;try{return {stat,value:JSON.parse(await fs.readFile(file,'utf8')) as Record<string,unknown>};}catch{return {stat,value:undefined};}};
 const shown=await read(visible),old=await read(hidden);
 if(!shown&&!old)return;
 const identities=[shown,old].filter(Boolean).map(item=>item!.value?markerIdentity(item!.value):null);
 if(identities.some(item=>item===null)||new Set(identities).size>1)throw new Error(`Drive backup markers disagree or cannot be read: ${folder}`);
 const recorded=shown?.value??old!.value!;
 if(!shown||shown.value?.v===undefined){
  const temporary=path.join(folder,`photo-importer-drive-${randomUUID()}.tmp`);
  await contained(temporary,root);
  await writeNewFile(temporary,markerText({identity:identities[0]!,name:String(recorded.name??'')}));
  await fs.rename(temporary,visible);await syncDirectory(folder);
  await hit(context,'C:written');
 }
 if(old)await removeIfSame(hidden,old.stat,root);
 await hit(context,'C');
}
/** C: `root`'s destination index and duplicate store, its earlier version's temp files over an hour old, and the
 * drive markers of its drive backups. */
export async function convertCaches(root:string,context:MigrationContext):Promise<void>{
 const note=(error:unknown)=>{if(passThrough(error))throw error;context.problems.push(`${root}: ${message(error)}`);};
 for(const name of LEGACY_INDEX_NAMES)await convertCache(root,path.join(root,name),'index',1,context).catch(note);
 await convertCache(root,path.join(root,LEGACY_DUPLICATES_NAME),'duplicates',2,context).catch(note);
 for(const name of await fs.readdir(root).catch(()=>[] as string[])){
  if(!legacyTemporary.test(name))continue;
  const file=path.join(root,name),stat=await maybeLstat(file);
  if(stat?.isFile()&&Date.now()-Number(stat.mtimeNs/1000000n)>TEMPORARY_AGE_MS)await removeIfSame(file,stat,root).catch(note);
 }
 if(!hostKeyConfigured())return;
 const backups=path.join(root,DRIVE_BACKUPS);
 for(const entry of await fs.readdir(backups,{withFileTypes:true}).catch(error=>{if(code(error)==='ENOENT')return [];throw error;}))
  if(entry.isDirectory())await convertMarker(path.join(backups,entry.name),root,context).catch(note);
}
