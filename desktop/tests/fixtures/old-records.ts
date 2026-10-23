import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHmac,randomUUID} from 'node:crypto';

/** Records as the versions before v5 wrote them, only as far as detection looks at them: a manifest, a pointer
 * and a per-file receipt, each sealed with an HMAC over the plain JSON. The tests never need them to be complete. */
export const OLD_KEY='fixture-only-host-recovery-secret-32bytes';
export function signOld(value:Record<string,unknown>,key=OLD_KEY):Record<string,unknown>{return {...value,seal:createHmac('sha256',Buffer.from(key)).update(JSON.stringify(value)).digest('hex')};}
export const OLD_FOLDER='Photo Importer Recovery',OLD_HIDDEN_FOLDER='.photo-importer-recovery';
/** A journal folder `<folder>/<id>` with its manifest and some per-event files; returns the manifest's path. */
export async function oldJournal(root:string,options:{id?:string;key?:string;folder?:string}={}):Promise<{id:string;folder:string;manifest:string;events:string[]}>{
 const id=options.id??randomUUID(),folder=path.join(root,options.folder??OLD_FOLDER,id);
 await fs.mkdir(folder,{recursive:true});
 const manifest=path.join(folder,'manifest.json');
 await fs.writeFile(manifest,JSON.stringify(signOld({version:1,id,root,rootIdentity:'1:2',source:root,sourceIdentity:'1:2',entries:[]},options.key)));
 const events=[path.join(folder,`event-${randomUUID()}.json`),path.join(folder,'event-log.jsonl')];
 await fs.writeFile(events[0]!,JSON.stringify(signOld({id,root,event:'complete'},options.key)));
 await fs.writeFile(events[1]!,'not read by detection\n');
 return {id,folder,manifest,events};
}
/** An old sibling pointer `<folder>/Photo Importer Recovery/journal-<id>.json`. */
export async function oldPointer(folder:string,options:{id?:string;key?:string}={}):Promise<string>{
 const id=options.id??randomUUID(),file=path.join(folder,OLD_FOLDER,`journal-${id}.json`);
 await fs.mkdir(path.dirname(file),{recursive:true});
 await fs.writeFile(file,JSON.stringify(signOld({kind:'sibling-journal',library:folder,root:path.join(folder,'..','elsewhere'),id},options.key)));
 return file;
}
/** An old per-file receipt beside `file`. */
export async function oldReceipt(file:string,options:{key?:string;kind?:'stage'|'intent'}={}):Promise<string>{
 const receipt=path.join(path.dirname(file),`photo-importer-${options.kind??'stage'}-${randomUUID()}.json`);
 await fs.writeFile(receipt,JSON.stringify(signOld({version:1,kind:options.kind==='intent'?'publication':'stage',file},options.key)));
 return receipt;
}
