import test from 'node:test';
import assert from 'node:assert/strict';
import {OverviewMotion} from '../src/native/overview-motion.ts';

function fixture(t,reduced=false){
  const previous={document:globalThis.document,matchMedia:globalThis.matchMedia,requestAnimationFrame:globalThis.requestAnimationFrame,cancelAnimationFrame:globalThis.cancelAnimationFrame};
  const document=new EventTarget(),animations=[];
  globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};globalThis.document=document;globalThis.matchMedia=()=>({matches:reduced});
  const classes=()=>{const set=new Set();return{add:x=>set.add(x),remove:(...values)=>values.forEach(x=>set.delete(x)),contains:x=>set.has(x)};};
  const layers=Array.from({length:3},()=>({inert:false,style:{zIndex:'',transformOrigin:'',transform:'',filter:''},offsetLeft:0,offsetTop:0,getBoundingClientRect:()=>({left:0,top:0}),animate(){
    let resolve;const finished=new Promise(yes=>resolve=yes);const animation={finished,cancelled:false,cancel(){this.cancelled=true;resolve();}};animations.push(animation);return animation;
  }}));
  const shell={clientWidth:1000,classList:classes(),querySelectorAll:()=>layers,getBoundingClientRect:()=>({left:0,top:0,width:1000})};
  const preview={classList:classes(),getBoundingClientRect:()=>({left:350,top:180,width:300,height:210})};
  const motion=new OverviewMotion();
  t.after(()=>{motion.release();for(const key of Object.keys(previous)){if(previous[key]===undefined)delete globalThis[key];else globalThis[key]=previous[key];}});
  return{document,layers,shell,preview,motion,animations};
}

test('clicking during overview motion finishes it without swallowing the click or delaying the UI update',async t=>{
  const f=fixture(t),events=[];
  const done=f.motion.run(f.shell,f.preview,true,()=>events.push('opened'),()=>events.push('finished'));
  assert.deepEqual(events,['opened'],'Selection controls must exist immediately');
  assert.equal(f.shell.classList.contains('overview-animating'),true);
  f.document.addEventListener('pointerdown',event=>{assert.equal(event.defaultPrevented,false);events.push('click');});
  f.document.dispatchEvent(new Event('pointerdown',{cancelable:true}));
  await done;
  assert.deepEqual(events,['opened','finished','click']);
  assert.equal(f.preview.classList.contains('is-live-preview'),true,'Keep a live miniature instead of swapping its contents');
  f.motion.release();
  assert.equal(f.shell.classList.contains('overview-animating'),false);
  assert.equal(f.preview.classList.contains('is-live-preview'),false);
  assert.ok(f.animations.every(animation=>animation.cancelled));
  assert.ok(f.layers.every(layer=>layer.style.zIndex===''&&!layer.inert));
});

test('a rapid reversal completes the previous state once and keyboard input remains available',async t=>{
  const f=fixture(t),events=[];
  const opened=f.motion.run(f.shell,f.preview,true,()=>events.push('open'),()=>events.push('open-finished'));
  const closed=f.motion.run(f.shell,f.preview,false,()=>events.push('close'),()=>events.push('close-finished'));
  assert.deepEqual(events,['open','open-finished','close']);
  f.document.dispatchEvent(new Event('keydown'));await Promise.all([opened,closed]);
  f.motion.finish();assert.deepEqual(events,['open','open-finished','close','close-finished']);
});

test('reduced motion updates immediately without creating animations or hiding the preview',async t=>{
  const f=fixture(t,true),events=[];
  await f.motion.run(f.shell,f.preview,true,()=>events.push('open'),()=>events.push('finished'));
  assert.deepEqual(events,['open','finished']);assert.equal(f.animations.length,0);
  assert.equal(f.preview.classList.contains('is-live-preview'),false);
});
