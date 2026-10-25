import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

const css = fs.readFileSync(new URL('../renderer/styles.css', import.meta.url), 'utf8').replace(/\/\*[^]*?\*\//g, '');
// Every declaration block whose selector list names exactly this selector.
const rules = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selectors]) => selectors!.split(',').map(part => part.trim()).includes(selector)).map(([, , body]) => body!);

// The sidebar is a window drag region; Electron gives a drag region's wheel events to the window, so a scroller inside it must opt out or it never scrolls.
test('the sidebar drags the window but its scrolling device list takes the wheel', () => {
  assert.ok(rules('.sidebar').some(body => /-webkit-app-region:drag/.test(body)), 'the sidebar still drags the window');
  assert.ok(rules('.sidebar-devices').some(body => /overflow-y:auto/.test(body)), 'the device list is the sidebar scroller');
  assert.ok(rules('.sidebar-devices').some(body => /-webkit-app-region:no-drag/.test(body)), 'the device list is not a drag region');
});
