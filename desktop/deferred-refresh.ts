/** Runs a background listing one at a time, and not while `planning()` is true: a review or job that is
 * planning needs the drive's file calls, and a listing beside it only queues behind them. A request made
 * meanwhile is remembered and run by the next `resume()` once planning has ended. `pause()` stops a
 * listing already running (its signal aborts) and defers it the same way; the run keeps what it read. */
export function deferredRefresh(options:{planning:()=>boolean;run:(signal:AbortSignal)=>Promise<void>}){
 let running:Promise<void>|undefined,deferred=false,control:AbortController|undefined,starting=false;
 const start=():boolean=>{
  if(running||starting)return false;
  if(options.planning()){deferred=true;return false;}
  deferred=false;const own=control=new AbortController();starting=true;
  try{
   running=options.run(own.signal).then(()=>{},()=>{}).finally(()=>{running=undefined;if(control===own)control=undefined;});
  }finally{starting=false;}
  return true;
 };
 return {
  /** True when a listing was started now; false when one is running or the request was deferred. */
  request:start,
  /** Starts a deferred request if planning has ended. */
  resume:()=>{if(deferred)start();},
  /** Stops the running listing, if any, and defers it until `resume()` finds nothing planning. */
  pause:()=>{if(running&&control&&!control.signal.aborted){deferred=true;control.abort();}},
  /** A run that stopped itself (it was aborted) asks to be started again by `resume()`. */
  defer:()=>{deferred=true;},
  get running(){return !!running;},
  get deferred(){return deferred;},
 };
}
