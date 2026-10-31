import { freshOrganizeOptions } from '../run-policy';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { backendMessages, formatMessage, joined, message, MessageError, savedMessage, text, toMessage } from '../messages';
import { createTranslator, I18nProvider, languages } from '../renderer/i18n';
import type { AppState, Job } from '../shared';
import { defaultPreferences } from '../preferences';

const placeholders = (template: string) => [...template.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

test('every backend message key has text in all four languages with the same placeholders', () => {
  assert.ok(Object.keys(backendMessages).length > 40);
  for (const [key, templates] of Object.entries(backendMessages)) {
    assert.deepEqual(Object.keys(templates).sort(), [...languages].sort(), `${key}: languages`);
    for (const language of languages) {
      assert.ok(templates[language].trim(), `${key}: missing ${language}`);
      assert.deepEqual(placeholders(templates[language]), placeholders(templates.en), `${key}: placeholders differ in ${language}`);
    }
  }
});

test('parameters interpolate with locale numbers, nested messages and joined parts', () => {
  const detail = joined(message('job.copied', { copied: 1234, skipped: 5 }), 0, message('job.errors', { count: 0 }));
  assert.equal(formatMessage(detail, 'en'), '1,234 copied · 5 verified · 0 errors');
  assert.equal(formatMessage(detail, 'zh-Hans'), '已复制 1,234 个 · 已验证 5 个 · 0 个错误');
  const nested = message('error.backupFolderCheck', { error: text('EBUSY: resource busy') });
  assert.equal(formatMessage(nested, 'ja'), 'バックアップフォルダーの確認：EBUSY: resource busy');
  const parts = joined(detail, message('job.mirrorVerified'));
  assert.equal(formatMessage(parts, 'en'), '1,234 copied · 5 verified · 0 errors · Both destinations verified');
  for (const language of languages) assert.ok(!formatMessage(parts, language).includes('{'), `${language}: no placeholder left`);
});

test('a keyed error keeps its English text for logs and reports, and raw errors pass through unchanged', () => {
  const error = new MessageError('error.sourceChanged', { path: '/card/DCIM/A.NEF' });
  assert.equal(error.message, 'Source changed; scan again: /card/DCIM/A.NEF');
  assert.deepEqual(toMessage(error), { key: 'error.sourceChanged', params: { path: '/card/DCIM/A.NEF' } });
  assert.equal(formatMessage(toMessage(error), 'zh-Hant'), '來源已變更，請重新掃描：/card/DCIM/A.NEF');
  const raw = toMessage(new Error('EIO: i/o error, read'));
  for (const language of languages) assert.equal(formatMessage(raw, language), 'EIO: i/o error, read');
});

test('history saved as plain strings by earlier versions still loads and renders', () => {
  assert.deepEqual(savedMessage('Import: Card A'), text('Import: Card A'));
  assert.deepEqual(savedMessage({ key: 'history.import', params: { name: 'Card A' } }), message('history.import', { name: 'Card A' }));
  assert.equal(savedMessage({ key: 'no.such.key' }), undefined);
  assert.equal(savedMessage(42), undefined);
  for (const language of languages) assert.equal(createTranslator(language)(savedMessage('12 copied · 0 verified · 0 errors')!), '12 copied · 0 verified · 0 errors');
});

test('the translator accepts backend messages and job details render in the chosen language', async () => {
  const { ImportDesk } = await import('../renderer/RootApp');
  const source = { id: 'card', name: 'Card', path: '/Volumes/Card', transport: 'storage' as const, selected: true };
  const preferences: AppState['preferences'] = { ...defaultPreferences, language:'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/backup'], copyMode: 'single', template: '{year}', mediaLayout: 'flat', videoTemplate: '', unknownRules: {} };
  const job: Job = { id: 'j', source, phase: 'copying', detail: message('job.destinationFile', { index: 1, count: 2, file: 'A.NEF' }), errors: [], backup: false };
  for (const language of languages) {
    const markup = renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(ImportDesk, { state: { preferences: { ...preferences, language }, sources: [source], jobs: [job], history: [], platform: 'darwin', organizeOptions: freshOrganizeOptions() }, act: () => {}, inspect: () => {}, onOrganization: () => {}, onSettings: () => {} }) }));
    assert.ok(markup.includes(createTranslator(language)(job.detail!)), `${language}: localized detail`);
    assert.equal(createTranslator(language)(job.detail!), formatMessage(job.detail!, language));
  }
  assert.notEqual(formatMessage(job.detail!, 'ja'), formatMessage(job.detail!, 'en'));
});

test('errors panel explains keyed mirror confirmations in every language', async () => {
  const { explainError } = await import('../renderer/RootApp');
  const mirror = message('error.mirrorReview', { count: 3 });
  for (const language of languages) assert.deepEqual(explainError(mirror, 'source', language), { title: 'Mirror needs your review before moving files.', hint: 'Open Review on this drive.' });
  assert.equal(explainError(message('error.sourceDisconnected'), 'app', 'ja').title, 'The drive was disconnected or a file is missing.');
  assert.equal(explainError(message('error.selectDrive'), 'app', 'zh-Hans').title, formatMessage(message('error.selectDrive'), 'zh-Hans'));
  assert.equal(explainError(text('Unexpected failure. More text.'), 'app', 'en').title, 'Unexpected failure.');
});
