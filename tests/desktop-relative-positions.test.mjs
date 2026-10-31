import test from'node:test';import assert from'node:assert/strict';
import{relativePlacement,placementPoint,ICON_WIDTH,ICON_HEIGHT}from'../shared/desktop-coordinates.mjs';
import{placementMaps,placementTransfer,applyPlacementChanges,validPlacement}from'../shared/desktop-placements.mjs';
import{cursorScreenPoint}from'../shared/presence-cursor.mjs';
import{updatePresence}from'../server/presence.mjs';

test('icon centers and cursors share proportions between differently sized windows',()=>{
 const saved=relativePlacement({x:676,y:440},{width:1440,height:960});
 assert.deepEqual(saved,{x:.5,y:.5,relative:true});
 const client={sequence:0};updatePresence(client,{sequence:1,cursor:{x:720/1440,y:480/960}});
 for(const area of [{width:800,height:600},{width:1920,height:1080}]){
  const icon=placementPoint(saved,area),cursor=cursorScreenPoint(client.cursor,area);
  assert.equal(cursor.x,icon.x+ICON_WIDTH/2);assert.equal(cursor.y,icon.y+ICON_HEIGHT/2);
 }
 assert.deepEqual(saved,{x:.5,y:.5,relative:true});
});

test('out-of-bounds drops stay inside the usable area after resizing',()=>{
 for(const point of [{x:-100,y:-100},{x:10000,y:10000}]){
  const saved=relativePlacement(point,{width:1440,height:960});assert.ok(validPlacement(saved));
  for(const area of [{width:800,height:600},{width:120,height:100}]){
   const p=placementPoint(saved,area);assert.ok(p.x>=0&&p.y>=0);assert.ok(p.x+ICON_WIDTH<=area.width);assert.ok(p.y+ICON_HEIGHT<=area.height);
  }
 }
});

test('legacy layouts convert explicitly and retain the relative marker on projection',()=>{
 const id='a'.repeat(32),saved=relativePlacement({x:200,y:300},{width:1440,height:960});
 assert.deepEqual(relativePlacement(saved,{width:800,height:600}),saved);
 const projected=placementMaps({1:{[id]:saved}},[{id:1}]);assert.deepEqual(projected[1][id],saved);
 assert.deepEqual(placementPoint({x:200,y:300},{width:1440,height:960}),{x:200,y:300});
 assert.equal(validPlacement({x:2,y:.3,relative:true}),false);
});

test('cross-desktop paste retains relative units and undo preserves exact originals',()=>{
 const a='a'.repeat(32),b='b'.repeat(32),area={width:1000,height:700},spaces=[{id:1},{id:2}];
 const placements={1:{[a]:relativePlacement({x:100,y:100},area),[b]:relativePlacement({x:200,y:100},area)}};
 const before=structuredClone(placements),change=placementTransfer(placements,spaces,[a,b],{from:1,to:2,cut:true,point:{x:300,y:300},area});
 applyPlacementChanges(placements,spaces,change.after);assert.equal(placements[2][a].relative,true);assert.equal(placements[2][b].relative,true);
 assert.equal(Math.round(placementPoint(placements[2][b],area).x-placementPoint(placements[2][a],area).x),100);
 applyPlacementChanges(placements,spaces,change.before);assert.deepEqual(placements[1],before[1]);assert.deepEqual(placements[2],{});
});
