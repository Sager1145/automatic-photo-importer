/** Drives the user moved to the top: their cards come first and their queued jobs start next. */

/** `order` with `id` moved to its front. */
export function moveToFront(order:string[],id:string):string[] {return [id,...order.filter(item=>item!==id)];}

/** Sources named in `order` first, in that order; the rest keep their current order. */
export function orderSources<T extends {id:string}>(sources:T[],order:string[]):T[] {
  const rank=new Map(order.map((id,index)=>[id,index]));
  return sources.map((source,index)=>({source,index})).sort((a,b)=>(rank.get(a.source.id)??order.length)-(rank.get(b.source.id)??order.length)||a.index-b.index).map(({source})=>source);
}

interface QueuedJob {id:string;phase:string;organization?:boolean;source:{id:string};}
/** Queued jobs in the order they will start: jobs of drives moved to the top first, in card
 * order (most recent move first), then every other job longest waiting first (jobs are kept
 * newest first). A drive keeps its place for jobs started after it was moved; organization
 * jobs never jump the queue. */
function startOrder<T extends QueuedJob>(jobs:T[],sourceOrder:string[]):T[] {
  const rank=new Map(sourceOrder.map((id,index)=>[id,index]));
  const queued=jobs.filter(job=>job.phase==='queued').reverse();
  const position=(job:T)=>job.organization?sourceOrder.length:rank.get(job.source.id)??sourceOrder.length;
  return queued.map((job,index)=>({job,index})).sort((a,b)=>position(a.job)-position(b.job)||a.index-b.index).map(({job})=>job);
}
/** The start order as ids, for the renderer. */
export const queueOrder=<T extends QueuedJob>(jobs:T[],sourceOrder:string[]):string[]=>startOrder(jobs,sourceOrder).map(job=>job.id);
/** The first queued job in start order that `canStart` accepts, so a job held back (its drive is
 * busy) lets the next one go. */
export const nextRunnable=<T extends QueuedJob>(jobs:T[],sourceOrder:string[],canStart:(job:T)=>boolean):T|undefined=>startOrder(jobs,sourceOrder).find(canStart);
