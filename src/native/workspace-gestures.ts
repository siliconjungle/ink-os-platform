import {createGestureSession} from '../../shared/gesture-session.mjs';
import {adjacentWorkspace} from '../../shared/workspace-gestures.mjs';
import {GestureDrag,type GestureMotion} from '../../shared/gesture-drag.mjs';
import {workspaceDrag} from './workspace-drag';
import type {Compositor} from './compositor';
import './workspace-gestures.css';

declare global {
  interface Window {
    inkDesktopGestures?: {isActive?():boolean;onGestureStart?(listener:()=>void):()=>void;onGestureEnd?(listener:(cancelled:boolean)=>void):()=>void;onGestureMove?(listener:(position:{x:number;y:number})=>void):()=>void;onSwipe(listener:(direction:'left'|'right')=>void):()=>void};
  }
}

export function installWorkspaceGestures(switcher:HTMLElement, compositor:Compositor, overview:{isOpen:()=>boolean;open:()=>void;close:()=>void;step:(direction:number)=>void;beginVertical:()=>GestureMotion|undefined;beginHorizontal:()=>GestureMotion|undefined;finish:()=>void}) {
  const native=!!window.inkDesktopGestures?.onGestureMove&&/Mac/.test(navigator.platform);
  let touching=false,consumeTail=false,nativeEligible:boolean|undefined,nativeX=0,nativeY=0;
  let pendingNative:{x:number;y:number}|undefined;
  let nativeModifiers={ctrlKey:false,metaKey:false,altKey:false,shiftKey:false};
  const drag=new GestureDrag(axis=>axis==='vertical'?overview.beginVertical():overview.isOpen()?overview.beginHorizontal():workspaceDrag(compositor));
  const reset=()=>{drag.end(true);touching=false;consumeTail=false;};
  const start=()=>{drag.start();touching=true;consumeTail=false;nativeEligible=undefined;nativeX=0;nativeY=0;pendingNative=undefined;};
  const end=(cancelled=false)=>{drag.end(cancelled);touching=false;};
  const session=native?undefined:createGestureSession(start,()=>end());
  const status = document.createElement('span');
  status.className = 'workspace-gesture-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  switcher.append(status);
  switcher.setAttribute('role', 'group');
  switcher.setAttribute('aria-label', 'Desktops');
  switcher.title = 'Two-finger ← / → switches desktops · Swipe up on the desktop or a window title bar for desktop selection; down to return';
  const blocked = () => !!compositor.gesture || !!document.documentElement.dataset.gesture || !!document.querySelector('.modal-backdrop,.quick-look-backdrop,.desktop-context,.system-menu');
  const step = (direction:number) => {
    if (blocked() || overview.isOpen()) {drag.end(true); return;}
    const id = adjacentWorkspace(compositor.workspaces, compositor.workspace, direction);
    if (id === undefined) return;
    compositor.switchWorkspace(id);
    status.textContent = compositor.workspaces.find(space => space.id === id)?.name || 'Desktop';
  };
  const foreground = () => window.inkDesktopGestures?.isActive?.() !== false;
  const route = (event:{deltaX:number;deltaY:number;deltaMode?:number;ctrlKey?:boolean;metaKey?:boolean;altKey?:boolean;shiftKey?:boolean;momentum?:boolean},eligible:boolean) => {
    if (blocked() || !foreground()) {reset(); return false;}
    if(native){
      if(touching&&nativeEligible===undefined){nativeEligible=eligible||overview.isOpen();nativeModifiers={ctrlKey:!!event.ctrlKey,metaKey:!!event.metaKey,altKey:!!event.altKey,shiftKey:!!event.shiftKey};if(pendingNative){consumeTail=drag.wheel({deltaX:pendingNative.x,deltaY:pendingNative.y,...nativeModifiers},nativeEligible);nativeX=pendingNative.x;nativeY=pendingNative.y;}}
      return consumeTail||touching&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&(Math.abs(event.deltaX)>Math.abs(event.deltaY)*1.5||!!nativeEligible&&Math.abs(event.deltaY)>Math.abs(event.deltaX)*1.5);
    }
    const physical=session?session.feed(event,performance.now()):touching;
    if(!physical)return consumeTail;
    const consume=drag.wheel(event,eligible||overview.isOpen());
    consumeTail=consume;return consume;
  };
  const wheel = (event:WheelEvent) => {
    const target=event.target instanceof Element?event.target:null;
    const eligible=!!target?.closest('.window-chrome')||!!target?.closest('.desktop-shell')&&!target.closest('.desktop-window,.system-bar,.desktop-bottom,.canvas-navigation,input,textarea,select,[contenteditable="true"]');
    if(route(event,eligible)){event.preventDefault();event.stopImmediatePropagation();}
  };
  const frameWheel = (event:MessageEvent) => {
    const value = event.data;
    if (value?.source !== 'ink-workspace-wheel' || value.version !== 1 ||
      ![value.deltaX,value.deltaY].every(number => Number.isFinite(number) && Math.abs(number) <= 100000) ||
      ![0,1,2].includes(value.deltaMode)) return;
    const frame = [...document.querySelectorAll<HTMLIFrameElement>('iframe.app-frame')].find(frame => frame.contentWindow === event.source);
    if (!frame || frame.closest<HTMLElement>('.desktop-window')?.hidden) return;
    try {if (new URL(frame.src, location.href).origin !== event.origin) return;} catch {return;}
    route({deltaX:value.deltaX,deltaY:value.deltaY,deltaMode:value.deltaMode,
      ctrlKey:value.ctrlKey===true,metaKey:value.metaKey===true,altKey:value.altKey===true,shiftKey:value.shiftKey===true},false);
  };
  window.addEventListener('wheel', wheel, {passive:false,capture:true});
  window.addEventListener('message', frameWheel);
  const unsubscribeStart = native?window.inkDesktopGestures?.onGestureStart?.(start):undefined;
  const unsubscribeMove=native?window.inkDesktopGestures?.onGestureMove?.(position=>{
    pendingNative=position;
    if(!touching||nativeEligible===undefined)return;
    if(blocked()||!foreground()){reset();return;}
    consumeTail=drag.wheel({deltaX:position.x-nativeX,deltaY:position.y-nativeY,...nativeModifiers},nativeEligible);
    nativeX=position.x;nativeY=position.y;
  }):undefined;
  const unsubscribeEnd = native?window.inkDesktopGestures?.onGestureEnd?.(end):undefined;
  const interrupt=()=>{end();compositor.workspaceTransition.finish();overview.finish();};
  document.addEventListener('pointerdown',interrupt,true);
  document.addEventListener('keydown',interrupt,true);
  const unsubscribe = window.inkDesktopGestures?.onSwipe(direction => {
    reset();
    const directionStep=direction==='left'?1:-1;
    if(overview.isOpen())overview.step(directionStep);else step(directionStep);
  });
  // Native window focus is authoritative; parking an iframe must not end a stroke.
  const blur=()=>{if(!native)reset();};
  window.addEventListener('blur', blur);
  const dispose = () => {
    window.removeEventListener('wheel', wheel, true);
    window.removeEventListener('message', frameWheel);
    session?.dispose();
    unsubscribeStart?.();
    unsubscribeEnd?.();
    unsubscribeMove?.();
    drag.end(true);
    compositor.workspaceTransition.finish();
    document.removeEventListener('pointerdown',interrupt,true);
    document.removeEventListener('keydown',interrupt,true);
    window.removeEventListener('blur', blur);
    window.removeEventListener('pagehide', dispose);
    unsubscribe?.();
    status.remove();
  };
  window.addEventListener('pagehide', dispose, {once:true});
  return dispose;
}
