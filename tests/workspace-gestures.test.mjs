import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceSwipe, adjacentWorkspace} from '../shared/workspace-gestures.mjs';
const wheel = (tracker, x, y = 0, time = 0, extra = {}) => tracker.wheel({deltaX:x, deltaY:y, ...extra}, time);

test('one switch per swipe, including momentum and direction reversal after switching', () => {
  const tracker = new WorkspaceSwipe();
  assert.deepEqual(wheel(tracker, 30), {consume:true, step:0});
  assert.equal(wheel(tracker, 60, 0, 16).step, 1);
  for (let time = 32; time < 900; time += 16) assert.deepEqual(wheel(tracker, time < 300 ? 20 : -2, 0, time), {consume:true, step:0});
  assert.equal(wheel(tracker, -100, 0, 1200).step, -1);
});
test('vertical scroll, diagonal gestures and pinch zoom do not switch desktops', () => {
  for (const event of [{deltaX:0,deltaY:120},{deltaX:100,deltaY:100},{deltaX:120,deltaY:0,ctrlKey:true},{deltaX:120,deltaY:0,metaKey:true},{deltaX:120,deltaY:0,altKey:true},{deltaX:120,deltaY:0,shiftKey:true}]) {
    assert.deepEqual(new WorkspaceSwipe().wheel(event, 0), {consume:false, step:0});
  }
  const tracker = new WorkspaceSwipe();
  wheel(tracker, 0, 30);
  assert.equal(wheel(tracker, 180, 0, 16).step, 0, 'A vertical gesture keeps its axis');
});
test('small jitter, scroll units, cancellation and non-finite input are handled', () => {
  const tracker = new WorkspaceSwipe();
  assert.equal(wheel(tracker, 1, 1).step, 0);
  assert.equal(wheel(tracker, 6, 0, 16, {deltaMode:1}).step, 1);
  tracker.reset();
  assert.equal(wheel(tracker, -1, 0, 32, {deltaMode:2}).step, -1);
  assert.deepEqual(wheel(tracker, NaN), {consume:false, step:0});
  assert.equal(wheel(tracker, 100, 0, 48).step, 1);
});
test('desktop order is respected and gestures stop at either end instead of wrapping', () => {
  const spaces = [{id:7},{id:2},{id:30}];
  assert.equal(adjacentWorkspace(spaces, 7, 1), 2);
  assert.equal(adjacentWorkspace(spaces, 30, -1), 2);
  assert.equal(adjacentWorkspace(spaces, 7, -1), undefined);
  assert.equal(adjacentWorkspace(spaces, 30, 1), undefined);
  assert.equal(adjacentWorkspace([{id:7}], 7, 1), undefined);
  assert.equal(adjacentWorkspace(spaces, 99, 1), undefined);
  assert.equal(adjacentWorkspace(spaces, 2, 2), undefined);
});
