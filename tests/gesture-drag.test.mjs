import test from 'node:test';
import assert from 'node:assert/strict';
import {GestureDrag} from '../shared/gesture-drag.mjs';
import {settleProgress} from '../shared/settle-progress.mjs';

test('movement follows fingers, pauses without a timeout, and reverses before release',()=>{
  const calls=[],drag=new GestureDrag(axis=>({move:x=>calls.push([axis,x]),end:cancelled=>calls.push(['end',cancelled])}));
  drag.start();drag.wheel({deltaX:40,deltaY:1},false);drag.wheel({deltaX:50,deltaY:0},false);
  assert.deepEqual(calls,[['horizontal',40],['horizontal',90]]);
  drag.wheel({deltaX:-70,deltaY:0},false);drag.end();
  assert.deepEqual(calls.slice(-2),[['horizontal',20],['end',false]]);
});
test('vertical strokes retain their origin eligibility while application scrolling and pinch remain available',()=>{
  const calls=[],drag=new GestureDrag(axis=>{calls.push(axis);return{move(){},end:cancel=>calls.push(cancel)};});
  assert.equal(drag.wheel({deltaX:0,deltaY:40},false),false);
  assert.equal(drag.wheel({deltaX:0,deltaY:200},true),false);
  drag.start();assert.equal(drag.wheel({deltaX:0,deltaY:40},true),true);
  assert.equal(drag.wheel({deltaX:0,deltaY:20,ctrlKey:true},true),false);
  assert.deepEqual(calls,['vertical',true]);
});
test('native gesture boundaries rearm consecutive swipes and axis lock prevents diagonal hopping',()=>{
  const calls=[],drag=new GestureDrag(axis=>({move:x=>calls.push([axis,x]),end:cancelled=>calls.push(['end',cancelled])}));
  for(let i=0;i<3;i++){drag.start();drag.wheel({deltaX:40,deltaY:0},true);drag.wheel({deltaX:0,deltaY:100},true);drag.end();}
  assert.equal(calls.filter(([axis])=>axis==='horizontal').length,6);
  assert.equal(calls.filter(([axis])=>axis==='vertical').length,0);
  assert.equal(calls.filter(([axis])=>axis==='end').length,3);
});
test('settling starts at the held position and can finish immediately for an incoming click',()=>{
  const values=[];let tick,complete=0;
  const finish=settleProgress(.3,0,x=>values.push(x),()=>complete++,{now:()=>0,request:callback=>{tick=callback;return 1;},cancel(){}});
  tick(16);assert.ok(values[0]>0&&values[0]<.3);finish();tick(1000);
  assert.equal(values.at(-1),0);assert.equal(complete,1);
});

test('quick deliberate strokes carry flick velocity, while pausing, slow strokes and tiny jitter do not',()=>{
  const velocities=[];let now=0;
  const drag=new GestureDrag(()=>({move(){},end:(_cancelled,velocity)=>velocities.push(velocity)}),()=>now);
  now=20;drag.wheel({deltaX:20,deltaY:0},true);now=40;drag.wheel({deltaX:25,deltaY:0},true);now=45;drag.end();
  assert.ok(velocities[0]>.65);
  now=60;drag.start();now=80;drag.wheel({deltaX:50,deltaY:0},true);now=250;drag.end();
  assert.equal(velocities[1],0,'Holding before lifting must use the nearest position');
  now=300;drag.start();now=400;drag.wheel({deltaX:45,deltaY:0},true);now=420;drag.end();
  assert.ok(velocities[2]<.65);
  now=500;drag.start();now=510;drag.wheel({deltaX:10,deltaY:0},true);now=515;drag.end();
  assert.equal(velocities[3],0);
});

test('a flick completes the step in its direction, including reversal and bounded picker ends',async()=>{
  const {releaseTarget}=await import('../shared/gesture-drag.mjs');
  assert.equal(releaseTarget(.1,.9),1);assert.equal(releaseTarget(.9,-.9),0);
  assert.equal(releaseTarget(.1,0),0);assert.equal(releaseTarget(.9,0),1);
  assert.equal(releaseTarget(1.1,.9,0,3),2);assert.equal(releaseTarget(1.9,-.9,0,3),1);
  assert.equal(releaseTarget(3,.9,0,3),3);assert.equal(releaseTarget(0,-.9,0,3),0);
});
