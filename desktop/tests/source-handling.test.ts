import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {plan,execute,configureOrganizationRecovery} from '../core/index';
import {measureOriginals,deleteOriginals,type VerifiedOriginal} from '../core/originals';
import {destinationEntries} from '../core/allocation';
import {sourcePolicy,freshOrganizeOptions,organizeDefaults} from '../run-policy';
import {normalizePreferences} from '../preferences';
import {I18nProvider,languages,createTranslator} from '../renderer/i18n';
import {DeleteOriginals,OriginalsConfirm} from '../renderer/RootApp';
import {nextConfirmStep} from '../renderer/ui';
import type {Job,Metadata} from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2024-02-03T12:00:00Z',fields:{}});

async function imported(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'photo-handling-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),root=path.join(base,'destination');await fs.mkdir(path.join(source,'DCIM'),{recursive:true});await fs.mkdir(root);
 for(const name of ['A','B','C'])await fs.writeFile(path.join(source,'DCIM',name+'.JPG'),name.repeat(100+name.charCodeAt(0)));
 const verified=new Map<string,string>();
 const [transfer]=(await plan(source,[root],options,metadata)).plans;
 await execute(transfer!,undefined,undefined,{onFileOutcome:outcome=>{verified.set(outcome.source,outcome.sha256);}});
 const files:VerifiedOriginal[]=destinationEntries(transfer!).map(entry=>({source:entry.source,size:entry.size,sha256:verified.get(entry.source)??'',destinations:[entry.destination]}));
 return {base,source,root,files};
}
const listing=async(folder:string)=>(await fs.readdir(folder,{recursive:true})).sort();

test('an import never touches its source, even with saved preferences that would delete',async t=>{
 const prefs=normalizePreferences({removeEmptySourceFolders:true,releaseDuplicatesAfterOrganizing:true,copyMode:'mirror',backupMode:'mirror'});
 for(const choice of [freshOrganizeOptions(),{removeEmptyFolders:true,releaseDuplicates:true}]){
  const policy=sourcePolicy('import',choice,prefs);
  assert.deepEqual(policy,{sourceAction:'copy',removeEmptySourceFolders:false,releaseDuplicates:false,verifyCopies:true});
 }
 const {source,files}=await imported(t);
 assert.equal(files.length,3);assert.deepEqual(await listing(source),['DCIM','DCIM/A.JPG','DCIM/B.JPG','DCIM/C.JPG']);
 for(const file of files)assert.equal((await fs.stat(file.source)).size,file.size);
});

test('organizing defaults to move, remove emptied folders and release duplicates, and each run starts from those defaults',()=>{
 const prefs=normalizePreferences({removeEmptySourceFolders:false,releaseDuplicatesAfterOrganizing:false});
 assert.deepEqual(sourcePolicy('reorganize',undefined,prefs),{sourceAction:'move',removeEmptySourceFolders:true,releaseDuplicates:true,verifyCopies:true});
 const run=freshOrganizeOptions();run.removeEmptyFolders=false;
 assert.equal(sourcePolicy('reorganize',run,prefs).removeEmptySourceFolders,false);
 // The next run does not inherit the previous run's choice.
 assert.deepEqual(freshOrganizeOptions(),organizeDefaults);assert.notEqual(freshOrganizeOptions(),freshOrganizeOptions());
 assert.equal(sourcePolicy('reorganize',freshOrganizeOptions(),prefs).removeEmptySourceFolders,true);
 assert.throws(()=>{(organizeDefaults as {removeEmptyFolders:boolean}).removeEmptyFolders=false;});
});

test('Delete originals removes only files verified in the backup and refuses changed, unverified or missing-copy ones',async t=>{
 const {source,files}=await imported(t);
 const [a,b,c]=files.sort((x,y)=>x.source.localeCompare(y.source)) as [VerifiedOriginal,VerifiedOriginal,VerifiedOriginal];
 assert.deepEqual(await measureOriginals(source,files),{files:3,bytes:files.reduce((sum,f)=>sum+f.size,0),kept:0});
 // A: source changed after the import (same size). B: never verified. C: stays verified.
 await fs.writeFile(a.source,'X'.repeat(a.size));
 const unverified={...b,sha256:''};
 const result=await deleteOriginals(source,[a,unverified,c]);
 assert.deepEqual(result.deleted.map(item=>item.source),[c.source]);
 assert.deepEqual(result.kept.map(item=>[path.basename(item.source),item.reason]),[['A.JPG','changed'],['B.JPG','unverified']]);
 assert.deepEqual(await listing(source),['DCIM','DCIM/A.JPG','DCIM/B.JPG']);
 // The backup copy of C is untouched.
 assert.equal((await fs.stat(c.destinations[0]!)).size,c.size);
});

test('Delete originals keeps a file whose backup copy is missing or differs, and never follows paths outside the source',async t=>{
 const {base,source,files}=await imported(t);
 const [a,b,c]=files.sort((x,y)=>x.source.localeCompare(y.source)) as [VerifiedOriginal,VerifiedOriginal,VerifiedOriginal];
 await fs.rm(a.destinations[0]!);
 await fs.writeFile(b.destinations[0]!,'Y'.repeat(b.size));
 const outside=path.join(base,'outside.JPG');await fs.writeFile(outside,'Z');
 const result=await deleteOriginals(source,[a,b,{...c,source:outside,destinations:[c.destinations[0]!]}]);
 assert.deepEqual(result.deleted,[]);
 assert.deepEqual(result.kept.map(item=>item.reason),['destination-missing','destination-differs','unsafe']);
 assert.equal((await listing(source)).length,4);await fs.stat(outside);
});

const job:Job={id:'j1',source:{id:'folder:/x',name:'Shoot',path:'/x',transport:'folder'},phase:'complete',errors:[],backup:false,verifiedOriginals:3};
const render=(child:ReturnType<typeof createElement>,language:'en'|'zh-Hans'|'zh-Hant'|'ja'='en')=>renderToStaticMarkup(createElement(I18nProvider,{language,children:child}));

test('Delete originals asks twice, names count and size, and only the second confirmation deletes',()=>{
 const first=nextConfirmStep('closed','open');
 const second=nextConfirmStep(first.step,'confirm');
 assert.deepEqual([first,second],[{step:'first',delete:false},{step:'second',delete:false}]);
 assert.deepEqual(nextConfirmStep(second.step,'confirm'),{step:'closed',delete:true});
 assert.equal(nextConfirmStep('first','cancel').delete,false);
 for(const language of languages){
  const t=createTranslator(language);
  const card=render(createElement(DeleteOriginals,{job,act:()=>{}}),language);
  assert.ok(card.includes('data-testid="delete-originals-button"')&&card.includes(t('Delete originals already in the backup')),language);
  assert.ok(card.includes(t('Import: copy, source untouched')),language);
  const size={jobId:'j1',files:1200,bytes:5e9,kept:4};
  const one=render(createElement(OriginalsConfirm,{step:'first',name:'Shoot',size,onCancel:()=>{},onConfirm:()=>{}}),language);
  assert.ok(one.includes((1200).toLocaleString(language))&&one.includes(t('Delete originals already in the backup?').replaceAll("'",'&#x27;')),language);
  const two=render(createElement(OriginalsConfirm,{step:'second',name:'Shoot',size,onCancel:()=>{},onConfirm:()=>{}}),language);
  const buttons=two.match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/g)!;
  assert.equal(buttons.length,2);assert.match(buttons[0]!,/data-autofocus/);assert.match(buttons[1]!,/button-danger/);assert.ok(buttons[1]!.includes(t('Delete permanently')));
 }
 // Not offered before the import finished, for cameras, or when nothing was verified.
 assert.equal(render(createElement(DeleteOriginals,{job:{...job,phase:'copying'},act:()=>{}})),'');
 assert.equal(render(createElement(DeleteOriginals,{job:{...job,source:{...job.source,transport:'camera'}},act:()=>{}})),'');
 assert.equal(render(createElement(DeleteOriginals,{job:{...job,verifiedOriginals:undefined},act:()=>{}})),'');
 // Nothing to confirm until the count is known, or when it is zero.
 const measuring=render(createElement(OriginalsConfirm,{step:'first',name:'Shoot',onCancel:()=>{},onConfirm:()=>{}}));
 assert.match(measuring.match(/<button[^>]*button-danger[^>]*>/)![0],/disabled/);
});

test('a stopped Delete originals still reports every file it removed, and keeps the rest',async t=>{
 const {source,files}=await imported(t);
 const control=new AbortController();
 const result=await deleteOriginals(source,files,{signal:control.signal,onProgress:completed=>{if(completed===1)control.abort();}});
 assert.equal(result.stopped,true);
 assert.equal(result.deleted.length+result.kept.length,files.length,'every file is accounted for');
 for(const item of result.deleted)await assert.rejects(fs.stat(item.source),'reported deleted, so it is gone');
 for(const item of result.kept){assert.equal(item.reason,'stopped');assert.ok((await fs.stat(item.source)).isFile(),'kept, so it is still there');}
});
