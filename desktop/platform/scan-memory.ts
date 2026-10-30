import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Listing, Metadata } from '../shared';
import { readCacheFile, serialized, writeCacheFile } from './user-caches';

/** What a scan learned about one card, kept across app restarts under its volume UUID.
 * Paths are relative to the card and stats omit the device number, which changes on
 * every mount. Nothing here is trusted as-is: folders are reused only when their entry
 * names still match, and EXIF results only when a file's inode, size and times match. */
interface Stored {
  /** 5: routing metadata carries the summary card's exposure numbers and shutter count (a number, with a note code). */
  version:5;volume:string;saved:string;backup:boolean;
  folders:[string,string[]][];
  files:[string,number][];
  routing:[string,string,Metadata][];
}
const MAX_BYTES=64*1024*1024;
const memoryFile=(store:string,volume:string)=>path.join(store,'scan-memory',createHash('sha256').update(volume).digest('hex').slice(0,32)+'.json');
const safeRelative=(relative:unknown):relative is string=>typeof relative==='string' && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..');

/** `routing`: the routing results for files under `mount` (routingEntriesUnder). */
export async function saveScanMemory(store:string,volume:string,mount:string,listing:Listing,routing:[string,Metadata][]):Promise<void> {
  const prefix=mount+path.sep,stored:Stored={
    version:5,volume,saved:new Date().toISOString(),backup:listing.backup,
    // A folder's identity holds the mount's device number: after a remount it is checked by its names.
    folders:listing.folders.map(({relative,names})=>[relative,names]),
    files:listing.files.map(file=>[file.relative,file.size]),
    routing:routing.filter(([key])=>key.startsWith(prefix)).flatMap(([key,metadata])=>{
      const [file,stat]=key.split('\0'),parts=stat?.split(':');
      return file&&parts?.length===5?[[path.relative(mount,file),parts.slice(1).join(':'),metadata] as [string,string,Metadata]]:[];
    }),
  };
  await writeCacheFile(memoryFile(store,volume),'scan',stored as unknown as Record<string,unknown>);
}

/** The remembered listing (its folders without an identity, so each is checked by its names) and EXIF results rebased
 * onto the card's current mount, or undefined when nothing usable is remembered. */
export async function loadScanMemory(store:string,volume:string,mount:string):Promise<{listing:Listing;routing:[string,Metadata][]}|undefined> {
  try {
    const stored=await readCacheFile<Stored>(memoryFile(store,volume),'scan',5,{maxBytes:MAX_BYTES});
    if(!stored || stored.volume!==volume || !Array.isArray(stored.folders) || !Array.isArray(stored.files) || !Array.isArray(stored.routing)) return undefined;
    const dev=(await fs.lstat(mount,{bigint:true})).dev;
    const listing:Listing={
      backup:!!stored.backup,
      folders:stored.folders.filter(([relative,names])=>safeRelative(relative)&&Array.isArray(names)&&names.every(name=>typeof name==='string')).map(([relative,names])=>({relative,names})),
      files:stored.files.filter(([relative,size])=>safeRelative(relative)&&relative!==''&&Number.isSafeInteger(size)&&size>=0).map(([relative,size])=>({relative,size})),
    };
    const routing=stored.routing.filter(([relative,stat,metadata])=>safeRelative(relative)&&typeof stat==='string'&&/^\d+:\d+:\d+:\d+$/.test(stat)&&metadata&&typeof metadata==='object')
      .map(([relative,stat,metadata])=>[`${path.join(mount,relative)}\0${dev}:${stat}`,metadata] as [string,Metadata]);
    return {listing,routing};
  } catch { return undefined; }
}

/** Checksums of card files this app copied and verified, kept per card (volume UUID) with the
 * inode, size and times they were read under. A later plan uses one only while the card file
 * still has that exact identity, so an unchanged card is recognised without being read. */
const importedFile=(store:string,volume:string)=>memoryFile(store,volume).replace(/\.json$/,'.imported.json');
type Imported=Record<string,{stat:string;sha256:string}>;
const withoutDevice=(identity:string)=>identity.split(':').slice(1).join(':');
async function readImported(store:string,volume:string):Promise<Imported> {
  const stored=await readCacheFile<{volume:string;files:Imported}>(importedFile(store,volume),'imported',1,{maxBytes:MAX_BYTES});
  if(!stored||stored.volume!==volume||!stored.files||typeof stored.files!=='object') return {};
  return Object.fromEntries(Object.entries(stored.files as Imported).filter(([relative,value])=>safeRelative(relative)&&relative!==''&&typeof value?.stat==='string'&&/^-?\d+:\d+:\d+:\d+$/.test(value.stat)&&/^[a-f0-9]{64}$/.test(value?.sha256??'')));
}
export function rememberImported(store:string,volume:string,mount:string,verified:Record<string,{sha256:string;identity:string}>):Promise<void> {
  const target=importedFile(store,volume),prefix=mount+path.sep;
  return serialized(target,async()=>{
    const files=await readImported(store,volume);
    for(const [file,{sha256,identity}] of Object.entries(verified)) if(file.startsWith(prefix)&&/^[a-f0-9]{64}$/.test(sha256)) files[path.relative(mount,file)]={stat:withoutDevice(identity),sha256};
    await writeCacheFile(target,'imported',{volume,files});
  });
}
export async function loadImported(store:string,volume:string,mount:string):Promise<(file:string,identity:string)=>string|undefined> {
  const files=await readImported(store,volume),prefix=mount+path.sep;
  return (file,identity)=>{
    if(!file.startsWith(prefix)) return undefined;
    const known=files[path.relative(mount,file)];
    return known&&known.stat===withoutDevice(identity)?known.sha256:undefined;
  };
}
