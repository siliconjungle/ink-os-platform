import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceSwipe, OverviewSwipe, adjacentWorkspace} from '../shared/workspace-gestures.mjs';
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

test('a new physical gesture rearms immediately without waiting for the previous momentum to become idle', () => {
  const tracker=new WorkspaceSwipe();
  assert.equal(wheel(tracker,100,0,0).step,1);
  assert.equal(wheel(tracker,40,0,16).step,0);
  tracker.reset(); // The native scroll-begin event, independent of selected app or desktop.
  assert.equal(wheel(tracker,100,0,32).step,1);
  tracker.reset();
  assert.equal(wheel(tracker,-100,0,48).step,-1);
});

test('vertical overview strokes open/close once per gesture and preserve the originating surface',()=>{
  const tracker=new OverviewSwipe();
  const event=(y,time,eligible=true,x=0)=>tracker.wheel({deltaX:x,deltaY:y},time,eligible);
  assert.deepEqual(event(35,0),{consume:true,step:0});
  assert.equal(event(75,16).step,1);
  for(let time=32;time<500;time+=16)assert.equal(event(25,time).step,0);
  tracker.reset();assert.equal(event(-110,510).step,-1);
  tracker.reset();assert.deepEqual(event(120,600,false),{consume:false,step:0});
  assert.deepEqual(event(150,616,true),{consume:false,step:0},'Moving from app content onto chrome does not steal its scroll');
  assert.equal(event(120,1000).step,1,'A later stroke can start on chrome');
});

test('overview gestures ignore horizontal strokes, diagonal scrolling and browser-inherited zoom modifiers',()=>{
  for(const value of [{deltaX:120,deltaY:0},{deltaX:110,deltaY:100},{deltaX:0,deltaY:120,ctrlKey:true},{deltaX:0,deltaY:120,metaKey:true},{deltaX:0,deltaY:120,altKey:true},{deltaX:0,deltaY:120,shiftKey:true}]){
    // WheelEvent properties are inherited accessors rather than enumerable own properties.
    assert.deepEqual(new OverviewSwipe().wheel(Object.create(value),0,true),{consume:false,step:0});
  }
});
