import fs from 'node:fs/promises';
import {mkdtempSync,openSync,closeSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
/** True when the libuv pool has more than `n` threads: `n` opens of unwritten FIFOs block `n` threads for good,
 * so a further request is served promptly only if a spare thread exists. Deterministic, unlike timing CPU work. */
export async function threadpoolExceeds(n:number):Promise<boolean>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'pool-')),pipes:string[]=[];
 for(let i=0;i<n;i++){const pipe=path.join(dir,`f${i}`);execFileSync('mkfifo',[pipe]);pipes.push(pipe);}
 const blocked=pipes.map(pipe=>fs.open(pipe,'r').then(handle=>handle.close(),()=>undefined));
 await new Promise(r=>setTimeout(r,200));
 const spare=await Promise.race([fs.stat(dir).then(()=>true),new Promise<boolean>(r=>setTimeout(()=>r(false),500))]);
 const writers=pipes.map(pipe=>openSync(pipe,'r+'));
 await Promise.all(blocked);for(const fd of writers)closeSync(fd);
 await fs.rm(dir,{recursive:true,force:true});return spare;
}
