import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CleanupConfirmation,cleanupPreview,confirmCleanup} from '../renderer/CleanupConfirmation';
import {I18nProvider,translationCatalogs,createTranslator} from '../renderer/i18n';
import {safetyTranslationRows} from '../renderer/safety-translations';
import type {Action,ResidueStatus} from '../shared';

const residue:ResidueStatus={files:15,bytes:10000,resumable:{files:3,bytes:1200},kept:{files:2,bytes:2300},unbound:{files:4,paths:['/photos/kept.nef']},recoverable:{files:1,bytes:5000,folder:'/backup/recoverable'},checkedAt:'2026-10-23T12:00:00Z'};
const render=(child:ReturnType<typeof createElement>)=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:child}));
const button=(markup:string,id:string)=>markup.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`))![0];
test('preview excludes retained copies and receipt counts from removable files and bytes',()=>{
 assert.deepEqual(cleanupPreview(residue),{removable:{files:10,bytes:5000},other:{files:5,bytes:1500},resumable:{files:3,bytes:1200},kept:{files:2,bytes:2300},receipts:4,recoverable:{files:1,bytes:5000,folder:'/backup/recoverable'}});
 const receiptsOnly={...residue,files:4,bytes:0,resumable:{files:0,bytes:0},kept:undefined,recoverable:undefined};
 assert.deepEqual(cleanupPreview(receiptsOnly).removable,{files:0,bytes:0});
});
test('only explicit unlocked confirmation dispatches cleanup; opening/rendering/cancelling has no effect',()=>{
 const actions:Action[]=[],act=(action:Action)=>{actions.push(action);};let cancelled=false;
 const markup=render(createElement(CleanupConfirmation,{residue,busy:false,act,onCancel:()=>{cancelled=true;}}));
 assert.deepEqual(actions,[]);assert.equal(cancelled,false);
 assert.doesNotMatch(button(markup,'cleanup-confirm'),/disabled/);
 assert.equal(confirmCleanup(undefined,false,act),false);
 assert.equal(confirmCleanup({...residue,checkedAt:undefined},false,act),false);
 assert.equal(confirmCleanup(residue,true,act),false);
 assert.equal(confirmCleanup({...residue,checking:true},false,act),false);
 assert.deepEqual(actions,[]);
 assert.equal(confirmCleanup(residue,false,act),true);assert.deepEqual(actions,[{type:'cleanResidue'}]);
});
test('confirmation explains every category and retained files, while preserving busy/checking locks',()=>{
 const markup=render(createElement(CleanupConfirmation,{residue,busy:false,act:()=>{},onCancel:()=>{}}));
 for(const text of ['Resumable staging copies','Kept staging copies','Other leftover files and folders','Old copy receipts','Recoverable complete copies','Estimated removable files: 10 (5 KB).','The files named by old copy receipts are kept.','Recoverable complete copies are retained.','Manual cleanup also deletes resumable and kept staging copies.'])assert.ok(markup.includes(text),text);
 assert.doesNotMatch(markup,/will be freed/);
 for(const props of [{residue,busy:true},{residue:{...residue,checking:true},busy:false},{residue:undefined,busy:false}]){
  const locked=render(createElement(CleanupConfirmation,{...props,act:()=>{},onCancel:()=>{}}));assert.match(button(locked,'cleanup-confirm'),/disabled/);
 }
});
test('receipt-only cleanup remains available without claiming removal of the named files',()=>{
 const receiptOnly:ResidueStatus={files:4,bytes:0,resumable:{files:0,bytes:0},unbound:{files:4,paths:['/photos/kept.nef']},checkedAt:residue.checkedAt};
 const markup=render(createElement(CleanupConfirmation,{residue:receiptOnly,busy:false,act:()=>{},onCancel:()=>{}}));
 assert.doesNotMatch(button(markup,'cleanup-confirm'),/disabled/);assert.ok(markup.includes('Estimated removable files: 0 (0 B).'));assert.ok(markup.includes('The files named by old copy receipts are kept.'));
});

test('cleanup categories and consequences render with complete four-locale translations',()=>{
 const keys=safetyTranslationRows.trim().split('\n').map(row=>row.split('|'));
 for(const parts of keys){assert.equal(parts.length,4);const placeholders=(value:string)=>[...value.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).sort();for(const text of parts.slice(1)){assert.ok(text);assert.deepEqual(placeholders(text),placeholders(parts[0]));}}
 for(const [i,language] of (['zh-Hans','zh-Hant','ja'] as const).entries()){
  // Integration appends these rows to i18n; install the same rows for this isolated component test.
  for(const parts of keys)translationCatalogs[language][parts[0]]=parts[i+1];
  const markup=renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(CleanupConfirmation,{residue,busy:false,act:()=>{},onCancel:()=>{}})}));
  const t=createTranslator(language);
  for(const key of ['Resumable staging copies','Kept staging copies','Old copy receipts','Recoverable complete copies'])assert.ok(markup.includes(t(key)),language+': '+key);
  assert.doesNotMatch(markup,/Resumable staging copies|Kept staging copies|Old copy receipts/);
 }
});
