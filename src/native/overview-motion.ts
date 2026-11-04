/** Keep the current desktop live while moving it into and out of selection. */
export class OverviewMotion {
  private active?:()=>void;
  private held?:()=>void;
  finish(){this.active?.();}
  release(){this.finish();this.held?.();}
  run(shell:HTMLElement,preview:HTMLElement|undefined,opening:boolean,update:()=>void,complete=()=>{},currentPreview=()=>preview) {
    this.release();update();
    const layers=[...shell.querySelectorAll<HTMLElement>(':scope > .desktop-wallpaper,:scope > .desktop-items,:scope > .desktop-stage')];
    if(!preview||!shell.clientWidth||matchMedia('(prefers-reduced-motion: reduce)').matches){complete();return Promise.resolve();}
    const target=preview.getBoundingClientRect();if(!target.width||!target.height){complete();return Promise.resolve();}
    const animations:Animation[]=[],saved=layers.map(layer=>({layer,zIndex:layer.style.zIndex,origin:layer.style.transformOrigin,transform:layer.style.transform,filter:layer.style.filter,clip:layer.style.clipPath,inert:layer.inert}));
    const transforms=(card:HTMLElement)=>{
      const viewport=shell.getBoundingClientRect(),rect=card.getBoundingClientRect(),scale=rect.width/viewport.width;
      return layers.map(layer=>`translate3d(${rect.left-viewport.left+layer.offsetLeft*(scale-1)}px,${rect.top-viewport.top+layer.offsetTop*(scale-1)}px,0) scale(${scale})`);
    };
    let livePreview=preview,frame=0;
    const restore=()=>{
      cancelAnimationFrame(frame);for(const animation of animations)animation.cancel();
      for(const {layer,zIndex,origin,transform,filter,clip,inert}of saved){layer.style.zIndex=zIndex;layer.style.transformOrigin=origin;layer.style.transform=transform;layer.style.filter=filter;layer.style.clipPath=clip;layer.inert=inert;}
      shell.classList.remove('overview-animating','overview-live');livePreview.classList.remove('is-live-preview');this.held=undefined;
    };
    shell.classList.add('overview-animating');preview.classList.add('is-live-preview');
    const small=transforms(preview);
    for(const [index,layer]of layers.entries()){
      if(opening)layer.inert=true;layer.style.zIndex=String(22000+index);layer.style.transformOrigin='0 0';
      animations.push(layer.animate([{transform:opening?'none':small[index]},{transform:opening?small[index]:'none'}],{duration:340,easing:'cubic-bezier(.22,.8,.25,1)',fill:'both'}));
    }
    const overview=preview.closest?.('.window-overview');
    if(overview)animations.push(overview.animate([{opacity:opening?0:1},{opacity:opening?1:0}],{duration:240,easing:'ease-out',fill:'both'}));
    let resolve!:()=>void,finished=false;
    const done=new Promise<void>(yes=>resolve=yes);
    const finish=()=>{
      if(finished)return;finished=true;if(this.active===finish)this.active=undefined;
      document.removeEventListener('pointerdown',finish,true);document.removeEventListener('keydown',finish,true);
      if(opening){
        // Retain the live miniature; do not swap it for a schematic thumbnail.
        const follow=()=>{
          const card=currentPreview();if(!card?.isConnected){restore();return;}
          if(!card.getBoundingClientRect().width||!shell.clientWidth){frame=requestAnimationFrame(follow);return;}
          if(card!==livePreview){livePreview.classList.remove('is-live-preview');livePreview=card;card.classList.add('is-live-preview');}
          const next=transforms(card),brightness=typeof getComputedStyle==='function'&&card.parentElement?getComputedStyle(card.parentElement).opacity:'1',deck=card.closest('.overview-desktops')?.getBoundingClientRect(),rect=card.getBoundingClientRect(),scale=rect.width/shell.clientWidth;
          for(const [index,layer]of layers.entries()){
            layer.style.transform=next[index];layer.style.filter=`brightness(${brightness})`;
            if(deck){const left=Math.max(0,(deck.left-rect.left)/scale-layer.offsetLeft),right=Math.max(0,layer.offsetWidth-((deck.right-rect.left)/scale-layer.offsetLeft));layer.style.clipPath=`inset(0px ${right}px 0px ${left}px)`;}
          }
          frame=requestAnimationFrame(follow);
        };
        const next=transforms(livePreview);for(const [index,layer]of layers.entries())layer.style.transform=next[index];
        for(const animation of animations)animation.cancel();shell.classList.remove('overview-animating');shell.classList.add('overview-live');this.held=restore;frame=requestAnimationFrame(follow);
      }else restore();
      complete();resolve();
    };
    this.active=finish;
    // Let a click/key finish the motion, then continue to its normal handler.
    document.addEventListener('pointerdown',finish,true);document.addEventListener('keydown',finish,true);
    void Promise.allSettled(animations.map(animation=>animation.finished)).then(finish);
    return done;
  }
}
