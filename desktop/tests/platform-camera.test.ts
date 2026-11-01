import test from 'node:test';
import assert from 'node:assert/strict';

// The helper protocol (list, files, read by range) is tested on every system in camera-direct.test.ts.
test('a USB camera reports its card slots, and its capacity is their sum', async () => {
  const { cameraCapacity } = await import('../platform/camera-bridge');
  assert.deepEqual(cameraCapacity([{name:'Slot 1',total:100,free:40},{name:'Slot 2',total:100,free:60}]), {storages:[{name:'Slot 1',total:100,free:40},{name:'Slot 2',total:100,free:60}],total:200,free:100});
  // One slot without figures: the slots are still listed, but no partial sum is shown as the camera's capacity.
  assert.deepEqual(cameraCapacity([{name:'Slot 1',total:100,free:40},{name:'Slot 2'}]), {storages:[{name:'Slot 1',total:100,free:40},{name:'Slot 2',total:undefined,free:undefined}],total:undefined,free:undefined});
  assert.deepEqual(cameraCapacity(undefined), {});
});
