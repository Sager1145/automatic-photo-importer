/** Runs a background listing one at a time, and not while `planning()` is true: a review or job that is
 * planning needs the drive's file calls, and a listing beside it only queues behind them. A request made
 * meanwhile is remembered and run by the next `resume()` once planning has ended. */
export function deferredRefresh(options:{planning:()=>boolean;run:()=>Promise<void>}){
 let running:Promise<void>|undefined,deferred=false;
 const start=():boolean=>{
  if(running)return false;
  if(options.planning()){deferred=true;return false;}
  deferred=false;
  running=options.run().then(()=>{},()=>{}).finally(()=>{running=undefined;});
  return true;
 };
 return {
  /** True when a listing was started now; false when one is running or the request was deferred. */
  request:start,
  /** Starts a deferred request if planning has ended. */
  resume:()=>{if(deferred)start();},
  get running(){return !!running;},
  get deferred(){return deferred;},
 };
}
