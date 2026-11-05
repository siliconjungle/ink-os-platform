import {settleProgress} from '../../shared/settle-progress.mjs';
import {releaseTarget} from '../../shared/gesture-drag.mjs';
/** Keep the current desktop live while moving it into and out of selection. */
export class OverviewMotion {
  private active?:()=>void;
  private held?:()=>void;
  finish(){this.active?.();}
  release(){this.finish();this.held?.();}
  run(shell:HTMLElement,preview:HTMLElement|undefined,opening:boolean,update:()=>void,complete=()=>{},currentPreview=()=>preview) {
    return this.transition(shell,preview,opening,update,()=>complete(),currentPreview,false).finished;
  }
  scrub(shell:HTMLElement,preview:HTMLElement|undefined,opening:boolean,update:()=>void,complete:(open:boolean)=>void,currentPreview=()=>preview){
    return this.transition(shell,preview,opening,update,complete,currentPreview,true);
  }
  private transition(shell:HTMLElement,preview:HTMLElement|undefined,opening:boolean,update:()=>void,complete:(open:boolean)=>void,currentPreview:()=>HTMLElement|undefined,interactive:boolean){
    this.release();update();
    const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    const layers=[...shell.querySelectorAll<HTMLElement>(':scope > .desktop-wallpaper,:scope > .desktop-items,:scope > .desktop-stage')];
    const animations:Animation[]=[],saved=layers.map(layer=>({layer,zIndex:layer.style.zIndex,origin:layer.style.transformOrigin,transform:layer.style.transform,filter:layer.style.filter,clip:layer.style.clipPath,inert:layer.inert}));
    let progress=0,frame=0,finished=false,ended=false,release:(()=>void)|undefined,livePreview=preview;
    let resolve!:()=>void;const done=new Promise<void>(yes=>resolve=yes);
    const transforms=(card:HTMLElement)=>{
      const viewport=shell.getBoundingClientRect(),rect=card.getBoundingClientRect(),scale=rect.width/viewport.width;
      return layers.map(layer=>`translate3d(${rect.left-viewport.left+layer.offsetLeft*(scale-1)}px,${rect.top-viewport.top+layer.offsetTop*(scale-1)}px,0) scale(${scale})`);
    };
    const restore=()=>{
      cancelAnimationFrame(frame);for(const animation of animations)animation.cancel();
      for(const {layer,zIndex,origin,transform,filter,clip,inert}of saved){layer.style.zIndex=zIndex;layer.style.transformOrigin=origin;layer.style.transform=transform;layer.style.filter=filter;layer.style.clipPath=clip;layer.inert=inert;}
      shell.classList.remove('overview-animating','overview-live');livePreview?.classList.remove('is-live-preview');this.held=undefined;
    };
    const finish=(open=opening)=>{
      if(finished)return;finished=true;if(this.active===interrupt)this.active=undefined;
      document.removeEventListener('pointerdown',interrupt,true);document.removeEventListener('keydown',interrupt,true);
      if(open&&livePreview&&!reduced){
        const follow=()=>{
          const card=currentPreview();if(!card?.isConnected){restore();return;}
          if(!card.getBoundingClientRect().width||!shell.clientWidth){frame=requestAnimationFrame(follow);return;}
          if(card!==livePreview){livePreview?.classList.remove('is-live-preview');livePreview=card;card.classList.add('is-live-preview');}
          const next=transforms(card),brightness=typeof getComputedStyle==='function'&&card.parentElement?getComputedStyle(card.parentElement).opacity:'1',deck=card.closest('.overview-desktops')?.getBoundingClientRect(),rect=card.getBoundingClientRect(),scale=rect.width/shell.clientWidth;
          for(const [index,layer]of layers.entries()){
            layer.style.transform=next[index];layer.style.filter=`brightness(${brightness})`;
            if(deck){const left=Math.max(0,(deck.left-rect.left)/scale-layer.offsetLeft),right=Math.max(0,layer.offsetWidth-((deck.right-rect.left)/scale-layer.offsetLeft));layer.style.clipPath=`inset(0px ${right}px 0px ${left}px)`;}
          }
          frame=requestAnimationFrame(follow);
        };
        const next=transforms(livePreview);for(const [index,layer]of layers.entries()){layer.style.transform=next[index];layer.inert=true;}
        for(const animation of animations)animation.cancel();shell.classList.remove('overview-animating');shell.classList.add('overview-live');this.held=restore;frame=requestAnimationFrame(follow);
      }else restore();
      complete(open);resolve();
    };
    const paint=(value:number)=>{progress=Math.max(0,Math.min(1,value));for(const animation of animations)animation.currentTime=progress*1000;};
    const end=(cancelled=false,velocity=0)=>{
      if(finished||ended)return;ended=true;const target=cancelled?0:releaseTarget(progress,velocity),open=target===1?opening:!opening;
      if(reduced||!animations.length)finish(open);else release=settleProgress(progress,target,paint,()=>finish(open));
    };
    const interrupt=()=>{if(release)release();else finish(interactive?(progress>=.5?opening:!opening):opening);};
    const control={move:(value:number)=>{if(!ended&&!finished)paint(value);},end,finished:done};
    if(!preview||!shell.clientWidth||!preview.getBoundingClientRect().width||reduced){if(!interactive)finish();else this.active=interrupt;return control;}
    shell.classList.add('overview-animating');preview.classList.add('is-live-preview');
    const small=transforms(preview),duration=interactive?1000:340,easing=interactive?'linear':'cubic-bezier(.22,.8,.25,1)';
    for(const [index,layer]of layers.entries()){
      if(opening)layer.inert=true;layer.style.zIndex=String(22000+index);layer.style.transformOrigin='0 0';
      animations.push(layer.animate([{transform:opening?'none':small[index]},{transform:opening?small[index]:'none'}],{duration,easing,fill:'both'}));
    }
    const overview=preview.closest?.('.window-overview');
    if(overview)animations.push(overview.animate([{opacity:opening?0:1},{opacity:opening?1:0}],{duration:interactive?1000:240,easing:interactive?'linear':'ease-out',fill:'both'}));
    if(interactive){
      // These live in separate stacking layers, so each follows the held position.
      const dock=shell.querySelector<HTMLElement>(':scope > .desktop-bottom'),navigation=overview?.querySelector<HTMLElement>('.overview-navigation');
      if(dock)animations.push(dock.animate([{opacity:opening?1:0},{opacity:opening?0:1}],{duration:1000,fill:'both'}));
      if(navigation)animations.push(navigation.animate([{opacity:opening?0:1},{opacity:opening?1:0}],{duration:1000,fill:'both'}));
      for(const animation of animations){animation.pause();animation.currentTime=0;}
    }else void Promise.allSettled(animations.map(animation=>animation.finished)).then(()=>finish());
    this.active=interrupt;
    document.addEventListener('pointerdown',interrupt,true);document.addEventListener('keydown',interrupt,true);
    return control;
  }
}
