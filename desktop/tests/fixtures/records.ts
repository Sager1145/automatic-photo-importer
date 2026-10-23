import * as fs from 'node:fs/promises';
import path from 'node:path';
import {journalFolderFor} from '../../core/recovery';
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
