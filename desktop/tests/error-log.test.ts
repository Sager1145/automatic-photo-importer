import test from 'node:test';
import assert from 'node:assert/strict';
import {ErrorLog,clearErrors,driveName,gatherErrors} from '../error-log';
import {text} from '../messages';
import type {AppState,Job} from '../shared';

const preferences:AppState['preferences']={language:'en',appearance:'system',textScale:1,accent:'coral',automatic:false,parallel:2,destinations:['/Volumes/A006'],copyMode:'single',basePath:'photobackup',template:'{year}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,unknownRules:{}};
const untitled={id:'untitled',name:'Untitled',path:'/Volumes/Untitled',transport:'storage' as const};
const folder={id:'folder',name:'photobackup',path:'/Volumes/A006/photobackup',transport:'folder' as const};
const job=(extra:Partial<Job>):Job=>({id:'j1',source:untitled,phase:'error',errors:[],backup:false,...extra});
const state=(extra:Partial<AppState>={}):AppState=>({preferences,sources:[untitled,folder],jobs:[],history:[],platform:'darwin',...extra});

test('the drive name comes from the mounted volume, else the source name',()=>{
 assert.equal(driveName('/Volumes/A006/photobackup/2022','photobackup'),'A006');
 assert.equal(driveName('/Volumes/NIKON Z F','NIKON Z F'),'NIKON Z F');
 assert.equal(driveName('gphoto2://usb:001,004','NIKON Z F'),'NIKON Z F');
 assert.equal(driveName('/Users/me/Pictures','Pictures'),'Pictures');
});

test('every gathered error names its source and drive and has a stable id',()=>{
 const value=state({error:text('Busy'),jobs:[job({errors:[text('EIO: read /Volumes/Untitled/DSC_1.NEF'),text('EIO: read /Volumes/Untitled/DSC_1.NEF')]}),job({id:'j2',source:folder,errors:[text('ENOSPC')]})],
  destinationStatus:[{path:'/Volumes/A006',available:false,detail:'Not mounted'}]});
 const errors=gatherErrors(value);
 assert.deepEqual(errors.map(error=>[error.source,error.drive,error.kind]),[['','','app'],['Untitled','Untitled','source'],['photobackup','A006','source'],['/Volumes/A006','A006','destination']]);
 assert.deepEqual(gatherErrors(value).map(error=>error.id),errors.map(error=>error.id),'ids are stable across calls');
 assert.equal(new Set(errors.map(error=>error.id)).size,errors.length);
 const again=gatherErrors(state({jobs:[job({id:'j3',errors:[text('EIO: read /Volumes/Untitled/DSC_1.NEF')]})]}));
 assert.notEqual(again[0]!.id,errors[1]!.id,'the same error in a later import is a new error');
});

test('the log stamps when each error first appeared and keeps that time',()=>{
 const log=new ErrorLog(),first=new Date('2026-10-22T09:00:00Z'),later=new Date('2026-10-22T09:05:00Z');
 const one=state({jobs:[job({errors:[text('A')]})]});
 const stamped=log.update(gatherErrors(one),first);
 const [a]=gatherErrors(one);
 assert.equal(stamped.at[a!.id],first.toISOString());
 const two=state({jobs:[job({errors:[text('A'),text('B')]})]});
 const next=log.update(gatherErrors(two),later);
 const [,b]=gatherErrors(two);
 assert.equal(next.at[a!.id],first.toISOString());assert.equal(next.at[b!.id],later.toISOString());
});

test('clearing hides one error or all of them without changing any job',()=>{
 const log=new ErrorLog();
 const value=state({error:text('Busy'),jobs:[job({phase:'copying',errors:[text('A'),text('B')]})]});
 const before=structuredClone(value.jobs);
 const [app,a,b]=gatherErrors(value);
 log.update(gatherErrors(value));
 clearErrors(log,value,{ids:[a!.id]});
 assert.deepEqual(log.update(gatherErrors(value)).cleared,[a!.id]);
 assert.deepEqual(value.jobs,before,'jobs keep their errors and phase');
 assert.ok(value.error,'clearing a job error leaves the app error');
 clearErrors(log,value,{ids:[app!.id]});
 assert.equal(value.error,undefined,'clearing the app error clears it at the source');
 clearErrors(log,value);
 assert.deepEqual(log.update(gatherErrors(value)).cleared.sort(),[a!.id,b!.id].sort());
 assert.deepEqual(value.jobs,before);
});

test('an error that goes away and comes back is shown again with a new time',()=>{
 const log=new ErrorLog(),with_=state({destinationStatus:[{path:'/Volumes/A006',available:false,detail:'Not mounted'}]}),without=state();
 const [error]=gatherErrors(with_);
 log.update(gatherErrors(with_),new Date('2026-10-22T09:00:00Z'));clearErrors(log,with_,{ids:[error!.id]});
 assert.deepEqual(log.update(gatherErrors(with_)).cleared,[error!.id]);
 log.update(gatherErrors(without));
 const back=log.update(gatherErrors(with_),new Date('2026-10-22T10:00:00Z'));
 assert.deepEqual(back.cleared,[]);assert.equal(back.at[error!.id],'2026-10-22T10:00:00.000Z');
});

test('All errors shows each error with its time and drive, a Clear button, and Clear all; cleared errors leave the count',async()=>{
 const {createElement}=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
 const {I18nProvider,createTranslator,languages}=await import('../renderer/i18n');
 const {ActivityPanel,collectErrors,TitlebarControls,formatWhen}=await import('../renderer/RootApp');
 const value=state({jobs:[job({errors:[text('EIO: read A'),text('EIO: read B')]}),job({id:'j2',source:folder,errors:[text('ENOSPC')]})]});
 const log=new ErrorLog(),at=new Date('2026-10-22T09:41:00Z');
 value.errorLog=log.update(gatherErrors(value),at);
 const errors=collectErrors(value,[{detail:'/Volumes/NIKON Z F/DSC_1.NEF: bad header',at:at.toISOString()}]);
 assert.equal(errors.length,4);
 assert.ok(errors.every(error=>error.id&&error.at===at.toISOString()));
 assert.deepEqual(errors.map(error=>error.drive),['NIKON Z F','Untitled','Untitled','A006']);
 for(const language of languages){
  const t=createTranslator(language),render=(child:ReturnType<typeof createElement>)=>renderToStaticMarkup(createElement(I18nProvider,{language,children:child}));
  const panel=render(createElement(ActivityPanel,{state:value,errors,act:()=>{},onClose:()=>{}}));
  assert.equal((panel.match(/data-testid="error-clear"/g)??[]).length,4,`${language}: one Clear per error`);
  assert.ok(panel.includes('data-testid="errors-clear-all"')&&panel.includes(t('Clear all')),`${language}: Clear all`);
  assert.ok(panel.includes(t('Clear')),`${language}: Clear label`);
  assert.equal((panel.match(new RegExp(`dateTime="${at.toISOString()}"`,'g'))??[]).length,4,`${language}: every error has its time`);
  assert.ok(panel.includes(formatWhen(at.toISOString(),language).replace(/&/g,'&amp;')),`${language}: local time formatted like the app`);
  for(const drive of ['NIKON Z F','Untitled','A006'])assert.ok(panel.includes(`>${drive}<`),`${language}: drive ${drive}`);
  assert.ok(panel.includes(`aria-label="${t('Drive: {name}',{name:'A006'})}"`),`${language}: drive is labelled`);
 }
 log.clear([errors[1]!.id!]);value.errorLog=log.update(gatherErrors(value));
 const left=collectErrors(value);assert.equal(left.length,2);
 const controls=renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(TitlebarControls,{state:value,act:()=>{},errorCount:left.length,onErrors:()=>{}})}));
 assert.ok(controls.includes('data-count="2"'));
 clearErrors(log,value);value.errorLog=log.update(gatherErrors(value));
 assert.equal(collectErrors(value).length,0);
 assert.equal(value.jobs[0]!.errors.length,2,'jobs keep their errors');
});

test('sidebar sources and destinations with errors show a live count that opens All errors for that drive',async()=>{
 const {createElement}=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
 const {I18nProvider,createTranslator,languages}=await import('../renderer/i18n');
 const {ActivityPanel,SidebarSources,SidebarDestinations,collectErrors,errorsFor}=await import('../renderer/RootApp');
 const organization={id:'library:/Volumes/A006',name:'Backup organization',path:'/Volumes/A006',transport:'folder' as const};
 const value=state({jobs:[job({errors:[text('EIO: read A'),text('EIO: read B')]}),job({id:'o',source:organization,organization:true,errors:[text('ENOSPC')]})],
  destinationStatus:[{path:'/Volumes/A006',available:true,detail:'Slow drive'}]});
 const log=new ErrorLog();value.errorLog=log.update(gatherErrors(value));
 let errors=collectErrors(value);
 assert.equal(errorsFor(errors,{sourceId:'untitled',name:'Untitled'}).length,2);
 assert.equal(errorsFor(errors,{sourceId:'folder',name:'photobackup'}).length,0);
 assert.equal(errorsFor(errors,{destination:'/Volumes/A006',name:'A006'}).length,2,'destination and organization errors on A006');
 for(const language of languages){
  const t=createTranslator(language),render=(child:ReturnType<typeof createElement>)=>renderToStaticMarkup(createElement(I18nProvider,{language,children:child}));
  const sources=render(createElement(SidebarSources,{state:value,onOpen:()=>{},errors,onErrors:()=>{}}));
  const badges=[...sources.matchAll(/<li[^>]*data-source-id="(\w+)"[\s\S]*?<\/li>/g)].map(match=>[match[1],(match[0].match(/data-testid="sidebar-errors"[^>]*aria-label="([^"]+)"/)??[])[1]]);
  assert.deepEqual(badges,[['untitled',t('{count} errors',{count:2})],['folder',undefined]],`${language}: only the source with errors has a badge`);
  const destinations=render(createElement(SidebarDestinations,{state:value,errors,onErrors:()=>{}}));
  assert.ok(destinations.includes(`aria-label="${t('{count} errors',{count:2})}"`),`${language}: destination badge`);
  const panel=render(createElement(ActivityPanel,{state:value,errors,target:{sourceId:'untitled',name:'Untitled'},act:()=>{},onClose:()=>{},onShowAll:()=>{}}));
  assert.equal((panel.match(/data-testid="error-clear"/g)??[]).length,2,`${language}: filtered to the drive`);
  assert.ok(panel.includes(t('Errors for {name}',{name:'Untitled'}))&&panel.includes(t('Show all errors')),`${language}: filter is named and can be removed`);
 }
 clearErrors(log,value,{ids:[errors[0]!.id!]});clearErrors(log,value,{ids:[errors[1]!.id!]});value.errorLog=log.update(gatherErrors(value));errors=collectErrors(value);
 const sources=renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(SidebarSources,{state:value,onOpen:()=>{},errors,onErrors:()=>{}})}));
 assert.ok(!sources.includes('sidebar-errors'),'the badge goes once its errors are cleared');
});

test('the error log follows real changes, not counts: an equal-length A→B replacement and B→A back',async()=>{
 const {createErrorLogCache}=await import('../error-log');
 const log=new ErrorLog(),cache=createErrorLogCache(log),value=state({jobs:[job({errors:[text('A')]})]});
 const t1=new Date('2026-10-23T09:00:00Z'),t2=new Date('2026-10-23T09:05:00Z'),t3=new Date('2026-10-23T09:10:00Z');
 const [a]=gatherErrors(value);cache.refresh(value,t1);clearErrors(log,value,{ids:[a!.id]});
 assert.deepEqual(cache.refresh(value,t1).cleared,[a!.id]);
 value.jobs[0]!.errors=[text('B')];
 const replaced=cache.refresh(value,t2),[b]=gatherErrors(value);
 assert.deepEqual(replaced.cleared,[],'A is gone, so its clear is forgotten');assert.deepEqual(replaced.at,{[b!.id]:t2.toISOString()},'B shows with its own time');
 value.jobs[0]!.errors=[text('A')];
 const back=cache.refresh(value,t3);
 assert.deepEqual(back.cleared,[],'A is not hidden by its old clear');assert.deepEqual(back.at,{[a!.id]:t3.toISOString()},'A is new again');
});

test('appending, a group count, acknowledging and a phase error each rebuild the cached log once',async()=>{
 const {createErrorLogCache}=await import('../error-log');const {addErrors,recordIssue}=await import('../job-issues');const {acknowledgeJob}=await import('../acknowledge');
 const log=new ErrorLog(),cache=createErrorLogCache(log),failing=job({phase:'copying'}),value=state({jobs:[failing]});
 cache.refresh(value);assert.equal(cache.builds,1);
 addErrors(failing,text('A'));cache.refresh(value);cache.refresh(value);assert.equal(cache.builds,2,'an appended error');
 recordIssue(failing,{code:'copy-failed',severity:'error',path:'/a'});cache.refresh(value);assert.equal(cache.builds,3,'a new group');
 recordIssue(failing,{code:'copy-failed',severity:'error',path:'/b'});const counted=cache.refresh(value);assert.equal(cache.builds,4,'only a count changed');
 assert.equal(gatherErrors(value).find(error=>error.code==='copy-failed')!.count,2);assert.ok(counted);
 failing.phase='error';acknowledgeJob(failing,['copy-failed']);cache.refresh(value);assert.equal(cache.builds,5,'acknowledging');
 const quiet=state({jobs:[job({errors:[]})]});cache.refresh(quiet);const builds=cache.builds;
 quiet.jobs[0]!.detail=text('Failed');cache.refresh(quiet);assert.equal(cache.builds,builds+1,'a failed job without entries shows its detail');
 quiet.jobs[0]!.progress={completed:1,total:2,bytes:1,totalBytes:2,speed:1,file:'a'};cache.refresh(quiet);assert.equal(cache.builds,builds+1,'progress alone never rebuilds');
});

test('an error has the same id in main and, after the wire, in the renderer',async()=>{
 const {addErrors,recordIssue}=await import('../job-issues');
 const recorded=job({});addErrors(recorded,text('EIO'),text('ENOSPC'));recordIssue(recorded,{code:'copy-failed',severity:'error',path:'/a'});
 const value=state({jobs:[recorded]});
 assert.deepEqual(gatherErrors(structuredClone(value)).map(error=>error.id),gatherErrors(value).map(error=>error.id));
});

test('lists rebuilt with the same contents on every emit (sources, destinations) do not rebuild the log',async()=>{
 const {createErrorLogCache}=await import('../error-log');
 const log=new ErrorLog(),cache=createErrorLogCache(log),value=state({destinationStatus:[{path:'/Volumes/A006',available:true}]});
 for(let index=0;index<5;index++){cache.refresh(value);value.sources=[...value.sources];value.destinationStatus=value.destinationStatus!.map(item=>({...item}));}
 assert.equal(cache.builds,1);
 value.destinationStatus=[{path:'/Volumes/A006',available:false,detail:'Not mounted'}];cache.refresh(value);assert.equal(cache.builds,2,'a destination problem');
 value.sources=[{...value.sources[0]!,name:'Renamed'},value.sources[1]!];cache.refresh(value);assert.equal(cache.builds,3,'a source name an error shows');
});
