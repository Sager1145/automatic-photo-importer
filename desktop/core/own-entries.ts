import path from 'node:path';
import { isRecordFolderName } from './legacy-names';

/**
 * What this process created or renamed on drives, so the macOS "._" files that writing them makes on volumes without
 * extended attributes (exFAT, FAT, SMB) can be removed afterwards (AppleDoubleCleaner.own in appledouble.ts). Library
 * folders are noted one by one, with whether a "._" by that name was already there (then it is not the app's and stays).
 * In the app's records folders every entry is the app's own, so the folder written to is noted and all its "._" files
 * are judged. Kept in memory only, and bounded: on Windows and Linux nothing makes these files, and looking finds none.
 */
export interface OwnEntry {/** The entry whose "._" sidecar may go. */entry:string;/** Every check stays inside it. */scope:string;/** A "._" by this name was there before the app made the entry. */existed:boolean;}
export interface OwnFolder {folder:string;scope:string;}
const MAX=20_000;
const entries=new Map<string,OwnEntry>(),folders=new Map<string,OwnFolder>();
const keyOf=(file:string)=>path.resolve(file).normalize('NFC').toLowerCase();
function remember<T>(map:Map<string,T>,key:string,value:T):void {
  map.delete(key);map.set(key,value);
  if(map.size>MAX)map.delete(map.keys().next().value!);
}
/** `entry` (a file or folder inside `scope`) was just created or renamed into place by this app. */
export function ownEntry(entry:string,scope:string,existed=false):void {
  const key=keyOf(entry);
  remember(entries,key,{entry,scope,existed:existed||!!entries.get(key)?.existed});
}
/** `entry` was created or renamed into place by this app; only entries inside one of its records folders are noted:
 * the folder holding it, or, for a records folder itself, its own name beside it. */
export function ownRecordWrite(entry:string):void {
  const parts=path.resolve(entry).split(path.sep),at=parts.findIndex((part,index)=>index>0&&isRecordFolderName(part));
  if(at<0)return;
  if(at===parts.length-1){ownEntry(entry,path.dirname(path.resolve(entry)));return;}
  const folder=path.dirname(path.resolve(entry));
  remember(folders,keyOf(folder),{folder,scope:parts.slice(0,at+1).join(path.sep)||path.sep});
}
const inside=(child:string,parent:string)=>{const relative=path.relative(parent,child);return relative===''||!relative.startsWith('..')&&!path.isAbsolute(relative);};
/** Takes (and forgets) what was noted on the drives of `roots`: inside one of them, or records kept beside or above one. */
export function takeOwn(roots:string[]):{entries:OwnEntry[];folders:OwnFolder[]} {
  const mine=(scope:string)=>roots.some(root=>inside(scope,root)||inside(root,path.dirname(scope)));
  const take=<T extends {scope:string}>(map:Map<string,T>)=>{const found:T[]=[];for(const [key,value] of map)if(mine(value.scope)){found.push(value);map.delete(key);}return found;};
  return {entries:take(entries),folders:take(folders)};
}
