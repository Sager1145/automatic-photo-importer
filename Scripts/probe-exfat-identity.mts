/** Read-only for existing data: records what a volume reports as file identity (inode, birth time, size, links) at each step
 * the importer's copy and recovery code takes, inside a new sandbox folder it removes again. Answers which identity fields
 * stay stable on the real filesystem. Usage: node --import tsx Scripts/probe-exfat-identity.mts /Volumes/NAME [--keep] */
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';

const {positionals,values:{keep}}=parseArgs({allowPositionals:true,options:{keep:{type:'boolean'}}});
const volume=positionals[0];
if(!volume||!/^\/Volumes\/[^/]+$/.test(volume))throw new Error('Usage: probe-exfat-identity.mts /Volumes/NAME [--keep]');
const sandbox=path.join(volume,`photo-importer-hw-probe-${new Date().toISOString().replace(/[:.]/g,'-')}`);
// Every path this script writes or removes must be inside its own sandbox.
const inside=(file:string)=>{const relative=path.relative(sandbox,file);return relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative);};
const guard=(file:string)=>{if(!inside(file))throw new Error(`Refusing to touch ${file} outside ${sandbox}`);return file;};

type Snapshot={step:string;dev:string;ino:string;size:string;nlink:string;birthtimeNs:string;mtimeNs:string;ctimeNs:string;unreliable:boolean};
const snap=(step:string,s:import('node:fs').BigIntStats):Snapshot=>({step,dev:String(s.dev),ino:String(s.ino),size:String(s.size),nlink:String(s.nlink),birthtimeNs:String(s.birthtimeNs),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs),unreliable:s.size===0n||s.ino<0n||s.ino>=2n**63n});

async function trace(name:string,bytes:number):Promise<Snapshot[]> {
  const out:Snapshot[]=[],dir=guard(path.join(sandbox,'a')),other=guard(path.join(sandbox,'b'));
  let file=guard(path.join(dir,name));
  const handle=await fs.open(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try {
    out.push(snap('created',await handle.stat({bigint:true})));
    if(bytes){await handle.write(Buffer.alloc(bytes,7));out.push(snap('written',await handle.stat({bigint:true})));}
    await handle.sync();out.push(snap('fsynced',await handle.stat({bigint:true})));
  } finally {await handle.close();}
  out.push(snap('closed',await fs.lstat(file,{bigint:true})));
  const when=new Date('2020-01-02T03:04:05Z');await fs.utimes(file,when,when);out.push(snap('timed',await fs.lstat(file,{bigint:true})));
  const renamed=guard(path.join(dir,`${name}.renamed`));await fs.rename(file,renamed);file=renamed;out.push(snap('renamed',await fs.lstat(file,{bigint:true})));
  const moved=guard(path.join(other,name));await fs.rename(file,moved);file=moved;out.push(snap('moved',await fs.lstat(file,{bigint:true})));
  if(!bytes){
    // An empty file that receives data later (a direct copy's creation receipt names it while still empty).
    const later=await fs.open(file,'r+');try{await later.write(Buffer.alloc(4096,9),0,4096,0);await later.sync();out.push(snap('filled',await later.stat({bigint:true})));}finally{await later.close();}
    out.push(snap('filled-closed',await fs.lstat(file,{bigint:true})));
  }
  return out;
}

await fs.mkdir(sandbox);
try {
  await fs.mkdir(guard(path.join(sandbox,'a')));await fs.mkdir(guard(path.join(sandbox,'b')));
  const results:Record<string,Snapshot[]>={};
  for(const [name,bytes] of [['empty.bin',0],['one.bin',1],['page.bin',4096],['mib.bin',1<<20]] as const)results[name]=await trace(name,bytes);
  let link:string;
  try{await fs.link(guard(path.join(sandbox,'b','page.bin')),guard(path.join(sandbox,'b','page.link')));link='supported';}catch(error){link=(error as NodeJS.ErrnoException).code??String(error);}
  // Where the inode or birth time changed between consecutive steps, and whether the earlier step looked unreliable.
  const changes=Object.entries(results).flatMap(([name,steps])=>steps.slice(1).flatMap((step,index)=>{const before=steps[index]!;const fields=(['ino','birthtimeNs','dev'] as const).filter(key=>before[key]!==step[key]);return fields.length?[{file:name,from:before.step,to:step.step,fields,earlierUnreliable:before.unreliable,earlierSize:before.size}]:[];}));
  console.log(JSON.stringify({volume,sandbox,hardLink:link,changes,results},null,1));
} finally {
  if(!keep)await fs.rm(sandbox,{recursive:true,force:true});
}
