// What the test machine's file system allows, and separator-safe path helpers, so shared tests run unchanged on macOS,
// Windows and Linux (docs/cross-platform.md, rule 7).
import fs from 'node:fs/promises';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/** A native path (`a\b` on Windows) with `/`, for comparing in-memory relative paths with literal expectations. */
export const slash=(file:string):string=>file.split(path.sep).join('/');
/** A literal `a/b/c` written with this system's separator. */
export const native=(file:string):string=>file.split('/').join(path.sep);

/** Windows refuses symbolic links (EPERM) unless Developer Mode is on or the process is elevated; probe once. */
export const fileSymlinks:boolean=(()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'symlink-probe-'));
  try {writeFileSync(path.join(dir,'target'),'');symlinkSync(path.join(dir,'target'),path.join(dir,'link'),'file');return true;}
  catch {return false;}
  finally {rmSync(dir,{recursive:true,force:true});}
})();
/** Skip reason for a test whose subject is a symbolic link to a file (or a relative link), or false when links can be made. */
export const needsFileSymlinks:string|false=fileSymlinks?false:'symbolic links to files need Developer Mode on Windows';

/** A link to a folder: a symbolic link, or on Windows without Developer Mode a junction (no privilege needed; Node and the app
 * see it as a symbolic link). A junction needs an absolute target. */
export const linkFolder=(target:string,at:string):Promise<void>=>
  process.platform==='win32'&&!fileSymlinks?fs.symlink(path.resolve(path.dirname(at),target),at,'junction'):fs.symlink(target,at,'dir');

/** Mode bits (`chmod 0o500`, `0o000`) deny access on macOS and Linux; Windows keeps only the read-only flag on files and ignores them on folders.
 * Root also ignores them. */
export const unixPermissions:boolean=process.platform!=='win32'&&process.getuid?.()!==0;
export const needsUnixPermissions:string|false=unixPermissions?false:process.platform==='win32'?'Windows ignores Unix permission bits':'root ignores permission bits';

// Taking access away. macOS and Linux use mode bits; Windows ignores those, so it gets an ACL entry denying this user
// (the denial reads as EPERM there, EACCES elsewhere). Each returns nothing; undo with the matching allow call.
const icacls=(...args:string[])=>new Promise<void>((resolve,reject)=>execFile('icacls',args,error=>error?reject(error):resolve()));
const user=()=>os.userInfo().username;
/** The file can no longer be read (chmod 0). */
export const denyRead=(file:string):Promise<void>=>process.platform==='win32'?icacls(file,'/deny',`${user()}:(R)`):fs.chmod(file,0);
export const allowRead=(file:string):Promise<void>=>process.platform==='win32'?icacls(file,'/remove:d',user()):fs.chmod(file,0o600);
/** Nothing can be added to the folder (chmod 0o555). */
export const denyWrite=(folder:string):Promise<void>=>process.platform==='win32'?icacls(folder,'/deny',`${user()}:(W,AD)`):fs.chmod(folder,0o555);
export const allowWrite=(folder:string):Promise<void>=>process.platform==='win32'?icacls(folder,'/remove:d',user()):fs.chmod(folder,0o755);
/** What a denied read or write fails with on this system. */
export const DENIED=/EACCES|EPERM|permission/i;

/** The variables the system temporary folder is read from: TMPDIR on macOS and Linux, TEMP and TMP on Windows. */
const TEMPORARY_VARIABLES=['TMPDIR','TEMP','TMP'] as const;
/** Gives this test a temporary folder of its own: `os.tmpdir()` returns it until the test ends, on every system. A check that
 * an operation leaves nothing in the temporary folder then sees only what that operation wrote, never the folders of test
 * files running at the same time (`node --test` runs files in parallel, all sharing the one system folder). */
export async function ownTemporaryFolder(t:{after:(fn:()=>Promise<void>|void)=>void}):Promise<string> {
  const saved=Object.fromEntries(TEMPORARY_VARIABLES.map(name=>[name,process.env[name]]));
  const folder=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'own-temporary-')));
  for(const name of TEMPORARY_VARIABLES)process.env[name]=folder;
  t.after(async()=>{
    for(const name of TEMPORARY_VARIABLES){const value=saved[name];if(value===undefined)delete process.env[name];else process.env[name]=value;}
    await fs.rm(folder,{recursive:true,force:true});
  });
  return folder;
}
