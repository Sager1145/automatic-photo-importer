import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, languages, createTranslator } from '../renderer/i18n';
import { normalizePreferences } from '../preferences';
import type { AppState } from '../shared';

const english = 'Locked while an import, organization or review is active, including paused or queued ones. Finish or stop them to change this.';

test('the lock reason names paused and queued work in every language', () => {
  for (const language of languages) {
    const t = createTranslator(language);
    assert.ok(!t(english).includes('after the job finishes or is paused'));
    if (language !== 'en') assert.notEqual(t(english), english, `${language} has a translation`);
  }
});

test('locked settings show a visible notice that the fieldsets are described by', async () => {
  const { SettingsPage } = await import('../renderer/RootApp');
  const state = { preferences: normalizePreferences({ destinations: ['/backup'] }), sources: [], jobs: [], history: [], platform: 'darwin' } as unknown as AppState;
  for (const language of languages) {
    const t = createTranslator(language);
    const markup = renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(SettingsPage, { state, act: () => {}, busy: true }) }));
    const fieldsets = markup.match(/<fieldset[^>]*>/g) ?? [];
    assert.ok(fieldsets.length >= 3);
    for (const tag of fieldsets) {
      const id = tag.match(/aria-describedby="([^"]+)"/)?.[1];
      assert.ok(id, `${language}: ${tag}`);
      assert.ok(markup.includes(`id="${id}"`), `${language}: notice ${id} exists`);
    }
    assert.ok(markup.includes(t(english)));
    assert.ok(markup.includes(t('Some settings are locked while work is active.')));
    assert.ok(!markup.includes('role="alert"'));
  }
  const free = renderToStaticMarkup(createElement(I18nProvider, { language: 'en', children: createElement(SettingsPage, { state, act: () => {}, busy: false }) }));
  assert.ok(!free.includes('aria-describedby="settings-lock'));
});
