import * as fs from 'node:fs/promises';
import {isAbort} from '../paths';
import {APPLEDOUBLE_MAX_BYTES,inspectAppleDouble} from '../appledouble';
import {log,logDeletion} from '../../logger';

/** Log a file or folder the converter deletes, with why and what proved it safe. */
export const deleted=(file:string,reason:string,proof:string,fields?:Record<string,string|number|boolean>)=>logDeletion('migrate',file,reason,proof,fields);
/** One of many files a step deletes, logged at the detailed level (the step logs their count at the normal level with `deleted`). */
export const deletedDetail=(file:string,reason:string)=>log('detailed','migrate','file-deleted',{path:file,reason});

/** The converter's steps, as the interface shows them. */
export type MigrationStep='looking'|'converting'|'originals'|'removing'|'receipts'|'caches'|'cleanup';
export interface MigrationProgress {step:MigrationStep;completed:number;total:number;file:string;}
/** Called right after each step's change is durable, with the step's name (N1…N9, P1, R1…R3, C, F): tests stop the
 * converter there to check that the next run finishes from what is on disk. */
export type CrashPoint=(point:string)=>void|Promise<void>;
export interface MigrationContext {signal?:AbortSignal;onProgress?:(progress:MigrationProgress)=>void;crash?:CrashPoint;problems:string[];/** Folders the receipt walk never enters, by name (the no-metadata "Unknown files" folder). */ignoreFolders?:string[];}
/** What a test's crash point throws: never caught by the converter's own error handling. */
export class SimulatedCrash extends Error {constructor(readonly point:string){super(`Simulated crash at ${point}`);this.name='SimulatedCrash';}}
/** Errors a step must not swallow: a stop, or a simulated crash. */
export const passThrough=(error:unknown)=>isAbort(error)||error instanceof SimulatedCrash;
export async function hit(context:MigrationContext,point:string):Promise<void>{await context.crash?.(point);}
export const message=(error:unknown)=>error instanceof Error?error.message:String(error);
/** A macOS "._" file holding only bookkeeping (no resource fork, Finder info or comments). */
export async function bookkeepingOnly(file:string):Promise<boolean>{
 const stat=await fs.lstat(file).catch(()=>undefined);if(!stat?.isFile()||stat.size>APPLEDOUBLE_MAX_BYTES)return false;
 const bytes=await fs.readFile(file).catch(()=>undefined);return !!bytes&&inspectAppleDouble(bytes).safe;
}
/** Run `work` on every item, several at a time (unlinking tens of thousands of small files on a USB drive). */
export async function pool<T>(items:T[],width:number,work:(item:T)=>Promise<void>):Promise<void>{
 let next=0,failure:unknown;
 await Promise.all(Array.from({length:Math.min(width,items.length)},async()=>{while(failure===undefined&&next<items.length){const item=items[next++]!;try{await work(item);}catch(error){failure??=error;}}}));
 if(failure!==undefined)throw failure;
}
