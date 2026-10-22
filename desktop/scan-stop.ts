/** The part of a utility process the stop sequence needs (kept free of Electron so it can be tested). */
export interface ScanChild {
  pid?:number;
  postMessage(message:unknown):void;
  kill():boolean;
  once(event:'spawn',listener:()=>void):unknown;
}
export interface StopTimings {graceMs?:number;killMs?:number;sigkill?:(pid:number)=>void;}

/**
 * Stops a read-only scan process and resolves once it has exited.
 * It is asked to stop first and closes its own files (the worker awaits closeMetadata, then exits).
 * Only when it has not exited after `graceMs` is it killed, and `killMs` later forced.
 * `exited` must resolve when the process has exited (or never started).
 */
export async function stopScanChild(child:ScanChild,exited:Promise<void>,timings:StopTimings={}):Promise<void> {
  const {graceMs=2000,killMs=250,sigkill=pid=>{process.kill(pid,'SIGKILL');}}=timings;
  const timers:NodeJS.Timeout[]=[];
  try {
    // A process that has not spawned yet is asked once it has.
    if(!child.pid) await Promise.race([new Promise<void>(resolve=>child.once('spawn',resolve)),exited]);
    const pid=child.pid;
    if(!pid) return await exited;
    try { child.postMessage({type:'stop'}); } catch { /* Already gone. */ }
    timers.push(setTimeout(()=>{
      try { child.kill(); } catch { /* Already gone. */ }
      timers.push(setTimeout(()=>{ try { sigkill(pid); } catch { /* Already gone. */ } },killMs));
    },graceMs));
    await exited;
  } finally { for(const timer of timers) clearTimeout(timer); }
}
