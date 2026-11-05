import {settleProgress} from './settle-progress.mjs';
import {releaseTarget} from './gesture-drag.mjs';
/** Capture outgoing app pixels before inactive frames are parked/destroyed. */
export class WorkspaceTransition {
  constructor(document, reducedMotion = () => document.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    this.document = document;
    this.reducedMotion = reducedMotion;
    this.active = undefined;
  }
  finish() {
    const active = this.active;
    if (!active) return;
    if(active.finish){active.finish();return;}
    active.commit();
    active.view.skipTransition();
    active.cleanup();
    this.active = undefined;
    delete this.document.documentElement.dataset.workspaceSlide;
  }
  scrub(direction,prepare,settled) {
    this.finish();
    const document=this.document;let progress=0,ended=false,ready=false,done=false,prepared=false,animations=[],release,view;
    const paint=value=>{progress=Math.max(0,Math.min(1,value));for(const animation of animations)animation.currentTime=Math.min(.99999,progress)*1000;};
    const finish=accept=>{
      if(done)return;done=true;
      // Restore the source before dropping the transition snapshots when cancelled.
      settled(accept,prepared);view?.skipTransition();
      if(this.active===active){this.active=undefined;delete document.documentElement.dataset.workspaceSlide;delete document.documentElement.dataset.workspaceScrub;}
    };
    const settle=(cancelled=false,velocity=0)=>{
      if(done)return;ended=true;const target=cancelled?0:releaseTarget(progress,velocity);
      active.finish=()=>{release?.();finish(target===1);};
      if(!ready)return;
      if(this.reducedMotion()||!animations.length)finish(target===1);
      else release=settleProgress(progress,target,paint,()=>finish(target===1));
    };
    const active={finish:()=>{release?.();finish(progress>=.5);}};
    this.active=active;
    if(!document.startViewTransition||this.reducedMotion()||document.visibilityState==='hidden')ready=true;
    else {
      document.documentElement.dataset.workspaceSlide=direction>0?'next':'previous';
      document.documentElement.dataset.workspaceScrub='true';
      try {
        view=document.startViewTransition(()=>{if(!done){prepare();prepared=true;}});
        view.ready.then(()=>{
          if(done)return;
          animations=document.getAnimations().filter(animation=>/^::view-transition-(old|new|group)\(ink-desktop\)$/.test(animation.effect?.pseudoElement||''));
          for(const animation of animations){animation.pause();animation.effect.updateTiming({duration:1000,easing:'linear'});}
          ready=true;paint(progress);if(ended)active.finish();
        }).catch(()=>{ready=true;if(ended)active.finish();});
        view.finished.catch(()=>{});
      }catch{ready=true;}
    }
    return {move:value=>{if(!ended&&!done)paint(value);},end:settle,
      cancel:()=>{release?.();finish(false);}};
  }
  run(direction, update, cleanup = () => {}) {
    this.finish();
    let committed = false;
    const commit = () => {if (!committed) {committed = true; update();}};
    const document = this.document;
    if (!document.startViewTransition || this.reducedMotion() || document.visibilityState === 'hidden') {
      commit();
      cleanup();
      return Promise.resolve();
    }
    document.documentElement.dataset.workspaceSlide = typeof direction === 'string' ? direction : direction > 0 ? 'next' : 'previous';
    let view;
    try {view = document.startViewTransition(commit);}
    catch {delete document.documentElement.dataset.workspaceSlide; commit(); cleanup(); return Promise.resolve();}
    const active = {view, commit, cleanup};
    this.active = active;
    // Skip an interrupted animation without losing its update or clearing a newer one's styles.
    view.ready.catch(() => {});
    view.finished.catch(() => {}).then(() => {
      if (this.active !== active) return;
      this.active = undefined;
      cleanup();
      delete document.documentElement.dataset.workspaceSlide;
    });
    return view.updateCallbackDone;
  }
}
