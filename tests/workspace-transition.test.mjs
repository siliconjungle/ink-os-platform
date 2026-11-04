import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceTransition} from '../shared/workspace-transition.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function fixture() {
  const views=[];
  const document={documentElement:{dataset:{}},visibilityState:'visible',startViewTransition(update){
    const ready=deferred(),finished=deferred(),done=deferred();
    const view={ready:ready.promise,finished:finished.promise,updateCallbackDone:done.promise,
      skipTransition(){this.skipped=true;},commit(){update();done.resolve();},end(){ready.resolve();finished.resolve();}};
    views.push(view);return view;
  }};
  return{document,views,transition:new WorkspaceTransition(document,()=>false)};
}
test('outgoing content is retained until captured, then the switch commits before animation ends',async()=>{
  const f=fixture();let desktop=1;
  const switched=f.transition.run(1,()=>desktop=2);
  assert.equal(desktop,1);
  assert.equal(f.document.documentElement.dataset.workspaceSlide,'next');
  f.views[0].commit();await switched;
  assert.equal(desktop,2);
  f.views[0].end();await Promise.resolve();await Promise.resolve();
  assert.equal(f.document.documentElement.dataset.workspaceSlide,undefined);
});
test('rapid reversals commit each destination exactly once and stale completion preserves the latest animation',async()=>{
  const f=fixture(),visited=[];
  f.transition.run(1,()=>visited.push(2));
  f.transition.run(-1,()=>visited.push(1));
  assert.deepEqual(visited,[2]);
  assert.equal(f.views[0].skipped,true);
  f.views[0].commit();f.views[0].end();await Promise.resolve();await Promise.resolve();
  assert.deepEqual(visited,[2]);
  assert.equal(f.document.documentElement.dataset.workspaceSlide,'previous');
  f.views[1].commit();assert.deepEqual(visited,[2,1]);
  f.transition.finish();assert.deepEqual(visited,[2,1]);
  assert.equal(f.document.documentElement.dataset.workspaceSlide,undefined);
});
test('reduced motion, hidden pages, unsupported browsers and capture failures still switch immediately',async()=>{
  for(const mode of ['reduced','hidden','unsupported','failure']){
    const f=fixture();let switched=false;
    if(mode==='reduced')f.transition.reducedMotion=()=>true;
    if(mode==='hidden')f.document.visibilityState='hidden';
    if(mode==='unsupported')delete f.document.startViewTransition;
    if(mode==='failure')f.document.startViewTransition=()=>{throw Error('capture unavailable');};
    await f.transition.run(1,()=>switched=true);
    assert.equal(switched,true,mode);
    assert.equal(f.document.documentElement.dataset.workspaceSlide,undefined,mode);
  }
});
