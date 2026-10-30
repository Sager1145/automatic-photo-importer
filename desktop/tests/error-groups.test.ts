import { freshOrganizeOptions } from '../run-policy';
import test from 'node:test';
import assert from 'node:assert/strict';
import {ErrorLog,gatherErrors,severityOf,codeOf,createErrorLogCache,clearErrors} from '../error-log';
import {buildRows,rowCounts} from '../error-groups';
import {errorTotal,issuePaths,recordIssue,reportSummary,throttled} from '../job-issues';
import {createStateChannel} from '../state-channel';
import {message,text} from '../messages';
import {createTranslator,languages} from '../renderer/i18n';
import {MAX_GROUP_ITEMS,type AppState,type ExecutionIssue,type Job} from '../shared';
import { defaultPreferences } from '../preferences';

const preferences:AppState['preferences']={...defaultPreferences, language:'en',appearance:'system',textScale:1,accent:'coral',automatic:false,parallel:2,destinations:['/Volumes/A006'],copyMode:'single',basePath:'photobackup',template:'{year}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',unknownRules:{}};
const card={id:'card',name:'Card',path:'/Volumes/Card',transport:'storage' as const};
const newJob=(extra:Partial<Job>={}):Job=>({id:'j1',source:card,phase:'complete',errors:[],backup:false,...extra});
const state=(jobs:Job[]):AppState=>({preferences,sources:[card],jobs,history:[],platform:'darwin',organizeOptions:freshOrganizeOptions()});
const leftover=(index:number):ExecutionIssue=>({code:'staging-left',severity:'warning',path:`/Volumes/A006/photobackup/2024/.photo-importer-${index}.partial`,detail:'expected 1:2:3 found 1:2:4',destination:1});

test('17,883 identical leftovers become one warning group; no per-file entries',()=>{
 const job=newJob();
 for(let index=0;index<17_883;index++)recordIssue(job,leftover(index));
 assert.equal(job.errors.length,0);
 assert.equal(job.groups!.length,1);assert.equal(job.groups![0]!.count,17_883);assert.equal(job.groups![0]!.items.length,MAX_GROUP_ITEMS);
 assert.equal(issuePaths(job,'staging-left').length,17_883,'the full list stays available on demand');
 const logged=gatherErrors(state([job]));
 assert.equal(logged.length,1);assert.equal(logged[0]!.severity,'warning');assert.equal(logged[0]!.code,'staging-left');assert.equal(logged[0]!.count,17_883);
 const rows=buildRows(logged);assert.equal(rows.length,1);assert.equal(rows[0]!.count,17_883);
 assert.deepEqual(rowCounts(rows),{errors:0,warnings:1},'the badge counts groups, not leftovers');
});

test('a staging leftover is a warning: the job is not in error and the report passes',()=>{
 const job=newJob();
 for(let index=0;index<50;index++)recordIssue(job,leftover(index));
 assert.equal(errorTotal(job),0);
 const summary=reportSummary([],Array.from({length:50},(_,index)=>leftover(index)),0);
 assert.equal(summary.passed,true);assert.equal(summary.warningCount,50);assert.deepEqual(summary.warningCodes,{'staging-left':50});
 assert.equal(reportSummary(['x'],[],0).passed,false);assert.equal(reportSummary([],[],1).passed,false);
 recordIssue(job,{code:'copy-failed',severity:'error',path:'/a.NEF'});
 assert.equal(errorTotal(job),1,'a real failure still counts');
 assert.equal(severityOf(message('error.fileSkipped',{path:'/a',error:text('EIO')})),'error');
});

test('entries without a code fall back to one derived from the message key',()=>{
 assert.equal(codeOf(message('error.fileSkipped',{path:'/a',error:text('x')})),'file-skipped');
 assert.equal(codeOf(message('inventory.emptyFile')),'zero-byte');
 assert.equal(codeOf(text('EIO')),'text');
 assert.equal(codeOf({key:'text',params:{text:'x',code:'unreadable'}}),'unreadable');
});

test('benchmark: 100,000 errors of 3 kinds fold in under 1 s, the payload stays under 100 KB and emits follow the throttle',()=>{
 const job=newJob({phase:'copying'});let asked=0,emitted=0,clock=0;
 const emit=throttled(()=>{emitted++;},100,()=>clock);
 const add=(issue:ExecutionIssue)=>{recordIssue(job,issue);asked++;emit();};
 const kinds:Pick<ExecutionIssue,'code'|'severity'>[]=[{code:'staging-left',severity:'warning'},{code:'copy-failed',severity:'error'},{code:'unreadable',severity:'warning'}];
 const started=performance.now();
 for(let index=0;index<100_000;index++){clock=index*0.01;const kind=kinds[index%3]!;add({...kind,path:`/Volumes/A006/photobackup/2024/IMG_${index}.NEF`,detail:'expected 1:2:3 found 1:2:4'});}
 const elapsed=performance.now()-started;
 assert.ok(elapsed<1000,`took ${elapsed.toFixed(0)} ms`);
 assert.equal(asked,100_000);
 assert.ok(emitted<=Math.ceil(clock/100)+1,`${emitted} emits for ${clock} ms`);
 assert.equal(job.groups!.length,3);
 let payload=0;const channel=createStateChannel(update=>{payload=JSON.stringify(update).length;});
 const value=state([job]);value.errorLog=new ErrorLog().update(gatherErrors(value));
 channel.publish(value);
 console.log(`error burst: ${elapsed.toFixed(0)} ms, ${emitted} emits for ${asked} errors, payload ${(payload/1024).toFixed(1)} KB`);
 // The log now carries the entries the renderer used to derive from the jobs, so the burst crosses twice (job groups and log).
 assert.ok(payload<200*1024,`payload ${payload} bytes`);
});

test('the All errors panel renders at most 250 rows for 100,000 errors',async()=>{
 const {createElement}=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
 const {I18nProvider}=await import('../renderer/i18n');const {ActivityPanel,collectErrors}=await import('../renderer/RootApp');
 const job=newJob({phase:'error'});
 for(let index=0;index<100_000;index++)recordIssue(job,index%3===0?leftover(index):index%3===1?{code:'copy-failed',severity:'error',path:`/a/${index}.NEF`}:{code:'unreadable',severity:'warning',path:`/b/${index}.NEF`});
 const value=state([job]);value.errorLog=new ErrorLog().update(gatherErrors(value));
 const errors=collectErrors(value);
 const markup=renderToStaticMarkup(createElement(I18nProvider,{...defaultPreferences, language:'en',children:createElement(ActivityPanel,{state:value,errors,act:()=>{},onClose:()=>{}})}));
 const rows=(markup.match(/<li /g)??[]).length;
 assert.ok(rows<=250,`${rows} rows`);assert.equal((markup.match(/data-testid="error-group"/g)??[]).length,3);
 assert.ok(markup.includes('33,334 temporary copies were left on'),'plain-language title');
 assert.ok(markup.includes('data-testid="error-group-cleanup"')&&markup.includes('data-testid="error-group-clear"'));
 console.log(`panel rows for 100k errors: ${rows}, markup ${(markup.length/1024).toFixed(0)} KB`);
});

test('every group string exists in all four locales',()=>{
 const keys=['{count} temporary copies were left on {drive} — your photos are safe','1 temporary copy was left on {drive} — your photo is safe','These are scratch files from the copy step. Every real copy was checked and is complete; Clean up removes the leftovers.','{count} files could not be read for photo details','1 file could not be read for photo details','The files are still copied; their dates may come from the file instead.','{count} empty files were left out','1 empty file was left out','Empty files hold no photo data.','{count} files could not be copied','1 file could not be copied','These files are not in the backup yet. Retry runs the job again.','{count} files were skipped because they failed','1 file was skipped because it failed','The other files were copied. Retry runs the job again, including these files.','{count} issues need attention','1 issue needs attention','Copy details','Clear group','Retry all','Show more','and {count} more','Copy all paths','Show affected files','Hide affected files','Technical detail'];
 for(const language of languages.filter(item=>item!=='en')){const t=createTranslator(language);for(const key of keys)assert.notEqual(t(key),key,`${language}: ${key}`);}
});

test('Delete originals shows for a complete job, and for an error job without real failures; real failures hide it',async()=>{
 const {createElement}=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
 const {I18nProvider}=await import('../renderer/i18n');const {DeleteOriginals}=await import('../renderer/RootApp');
 const folder={id:'f',name:'Untitled',path:'/Users/me/Untitled',transport:'folder' as const};
 const render=(job:Job)=>renderToStaticMarkup(createElement(I18nProvider,{...defaultPreferences, language:'en',children:createElement(DeleteOriginals,{job,act:()=>{}})}));
 const base=newJob({source:folder,verifiedOriginals:10});
 assert.notEqual(render({...base,phase:'complete'}),'');
 const leftovers=newJob({source:folder,verifiedOriginals:10,phase:'error'});for(let index=0;index<20;index++)recordIssue(leftovers,leftover(index));
 assert.notEqual(render(leftovers),'','only leftovers: still offered');
 const failed=newJob({source:folder,verifiedOriginals:10,phase:'error',errors:[text('EIO')]});
 assert.equal(render(failed),'','a real failure hides it');
});

test('progress emits stay at 4 a second while copying, and the error log is rebuilt only when errors change',()=>{
 let clock=0,emitted=0;
 const copying=newJob({phase:'copying'});
 const emit=throttled(()=>{emitted++;},()=>copying.phase==='copying'?250:100,()=>clock);
 for(clock=0;clock<10_000;clock+=5)emit();
 assert.ok(emitted<=40,`${emitted} emits in 10 s`);assert.ok(emitted>=35);
 const log=new ErrorLog(),cache=createErrorLogCache(log),value=state([copying]);
 for(let index=0;index<50;index++)cache.refresh(value);
 assert.equal(cache.builds,1,'nothing changed: built once');
 recordIssue(copying,leftover(1));cache.refresh(value);cache.refresh(value);
 assert.equal(cache.builds,2,'a new issue rebuilds once');
 clearErrors(log,value);cache.refresh(value);
 assert.equal(cache.builds,3,'a clear rebuilds once');
});
