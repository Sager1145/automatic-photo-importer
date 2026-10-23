import {spawn} from 'node:child_process';
import type {FileHandle} from 'node:fs/promises';
import type {BigIntStats} from 'node:fs';
import {nativeCameraHelperPath} from './camera-bridge';
import {log} from '../logger';

/** Only call on exclusively owned writable descriptors, before publication.
 * Linux/Windows Node exposes mtime, but no writable filesystem creation time.
 * Returns false when the destination cannot store the capture date (exFAT keeps 1980–2107,
 * APFS about 1677–2262; both clamp or ignore such a value rather than fail): the file then gets
 * the source's own dates, as a file without a capture date does. Any other failure (a missing
 * helper, a file that is not exclusively linked) is thrown. Copy-time dates are never accepted.
 */
export async function applyFileTimestamps(output:FileHandle,source:BigIntStats,captureTimeMs?:number):Promise<boolean>{
 if(captureTimeMs!==undefined&&(!Number.isFinite(captureTimeMs)||Math.abs(captureTimeMs)>8640000000000000))throw new Error('Invalid planned capture timestamp');
 if(captureTimeMs!==undefined)try{await setDates(output,source,captureTimeMs/1000,captureTimeMs/1000);return true;}catch(error){if(!(error instanceof UnstorableDate))throw error;}
 await setDates(output,source,Number(source.birthtimeMs)/1000,Number(source.mtimeMs)/1000);
 return captureTimeMs===undefined;
}
/** The filesystem refused the value's range, or stored a different (clamped or unchanged) date. */
class UnstorableDate extends Error {}
const rangeCodes=new Set(['EINVAL','EOVERFLOW','ERANGE']);
async function setDates(output:FileHandle,source:BigIntStats,created:number,modified:number):Promise<void>{
 const current=await output.stat();if(!current.isFile()||current.nlink!==1)throw new Error('Filesystem timestamps require an exclusively owned regular file');
 try{await output.utimes(Number(source.atimeMs)/1000,modified);}catch(error){throw rangeCodes.has((error as NodeJS.ErrnoException).code??'')?new UnstorableDate(String(error)):error;}
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
