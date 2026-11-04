import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {plan,execute,configureOrganizationRecovery,type FileOutcome} from '../core/index';
import {getOrganizationRecovery,finalizeOrganization,undoOrganization} from '../core/recovery';
import {applyConflictChoices,type ConflictWork} from '../core/name-conflicts';
import {ConflictBook} from '../name-conflicts';
import type {Metadata,PlanEntry,TransferPlan} from '../shared';
import {fileSha,put,temporary} from './fixtures/edge';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const fixed=async():Promise<Metadata>=>({camera:'Fixture Cam',date:'2026-10-03T12:00:00',fields:{}});
const base={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const folder=path.join('2026','202610','Fixture Cam');
/** Bigger than the 64 KB a same-named pair is compared by first. */
const big=(fill:string,tail='')=>Buffer.concat([Buffer.alloc(200*1024,fill),Buffer.from(tail)]);

async function library(t:test.TestContext,prefix:string){
  const root=await temporary(t,prefix),source=path.join(root,'card'),photos=path.join(root,'drive','photobackup');
  await fs.mkdir(source,{recursive:true});await fs.mkdir(photos,{recursive:true});
  return {source,photos,existing:(name:string)=>path.join(photos,folder,name)};
}
/** Plan and copy, collecting the conflicts as the app does (from each file's outcome). */
async function importOnce(source:string,photos:string,options:Partial<typeof base>&{conflictNaming?:'number'}={}){
  const {plans:[transfer]}=await plan(source,[photos],{...base,...options},fixed);
  const book=new ConflictBook(),byId=new Map(transfer!.entries.map(entry=>[entry.id,entry])),outcomes:FileOutcome[]=[];
  const result=await execute(transfer!,undefined,undefined,{onFileOutcome:outcome=>{outcomes.push(outcome);book.note(outcome,byId.get(outcome.entryId),transfer!,0);}});
  return {transfer:transfer!,book,result,outcomes};
}
const work=(book:ConflictBook)=>book.take();
const entryNamed=(transfer:TransferPlan,name:string):PlanEntry=>transfer.entries.find(entry=>path.basename(entry.source)===name)!;

test('same name, same size, different first 64 KB: a different file, never read in full, copied under a new name',async t=>{
  const {source,photos,existing}=await library(t,'conflict-head-');
  await put(existing('DSC_0001.JPG'),big('a'));
  await put(path.join(source,'DCIM','DSC_0001.JPG'),big('b'));
  const events:{bytes:number;totalBytes:number}[]=[];
  const {plans:[transfer]}=await plan(source,[photos],{...base,conflictNaming:'number'},fixed,undefined,(_count,_file,detail)=>{if(detail?.step==='comparing')events.push({bytes:detail.bytes,totalBytes:detail.totalBytes});});
  // Comparing counts the 64 KB it read, and its total shrinks to that once the pair is found different.
  assert.deepEqual(events.at(-1),{bytes:64*1024,totalBytes:64*1024});
  const entry=entryNamed(transfer!,'DSC_0001.JPG');
  assert.equal(entry.skip,false);
  assert.equal(path.basename(entry.destination),'DSC_0001 (1).JPG');
  assert.equal(entry.digest,undefined,'the card file was not read in full to tell them apart');
  assert.deepEqual((await execute(transfer!)).errors,[]);
  assert.equal(await fileSha(existing('DSC_0001 (1).JPG')),await fileSha(path.join(source,'DCIM','DSC_0001.JPG')));
});

test('same name, size and first 64 KB but different bytes: SHA-256 decides, and it is copied under a new name with no prompt',async t=>{
  const {source,photos,existing}=await library(t,'conflict-tail-');
  await put(existing('DSC_0002.JPG'),big('a','one'));
  await put(path.join(source,'DCIM','DSC_0002.JPG'),big('a','two'));
  const {transfer,book,result}=await importOnce(source,photos);
  const entry=entryNamed(transfer,'DSC_0002.JPG');
  assert.equal(entry.skip,false);
  assert.ok(entry.digest,'both were read in full');
  assert.ok(entry.destination.includes(`${path.sep}Conflicts${path.sep}`),entry.destination);
  assert.deepEqual(result.errors,[]);
  assert.equal(book.size,0,'a different file is no conflict to ask about');
  assert.equal((await fs.readFile(existing('DSC_0002.JPG'))).subarray(-3).toString(),'one','the library file is untouched');
});

test('same name and bytes: listed as a conflict while the import goes on, skipped by default',async t=>{
  const {source,photos,existing}=await library(t,'conflict-same-');
  await put(existing('DSC_0003.JPG'),big('s'));
  await put(path.join(source,'DCIM','DSC_0003.JPG'),big('s'));
  await put(path.join(source,'DCIM','DSC_0004.JPG'),'a new photo');
  const {book,result,outcomes}=await importOnce(source,photos);
  assert.deepEqual(result.errors,[]);
  assert.equal(result.copied,1,'the other file is copied: nothing waited on the conflict');
  assert.equal(outcomes.find(outcome=>path.basename(outcome.source)==='DSC_0004.JPG')?.disposition,'published');
  const [conflict]=book.list();
  assert.equal(book.size,1);
  assert.equal(conflict!.existing,existing('DSC_0003.JPG'));
  assert.equal(conflict!.relative,'DCIM/DSC_0003.JPG');
  assert.equal(conflict!.choice,'skip');
  assert.equal(conflict!.sha256,await fileSha(existing('DSC_0003.JPG')));
  assert.deepEqual(book.summary(),{count:1,skip:1,overwrite:0,keep:0,done:0,failed:0,waiting:0,undoable:0,revision:1});
  assert.equal(book.hasWork(),false);
  assert.deepEqual(await fs.readdir(path.join(photos,folder)),['DSC_0003.JPG','DSC_0004.JPG']);
});

test('Keep both copies the file, verified, under the conflict naming; Skip leaves both as they are',async t=>{
  for(const conflictNaming of [undefined,'number' as const]){
    const {source,photos,existing}=await library(t,`conflict-keep-${conflictNaming??'folder'}-`);
    for(const name of ['A.JPG','B.JPG']){await put(existing(name),big(name[0]!));await put(path.join(source,'DCIM',name),big(name[0]!));}
    const {book}=await importOnce(source,photos,conflictNaming?{conflictNaming}:{});
    const [a,b]=book.list().sort((x,y)=>x.relative.localeCompare(y.relative));
    book.choose('keep',[a!.id]);book.choose('skip',[b!.id]);
    const results=await applyConflictChoices(work(book));
    book.settle(results);
    assert.equal(results.length,1);
    assert.ok(results[0]!.ok,String(results[0]!.error));
    const copy=results[0]!.copy!;
    assert.equal(conflictNaming?path.basename(copy):path.relative(path.join(photos,folder),copy).split(path.sep)[0],conflictNaming?'A (1).JPG':'Conflicts');
    assert.equal(await fileSha(copy),a!.sha256);
    assert.equal(await fileSha(existing('A.JPG')),a!.sha256,'the library file stays');
    assert.equal(book.list().find(item=>item.id===a!.id)!.state,'done');
    assert.equal(book.list().find(item=>item.id===b!.id)!.state,'waiting');
    // Keep both twice finds its own copy there: nothing more is written.
    book.choose('keep',[b!.id]);
    const again=await applyConflictChoices(work(book));
    assert.ok(again[0]!.ok);
    assert.notEqual(path.basename(again[0]!.copy!),path.basename(copy)==='A (1).JPG'?'B.JPG':'');
  }
});

test('Overwrite sets the library file aside in recovery storage and Undo puts it back',async t=>{
  const {source,photos,existing}=await library(t,'conflict-overwrite-');
  const target=existing('DSC_0005.JPG');
  await put(target,big('o'));await put(path.join(source,'DCIM','DSC_0005.JPG'),big('o'));
  const before=await fs.stat(target,{bigint:true});
  const {book}=await importOnce(source,photos);
  book.choose('overwrite');
  const [result]=await applyConflictChoices(work(book));
  book.settle([result!]);
  assert.ok(result!.ok,String(result!.error));
  assert.ok(result!.journal);
  const after=await fs.stat(target,{bigint:true});
  assert.notEqual(after.ino,before.ino,'a fresh verified copy took the name');
  assert.equal(await fileSha(target),book.list()[0]!.sha256);
  assert.deepEqual((await fs.readdir(path.join(photos,folder))).sort(),['DSC_0005.JPG'],'no copy is left under another name');
  assert.deepEqual(book.summary()!.undoable,1);
  // The journal is listed like any duplicate removal: complete, the original kept for undo.
  const [listed]=(await getOrganizationRecovery(photos)).filter(item=>item.id===result!.journal);
  assert.equal(listed!.status,'complete');assert.equal(listed!.retainedFiles,1);assert.equal(listed!.undoable,true);
  const undone=await undoOrganization(photos,result!.journal!);
  assert.equal(undone.restored,1);assert.equal(undone.removed,1);
  const back=await fs.stat(target,{bigint:true});
  assert.equal(back.ino,before.ino,'the original file itself is back');
  assert.deepEqual((await fs.readdir(path.join(photos,folder))).sort(),['DSC_0005.JPG']);
  assert.equal(book.undone(result!.journal!),1);
  assert.equal(book.list()[0]!.undone,true);
  assert.equal(book.list()[0]!.state,'waiting');
});

test('Overwrite, then releasing the kept original: the copy stays at the name and Undo is refused',async t=>{
  const {source,photos,existing}=await library(t,'conflict-release-');
  const target=existing('DSC_0006.JPG');
  await put(target,big('r'));await put(path.join(source,'DCIM','DSC_0006.JPG'),big('r'));
  const {book}=await importOnce(source,photos);
  book.choose('overwrite');
  const [result]=await applyConflictChoices(work(book));
  assert.ok(result!.ok,String(result!.error));
  const released=await finalizeOrganization(photos,result!.journal!);
  assert.equal(released.removed,1);
  assert.equal(await fileSha(target),book.list()[0]!.sha256);
  await assert.rejects(undoOrganization(photos,result!.journal!),/released/);
});

test('Overwrite refuses a library file that changed since it was compared, and changes nothing',async t=>{
  const {source,photos,existing}=await library(t,'conflict-changed-');
  const target=existing('DSC_0007.JPG');
  await put(target,big('c'));await put(path.join(source,'DCIM','DSC_0007.JPG'),big('c'));
  const {book}=await importOnce(source,photos);
  await fs.writeFile(target,big('c','edited'));
  book.choose('overwrite');
  const [result]=await applyConflictChoices(work(book));
  book.settle([result!]);
  assert.equal(result!.ok,false);
  assert.match(result!.error!,/changed since it was compared/);
  assert.equal((await fs.readFile(target)).subarray(-6).toString(),'edited');
  assert.equal(book.list()[0]!.state,'failed');
  // A failed item can be chosen again.
  assert.equal(book.choose('skip',[book.list()[0]!.id]),1);
});

test('bulk choices: Skip all, Overwrite all and Keep both for all change every conflict not applied yet',()=>{
  const book=new ConflictBook(),transfer={source:'/card',root:'/lib',rootIdentity:'1:2'};
  for(const name of ['A','B','C']){
    const entry:PlanEntry={id:`/card/${name}.JPG`,source:`/card/${name}.JPG`,destination:`/lib/${name}.JPG`,size:1,kind:'JPEG' as PlanEntry['kind'],skip:true,family:name};
    assert.equal(book.note({entryId:entry.id,family:name,source:entry.source,root:'/lib',rootIdentity:'1:2',destination:entry.destination,size:1,sha256:'0'.repeat(64),disposition:'existing',verification:'content-verified'},entry,transfer,0),true);
  }
  // The same file found again (after Pause and Continue) is the same conflict.
  const [first]=book.list();
  assert.equal(book.note({entryId:first!.source,family:'A',source:first!.source,root:'/lib',rootIdentity:'1:2',destination:first!.existing,size:1,sha256:'0'.repeat(64),disposition:'existing',verification:'content-verified'},{id:first!.source,source:first!.source,destination:first!.existing,size:1,kind:'JPEG' as PlanEntry['kind'],skip:true,family:'A'},transfer,0),false);
  // Files found where older rules filed them, and files written, are no name conflicts.
  assert.equal(book.note({entryId:'x',family:'x',source:'/card/X.JPG',root:'/lib',rootIdentity:'1:2',destination:'/lib/old/X.JPG',size:1,sha256:'1'.repeat(64),disposition:'routed',verification:'content-verified'},{id:'x',source:'/card/X.JPG',destination:'/lib/old/X.JPG',size:1,kind:'JPEG' as PlanEntry['kind'],skip:true,family:'x',routed:'/lib/X.JPG'},transfer,0),false);
  assert.equal(book.choose('overwrite'),3);
  assert.equal(book.summary()!.overwrite,3);assert.equal(book.summary()!.waiting,3);
  assert.equal(book.choose('keep'),3);assert.equal(book.summary()!.keep,3);
  assert.equal(book.choose('skip'),3);assert.equal(book.hasWork(),false);
  book.choose('keep');
  const taken=book.take();
  assert.equal(taken.length,3);
  // While they are applied, choices do not change them.
  assert.equal(book.choose('skip'),0);
  book.settle([{id:taken[0]!.id,ok:true,copy:'/lib/Conflicts/x/A.JPG'},{id:taken[1]!.id,ok:false,error:'disk full'}]);
  const states=book.list().map(item=>item.state);
  assert.deepEqual(states,['done','failed','waiting'],'what was not reached waits again with its choice');
  assert.equal(book.list()[2]!.choice,'keep');
  assert.equal(book.choose('skip'),2,'done stays done');
});

test('Stop all skips every conflict not applied yet, including one being applied when it stops',()=>{
  const book=new ConflictBook(),transfer={source:'/card',root:'/lib',rootIdentity:'1:2'};
  for(const name of ['A','B']){
    const entry:PlanEntry={id:name,source:`/card/${name}.JPG`,destination:`/lib/${name}.JPG`,size:1,kind:'JPEG' as PlanEntry['kind'],skip:true,family:name};
    book.note({entryId:name,family:name,source:entry.source,root:'/lib',rootIdentity:'1:2',destination:entry.destination,size:1,sha256:'0'.repeat(64),disposition:'existing',verification:'content-verified'},entry,transfer,0);
  }
  book.choose('overwrite');
  const taken=book.take();
  assert.equal(taken.length,2);
  book.stopAll();
  book.settle([]);
  assert.deepEqual(book.list().map(item=>[item.choice,item.state]),[['skip','waiting'],['skip','waiting']]);
  assert.equal(book.summary()!.stopped,true);
  assert.equal(book.hasWork(),false);
  assert.deepEqual(book.take(),[]);
  // A new choice after Stop all is a new decision.
  book.choose('keep',[book.list()[0]!.id]);
  assert.equal(book.summary()!.stopped,undefined);
  assert.equal(book.hasWork(),true);
});

test('choices made while the import runs wait for its end; choices made after it apply at once',async t=>{
  const {source,photos,existing}=await library(t,'conflict-later-');
  for(const name of ['A.JPG','B.JPG']){await put(existing(name),big(name[0]!));await put(path.join(source,'DCIM',name),big(name[0]!));}
  const {plans:[transfer]}=await plan(source,[photos],base,fixed);
  const book=new ConflictBook(),byId=new Map(transfer!.entries.map(entry=>[entry.id,entry]));
  let chosenDuring=false;
  const result=await execute(transfer!,undefined,undefined,{onFileOutcome:outcome=>{
    if(book.note(outcome,byId.get(outcome.entryId),transfer!,0)&&!chosenDuring){chosenDuring=true;book.choose('keep',[book.list()[0]!.id]);}
  }});
  assert.deepEqual(result.errors,[]);
  assert.equal(book.size,2);
  // Nothing was applied during the copy: the chosen keep waits.
  assert.equal(book.summary()!.waiting,1);
  assert.equal((await fs.readdir(path.join(photos,folder))).includes('Conflicts'),false);
  const during=await applyConflictChoices(work(book));
  book.settle(during);
  assert.equal(during.length,1);assert.ok(during[0]!.ok);
  // After the end: Overwrite for the other one is a short follow-up of its own.
  const other=book.list().find(item=>item.state==='waiting')!;
  book.choose('overwrite',[other.id]);
  const later=await applyConflictChoices(work(book));
  book.settle(later);
  assert.ok(later[0]!.ok,String(later[0]!.error));
  assert.deepEqual(book.list().map(item=>item.state).sort(),['done','done']);
});

test('a stop while choices are applied leaves every file as it was or finished, never half replaced',async t=>{
  const {source,photos,existing}=await library(t,'conflict-abort-');
  await put(existing('DSC_0008.JPG'),big('x'));await put(path.join(source,'DCIM','DSC_0008.JPG'),big('x'));
  const {book}=await importOnce(source,photos);
  book.choose('overwrite');
  const control=new AbortController();control.abort();
  const items:ConflictWork[]=work(book);
  await assert.rejects(applyConflictChoices(items,{signal:control.signal}));
  book.settle([]);
  assert.equal(book.list()[0]!.state,'waiting');
  assert.equal(await fileSha(existing('DSC_0008.JPG')),items[0]!.sha256);
});

test('the conflicts panel lists the count, every bulk choice and Stop all, in each language',async()=>{
  const {createElement}=await import('react');
  const {renderToStaticMarkup}=await import('react-dom/server');
  const {I18nProvider}=await import('../renderer/i18n');
  const {ConflictsPanel}=await import('../renderer/ConflictsPanel');
  const job={id:'j',source:{id:'s',name:'Card',path:'/card',transport:'storage'},phase:'copying',errors:[],backup:false,conflicts:{count:3,skip:2,overwrite:1,keep:0,done:0,failed:0,waiting:1,undoable:0,revision:4}} as unknown as import('../shared').Job;
  const html=(language:'en'|'zh-Hans')=>renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(ConflictsPanel,{job,act:()=>{}})}));
  const english=html('en');
  assert.match(english,/3 files are already in the library with the same name and contents/);
  assert.match(english,/The import goes on/);
  for(const id of ['conflicts-skip-all','conflicts-overwrite-all','conflicts-keep-all','conflicts-stop-all','conflicts-toggle'])assert.match(english,new RegExp(`data-testid="${id}"`));
  assert.match(english,/Skip 2 · Overwrite 1 · Keep both 0/);
  assert.match(html('zh-Hans'),/有 3 个文件已在图库中，名称和内容都相同/);
  assert.equal(renderToStaticMarkup(createElement(ConflictsPanel,{job:{...job,conflicts:undefined},act:()=>{}})),'');
  // The bulk choice every file has shows as pressed; the status line is there, empty, until a bulk button is clicked.
  assert.match(english,/data-testid="conflicts-skip-all" aria-pressed="false"/);
  assert.match(english,/data-testid="conflicts-bulk-status"><\/p>/);
  const allSkip=renderToStaticMarkup(createElement(ConflictsPanel,{job:{...job,conflicts:{...job.conflicts!,skip:3,overwrite:0}},act:()=>{}}));
  assert.match(allSkip,/data-testid="conflicts-skip-all" aria-pressed="true"/);
  assert.match(allSkip,/data-testid="conflicts-overwrite-all" aria-pressed="false"/);
});

test('a bulk choice says what the conflicts hold now, also when it changed nothing, in each language',async()=>{
  const {bulkChoiceStatus}=await import('../renderer/ConflictsPanel');
  const {createTranslator}=await import('../renderer/i18n');
  // Skip all when every file is already skipped (the default): it still confirms.
  const all=bulkChoiceStatus({count:409,skip:409,overwrite:0,keep:0},'skip');
  assert.deepEqual(all,{text:'Skip is now chosen for every file ({count}).',params:{count:409}});
  // Two overwrites already applied keep their result.
  const some=bulkChoiceStatus({count:5,skip:3,overwrite:2,keep:0},'skip');
  assert.deepEqual(some.params,{chosen:3,count:5});
  for(const choice of ['skip','overwrite','keep'] as const)for(const summary of [{count:2,skip:2,overwrite:2,keep:2},{count:2,skip:1,overwrite:1,keep:1}]) {
    const {text,params}=bulkChoiceStatus(summary,choice);
    for(const language of ['en','zh-Hans','zh-Hant','ja'] as const) {
      const line=createTranslator(language)(text,params);
      assert.doesNotMatch(line,/\{/,`${language}: ${text}`);
      if(language!=='en')assert.notEqual(line,createTranslator('en')(text,params),`${language} has no translation of: ${text}`);
    }
  }
});
