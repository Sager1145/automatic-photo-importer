/** Shared synthetic-fixture helpers for the edge-case and stress suites. Every fixture lives in
 * its own temporary folder; nothing here ever touches a real card or drive. */
import type test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {execute} from '../../core/index';
import type {TransferPlan} from '../../shared';

export const run=promisify(execFile);
export const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export const fileSha=async(file:string)=>sha(await fs.readFile(file));

/** Disk images attached inside each temporary folder, detached by device before it is removed (a
 * volume a test unmounted with umount stays attached, so its mount path cannot detach it). */
const mounts=new Map<string,string[]>();
/** A private temporary folder, removed after the test (read-only folders made writable first). */
export async function temporary(t:test.TestContext,prefix:string):Promise<string> {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),prefix)));
 t.after(async()=>{
  for(const mount of mounts.get(root)??[])await run('hdiutil',['detach','-quiet','-force',mount]).catch(()=>{});
  mounts.delete(root);
  await run('chmod',['-R','u+rwx',root]).catch(()=>{});await fs.rm(root,{recursive:true,force:true});
 });
 return root;
}
export async function put(file:string,content:Buffer|string):Promise<void> {
 await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content);
}
/** Every regular file under `root` (relative path → SHA-256), without the app's own bookkeeping or
 * macOS AppleDouble (._) service files, which exFAT volumes gain. */
export async function tree(root:string):Promise<Map<string,string>> {
 const found=new Map<string,string>();
 for(const entry of await fs.readdir(root,{withFileTypes:true,recursive:true})){
  const file=path.join(entry.parentPath,entry.name),relative=path.relative(root,file);
  if(!entry.isFile()||entry.name.startsWith('._')||relative.split(path.sep).some(part=>part.startsWith('.photo-importer-')||/^photo-importer-(?:index|drive)/.test(part)||part==='Photo Importer Recovery'||part==='Photo Importer Data'))continue;
  found.set(relative,await fileSha(file));
 }
 return found;
}
/** Every extension media-formats.ts lists, read from its source so tests follow the list. */
export async function listedExtensions():Promise<string[]> {
 const source=await fs.readFile(fileURLToPath(new URL('../../media-formats.ts',import.meta.url)),'utf8');
 const block=source.slice(source.indexOf('Object.entries({'),source.indexOf('})) {'));
 return [...block.matchAll(/^\s*\w+: '([a-z0-9 ]+)',?$/gm)].flatMap(match=>match[1]!.split(' '));
}
export const parts=(transfer:TransferPlan)=>[transfer,...(transfer.videos?[transfer.videos]:[])];
/** Execute both parts of a plan (photos and, in video-root, videos) and return the summed result. */
export async function executeAll(transfer:TransferPlan,options:Parameters<typeof execute>[3]={}){
 const total={copied:0,skipped:0,errors:[] as string[]};
 for(const part of parts(transfer)){const result=await execute(part,undefined,undefined,options);total.copied+=result.copied;total.skipped+=result.skipped;total.errors.push(...result.errors);}
 return total;
}
/** Every planned entry holds its source's exact bytes at its destination. */
export async function assertCopied(transfer:TransferPlan):Promise<void> {
 for(const part of parts(transfer))for(const entry of part.entries)assert.equal(await fileSha(entry.destination),await fileSha(entry.source),`${entry.source} → ${entry.destination}`);
}
/** Staging files or stage records left in a destination. */
export async function leftovers(root:string):Promise<string[]> {
 const found:string[]=[];
 for(const entry of await fs.readdir(root,{withFileTypes:true,recursive:true}))if(/^photo-importer-(?!index)/.test(entry.name))found.push(path.join(entry.parentPath,entry.name));
 return found;
}
/** A disk image mounted privately inside `base`, a folder from temporary() (macOS only); it is
 * detached when that folder is removed. */
export async function diskImage(base:string,size:string,fsType:'ExFAT'|'APFS'|'HFS+',name:string,options:{readOnly?:boolean}={}):Promise<string|undefined> {
 if(process.platform!=='darwin')return undefined;
 const image=path.join(base,`${name}.dmg`),mount=path.join(base,name);let device:string|undefined;
 await fs.mkdir(mount);
 try{
  await run('hdiutil',['create','-quiet','-size',size,'-fs',fsType,'-volname',name,image]);
  const {stdout}=await run('hdiutil',['attach','-nobrowse',...(options.readOnly?['-readonly']:[]),'-mountpoint',mount,image]);
  device=stdout.match(/^\/dev\/disk\d+/m)?.[0];
 }catch{return undefined;}
 mounts.set(base,[...(mounts.get(base)??[]),device??mount]);
 return fs.realpath(mount);
}
