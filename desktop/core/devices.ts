import * as fs from 'node:fs/promises';
import path from 'node:path';
import { volumeAt } from '../platform/volumes';
import { cpuWorkers, governor, memoryBudgetBytes, type MemoryGovernor } from '../resource-limits';

/** What a storage device is, as far as streaming it is concerned. */
export type DeviceKind='hdd'|'ssd'|'card'|'unknown';
/** Whole-file reads and copies running at once on one device. A spinning disk seeks between
 * streams, so it gets one; SD cards and their readers gain little beyond two; SSDs (internal,
 * NVMe or USB) hide per-request and fsync latency with several. */
export const STREAMS:Record<DeviceKind,number>={hdd:1,card:2,ssd:4,unknown:2};
/** Read size per stream: long sequential reads keep a spinning disk streaming between seeks;
 * flash gains nothing measurable beyond 1 MiB. */
export const CHUNK:Record<DeviceKind,number>={hdd:8*1024*1024,card:1024*1024,ssd:1024*1024,unknown:1024*1024};

type Classify=(file:string)=>Promise<DeviceKind>;
/** The medium `file` is on, from the description of its volume (platform/volumes). */
async function classify(file:string):Promise<DeviceKind> {
  return (await volumeAt(file))?.kind ?? 'unknown';
}

/** Per-device stream slots shared by every job in this process, so two imports reading or
 * writing the same spinning disk take turns instead of making it seek between them. */
export class DeviceStreams {
  private kinds=new Map<bigint,Promise<DeviceKind>>();
  private known=new Map<bigint,DeviceKind>();
  private slots=new Map<bigint,{busy:number;limit:number;waiting:(()=>void)[]}>();
  constructor(private readonly kindOf?:Classify,private readonly gate:MemoryGovernor=governor) {}
  /** The device `file` lives on, or for a file not yet created its nearest existing folder. */
  private async device(file:string):Promise<bigint> {
    for(let current=file;;current=path.dirname(current)) {
      try { return (await fs.stat(current,{bigint:true})).dev; }
      catch(error) { if(path.dirname(current)===current) throw error; }
    }
  }
  /** Classify `file`'s device (once per device); streams use the answer as soon as it is known. */
  async kind(file:string,dev?:bigint):Promise<DeviceKind> {
    const id=dev??await this.device(file);
    let kind=this.kinds.get(id);
    if(!kind) {
      kind=(this.kindOf??classify)(file).catch(()=>'unknown' as const);this.kinds.set(id,kind);
      void kind.then(value=>{this.known.set(id,value);const slot=this.slots.get(id);if(slot){slot.limit=STREAMS[value];this.wake(slot);}});
    }
    return kind;
  }
  /** Hand free slots to waiters, up to the device's current limit. */
  private wake(slot:{busy:number;limit:number;waiting:(()=>void)[]}):void {
    while(slot.busy<slot.limit&&slot.waiting.length) {slot.busy++;slot.waiting.shift()!();}
  }
  private async acquire(dev:bigint,signal?:AbortSignal):Promise<void> {
    const kind=this.known.get(dev),limit=STREAMS[kind??'unknown'];
    const slot=this.slots.get(dev)??{busy:0,limit,waiting:[]};if(kind)slot.limit=limit;this.slots.set(dev,slot);
    if(slot.busy<slot.limit&&!slot.waiting.length) {slot.busy++;return;}
    await new Promise<void>((resolve,reject)=>{
      // Stop leaves the queue at once; a slot already handed over is released by the caller.
      const stop=()=>{const position=slot.waiting.indexOf(grant);if(position>=0){slot.waiting.splice(position,1);reject(new DOMException('Import stopped','AbortError'));}};
      const grant=()=>{if(typeof signal?.removeEventListener==='function')signal.removeEventListener('abort',stop);resolve();};
      if(signal?.aborted) {reject(new DOMException('Import stopped','AbortError'));return;}
      // Only a real AbortSignal can be listened to; anything else just waits.
      slot.waiting.push(grant);if(typeof signal?.addEventListener==='function')signal.addEventListener('abort',stop,{once:true});this.wake(slot);
    });
  }
  private release(dev:bigint):void {
    const slot=this.slots.get(dev)!;slot.busy--;this.wake(slot);
  }
  /** Run `work` holding one stream on each device the files are on (taken in a fixed order, so
   * two callers can never wait on each other). `chunk` is the read size suited to them; with
   * `signal`, Stop ends the wait for a slot at once. A device's kind waits for the mount snapshot
   * (diskutil, seconds under load), so until it answers its streams use the middle setting. */
  run<T>(files:string[],work:(chunk:number)=>Promise<T>,signal?:AbortSignal):Promise<T> {
    // Memory governor: while the app is above 90% of its memory limit, a new file waits here (work already running is untouched).
    return this.gate.govern(()=>this.stream(files,work,signal),signal);
  }
  private async stream<T>(files:string[],work:(chunk:number)=>Promise<T>,signal?:AbortSignal):Promise<T> {
    const devices=new Map<bigint,string>();
    for(const file of files) {const dev=await this.device(file);if(!devices.has(dev))devices.set(dev,file);}
    const order=[...devices.keys()].sort((a,b)=>a<b?-1:a>b?1:0);
    for(const dev of order) void this.kind(devices.get(dev)!,dev);
    const kinds=order.map(dev=>this.known.get(dev)??'unknown');
    const held:bigint[]=[];
    try {
      for(const dev of order) {await this.acquire(dev,signal);held.push(dev);}
      // Read buffers shrink with a small memory budget (1/256 of it per stream; the tuned sizes stand at the 2 GB default).
      return await work(Math.min(Math.max(...kinds.map(kind=>CHUNK[kind])),Math.max(256*1024,Math.floor(memoryBudgetBytes()/256))));
    } finally { for(const dev of held.reverse()) this.release(dev); }
  }
}
/** The process-wide slots: every whole-file stream of every job goes through them. */
export const streams=new DeviceStreams();

/** Files per ExifTool request for routing reads (platform/metadata.ts). */
export const ROUTING_BATCH=16;
/** Metadata reads in flight while checking or scanning: enough to fill ExifTool's multi-file requests (platform/metadata.ts) on every
 * request the fastest device runs at once, plus one batch being gathered; the device's own limit still caps the requests running at once. */
export const CHECK_CONCURRENCY=ROUTING_BATCH*(Math.max(...Object.values(STREAMS))+1);

/** CPU worker count for a pool wanting up to `cap`: never above the user's thread limit, never below one. */
export {cpuWorkers};
/** Run `work` over `items` with at most `limit` in flight, results in input order (by index). The first
 * failure stops new work and is rethrown once the running ones settle. A stopped `signal` fails the next item (checkAbort in paths.ts, which this file cannot import). */
export async function mapPool<T,R>(items:readonly T[],limit:number,work:(item:T,index:number)=>Promise<R>,signal?:AbortSignal):Promise<R[]> {
  const results=new Array<R>(items.length);
  let next=0,failure:unknown,failed=false;
  await Promise.all(Array.from({length:Math.min(items.length,Math.max(1,limit))},async()=>{
    while(!failed&&next<items.length) {
      const index=next++;
      try { if(signal?.aborted) throw new DOMException('Import stopped','AbortError'); results[index]=await work(items[index]!,index); } catch(error) { if(!failed){failed=true;failure=error;} }
    }
  }));
  if(failed) throw failure;
  return results;
}

/** Whether another job may start reading a device: jobs on one physical disk (the snapshot's
 * physicalId) share its stream limit (a spinning disk serves one, so two folders on it take turns
 * while folders on other disks run in parallel). `running` holds the drives of the jobs already
 * going; a source with no known physical disk (a card, a camera) is never held back. */
export function deviceHasRoom(drive:{physicalId?:string;kind?:DeviceKind}|undefined,running:readonly ({physicalId?:string}|undefined)[]):boolean {
  if(!drive?.physicalId) return true;
  return running.filter(item=>item?.physicalId===drive.physicalId).length<STREAMS[drive.kind??'unknown'];
}
