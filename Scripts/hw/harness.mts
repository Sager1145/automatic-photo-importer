/**
 * Harness for the real-hardware exFAT end-to-end test (macOS). Entry point: Scripts/hw/run.mts.
 *
 * SAFETY (absolute): ONE sandbox folder per volume, `/Volumes/<NAME>/photo-importer-hw-test-<ISO>` (mkdir fails if it
 * exists). Every write/rename/remove a group performs itself goes through `guard()`, which throws for any path that is
 * not strictly inside a sandbox (realpath-checked). Core APIs are only ever given sandbox paths. The volume's existing
 * files and folders are never listed for deletion or touched. At the end (also on failure) only the exact sandbox paths
 * are removed, after re-checking they match the sandbox name pattern, unless --keep is given (names stored
 * precomposed (NFC) are removed through unlinkEntry/rmdirEntry, because plain unlink/rmdir fail on the NFD form
 * readdir returns; macOS's `._<sandbox name>` file beside the sandbox goes too). App data (recovery host key, HOME)
 * goes to a fresh folder in os.tmpdir(). An outside-sandbox witness (volume root + `Photo Importer Data` snapshot,
 * plus any files registered with witnessFiles) must be identical before and after.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {unlinkEntry,rmdirEntry} from '../../desktop/core/paths.ts';

export type Metadata=import('../../desktop/shared.ts').Metadata;

// ---- arguments -----------------------------------------------------------------------------------------------
export type Options={source:string;library:string;keep:boolean;files:number;hostKey?:string;only?:string[]};
export const VOLUME=/^\/Volumes\/[^/]+$/;
export const SANDBOX_NAME=/^photo-importer-hw-test-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/;
const USAGE='Usage: node --import tsx Scripts/hw/run.mts --source=/Volumes/<NAME> --library=/Volumes/<NAME> [--keep] [--files=N] [--host-key=<path>] [--only=<group,...>]';

export function parseArgs(argv:string[]):Options{
 const args=new Map<string,string>();
 for(const arg of argv){const m=/^--([a-z-]+)(?:=(.*))?$/.exec(arg);if(!m||!['source','library','keep','files','host-key','only'].includes(m[1]!)){console.error('Unknown argument: '+arg);process.exit(2);}args.set(m[1]!,m[2]??'true');}
 const source=args.get('source'),library=args.get('library');
 if(!source||!library||!VOLUME.test(source)||!VOLUME.test(library)){console.error(USAGE);process.exit(2);}
 if(process.platform!=='darwin'){console.error('macOS only');process.exit(2);}
 const only=args.get('only');
 return {source,library,keep:args.has('keep'),files:Math.max(12,Number(args.get('files')??60)|0),hostKey:args.get('host-key'),only:only?only.split(',').map(s=>s.trim().replace(/\.mts$/,'')).filter(Boolean):undefined};
}

// ---- sandboxes + guarded fs ----------------------------------------------------------------------------------
const sandboxes:string[]=[];           // real paths of the sandboxes this run created
let keepSandboxes=false;
export const inside=(parent:string,child:string)=>{const r=path.relative(parent,child);return r!==''&&!r.startsWith('..')&&!path.isAbsolute(r);};
/** Throws unless `target` is strictly inside a sandbox (also after resolving the deepest existing ancestor's symlinks). */
export async function guard(target:string):Promise<string>{
 if(!path.isAbsolute(target))throw new Error('Guard: not absolute: '+target);
 const resolved=path.resolve(target);
 const box=sandboxes.find(s=>inside(s,resolved));
 if(!box)throw new Error('Guard: outside every sandbox: '+target);
 let existing=resolved;
 for(;;){
  try{const real=await fs.realpath(existing);if(real!==box&&!inside(box,real))throw new Error('Guard: symlink escape: '+target);break;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;existing=path.dirname(existing);if(!inside(box,existing)&&existing!==box)throw new Error('Guard: no ancestor in sandbox: '+target);}
 }
 return resolved;
}
export const gMkdir=async(p:string)=>fs.mkdir(await guard(p),{recursive:true});
export const gWrite=async(p:string,data:Buffer|string)=>{const t=await guard(p);await fs.mkdir(path.dirname(t),{recursive:true});await fs.writeFile(t,data);};
export const gRm=async(p:string)=>fs.rm(await guard(p),{force:true});
export const gUtimes=async(p:string,time:Date)=>fs.utimes(await guard(p),time,time);
/** Both ends must be inside a sandbox. */
export const gRename=async(from:string,to:string)=>{const a=await guard(from),b=await guard(to);await fs.mkdir(path.dirname(b),{recursive:true});await fs.rename(a,b);};
/** Source may be anywhere readable (read-only); the destination must be inside a sandbox. */
export const gCopy=async(from:string,to:string)=>{const b=await guard(to);await fs.mkdir(path.dirname(b),{recursive:true});await fs.copyFile(from,b);};
export const newDir=async(box:string,name:string)=>{const dir=path.join(box,name);await gMkdir(dir);return dir;};

async function createSandbox(volume:string):Promise<string>{
 const real=await fs.realpath(volume);
 if(real!==volume)throw new Error(`${volume} is not a plain mount point (resolves to ${real})`);
 const stat=await fs.lstat(volume),boot=await fs.stat('/');
 if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error(volume+' is not a directory');
 if(stat.dev===boot.dev)throw new Error(volume+' is on the boot volume');
 const name='photo-importer-hw-test-'+new Date().toISOString().replace(/[:.]/g,'-');
 if(!SANDBOX_NAME.test(name))throw new Error('bad sandbox name');
 const sandbox=path.join(volume,name);
 await fs.mkdir(sandbox);                       // not recursive: fails if it exists
 const resolved=await fs.realpath(sandbox);
 if(resolved!==sandbox)throw new Error('sandbox resolved elsewhere: '+resolved);
 sandboxes.push(sandbox);
 return sandbox;
}
/** Empties `dir` (never following links) through unlinkEntry/rmdirEntry, which also reach precomposed (NFC) names; `dir` itself stays. Only strictly inside a sandbox. */
export async function removeTree(dir:string):Promise<void>{
 if(!sandboxes.some(box=>inside(box,dir)||box===dir))throw new Error('refusing to remove outside a sandbox: '+dir);
 for(const entry of await fs.readdir(dir,{withFileTypes:true})){
  const child=path.join(dir,entry.name);
  // macOS removes a `._` partner itself when its main file goes, so an entry listed a moment ago may already be gone.
  const gone=(error:unknown)=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;};
  if(entry.isDirectory()){await removeTree(child);await rmdirEntry(child).catch(gone);}else await unlinkEntry(child).catch(gone);
 }
}
/** Removes the exact sandbox paths (unless --keep). Returns false when a cleanup failed. */
export async function removeSandboxes():Promise<boolean>{
 let ok=true;
 for(const sandbox of sandboxes){
  try{
   if(!VOLUME.test(path.dirname(sandbox))||!SANDBOX_NAME.test(path.basename(sandbox)))throw new Error('refusing, not a sandbox path: '+sandbox);
   if(await fs.realpath(sandbox)!==sandbox)throw new Error('refusing, sandbox path changed: '+sandbox);
   if(keepSandboxes){console.log('KEPT   '+sandbox);continue;}
   await removeTree(sandbox);await rmdirEntry(sandbox);
   // macOS writes `._<name>` beside a folder it made on exFAT; only that exact name next to the sandbox is removed.
   const sidecar=path.join(path.dirname(sandbox),'._'+path.basename(sandbox));
   if(path.basename(sidecar)==='._'+path.basename(sandbox)&&path.dirname(sidecar)===path.dirname(sandbox)&&(await fs.lstat(sidecar).catch(()=>undefined))?.isFile())await unlinkEntry(sidecar);
   console.log('REMOVED '+sandbox);
  }catch(error){console.error('CLEANUP FAILED for '+sandbox+': '+String(error));process.exitCode=1;ok=false;}
 }
 return ok;
}

// ---- helpers -------------------------------------------------------------------------------------------------
export const sha=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
export const fileSha=async(p:string)=>sha(await fs.readFile(p));
export const exists=(p:string)=>fs.lstat(p).then(()=>true,()=>false);
/** Every regular file under `dir` as relative path -> hash, without the app's own records and "._" files. */
export const treeOf=async(dir:string)=>{
 const found=new Map<string,string>();
 for(const entry of await fs.readdir(dir,{withFileTypes:true,recursive:true})){
  const file=path.join(entry.parentPath,entry.name),rel=path.relative(dir,file);
  if(!entry.isFile()||entry.name.startsWith('._')||rel.split(path.sep).some(part=>part==='Photo Importer Data'||part.startsWith('photo-importer-')||part.startsWith('.photo-importer-')))continue;
  found.set(rel,await fileSha(file));
 }
 return found;
};
export const multiset=(m:Map<string,string>)=>[...m.values()].sort();
export const same=(a:string[],b:string[])=>a.length===b.length&&a.every((x,i)=>x===b[i]);
export const sameTree=(a:Map<string,string>,b:Map<string,string>)=>a.size===b.size&&[...a].every(([k,v])=>b.get(k)===v);

/** Metadata table: distinct capture dates and cameras per stem (case-insensitive), so no real camera files are needed. One per group. */
export function createMetadata(){
 const cameras=['Nikon Z f','Sony A7 IV','Canon EOS R5','DJI Mavic 3'];
 const table=new Map<string,{camera:string;date:string}>();
 const stemOf=(file:string)=>path.basename(file).replace(/\.[^.]*$/,'').toLowerCase();
 const metadata=async(file:string):Promise<Metadata>=>{
  const found=table.get(stemOf(file))??{camera:'Nikon Z f',date:'2024-01-01T00:00:00'};
  return {camera:found.camera,date:found.date,fields:{}};
 };
 const describe=(stem:string,i:number)=>{table.set(stem.toLowerCase(),{camera:cameras[i%cameras.length]!,date:new Date(Date.UTC(2022+(i%3),(i*5)%12,1+(i*7)%27,(i*3)%24,i%60,i%60)).toISOString().slice(0,19)});};
 return {cameras,table,metadata,describe};
}

// ---- outside-the-sandbox witness ------------------------------------------------------------------------------
/** What must not change: the volume root's entries and everything in its records folder (name, kind, size, mtime, inode).
 * Taken before the run and compared after cleanup; any difference fails the run. */
async function outsideSnapshot(volume:string):Promise<Map<string,string>>{
 const out=new Map<string,string>(),volatile=new Set(['.fseventsd','.Spotlight-V100','.Trashes','$RECYCLE.BIN','System Volume Information']);
 // exFAT names an empty file by a temporary negative inode that macOS reassigns on its own (measured), so such an entry is
 // identified by its birth time instead, as the app's own identity rule does; every other entry keeps its exact inode.
 const record=async(file:string)=>{const s=await fs.lstat(file,{bigint:true});out.set(path.relative(volume,file),`${s.isDirectory()?'d':s.isSymbolicLink()?'l':'f'}:${s.size}:${s.mtimeNs}:${s.ino<0n?'birth '+s.birthtimeNs:s.ino}`);return s;};
 for(const name of await fs.readdir(volume)){if(volatile.has(name)||SANDBOX_NAME.test(name))continue;await record(path.join(volume,name));}
 const walk=async(dir:string):Promise<void>=>{for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);await record(file);if(entry.isDirectory())await walk(file);}};
 const records=path.join(volume,'Photo Importer Data');if(await fs.lstat(records).then(s=>s.isDirectory()&&!s.isSymbolicLink(),()=>false))await walk(records);
 return out;
}
function compareOutside(volume:string,before:Map<string,string>,after:Map<string,string>):boolean{
 const changed=[...new Set([...before.keys(),...after.keys()])].filter(key=>before.get(key)!==after.get(key));
 if(changed.length)console.error(`OUTSIDE-SANDBOX CHANGES on ${volume}:\n`+changed.map(key=>`  ${key}: ${before.get(key)??'(absent)'} -> ${after.get(key)??'(absent)'}`).join('\n'));
 else console.log(`UNTOUCHED ${volume}: ${before.size} entries outside the sandbox are identical before and after`);
 return changed.length===0;
}
const fileWitnesses=new Map<string,string>();
const fingerprint=async(p:string)=>{const s=await fs.lstat(p,{bigint:true});if(!s.isFile())throw new Error('witnessFiles: not a regular file: '+p);return `${s.size}:${s.mtimeNs}:${s.ino}:${await fileSha(p)}`;};
/** Records sha256+size+mtimeNs+ino of specific files OUTSIDE the sandboxes (read-only user files); compared after cleanup. Call BEFORE reading/using them. */
export async function witnessFiles(paths:string[]):Promise<void>{
 for(const raw of paths){
  if(!path.isAbsolute(raw))throw new Error('witnessFiles: not absolute: '+raw);
  const p=path.resolve(raw);
  if(sandboxes.some(box=>box===p||inside(box,p)))throw new Error('witnessFiles: path is inside a sandbox: '+p);
  if(!fileWitnesses.has(p))fileWitnesses.set(p,await fingerprint(p));
 }
}
async function compareFileWitnesses():Promise<boolean>{
 let ok=true;
 for(const [p,before] of fileWitnesses){
  const after=await fingerprint(p).catch(error=>'(unreadable: '+String(error)+')');
  if(after!==before){ok=false;console.error(`WITNESSED FILE CHANGED: ${p}: ${before} -> ${after}`);}
 }
 if(ok&&fileWitnesses.size)console.log(`UNTOUCHED ${fileWitnesses.size} witnessed file(s) (sha256, size, mtime, inode identical)`);
 return ok;
}

// ---- context -------------------------------------------------------------------------------------------------
export type GroupStats={name:string;title:string;pass:number;fail:number;skip:number;timings:[string,number][]};
const modules=async()=>({
 core:await import('../../desktop/core/index.ts'),
 recovery:await import('../../desktop/core/recovery.ts'),
 duplicates:await import('../../desktop/core/duplicates.ts'),
 removal:await import('../../desktop/core/duplicate-removal.ts'),
 rules:await import('../../desktop/duplicate-rules.ts'),
 destIndex:await import('../../desktop/core/destination-index.ts'),
 paths:await import('../../desktop/core/paths.ts'),
});
export type Context={
 // desktop/core modules
 core:Awaited<ReturnType<typeof modules>>['core'];
 recovery:Awaited<ReturnType<typeof modules>>['recovery'];
 duplicates:Awaited<ReturnType<typeof modules>>['duplicates'];
 removal:Awaited<ReturnType<typeof modules>>['removal'];
 rules:Awaited<ReturnType<typeof modules>>['rules'];
 destIndex:Awaited<ReturnType<typeof modules>>['destIndex'];
 paths:Awaited<ReturnType<typeof modules>>['paths'];
 /** This group's folder inside the source / library sandbox (already created; the same folder when both volumes are the same). */
 sourceBox:string;libraryBox:string;
 /** The volume mount points (/Volumes/<NAME>). Never write to them directly. */
 sourceVolume:string;libraryVolume:string;
 /** --files (at least 12). */
 files:number;
 // reporting
 check:(name:string,ok:boolean,detail?:unknown)=>void;
 scenario:(name:string,work:()=>Promise<void>)=>Promise<void>;
 skip:(name:string,reason:string)=>void;
 // guarded fs (every path must be strictly inside a sandbox)
 guard:typeof guard;gMkdir:typeof gMkdir;gWrite:typeof gWrite;gRm:typeof gRm;gUtimes:typeof gUtimes;gRename:typeof gRename;gCopy:typeof gCopy;
 newDir:typeof newDir;
 // helpers
 sha:typeof sha;fileSha:typeof fileSha;exists:typeof exists;treeOf:typeof treeOf;multiset:typeof multiset;same:typeof same;sameTree:typeof sameTree;
 // synthetic metadata (per group): `metadata` is the callback for core.plan; `describe(stem,i)` registers a stem
 cameras:string[];table:Map<string,{camera:string;date:string}>;metadata:(file:string)=>Promise<Metadata>;describe:(stem:string,i:number)=>void;
 // read-only user files outside the sandbox: record fingerprints now, compared after cleanup
 witnessFiles:typeof witnessFiles;
 /** true when --host-key supplied this Mac's recovery key (else a throwaway key is configured). */
 hostKeyUsed:boolean;
};

// ---- harness lifecycle ---------------------------------------------------------------------------------------
export type Harness={
 /** Creates the Context for one group (its own sub-folder in each sandbox) and its stats. */
 group(name:string,title:string):Promise<{ctx:Context;stats:GroupStats}>;
 /** Cleanup + outside-sandbox witness. Returns the number of harness-level failures (changed witness, failed cleanup). */
 finish():Promise<number>;
};

export async function createHarness(options:Options):Promise<Harness>{
 keepSandboxes=options.keep;
 const appData=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'photo-importer-hw-appdata-')));
 process.env.HOME=path.join(appData,'home');await fs.mkdir(process.env.HOME);
 process.on('SIGINT',()=>{removeSandboxes().finally(()=>process.exit(130));});
 const witnessed=new Map<string,Map<string,string>>();
 for(const volume of new Set([options.source,options.library]))witnessed.set(volume,await outsideSnapshot(volume));
 const finish=async()=>{
  let failures=0;
  console.log('\n== cleanup');
  if(!await removeSandboxes())failures++;
  await fs.rm(appData,{recursive:true,force:true}).catch(()=>{});
  console.log('\n== outside the sandbox');
  for(const [volume,before] of witnessed)if(!compareOutside(volume,before,await outsideSnapshot(volume)))failures++;
  if(!await compareFileWitnesses())failures++;
  return failures;
 };
 try{
  const mods=await modules();
  // A library beneath a volume whose records folder this Mac wrote (A006) can only be read with this Mac's own key; the
  // key file is read, never printed or written. Without --host-key a throwaway key is used, and such a volume refuses.
  const key=options.hostKey?await fs.readFile(options.hostKey):randomBytes(32);if(key.length!==32)throw new Error('--host-key must name a 32-byte key file');
  // Child processes (the crash worker) read the same key file; the path is passed, never the key.
  if(options.hostKey)process.env.HW_HOST_KEY_FILE=options.hostKey;
  mods.core.configureOrganizationRecovery(key);console.log('recovery key:',options.hostKey?'this Mac\'s (--host-key)':'throwaway');
  const sourceSandbox=await createSandbox(options.source);
  const librarySandbox=options.library===options.source?sourceSandbox:await createSandbox(options.library);
  console.log('sandboxes:',sandboxes.join(', '));console.log('app data :',appData);
  return {
   async group(name,title){
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))throw new Error('bad group name: '+name);
    const stats:GroupStats={name,title,pass:0,fail:0,skip:0,timings:[]};
    const sourceBox=path.join(sourceSandbox,name),libraryBox=path.join(librarySandbox,name);
    await gMkdir(sourceBox);await gMkdir(libraryBox);
    const meta=createMetadata();
    const ctx:Context={
     ...mods,sourceBox,libraryBox,sourceVolume:options.source,libraryVolume:options.library,files:options.files,
     check(n,ok,detail){if(ok)stats.pass++;else stats.fail++;console.log(`${ok?'PASS':'FAIL'}  ${n}${!ok&&detail!==undefined?'  -> '+(typeof detail==='string'?detail:JSON.stringify(detail,(_k,v)=>typeof v==='bigint'?v.toString():v)):''}`);},
     async scenario(n,work){
      console.log(`\n== ${n}`);const start=Date.now();
      try{await work();}catch(error){stats.fail++;console.log(`FAIL  ${n} threw: ${error instanceof Error?error.stack??error.message:String(error)}`);}
      stats.timings.push([n,Date.now()-start]);
     },
     skip(n,reason){stats.skip++;console.log(`SKIP  ${n}: ${reason}`);},
     guard,gMkdir,gWrite,gRm,gUtimes,gRename,gCopy,newDir,
     sha,fileSha,exists,treeOf,multiset,same,sameTree,
     ...meta,witnessFiles,hostKeyUsed:!!options.hostKey,
    };
    return {ctx,stats};
   },
   finish,
  };
 }catch(error){
  // Setup failed after the snapshots/sandboxes were taken: clean up and report, then let the caller exit non-zero.
  console.error('FATAL (setup): '+(error instanceof Error?error.stack:String(error)));
  await finish();
  process.exit(1);
 }
}
