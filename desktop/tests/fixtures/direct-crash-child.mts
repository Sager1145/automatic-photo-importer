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
const [source,root,mode]=process.argv.slice(2) as [string,string,string];
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const die=():Promise<never>=>{process.kill(process.pid,'SIGKILL');return new Promise<never>(()=>{});};
const media=(file:string)=>/^DSC_/.test(path.basename(file))&&file.startsWith(root+path.sep);
const receipt=(file:string)=>path.basename(file).startsWith('photo-importer-intent-');
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
    if(name&&receipt(name)&&mode==='torn-r1')await die();
    return writeFile.apply(this,args);
  };
};
const open=fsPatchable.open.bind(fsPatchable),unlink=fsPatchable.unlink.bind(fsPatchable);
fsPatchable.open=async(...args:Parameters<typeof fs.open>)=>{
  const file=String(args[0]);
  if(mode==='before-r1'&&args[1]==='wx'&&receipt(file))await die();
  if(mode==='after-r1'&&args[1]==='wx'&&media(file))await die();
  // The check read of a finished copy: the only time the app reads a backup file by name before it is done.
  if(mode==='full-unverified'&&(args[1]===undefined||typeof args[1]==='number')&&media(file))await die();
  const handle=await open(...args);
  names.set(handle,file);patchHandle(handle);
  if(mode==='after-open'&&args[1]==='wx'&&media(file))await die();
  return handle;
};
fsPatchable.unlink=async(...args:Parameters<typeof fs.unlink>)=>{
  const file=String(args[0]);
  // Only the removal of a receipt of a file whose data and dates are already flushed (its folder entry is flushed right after that) counts.
  const settled=receipt(file)&&await fsPatchable.readFile(file,'utf8').then(text=>flushed.has(JSON.parse(text).file as string),()=>false);
  if(mode==='after-p'&&settled)await die();
  await unlink(...args);
  if(mode==='after-unlink'&&settled)await die();
};
syncBuiltinESMExports();
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const reviewed=(await plan(source,[root],options,async()=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}}))).plans[0]!;
await execute(reviewed);
console.log('finished without crash');
process.exit(0);
