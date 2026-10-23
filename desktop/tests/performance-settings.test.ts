import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, languages, translationCatalogs } from '../renderer/i18n';
import { PerformanceSettings } from '../renderer/RootApp';
import { defaultPreferences } from '../preferences';
import type { AppState, ResourceUse } from '../shared';

const use = (patch: Partial<ResourceUse> = {}): ResourceUse => ({ threads: 5, memoryMB: 812, limitMB: 2048, cores: 10, totalMemMB: 16384, memoryMaxMB: 12288, defaultThreads: 5, defaultMemoryMB: 2048, ...patch });
const state = (resources?: ResourceUse, prefs = {}): AppState => ({ preferences: { ...defaultPreferences, ...prefs }, sources: [], jobs: [], history: [], platform: 'darwin', destinationStatus: [], ...(resources ? { resources } : {}) } as AppState);
const render = (value: AppState, language: 'en' | 'zh-Hans' | 'zh-Hant' | 'ja' = 'en') => renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(PerformanceSettings, { state: value, act: () => {} }) }));

test('Performance shows both limits with their ranges, a live readout and a disabled Reset at the defaults', () => {
  const html = render(state(use(), { maxCpuThreads: 5, memoryLimitMB: 2048 }));
  assert.match(html, /id="settings-cpu-threads"[^>]*min="1"[^>]*max="10"[^>]*value="5"/);
  assert.match(html, /id="settings-memory-limit"[^>]*min="512"[^>]*max="12288"[^>]*step="256"[^>]*value="2048"/);
  assert.match(html, /5 threads/); assert.match(html, /2,048 MB/);
  assert.match(html, /Limit 5 threads per task · 812 MB of 2,048 MB budget/, 'the readout names configured limits, not measured thread use');
  assert.doesNotMatch(html, /Using up to/);
  assert.match(render(state(use({ memoryMaxMB: 8192 }))), /id="settings-memory-limit"[^>]*max="8192"/, 'the memory range comes from the main process');
  assert.match(html, /data-testid="performance-reset"[^>]*disabled/);
  assert.doesNotMatch(html, /memory-warning/);
});
test('away from the defaults Reset is enabled, and the over-limit warning is a notice, not an error', () => {
  const html = render(state(use({ warning: true }), { maxCpuThreads: 3, memoryLimitMB: 1024 }));
  assert.doesNotMatch(html, /data-testid="performance-reset"[^>]*disabled/);
  assert.match(html, /data-testid="memory-warning"/);
  assert.doesNotMatch(html, /error-toast|role="alert"/);
});
test('every Performance string is translated in all four languages', () => {
  const keys = ['Performance', 'CPU threads', '{count} threads', 'Memory limit', '{count} MB', 'Reset to defaults', 'Limit {threads} threads per task · {used} MB of {limit} MB budget', 'The most threads each kind of work (checksums, reading photo details, thumbnails) uses at once; it is a limit per task, not a total. Lower it to keep the Mac responsive. Applies to the next import; file reading adjusts after you restart the app.', 'Memory use is above the limit. New files wait until it drops; running work continues.'];
  for (const language of languages.filter(language => language !== 'en')) for (const key of keys) assert.ok(translationCatalogs[language][key], `${language}: ${key}`);
  assert.match(render(state(use()), 'ja'), /タスクごとの上限 5 スレッド/);
  assert.match(render(state(use()), 'zh-Hant'), /執行緒/);
});
