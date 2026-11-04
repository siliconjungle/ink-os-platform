import test from 'node:test';
import assert from 'node:assert/strict';
import {desktopNeighbor} from '../shared/desktop-navigation.mjs';

const box=(x,y,width=88,height=80)=>({x,y,width,height});
const grid=new Map([['bottom-right',box(220,220)],['top-left',box(20,20)],['bottom-left',box(20,220)],['top-right',box(220,20)],['middle',box(120,120)]]);

test('four directions follow icon positions rather than insertion or file order',()=>{
 assert.equal(desktopNeighbor(grid,'top-left','ArrowRight'),'top-right');
 assert.equal(desktopNeighbor(grid,'top-left','ArrowDown'),'bottom-left');
 assert.equal(desktopNeighbor(grid,'bottom-right','ArrowLeft'),'bottom-left');
 assert.equal(desktopNeighbor(grid,'bottom-right','ArrowUp'),'top-right');
 for(const direction of ['ArrowLeft','ArrowUp'])assert.equal(desktopNeighbor(grid,'top-left',direction),'top-left');
 for(const direction of ['ArrowRight','ArrowDown'])assert.equal(desktopNeighbor(grid,'bottom-right',direction),'bottom-right');
});

test('free-positioned icons use the nearest forward neighbour, with aligned rows and columns preferred',()=>{
 const icons=new Map([['start',box(0,0)],['diagonal',box(120,100)],['aligned',box(250,35)],['below',box(5,240)],['behind',box(-100,0)]]);
 assert.equal(desktopNeighbor(icons,'start','ArrowRight'),'aligned');
 assert.equal(desktopNeighbor(icons,'start','ArrowDown'),'below');
 icons.delete('aligned');assert.equal(desktopNeighbor(icons,'start','ArrowRight'),'diagonal');
 icons.delete('below');assert.equal(desktopNeighbor(icons,'start','ArrowDown'),'diagonal');
});

test('an empty selection starts at the first visible icon without skipping it',()=>{
 const icons=new Map([['offscreen',box(-300,-300)],['second',box(120,20)],['first',box(20,20)]]);
 for(const direction of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'])assert.equal(desktopNeighbor(icons,undefined,direction,{width:800,height:600}),'first');
 assert.equal(desktopNeighbor(new Map(),undefined,'ArrowDown'),undefined);
 assert.equal(desktopNeighbor(icons,'removed','ArrowDown',{width:800,height:600}),'first');
});

test('resizing or uniformly zooming the same desktop preserves directional relationships',()=>{
 for(const scale of [.5,1,2]){
  const scaled=new Map([...grid].map(([id,rect])=>[id,{x:rect.x*scale,y:rect.y*scale,width:rect.width*scale,height:rect.height*scale}]));
  assert.equal(desktopNeighbor(scaled,'top-left','ArrowRight'),'top-right');
  assert.equal(desktopNeighbor(scaled,'top-left','ArrowDown'),'bottom-left');
 }
});

test('invalid rectangles are ignored and exact ties are stable across catalog order',()=>{
 const icons=new Map([['start',box(0,0)],['z',box(150,0)],['a',box(150,0)],['invalid',box(NaN,0)]]);
 assert.equal(desktopNeighbor(icons,'start','ArrowRight'),'a');
 assert.equal(desktopNeighbor([...icons].reverse(),'start','ArrowRight'),'a');
});

test('slightly misaligned columns and rows do not turn edge keys into long sideways jumps',()=>{
 const column=new Map([['top',box(20,20)],['bottom',box(15,600)]]);
 assert.equal(desktopNeighbor(column,'top','ArrowLeft'),'top');
 assert.equal(desktopNeighbor(column,'top','ArrowDown'),'bottom');
 const row=new Map([['left',box(20,20)],['right',box(600,15)]]);
 assert.equal(desktopNeighbor(row,'left','ArrowUp'),'left');
 assert.equal(desktopNeighbor(row,'left','ArrowRight'),'right');
});
