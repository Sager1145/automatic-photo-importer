import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

export interface ExportResult {path:string;kind:'zip'|'folder';files:number;bytes:number;}

const CRC=(()=>{const table=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0;}return table;})();
function crc32(data:Buffer):number{let c=0xffffffff;for(let i=0;i<data.length;i++)c=CRC[(c^data[i]!)&0xff]!^(c>>>8);return (c^0xffffffff)>>>0;}
const dosTime=(date:Date)=>({time:(date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>1),date:((Math.max(1980,date.getFullYear())-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate()});

/** A zip archive of the given files, built without any dependency (deflate, one file in memory at a time, no zip64). */
export async function writeZip(destination:string,files:{name:string;file:string}[]):Promise<number>{
 const handle=await fs.open(destination,'w',0o600);const central:Buffer[]=[];let offset=0;
 try{
  for(const item of files){
   const data=await fs.readFile(item.file),info=await fs.stat(item.file),packed=zlib.deflateRawSync(data),name=Buffer.from(item.name,'utf8'),{time,date}=dosTime(info.mtime),crc=crc32(data);
   if(data.length>0xffffffff-1||offset>0xffffffff-1)throw new Error('The logs are too large for a zip file.');
   const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x0800,6);local.writeUInt16LE(8,8);local.writeUInt16LE(time,10);local.writeUInt16LE(date,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
   await handle.write(Buffer.concat([local,name,packed]));
   const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50,0);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x0800,8);entry.writeUInt16LE(8,10);entry.writeUInt16LE(time,12);entry.writeUInt16LE(date,14);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(packed.length,20);entry.writeUInt32LE(data.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);
   central.push(Buffer.concat([entry,name]));offset+=30+name.length+packed.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  await handle.write(Buffer.concat([directory,end]));await handle.sync();
  return offset+directory.length+end.length;
 }finally{await handle.close();}
}

/** Export the log folder to `destination` (a .zip path). When the archive cannot be written, the folder is copied beside it instead. */
export async function exportLogs(directory:string,destination:string,options:{zip?:typeof writeZip}={}):Promise<ExportResult>{
 const names=(await fs.readdir(directory)).filter(name=>name.endsWith('.jsonl')).sort(),files=names.map(name=>({name,file:path.join(directory,name)}));
 try{
  const bytes=await (options.zip??writeZip)(destination,files);
  return {path:destination,kind:'zip',files:files.length,bytes};
 }catch{
  await fs.rm(destination,{force:true}).catch(()=>{});
  const target=destination.replace(/\.zip$/i,'')||destination+'-logs';await fs.mkdir(target,{recursive:true});let bytes=0;
  for(const item of files){await fs.copyFile(item.file,path.join(target,item.name));bytes+=(await fs.stat(item.file)).size;}
  return {path:target,kind:'folder',files:files.length,bytes};
 }
}
