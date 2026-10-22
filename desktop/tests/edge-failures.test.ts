import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {plan,execute,configureOrganizationRecovery} from '../core/index';
import type {Metadata,TransferPlan} from '../shared';
import {assertCopied,fileSha,leftovers,put,temporary,tree} from './fixtures/edge';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false,template:'{year}/{camera}',layout:'format' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Cam',date:'2024-02-03T12:00:00',fields:{}});
async function card(root:string,name:string,count:number,size=256*1024,seed=0):Promise<string>{
 const source=path.join(root,name);
 for(let index=0;index<count;index++)await put(path.join(source,'DCIM',`IMG_${String(index).padStart(3,'0')}.JPG`),Buffer.alloc(size,(seed+index)%251+1));
 return source;
}
/** Published files hold complete source bytes; no staging files are left unless `staged`. */
async function onlyCompleteCopies(transfer:TransferPlan,root=transfer.root,staged=false):Promise<number>{
 const sources=new Set(await Promise.all(transfer.entries.map(entry=>fileSha(entry.source).catch(()=>''))));
 let published=0;
 for(const [relative,digest] of await tree(root))if(relative.endsWith('.JPG')){assert.ok(sources.has(digest),`incomplete or foreign bytes: ${relative}`);published++;}
 if(!staged)assert.deepEqual(await leftovers(root),[]);
 return published;
}

test('a source rewritten or removed mid-copy fails only that file, publishes nothing for it, and a new plan copies the new bytes',async t=>{
 const root=await temporary(t,'edge-source-change-'),source=await card(root,'card',8,1024*1024),destination=path.join(root,'drive');await fs.mkdir(destination);
 const {plans:[transfer]}=await plan(source,[destination],options,metadata);
 const changed=transfer!.entries[2]!.source,removed=transfer!.entries[5]!.source;
 let touched=false;
 const result=await execute(transfer!,undefined,progress=>{
  if(touched||progress.completed<1)return;touched=true;
  // Changed and removed while the first files are still streaming.
  void fs.appendFile(changed,'edited in camera');void fs.unlink(removed);
 });
 assert.equal(result.copied,6);assert.equal(result.errors.length,2);
 assert.ok(result.errors.some(error=>error.startsWith('IMG_002.JPG')));assert.ok(result.errors.some(error=>error.startsWith('IMG_005.JPG')));
 await assert.rejects(fs.stat(transfer!.entries[2]!.destination),{code:'ENOENT'});
 assert.equal(await onlyCompleteCopies(transfer!),6);
 const {plans:[retry]}=await plan(source,[destination],options,metadata);
 assert.deepEqual(await execute(retry!),{copied:1,skipped:6,errors:[]});
 await assertCopied(retry!);
});

test('a destination folder renamed away or replaced by a link mid-run is never recreated or followed',async t=>{
 for(const fault of ['renamed','link'] as const){
  const root=await temporary(t,`edge-dest-${fault}-`),source=await card(root,'card',10),destination=path.join(root,'drive'),moved=path.join(root,'moved'),elsewhere=path.join(root,'elsewhere');
  await fs.mkdir(destination);await fs.mkdir(elsewhere);
  const {plans:[transfer]}=await plan(source,[destination],options,metadata);
  let done:Promise<void>|undefined;
  const outcome=await execute(transfer!,undefined,progress=>{
   if(done||progress.completed<2)return;
   done=fs.rename(destination,moved).then(()=>fault==='link'?fs.symlink(elsewhere,destination):undefined);
  }).then(value=>value,error=>error as Error);
  await done;
  if(!(outcome instanceof Error))assert.ok(outcome.errors.length>0,fault);
  // Nothing appeared at the old path (beyond the link) or through the link.
  if(fault==='renamed')await assert.rejects(fs.lstat(destination),{code:'ENOENT'});
  assert.deepEqual(await fs.readdir(elsewhere),[]);
  await onlyCompleteCopies(transfer!,moved,true);
  // Once the folder is back where it was, a new import finishes and clears what the stopped one staged.
  if(fault==='link')await fs.unlink(destination);
  await fs.rename(moved,destination);
  const {plans:[retry]}=await plan(source,[destination],options,metadata);
  assert.deepEqual((await execute(retry!)).errors,[]);await assertCopied(retry!);
  await onlyCompleteCopies(retry!);
 }
});

test('jobs from several cards running at once on one destination never overwrite one another',async t=>{
 const root=await temporary(t,'edge-concurrent-'),destination=path.join(root,'drive');await fs.mkdir(destination);
 // Four cards with the same file names: two hold identical bytes, two different ones.
 const sources=await Promise.all([0,0,1,2].map((seed,index)=>card(root,`card-${index}`,12,64*1024,seed*7)));
 // Every plan is made before any job writes, so each sees an empty destination.
 const plans=await Promise.all(sources.map(async source=>(await plan(source,[destination],options,metadata)).plans[0]!));
 const results=await Promise.all(plans.map(transfer=>execute(transfer)));
 for(const result of results)assert.deepEqual(result.errors,[]);
 // A name holding identical bytes on several cards is kept once; every other file survives under its name.
 const distinct=new Set<string>();for(const transfer of plans)for(const entry of transfer.entries)distinct.add(path.basename(entry.source)+' '+await fileSha(entry.source));
 const stored=new Set([...(await tree(destination))].map(([relative,digest])=>path.basename(relative)+' '+digest));
 assert.deepEqual(stored,distinct);assert.equal((await tree(destination)).size,distinct.size);
 assert.equal(results.reduce((sum,result)=>sum+result.copied,0),distinct.size);
 assert.deepEqual(await leftovers(destination),[]);
 // A second round of the same plans copies nothing and finds everything verified.
 const again=await Promise.all(sources.map(async source=>(await plan(source,[destination],options,metadata)).plans[0]!));
 for(const result of await Promise.all(again.map(transfer=>execute(transfer))))assert.deepEqual({copied:result.copied,errors:result.errors},{copied:0,errors:[]});
});

test('a stopped import leaves no partial files and a retry completes exactly',async t=>{
 const root=await temporary(t,'edge-stop-'),source=await card(root,'card',10,512*1024),destination=path.join(root,'drive');await fs.mkdir(destination);
 const {plans:[transfer]}=await plan(source,[destination],options,metadata);
 const control=new AbortController();
 await assert.rejects(execute(transfer!,control.signal,progress=>{if(progress.completed>=3)control.abort();}),{name:'AbortError'});
 await onlyCompleteCopies(transfer!);
 const {plans:[retry]}=await plan(source,[destination],options,metadata);
 assert.deepEqual((await execute(retry!)).errors,[]);await assertCopied(retry!);
});
