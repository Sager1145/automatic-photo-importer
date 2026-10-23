import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider,createTranslator,languages} from '../renderer/i18n';
import {SidebarDestinations,RecordsConversion} from '../renderer/RootApp';
import type {AppState,Preferences} from '../shared';

// The conversion of earlier records can be paused and resumed from the destination row and from Settings.
const preferences={language:'en',destinations:['/Volumes/BACKUP'],copyMode:'single'} as unknown as Preferences;
const stateOf=(patch:Partial<AppState>={}):AppState=>({preferences,sources:[],jobs:[],history:[],platform:'darwin',destinationStatus:[{path:'/Volumes/BACKUP',available:true,total:1e12,free:5e11}],...patch});
const act=()=>{};
const sidebar=(state:AppState,language:typeof languages[number]='en')=>renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(SidebarDestinations,{state,act})}));
const settings=(state:AppState,language:typeof languages[number]='en')=>renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(RecordsConversion,{state,act})}));
const running=stateOf({migration:{drive:'/Volumes/BACKUP',step:'converting',completed:120,total:400,file:'journal.jsonl'},migrationWaiting:['/Volumes/BACKUP']});

test('while converting, the destination row shows the counter and a Pause control',()=>{
 const markup=sidebar(running);
 assert.match(markup,/data-testid="sidebar-migration"/);assert.match(markup,/120 of 400/);
 assert.match(markup,/data-testid="migration-toggle"[^>]*aria-label="Pause conversion"/);
 assert.match(settings(running),/>Pause conversion</);
});

test('paused, the row says so and offers Resume, in every language',()=>{
 const paused=stateOf({migrationPaused:true,migrationWaiting:['/Volumes/BACKUP']});
 for(const language of languages){
  const t=createTranslator(language);
  const row=sidebar(paused,language),panel=settings(paused,language);
  assert.ok(row.includes(t('Conversion paused')),`${language}: paused label`);
  assert.ok(row.includes(`aria-label="${t('Resume conversion')}"`),`${language}: resume control`);
  assert.ok(panel.includes(`>${t('Resume conversion')}<`),`${language}: settings control`);
  assert.ok(panel.includes(t('Conversion is paused until you resume it or restart the app.')),`${language}: settings note`);
  for(const key of ['Pause conversion','Resume conversion','Conversion paused','Earlier records are converted once the drive is idle'])assert.notEqual(t(key),language==='en'?'':key,`${language}: ${key}`);
 }
});

test('waiting for an idle drive, the row says so and still offers Pause; nothing to convert shows nothing',()=>{
 const waiting=sidebar(stateOf({migrationWaiting:['/Volumes/BACKUP']}));
 assert.match(waiting,/Earlier records are converted once the drive is idle/);assert.match(waiting,/aria-label="Pause conversion"/);
 assert.doesNotMatch(sidebar(stateOf()),/sidebar-migration/);
});

test('the sidebar control is an icon button, not a wide one',()=>{
 const css=readFileSync(new URL('../renderer/styles.css',import.meta.url),'utf8');
 assert.match(css,/\.sidebar-migration-line>\.button\{flex:none/);
 assert.match(sidebar(running),/class="button button-quiet button-icon-only/);
});
