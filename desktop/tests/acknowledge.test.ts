import { freshOrganizeOptions } from '../run-policy';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,realpath,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ErrorLog,gatherErrors} from '../error-log';
import {buildRows,rowCounts} from '../error-groups';
import {acknowledgeJob,acknowledgeSummary} from '../acknowledge';
import {errorTotal,recordIssue,reportSummary} from '../job-issues';
import {deleteOriginals} from '../core/originals';
import {createTranslator,languages} from '../renderer/i18n';
import {text} from '../messages';
import type {AppState,Job} from '../shared';
import { defaultPreferences } from '../preferences';

const preferences:AppState['preferences']={...defaultPreferences, language:'en',appearance:'system',textScale:1,accent:'coral',automatic:false,parallel:2,destinations:['/Volumes/A006'],copyMode:'single',basePath:'photobackup',template:'{year}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',unknownRules:{}};
const card={id:'card',name:'Card',path:'/Volumes/Card',transport:'storage' as const};
const failedJob=():Job=>{
 const job:Job={id:'j1',source:card,phase:'error',errors:[],backup:false,retryable:true};
 for(let index=0;index<5;index++)recordIssue(job,{code:'copy-failed',severity:'error',path:`/a/${index}.NEF`});
 for(let index=0;index<20;index++)recordIssue(job,{code:'staging-left',severity:'warning',path:`/b/${index}.partial`});
 return job;
};
const state=(job:Job):AppState=>({preferences,sources:[card],jobs:[job],history:[],platform:'darwin',organizeOptions:freshOrganizeOptions()});
const badge=(job:Job)=>rowCounts(buildRows(gatherErrors(state(job))));

test('skipping a group removes it from the badge and the panel, and a job with nothing left becomes complete',()=>{
 const job=failedJob();
 assert.deepEqual(badge(job),{errors:1,warnings:1});
 const record=acknowledgeJob(job,['copy-failed'],new Date('2026-10-22T10:00:00Z'));
 assert.deepEqual(badge(job),{errors:0,warnings:1});
 assert.equal(gatherErrors(state(job)).some(error=>error.code==='copy-failed'),false);
 assert.equal(record.errorCount,5);assert.deepEqual(record.codes,['copy-failed']);
 assert.equal(job.phase,'complete');assert.equal(errorTotal(job),0);
 assert.equal(job.groups!.find(group=>group.code==='copy-failed')!.count,5,'the original list is kept');
});

test('skip all marks the job complete with an acknowledged record and passes the summary',async()=>{
 const job:Job={...failedJob(),errors:[text('EIO: read x')]};
 const record=acknowledgeJob(job);
 assert.equal(job.phase,'complete');assert.equal(record.all,true);assert.equal(record.errorCount,6);
 assert.deepEqual(record.groups.map(group=>group.code).sort(),['copy-failed','text']);
 assert.equal(gatherErrors(state(job)).filter(error=>error.severity==='error').length,0);
 const directory=await mkdtemp(path.join(tmpdir(),'ack-'));
 await writeFile(path.join(directory,'summary.json'),JSON.stringify({...reportSummary(['x'],[],1),jobId:'j1'}));
 await writeFile(path.join(directory,'execution.json'),JSON.stringify({errors:['x']}));
 await acknowledgeSummary(directory,record);
 const summary=JSON.parse(await readFile(path.join(directory,'summary.json'),'utf8'));
 assert.equal(summary.passed,true);assert.equal(summary.acknowledged.errorCount,6);assert.equal(summary.jobId,'j1');
 assert.deepEqual(JSON.parse(await readFile(path.join(directory,'execution.json'),'utf8')),{errors:['x']},'the full error list stays in execution.json');
});

test('only finished jobs can be skipped, and only for codes they have',()=>{
 assert.throws(()=>acknowledgeJob({...failedJob(),phase:'copying'}));
 assert.throws(()=>acknowledgeJob(failedJob(),['nope']));
 assert.throws(()=>acknowledgeJob(failedJob(),[]));
});

test('skipping never touches data: Delete originals still removes only verified files',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'ack-src-'))),backup=await realpath(await mkdtemp(path.join(tmpdir(),'ack-dst-')));
 const good=path.join(root,'good.NEF'),bad=path.join(root,'bad.NEF'),copy=path.join(backup,'good.NEF');
 await writeFile(good,'good bytes');await writeFile(bad,'bad bytes');await writeFile(copy,'good bytes');
 const verified=[{source:good,size:10,sha256:createHash('sha256').update('good bytes').digest('hex'),destinations:[copy]}];
 const job=failedJob();acknowledgeJob(job);
 const before=await readFile(bad,'utf8');
 const result=await deleteOriginals(root,verified);
 assert.deepEqual(result.deleted.map(item=>item.source),[good]);
 assert.equal(await readFile(bad,'utf8'),before,'the file whose copy failed is never deleted');
 // Even if a failed file were listed, a missing backup copy keeps it.
 const risky=await deleteOriginals(root,[{source:bad,size:9,sha256:createHash('sha256').update('bad bytes').digest('hex'),destinations:[path.join(backup,'bad.NEF')]}]);
 assert.equal(risky.deleted.length,0);assert.equal(await readFile(bad,'utf8'),'bad bytes');
 await mkdir(backup,{recursive:true});
});

test('the skip labels exist in all four locales',()=>{
 const keys=['Skip these','Skip all and mark as done','Skipping only changes the status. Nothing is deleted.','{count} issues skipped','1 issue skipped'];
 for(const language of languages.filter(item=>item!=='en')){const t=createTranslator(language);for(const key of keys)assert.notEqual(t(key),key,`${language}: ${key}`);}
});

test('the panel and the job card offer the skip buttons',async()=>{
 const {createElement}=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
 const {I18nProvider}=await import('../renderer/i18n');const {ActivityPanel,collectErrors}=await import('../renderer/RootApp');
 const job=failedJob(),value=state(job);value.errorLog=new ErrorLog().update(gatherErrors(value));
 const panel=renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(ActivityPanel,{state:value,errors:collectErrors(value),act:()=>{}})}));
 assert.ok(panel.includes('data-testid="error-group-skip"'));assert.ok(panel.includes('data-testid="job-skip-all"'));
 assert.equal(panel.includes('data-testid="error-group-skip"')&&(panel.match(/data-testid="error-group-skip"/g)??[]).length,1,'warnings have no Skip');
});

test('old records are a warning row in Issues with Acknowledge, and the sidebar shows only the warning mark',async()=>{
 const {createElement}=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
 const {I18nProvider}=await import('../renderer/i18n');const {ActivityPanel,SidebarDestinations,collectErrors}=await import('../renderer/RootApp');
 const value:AppState={...state({id:'j',source:card,phase:'complete',errors:[],backup:false}),oldRecords:['/Volumes/A006']};
 const logged=(next:AppState)=>({...next,errorLog:new ErrorLog().update(gatherErrors(next))});
 const withLog=logged(value),errors=collectErrors(withLog),old=errors.filter(error=>error.oldDrive);
 assert.equal(old.length,1);assert.equal(old[0]!.severity,'warning');assert.equal(old[0]!.drive,'A006');
 assert.deepEqual(gatherErrors(value).filter(error=>error.oldDrive).map(error=>[error.id,error.code,error.kind,error.severity,error.message]),[['old-records:/Volumes/A006','error.oldRecords','destination','warning',{key:'error.oldRecords',params:{drive:'A006'}}]],'gatherErrors is the one source of the old-records issue');
 assert.deepEqual(gatherErrors({...value}).map(error=>error.id),gatherErrors(value).map(error=>error.id),'the id is stable');
 const render=(child:ReturnType<typeof createElement>)=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:child}));
 const panel=render(createElement(ActivityPanel,{state:withLog,errors,act:()=>{}}));
 assert.match(panel,/data-testid="old-records-acknowledge"/);assert.match(panel,/Old records from an earlier version are on A006\./);
 assert.doesNotMatch(panel,/data-testid="error-clear"/);
 const sidebar=render(createElement(SidebarDestinations,{state:withLog,errors,onErrors:()=>{}}));
 assert.doesNotMatch(sidebar,/sidebar-old-records|old-records-acknowledge|records-migrator/);assert.match(sidebar,/data-testid="sidebar-warnings"/);
 assert.deepEqual(collectErrors(logged({...value,oldRecords:[]})).filter(error=>error.oldDrive),[]);
});
