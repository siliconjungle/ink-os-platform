import {adjacentWorkspace, WorkspaceSwipe} from '../../shared/workspace-gestures.mjs';
import type {Compositor} from './compositor';
import './workspace-gestures.css';

declare global {
  interface Window {
    inkDesktopGestures?: {onSwipe(listener:(direction:'left'|'right')=>void):()=>void};
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
  switcher.title = 'Two-finger horizontal swipe on the desktop or a window title bar · Ctrl Alt ← / →';
  const blocked = () => !!compositor.gesture || !!document.documentElement.dataset.gesture || !!document.querySelector('.modal-backdrop,.quick-look-backdrop,.window-overview,.desktop-context,.system-menu');
  const step = (direction:number) => {
    if (blocked()) {swipe.reset(); return;}
    const id = adjacentWorkspace(compositor.workspaces, compositor.workspace, direction);
    if (id === undefined) return;
    compositor.switchWorkspace(id);
    status.textContent = compositor.workspaces.find(space => space.id === id)?.name || 'Desktop';
  };
  const eligible = (target:EventTarget|null) => {
    if (!(target instanceof Element)) return false;
    if (target.closest('.workspace-switch,.window-chrome')) return true;
    return !!target.closest('.desktop-shell') && !target.closest('.desktop-window,.system-bar,.desktop-bottom,.canvas-navigation,[role=dialog],input,textarea,select,[contenteditable=true]');
  };
  const wheel = (event:WheelEvent) => {
    if (event.defaultPrevented || blocked() || !eligible(event.target)) {swipe.reset(); return;}
    const result = swipe.wheel(event, performance.now());
    if (result.consume) {event.preventDefault(); event.stopPropagation();}
    if (result.step) step(result.step);
  };
  window.addEventListener('wheel', wheel, {passive:false,capture:true});
  const unsubscribe = window.inkDesktopGestures?.onSwipe(direction => {
    swipe.reset();
    step(direction === 'left' ? 1 : -1);
  });
  const reset = () => swipe.reset();
  window.addEventListener('blur', reset);
  const dispose = () => {
    window.removeEventListener('wheel', wheel, true);
    window.removeEventListener('blur', reset);
    window.removeEventListener('pagehide', dispose);
    unsubscribe?.();
    status.remove();
  };
  window.addEventListener('pagehide', dispose, {once:true});
  return dispose;
}
