import type * as NodeFs from 'node:fs/promises';
import { constants, type BigIntStats, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

/** Sources that are not mounted filesystems: a USB camera in MTP/PTP mode is listed once (names, folders, sizes,
 * dates) and its files are read on demand, a byte range at a time. Each such source is given a folder path of its own
 * that exists nowhere on disk (`\\?\photo-importer-camera\<id>` on Windows, `/.photo-importer-camera/<id>` elsewhere),
 * and the core's file access goes through `sourceAware(fs)`: under such a path lstat, stat, readdir, realpath and a
 * read-only open are answered from the listing and the reader; everything else is the real filesystem, untouched.
 * So planning, metadata, hashing and the copy read a camera exactly as they read a card, and nothing is ever written
 * for it anywhere but the destination. */
export interface ListedFile {
  /** Path inside the source, '/' separated (`Slot 1/DCIM/100NZ_F/DSC_0001.NEF`). */
  relative:string;
  size:number;
  modifiedMs:number;
  createdMs?:number;
}
export interface ListedSource {
  /** Stable for the same camera storage across connections, so a partial copy left by a disconnect is found again. */
  id:string;
  files:readonly ListedFile[];
  /** Up to `length` bytes of `file` from `offset`; fewer only at its end, none past it. */
  read(file:ListedFile,offset:number,length:number):Promise<Buffer>;
  /** Called once a reader of `file` is closed: whatever the device kept open for it may go. */
  release?(file:ListedFile):void;
}
interface Registered {source:ListedSource;root:string;dev:bigint;files:Map<string,ListedFile>;/** Folder path -> its entries, for readdir; every listed folder has one. */entries:Map<string,{name:string;folder:boolean}[]>;}
const registered=new Map<string,Registered>();
/** The folder all listed sources live under. Not a real folder: every real file call beneath it fails at once. */
export const LISTED_PARENT=path.sep==='\\'?'\\\\?\\photo-importer-camera':'/.photo-importer-camera';
const positive=(text:string)=>BigInt('0x'+createHash('sha256').update(text).digest('hex').slice(0,15));
export const listedRoot=(id:string)=>path.join(LISTED_PARENT,createHash('sha256').update(id).digest('hex').slice(0,16));
/** Make `source` readable under its root (returned); the returned function takes it away again. One relative path
 * names one file: a later file with a name already listed (some cameras repeat one in a folder) is left out. */
export function registerListedSource(source:ListedSource):{root:string;unregister():void} {
  const root=listedRoot(source.id),files=new Map<string,ListedFile>(),entries=new Map<string,{name:string;folder:boolean}[]>();
  const add=(folder:string,name:string,isFolder:boolean)=>{const list=entries.get(folder)??[];if(!list.some(item=>item.name===name)){list.push({name,folder:isFolder});entries.set(folder,list);}};
  entries.set(root,[]);
  for(const file of source.files) {
    const parts=file.relative.split('/').filter(part=>part&&part!=='.'&&part!=='..');
    if(!parts.length||parts.length!==file.relative.split('/').length) continue;
    const full=path.join(root,...parts);
    if(files.has(full)||entries.has(full)) continue;
    let folder=root;
    for(const part of parts.slice(0,-1)) {const next=path.join(folder,part);if(files.has(next))break;add(folder,part,true);if(!entries.has(next))entries.set(next,[]);folder=next;}
    if(folder!==path.dirname(full)) continue;
    add(folder,parts.at(-1)!,false);files.set(full,file);
  }
  const record:Registered={source,root,dev:positive('device:'+source.id),files,entries};
  registered.set(root,record);
  return {root,unregister:()=>{if(registered.get(root)===record)registered.delete(root);}};
}
/** The listed source `file` is in (or is the root of), if any. */
function owner(file:string):Registered|undefined {
  if(!file.startsWith(LISTED_PARENT)) return undefined;
  const resolved=path.normalize(file);
  for(const [root,record] of registered) if(resolved===root||resolved.startsWith(root+path.sep)) return record;
  return undefined;
}
export const isListedPath=(file:string)=>file.startsWith(LISTED_PARENT);
const missing=(file:string,syscall:string)=>Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${file}'`),{code:'ENOENT',errno:-2,syscall,path:file});
const readOnly=(file:string,syscall:string)=>Object.assign(new Error(`EROFS: read-only file system, ${syscall} '${file}'`),{code:'EROFS',errno:-30,syscall,path:file});
/** Stats of a listed file or folder: its listed size and dates. ctime equals mtime, so nothing treats them as provable
 * (destination-index), and the inode is a hash of the path, the same in every session. */
function stats(record:Registered,file:string,bigint:boolean):Stats|BigIntStats|undefined {
  const listed=record.files.get(file),folder=!listed&&record.entries.has(file);
  if(!listed&&!folder) return undefined;
  const modified=Math.max(0,Math.floor(listed?.modifiedMs??0)),born=Math.max(0,Math.floor(listed?.createdMs??modified)),size=listed?.size??0;
  const mode=listed?constants.S_IFREG|0o444:constants.S_IFDIR|0o555,ino=positive('file:'+path.relative(record.root,file));
  const kind={isFile:()=>!!listed,isDirectory:()=>folder,isSymbolicLink:()=>false,isBlockDevice:()=>false,isCharacterDevice:()=>false,isFIFO:()=>false,isSocket:()=>false};
  const dates={atime:new Date(modified),mtime:new Date(modified),ctime:new Date(modified),birthtime:new Date(born)};
  if(bigint) {
    const ns=(ms:number)=>BigInt(ms)*1_000_000n;
    return {...kind,...dates,dev:record.dev,ino,mode:BigInt(mode),nlink:1n,uid:0n,gid:0n,rdev:0n,size:BigInt(size),blksize:4096n,blocks:BigInt(Math.ceil(size/512)),atimeMs:BigInt(modified),mtimeMs:BigInt(modified),ctimeMs:BigInt(modified),birthtimeMs:BigInt(born),atimeNs:ns(modified),mtimeNs:ns(modified),ctimeNs:ns(modified),birthtimeNs:ns(born)} as unknown as BigIntStats;
  }
  return {...kind,...dates,dev:Number(record.dev),ino:Number(ino),mode,nlink:1,uid:0,gid:0,rdev:0,size,blksize:4096,blocks:Math.ceil(size/512),atimeMs:modified,mtimeMs:modified,ctimeMs:modified,birthtimeMs:born} as unknown as Stats;
}
/** Size of one read asked of the device: a USB camera answers 16 MB ranges at its full speed (150 MB/s on a Nikon Z f). */
export const LISTED_BLOCK=16*1024*1024;
/** A read-only handle on a listed file, enough of FileHandle for the core's readers (stat, read, close). Reads in order
 * keep the next range requested while this one is consumed, so the device reads while the last range is still on its
 * way and being hashed (119 against 93 MB/s with one request at a time). A range that reaches the listed end asks one
 * byte more: a file that grew since it was listed is a changed file, as one that shrank is. */
class ListedHandle {
  readonly fd=-1;
  private position=0;private closed=false;
  private current?:{offset:number;data:Buffer};private queued:{offset:number;data:Promise<Buffer>}[]=[];
  constructor(private readonly record:Registered,private readonly file:string,private readonly listed:ListedFile) {}
  stat(options?:{bigint?:boolean}) {return Promise.resolve(stats(this.record,this.file,options?.bigint===true)!);}
  private request(offset:number,length:number):{offset:number;data:Promise<Buffer>} {
    const end=offset+length>=this.listed.size,asked=end?this.listed.size-offset+1:length;
    const data=this.record.source.read(this.listed,offset,asked).then(data=>{
      if(end&&data.length>this.listed.size-offset) throw Object.assign(new Error(`File changed while reading; scan again: ${this.file}`),{changedWhileReading:true});
      return data;
    });
    data.catch(()=>{});
    return {offset,data};
  }
  async read(buffer:Buffer,offset=0,length=buffer.length-offset,position:number|bigint|null=null):Promise<{bytesRead:number;buffer:Buffer}> {
    if(this.closed) throw Object.assign(new Error('EBADF: file closed'),{code:'EBADF'});
    const sequential=position===null||position===undefined,at=sequential?this.position:Number(position);
    const want=Math.max(0,Math.min(length,this.listed.size-at));
    if(!want) return {bytesRead:0,buffer};
    if(!this.current||at<this.current.offset||at>=this.current.offset+this.current.data.length) {
      this.current=undefined;
      while(this.queued.length&&this.queued[0]!.offset!==at) this.queued.shift();
      // In order: whole blocks, with the following one asked for at once; elsewhere just the range wanted.
      const block=this.queued.shift()??this.request(at,sequential?Math.min(LISTED_BLOCK,this.listed.size-at):Math.min(want,LISTED_BLOCK));
      if(sequential&&!this.queued.length){const next=at+LISTED_BLOCK;if(next<this.listed.size)this.queued.push(this.request(next,Math.min(LISTED_BLOCK,this.listed.size-next)));}
      const data=await block.data;
      if(!data.length) return {bytesRead:0,buffer};
      this.current={offset:at,data};
    }
    const from=at-this.current.offset,bytesRead=Math.min(want,this.current.data.length-from);
    this.current.data.copy(buffer,offset,from,from+bytesRead);
    if(sequential) this.position=at+bytesRead;
    return {bytesRead,buffer};
  }
  async close():Promise<void> {
    if(this.closed) return;
    this.closed=true;this.current=undefined;
    const pending=this.queued.map(item=>item.data);this.queued=[];
    await Promise.allSettled(pending);
    this.record.source.release?.(this.listed);
  }
}
/** `fs` with listed sources readable through it (see above); a Proxy, so every other call, and a test's mock of one,
 * reaches the real module at call time. */
export function sourceAware(fs:typeof NodeFs):typeof NodeFs {
  const overrides:Partial<Record<keyof typeof NodeFs,unknown>>={
    async lstat(file:string,options?:{bigint?:boolean}) {const record=owner(String(file));if(!record&&!isListedPath(String(file))) return fs.lstat(file,options as never);const found=record&&stats(record,path.normalize(String(file)),options?.bigint===true);if(!found) throw missing(String(file),'lstat');return found;},
    async stat(file:string,options?:{bigint?:boolean}) {const record=owner(String(file));if(!record&&!isListedPath(String(file))) return fs.stat(file,options as never);const found=record&&stats(record,path.normalize(String(file)),options?.bigint===true);if(!found) throw missing(String(file),'stat');return found;},
    async realpath(file:string,options?:unknown) {const record=owner(String(file));if(!record&&!isListedPath(String(file))) return fs.realpath(file,options as never);const resolved=path.normalize(String(file));if(!record||!stats(record,resolved,false)) throw missing(String(file),'realpath');return resolved;},
    async readdir(folder:string,options?:{withFileTypes?:boolean}) {
      const record=owner(String(folder));if(!record&&!isListedPath(String(folder))) return fs.readdir(folder,options as never);
      const list=record?.entries.get(path.normalize(String(folder)));if(!list) throw missing(String(folder),'scandir');
      const parent=path.normalize(String(folder));
      return options?.withFileTypes?list.map(item=>({name:item.name,parentPath:parent,path:parent,isFile:()=>!item.folder,isDirectory:()=>item.folder,isSymbolicLink:()=>false,isBlockDevice:()=>false,isCharacterDevice:()=>false,isFIFO:()=>false,isSocket:()=>false})):list.map(item=>item.name);
    },
    async open(file:string,flags?:string|number,mode?:number) {
      const record=owner(String(file));if(!record&&!isListedPath(String(file))) return fs.open(file,flags as never,mode);
      const reading=flags===undefined||flags==='r'||(typeof flags==='number'&&(flags&(constants.O_WRONLY|constants.O_RDWR|constants.O_CREAT|constants.O_TRUNC|constants.O_APPEND))===0);
      if(!reading) throw readOnly(String(file),'open');
      const resolved=path.normalize(String(file)),listed=record?.files.get(resolved);
      if(!record||!listed) throw missing(String(file),'open');
      return new ListedHandle(record,resolved,listed);
    },
    async access(file:string,mode?:number) {const record=owner(String(file));if(!record&&!isListedPath(String(file))) return fs.access(file,mode);if(mode!==undefined&&(mode&constants.W_OK)) throw readOnly(String(file),'access');if(!record||!stats(record,path.normalize(String(file)),false)) throw missing(String(file),'access');},
  };
  return new Proxy(fs,{get:(target,key)=>key in overrides?overrides[key as keyof typeof NodeFs]:Reflect.get(target,key)});
}
/** A listed file's reader, for code that reads ranges itself (metadata from the first bytes). */
export async function readListed(file:string,offset:number,length:number):Promise<Buffer> {
  const record=owner(file),listed=record?.files.get(path.normalize(file));
  if(!record||!listed) throw missing(file,'read');
  const parts:Buffer[]=[];let at=offset,left=Math.max(0,Math.min(length,listed.size-offset));
  try {
    while(left>0){const data=await record.source.read(listed,at,Math.min(left,LISTED_BLOCK));if(!data.length)break;parts.push(data.subarray(0,left));at+=data.length;left-=data.length;}
  } finally { record.source.release?.(listed); }
  return Buffer.concat(parts);
}
/** The listed entry for `file` (size, dates), or undefined for anything else. */
export function listedFile(file:string):ListedFile|undefined {return owner(file)?.files.get(path.normalize(file));}
