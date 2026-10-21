/** macOS OS-level failures on disposable exFAT images. Never selects a real disk. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {plan,execute} from '../desktop/core/index.ts';

const self=fileURLToPath(import.meta.url);
const options={backup:true,template:'{year}/{camera}',separateMedia:false,unknownRules:{}};
if(process.argv[2]==='--fixture-worker'){
 const [source,destination,stop]=process.argv.slice(3);
 try{
  const prepared=(await plan(source,[destination],options,async()=>{throw new Error('No metadata for backup');})).plans[0];
  let paused=false;
  const result=await execute(prepared,undefined,progress=>{
   if(stop==='pause'&&!paused&&progress.bytes>=1024*1024){paused=true;process.send?.({phase:'streaming',bytes:progress.bytes});process.kill(process.pid,'SIGSTOP');}
  });
  process.send?.({phase:'finished',result});process.disconnect?.();
 }catch(error){process.send?.({phase:'failed',error:String(error)});process.disconnect?.();process.exitCode=1;}
}else{
 assert.equal(process.platform,'darwin','Disposable image tests require macOS hdiutil');
 const template=process.argv[2]?.startsWith('--image-template=')?process.argv[2].slice('--image-template='.length):undefined;
 if(template){
  assert.ok(template.startsWith('/private/tmp/photo-importer-fault-ui-')&&template.endsWith('/fault-fixture.dmg'),'Only a newly created temporary fixture image may be used');
  assert.equal(await fs.realpath(template),template);assert.ok((await fs.lstat(template)).isFile());
 }
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'photo-importer-fault-volumes-')));
 const report=path.resolve('build/failure-modes/virtual-volumes-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
 await fs.mkdir(path.dirname(report),{recursive:true});
 const checks:{name:string;passed:boolean;detail?:unknown;error?:string}[]=[];
 const hash=async(file:string)=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
 const command=(bin:string,args:string[],timeout=30000)=>new Promise<string>((resolve,reject)=>{
  const child=spawn(bin,args,{stdio:['ignore','pipe','pipe']});let out='',err='';
  child.stdout.on('data',data=>{out+=data;});child.stderr.on('data',data=>{err+=data;});
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`${bin} timed out: ${err}`));},timeout);
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',code=>{clearTimeout(timer);code===0?resolve(out):reject(new Error(`${bin} exited ${code}: ${err}`));});
 });
 const entities=(xml:string)=>[...xml.matchAll(/<dict>((?:(?!<dict>)[\s\S])*?)<\/dict>/g)].map(match=>{
  const field=(key:string)=>match[1].match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1];
  return {device:field('dev-entry'),mount:field('mount-point')};
 });
 const dictionaries=(xml:string)=>{
  const stack:number[]=[],blocks:string[]=[];
  for(const match of xml.matchAll(/<\/?dict>/g)){
   if(match[0]==='<dict>')stack.push(match.index!);
   else{const start=stack.pop();if(start!==undefined)blocks.push(xml.slice(start,match.index!+match[0].length));}
  }
  return blocks;
 };
 async function volume(){
  const id=randomUUID(),image=path.join(base,id+'.dmg'),mount=path.join(base,id+'-mount');
  await fs.mkdir(mount);
  if(template){
   const mounted=await command('/usr/bin/hdiutil',['info','-plist']);
   assert.ok(!dictionaries(mounted).some(block=>block.match(/<key>image-path<\/key>\s*<string>([^<]+)<\/string>/)?.[1]===template),'The blank fixture template must be unmounted before copying');
   await fs.copyFile(template,image,fs.constants.COPYFILE_EXCL);
  }else await command('/usr/sbin/diskutil',['image','create','blank','--size','67108864','--fs','ExFAT','--volumeName','ImporterFaultFixture',image]);
  let device='';
  const attach=async()=>{
   await fs.mkdir(mount,{recursive:true});
   const result=entities(await command('/usr/bin/hdiutil',['attach','-nobrowse','-mountpoint',mount,'-plist',image]));
   assert.ok(result.some(item=>item.mount===mount),'The created image must mount at our unique fixture path');
   device=result.find(item=>/^\/dev\/disk\d+$/.test(item.device??''))?.device??'';
   assert.match(device,/^\/dev\/disk\d+$/);
   assert.notEqual((await fs.stat(mount)).dev,(await fs.stat(base)).dev,'Fixture must be a mounted filesystem');
  };
  const detach=async(force=false)=>{
   if(!device)return;
   // Revalidate the attachment belongs to our newly created image, never a user disk.
   const info=await command('/usr/bin/hdiutil',['info','-plist']);
   const imageBlock=dictionaries(info).find(block=>block.match(/<key>image-path<\/key>\s*<string>([^<]+)<\/string>/)?.[1]===image);
   assert.ok(imageBlock&&entities(imageBlock).some(item=>item.mount===mount)&&entities(imageBlock).some(item=>item.device===device),'Owned image attachment changed');
   await command('/usr/bin/hdiutil',['detach',...(force?['-force']:[]),device]);device='';
  };
  await attach();return {image,mount,attach,detach};
 }
 async function worker(source:string,destination:string,pause:boolean,onPaused?:()=>Promise<void>){
  const child=spawn(process.execPath,['--import','tsx',self,'--fixture-worker',source,destination,pause?'pause':'run'],{cwd:process.cwd(),stdio:['ignore','pipe','pipe','ipc']});
  let stderr='',finished:unknown,paused=false,detachError:unknown;
  assert.ok(child.stderr,'Fixture worker must have a captured stderr pipe');
  child.stderr.on('data',data=>{stderr+=data;});
  return new Promise<any>((resolve,reject)=>{
   const timer=setTimeout(()=>{child.kill('SIGCONT');child.kill('SIGKILL');reject(new Error('Fixture copy did not settle after OS failure: '+stderr));},45000);
   child.on('message',async(message:any)=>{
    if(message.phase==='streaming'){
     paused=true;try{await onPaused?.();}catch(error){detachError=error;}finally{child.kill('SIGCONT');}
    }else finished=message;
   });
   child.once('error',error=>{clearTimeout(timer);reject(error);});
   child.once('exit',(code,signal)=>{
    clearTimeout(timer);if(detachError)return reject(detachError);
    if(pause&&!paused)return reject(new Error('Copy never reached the live streaming checkpoint: '+stderr));
    if(!finished)return reject(new Error(`No fixture result (${code}/${signal}): ${stderr}`));
    resolve(finished);
   });
  });
 }
 async function run(name:string,work:()=>Promise<unknown>){
  try{const detail=await work();checks.push({name,passed:true,detail});console.log(JSON.stringify({name,passed:true}));}
  catch(error){checks.push({name,passed:false,error:String(error)});console.error(JSON.stringify({name,passed:false,error:String(error)}));}
 }
 for(const side of ['source','destination'] as const)await run(`force-detach disposable exFAT ${side} during copying, then reattach and retry`,async()=>{
  const disk=await volume(),local=path.join(base,randomUUID());await fs.mkdir(local);
  const source=side==='source'?path.join(disk.mount,'source'):path.join(local,'source');
  const destination=side==='destination'?path.join(disk.mount,'destination'):path.join(local,'destination');
  await fs.mkdir(source);await fs.mkdir(destination);
  const original=path.join(source,'original.bin'),marker=path.join(destination,'keep.txt');
  await fs.writeFile(original,Buffer.alloc(12*1024*1024,77));await fs.writeFile(marker,'preexisting fixture');
  const before=await hash(original),markerBefore=await hash(marker);
  try{
   const result=await worker(source,destination,true,()=>disk.detach(true));
   assert.ok(result.phase==='failed'||result.result?.errors?.length,'Disconnect must not report success');
   await disk.attach();assert.equal(await hash(original),before);assert.equal(await hash(marker),markerBefore);
   await assert.rejects(fs.stat(path.join(destination,'original.bin')),{code:'ENOENT'});
   const retry=await worker(source,destination,false);assert.equal(retry.phase,'finished');assert.deepEqual(retry.result,{copied:1,skipped:0,errors:[]});
   assert.equal(await hash(path.join(destination,'original.bin')),before);assert.equal(await hash(original),before);assert.equal(await hash(marker),markerBefore);
   return {failure:result,retry:retry.result,sha256:before};
  }finally{await disk.detach(true);}
 });
 await run('real exFAT capacity exhaustion fails without publication and succeeds on a larger destination',async()=>{
  const disk=await volume(),source=path.join(base,'full-source');await fs.mkdir(source);
  const original=path.join(source,'large.bin');await fs.writeFile(original,Buffer.alloc(72*1024*1024,81));
  await fs.writeFile(path.join(disk.mount,'keep.txt'),'preexisting fixture');const before=await hash(original);
  try{
   const result=await worker(source,disk.mount,false);assert.equal(result.phase,'finished');assert.equal(result.result.copied,0);assert.ok(result.result.errors.length);assert.match(result.result.errors.join(' '),/ENOSPC|space/i);
   assert.equal(await hash(original),before);assert.equal(await fs.readFile(path.join(disk.mount,'keep.txt'),'utf8'),'preexisting fixture');await assert.rejects(fs.stat(path.join(disk.mount,'large.bin')),{code:'ENOENT'});
   const larger=path.join(base,'larger-destination');await fs.mkdir(larger);const retry=await worker(source,larger,false);assert.deepEqual(retry.result,{copied:1,skipped:0,errors:[]});assert.equal(await hash(path.join(larger,'large.bin')),before);
   return {failure:result.result,retry:retry.result,sha256:before};
  }finally{await disk.detach(true);}
 });
 const summary={at:new Date().toISOString(),passed:checks.every(check=>check.passed),base,checks,limitations:['Disposable disk images, not physical camera-card or SSD unplug tests.','SIGSTOP checkpoints permit deterministic OS detach mid-stream; this does not remove volatile device caches or emulate electrical power loss.']};
 await fs.writeFile(report,JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({passed:summary.passed,report,base}));if(!summary.passed)process.exitCode=1;
}
