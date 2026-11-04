import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createGestureSession} from '../shared/gesture-session.mjs';
import {WorkspaceSwipe} from '../shared/workspace-gestures.mjs';

test('two recorded trackpad swipes work without mouse movement, including a fresh swipe interrupting momentum',async()=>{
  const {wheelEvents}=JSON.parse(await readFile(new URL('./fixtures/desktop-double-swipe.json',import.meta.url),'utf8'));
  const bare=new WorkspaceSwipe(),tracker=new WorkspaceSwipe(),oldSteps=[],steps=[];let starts=0;
  const session=createGestureSession(()=>{starts++;tracker.reset();});
  for(const event of wheelEvents){
    session.feed(event,event.timeStamp);
    const old=bare.wheel(event,event.timeStamp),current=tracker.wheel(event,event.timeStamp);
    if(old.step)oldSteps.push(old.step);if(current.step)steps.push(current.step);
  }
  session.dispose();
  assert.deepEqual(oldSteps,[-1],'The original idle-only recognizer reproduces the dropped second swipe');
  assert.deepEqual(steps,[-1,-1]);assert.equal(starts,2);
});

test('browser momentum flags rearm immediately in either direction while momentum spikes remain one swipe',()=>{
  for(const direction of [-1,1]){
    const tracker=new WorkspaceSwipe(),steps=[];
    const session=createGestureSession(()=>tracker.reset());
    const events=[{deltaX:100,momentum:false},{deltaX:50,momentum:true},{deltaX:1000,momentum:true},{deltaX:direction,momentum:false},{deltaX:direction*100,momentum:false}];
    for(const [i,event]of events.entries()){
      const value={...event,deltaY:0,deltaMode:0},now=i*16;
      session.feed(value,now);const result=tracker.wheel(value,now);if(result.step)steps.push(result.step);
    }
    session.dispose();assert.deepEqual(steps,[1,direction]);
  }
});

test('session detection leaves scrolling to the caller and releases its listener',()=>{
  let starts=0,prevented=0;const session=createGestureSession(()=>starts++);
  session.feed({deltaX:0,deltaY:100,preventDefault:()=>prevented++},0);
  assert.equal(starts,1);assert.equal(prevented,0);
  session.dispose();session.feed({deltaX:0,deltaY:50,momentum:true},16);session.feed({deltaX:0,deltaY:20,momentum:false},32);
  assert.equal(starts,1);
});
