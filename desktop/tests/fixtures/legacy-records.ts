import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHmac,randomUUID} from 'node:crypto';
import {journalFolderFor,pointerFilesFor} from '../../core/recovery';

/** Records as the earlier version wrote them, made from real v5 records: the converter's fixtures. */
export const FIXTURE_KEY='fixture-only-host-recovery-secret-32bytes';
/** The earlier version's seal: an HMAC over the plain JSON. */
export function signV1(value:Record<string,unknown>,key=FIXTURE_KEY):Record<string,unknown>{return {...value,seal:createHmac('sha256',Buffer.from(key)).update(JSON.stringify(value)).digest('hex')};}
const unseal=(line:string)=>{const {v:_v,kind:_kind,seal:_seal,...rest}=JSON.parse(line) as Record<string,unknown>;return rest;};
export interface LegacyOptions {/** Write events as one file each (versions before the event log), or split between both. */format?:'log'|'files'|'both';/** Sign with another Mac's key. */key?:string;}
/** Turn organization `id` of `root`, recorded by this version, into the earlier version's records: its folder
 * root/Photo Importer Recovery/<id> with manifest.json and its events, its kept originals moved there, and its
 * pointers rewritten in each folder's own Photo Importer Recovery. The v5 copy is removed. Returns the old folder. */
export async function toLegacy(root:string,id:string,options:LegacyOptions={}):Promise<string>{
 const folder=await journalFolderFor(root,id),lines=(await fs.readFile(path.join(folder,'journal.jsonl'),'utf8')).split('\n').filter(Boolean);
 const header=unseal(lines[0]!),entries=(JSON.parse(lines[1]!) as {entries:unknown[]}).entries;
 const manifest:Record<string,unknown>={version:1,...(header.dupKind?{kind:header.dupKind}:{}),id,root:header.root,rootIdentity:header.rootIdentity,source:header.source,sourceIdentity:header.sourceIdentity,entries,
  ...(header.strategy?{strategy:header.strategy}:{}),...(header.keepFolders?{keepFolders:header.keepFolders}:{}),...(header.libraries?{libraries:header.libraries}:{})};
 const legacy=path.join(root,'Photo Importer Recovery',id);await fs.mkdir(legacy,{recursive:true});
 await fs.writeFile(path.join(legacy,'manifest.json'),JSON.stringify(signV1(manifest,options.key)));
 const events=lines.slice(2).map(line=>JSON.stringify(signV1(unseal(line),options.key)));
 const format=options.format??'log';
 const inLog=format==='log'?events:format==='both'?events.slice(0,Math.ceil(events.length/2)+1):[];
 const inFiles=format==='files'?events:format==='both'?events.slice(Math.ceil(events.length/2)):[];
 if(inLog.length)await fs.writeFile(path.join(legacy,'event-log.jsonl'),inLog.join('\n')+'\n');
 for(const event of inFiles)await fs.writeFile(path.join(legacy,`event-${randomUUID()}.json`),event);
 if(await fs.lstat(path.join(folder,'originals')).then(()=>true,()=>false))await fs.rename(path.join(folder,'originals'),path.join(legacy,'originals'));
 for(const name of await fs.readdir(folder))if(/^(?:stage-|incomplete-)/.test(name))await fs.rename(path.join(folder,name),path.join(legacy,name));
 for(const pointerFolder of (header.folders as string[]|undefined)??[])for(const file of await pointerFilesFor(pointerFolder)){
  if(path.basename(file)!==`journal-${id}.json`)continue;
  const pointer=unseal(await fs.readFile(file,'utf8'));
  const old=path.join(pointerFolder,'Photo Importer Recovery');await fs.mkdir(old,{recursive:true});
  await fs.writeFile(path.join(old,`journal-${id}.json`),JSON.stringify(signV1({kind:'sibling-journal',library:pointer.library,root:pointer.root,id},options.key)));
  await fs.unlink(file);
 }
 await fs.rm(folder,{recursive:true});
 return legacy;
}
/** An earlier-version import receipt beside `file` (photo-importer-stage-<uuid>.json or photo-importer-intent-<uuid>.json), signed. */
export async function legacyReceipt(record:Record<string,unknown>&{kind:'stage'|'publication';file:string},key=FIXTURE_KEY):Promise<string>{
 const journal=path.join(path.dirname(record.file),`photo-importer-${record.kind==='stage'?'stage':'intent'}-${randomUUID()}.json`);
 await fs.writeFile(journal,JSON.stringify(signV1({version:1,...record},key)));
 return journal;
}
