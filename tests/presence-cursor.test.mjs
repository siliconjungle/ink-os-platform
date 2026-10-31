import test from'node:test';import assert from'node:assert/strict';
import{presenceCursor,cursorScreenPoint}from'../shared/presence-cursor.mjs';
import{updatePresence,visiblePeer}from'../server/presence.mjs';

test('icon drop coordinates survive transport between different viewport sizes',()=>{
 const sender={left:12,top:24,width:1440,height:960},receiver={left:31,top:49,width:800,height:600};
 const drop={x:sender.left+420,y:sender.top+350},client={id:'peer',view:'desktop/1',sequence:0};
 assert.equal(updatePresence(client,{sequence:1,cursor:{space:'desktop',x:drop.x-sender.left,y:drop.y-sender.top}}),true);
 const point=cursorScreenPoint(visiblePeer(client,{view:'desktop/1'}).cursor,receiver);
 assert.deepEqual(point,{x:receiver.left+420,y:receiver.top+350});
 assert.equal(point.x-receiver.left,drop.x-sender.left);
 assert.equal(point.y-receiver.top,drop.y-sender.top);
});

test('offscreen desktop pointers disappear instead of moving to an edge',()=>{
 const bounds={width:800,height:600};
 for(const point of [{x:900,y:400},{x:400,y:700},{x:-2,y:300},{x:400,y:-1}])assert.equal(cursorScreenPoint({...point,space:'desktop'},bounds),null);
 assert.deepEqual(cursorScreenPoint({space:'desktop',x:799,y:599},bounds),{x:799,y:599});
});

test('legacy normalized pointers remain supported during client refresh',()=>{
 assert.deepEqual(presenceCursor({x:-1,y:2}),{x:0,y:1});
 assert.deepEqual(cursorScreenPoint({x:.25,y:.5},{width:800,height:600}),{x:200,y:300});
});

test('invalid coordinates and unknown spaces cannot leave stale pointers',()=>{
 const client={view:'desktop/1',sequence:1,cursor:{space:'desktop',x:200,y:300}};
 for(const cursor of [{space:'desktop',x:Infinity,y:1},{space:'desktop',x:1e8,y:1},{space:'other',x:1,y:1},null]){
  assert.equal(presenceCursor(cursor),null);updatePresence(client,{sequence:client.sequence+1,cursor});assert.equal(client.cursor,null);
 }
});

test('stale messages and other desktops cannot move or expose the cursor',()=>{
 const cursor={space:'desktop',x:200,y:300},client={id:'peer',view:'desktop/1',sequence:5,cursor};
 assert.equal(updatePresence(client,{sequence:4,cursor:{space:'desktop',x:9,y:9}}),false);assert.deepEqual(client.cursor,cursor);
 assert.equal(visiblePeer(client,{view:'desktop/2'}).cursor,null);
});
