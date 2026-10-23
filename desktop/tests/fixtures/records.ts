import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {journalFolderFor,type ReorganizationResult} from '../../core/recovery';
import * as core from '../../core/index';
import type {Progress,TransferPlan} from '../../shared';
export {journalFolderFor};
/** The v5 journal file of organization `id` of library `root`. */
export const journalFileFor=async(root:string,id:string)=>path.join(await journalFolderFor(root,id),'journal.jsonl');
/** The journal's lines: 0 header, 1 entries, then events (without the trailing empty line). */
export async function journalLines(root:string,id:string):Promise<string[]>{return (await fs.readFile(await journalFileFor(root,id),'utf8')).split('\n').filter(Boolean);}
/** Rewrite one line of the journal as parsed JSON (its seal no longer matches unless `change` keeps it intact). */
export async function editJournalLine(root:string,id:string,index:number,change:(value:any)=>any):Promise<void>{
 const file=await journalFileFor(root,id),lines=(await fs.readFile(file,'utf8')).split('\n');
 lines[index]=JSON.stringify(change(JSON.parse(lines[index]!)));
 await fs.writeFile(file,lines.join('\n'));
}
/** The journal's entries as stored (line 2). */
export async function journalEntries(root:string,id:string):Promise<any[]>{return JSON.parse((await journalLines(root,id))[1]!).entries;}
import {pointerFilesFor} from '../../core/recovery';
import {pointerPartition,sealedLine,storeFor} from '../../core/app-store';
export {pointerFilesFor};
/** Where a pointer for `folder` is written (Photo Importer Data/Pointers/<name> <hash> in the store `folder` writes to). */
export async function pointerDirFor(folder:string):Promise<string>{return path.join((await storeFor(folder)).path,'Pointers',pointerPartition(folder));}
/** A v5 event line sealed with this process's host key (configureOrganizationRecovery must have run). */
export const sealedEvent=(record:Record<string,unknown>)=>sealedLine('event',record);
/** Append one line (sealed or not) to the journal, on a fresh line. */
export async function appendJournalLine(root:string,id:string,line:string):Promise<void>{
 const file=await journalFileFor(root,id),text=await fs.readFile(file,'utf8');
 await fs.writeFile(file,text+(text.endsWith('\n')?'':'\n')+line+'\n');
}
/** Like editJournalLine, but the edited line is sealed again with this process's host key (as the app itself would have written it). */
export async function resealJournalLine(root:string,id:string,index:number,change:(value:any)=>any):Promise<void>{
 const file=await journalFileFor(root,id),lines=(await fs.readFile(file,'utf8')).split('\n'),value=JSON.parse(lines[index]!);
 lines[index]=sealedLine(value.kind,change(value));
 await fs.writeFile(file,lines.join('\n'));
}
/** Any v5 record sealed with this process's host key (a pointer, for instance). */
export const sealedRecord=(kind:Parameters<typeof sealedLine>[0],record:Record<string,unknown>)=>sealedLine(kind,record);
/** Where the pointer of journal `id` for `folder` is kept. */
export const pointerFor=async(folder:string,id:string)=>path.join(await pointerDirFor(folder),`journal-${id}.json`);
/** A new organization (`rename`), or one recorded as an earlier version's copy journal (`copy`, see organizeByCopy). */
export const organizeAs=(kind:'rename'|'copy',transfer:TransferPlan,signal?:AbortSignal,onProgress?:(progress:Progress)=>void,options:{keepSourceFolders?:boolean}={}):Promise<ReorganizationResult>=>
 kind==='copy'?organizeByCopy(transfer,signal,onProgress,options):core.executeReorganization(transfer,signal,onProgress,options);
/** An organization as versions before rename-only journals recorded the copy strategy: a header with neither
 * `strategy` nor `cleanupScope`. The app creates the journal and is stopped before anything moves; the header is
 * sealed again without those fields, and the run resumed like any interrupted organization. */
export async function organizeByCopy(transfer:TransferPlan,signal?:AbortSignal,onProgress?:(progress:Progress)=>void,options:{keepSourceFolders?:boolean}={}):Promise<ReorganizationResult&{id:string}>{
 const listed=async()=>(await core.getOrganizationRecovery(transfer.root,{verifyContents:false,includeEnded:true})).map(job=>job.id);
 const before=new Set(await listed()),stop=new AbortController();
 await assert.rejects(core.executeReorganization(transfer,stop.signal,()=>stop.abort(),options),{name:'AbortError'});
 const id=(await listed()).find(item=>!before.has(item));assert.ok(id,'the stopped organization left its journal');
 await resealJournalLine(transfer.root,id,0,({strategy:_strategy,cleanupScope:_scope,...header})=>header);
 return {...await core.resumeOrganization(transfer.root,id,signal,onProgress),id};
}
