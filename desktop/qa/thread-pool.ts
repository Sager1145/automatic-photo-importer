import fs from 'node:fs/promises';
import {mkdtempSync,openSync,closeSync} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {execFileSync} from 'node:child_process';
/** True when the libuv pool has more than `n` threads: `n` reads that cannot finish block `n` threads for good,
 * so a further request is served promptly only if a spare thread exists. Deterministic, unlike timing CPU work.
 * macOS and Linux block on opening unwritten FIFOs; Windows has no FIFOs, so there each thread blocks reading a
 * named-pipe client opened without overlapped I/O, until this process's pipe server writes to it. */
export async function threadpoolExceeds(n:number):Promise<boolean>{
 return process.platform==='win32'?pipesExceed(n):fifosExceed(n);
}
/** Whether a spare thread answers a stat while the others are blocked. */
async function spare(folder:string):Promise<boolean>{
 await sleep(200);
 return Promise.race([fs.stat(folder).then(()=>true),new Promise<boolean>(r=>setTimeout(()=>r(false),500))]);
}
async function fifosExceed(n:number):Promise<boolean>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'pool-')),pipes:string[]=[],writers:number[]=[];
 try{
  for(let i=0;i<n;i++){const pipe=path.join(dir,`f${i}`);execFileSync('mkfifo',[pipe]);pipes.push(pipe);}
  const blocked=pipes.map(pipe=>fs.open(pipe,'r').then(handle=>handle.close(),()=>undefined));
  try{
   return await spare(dir);
  }finally{
   // Open a writer for every FIFO so each blocked open is released.
   for(const pipe of pipes){try{writers.push(openSync(pipe,'r+'));}catch{}}
   await Promise.all(blocked);
  }
 }finally{
  for(const fd of writers){try{closeSync(fd);}catch{}}
  await fs.rm(dir,{recursive:true,force:true});
 }
}
async function pipesExceed(n:number):Promise<boolean>{
 const name=`\\\\.\\pipe\\photo-importer-pool-${process.pid}-${Date.now()}`,sockets:net.Socket[]=[];
 const server=net.createServer(socket=>{sockets.push(socket);});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(name,()=>resolve());});
 const handles:fs.FileHandle[]=[];
 try{
  for(let i=0;i<n;i++)handles.push(await fs.open(name,'r+'));
  while(sockets.length<n)await sleep(10);
  const blocked=handles.map(handle=>handle.read(Buffer.alloc(1),0,1,null).catch(()=>undefined));
  try{
   return await spare(os.tmpdir());
  }finally{
   // One byte to every client releases each blocked read.
   for(const socket of sockets)socket.write('x');
   await Promise.all(blocked);
  }
 }finally{
  for(const handle of handles)await handle.close().catch(()=>{});
  for(const socket of sockets)socket.destroy();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
 }
}
