import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, createTranslator, languages, translationCatalogs } from '../renderer/i18n';
import { DiagnosticsSettings } from '../renderer/RootApp';
import { defaultPreferences } from '../preferences';
import type { Action, AppState } from '../shared';

const state = (prefs = {}, logInfo?: AppState['logInfo']): AppState => ({ preferences: { ...defaultPreferences, ...prefs }, sources: [], jobs: [], history: [], platform: 'darwin', destinationStatus: [], ...(logInfo ? { logInfo } : {}) } as AppState);
const render = (value: AppState, language: 'en' | 'zh-Hans' | 'zh-Hant' | 'ja' = 'en', act: (action: Action) => void = () => {}) => renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(DiagnosticsSettings, { state: value, act }) }));
const strings = ['Diagnostics', 'Log detail', 'Detailed', 'Trace', 'Nothing is recorded.', 'Records settings changes, job phases, every file the app deletes, and errors.', "Also records each file's steps and decisions, drives, memory and timing.", 'Also records every routing decision and journal entry. Large; for troubleshooting.', 'Open log folder', 'Copy latest log path', 'Export logs…', 'Log size: {size}', 'Logs stay on this Mac. They never include file contents or recovery keys.'];

test('Diagnostics shows the level selector with all four levels, the current size and the three actions', () => {
  const html = render(state({ logLevel: 'detailed' }, { dir: '/logs', latest: '/logs/importer-20260101-100000.jsonl', bytes: 3 * 1024 * 1024 }));
  assert.match(html, /id="settings-log-level"/);
  for (const value of ['off', 'normal', 'detailed', 'trace']) assert.match(html, new RegExp(`<option value="${value}"`));
  assert.match(html, /<option value="detailed" selected/);
  assert.match(html, /data-testid="log-size"[^>]*>Log size: 3\.1 MB/);
  for (const id of ['log-open-folder', 'log-copy-path', 'log-export']) assert.match(html, new RegExp(`data-testid="${id}"`));
  assert.match(html, /Open log folder/); assert.match(html, /Copy latest log path/); assert.match(html, /Export logs…/);
  assert.match(html, /Also records each file&#x27;s steps/);
});

test('each level has its own one-line explanation, and the section is never disabled while jobs run', () => {
  for (const [level, text] of [['off', /Nothing is recorded/], ['normal', /every file the app deletes/], ['detailed', /steps and decisions/], ['trace', /routing decision/]] as const) {
    const html = render(state({ logLevel: level }));
    assert.match(html.match(/data-testid="log-level-explanation"[^>]*>([^<]*)</)![1]!, text);
  }
  const busy = { ...state(), jobs: [{ id: 'j', phase: 'copying', source: { id: 's', name: 'A', path: '/A', transport: 'storage' }, errors: [], backup: false, detail: { key: 'job.finding' } }] } as unknown as AppState;
  assert.doesNotMatch(render(busy), /disabled/);
});

test('every Diagnostics string is translated in all four languages', () => {
  for (const language of languages.filter(language => language !== 'en')) for (const key of strings) assert.ok(translationCatalogs[language][key], `${language}: ${key}`);
  assert.match(render(state({ logLevel: 'trace' }), 'ja'), /トレース/);
  assert.match(render(state(), 'zh-Hant'), /記錄詳細程度/);
  assert.match(render(state({ logLevel: 'off' }), 'zh-Hans'), /不记录任何内容/);
  assert.equal(createTranslator('ja')('Diagnostics'), '診断');
});

test('the Diagnostics section sits in Performance outside the job-locked fieldset, and adds no stacking layers', async () => {
  const source = await fs.readFile(path.join(import.meta.dirname, '../renderer/RootApp.tsx'), 'utf8');
  const general = source.slice(source.indexOf('    performance: <>'), source.indexOf('  const onKeyDown'));
  assert.match(general, /<DiagnosticsSettings state=\{state\} act=\{act\} \/>/);
  assert.ok(general.indexOf('<DiagnosticsSettings') > general.indexOf('</fieldset>'), 'diagnostics stays outside the locked fieldset');
  const part = source.slice(source.indexOf('export function DiagnosticsSettings'), source.indexOf('function SettingsSection'));
  assert.doesNotMatch(part, /z-index|zIndex|createPortal|popover|dialog/i);
  assert.match(part, /type: 'logOpenFolder'/); assert.match(part, /type: 'logCopyPath'/); assert.match(part, /type: 'logExport'/); assert.match(part, /logLevel: event\.target\.value/);
});
