import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** The folder rules each destination library was last filled under, kept across restarts. An import looks for
 * files already in the library under other folders only when the rules differ from these (or none were recorded):
 * with unchanged rules a file that belongs elsewhere cannot exist. A missing or corrupt record means "look".
 * The scope is routing-options.ts rulesScope. */
interface Stored {version:1;scopes:Record<string,{scope:string;at:string}>;}
const MAX_SCOPES=200,MAX_BYTES=1024*1024;
const memoryFile=(store:string)=>path.join(store,'routing-memory.json');
async function read(store:string):Promise<Stored['scopes']> {
  try {
    const file=memoryFile(store);
    if((await fs.lstat(file)).size>MAX_BYTES) return {};
    const stored=JSON.parse(await fs.readFile(file,'utf8')) as Stored;
    if(stored?.version!==1||!stored.scopes||typeof stored.scopes!=='object') return {};
    return Object.fromEntries(Object.entries(stored.scopes).filter(([,value])=>typeof value?.scope==='string'&&typeof value.at==='string'));
  } catch { return {}; }
}
/** True when any of these libraries (by root identity) was not last filled under `scope`, or is not recorded. */
export async function routingChanged(store:string,rootIdentities:string[],scope:string):Promise<boolean> {
  const known=await read(store);
  return rootIdentities.some(identity=>known[identity]?.scope!==scope);
}
let writing:Promise<void>=Promise.resolve();
/** Record that these libraries are now filled under `scope` (after a completed import or organization). */
export function rememberRouting(store:string,rootIdentities:string[],scope:string):Promise<void> {
  writing=writing.catch(()=>{}).then(async()=>{
    const scopes=await read(store),at=new Date().toISOString();
    for(const identity of rootIdentities) scopes[identity]={scope,at};
    const kept=Object.entries(scopes).sort((a,b)=>b[1].at.localeCompare(a[1].at)).slice(0,MAX_SCOPES);
    const target=memoryFile(store),temporary=`${target}.${randomUUID()}.tmp`;
    await fs.mkdir(store,{recursive:true});
    try { await fs.writeFile(temporary,JSON.stringify({version:1,scopes:Object.fromEntries(kept)}),{mode:0o600}); await fs.rename(temporary,target); }
    catch(error) { await fs.unlink(temporary).catch(()=>{}); throw error; }
  });
  return writing;
}
