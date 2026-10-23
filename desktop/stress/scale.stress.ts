// Long-running pressure tests: `npm run test:stress`. Sizes scale with STRESS_SCALE (default 1).
// Timings are printed as `STRESS {...}` lines and appended to build/stress-timings.jsonl.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as core from '../core/index';
import {metadata} from './fixtures/metadata';
import {assertCopied,diskImage,executeAll,fileSha,leftovers,listedExtensions,parts,put,temporary,tree} from '../tests/fixtures/edge';
import type {MediaLayout} from '../shared';

core.configureOrganizationRecovery('stress-fixture-host-recovery-secret-32bytes');
const scale=Number(process.env.STRESS_SCALE??1);
const count=(value:number)=>Math.max(1,Math.round(value*scale));
const repository=path.resolve(fileURLToPath(new URL('../..',import.meta.url)));
async function record(name:string,started:number,extra:Record<string,unknown>={}):Promise<void>{
 const line={name,seconds:Math.round((performance.now()-started)/100)/10,rssMB:Math.round(process.memoryUsage().rss/1048576),...extra};
 console.log('STRESS',JSON.stringify(line));
 await fs.mkdir(path.join(repository,'build'),{recursive:true});
 await fs.appendFile(path.join(repository,'build','stress-timings.jsonl'),JSON.stringify({at:new Date().toISOString(),...line})+'\n');
}
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'type-format' as const,unknownRules:{}};
const kinds=['JPG','NEF','MP4','HEIC','xmp','DNG','MOV','LRF'];
/** `files` small files across folders of 100, with a mix of formats and companions (each .xmp belongs to
 * the HEIC before it); `salt` varies the bytes. */
async function card(folder:string,files:number,salt=0):Promise<void>{
 for(let index=0;index<files;index++){
  const kind=kinds[index%kinds.length]!,name=kind==='LRF'||kind==='MP4'&&index%3===0?`DJI_${index}`:kind==='xmp'?`DSC_${index-1}`:`DSC_${index}`;
  await put(path.join(folder,`${100+Math.floor((kind==='xmp'?index-1:index)/100)}MEDIA`,`${name}.${kind}`),`${salt} ${index} ${'x'.repeat(index%2048)}`);
 }
}

test('scan, plan and backup-folder check of tens of thousands of small files',async t=>{
 const files=count(30000),root=await temporary(t,'stress-scan-'),source=path.join(root,'card'),drive=path.join(root,'drive');
 let started=performance.now();await card(source,files);await fs.mkdir(drive);await record('create fixture',started,{files});
 started=performance.now();const scan=await core.inventory(source,{});await record('inventory',started,{files:scan.files.length});
 assert.equal(scan.files.length,files);assert.deepEqual(scan.skipped?.map(file=>file.path),[]);
 started=performance.now();const {plans:[transfer]}=await core.plan(source,[drive],options,metadata);await record('plan into empty destination',started,{entries:transfer!.entries.length});
 assert.equal(transfer!.entries.length,files);
 assert.equal(new Set(transfer!.entries.map(entry=>entry.destination.toLowerCase())).size,files);
 started=performance.now();const reused=await core.plan(source,[drive],{...options,reuse:scan},metadata);await record('plan reusing the scan',started);
 assert.equal(reused.plans[0]!.entries.length,files);
 // The whole card treated as a misplaced library: a read-only check reads names, sizes and metadata only.
 started=performance.now();const misplaced=await core.findMisplaced(source,source,options,metadata);await record('misplaced check',started,{misplaced:misplaced.count});
 assert.equal(misplaced.count,files);
});

test('copy thousands of small files, then re-plan and re-run with everything verified in place',async t=>{
 const files=count(3000),root=await temporary(t,'stress-copy-'),source=path.join(root,'card'),drive=path.join(root,'drive');
 await card(source,files);await fs.mkdir(drive);
 let started=performance.now();const {plans:[transfer]}=await core.plan(source,[drive],options,metadata);await record('plan',started,{files});
 started=performance.now();const result=await core.execute(transfer!);await record('copy',started,{files,perFileMs:Math.round((performance.now()-started)/files)});
 assert.deepEqual(result,{copied:files,skipped:0,errors:[]});
 await assertCopied(transfer!);assert.deepEqual(await leftovers(drive),[]);
 started=performance.now();const {plans:[again]}=await core.plan(source,[drive],options,metadata);await record('re-plan (all present)',started);
 assert.ok(again!.entries.every(entry=>entry.skip));
 started=performance.now();assert.deepEqual(await core.execute(again!),{copied:0,skipped:files,errors:[]});await record('re-run (all verified)',started);
});

test('every listed extension is copied exactly in all six layouts',async t=>{
 const extensions=await listedExtensions();
 for(const layout of ['flat','format','type-format','photos-flat','videos-flat','video-root'] as MediaLayout[]){
  const root=await temporary(t,`stress-layout-${layout}-`),source=path.join(root,'card'),photos=path.join(root,'photobackup'),videos=path.join(root,'videobackup');
  for(const [index,extension] of extensions.entries())await put(path.join(source,'DCIM',`F${index}.${index%2?extension.toUpperCase():extension}`),`bytes ${index} ${extension}`);
  await fs.mkdir(photos);await fs.mkdir(videos);
  const started=performance.now(),{plans:[transfer]}=await core.plan(source,[photos],{...options,layout,videoRoots:[videos]},metadata);
  assert.deepEqual(await executeAll(transfer!),{copied:extensions.length,skipped:0,errors:[]},layout);
  await record('all extensions copied',started,{layout,files:extensions.length});
  await assertCopied(transfer!);for(const part of parts(transfer!))assert.deepEqual(await leftovers(part.root),[]);
 }
});

test('a 150-level folder tree with long names copies exactly',async t=>{
 const root=await temporary(t,'stress-deep-'),drive=path.join(root,'drive');await fs.mkdir(drive);
 let folder=path.join(root,'card');for(let level=0;level<150;level++)folder=path.join(folder,`l${level}`);
 for(let index=0;index<count(50);index++)await put(path.join(folder,`${'名'.repeat(60)}_${index}.JPG`),`deep ${index}`);
 const started=performance.now();const {plans:[transfer]}=await core.plan(path.join(root,'card'),[drive],options,metadata);
 assert.deepEqual((await core.execute(transfer!)).errors,[]);await record('deep tree copy',started,{files:transfer!.entries.length});
 await assertCopied(transfer!);
});

for(const sources of [1,4,10])test(`${sources} cards imported at once into one destination with clashing names lose nothing`,async t=>{
 const files=count(150),root=await temporary(t,`stress-parallel-${sources}-`),drive=path.join(root,'drive');await fs.mkdir(drive);
 // Every card uses the same names; odd cards repeat card 0's bytes, even ones have their own.
 const folders:string[]=[];
 for(let index=0;index<sources;index++){const folder=path.join(root,`card-${index}`);await card(folder,files,index%2?0:index);folders.push(folder);}
 const started=performance.now();
 const plans=await Promise.all(folders.map(async folder=>(await core.plan(folder,[drive],options,metadata)).plans[0]!));
 const results=await Promise.all(plans.map(transfer=>core.execute(transfer)));
 await record('parallel import',started,{sources,files:files*sources});
 for(const result of results)assert.deepEqual(result.errors,[]);
 // A job that loses a race for a planned name publishes in a conflict folder instead, so files are
 // compared by name and bytes: each distinct pair is stored exactly once.
 const wanted=new Set<string>();for(const transfer of plans)for(const entry of transfer.entries)wanted.add(path.basename(entry.source)+' '+await fileSha(entry.source));
 const stored=[...await tree(drive)].map(([relative,digest])=>path.basename(relative)+' '+digest);
 assert.equal(stored.length,wanted.size);assert.deepEqual(new Set(stored),wanted);
 assert.deepEqual(await leftovers(drive),[]);
});

test('organize thousands of misplaced files in place, check, and undo to the exact original tree',async t=>{
 const files=count(5000),root=await temporary(t,'stress-organize-'),library=path.join(root,'library');
 await card(path.join(library,'unsorted'),files);
 const before=await tree(library);
 let started=performance.now();const {plans:[transfer]}=await core.plan(library,[library],{...options,reorganize:true},metadata);await record('organization plan',started,{files});
 started=performance.now();const result=await core.executeReorganization(transfer!,undefined,undefined);await record('organization (rename)',started,{files,moved:result.moved});
 assert.deepEqual(result.errors,[]);assert.equal(result.moved,files);
 started=performance.now();assert.equal((await core.findMisplaced(library,library,options,metadata)).count,0);await record('misplaced check after organizing',started,{files});
 const [job]=await core.getOrganizationRecovery(library,{verifyContents:false});assert.equal(job?.status,'complete');
 started=performance.now();const undone=await core.undoOrganization(library,job.id);await record('undo organization',started,{files,restored:undone.restored});
 assert.equal(undone.restored,files);assert.deepEqual(await tree(library),before);
});

test('exFAT drive: import and organize in place without hard links, then undo',async t=>{
 const files=count(600),root=await temporary(t,'stress-exfat-'),exfat=await diskImage(root,'256m','ExFAT','STRESSEX');
 if(!exfat){t.skip('hdiutil unavailable');return;}
 const source=path.join(root,'card'),backup=path.join(exfat,'photobackup');await card(source,files);await fs.mkdir(backup);
 let started=performance.now();const {plans:[transfer]}=await core.plan(source,[backup],{...options,layout:'flat'},metadata);
 assert.deepEqual((await core.execute(transfer!)).errors,[]);await record('exFAT import',started,{files});
 await assertCopied(transfer!);assert.deepEqual(await leftovers(exfat),[]);
 const before=await tree(backup);
 started=performance.now();const {plans:[organize]}=await core.plan(backup,[backup],{...options,reorganize:true},metadata);
 const result=await core.executeReorganization(organize!,undefined,undefined);await record('exFAT organization (rename)',started,{files,moved:result.moved});
 assert.deepEqual(result.errors,[]);assert.equal(result.moved,files);
 assert.equal((await core.findMisplaced(backup,backup,options,metadata)).count,0);
 const [job]=await core.getOrganizationRecovery(backup);assert.equal(job?.status,'complete',JSON.stringify(job));
 started=performance.now();await core.undoOrganization(backup,job.id);await record('exFAT undo',started,{files});
 assert.deepEqual(await tree(backup),before);
});

/** Run the stress worker; kill it with SIGKILL once it reports `killAt` completed files. */
function worker(t:test.TestContext,mode:string,base:string,killAt?:number):Promise<{killed:boolean;result?:Record<string,unknown>}>{
 const child=fork(new URL('./fixtures/worker.mts',import.meta.url),[mode,base],{execArgv:['--import','tsx'],silent:true});
 let stderr='',result:Record<string,unknown>|undefined,killed=false;
 child.stderr?.on('data',chunk=>{stderr+=chunk;});child.stdout?.resume();
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 return new Promise((resolve,reject)=>{
  child.on('message',(message:{type:string;completed?:number;result?:Record<string,unknown>})=>{
   if(message.type==='progress'&&killAt!==undefined&&!killed&&message.completed!>=killAt){killed=true;child.kill('SIGKILL');}
   if(message.type==='result')result=message.result;
  });
  child.on('error',reject);
  child.on('close',(code,signal)=>{
   if(killed&&signal==='SIGKILL')resolve({killed:true});
   else if(code===0&&result)resolve({killed:false,result});
   else reject(new Error(`${mode} worker exited ${code??signal}: ${stderr}`));
  });
 });
}
// Deterministic pseudo-random kill points.
const points=(seed:number,total:number,runs:number)=>Array.from({length:runs},(_,index)=>1+((seed*(index+7)*7919)%Math.max(1,total-1)));

test('an import killed with SIGKILL at random points resumes to an exact copy',async t=>{
 const files=count(400),base=await temporary(t,'stress-kill-import-'),source=path.join(base,'card'),drive=path.join(base,'drive');
 await card(source,files);await fs.mkdir(drive);
 const started=performance.now();let kills=0;
 for(const killAt of points(3,files,6)){if((await worker(t,'import',base,killAt)).killed)kills++;}
 const final=await worker(t,'import',base);
 assert.deepEqual((final.result as {errors:string[]}).errors,[]);
 await record('import with SIGKILLs',started,{files,kills});
 const {plans:[transfer]}=await core.plan(source,[drive],{backup:false,template:'{year}/{camera}',layout:'format',unknownRules:{}},metadata);
 assert.ok(transfer!.entries.every(entry=>entry.skip),'every file is in place');await assertCopied(transfer!);
 // Only complete copies are visible; a staged copy left by the last kill is released by the final run.
 assert.equal([...(await tree(drive)).keys()].filter(relative=>!relative.startsWith('.')).length,files);
 assert.deepEqual(await leftovers(drive),[]);
});

test('an organization and its undo killed with SIGKILL at random points resume without losing a file',async t=>{
 const files=count(400),base=await temporary(t,'stress-kill-organize-'),library=path.join(base,'library');
 await card(path.join(library,'unsorted'),files);
 const before=await tree(library),started=performance.now();let kills=0;
 for(const killAt of points(5,files,5)){if((await worker(t,'organize',base,killAt)).killed)kills++;
  // Between kills every file is somewhere: at its original path or its organized one, or (killed
  // between hard link and unlink) briefly at both as one inode. Never neither.
  const now=await tree(library);
  assert.deepEqual(new Set(now.values()),new Set(before.values()));
  assert.ok(now.size===before.size||now.size===before.size+1,`${now.size} files`);
 }
 const finished=await worker(t,'organize',base);
 assert.deepEqual((finished.result as {errors:string[]}).errors,[]);
 assert.equal((await core.findMisplaced(library,library,options,metadata)).count,0);
 const jobs=(await worker(t,'jobs',base)).result!.jobs as {status:string;error?:string}[];
 assert.ok(jobs.length>=1&&jobs.every(job=>!job.error),JSON.stringify(jobs));
 for(const killAt of points(11,files,3)){if((await worker(t,'undo',base,killAt)).killed)kills++;assert.deepEqual(new Set((await tree(library)).values()),new Set(before.values()));}
 await worker(t,'undo',base);
 await record('organization and undo with SIGKILLs',started,{files,kills});
 assert.deepEqual(await tree(library),before);
});
