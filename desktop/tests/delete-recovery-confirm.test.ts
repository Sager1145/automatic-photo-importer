import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider,createTranslator,formatBytes} from '../renderer/i18n';
import {RetainedOriginals,DeleteRecoveryConfirm,nextConfirmStep,recoveryDeletable} from '../renderer/RootApp';
import type {AppState,Language} from '../shared';

type Recovery=NonNullable<AppState['organizationRecovery']>[number];
const job:Recovery={id:'o1',root:'/Volumes/A006/photobackup',status:'complete',files:27963,completed:27963,retainedFiles:0,retainedBytes:0,finalizable:false,undoable:true};
const languages:Language[]=['en','zh-Hans','zh-Hant','ja'];
const render=(child:ReturnType<typeof createElement>,language:Language='en')=>renderToStaticMarkup(createElement(I18nProvider,{language,children:child}));
const button=(html:string,id:string)=>html.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`))?.[0];
const html=(text:string)=>text.replaceAll("'",'&#x27;');

test('only the second confirmation deletes; cancelling either one deletes nothing',()=>{
 const first=nextConfirmStep('closed','open');assert.deepEqual(first,{step:'first',delete:false});
 const second=nextConfirmStep(first.step,'confirm');assert.deepEqual(second,{step:'second',delete:false});
 assert.deepEqual(nextConfirmStep(second.step,'confirm'),{step:'closed',delete:true});
 assert.deepEqual(nextConfirmStep('first','cancel'),{step:'closed',delete:false});
 assert.deepEqual(nextConfirmStep('second','cancel'),{step:'closed',delete:false});
 assert.deepEqual(nextConfirmStep('closed','confirm'),{step:'closed',delete:false});
});

test('each recovery card has a red Delete recovery files button beside Undo, disabled while busy or unfinished',()=>{
 const card=render(createElement(RetainedOriginals,{job,act:()=>{},busy:false}));
 const remove=button(card,'delete-recovery')!;assert.match(remove,/button-danger/);assert.doesNotMatch(remove,/disabled/);
 assert.ok(card.indexOf('Undo organization')<card.indexOf('Delete recovery files'));
 assert.match(button(render(createElement(RetainedOriginals,{job,act:()=>{},busy:true})),'delete-recovery')!,/disabled/);
 assert.match(button(render(createElement(RetainedOriginals,{job:{...job,status:'pending'},act:()=>{},busy:false})),'delete-recovery')!,/disabled/);
 // A replaced or undone organization can only have its recovery files deleted.
 for(const status of ['superseded','undone'] as const){const ended=render(createElement(RetainedOriginals,{job:{...job,status,undoable:false},act:()=>{},busy:false}));assert.doesNotMatch(button(ended,'delete-recovery')!,/disabled/);assert.ok(!ended.includes('Undo organization'));}
 assert.equal(recoveryDeletable({...job,error:'Unreadable journal'}),false);
});

test('the first confirmation names lost undo and the space freed; the second repeats it with Cancel focused, in every language',()=>{
 const size={root:job.root,id:job.id,files:87012,bytes:1_234_000_000};
 for(const language of languages){
  const t=createTranslator(language);
  const first=render(createElement(DeleteRecoveryConfirm,{step:'first',root:job.root,size,onCancel:()=>{},onConfirm:()=>{}}),language);
  assert.ok(first.includes(html(t('Delete recovery files for this organization?')))&&first.includes(html(t('You will no longer be able to undo it.'))),language);
  assert.ok(first.includes(html(t('{size} will be freed.',{size:formatBytes(1_234_000_000,language)}))),`${language}: size`);
  const second=render(createElement(DeleteRecoveryConfirm,{step:'second',root:job.root,size,onCancel:()=>{},onConfirm:()=>{}}),language);
  assert.ok(second.includes((87012).toLocaleString(language)),`${language}: file count`);
  assert.ok(second.includes(t('Delete permanently')),language);
  const buttons=second.match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/g)!;
  assert.equal(buttons.length,2);assert.ok(buttons[0]!.includes(t('Cancel'))&&buttons[1]!.includes(t('Delete permanently')),language);
  assert.match(buttons[0]!,/data-autofocus/,language);assert.match(buttons[1]!,/button-danger/);
 }
 // Nothing can be confirmed until the size is known.
 const measuring=render(createElement(DeleteRecoveryConfirm,{step:'first',root:job.root,size:{root:job.root,id:job.id},onCancel:()=>{},onConfirm:()=>{}}));
 assert.ok(measuring.includes('Measuring recovery files'));assert.match(measuring.match(/<button[^>]*button-danger[^>]*>/)![0],/disabled/);
});
