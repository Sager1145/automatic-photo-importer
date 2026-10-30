/** SIGKILL at every kill point of the process-crash worker, on a real volume, then recovery in a fresh process. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import type {Context} from '../harness.mts';

export const title='Process-kill (SIGKILL) at every import/organize/finalize kill point, then recovery';

const WORKER=fileURLToPath(new URL('../../../desktop/tests/fixtures/process-crash-worker.mts',import.meta.url));
const REPO=path.resolve(path.dirname(WORKER),'../../..');
type Msg={type:'checkpoint'|'result';file?:string;bytesWritten?:number;target?:string;result?:{copied?:number;skipped?:number;errors?:string[];moved?:number;removed?:number;finalized?:number;restored?:number};jobs?:{id:string;status:string}[]};

export default async function run(ctx:Context):Promise<void>{
 const {libraryBox,check,scenario,skip,gMkdir,gWrite,fileSha,sha,exists,newDir}=ctx;
 const data=Buffer.concat([Buffer.from('precious media prefix\n'),randomBytes(2*1024*1024),Buffer.from('\nprecious media suffix')]);
 const expected=sha(data),prefix=sha(data.subarray(0,4093));
 const foreign='pre-existing foreign file';
 let counter=0;

 /** Spawns the worker; with kill=true SIGKILLs it at its first checkpoint. reached=false when it finished without one. */
 const worker=(mode:string,base:string,kill=false,id?:string,env?:Record<string,string>):Promise<{msg?:Msg;reached:boolean;code:number|null;signal:string|null;stderr:string}>=>new Promise((resolve,reject)=>{
  const child=fork(WORKER,[mode,base,...(id?[id]:[])],{execArgv:['--import','tsx'],silent:true,cwd:REPO,env:{...process.env,...env}});
  let stderr='',msg:Msg|undefined,reached=false;
  child.stderr?.on('data',c=>{stderr+=c;});child.stdout?.resume();
  const deadline=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`worker ${mode} timed out: ${stderr}`));},60_000);
  child.on('error',e=>{clearTimeout(deadline);reject(e);});
  child.on('message',(v:Msg)=>{msg=v;if(v.type==='checkpoint'){reached=true;if(kill)child.kill('SIGKILL');}});
  child.on('close',(code,signal)=>{clearTimeout(deadline);resolve({msg,reached,code,signal,stderr});});
 });
 const normal=async(mode:string,base:string,id?:string,env?:Record<string,string>)=>{const r=await worker(mode,base,false,id,env);if(r.msg?.type!=='result'||r.code!==0)throw new Error(`worker ${mode} failed (code ${r.code}): ${r.stderr.slice(-800)}`);return r.msg;};

 const visible=async(folder:string)=>(await fs.readdir(folder)).filter(n=>!n.startsWith('photo-importer-index')&&n!=='Photo Importer Data'&&!n.startsWith('._'));
 const allFiles=async(dir:string)=>{
  const out=new Map<string,string>();
  for(const e of await fs.readdir(dir,{withFileTypes:true,recursive:true})){
   if(!e.isFile()||e.name.startsWith('._'))continue;
   const f=path.join(e.parentPath,e.name);out.set(path.relative(dir,f),await fileSha(f));
  }
  return out;
 };
 /** Media = everything outside the app's records and the worker's own marker files. */
 const media=async(base:string)=>{const m=await allFiles(base);for(const k of [...m.keys()])if(k.split(path.sep).includes('Photo Importer Data')||path.basename(k).startsWith('finally-')||path.basename(k).startsWith('photo-importer-index'))m.delete(k);return m;};
 const residue=async(base:string,allowed:RegExp[])=>[...(await allFiles(base)).keys()].filter(k=>/partial|\.tmp|incomplete|stage-|\.import-/i.test(path.basename(k))||k.includes('Staging')).filter(k=>!allowed.some(a=>a.test(k)));

 const fixture=async()=>{
  const base=await newDir(libraryBox,`process-crash-${++counter}-${randomBytes(3).toString('hex')}`);
  const source=path.join(base,'source'),destination=path.join(base,'destination'),library=path.join(base,'library');
  await gMkdir(source);await gMkdir(destination);await gMkdir(path.join(library,'incoming'));
  const original=path.join(library,'incoming','A.JPG');
  await gWrite(path.join(source,'A.bin'),data);await gWrite(original,data);
  await gWrite(path.join(destination,'keep.txt'),foreign);await gWrite(path.join(library,'keep.txt'),foreign);
  return {base,source,destination,library,original,target:path.join(library,'2024','202402','FixtureCamera','JPEG','A.JPG')};
 };
 const operation=async(library:string)=>{
  const storage=path.join(library,'Photo Importer Data','Organizations'),[id]=await visible(storage);
  if(!id)throw new Error('no organization record in '+storage);
  return {id,folder:path.join(storage,id)};
 };
 const retained=async(folder:string)=>{
  const entry=path.join(folder,'originals','0');
  for(const slot of await visible(entry)){const files=await visible(path.join(entry,slot));if(files.length)return path.join(entry,slot,files[0]!);}
  throw new Error('no retained original');
 };
 const marker=async(base:string,mode:string)=>!await exists(path.join(base,`finally-${mode}`));
 const hashOf=(f:string)=>fileSha(f).catch(()=>'(missing)');

 // ---- import kill points ----------------------------------------------------------------------------------------
 for(const mode of ['import-stage','import-exclusive'])await scenario(`${mode}: SIGKILL after the first chunk, fresh-process retry resumes the owned partial`,async()=>{
  // On exFAT execute() writes straight to the destination (direct mode), which is the import-exclusive kill point; import-stage needs the staged path forced.
  const env=mode==='import-stage'?{CRASH_STAGED_IMPORT:'1'}:undefined,f=await fixture(),unowned=path.join(f.destination,'.import-unowned.partial');await gWrite(unowned,'foreign partial');
  const sourceBefore=await hashOf(path.join(f.source,'A.bin'));
  const stopped=await worker(mode,f.base,true,undefined,env);
  check(`${mode}: killed at checkpoint by SIGKILL`,stopped.reached&&stopped.signal==='SIGKILL',{reached:stopped.reached,signal:stopped.signal,stderr:stopped.stderr.slice(-300)});
  if(!stopped.reached)return;
  check(`${mode}: no finally block ran`,await marker(f.base,mode));
  check(`${mode}: partial holds exactly the first 4093-byte chunk`,stopped.msg?.bytesWritten===4093&&!!stopped.msg.file&&await hashOf(stopped.msg.file)===prefix,{file:stopped.msg?.file,bytes:stopped.msg?.bytesWritten});
  const owned=stopped.msg?.file?await fs.lstat(stopped.msg.file,{bigint:true}):undefined;
  const retry=await normal('retry-import',f.base,undefined,env);
  check(`${mode}: retry copied 1, no errors`,JSON.stringify(retry.result)===JSON.stringify({copied:1,skipped:0,errors:[]}),retry.result);
  check(`${mode}: retry completed A.bin with source bytes`,retry.target===path.join(f.destination,'A.bin')&&await hashOf(retry.target!)===expected,retry.target);
  if(owned&&mode==='import-exclusive')check(`${mode}: owned partial resumed in the same inode (not recopied)`,(await fs.lstat(retry.target!,{bigint:true})).ino===owned.ino);
  check(`${mode}: destination holds only A.bin, keep.txt and the foreign partial`,JSON.stringify((await visible(f.destination)).sort())===JSON.stringify(['.import-unowned.partial','A.bin','keep.txt']),await visible(f.destination));
  check(`${mode}: foreign files untouched`,await fs.readFile(unowned,'utf8')==='foreign partial'&&await fs.readFile(path.join(f.destination,'keep.txt'),'utf8')===foreign);
  check(`${mode}: source untouched`,await hashOf(path.join(f.source,'A.bin'))===sourceBefore&&sourceBefore===expected);
  const again=await normal('retry-import',f.base,undefined,env);
  check(`${mode}: a second re-run copies nothing`,again.result?.copied===0&&(again.result?.errors??[]).length===0,again.result);
  check(`${mode}: still exactly one copy of the media`,[...(await media(f.destination)).values()].filter(h=>h===expected).length===1);
  const left=await residue(f.base,[/\.import-unowned\.partial$/]);
  check(`${mode}: no stray temp/partial residue`,left.length===0,left);
 });

 await scenario('import-stage: foreign file now at the target, old partial kept, retry picks another name',async()=>{
  const mode='import-stage',f=await fixture();
  const stopped=await worker(mode,f.base,true,undefined,{CRASH_STAGED_IMPORT:'1'});
  if(!stopped.reached||!stopped.msg?.file)return check('import-stage reached its kill point',false,stopped.stderr.slice(-300));
  const foreignTarget=path.join(f.destination,'A.bin');await gWrite(foreignTarget,foreign);
  const retry=await normal('retry-import',f.base,undefined,{CRASH_STAGED_IMPORT:'1'});
  check('retry copied 1, no errors',JSON.stringify(retry.result)===JSON.stringify({copied:1,skipped:0,errors:[]}),retry.result);
  check('retry used a different name and the right bytes',!!retry.target&&retry.target!==foreignTarget&&await hashOf(retry.target)===expected,retry.target);
  check('foreign A.bin untouched',await fs.readFile(foreignTarget,'utf8')===foreign);
  check('source untouched',await hashOf(path.join(f.source,'A.bin'))===expected);
 });

 // ---- organization kill points ----------------------------------------------------------------------------------
 for(const mode of ['organization-exclusive','organization-exclusive-synced','organization-publish','organization-stash'])await scenario(`${mode}: SIGKILL, resume in a new process`,async()=>{
  const f=await fixture(),mediaBefore=await media(f.library);
  const stopped=await worker(mode,f.base,true);
  if(!stopped.reached){
   // On exFAT there are no hard links: kill points that follow a successful fs.link cannot occur on this volume.
   skip(`${mode} kill point`,`worker finished without reaching it (code ${stopped.code}); stderr: ${stopped.stderr.slice(-200)||'(none)'}; result ${JSON.stringify(stopped.msg?.result)}`);
   return;
  }
  check(`${mode}: killed by SIGKILL, no finally`,stopped.signal==='SIGKILL'&&await marker(f.base,mode));
  const job=await operation(f.library),unowned=path.join(job.folder,'stage-unowned.partial');await gWrite(unowned,'unowned stage');
  const exclusive=mode.startsWith('organization-exclusive'),synced=mode==='organization-exclusive-synced',partialHash=synced?expected:prefix;
  if(exclusive){
   const st=await fs.lstat(f.target,{bigint:true}),jl=(await fs.readFile(path.join(job.folder,'journal.jsonl'),'utf8')).split('\n').filter(Boolean).map(l=>JSON.parse(l)).filter(l=>l.event==='exclusive-created');
   console.log(`INFO ${mode}: actual target ino=${st.ino} size=${st.size}; journal exclusive-created records: ${JSON.stringify(jl.map(l=>l.stat?.ino))}`);
   check(synced?'exclusive-synced: target holds the complete bytes (stopped after the first data sync + second checkpoint)':'exclusive: target holds exactly the first chunk',(synced||stopped.msg?.bytesWritten===4093)&&await hashOf(f.target)===partialHash,{bytes:stopped.msg?.bytesWritten,target:await hashOf(f.target)});
   if(synced)check('exclusive-synced: a second exclusive-created record names the settled inode',jl.some(l=>String(l.stat?.ino)===String(st.ino)),{ino:String(st.ino),records:jl.map(l=>l.stat?.ino)});
   check('exclusive: original still intact',await hashOf(f.original)===expected);
  }else{
   check(`${mode}: target already holds full bytes`,await hashOf(f.target)===expected);
   if(mode==='organization-publish')check('publish: original still present',await hashOf(f.original)===expected);
   if(mode==='organization-stash')check('stash: original already moved to the stash',!await exists(f.original));
  }
  if(mode==='organization-exclusive'){
   // exFAT hands an empty file a temporary inode that changes at the first data sync; killed before it, the journal holds only that
   // temporary inode, so the partial cannot be recognized as ours (found on real exFAT; tmpfs keeps one inode so the unit test passes).
   const retry=await normal('resume-organization',f.base,job.id);
   const owned=(retry.result?.errors??[]).length===0&&retry.result?.moved===1&&retry.jobs?.[0]?.status==='complete';
   check('organization-exclusive: owned partial killed before its first data sync is recognized and resume completes (exFAT temporary inode)',owned,{errors:retry.result?.errors,job:retry.jobs?.[0]?.status,journalInodes:'see INFO line above'});
   // Safety, whatever recognition does: nothing lost, the original and the foreign files untouched.
   check('organization-exclusive: original intact and no media lost after the refused/finished resume',await hashOf(f.original).then(h=>h===expected)||await hashOf(await retained(job.folder).catch(()=>'/nonexistent'))===expected);
   check('organization-exclusive: unowned stage file and library keep.txt untouched',await fs.readFile(unowned,'utf8')==='unowned stage'&&await fs.readFile(path.join(f.library,'keep.txt'),'utf8')===foreign);
   if(!owned){
    const undone=await normal('undo-organization',f.base,job.id);
    console.log('INFO organization-exclusive: undo of the stuck job ->',JSON.stringify({restored:undone.result?.restored,errors:undone.result?.errors,jobs:undone.jobs?.length}),'original',await hashOf(f.original)===expected?'intact':'CHANGED','target',await exists(f.target)?`still there (${(await fs.stat(f.target)).size} bytes)`:'gone');
    check('organization-exclusive: undo of the stuck job leaves the original intact',await hashOf(f.original)===expected);
   }
   return;
  }
  const retry=await normal('resume-organization',f.base,job.id);
  check(`${mode}: resume has no errors, moved 1, job complete`,(retry.result?.errors??[]).length===0&&retry.result?.moved===1&&retry.jobs?.[0]?.status==='complete',retry);
  check(`${mode}: target has the full bytes`,await hashOf(f.target)===expected);
  check(`${mode}: retained original has the full bytes`,await hashOf(await retained(job.folder).catch(()=>'/nonexistent'))===expected);
  check(`${mode}: unowned stage file and library keep.txt untouched`,await fs.readFile(unowned,'utf8')==='unowned stage'&&await fs.readFile(path.join(f.library,'keep.txt'),'utf8')===foreign);
  const after=await media(f.library),multiset=[...after.values()].sort();
  check(`${mode}: every media hash survived (nothing lost/corrupted)`,[...mediaBefore.values()].every(h=>after.size&&multiset.includes(h)),{before:[...mediaBefore.keys()],after:[...after.keys()]});
  let allowed=[/stage-unowned\.partial$/,/originals/,/Organizations[\\/][^\\/]+[\\/]stage-[0-9a-f-]{36}\.partial$/];   // a killed copy's own stage stays in its job folder (recognized by journalFile; removed with the job's records)
  if(exclusive){
   const incomplete=(await visible(job.folder)).filter(n=>n.startsWith('incomplete-'));
   if(synced)check('exclusive-synced: any kept incomplete-* file is exactly the owned bytes',incomplete.length<=1&&(!incomplete.length||await hashOf(path.join(job.folder,incomplete[0]!))===partialHash),incomplete);
   else check('exclusive: the owned prefix is kept as one documented incomplete-* file',incomplete.length===1&&await hashOf(path.join(job.folder,incomplete[0]!))===partialHash,incomplete);
   allowed=[...allowed,/incomplete-/];
  }
  const left=await residue(f.library,allowed);
  check(`${mode}: no undocumented residue`,left.length===0,left);
  const events=(await fs.readFile(path.join(job.folder,'journal.jsonl'),'utf8')).split('\n').filter(Boolean).map(l=>JSON.parse(l)).filter(l=>l.kind==='event').map(l=>l.event);
  check(`${mode}: receipts closed (journal has a completion event)`,events.some(e=>/complete|done|finish/i.test(String(e))||retry.jobs?.[0]?.status==='complete'),events);
  const again=await normal('resume-organization',f.base,job.id);
  check(`${mode}: second resume is a no-op`,(again.result?.errors??[]).length===0&&await hashOf(f.target)===expected);
 });

 // ---- finalize kill points --------------------------------------------------------------------------------------
 for(const mode of ['finalize-intent','finalize-unlink'])await scenario(`${mode}: SIGKILL during finalization, fresh finalization completes`,async()=>{
  const f=await fixture(),prepared=await normal('prepare-organization',f.base),id=prepared.jobs?.[0]?.id;
  if(!id)return check('prepare produced a job',false,prepared);
  const job=await operation(f.library),saved=await retained(job.folder).catch(()=>undefined);
  if(!saved)return check('prepare retained an original',false);
  const unowned=path.join(job.folder,'unowned-original.bin');await gWrite(unowned,foreign);
  const stopped=await worker(mode,f.base,true,id);
  if(!stopped.reached)return skip(`${mode} kill point`,`worker finished without reaching it (code ${stopped.code}): ${stopped.stderr.slice(0,700)}`);
  check(`${mode}: killed, no finally`,stopped.signal==='SIGKILL'&&await marker(f.base,mode));
  check(`${mode}: library copy intact`,await hashOf(f.target)===expected);
  if(mode==='finalize-intent')check('intent: retained original still there',await hashOf(saved)===expected);
  else check('unlink: retained original already gone',!await exists(saved));
  const events=(await fs.readFile(path.join(job.folder,'journal.jsonl'),'utf8')).split('\n').filter(Boolean).map(l=>JSON.parse(l)).filter(l=>l.kind==='event');
  check(`${mode}: durable finalize-intent, not yet finalized`,events.some(e=>e.event==='finalize-intent')&&!events.some(e=>e.event==='finalized'));
  const retry=await normal('retry-finalize',f.base,id);
  check(`${mode}: retry removes ${mode==='finalize-intent'?1:0} and finalizes 1, job complete`,retry.result?.removed===(mode==='finalize-intent'?1:0)&&retry.result?.finalized===1&&retry.jobs?.[0]?.status==='complete',retry.result);
  check(`${mode}: retained original gone, target intact`,!await exists(saved)&&await hashOf(f.target)===expected);
  check(`${mode}: unowned file untouched`,await fs.readFile(unowned,'utf8')===foreign);
  check(`${mode}: resume afterwards reports no errors`,((await normal('resume-organization',f.base,id)).result?.errors??[]).length===0);
  const left=await residue(f.library,[/unowned-original/]);
  check(`${mode}: no residue`,left.length===0,left);
 });

 // ---- rename-based organization (move) -------------------------------------------------------------------------
 for(const mode of ['organization-rename-link','organization-rename-unlink'])await scenario(`${mode}: SIGKILL mid-move, new process finishes it, undo restores`,async()=>{
  const f=await fixture(),before=await fs.lstat(f.original,{bigint:true});
  const stopped=await worker(mode,f.base,true);
  if(!stopped.reached)return skip(`${mode} kill point`,`worker finished without reaching it (exFAT has no hard links / rename path differs); result ${JSON.stringify(stopped.msg?.result)} stderr ${stopped.stderr.slice(-200)}`);
  check(`${mode}: killed, no finally`,stopped.signal==='SIGKILL'&&await marker(f.base,mode));
  const targetIno=(await fs.lstat(f.target,{bigint:true}).catch(()=>undefined))?.ino;
  check(`${mode}: no copy was made (same file identity at target)`,targetIno===before.ino,{targetIno,orig:before.ino});
  const job=await operation(f.library);
  const retry=await normal('resume-organization',f.base,job.id);
  check(`${mode}: resume moved 1, no errors, complete`,(retry.result?.errors??[]).length===0&&retry.result?.moved===1&&retry.jobs?.[0]?.status==='complete',retry);
  check(`${mode}: original gone, target has the bytes`,!await exists(f.original)&&await hashOf(f.target)===expected);
  check(`${mode}: no retained media copy in the recovery store`,!await exists(path.join(job.folder,'originals')));
  const undone=await normal('undo-organization',f.base,job.id);
  check(`${mode}: undo restored 1`,undone.result?.restored===1&&(undone.jobs??[]).length===0,undone);
  check(`${mode}: original back with its bytes, target gone`,await hashOf(f.original)===expected&&!await exists(f.target));
  const back=await fs.lstat(f.original,{bigint:true}).catch(()=>undefined);
  check(`${mode}: original mtime preserved`,back?.mtimeNs===before.mtimeNs,{back:back?.mtimeNs,before:before.mtimeNs});
  check(`${mode}: library keep.txt untouched`,await fs.readFile(path.join(f.library,'keep.txt'),'utf8')===foreign);
 });
}
