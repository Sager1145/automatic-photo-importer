import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

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
const run=(command:string,args:string[])=>new Promise<string>((resolve,reject)=>execFile(command,args,{timeout:10000,maxBuffer:1024*1024},(error,stdout)=>error?reject(error):resolve(stdout)));
/** The mount point of `file`'s volume, as df reports it (firmlinked folders such as /Users are
 * not mount points themselves). */
async function mountOf(file:string):Promise<string> {
  const mount=(await run('/bin/df',['-P',file])).trim().split('\n')[1]?.match(/\d+%\s+(\/.*)$/)?.[1];
  if(!mount) throw new Error('No mount point');
  return mount;
}
/** macOS: diskutil names the bus and medium. Linux: sysfs. Anything else stays unknown. */
async function classify(file:string,dev:bigint):Promise<DeviceKind> {
  try {
    if(process.platform==='darwin') {
      const info=await run('/usr/sbin/diskutil',['info','-plist',await mountOf(file)]);
      const key=(name:string)=>info.match(new RegExp(`<key>${name}</key>\\s*<(true|false|string>([^<]*)</string)`))?.slice(1);
      if(key('BusProtocol')?.[1]==='Secure Digital' || key('RemovableMedia')?.[0]==='true') return 'card';
      const solid=key('SolidState')?.[0];
      return solid==='true'?'ssd':solid==='false'?'hdd':'unknown';
    }
    if(process.platform==='linux') {
      const major=Number(((dev>>8n)&0xfffn)|((dev>>32n)&~0xfffn)),minor=Number((dev&0xffn)|((dev>>12n)&~0xffn));
      const device=await fs.realpath(`/sys/dev/block/${major}:${minor}`);
      if(/\/mmcblk\d+/.test(device)) return 'card';
      // A partition keeps its queue on the whole disk, one folder up.
      const rotational=await fs.readFile(path.join(device,'queue','rotational'),'utf8').catch(()=>fs.readFile(path.join(device,'..','queue','rotational'),'utf8'));
      return rotational.trim()==='1'?'hdd':'ssd';
    }
  } catch { /* Unknown devices get the middle setting. */ }
  return 'unknown';
}

/** Per-device stream slots shared by every job in this process, so two imports reading or
 * writing the same spinning disk take turns instead of making it seek between them. */
export class DeviceStreams {
  private kinds=new Map<bigint,Promise<DeviceKind>>();
  private known=new Map<bigint,DeviceKind>();
  private slots=new Map<bigint,{busy:number;limit:number;waiting:(()=>void)[]}>();
  constructor(private readonly kindOf?:Classify) {}
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
      kind=(this.kindOf?this.kindOf(file):classify(file,id)).catch(()=>'unknown' as const);this.kinds.set(id,kind);
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
      const grant=()=>{signal?.removeEventListener('abort',stop);resolve();};
      if(signal?.aborted) {reject(new DOMException('Import stopped','AbortError'));return;}
      slot.waiting.push(grant);signal?.addEventListener('abort',stop,{once:true});this.wake(slot);
    });
  }
  private release(dev:bigint):void {
    const slot=this.slots.get(dev)!;slot.busy--;this.wake(slot);
  }
  /** Run `work` holding one stream on each device the files are on (taken in a fixed order, so
   * two callers can never wait on each other). `chunk` is the read size suited to them; with
   * `signal`, Stop ends the wait for a slot at once. Classifying a device can take a second
   * under load (diskutil), so until it answers its streams use the middle setting. */
  async run<T>(files:string[],work:(chunk:number)=>Promise<T>,signal?:AbortSignal):Promise<T> {
    const devices=new Map<bigint,string>();
    for(const file of files) {const dev=await this.device(file);if(!devices.has(dev))devices.set(dev,file);}
    const order=[...devices.keys()].sort((a,b)=>a<b?-1:a>b?1:0);
    for(const dev of order) void this.kind(devices.get(dev)!,dev);
    const kinds=order.map(dev=>this.known.get(dev)??'unknown');
    const held:bigint[]=[];
    try {
      for(const dev of order) {await this.acquire(dev,signal);held.push(dev);}
      return await work(Math.max(...kinds.map(kind=>CHUNK[kind])));
    } finally { for(const dev of held.reverse()) this.release(dev); }
  }
}
/** The process-wide slots: every whole-file stream of every job goes through them. */
export const streams=new DeviceStreams();
