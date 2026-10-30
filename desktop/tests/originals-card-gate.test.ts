import test from 'node:test';
import assert from 'node:assert/strict';
import { onCameraCard, type MountedVolume } from '../platform/volumes';

const volume: MountedVolume = { path: '/Volumes/EOS', external: true, removable: true };
const deps = (source: boolean) => ({ volumes: async () => [{ path: '/' }, volume], classify: async () => ({ source }) as never });

test('a folder on a camera card is never offered for deletion', async () => {
  assert.equal(await onCameraCard('/Volumes/EOS/DCIM/100CANON', deps(true)), true);
});
test('a folder on an ordinary disk may be offered', async () => {
  assert.equal(await onCameraCard('/Volumes/EOS/Backup', deps(false)), false);
  assert.equal(await onCameraCard('/Users/me/Pictures', { ...deps(true), classify: async () => ({ source: false }) as never }), false);
});
test('an unknown volume or a failed classification refuses', async () => {
  assert.equal(await onCameraCard('/elsewhere', { volumes: async () => [volume], classify: async () => ({ source: false }) as never }), true);
  assert.equal(await onCameraCard('/Volumes/EOS/x', { volumes: async () => [volume], classify: async () => { throw new Error('x'); } }), true);
});
test('a volume whose top level could not be listed counts as a card', async () => {
  assert.equal(await onCameraCard('/Volumes/EOS/x', { volumes: async () => [volume], classify: async () => ({ camera: false, source: false, layoutUnavailable: true }) as never }), true);
});
