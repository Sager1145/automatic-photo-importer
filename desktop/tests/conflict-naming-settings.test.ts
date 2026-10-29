import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {defaultPreferences,normalizePreferences} from '../preferences';
import {acceptedPreferences,lockedPreferenceKeys} from '../settings-lock';
import {I18nProvider,languages} from '../renderer/i18n';
import {ConflictNamingSettings} from '../renderer/RootApp';
import type {ConflictNaming,Language} from '../shared';

test('same-name files default to a Conflicts folder; the choice is validated and job-locked',()=>{
 assert.equal(defaultPreferences.conflictNaming,'folder');
 assert.equal(normalizePreferences({}).conflictNaming,'folder');assert.equal(normalizePreferences({conflictNaming:'rename'}).conflictNaming,'folder');
 assert.equal(normalizePreferences({conflictNaming:'number'}).conflictNaming,'number');
 assert.deepEqual(lockedPreferenceKeys({conflictNaming:'number',language:'ja'}),['conflictNaming']);
 assert.deepEqual(acceptedPreferences({conflictNaming:'number'},true),{});assert.deepEqual(acceptedPreferences({conflictNaming:'number'},false),{conflictNaming:'number'});
});

test('the Settings control shows both choices, explains the chosen one, and is translated',()=>{
 const render=(language:Language,conflictNaming:ConflictNaming)=>renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(ConflictNamingSettings,{preferences:{...defaultPreferences,conflictNaming},act:()=>{}})}));
 const folder=render('en','folder'),number=render('en','number');
 assert.match(folder,/aria-pressed="true">Conflicts folder/);assert.match(folder,/Conflicts/);
 assert.match(number,/aria-pressed="true">Add a number/);assert.match(number,/IMG_0001 \(1\)\.JPG/);
 for(const language of languages.filter(item=>item!=='en'))for(const naming of ['folder','number'] as const)assert.doesNotMatch(render(language,naming),/Conflicts folder|Add a number|Same name, different content/,`${language} ${naming}`);
});

test('Same name, different content sits in Settings File handling, not Folders',async()=>{
 const {SettingsPage}=await import('../renderer/RootApp');
 const markup=renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(SettingsPage,{state:{preferences:{...defaultPreferences,destinations:['/backup']},sources:[],jobs:[],history:[],platform:'darwin'},act:()=>{},busy:false})}));
 const panel=(id:string)=>markup.split(`data-testid="settings-panel-${id}"`)[1]?.split('role="tabpanel"')[0]??'';
 assert.ok(panel('files').includes('data-testid="conflict-naming-settings"')&&!panel('folders').includes('conflict-naming-settings'));
 assert.ok(panel('files').includes('Files without date or camera')&&panel('files').includes('Unrecognized file types'));
 assert.ok(panel('defaults').includes('data-testid="backup-mode"')&&!panel('storage').includes('data-testid="backup-mode"'),'Drive backups mode lives in Importing');
});
