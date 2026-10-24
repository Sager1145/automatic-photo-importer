import test from 'node:test';
import assert from 'node:assert/strict';
import {ErrorLog,clearErrors,gatherErrors,migrateLoggedError,severityOf} from '../error-log';
import {backendMessages,message,text,type MessageKey} from '../messages';
import type {AppState,Job} from '../shared';

const preferences:AppState['preferences']={language:'en',appearance:'system',textScale:1,accent:'coral',automatic:false,parallel:2,destinations:['/Volumes/A006'],copyMode:'single',basePath:'photobackup',template:'{year}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,unknownRules:{}};
const card={id:'card',name:'Card',path:'/Volumes/Card',transport:'storage' as const};
const job=(extra:Partial<Job>):Job=>({id:'j1',source:card,phase:'error',errors:[],backup:false,...extra});
const state=(extra:Partial<AppState>={}):AppState=>({preferences,sources:[card],jobs:[],history:[],platform:'darwin',...extra});

// Message keys that can reach All errors, with their severity. Any other key defaults to an error.
const warnings:MessageKey[]=['error.userSkipped','inventory.emptyFile','inventory.emptySkipped','inventory.emptyPrimaryFile','inventory.emptyPrimarySkipped'];
const errorKeys:MessageKey[]=['error.sourceDisconnected','error.sourceChanged','error.alreadyInBackup','error.cameraScan','error.busy','error.mirrorReview','error.organizeSpace','error.destinationUnavailable','error.destinationReadOnly','error.fileFailed','error.residueCleanup'];

test('each known message key has the severity the table says',()=>{
 for(const key of warnings)assert.equal(severityOf(message(key)),'warning',key);
 for(const key of errorKeys)assert.equal(severityOf(message(key)),'error',key);
 for(const key of Object.keys(backendMessages) as MessageKey[])assert.ok(['error','warning'].includes(severityOf(message(key))),key);
 assert.equal(severityOf(text('EIO: read failed')),'error','raw text is an error');
 assert.equal(severityOf(text('Unreadable header'),'metadata'),'warning','a metadata problem is a warning');
 assert.equal(severityOf(message('error.fileSkipped',{path:'/a.NEF',error:message('error.userSkipped')})),'warning','skipped on purpose');
 assert.equal(severityOf(message('error.fileSkipped',{path:'/a.NEF',error:text('EIO')})),'error','skipped because it failed');
});

test('gathered items carry a severity: metadata notes are warnings, failures are errors',()=>{
 const value=state({jobs:[job({errors:[text('ENOSPC'),message('inventory.emptyFile')],inventory:{issues:[{path:'/Volumes/Card/A.NEF',message:'Bad EXIF'}],files:[],media:0,companions:0,unknown:0,bytes:0,unknownExtensions:{},elapsedMs:0}})]});
 const found=gatherErrors(value).map(item=>`${item.kind}:${item.severity}`).sort();
 assert.deepEqual(found,['metadata:warning','source:error','source:warning']);
});

test('clearing one severity never clears the other',()=>{
 const log=new ErrorLog();
 const value=state({error:text('Busy'),jobs:[job({phase:'copying',errors:[text('E1'),message('error.userSkipped'),message('inventory.emptyFile')]})]});
 const all=gatherErrors(value),errors=all.filter(item=>item.severity==='error'),warns=all.filter(item=>item.severity==='warning');
 assert.equal(errors.length,2);assert.equal(warns.length,2);
 log.update(all);
 clearErrors(log,value,{severity:'warning'});
 assert.deepEqual(log.update(gatherErrors(value)).cleared.sort(),warns.map(item=>item.id).sort(),'only warnings cleared');
 assert.ok(value.error,'the app error is untouched');
 clearErrors(log,value,{ids:[errors[0]!.id],severity:'warning'});
 assert.equal(log.update(gatherErrors(value)).cleared.length,2,'a warning-scoped clear ignores an error id');
 clearErrors(log,value,{severity:'error'});
 assert.equal(value.error,undefined);
 assert.equal(log.update(gatherErrors(value)).cleared.length,3,'the app error is gone, the rest are cleared');
 const other=new ErrorLog();other.update(all);
 clearErrors(other,value,{severity:'error'});
 assert.deepEqual(other.update(gatherErrors(value)).cleared.sort(),errors.filter(item=>item.kind!=='app').map(item=>item.id).sort(),'only errors cleared');
});

test('saved log state restores timestamps and cleared ids; old entries get a severity from their key',()=>{
 const value=state({jobs:[job({errors:[text('E1'),message('error.userSkipped')]})]});
 const first=new ErrorLog(),when=new Date('2026-10-22T09:00:00Z');
 const saved=first.update(gatherErrors(value),when);
 const restored=new ErrorLog(saved),next=restored.update(gatherErrors(value),new Date('2026-10-22T11:00:00Z'));
 assert.deepEqual(next.at,saved.at,'timestamps survive');
 const [old]=gatherErrors(state({jobs:[job({errors:[message('error.userSkipped')]})]}));
 const {severity:_removed,...legacy}=old!;
 assert.equal(migrateLoggedError(legacy).severity,'warning');
 assert.equal(migrateLoggedError({...legacy,message:text('EIO'),kind:'source'}).severity,'error');
 assert.equal(migrateLoggedError({...legacy,severity:'error'}).severity,'error','a stored severity is kept');
});

test('titlebar shows separate error and warning counts; the panel has two sections with their own actions',async()=>{
 const {createElement}=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
 const {I18nProvider,createTranslator,languages}=await import('../renderer/i18n');
 const {ActivityPanel,TitlebarControls,SidebarSources,collectErrors}=await import('../renderer/RootApp');
 const value=state({jobs:[job({errors:[text('EIO: read A'),message('error.userSkipped'),message('inventory.emptyFile')]})]});
 value.errorLog=new ErrorLog().update(gatherErrors(value));
 const errors=collectErrors(value);
 assert.deepEqual([errors.filter(item=>item.severity==='error').length,errors.filter(item=>item.severity==='warning').length],[1,2]);
 for(const language of languages){
  const t=createTranslator(language),render=(child:ReturnType<typeof createElement>)=>renderToStaticMarkup(createElement(I18nProvider,{language,children:child}));
  const bar=render(createElement(TitlebarControls,{state:value,act:()=>{},errorCount:1,warningCount:2,onErrors:()=>{}}));
  assert.ok(/class="error-count"[^>]*data-count="1"/.test(bar)&&/data-testid="warning-count"[^>]*data-count="2"/.test(bar),`${language}: both counts`);
  assert.ok(bar.includes('data-testid="show-errors"'));
  const none=render(createElement(TitlebarControls,{state:value,act:()=>{},errorCount:3,onErrors:()=>{}}));
  assert.ok(!none.includes('warning-count'),`${language}: no warning badge without warnings`);
  const panel=render(createElement(ActivityPanel,{state:value,errors,act:()=>{}}));
  for(const id of ['errors-section','warnings-section','errors-clear-all','warnings-clear-all','errors-copy-all','warnings-copy-all'])assert.ok(panel.includes(`data-testid="${id}"`),`${language}: ${id}`);
  assert.ok(panel.includes(t('Errors'))&&panel.includes(t('Warnings')));
  const split=panel.indexOf('data-testid="warnings-section"');
  assert.equal((panel.slice(0,split).match(/data-testid="error-clear"/g)??[]).length,1,`${language}: one error`);
  assert.equal((panel.slice(split).match(/data-testid="error-clear"/g)??[]).length,2,`${language}: two warnings`);
  const sources=render(createElement(SidebarSources,{state:value,onOpen:()=>{},errors,onErrors:()=>{}}));
  assert.ok(sources.includes(`data-testid="sidebar-errors" data-level="error" aria-label="${t('{count} errors',{count:1})}"`),`${language}: sidebar counts errors only`);
  assert.ok(sources.includes('data-testid="sidebar-warnings"')&&sources.includes(`aria-label="${t('{count} warnings',{count:2})}"`),`${language}: warning indicator`);
 }
 // Warnings only: no red badge, just the indicator.
 const calm=state({jobs:[job({errors:[message('error.userSkipped')]})]});calm.errorLog=new ErrorLog().update(gatherErrors(calm));
 const html=renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(SidebarSources,{state:calm,onOpen:()=>{},errors:collectErrors(calm),onErrors:()=>{}})}));
 assert.ok(!html.includes('sidebar-errors')&&html.includes('sidebar-warnings'));
});

test('the dashboard counts the warnings All errors shows: a cleared warning is not counted',async()=>{
 const {createElement}=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
 const {I18nProvider}=await import('../renderer/i18n');
 const {ImportDashboard}=await import('../renderer/RootApp');
 const render=(value:AppState)=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(ImportDashboard,{state:value,act:()=>{}})}));
 const value=state({jobs:[job({errors:[message('error.userSkipped'),message('inventory.emptyFile')]})]});
 value.errorLog=new ErrorLog().update(gatherErrors(value));
 assert.match(render(value),/2 warnings/);
 const [first]=gatherErrors(value).filter(item=>item.severity==='warning');
 value.errorLog={...value.errorLog,cleared:[first!.id]};
 assert.match(render(value),/1 warnings/);
 value.errorLog={...value.errorLog,cleared:gatherErrors(value).map(item=>item.id)};
 assert.doesNotMatch(render(value),/warnings/);
});
