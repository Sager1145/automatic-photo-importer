import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ActivityJobs,ActivityPanel,ImportDesk,Organization,OrganizationRecoveryPanel,TitlebarControls,WorkspaceNavigation} from '../renderer/RootApp';
import {I18nProvider} from '../renderer/i18n';
import {normalizePreferences} from '../preferences';
import type {AppState,Job,Source} from '../shared';
const media:Source={id:'card',name:'Media card',path:'/card',transport:'storage',selected:true};
const files=Object.assign({id:'files',name:'Documents folder',path:'/docs',transport:'folder' as const,selected:true},{backup:true});
const organization:Job={id:'organize',source:{id:'library:/backup',name:'Existing library',path:'/backup',transport:'folder'},phase:'copying',organization:true,backup:false,errors:[]};
const state=(extra:Partial<AppState>={}):AppState=>({preferences:normalizePreferences({destinations:['/backup'],showDashboard:false}),sources:[media,files],jobs:[],history:[],platform:'darwin',...extra});
const render=(child:ReturnType<typeof createElement>)=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:child}));
const desk=(value:AppState,mode:'media'|'files')=>render(createElement(ImportDesk,{state:value,act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{},mode}));
test('an empty mode says where the other mode\'s connected sources are and switches to it',()=>{
 const only=(...sources:Source[])=>state({sources});
 const hint=(value:AppState,mode:'media'|'files',onOtherMode?:()=>void)=>render(createElement(ImportDesk,{state:value,act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{},mode,onOtherMode}));
 assert.match(hint(only(files),'media',()=>{}),/1 connected source is in Files &amp; folders\./);
 assert.match(hint(only(media),'files',()=>{}),/1 connected source is in Media\./);
 assert.match(hint(only(files,{...files,id:'files-2'}),'media',()=>{}),/2 connected sources are in Files &amp; folders\./);
 assert.doesNotMatch(hint(only(media),'media',()=>{}),/other-mode-sources/,'not shown when this mode has sources');
 assert.doesNotMatch(hint(only(files),'media'),/other-mode-sources/,'not shown without a way to switch');
 assert.doesNotMatch(hint(state({sources:[]}),'media',()=>{}),/other-mode-sources/,'not shown when nothing is connected');
});
test('browser and task destinations with a separate Settings anchor replace six primary pages',()=>{
 const html=render(createElement(WorkspaceNavigation,{page:'library',onNavigate:()=>{}}));
 assert.deepEqual([...html.matchAll(/data-page="(.*?)"/g)].map(match=>match[1]),['desk','browser','library','activity','settings']);
 assert.match(html,/settings-navigation/);assert.match(html,/Library tools/);assert.doesNotMatch(html,/data-page="drives"/);
 assert.match(html,/<button[^>]*data-page="library"[^>]*aria-current="page"/);
});
test('Media and Files & folders expose the appropriate registered sources and picker',()=>{
 const m=desk(state(),'media'),f=desk(state(),'files');
 assert.match(m,/data-source-id="card"/);assert.doesNotMatch(m,/data-source-id="files"/);
 assert.match(f,/data-source-id="files"/);assert.doesNotMatch(f,/data-source-id="card"/);
 assert.match(m,/Choose media folders…/);assert.match(f,/Back up drives or folders…/);
 assert.ok(m.indexOf('Choose media folders…') < m.indexOf('data-testid="source-cards"'));
 assert.doesNotMatch(m,/data-testid="backup-mode-summary"/);assert.doesNotMatch(f,/data-testid="backup-mode"/);assert.match(f,/data-testid="backup-mode-summary"[^>]*><span>Drive backups: Additive<\/span><button[^>]*>Change</);
 assert.match(f,/Back up<\/button>/);assert.match(f,/Scan media/);
});
test('queued backup jobs stay in Files mode when the next source run is Media',()=>{
 const job:Job={id:'backup-job',source:media,phase:'queued',backup:true,errors:[]};
 const value=state({sources:[media],jobs:[job]});
 const f=desk(value,'files'),m=desk(value,'media');
 assert.match(f,/Queue position/);assert.match(f,/Folder backup/);
 assert.doesNotMatch(m,/Queue position/);assert.match(m,/Ready to import/);
 assert.equal(job.backup,true);assert.equal(value.preferences.backupMode,'additive');
});
test('organization scope, affected roots and consequences precede one execution area',()=>{
 const value=state({preferences:normalizePreferences({destinations:['/backup'],mediaLayout:'video-root'}),organizationFolders:{'/backup':['2024','2025']}});
 const html=render(createElement(Organization,{state:value,act:()=>{},busy:false,onFolderRules:()=>{}}));
 const execute=html.indexOf('data-testid="organization-execute"');
 assert.ok(execute>html.indexOf('<li>2025</li>'));assert.ok(execute>html.indexOf('Organize: move, source removed'));
 assert.ok(execute>html.indexOf('/backup/videobackup'));assert.equal((html.match(/>Organize now</g)??[]).length,1);
 assert.equal((html.match(/>Review changes…</g)??[]).length,1);
 assert.doesNotMatch(html,/collect-problem-files-setting/);assert.doesNotMatch(html,/organization-recovery-heading/);
 assert.match(html,/Edit folder rules/);assert.doesNotMatch(html,/Recovery &amp; maintenance/);
 const top=render(createElement(TitlebarControls,{state:value,act:()=>{},page:'library',errorCount:0,onErrors:()=>{}}));
 assert.doesNotMatch(top,/Organize now|Scan for duplicates|Review changes/);assert.match(top,/show-errors/);
});
test('Activity retains all mixed job controls and recovery actions independently of Import mode',()=>{
 const backup:Job={id:'b',source:files,phase:'queued',backup:true,errors:[]};
 const importJob:Job={id:'i',source:media,phase:'stopped',paused:true,backup:false,errors:[]};
 const value=state({jobs:[backup,importJob,organization],organizationRecovery:[{id:'saved',root:'/backup',status:'complete',files:5,completed:5,undoable:true,finalizable:true,retainedFiles:5,retainedBytes:100}]});
 const jobs=render(createElement(ActivityJobs,{state:value,act:()=>{}}));
 assert.match(jobs,/Pause Documents folder/);assert.match(jobs,/Continue/);assert.match(jobs,/organization-card/);
 const recovery=render(createElement(OrganizationRecoveryPanel,{state:value,act:()=>{},busy:false}));
 for(const label of ['Undo organization','Full recheck','Release','Delete recovery files'])assert.match(recovery,new RegExp(label));
 assert.match(recovery,/\/backup/);
 const locked=render(createElement(OrganizationRecoveryPanel,{state:value,act:()=>{},busy:true}));
 assert.match(locked,/<button[^>]*data-testid="delete-recovery"[^>]*disabled/);
});
test('Activity Issues embeds the complete issue resolution view without a modal',()=>{
 const html=render(createElement(ActivityPanel,{state:state(),errors:[],act:()=>{}}));
 assert.match(html,/activity-issues/);assert.doesNotMatch(html,/<dialog/);assert.match(html,/No errors to show/);assert.match(html,/No warnings to show/);
});

// Cross-workspace tasks must keep the backend's global planning lock visible.
test('Review stays disabled in both modes while any transfer, organization or duplicate operation runs',()=>{
 const backup:Job={id:'b',source:files,phase:'copying',backup:true,errors:[]};
 const mediaJob:Job={id:'m',source:media,phase:'copying',backup:false,errors:[]};
 for(const extra of [{jobs:[backup]},{jobs:[mediaJob]},{jobs:[organization]},{duplicates:{status:'scanning'}},{duplicates:{status:'removing'}}] as Partial<AppState>[]) {
  for(const mode of ['media','files'] as const) {
   const html=desk(state({...extra,sources:[media,files,{...media,id:'idle-media'},{...files,id:'idle-files'}]}),mode);
   const reviews=[...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map(match=>match[0]).filter(button=>/>Review(?: changes…)?<|>Review…</.test(button));
   assert.ok(reviews.length>0,`${mode}: review entry exists`);
   for(const review of reviews) assert.match(review,/disabled/,`${mode}: review locked across workspaces`);
  }
 }
});
