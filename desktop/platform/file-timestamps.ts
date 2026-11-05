import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import type {FileHandle} from 'node:fs/promises';
import type {BigIntStats} from 'node:fs';
import {nativeCameraHelperPath} from './camera-bridge';
import {log} from '../logger';

/** Only call on exclusively owned writable descriptors, before publication; `file` is the descriptor's path.
 * Created is set on each system its own way: macOS through the native helper on the descriptor, Windows with
 * SetFileTime on `file` (Node sets only Modified and Accessed there), and Linux not at all (its birth time cannot be
 * set). Returns false when the destination cannot store the capture date (exFAT keeps 1980–2107,
 * APFS about 1677–2262; both clamp or ignore such a value rather than fail): the file then gets
 * the source's own dates, as a file without a capture date does. Any other failure (a missing
 * helper, a file that is not exclusively linked) is thrown. Copy-time dates are never accepted.
 */
export async function applyFileTimestamps(output:FileHandle,source:BigIntStats,captureTimeMs?:number,file?:string):Promise<boolean>{
 if(captureTimeMs!==undefined&&(!Number.isFinite(captureTimeMs)||Math.abs(captureTimeMs)>8640000000000000))throw new Error('Invalid planned capture timestamp');
 if(captureTimeMs!==undefined)try{await setDates(output,source,captureTimeMs/1000,captureTimeMs/1000,file);return true;}catch(error){if(!(error instanceof UnstorableDate))throw error;}
 await setDates(output,source,Number(source.birthtimeMs)/1000,Number(source.mtimeMs)/1000,file);
 return captureTimeMs===undefined;
}
/** Windows: one PowerShell kept running that sets a file's Created date with SetFileTime, a request per line
 * ("<path>\t<FILETIME>"), answered "ok" or the Win32 error: a process per file would cost far more than the copy of a
 * small one. The file is opened for its attributes only, sharing everything (the app's own handle stays open), and a
 * link is never followed. It ends when its stdin closes. */
const createdScript=String.raw`
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class Created {
 [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
 [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFileTime(IntPtr handle, ref long created, IntPtr accessed, IntPtr written);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static string Set(string name, long created) {
  var handle = CreateFileW(name, 0x100, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero); // FILE_WRITE_ATTRIBUTES, share all, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT
  if (handle == new IntPtr(-1)) return "error " + Marshal.GetLastWin32Error();
  try { return SetFileTime(handle, ref created, IntPtr.Zero, IntPtr.Zero) ? "ok" : "error " + Marshal.GetLastWin32Error(); } finally { CloseHandle(handle); }
 }
}
"@
$in=New-Object IO.StreamReader([Console]::OpenStandardInput(),(New-Object Text.UTF8Encoding $false))
while($null -ne ($line=$in.ReadLine())){$p=$line.Split([char]9);try{[Console]::Out.WriteLine([Created]::Set($p[0],[int64]$p[1]))}catch{[Console]::Out.WriteLine('error '+$_.Exception.Message)}}
`;
let createdHelper:{child:ChildProcessWithoutNullStreams;waiting:((line:string)=>void)[];buffer:string}|undefined;
/** A Win32 path that is not limited to 260 characters. */
const longPath=(file:string)=>file.startsWith('\\\\?\\')?file:file.startsWith('\\\\')?`\\\\?\\UNC\\${file.slice(2)}`:`\\\\?\\${file}`;
function setWindowsCreated(file:string,createdMs:number):Promise<string> {
 if(!createdHelper||createdHelper.child.exitCode!==null){
  const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(createdScript,'utf16le').toString('base64')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const helper={child,waiting:[] as ((line:string)=>void)[],buffer:''};createdHelper=helper;
  child.stdout.setEncoding('utf8');child.stderr.resume();
  child.stdout.on('data',(text:string)=>{helper.buffer+=text;let at:number;while((at=helper.buffer.indexOf('\n'))>=0){const line=helper.buffer.slice(0,at).trim();helper.buffer=helper.buffer.slice(at+1);helper.waiting.shift()?.(line);}hold(helper);});
  const gone=()=>{if(createdHelper===helper)createdHelper=undefined;for(const done of helper.waiting.splice(0))done('error the helper ended');};
  child.on('exit',gone);child.on('error',gone);child.stdin.on('error',gone);
 }
 const helper=createdHelper!;
 // FILETIME: 100 ns intervals since 1601.
 const filetime=BigInt(Math.round(createdMs))*10000n+116444736000000000n;
 return new Promise(resolve=>{helper.waiting.push(resolve);hold(helper);helper.child.stdin.write(`${longPath(file)}\t${filetime}\n`);});
}
/** The helper keeps the app (or a test) running only while it owes an answer. */
function hold(helper:{child:ChildProcessWithoutNullStreams;waiting:unknown[]}):void {
 const method=helper.waiting.length?'ref':'unref';
 helper.child[method]();for(const stream of [helper.child.stdin,helper.child.stdout,helper.child.stderr])(stream as unknown as Record<string,(()=>void)|undefined>)[method]?.();
}
/** Ends the Windows Created-date helper, if one runs. */
export function closeFileTimestamps():void {const helper=createdHelper;createdHelper=undefined;try{helper?.child.stdin.end();}catch{/* Already gone. */}}
/** The filesystem refused the value's range, or stored a different (clamped or unchanged) date. */
class UnstorableDate extends Error {}
const rangeCodes=new Set(['EINVAL','EOVERFLOW','ERANGE']);
async function setDates(output:FileHandle,source:BigIntStats,created:number,modified:number,file?:string):Promise<void>{
 const current=await output.stat();if(!current.isFile()||current.nlink!==1)throw new Error('Filesystem timestamps require an exclusively owned regular file');
 try{await output.utimes(Number(source.atimeMs)/1000,modified);}catch(error){throw rangeCodes.has((error as NodeJS.ErrnoException).code??'')?new UnstorableDate(String(error)):error;}
 if(process.platform==='win32'&&file&&Number.isFinite(created)){
  const before=await output.stat();
  if(!(before.dev===current.dev&&before.ino===current.ino))throw new Error('Filesystem timestamps require an exclusively owned regular file');
  if(Math.abs(before.birthtimeMs-created*1000)>=1){
   const answer=await setWindowsCreated(file,created*1000);
   // 87 (invalid parameter): the file system refused the date's range (FAT keeps 1980–2107).
   if(answer==='error 87')throw new UnstorableDate('Destination filesystem refused the requested Created date');
   if(answer!=='ok')throw new Error(`Unable to set the Created date: ${answer}`);
   const after=await output.stat();
   // The descriptor still names the file the path did, so the date went to this copy.
   if(after.ino!==current.ino||Math.abs(after.birthtimeMs-created*1000)>2000)throw new UnstorableDate('Destination filesystem did not preserve the requested Created date');
  }
 }
 // Linux has no way to set a file's birth time; only Modified is kept there.
 if(process.platform!=='darwin'){if(Math.abs((await output.stat()).mtimeMs-modified*1000)>2000)throw new UnstorableDate('Destination filesystem did not preserve the requested Modified date');return;}
 // APFS commonly lowers Created along with an older Modified date. Avoid a
 // native process when descriptor utimes already produced both requested dates.
 const applied=await output.stat();
 if(Math.abs(applied.birthtimeMs-created*1000)<1&&Math.abs(applied.mtimeMs-modified*1000)<1)return;
 const executable=await nativeCameraHelperPath();if(!executable)throw new Error('The native helper is required to preserve macOS Created dates. Run npm run native:mac.');
 const helperStart=performance.now();
 await new Promise<void>((resolve,reject)=>{
  const child=spawn(executable,['--set-file-times',String(created),String(modified)],{stdio:['ignore','ignore','pipe',output.fd],windowsHide:true,timeout:10000});let stderr='';
  child.stderr!.on('data',data=>{stderr=(stderr+data.toString()).slice(-4096);});
  child.on('error',reject);child.on('exit',status=>status===0?resolve():reject(new Error(stderr.trim()||'Unable to set filesystem Created date')));
 });
 log('detailed','exec','timestamps-helper',{ms:Math.round(performance.now()-helperStart),created:Math.round(created),modified:Math.round(modified)});
 const result=await output.stat();
 // Filesystems can round timestamp precision, but silently ignoring creation
 // dates must never produce a successful import with copy-time Created dates.
 if(Math.abs(result.birthtimeMs-created*1000)>2000||Math.abs(result.mtimeMs-modified*1000)>2000)throw new UnstorableDate('Destination filesystem did not preserve the requested Created/Modified dates');
}
