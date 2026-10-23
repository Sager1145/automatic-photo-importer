import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DestinationStatus, DriveActivity, Source } from '../shared';
import { within } from '../core/paths';
import type { MountedVolume } from './volumes';

const exec = promisify(execFile);
/** Cumulative IOBlockStorageDriver "Statistics" of one block-storage driver (one physical disk). */
export interface Counters {readBytes:number;writeBytes:number;readOps:number;writeOps:number;readNs:number;writeNs:number;}
export const HISTORY_LENGTH = 60;
/** disk6s2 -> disk6; undefined when the name is not a BSD disk name. */
export function wholeDisk(name:string|undefined):string|undefined {return name?.match(/^(disk\d+)(?:s\d+)*$/)?.[1];}
/** A volume's physical identity is one whole disk, or several joined with "+" (APFS container over a Fusion pair). */
export function wholeDisks(physicalId:string|undefined):string[] {
  return [...new Set((physicalId??'').replace(/^\/dev\//,'').split('+').map(wholeDisk).filter((disk):disk is string=>!!disk))];
}

/** Minimal property-list reader (XML) for the value types ioreg prints. */
export function parsePlist(xml:string):unknown {
  const token=/<(\/?)([A-Za-z]+)\s*(\/?)>([^<]*)/g;
  type Frame={kind:'dict';value:Record<string,unknown>;key?:string}|{kind:'array';value:unknown[]};
  const stack:Frame[]=[];let root:unknown;
  const put=(value:unknown)=>{
    const top=stack[stack.length-1];
    if(!top){root=value;return;}
    if(top.kind==='array')top.value.push(value);else if(top.key!==undefined){top.value[top.key]=value;top.key=undefined;}
  };
  const text=(raw:string)=>raw.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
  let match:RegExpExecArray|null;
  while((match=token.exec(xml))){
    const [,closing,tag,selfClosing,body]=match as unknown as [string,string,string,string,string];
    if(tag==='plist'||tag==='data'||tag==='date')continue;
    if(closing){
      if(tag==='dict'||tag==='array'){const done=stack.pop();if(done)put(done.value);}
      continue;
    }
    if(tag==='dict'){if(selfClosing)put({});else stack.push({kind:'dict',value:{}});}
    else if(tag==='array'){if(selfClosing)put([]);else stack.push({kind:'array',value:[]});}
    else if(tag==='true')put(true);
    else if(tag==='false')put(false);
    else if(tag==='key'){const top=stack[stack.length-1];if(top?.kind==='dict')top.key=text(body);}
    else if(tag==='string')put(selfClosing?'':text(body));
    else if(tag==='integer'||tag==='real')put(Number(body));
  }
  return root;
}
const num=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0;
const drivers=(xml:string):Record<string,any>[]=>{const root=parsePlist(xml);return Array.isArray(root)?root.filter(item=>item&&typeof item==='object'):[];};
/** Statistics by IORegistryEntryID, from `ioreg -c IOBlockStorageDriver -r -w0 -a` (with or without -l). */
export function parseStatistics(xml:string):Map<number,Counters> {
  const result=new Map<number,Counters>();
  for(const driver of drivers(xml)){
    const stats=driver.Statistics,id=driver.IORegistryEntryID;
    if(!stats||typeof id!=='number')continue;
    result.set(id,{readBytes:num(stats['Bytes (Read)']),writeBytes:num(stats['Bytes (Write)']),readOps:num(stats['Operations (Read)']),writeOps:num(stats['Operations (Write)']),readNs:num(stats['Total Time (Read)']),writeNs:num(stats['Total Time (Write)'])});
  }
  return result;
}
/** Whole-disk BSD names under each driver (its IOMedia child), from the `-l` listing. Partitions and
 * synthesized APFS containers below a whole disk are not separate drives. */
export function parseDiskMap(xml:string):Map<number,string[]> {
  const result=new Map<number,string[]>();
  for(const driver of drivers(xml)){
    const id=driver.IORegistryEntryID;if(typeof id!=='number')continue;
    const names:string[]=[];
    const walk=(node:any)=>{
      if(!node||typeof node!=='object')return;
      const name=node['BSD Name'];
      if(typeof name==='string'&&node.Whole===true){const disk=wholeDisk(name);if(disk&&!names.includes(disk))names.push(disk);return;}
      for(const child of Array.isArray(node.IORegistryEntryChildren)?node.IORegistryEntryChildren:[])walk(child);
    };
    walk(driver);
    result.set(id,names);
  }
  return result;
}

export interface Rates {utilization:number;readBps:number;writeBps:number;iops:number;}
/** Rates over the interval between two cumulative readings; undefined when the interval is unusable
 * or a counter went backwards (the disk was re-attached). Total Time is I/O time summed over
 * concurrent requests, so busy time above wall time is capped to 100%. */
export function computeRates(previous:Counters,current:Counters,seconds:number):Rates|undefined {
  if(!(seconds>0))return undefined;
  const delta=(key:keyof Counters)=>current[key]-previous[key];
  const keys=Object.keys(current) as (keyof Counters)[];
  if(keys.some(key=>delta(key)<0))return undefined;
  const busyNs=delta('readNs')+delta('writeNs');
  return {utilization:Math.min(100,Math.max(0,busyNs/(seconds*1e9)*100)),readBps:delta('readBytes')/seconds,writeBps:delta('writeBytes')/seconds,iops:(delta('readOps')+delta('writeOps'))/seconds};
}

export interface DriveSampler {
  setTargets(targets:Record<string,string[]>):void;
  /** One reading; the activity of every target (empty until a second reading gives a delta). */
  sample():Promise<Record<string,DriveActivity>>;
}
export interface SamplerOptions {
  /** Runs ioreg; `withMedia` adds -l so IOMedia children (BSD names) are included. */
  run(withMedia:boolean):Promise<string>;
  now?():number;
  historyLength?:number;
  /** Minimum time between media listings, which are the costly form of the call. */
  mediaRetryMs?:number;
}
export function createDriveSampler(options:SamplerOptions):DriveSampler {
  const now=options.now??(()=>performance.now()),length=options.historyLength??HISTORY_LENGTH,retry=options.mediaRetryMs??10000;
  let targets:Record<string,string[]>={},diskMap=new Map<number,string[]>(),lastMedia=-Infinity;
  const previous=new Map<string,{at:number;counters:Counters}>(),history=new Map<string,number[]>(),latest=new Map<string,Rates>();
  return {
    setTargets(next){targets=next;},
    async sample(){
      const wanted=new Set(Object.values(targets).flat());
      if(!wanted.size)return {};
      let at=now(),stats=parseStatistics(await options.run(false));
      const mapped=new Set([...diskMap.values()].flat());
      const stale=[...stats.keys()].some(id=>!diskMap.has(id))||[...diskMap.keys()].some(id=>!stats.has(id));
      if((stale||[...wanted].some(disk=>!mapped.has(disk)))&&at-lastMedia>=retry){
        const xml=await options.run(true);at=now();lastMedia=at;
        diskMap=parseDiskMap(xml);stats=parseStatistics(xml);
      }
      // A disk with several drivers (rare) adds their counters.
      const byDisk=new Map<string,Counters>();
      for(const [id,counters] of stats)for(const disk of diskMap.get(id)??[]){
        if(!wanted.has(disk))continue;
        const sum=byDisk.get(disk);
        byDisk.set(disk,sum?Object.fromEntries((Object.keys(sum) as (keyof Counters)[]).map(key=>[key,sum[key]+counters[key]])) as unknown as Counters:{...counters});
      }
      for(const disk of [...previous.keys()])if(!wanted.has(disk)){previous.delete(disk);history.delete(disk);latest.delete(disk);}
      for(const [disk,counters] of byDisk){
        const before=previous.get(disk);previous.set(disk,{at,counters});
        if(!before)continue;
        const rates=computeRates(before.counters,counters,(at-before.at)/1000);
        if(!rates){history.delete(disk);latest.delete(disk);continue;}
        latest.set(disk,rates);
        const list=history.get(disk)??[];list.push(Math.round(rates.utilization));history.set(disk,list.slice(-length));
      }
      const result:Record<string,DriveActivity>={};
      for(const [key,disks] of Object.entries(targets)){
        const present=disks.filter(disk=>latest.has(disk));
        if(!present.length)continue;
        const rates=present.map(disk=>latest.get(disk)!),lists=present.map(disk=>history.get(disk)!);
        const size=Math.max(...lists.map(list=>list.length));
        result[key]={
          utilization:Math.round(Math.max(...rates.map(r=>r.utilization))),
          readBps:Math.round(rates.reduce((sum,r)=>sum+r.readBps,0)),
          writeBps:Math.round(rates.reduce((sum,r)=>sum+r.writeBps,0)),
          iops:Math.round(rates.reduce((sum,r)=>sum+r.iops,0)),
          history:Array.from({length:size},(_,index)=>Math.max(...lists.map(list=>list[list.length-size+index]??0))),
        };
      }
      return result;
    },
  };
}
/** One ioreg call covers every disk; without -l it is a small listing of statistics only. */
export async function runIoreg(withMedia:boolean):Promise<string> {
  const {stdout}=await exec('/usr/sbin/ioreg',['-c','IOBlockStorageDriver','-r','-w0',...(withMedia?['-l']:[]),'-a'],{timeout:5000,maxBuffer:16*1024*1024,windowsHide:true});
  return stdout;
}

/** The whole disks behind every connected source (keyed by source id) and destination (keyed by its path):
 * a folder maps to the volume it lives on. Cameras and unknown volumes have no entry. */
export function activityTargets(volumes:Pick<MountedVolume,'path'|'physicalId'>[],sources:Pick<Source,'id'|'path'|'transport'>[],destinations:Pick<DestinationStatus,'path'|'physicalId'|'available'>[]):Record<string,string[]> {
  const volumeOf=(target:string)=>volumes.filter(volume=>within(target,volume.path)).sort((a,b)=>b.path.length-a.path.length)[0];
  const result:Record<string,string[]>={};
  for(const source of sources){
    if(source.transport==='camera')continue;
    const disks=wholeDisks(volumeOf(source.path)?.physicalId);
    if(disks.length)result[source.id]=disks;
  }
  for(const destination of destinations){
    if(!destination.available)continue;
    const disks=wholeDisks(destination.physicalId??volumeOf(destination.path)?.physicalId);
    if(disks.length)result[destination.path]=disks;
  }
  return result;
}

export interface ActivityLoopOptions {
  sampler:DriveSampler;
  /** True while the window is visible or a job, scan or review runs; the loop stops entirely otherwise. */
  wanted():boolean;
  publish(activity:Record<string,DriveActivity>):void;
  intervals?:{fast:number};
  timers?:{set(fn:()=>void,ms:number):ReturnType<typeof setTimeout>;clear(handle:ReturnType<typeof setTimeout>):void};
}
/** Samples every second while wanted and publishes only when a shown value changed. When nothing is
 * wanted (window hidden or minimized, no work) no timer is left running; wake() restarts it. */
export function startActivityLoop(options:ActivityLoopOptions):{stop():void;tick():Promise<void>;wake():void} {
  const interval=options.intervals?.fast??1000;
  const timers=options.timers??{set:(fn,ms)=>{const handle=setTimeout(fn,ms);handle.unref?.();return handle;},clear:handle=>clearTimeout(handle)};
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,running=false,last='';
  async function tick(){
    try{
      const activity=await options.sampler.sample();
      const signature=JSON.stringify(activity);
      if(signature!==last){last=signature;options.publish(activity);}
    }catch{/* The meter is optional: a failed reading just leaves the last values. */}
  }
  function loop(){
    timer=undefined;
    if(stopped||running)return;
    if(!options.wanted())return;
    running=true;
    void tick().finally(()=>{running=false;if(!stopped&&options.wanted())timer=timers.set(loop,interval);});
  }
  function wake(){if(stopped||running||timer!==undefined)return;loop();}
  loop();
  return {stop(){stopped=true;if(timer!==undefined)timers.clear(timer);timer=undefined;},tick,wake};
}
