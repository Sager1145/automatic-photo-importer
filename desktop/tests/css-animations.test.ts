import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

const css = fs.readFileSync(new URL('../renderer/styles.css', import.meta.url), 'utf8');
const keyframes = (name: string) => new RegExp(`@keyframes ${name}\\{([^]*?\\}\\})`).exec(css)?.[1] ?? '';

test('infinite sidebar step animations only touch opacity and transform', () => {
  for (const name of ['step-flash', 'step-ping']) {
    const body = keyframes(name);
    assert.ok(body, `${name} exists`);
    assert.doesNotMatch(body, /box-shadow|background|color|filter/, `${name} stays on the compositor`);
  }
});

test('the flashing step keeps its animation layered inside the dot, behind overlays', () => {
  assert.match(css, /\.mini-steps i\[data-state=active\]\{[^}]*isolation:isolate/);
  assert.match(css, /\.mini-steps i\[data-state=active\]::before\{[^}]*z-index:-1[^}]*animation:step-flash/);
  assert.doesNotMatch(css, /\.mini-steps i\[data-state=active\]\{[^}]*animation:/);
});
