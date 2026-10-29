import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarSources } from '../renderer/RootApp';
import { I18nProvider } from '../renderer/i18n';
import type { AppState, DriveActivity } from '../shared';

const render = (state: AppState) => renderToStaticMarkup(createElement(I18nProvider, { language: 'en', children: createElement(SidebarSources, { state, onOpen() {} }) }));
const card = { id: 'card', name: 'Card', path: '/Volumes/CARD', transport: 'storage', selected: true, total: 128e9, free: 40e9 };
const stateWith = (extra: Partial<AppState>) => ({ preferences: { copyMode: 'single', destinations: [], sourceLayout: 'list' }, sources: [card], jobs: [], history: [], platform: 'darwin', ...extra }) as unknown as AppState;
const quiet: DriveActivity = { utilization: 0, readBps: 0, writeBps: 0, history: [0, 0] } as DriveActivity;

test('an idle source is three lines, with free space and activity still on screen', () => {
  const html = render(stateWith({ driveActivity: { card: { ...quiet, utilization: 37 } } }));
  assert.match(html, /class="sidebar-drive is-idle/);
  assert.match(html, /<div class="sidebar-detail"><small class="sidebar-capacity-text"[^>]*><span class="capacity-full">40.0 GB free of 128.0 GB<\/span>/);
  assert.match(html, /class="sidebar-activity-inline"[^>]*aria-valuetext="Activity ≈37%"[^>]*>.*37%<\/small><\/div>/);
  assert.ok(!html.includes('sidebar-activity-bar'), 'the activity figure joins the free-space line');
});

test('a quiet drive still shows its activity figure', () => {
  assert.match(render(stateWith({ driveActivity: { card: quiet } })), /class="sidebar-activity-inline"[^>]*>.*0%<\/small>/);
});

test('a source with a running job, a scan or low space keeps the four-line layout', () => {
  const job = { id: 'j', source: card, phase: 'copying', errors: [], backup: false, startedAt: new Date().toISOString(), progress: { phase: 'copying', completed: 1, total: 10, bytes: 1, totalBytes: 10, speed: 0 } };
  for (const state of [stateWith({ jobs: [job] as unknown as AppState['jobs'] }), stateWith({ scanningSources: ['card'] }), stateWith({ sources: [{ ...card, free: 1e9 }] as AppState['sources'] })]) {
    const html = render(state);
    assert.ok(!html.includes('is-idle') && !html.includes('sidebar-detail'));
    assert.ok(html.includes('sidebar-capacity-text'));
  }
});

test('an idle source without its own capacity keeps its note visible', () => {
  const html = render(stateWith({ sources: [{ id: 'cam', name: 'Camera', path: '', transport: 'camera', selected: true }] as unknown as AppState['sources'] }));
  assert.ok(html.includes('Capacity unavailable over USB'));
});
