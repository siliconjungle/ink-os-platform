import {adjacentWorkspace, WorkspaceSwipe} from '../../shared/workspace-gestures.mjs';
import type {Compositor} from './compositor';
import './workspace-gestures.css';

declare global {
  interface Window {
    inkDesktopGestures?: {isActive?():boolean;onGestureStart?(listener:()=>void):()=>void;onSwipe(listener:(direction:'left'|'right')=>void):()=>void};
  }
}

export function installWorkspaceGestures(switcher:HTMLElement, compositor:Compositor) {
  const swipe = new WorkspaceSwipe();
  const status = document.createElement('span');
  status.className = 'workspace-gesture-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  switcher.append(status);
  switcher.setAttribute('role', 'group');
  switcher.setAttribute('aria-label', 'Desktops');
  switcher.title = 'Two-finger horizontal swipe anywhere in the active Ink window · Ctrl Alt ← / →';
  const blocked = () => !!compositor.gesture || !!document.documentElement.dataset.gesture || !!document.querySelector('.modal-backdrop,.quick-look-backdrop,.window-overview,.desktop-context,.system-menu');
  const step = (direction:number) => {
    if (blocked()) {swipe.reset(); return;}
    const id = adjacentWorkspace(compositor.workspaces, compositor.workspace, direction);
    if (id === undefined) return;
    compositor.switchWorkspace(id);
    status.textContent = compositor.workspaces.find(space => space.id === id)?.name || 'Desktop';
  };
  const foreground = () => window.inkDesktopGestures?.isActive?.() !== false;
  const wheel = (event:WheelEvent) => {
    if (blocked() || !foreground()) {swipe.reset(); return;}
    const result = swipe.wheel(event, performance.now());
    if (result.consume) {event.preventDefault(); event.stopImmediatePropagation();}
    if (result.step) step(result.step);
  };
  const frameWheel = (event:MessageEvent) => {
    const value = event.data;
    if (value?.source !== 'ink-workspace-wheel' || value.version !== 1 ||
      ![value.deltaX,value.deltaY].every(number => Number.isFinite(number) && Math.abs(number) <= 100000) ||
      ![0,1,2].includes(value.deltaMode)) return;
    const frame = [...document.querySelectorAll<HTMLIFrameElement>('iframe.app-frame')].find(frame => frame.contentWindow === event.source);
    if (!frame || frame.closest<HTMLElement>('.desktop-window')?.hidden) return;
    try {if (new URL(frame.src, location.href).origin !== event.origin) return;} catch {return;}
    if (blocked() || !foreground()) {swipe.reset(); return;}
    const result = swipe.wheel({deltaX:value.deltaX,deltaY:value.deltaY,deltaMode:value.deltaMode,
      ctrlKey:value.ctrlKey===true,metaKey:value.metaKey===true,altKey:value.altKey===true,shiftKey:value.shiftKey===true}, performance.now());
    if (result.step) step(result.step);
  };
  window.addEventListener('wheel', wheel, {passive:false,capture:true});
  window.addEventListener('message', frameWheel);
  const unsubscribeStart = window.inkDesktopGestures?.onGestureStart?.(() => swipe.reset());
  const unsubscribe = window.inkDesktopGestures?.onSwipe(direction => {
    swipe.reset();
    step(direction === 'left' ? 1 : -1);
  });
  const reset = () => swipe.reset();
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
