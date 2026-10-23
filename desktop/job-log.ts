import {log} from './logger';
import type {DestinationStatus,DriveActivity,Job,Progress,Source} from './shared';
import type {MountedVolume} from './platform/volumes';

const terminal=new Set<Job['phase']>(['complete','stopped','error']);

/** Records every job phase start and end (counts, bytes, duration, rate) as the state is published; repeated calls with an unchanged phase log nothing. */
export class PhaseLog {
 private seen=new Map<string,{phase:Job['phase'];at:number;progress?:Progress}>();
 observe(jobs:readonly Job[],now:number){
  for(const job of jobs){
   const before=this.seen.get(job.id);
   if(before?.phase===job.phase){before.progress=job.progress??before.progress;continue;}
   if(!before&&job.phase==='queued'){this.seen.set(job.id,{phase:job.phase,at:now});log('normal','job','queued',{source:job.source.name,path:job.source.path,transport:job.source.transport,organization:!!job.organization,backup:job.backup},job.id);continue;}
   if(before&&before.phase!=='queued')this.end(job,before,now);
   this.seen.set(job.id,{phase:job.phase,at:now});
   if(terminal.has(job.phase))log('normal','job','job-end',{result:job.phase,errors:job.errors.length,copied:job.progress?.completed,startedAt:job.startedAt,paused:job.paused===true},job.id);
   else log('normal','job','phase-start',{phase:job.phase,source:job.source.name,path:job.source.path,transport:job.source.transport,organization:!!job.organization,backup:job.backup,...(before?{previous:before.phase}:{})},job.id);
  }
  if(this.seen.size>jobs.length*2+20){const live=new Set(jobs.map(job=>job.id));for(const id of this.seen.keys())if(!live.has(id))this.seen.delete(id);}
 }
 private end(job:Job,before:{phase:Job['phase'];at:number;progress?:Progress},now:number){
  const ms=Math.max(0,now-before.at),progress=before.progress??job.progress,seconds=ms/1000;
  log('normal','job','phase-end',{phase:before.phase,next:job.phase,ms,...(progress?{step:progress.step,completed:progress.completed,total:progress.total,bytes:progress.bytes,totalBytes:progress.totalBytes,...(seconds>0?{filesPerSecond:Math.round(progress.completed/seconds*100)/100,bytesPerSecond:Math.round(progress.bytes/seconds)}:{})}:{})},job.id);
 }
}

/** A snapshot of each running step, for the five-second log lines. */
export function logProgress(jobs:readonly Job[]){
 for(const job of jobs){
  if(!['discovering','verifying','copying'].includes(job.phase))continue;
  const progress=job.progress;
  log('detailed','job','progress',{phase:job.phase,step:progress?.step,stepPhase:progress?.phase,completed:progress?.completed,total:progress?.total,failed:progress?.failed,bytes:progress?.bytes,totalBytes:progress?.totalBytes,speed:progress?.speed,share:progress?.share,eta:progress?.eta??job.eta,file:progress?.file,fraction:job.fraction,errors:job.errors.length},job.id);
 }
}

/** Mounts, unmounts, drive identities, connected sources and destination status, logged when they change. */
export class TopologyLog {
 private mounts=new Map<string,string>();private sources=new Map<string,string>();private destinations=new Map<string,string>();private first=true;
 observe(volumes:readonly MountedVolume[],sources:readonly Source[],destinations:readonly DestinationStatus[]){
  const now=new Map(volumes.map(volume=>[volume.path,JSON.stringify([volume.volumeId,volume.physicalId,volume.fsType])]));
  for(const volume of volumes)if(!this.mounts.has(volume.path))log('detailed','volume','mounted',{path:volume.path,name:volume.name,volumeId:volume.volumeId,physicalId:volume.physicalId,fsType:volume.fsType,removable:volume.removable,external:volume.external,virtual:volume.virtual,diskImage:volume.diskImage,readOnly:volume.readOnly,totalBytes:volume.total,freeBytes:volume.free,initial:this.first});
  else if(this.mounts.get(volume.path)!==now.get(volume.path))log('detailed','volume','identity-changed',{path:volume.path,volumeId:volume.volumeId,physicalId:volume.physicalId,fsType:volume.fsType});
  for(const path of this.mounts.keys())if(!now.has(path))log('detailed','volume','unmounted',{path});
  this.mounts=now;
  const found=new Map(sources.map(source=>[source.id,JSON.stringify([source.path,source.selected])]));
  for(const source of sources)if(!this.sources.has(source.id))log('detailed','volume','source-connected',{id:source.id,name:source.name,path:source.path,transport:source.transport,drive:source.drive?.volumeId,totalBytes:source.total,freeBytes:source.free});
  for(const id of this.sources.keys())if(!found.has(id))log('detailed','volume','source-disconnected',{id});
  this.sources=found;
  const status=new Map(destinations.map(item=>[item.path,JSON.stringify([item.available,item.volumeId])]));
  for(const item of destinations)if(this.destinations.get(item.path)!==status.get(item.path))log('detailed','volume','destination',{path:item.path,available:item.available,volumeId:item.volumeId,freeBytes:item.free,totalBytes:item.total,detail:item.detail});
  this.destinations=status;this.first=false;
 }
}

/** One summary line per ~5 seconds of drive activity: which drives are busy and how hard. */
export class ActivityLog {
 private last=0;
 observe(activity:Record<string,DriveActivity>,now:number,every=5000){
  if(now-this.last<every)return;this.last=now;
  const drives=Object.entries(activity);
  log('detailed','drive-activity','tick',{drives:drives.length,busy:drives.filter(([,item])=>item.utilization>0.05).length,items:drives.slice(0,12).map(([key,item])=>({key,utilization:Math.round(item.utilization*100)/100,readBps:item.readBps,writeBps:item.writeBps,iops:item.iops}))});
 }
}
