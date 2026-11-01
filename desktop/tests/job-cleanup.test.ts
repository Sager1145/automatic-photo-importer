import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {plan,execute,configureOrganizationRecovery} from '../core/index';
import {recordPartial,recordCreation} from '../core/import-recovery';
import {storeFor} from '../core/app-store';
import {findRunResidue,cleanResidue,runLeftoverGroups,type RunScope} from '../core/residue';
import {runTrace,traceTemporary} from '../core/run-trace';
import {scanDuplicates,dropDuplicateStores} from '../core/duplicates';
import {removeDuplicates} from '../core/duplicate-removal';
import {destinationIndex,dropDestinationIndexes} from '../core/destination-index';
import {identity} from '../core/paths';
import {resolveGroups} from '../duplicate-rules';
import {configureLogger,resetLogger,withJob,type Logger} from '../logger';
import {cleanupLocked,cleanupOffered,leftoverTotal,markCleaned} from '../job-cleanup';
import {JobCleanupSheet,JobCleanup,confirmJobCleanup} from '../renderer/JobCleanup';
import {I18nProvider} from '../renderer/i18n';
import {stagePathFor,openReceiptsFor} from './fixtures/receipts';
import {journalFolderFor,organizeAs} from './fixtures/records';
import type {Action,Job,JobLeftovers,Metadata} from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}});
const lstat=(file:string)=>fs.lstat(file,{bigint:true});
const exists=(file:string)=>fs.lstat(file).then(()=>true,()=>false);
const scopeOf=(job:string):RunScope=>({job,...runTrace(job)??{roots:[],journals:[],temporary:[]}});

let logger:Logger|undefined;
afterEach(async()=>{await logger?.close();logger=undefined;resetLogger();});
async function logs(t:test.TestContext){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'job-cleanup-logs-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));logger=configureLogger({dir,level:'normal'});return dir;}
async function deletions(dir:string){await logger!.flush();const lines=(await Promise.all((await fs.readdir(dir)).map(name=>fs.readFile(path.join(dir,name),'utf8')))).join('').split('\n').filter(Boolean).map(line=>JSON.parse(line));return lines.filter(line=>line.event==='file-deleted'&&line.area==='residue') as {path:string;reason:string;proof:string;level:string}[];}
async function base(t:test.TestContext,name:string){const folder=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),name)));t.after(()=>fs.rm(folder,{recursive:true,force:true}));return folder;}
/** A card with three photos planned into a backup folder: what an import of it writes, before anything is copied. */
async function importFixture(t:test.TestContext){
  const folder=await base(t,'job-cleanup-');
  const card=path.join(folder,'card'),root=path.join(folder,'backup');
  await fs.mkdir(card);await fs.mkdir(root);
  for(const [index,size] of [4000,5000,3000].entries())await fs.writeFile(path.join(card,`DSC_000${index+1}.NEF`),Buffer.alloc(size,index+1));
  const reviewed=(await plan(card,[root],options,metadata)).plans[0]!;
  await fs.mkdir(path.dirname(reviewed.entries[0]!.destination),{recursive:true});
  return {folder,card,root,reviewed,entries:reviewed.entries};
}

test('import: what a stopped run staged is removed with its receipts; other jobs\', untracked and verified files stay',async t=>{
  const dir=await logs(t),f=await importFixture(t),[first,second,third]=f.entries as [typeof f.entries[0],typeof f.entries[0],typeof f.entries[0]];
  const stage=async(fill:number,bytes:number)=>{const file=await stagePathFor(f.root,randomUUID());await fs.writeFile(file,Buffer.alloc(bytes,fill));return file;};
  // This run: a staged prefix (resumable), and a receipt whose staged copy is already gone.
  const ours=await stage(1,1000),gone=await stage(2,10);
  const [oursReceipt,goneReceipt]=await withJob('job-a',async()=>[await recordPartial('stage',ours,await fs.lstat(ours,{bigint:true}),first,f.reviewed,new Map()),await recordPartial('stage',gone,await fs.lstat(gone,{bigint:true}),second,f.reviewed,new Map())]);
  await fs.unlink(gone);
  // Another job's staged copy, a staged copy without a receipt, and a verified copy at its destination.
  const theirs=await stage(3,700);
  const theirReceipt=await withJob('job-b',async()=>recordPartial('stage',theirs,await lstat(theirs),third,f.reviewed,new Map()));
  const untracked=await stage(9,2500);
  const verified=Buffer.alloc(3000,3);await fs.writeFile(third.destination,verified);
  const user=path.join(path.dirname(third.destination),`${randomUUID()}.partial`);await fs.writeFile(user,'user data');
  assert.deepEqual(runTrace('job-a')?.roots,[f.root],'the receipts recorded where this job wrote');

  const found=await findRunResidue(scopeOf('job-a'));
  assert.deepEqual(found.items.map(item=>[item.path,item.kind]).sort(),[[gone,'receipt'],[ours,'resumable']].sort());
  const groups=runLeftoverGroups(found);
  assert.deepEqual(groups.staged,{files:1,bytes:1000});assert.equal(groups.receipts,1);assert.deepEqual(leftoverTotal(groups),{files:1,bytes:1000});

  const {removed}=await cleanResidue(found);
  assert.deepEqual(removed,{files:1,bytes:1000});
  assert.equal(await exists(ours),false);
  const open=await openReceiptsFor(f.root);
  assert.equal(open.has(oursReceipt.rid),false);assert.equal(open.has(goneReceipt.rid),false,'a receipt whose file is gone is closed');
  assert.equal(open.has(theirReceipt.rid),true,'another job\'s receipt stays open');
  for(const kept of [theirs,untracked,third.destination,user,first.source,second.source,third.source])assert.ok(await exists(kept),`kept: ${kept}`);
  assert.deepEqual(await fs.readFile(third.destination),verified);
  const logged=await deletions(dir);
  assert.deepEqual(logged.map(line=>line.path),[ours]);
  assert.equal(logged[0]!.level,'normal');assert.ok(logged[0]!.reason.length>5&&logged[0]!.proof.length>5);
});

test('import: receipts a real copy writes carry its job, so its Clean up finds whatever a Pause left',async t=>{
  const f=await importFixture(t),big=f.entries[0]!;
  await fs.writeFile(big.source,Buffer.alloc(3*1024*1024,1));
  const reviewed=(await plan(f.card,[f.root],options,metadata)).plans[0]!,control=new AbortController();
  let seen:Promise<Map<string,{[key:string]:unknown}>>|undefined;
  // Paused once bytes stream: the receipts open at that moment are this run's.
  await assert.rejects(withJob('job-real',()=>execute(reviewed,control.signal,progress=>{if(progress.bytes>0&&!seen){seen=openReceiptsFor(f.root);void seen.finally(()=>control.abort());}},{direct:false})),{name:'AbortError'});
  const during=[...(await seen!).values()];
  assert.ok(during.length>0,'the copy had a receipt open');
  assert.ok(during.every(record=>record.job==='job-real'),'every receipt names the job that wrote it');
  // A stopped copy removes its own staged file when it can; what it could not (a crash, a file in use) is the job's to clean.
  const found=await findRunResidue(scopeOf('job-real'));
  assert.ok(found.items.every(item=>item.job==='job-real'));
  await cleanResidue(found);
  assert.deepEqual([...(await openReceiptsFor(f.root)).values()].filter(record=>record.job==='job-real'&&record.kind==='stage'),[],'no staged copy of the job is left open');
  for(const entry of reviewed.entries)assert.ok(await exists(entry.source));
});

test('import: a complete staged copy whose card file changed is listed as kept and never removed',async t=>{
  const f=await importFixture(t),entry=f.entries[0]!;
  const file=await stagePathFor(f.root,randomUUID());await fs.writeFile(file,Buffer.alloc(entry.size,1));
  await withJob('job-c',async()=>recordPartial('stage',file,await lstat(file),entry,f.reviewed,new Map()));
  await fs.writeFile(entry.source,Buffer.alloc(entry.size+10,7));
  const found=await findRunResidue(scopeOf('job-c'));
  assert.deepEqual(runLeftoverGroups(found).recoverable,{files:1,bytes:entry.size});
  assert.deepEqual(leftoverTotal(runLeftoverGroups(found)),{files:0,bytes:0});
  await cleanResidue(found);
  assert.ok(await exists(file),'it may be the only copy');
});

test('direct copies: an unfinished file at its final name goes, a whole one and other files there stay',async t=>{
  const dir=await logs(t),f=await importFixture(t),[first,second,third]=f.entries as [typeof f.entries[0],typeof f.entries[0],typeof f.entries[0]];
  const direct=(size:number)=>({size,finalBirth:[]});
  await withJob('job-d',async()=>{
    // Stopped mid-copy: 100 of 4000 bytes at the destination name.
    await fs.writeFile(first.destination,Buffer.alloc(100,1));
    await recordPartial('publication',first.destination,await lstat(first.destination),first,f.reviewed,new Map(),direct(first.size));
    // Stopped right after the name was claimed: an empty file the receipt written before it names.
    await recordCreation(second.destination,second,f.reviewed,new Map(),direct(second.size));
    await fs.writeFile(second.destination,'');
    // Every byte copied, only the dates and flush left: a re-import finishes it.
    await fs.writeFile(third.destination,Buffer.alloc(third.size,3));
    await recordPartial('publication',third.destination,await lstat(third.destination),third,f.reviewed,new Map(),direct(third.size));
  });
  const neighbour=path.join(path.dirname(first.destination),'DSC_9999.NEF');await fs.writeFile(neighbour,'earlier import');
  const found=await findRunResidue(scopeOf('job-d'));
  assert.deepEqual(found.items.filter(item=>item.kind==='direct').map(item=>item.path).sort(),[first.destination,second.destination].sort());
  assert.deepEqual(runLeftoverGroups(found).direct,{files:2,bytes:100});
  await cleanResidue(found);
  assert.equal(await exists(first.destination),false);assert.equal(await exists(second.destination),false);
  assert.ok(await exists(third.destination),'a whole copy is never removed here');assert.ok(await exists(neighbour));
  for(const entry of f.entries)assert.ok(await exists(entry.source),'originals are untouched');
  assert.deepEqual((await deletions(dir)).map(line=>line.path).sort(),[first.destination,second.destination].sort());
});

test('organization: scratch files of its own journal go; the journal, kept originals and other journals stay',async t=>{
  const dir=await logs(t),root=await base(t,'job-cleanup-organize-');
  for(const name of ['DSC_0001.NEF','DSC_0002.NEF']){await fs.mkdir(path.join(root,'incoming'),{recursive:true});await fs.writeFile(path.join(root,'incoming',name),Buffer.alloc(2048,name.length));}
  const reviewed=(await plan(root,[root],{...options,reorganize:true},metadata)).plans[0]!;
  await withJob('org-a',()=>organizeAs('rename',reviewed));
  const [journal]=runTrace('org-a')!.journals;assert.ok(journal,'the organization noted its journal');
  const folder=await journalFolderFor(root,journal.id),store=await storeFor(root);
  // What a run killed mid-copy leaves in its journal folder, and a Delete recovery files stopped after setting it aside.
  const stage=path.join(folder,`stage-${randomUUID()}.partial`),incomplete=path.join(folder,`incomplete-${randomUUID()}`);
  await fs.writeFile(stage,Buffer.alloc(300));await fs.writeFile(incomplete,Buffer.alloc(200));
  const aside=path.join(store.path,'Organizations',`deleting-${journal.id}-${randomUUID()}`);await fs.mkdir(aside);await fs.writeFile(path.join(aside,'journal.jsonl'),'x');
  // Another organization's scratch and set-aside folder.
  const other=path.join(store.path,'Organizations',randomUUID());await fs.mkdir(other);
  const otherStage=path.join(other,`stage-${randomUUID()}.partial`);await fs.writeFile(otherStage,'x');
  const otherAside=path.join(store.path,'Organizations',`deleting-${randomUUID()}-${randomUUID()}`);await fs.mkdir(otherAside);
  const found=await findRunResidue(scopeOf('org-a'));
  assert.deepEqual(found.items.map(item=>item.path).sort(),[stage,incomplete,aside].sort());
  assert.deepEqual(runLeftoverGroups(found).organization,{files:3,bytes:501});
  await cleanResidue(found);
  for(const gone of [stage,incomplete,aside])assert.equal(await exists(gone),false,gone);
  for(const kept of [path.join(folder,'journal.jsonl'),otherStage,otherAside])assert.ok(await exists(kept),kept);
  assert.deepEqual((await deletions(dir)).map(line=>line.path).sort(),[stage,incomplete,aside].sort());
});

test('duplicate removal: only scratch in the journal this removal made is listed',async t=>{
  const top=await base(t,'job-cleanup-duplicates-'),root=path.join(top,'library');
  dropDuplicateStores();dropDestinationIndexes();
  for(const [relative,content] of [['2024/202405/Nikon Z f/DSC_0001.JPG','the same photo'],['Imported/copy.JPG','the same photo']] as const){await fs.mkdir(path.dirname(path.join(root,relative)),{recursive:true});await fs.writeFile(path.join(root,relative),content);}
  const scanned=await scanDuplicates(root,{metadata:async()=>({fields:{}}),index:await destinationIndex(await fs.realpath(root),await identity(root))});
  const removal=await withJob('dup-a',()=>removeDuplicates(root,resolveGroups(scanned.groups,2),scanned.companions));
  assert.deepEqual(runTrace('dup-a')?.journals.map(item=>item.id),[removal.id]);
  const scratch=path.join(await journalFolderFor(root,removal.id!),`stage-${randomUUID()}.partial`);await fs.writeFile(scratch,'x');
  const found=await findRunResidue(scopeOf('dup-a'));
  assert.deepEqual(found.items.map(item=>item.path),[scratch]);
  assert.deepEqual((await findRunResidue(scopeOf('some-other-job'))).items,[],'a job that wrote nothing has nothing');
  await cleanResidue(found);
  assert.equal(await exists(scratch),false);
  assert.equal(await fs.readFile(path.join(root,'2024/202405/Nikon Z f/DSC_0001.JPG'),'utf8'),'the same photo');
});

test('camera: the job\'s own temporary folder goes, other camera folders and unrelated folders stay',async t=>{
  const dir=await logs(t),temporary=await base(t,'job-cleanup-tmp-');
  const ours=await fs.mkdtemp(path.join(temporary,'photo-importer-camera-')),theirs=await fs.mkdtemp(path.join(temporary,'photo-importer-camera-'));
  const unrelated=path.join(temporary,'photo-importer-camera-notmine');
  for(const folder of [ours,theirs,unrelated]){await fs.mkdir(path.join(folder,'DCIM'),{recursive:true});await fs.writeFile(path.join(folder,'DCIM','IMG_0001.JPG'),Buffer.alloc(1200));}
  traceTemporary('cam-a',ours);traceTemporary('cam-a',unrelated);
  const found=await findRunResidue(scopeOf('cam-a'));
  assert.deepEqual(found.items.map(item=>[item.path,item.kind]),[[ours,'temporary']],'only folders named as the app names them');
  assert.deepEqual(runLeftoverGroups(found).temporary,{files:1,bytes:1200});
  await cleanResidue(found);
  assert.equal(await exists(ours),false);assert.ok(await exists(theirs));assert.ok(await exists(unrelated));
  assert.deepEqual((await deletions(dir)).map(line=>line.path),[ours]);
});

// ---- When the button shows, and what the confirmation says.
const job=(patch:Partial<Job>={}):Job=>({id:'j1',source:{id:'s',name:'Card',path:'/card',transport:'storage'},phase:'stopped',paused:true,startedAt:'2026-11-01T10:00:00Z',errors:[],backup:false,...patch});
const measured:JobLeftovers={checkedAt:'2026-11-01T10:05:00Z',direct:{files:2,bytes:2048},staged:{files:3,bytes:3*1024*1024},organization:{files:0,bytes:0},temporary:{files:1,bytes:4096},receipts:4,recoverable:{files:1,bytes:5000}};
const render=(child:ReturnType<typeof createElement>)=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:child}));

test('Clean up shows on stopped and paused jobs that ran, never while they run or once cleaned',()=>{
  assert.equal(cleanupOffered(job()),true);assert.equal(cleanupOffered(job({paused:false})),true);
  assert.equal(cleanupOffered(job({startedAt:undefined})),false,'paused in the queue: nothing was written');
  for(const phase of ['queued','discovering','verifying','copying','complete','error'] as const)assert.equal(cleanupOffered(job({phase})),false,phase);
  assert.equal(cleanupOffered(job({stopping:'pause'})),false);
  assert.equal(cleanupOffered(job({leftovers:{...measured,cleaned:{files:1,bytes:1,at:'x'}}})),false);
  assert.equal(cleanupLocked({jobs:[job(),job({id:'j2',phase:'copying'})]}),true);
  assert.equal(cleanupLocked({jobs:[job(),job({id:'j2',phase:'queued'})]}),true);
  assert.equal(cleanupLocked({jobs:[job()],busyReview:true}),true);
  assert.equal(cleanupLocked({jobs:[job(),job({id:'j2',phase:'complete'})]}),false);
  const cleaned=job();markCleaned(cleaned);assert.equal(cleaned.paused,false,'a paused job that is cleaned up becomes stopped');assert.equal(cleaned.phase,'stopped');
  const markup=render(createElement(JobCleanup,{job:job(),locked:true,act:()=>{}}));
  assert.match(markup,/data-testid="job-cleanup"[^>]*disabled|disabled[^>]*data-testid="job-cleanup"/);
  assert.equal(render(createElement(JobCleanup,{job:job({phase:'copying'}),locked:false,act:()=>{}})),'');
});

test('the confirmation lists what will go, in counts and sizes, and only confirming removes',()=>{
  const actions:Action[]=[],act=(action:Action)=>{actions.push(action);};
  const markup=render(createElement(JobCleanupSheet,{job:job({leftovers:measured}),locked:false,act,onCancel:()=>{}}));
  assert.deepEqual(actions,[],'rendering removes nothing');
  assert.match(markup,/This deletes 6 files \(3\.2 MB\) that this job made\./);
  assert.match(markup,/job-cleanup-direct.*Unfinished copies at the destination.*2 · 2 KB/s);
  assert.match(markup,/job-cleanup-staged.*Staged copies in the records folder.*3 · 3\.1 MB/s);
  assert.match(markup,/job-cleanup-temporary.*Camera temporary folders.*1 · 4 KB/s);
  assert.match(markup,/job-cleanup-receipts.*Copy receipts closed.*4/s);
  assert.match(markup,/1 complete copies whose card file changed are kept/);
  assert.match(markup,/Importing again starts over/);
  assert.match(render(createElement(JobCleanupSheet,{job:job({organization:true,leftovers:measured}),locked:false,act,onCancel:()=>{}})),/can&#x27;t be continued here/);
  assert.match(render(createElement(JobCleanupSheet,{job:job({leftovers:measured}),locked:true,act,onCancel:()=>{}})),/job-cleanup-locked/);
  assert.equal(confirmJobCleanup(job({leftovers:measured}),true,act),false,'locked');
  assert.equal(confirmJobCleanup(job({leftovers:{...measured,checkedAt:undefined}}),false,act),false,'not measured');
  assert.equal(confirmJobCleanup(job({leftovers:{...measured,checking:true}}),false,act),false,'measuring');
  const nothing={...measured,direct:{files:0,bytes:0},staged:{files:0,bytes:0},temporary:{files:0,bytes:0},receipts:0};
  assert.equal(confirmJobCleanup(job({leftovers:nothing}),false,act),false,'nothing to do');
  assert.match(render(createElement(JobCleanupSheet,{job:job({leftovers:nothing}),locked:false,act,onCancel:()=>{}})),/This job left nothing to clean up\./);
  assert.deepEqual(actions,[]);
  assert.equal(confirmJobCleanup(job({leftovers:measured}),false,act),true);
  assert.deepEqual(actions,[{type:'cleanJob',jobId:'j1'}]);
});
