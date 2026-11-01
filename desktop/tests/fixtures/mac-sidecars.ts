// What macOS does on a volume without extended attributes (exFAT, FAT, SMB), on any system: every file or folder
// created, linked or renamed gets a "._<name>" AppleDouble file beside it holding only bookkeeping (the kernel's
// com.apple.provenance), and a rename takes the one already there along. Tests use it to check the app removes them.
import type { TestContext } from 'node:test';
import fsDefault from 'node:fs/promises';
import { constants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

/** A "._" file as macOS writes it for a created entry: header and an empty entry table, bookkeeping only. */
export const bookkeepingSidecar=()=>{const b=Buffer.alloc(4096);b.writeUInt32BE(0x00051607,0);b.writeUInt32BE(0x00020000,4);return b;};
/** Finder info with a colour label: real user data that must stay. */
export const labelledSidecar=()=>{const b=Buffer.alloc(4096);b.writeUInt32BE(0x00051607,0);b.writeUInt32BE(0x00020000,4);b.writeUInt16BE(1,24);b.writeUInt32BE(9,26);b.writeUInt32BE(50,30);b.writeUInt32BE(32,34);b[50+9]=0x0c;return b;};

/** Every "._" file under `folder`, relative with "/", sorted. */
export async function sidecarsUnder(folder:string):Promise<string[]> {
  const entries=await fsDefault.readdir(folder,{recursive:true,withFileTypes:true});
  return entries.filter(entry=>entry.name.startsWith('._')).map(entry=>path.relative(folder,path.join(entry.parentPath,entry.name)).split(path.sep).join('/')).sort();
}

/** Until the test ends, entries made under `area` get the "._" files macOS would make there. */
export function simulateMacSidecars(t:TestContext,area:string):void {
  const original={mkdir:fsDefault.mkdir.bind(fsDefault),open:fsDefault.open.bind(fsDefault),rename:fsDefault.rename.bind(fsDefault),link:fsDefault.link.bind(fsDefault),lstat:fsDefault.lstat.bind(fsDefault),writeFile:fsDefault.writeFile.bind(fsDefault)};
  const sidecar=(entry:string)=>path.join(path.dirname(entry),'._'+path.basename(entry));
  const ours=(entry:unknown)=>{const file=path.resolve(String(entry)),relative=path.relative(area,file);return !relative.startsWith('..')&&!path.isAbsolute(relative)&&relative!==''&&!path.basename(file).startsWith('._');};
  const make=async(entry:unknown)=>{if(ours(entry))await original.writeFile(sidecar(path.resolve(String(entry))),bookkeepingSidecar(),{flag:'wx'}).catch(()=>{});};
  const creates=(flags:unknown)=>typeof flags==='string'?/[wax]/.test(flags):typeof flags==='number'&&(flags&constants.O_CREAT)!==0;
  const mock=(name:string,fn:(...args:any[])=>Promise<unknown>)=>t.mock.method(fsDefault,name as any,fn as any);
  mock('mkdir',async(...args:any[])=>{const made=await original.mkdir(...(args as [string]));if(!args[1]?.recursive)await make(args[0]);return made;});
  mock('open',async(...args:any[])=>{const handle=await original.open(...(args as [string]));if(creates(args[1]))await make(args[0]);return handle;});
  mock('link',async(...args:any[])=>{await original.link(...(args as [string,string]));await make(args[1]);});
  mock('rename',async(...args:any[])=>{
    await original.rename(...(args as [string,string]));
    if(!ours(args[1]))return;
    const from=sidecar(path.resolve(String(args[0])));
    if(ours(args[0])&&await original.lstat(from).then(()=>true,()=>false))await original.rename(from,sidecar(path.resolve(String(args[1])))).catch(()=>{});
    else await make(args[1]);
  });
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
}
