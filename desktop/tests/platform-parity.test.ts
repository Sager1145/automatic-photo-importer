import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FEATURES } from './platform-features';
import { darwin } from './platforms/darwin';
import { win32 } from './platforms/win32';
import { linux } from './platforms/linux';

test('every platform is tested on the same app features', async () => {
  const profiles = [darwin, win32, linux];
  assert.deepEqual(profiles.map(profile => profile.platform), ['darwin', 'win32', 'linux']);
  for (const profile of profiles) {
    const file = await readFile(new URL(`./platform-${profile.platform}.test.ts`, import.meta.url), 'utf8');
    assert.ok(file.includes(`testFeatures(${profile.platform})`), `platform-${profile.platform}.test.ts runs the shared feature list`);
  }
  assert.ok(Object.keys(FEATURES).length >= 6);
});

test('builds follow release-targets.json: macOS arm64 and Windows x64 now, the rest planned', async () => {
  const read = (file: string) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
  const targets = JSON.parse(await read('release-targets.json')) as Record<string, { release: string[]; planned: string[] }>;
  assert.deepEqual(Object.keys(targets).sort(), ['darwin', 'linux', 'win32'], 'one entry per platform profile');
  for (const [platform, { release, planned }] of Object.entries(targets))
    for (const arch of [...release, ...planned]) assert.ok(['x64', 'arm64'].includes(arch), `${platform}: ${arch}`);
  const pkg = JSON.parse(await read('package.json'));
  // macOS: the DMG, its name and the native camera helper are all Apple silicon only.
  const macArgs = String(pkg.scripts['package:mac:release']);
  for (const arch of ['arm64', 'x64', 'universal']) assert.equal(macArgs.includes(`--${arch}`), targets.darwin!.release.includes(arch), `package:mac:release --${arch}`);
  assert.equal(pkg.build.mac.x64ArchFiles, undefined, 'no Intel slice in the Mac app');
  assert.match(pkg.build.dmg.artifactName, /-arm64\./);
  const helper = await read('Scripts/build_camera_bridge.sh');
  assert.ok(helper.includes('arm64-apple-macosx') && !helper.includes('x86_64') && !helper.includes('lipo'), 'camera helper is arm64 only');
  // Windows: packaging takes its architectures from the released list.
  assert.ok((await read('Scripts/package-win.mjs')).includes('.win32.release'), 'package-win.mjs reads win32.release');
});
