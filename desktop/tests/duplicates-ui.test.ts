import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider,translationCatalogs,languages} from '../renderer/i18n';
import {categories} from '../renderer/exif-categories';
import {LevelSelector,GroupView,DuplicatesConfirm,RemovedDuplicates,removalPlan,fileBadges,GROUPS_PER_PAGE,Pagination} from '../renderer/DuplicatesPage';
import {nextDeleteRecoveryStep} from '../renderer/RootApp';
import type {DuplicateFile,DuplicateGroup,Language,Metadata,Thumbnail,OrganizationRecovery} from '../shared';

const render=(child:ReturnType<typeof createElement>,language:Language='en')=>renderToStaticMarkup(createElement(I18nProvider,{language,children:child}));
const exif={date:'2026-05-01T10:00:00.123',camera:'Nikon Z6',shutterCount:'42',width:6000,height:4000};
const file=(path:string,extra:Partial<DuplicateFile>={}):DuplicateFile=>({path,size:1000,kind:'RAW',sha256:'a'.repeat(64),exif,edited:false,birth:1,ctime:1,...extra});
const organized=file('2026/202605/Nikon Z6/DSC_0001.NEF',{birth:5});
const stray=file('Unsorted/DSC_0001 copy.NEF',{birth:9});
const sha:DuplicateGroup={id:'g1',strength:'sha',files:[stray,organized]};
const sized:DuplicateGroup={id:'g2',strength:'exif-size',files:[file('a/x.NEF',{sha256:'b'.repeat(64)}),file('b/x.NEF',{size:2000,sha256:'c'.repeat(64)})]};
const item=(group:DuplicateGroup,level:1|2|3=1,decisions:Record<string,string>={})=>removalPlan([group],level,decisions).resolved[0]!;
const view=(group:DuplicateGroup,options:{thumbs?:Record<string,Thumbnail>;exifs?:Record<string,Metadata>;level?:1|2|3;decisions?:Record<string,string>}={},language:Language='en')=>
 render(createElement(GroupView,{item:item(group,options.level,options.decisions),number:1,thumbs:options.thumbs??{},exifs:options.exifs??{},onDecide:()=>{}}),language);

test('the level selector explains three levels in plain words and marks the chosen one',()=>{
 const html=render(createElement(LevelSelector,{level:2,onChange:()=>{}}));
 for(const level of [1,2,3])assert.match(html,new RegExp(`data-testid="duplicate-level-${level}"`));
 assert.match(html,/You decide every group/);assert.match(html,/same SHA-256\) are removed automatically/);assert.match(html,/same EXIF but a different size/);
 assert.equal((html.match(/aria-checked="true"/g)??[]).length,1);
 assert.match(html.match(/<button[^>]*data-testid="duplicate-level-2"[^>]*>/)![0],/aria-checked="true"/);
 assert.match(render(createElement(LevelSelector,{level:1,onChange:()=>{},disabled:true})),/disabled/);
});

test('the group view shows badges, keep radios with the suggestion, Keep all and a removal mark',()=>{
 const html=view(sha,{level:2});
 assert.equal((html.match(/data-testid="keep-file"/g)??[]).length,2);assert.match(html,/data-testid="keep-all"/);
 for(const badge of ['sha','exif','organized','suggested'])assert.match(html,new RegExp(`data-badge="${badge}"`));
 assert.doesNotMatch(html,/data-badge="size"/);
 // Level 2 resolves a SHA group on its own: the organized copy is kept, the other will be removed.
 assert.match(html,/data-auto="true"/);assert.match(html,/Removed automatically/);
 assert.match(html.match(/<input[^>]*value="2026\/202605\/Nikon Z6\/DSC_0001.NEF"[^>]*>/)![0],/checked/);
 assert.match(html,/Will be removed/);
 // Level 1 leaves it undecided until the user picks.
 const manual=view(sha,{level:1});assert.match(manual,/data-testid="duplicate-undecided"/);assert.doesNotMatch(manual,/checked/);
 const all=view(sha,{level:1,decisions:{g1:'all'}});
 assert.match(all.match(/<input[^>]*data-testid="keep-all"[^>]*>/)![0],/checked/);assert.doesNotMatch(all,/Will be removed/);
 assert.deepEqual(fileBadges(sized,sized.files[1]!,'a/x.NEF'),['exif','size']);
});

test('basic EXIF lists camera, lens, date and time, exposure, dimensions, size and path; full EXIF is grouped',()=>{
 const metadata:Metadata={camera:'Nikon Z6',date:'2026-05-01T10:00:00.123',exposure:{lens:'NIKKOR 24-70',aperture:2.8,iso:200,exposureTime:.004,focalLength:50},fields:{'EXIF:ExposureTime':.004,'EXIF:FNumber':2.8,'EXIF:ISO':200,'EXIF:Model':'Nikon Z6','File:FileSize':1000,'EXIF:FocalLength':50}};
 const html=view(sha,{exifs:{[organized.path]:metadata}});
 const basic=html.match(/data-testid="basic-exif"[\s\S]*?<\/dl>/g)!.find(block=>block.includes('NIKKOR'))!;
 for(const text of ['Camera','Nikon Z6','NIKKOR 24-70','Capture date','Capture time','10:00:00.123','1/250 s','f/2.8','200','50 mm','6000 × 4000','1 KB','2026/202605/Nikon Z6/DSC_0001.NEF'])assert.ok(basic.includes(text),text);
 assert.match(html,/<details class="duplicate-full-exif" data-testid="full-exif">/);
 assert.match(html,/<h4>Exposure<\/h4>/);assert.match(html,/<h4>Camera &amp; Lens<\/h4>/);assert.match(html,/Shutter speed/);
 assert.match(view(sha,{exifs:{[organized.path]:metadata}},'ja'),/<h4>露出<\/h4>/);
});

test('a RAW the system cannot decode shows the macOS update / DNG Converter message with the embedded preview',()=>{
 const html=view(sha,{thumbs:{[organized.path]:{src:'data:image/jpeg;base64,AAAA',via:'embedded',problem:'raw-unsupported'},[stray.path]:{src:'data:image/jpeg;base64,BBBB',via:'system'}}});
 assert.equal((html.match(/data-testid="raw-unsupported"/g)??[]).length,1);
 assert.match(html,/Updating macOS or converting the files with Adobe DNG Converter/);
 assert.match(html,/<img src="data:image\/jpeg;base64,AAAA"/);
});

test('the summary counts groups, files and bytes from the level and the choices',()=>{
 const groups=[sha,sized];
 const numbers=(plan:ReturnType<typeof removalPlan>)=>[plan.summary.groups,plan.summary.files,plan.summary.bytes,plan.summary.undecided];
 assert.deepEqual(numbers(removalPlan(groups,1,{})),[0,0,0,2]);
 assert.deepEqual(numbers(removalPlan(groups,2,{})),[1,1,1000,1]);
 assert.deepEqual(numbers(removalPlan(groups,2,{g2:'b/x.NEF'})),[2,2,2000,0]);
 assert.deepEqual(numbers(removalPlan(groups,2,{g1:'all',g2:'a/x.NEF'})),[1,1,2000,0]);
});

test('removal asks twice and only the second confirmation acts',()=>{
 let step=nextDeleteRecoveryStep('closed','open');assert.equal(step.step,'first');
 step=nextDeleteRecoveryStep(step.step,'confirm');assert.deepEqual(step,{step:'second',delete:false});
 assert.equal(nextDeleteRecoveryStep('second','confirm').delete,true);assert.equal(nextDeleteRecoveryStep('second','cancel').delete,false);
 const summary={groups:3,files:5,bytes:5_000_000};
 const first=render(createElement(DuplicatesConfirm,{step:'first',summary,name:'Library',onCancel:()=>{},onConfirm:()=>{}}));
 assert.match(first,/data-testid="duplicates-confirm-first"/);assert.match(first,/5 files in 3 groups/);assert.match(first,/5.0 MB/);
 const second=render(createElement(DuplicatesConfirm,{step:'second',summary,name:'Library',onCancel:()=>{},onConfirm:()=>{}}));
 assert.match(second,/data-testid="duplicates-confirm-second"/);assert.match(second,/data-autofocus/);assert.match(second,/Remove 5 files/);
});

test('the removed duplicates list offers Undo and Release',()=>{
 const job:OrganizationRecovery={id:'j1',root:'/lib',kind:'duplicates',status:'complete',files:4,completed:4,retainedFiles:4,retainedBytes:4_000_000,finalizable:true,undoable:true};
 const html=render(createElement(RemovedDuplicates,{jobs:[job],act:()=>{},busy:false}));
 assert.match(html,/data-testid="duplicates-undo"/);assert.match(html,/Release 4.0 MB/);
 assert.doesNotMatch(html.match(/<button[^>]*data-testid="duplicates-release"[^>]*>/)![0],/disabled/);
 assert.match(render(createElement(RemovedDuplicates,{jobs:[],act:()=>{},busy:false})),/No removed duplicates/);
 assert.match(render(createElement(RemovedDuplicates,{jobs:[job],act:()=>{},busy:true})).match(/<button[^>]*data-testid="duplicates-undo"[^>]*>/)![0],/disabled/);
});

test('thousands of groups are paged: only one page of groups is ever drawn',()=>{
 assert.ok(GROUPS_PER_PAGE<=12);
 assert.match(render(createElement(Pagination,{page:0,pages:625,onPage:()=>{}})),/Page 1 of 625/);
 assert.equal(render(createElement(Pagination,{page:0,pages:1,onPage:()=>{}})),'');
 const started=performance.now();
 const many=Array.from({length:5000},(_,i)=>({id:`g${i}`,strength:'sha' as const,files:[file(`a/${i}.NEF`),file(`b/${i}.NEF`)]}));
 assert.equal(removalPlan(many,2,{}).summary.files,5000);assert.ok(performance.now()-started<2000);
});

test('every new string, EXIF category, label and value is translated in all languages',()=>{
 const keys=new Set<string>();
 for(const name of ['DuplicatesPage.tsx','RootApp.tsx'])for(const match of readFileSync(new URL(`../renderer/${name}`,import.meta.url),'utf8').matchAll(/\bt\("([^"\n]+)"/g))keys.add(match[1]!);
 for(const category of categories){keys.add(category.title);for(const tag of category.tags)keys.add(tag.label);}
 for(const match of readFileSync(new URL('../renderer/exif-categories.ts',import.meta.url),'utf8').matchAll(/\d+: '([^']+)'/g))keys.add(match[1]!);
 for(const language of languages.filter(language=>language!=='en'))for(const key of keys)assert.ok(Object.hasOwn(translationCatalogs[language as Exclude<Language,'en'>],key),`${language}: ${key}`);
});
