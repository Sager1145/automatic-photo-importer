import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {AppState} from '../../../shared';

/** What every check may read: the fixture root, the original bytes, and what the first paint showed. */
export interface Context {
 root:string;
 /** Digest of every source original and destination marker, taken before anything ran. */
 originals:Map<string,string>;
 marker:string;
 firstState:AppState;
 firstBanner:string;
 organizationOnly:boolean;
 /** Set only by --real-drives: libraries of real, mounted drives to browse read-only. */
 realDrives?:{destination:string;basePath:string}[];
}
/** The fixture's photo folders named `name` on both destination drives (the video folders stay where they are). */
export const photoFolders=(ctx:Pick<Context,'root'>,name:string)=>({destinations:[path.join(ctx.root,'destination',name),path.join(ctx.root,'destination-2',name)]});
export const digest=async(file:string)=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
/** Digests of every file under a folder. */
export async function digests(folder:string):Promise<string[]>{
 const out:string[]=[];
 const walk=async(dir:string):Promise<void>=>{for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile())out.push(await digest(file));}};
 await walk(folder);return out;
}
export const savedPreferences=async(root:string)=>JSON.parse(await fs.readFile(path.join(root,'user-data','settings.json'),'utf8')).preferences;
