import * as fs from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { MessageError, message, text } from '../messages';
import { code, syncDirectory, syncFile } from './paths';

/** What the probe does to the folder, replaceable in tests (a driver that loses a write, a rename that fails). */
export interface ProbeOps {
  write(file:string,data:Buffer):Promise<void>;
  flush(file:string,folder:string):Promise<void>;
  read(file:string):Promise<Buffer>;
  rename(from:string,to:string):Promise<void>;
  remove(file:string):Promise<void>;
  exists(file:string):Promise<boolean>;
}
const realOps:ProbeOps={
  // 'wx': the probe never replaces anything already in the folder.
  write:async(file,data)=>{const handle=await fs.open(file,'wx');try{await handle.writeFile(data);}finally{await handle.close();}},
  flush:async(file,folder)=>{await syncFile(file);await syncDirectory(folder);},
  read:file=>fs.readFile(file),
  rename:(from,to)=>fs.rename(from,to),
  remove:file=>fs.unlink(file),
  exists:file=>fs.lstat(file).then(()=>true,error=>{if(code(error)==='ENOENT')return false;throw error;}),
};
export type ProbeStep='write'|'flush'|'read'|'rename'|'delete';
/** Bytes written by the probe: enough to cross a page and a FAT/exFAT cluster, small enough to cost nothing. */
const PROBE_BYTES=192*1024;
const READ_ONLY=new Set(['EROFS','EACCES','EPERM']);
const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');

/**
 * Proves a destination folder works the way a backup needs before it is accepted: a new file is written, flushed to
 * the drive, read back with the same SHA-256, renamed, read again under its new name, and deleted. Every drive gets
 * this, not only those mounted by a third-party or FUSE driver: a driver that mounts read-only, loses writes, or cannot
 * rename is refused here instead of failing an import midway. Nothing but the probe's own file is touched, and it is
 * removed again whatever happens. A drive that refuses the first write is reported read-only.
 */
export async function probeDestination(folder:string,ops:ProbeOps=realOps):Promise<void> {
  const name=`.photo-importer-probe-${randomUUID()}`,first=path.join(folder,name),second=path.join(folder,`${name}-renamed`);
  const data=randomBytes(PROBE_BYTES),expected=sha(data);
  let step:ProbeStep='write';
  const fail=(detail:string):never=>{throw new MessageError('error.destinationProbe',{step:message(`probe.${step}`),detail:text(detail)});};
  try {
    try { await ops.write(first,data); }
    catch(error) { if(READ_ONLY.has(code(error)??''))throw new MessageError('error.destinationReadOnly'); throw error; }
    step='flush'; await ops.flush(first,folder);
    step='read'; if(sha(await ops.read(first))!==expected)fail('the data read back differs from the data written');
    step='rename'; await ops.rename(first,second);
    if(await ops.exists(first))fail('the old name is still there after renaming');
    if(sha(await ops.read(second))!==expected)fail('the renamed file holds different data');
    step='delete'; await ops.remove(second);
    if(await ops.exists(second))fail('the file is still there after deleting it');
  } catch(error) {
    if(error instanceof MessageError)throw error;
    fail(error instanceof Error?error.message:String(error));
  } finally {
    // Whatever failed, the probe leaves nothing behind that it can still remove.
    for(const file of [first,second])await ops.remove(file).catch(()=>{});
  }
}
