import {adjacentWorkspace, WorkspaceSwipe, OverviewSwipe} from '../../shared/workspace-gestures.mjs';
import type {Compositor} from './compositor';
import './workspace-gestures.css';

declare global {
  interface Window {
    inkDesktopGestures?: {isActive?():boolean;onGestureStart?(listener:()=>void):()=>void;onSwipe(listener:(direction:'left'|'right')=>void):()=>void};
  }
}

export function installWorkspaceGestures(switcher:HTMLElement, compositor:Compositor, overview:{isOpen:()=>boolean;open:()=>void;close:()=>void}) {
  const swipe = new WorkspaceSwipe();
  const vertical = new OverviewSwipe();
  const reset = () => {swipe.reset();vertical.reset();};
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
    if (blocked() || overview.isOpen()) {swipe.reset(); return;}
    const id = adjacentWorkspace(compositor.workspaces, compositor.workspace, direction);
    if (id === undefined) return;
    compositor.switchWorkspace(id);
    status.textContent = compositor.workspaces.find(space => space.id === id)?.name || 'Desktop';
  };
  const foreground = () => window.inkDesktopGestures?.isActive?.() !== false;
  const route = (event:{deltaX:number;deltaY:number;deltaMode?:number;ctrlKey?:boolean;metaKey?:boolean;altKey?:boolean;shiftKey?:boolean},eligible:boolean) => {
    if (blocked() || !foreground()) {reset(); return false;}
    const now=performance.now(),open=overview.isOpen(),motion=vertical.wheel(event,now,eligible||open);
    if(motion.step>0&&!open)overview.open();
    else if(motion.step<0&&open)overview.close();
    if(open){swipe.reset();return motion.consume;}
    const result=swipe.wheel(event,now);
    if(result.step)step(result.step);
    return result.consume||motion.consume;
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
  const unsubscribeStart = window.inkDesktopGestures?.onGestureStart?.(reset);
  const unsubscribe = window.inkDesktopGestures?.onSwipe(direction => {
    swipe.reset();
    step(direction === 'left' ? 1 : -1);
  });
  window.addEventListener('blur', reset);
  const dispose = () => {
    window.removeEventListener('wheel', wheel, true);
    window.removeEventListener('message', frameWheel);
    unsubscribeStart?.();
    window.removeEventListener('blur', reset);
    window.removeEventListener('pagehide', dispose);
    unsubscribe?.();
    status.remove();
  };
  window.addEventListener('pagehide', dispose, {once:true});
  return dispose;
}
