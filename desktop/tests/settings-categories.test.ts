import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsPage, settingsCategories, type SettingsCategory } from '../renderer/RootApp';
import { I18nProvider } from '../renderer/i18n';
import { defaultPreferences } from '../preferences';
import type { AppState } from '../shared';

const state: AppState = {preferences: {...defaultPreferences, destinations: ['/backup']}, sources: [], jobs: [], history: [], platform: 'darwin'};
const render = (requestedCategory?: SettingsCategory, busy = false) => renderToStaticMarkup(createElement(I18nProvider, {language: 'en', children: createElement(SettingsPage, {state, act: () => {}, busy, requestedCategory})}));
const panel = (markup: string, category: SettingsCategory) => markup.split(`data-testid="settings-panel-${category}"`)[1]?.split('role="tabpanel"')[0] ?? '';

test('Settings exposes eight task-focused categories and opens General by default', () => {
  assert.deepEqual(settingsCategories, ['general', 'storage', 'folders', 'defaults', 'files', 'devices', 'performance', 'diagnostics']);
  assert.match(render(), /id="settings-tab-general"[^>]*aria-selected="true"/);
});

test('each saved policy and live control is grouped under its intended category', () => {
  const markup = render();
  const contents: Record<SettingsCategory, string[]> = {
    general: ['App language', 'Text size', 'Appearance'],
    storage: ['Backup location', 'Backup folder', 'Drive backups'],
    folders: ['Folder structure', 'Edited exports folder'],
    defaults: ['Automatic import', 'Verify each copy after copying', 'Skip files with errors and continue'],
    files: ['Files without date or camera', 'Unrecognized file types', 'Same name, different content', 'Remove macOS ._ files', 'Collect problem files'],
    devices: ['Remembered drives', 'Ignored drives'],
    performance: ['Drives at once', 'CPU threads', 'Memory limit'],
    diagnostics: ['Diagnostics', 'Log detail'],
  };
  for (const category of settingsCategories) for (const label of contents[category]) assert.ok(panel(markup, category).includes(label), `${category}: ${label}`);
  assert.doesNotMatch(markup, /data-testid="residue-cleanup"|Auto-organize backup|Automatic folder check/);
});

test('explicit category requests select the category without dispatching preferences', () => {
  for (const category of settingsCategories) assert.match(render(category), new RegExp(`id="settings-tab-${category}"[^>]*aria-selected="true"`));
});

test('legacy saved categories migrate and unknown categories safely open General', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  try {
    for (const [saved, expected] of Object.entries({ importing: 'defaults', destinations: 'storage', organization: 'files', drives: 'devices', folders: 'folders', performance: 'performance', obsolete: 'general', constructor: 'general', toString: 'general' })) {
      Object.defineProperty(globalThis, 'sessionStorage', {configurable: true, value: { getItem: () => saved }});
      assert.match(render(), new RegExp(`id="settings-tab-${expected}"[^>]*aria-selected="true"`), saved);
      assert.match(render('storage'), /id="settings-tab-storage"[^>]*aria-selected="true"/, 'request takes priority over saved category');
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});

test('locked work keeps automation, parallelism and diagnostics live while protecting copy policies', () => {
  const markup = render(undefined, true);
  for (const category of ['defaults', 'performance'] as const) {
    const html = panel(markup, category);
    assert.ok(html.indexOf(category === 'defaults' ? 'Automatic import' : 'Drives at once') < html.indexOf('<fieldset'));
    assert.match(html, /<fieldset[^>]*disabled/);
  }
  assert.ok(panel(markup, 'diagnostics').includes('settings-log-level') && !panel(markup, 'diagnostics').includes('<fieldset'), 'Diagnostics sits in its own category, outside every lock');
  assert.ok(!panel(markup, 'performance').includes('Diagnostics'));
});
