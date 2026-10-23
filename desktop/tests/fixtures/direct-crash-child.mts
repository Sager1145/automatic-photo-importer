import * as fs from 'node:fs/promises';
import fsPatchable from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {plan,execute,configureOrganizationRecovery} from '../../core/index';

// Copies a card onto an exFAT backup folder and kills itself with SIGKILL at one named point of the
// direct (no staging file) copy. The page cache survives a SIGKILL, so these model a crashed process,
// not a power cut. Points, in the order a file goes through them:
//   torn-r1      the creation receipt exists, empty            before-r1   nothing written yet
//   after-r1     R1 durable, the name not created              after-open  the empty name exists, no R2
//   after-r2     R2 durable, no data                           mid-stream  part of the data written
//   full-unverified  every byte written, nothing checked       after-times dates applied, not flushed
//   after-m      dates and data flushed, folder not            after-p     folder flushed, the finished file's receipts remain
//   after-unlink the first receipt of a finished file removed
// Records v5: receipts are sealed lines appended to Photo Importer Data/Imports/receipts-NNNNNN.jsonl (several may
// go in one append). R1 is an open line naming a media file not yet created ('creating'); removing a receipt is
// appending its close line.
const [source,root,mode]=process.argv.slice(2) as [string,string,string];
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const die=():Promise<never>=>{process.kill(process.pid,'SIGKILL');return new Promise<never>(()=>{});};
const media=(file:string)=>/^DSC_/.test(path.basename(file))&&file.startsWith(root+path.sep);
const segment=(file:string)=>/^receipts-\d{6}\.jsonl$/.test(path.basename(file));
/** The receipt lines an append writes, parsed (a line that is not JSON is skipped). */
const lines=(text:string)=>text.split('\n').flatMap(line=>{try{return [JSON.parse(line) as {op?:string;rid?:string;file?:string;fileIdentity?:string}];}catch{return [];}});
/** What each open receipt this process wrote names, by rid. */
const named=new Map<string,string>();
const names=new WeakMap<object,string>(),timed=new WeakSet<object>(),writes=new Map<string,number>(),flushed=new Set<string>();
let patched=false;
const patchHandle=(handle:Awaited<ReturnType<typeof fs.open>>)=>{
  if(patched)return;patched=true;
  const proto=Object.getPrototypeOf(handle) as Record<string,(...args:unknown[])=>Promise<unknown>>;
  const write=proto.write!,sync=proto.sync!,utimes=proto.utimes!,writeFile=proto.writeFile!;
  proto.write=async function(this:object,...args){
    const name=names.get(this);
    if(name&&media(name)){
      if(mode==='after-r2'&&!writes.has(name))await die();
      const count=(writes.get(name)??0)+1;writes.set(name,count);
      if(mode==='mid-stream'&&count===3)await die();
    }
    return write.apply(this,args);
  };
  proto.utimes=async function(this:object,...args){const result=await utimes.apply(this,args);const name=names.get(this);if(name&&media(name))timed.add(this);return result;};
  proto.sync=async function(this:object,...args){
    if(timed.has(this)&&mode==='after-times')await die();
    const result=await sync.apply(this,args);
    if(timed.has(this)){flushed.add(names.get(this)!);if(mode==='after-m')await die();}
    return result;
  };
  proto.writeFile=async function(this:object,...args){
    const name=names.get(this);
    if(!name||!segment(name))return writeFile.apply(this,args);
    const text=String(args[0]),written=lines(text);
    for(const line of written)if(line.op==='open'&&line.rid&&line.file)named.set(line.rid,line.file);
    const r1=written.some(line=>line.op==='open'&&line.fileIdentity==='creating'&&!!line.file&&media(line.file));
    // Only closing a receipt of a file whose data and dates are already flushed (its folder entry is flushed right after that) counts.
    const settled=written.some(line=>line.op==='close'&&!!line.rid&&flushed.has(named.get(line.rid)??''));
    if(r1&&mode==='before-r1')await die();
    if(r1&&mode==='torn-r1'){await writeFile.apply(this,[text.slice(0,Math.floor(text.length/2))]);await die();}
    if(settled&&mode==='after-p')await die();
    const result=await writeFile.apply(this,args);
    if(settled&&mode==='after-unlink')await die();
    return result;
  };
};
const open=fsPatchable.open.bind(fsPatchable);
fsPatchable.open=async(...args:Parameters<typeof fs.open>)=>{
  const file=String(args[0]);
  if(mode==='after-r1'&&args[1]==='wx'&&media(file))await die();
  // The check read of a finished copy: the only time the app reads a backup file by name before it is done.
  if(mode==='full-unverified'&&(args[1]===undefined||typeof args[1]==='number')&&media(file))await die();
  const handle=await open(...args);
  names.set(handle,file);patchHandle(handle);
  if(mode==='after-open'&&args[1]==='wx'&&media(file))await die();
  return handle;
};
syncBuiltinESMExports();
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const reviewed=(await plan(source,[root],options,async()=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}}))).plans[0]!;
await execute(reviewed);
console.log('finished without crash');
process.exit(0);
