import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../renderer/i18n';
import { normalizePreferences } from '../preferences';
import type { AppState, Job } from '../shared';

test('the dashboard organization list shows no file name; the per-job view keeps it', async () => {
  const { ImportDesk } = await import('../renderer/RootApp');
  const { OrganizationProgress } = await import('../renderer/progress');
  const job: Job = { id: 'o', source: { id: 'library:/b', name: 'Library', path: '/b', transport: 'folder' }, phase: 'copying', organization: true, errors: [], backup: false, startedAt: new Date().toISOString(), progress: { phase: 'copying', step: 'moving', completed: 3, total: 10, bytes: 0, totalBytes: 0, speed: 1000, file: 'SECRET_NAME_0042.JPG' } };
  const render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { language: 'en', children: child }));
  const state = { preferences: normalizePreferences({ destinations: ['/b'] }), sources: [], jobs: [job], history: [], platform: 'darwin' } as unknown as AppState;
  const desk = render(createElement(ImportDesk, { state, act: () => {}, inspect: () => {}, onOrganization: () => {}, onSettings: () => {} }));
  const list = desk.match(/<ul class="progress-jobs">[\s\S]*?<\/ul>/)?.[0];
  assert.ok(list, 'the dashboard lists the organization');
  assert.ok(!list.includes('SECRET_NAME_0042'));
  assert.ok(render(createElement(OrganizationProgress, { job })).includes('SECRET_NAME_0042'), 'per-job detail keeps the file');
});
