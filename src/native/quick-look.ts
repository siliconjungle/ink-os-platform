import { api } from '../api';
import type { WorldObject } from '../types';
import type { DeskWindow } from '../window-model';
import { fileApps, fileLaunch, preferredFileApp, previewableObject } from '../../shared/file-apps.mjs';
import { isAppRegistration, appManifest } from '../../shared/app-desktop.mjs';
import { desktopFile } from '../../shared/desktop-placements.mjs';
import type { Desktop } from './desktop';
import type { Panel } from './contracts';
import { framePanel } from './frame';
import { el, button, text } from './dom';
import { openWithDialog } from './files';
import './quick-look.css';

/** A local, temporary view. Never enters the compositor, dock or shared layout. */
export class QuickLook {
 private overlay?: HTMLElement;
 private panel?: Panel;
 private ids: string[] = [];
 private index = 0;
 private followsDesktop = false;
 private generation = 0;
 private restoreFocus?: HTMLElement;
 private stopWorld?: () => void;
 private key = (event: KeyboardEvent) => {
  if (document.querySelector('.modal-backdrop')) return;
  if (!this.overlay || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement;
  if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); this.close(); return; }
  if (target.closest('input,textarea,select,[contenteditable]:not([contenteditable=false])')) return;
  if (event.key === ' ' && !target.closest('button,a[href],[role=button],summary')) {
   event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) this.close();
  } else if (/^Arrow(Left|Right|Up|Down)$/.test(event.key)) {
   event.preventDefault(); event.stopImmediatePropagation(); void this.direction(event.key,event.shiftKey);
  }
 };
 constructor(private desktop: Desktop) {}
 get active() { return !!this.overlay; }
 async show(ids: string[], items: string[] = ids, followsDesktop = false) {
  if (this.active) { this.close(); return; }
  this.followsDesktop=followsDesktop;
  const valid = (id: string) => previewableObject(this.desktop.world.get(id))||this.followsDesktop&&isAppRegistration(this.desktop.world.get(id));
  const selected = [...new Set(ids)].filter(valid);
  if (!selected.length) return;
  this.restoreFocus = document.activeElement as HTMLElement;
  this.ids = [...new Set(selected.length > 1 ? selected : [...items, ...selected])].filter(valid);
  const focused=this.restoreFocus?.closest<HTMLElement>('[data-object-id]')?.dataset.objectId;
  this.index = Math.max(0, this.ids.indexOf(this.followsDesktop&&focused&&selected.includes(focused)?focused:selected[0]));
  this.overlay = el('div', { class: 'quick-look-backdrop' });
  this.overlay.addEventListener('pointerdown', event => { if (event.target === this.overlay) this.close(); });
  document.body.append(this.overlay);
  this.desktop.shell.inert = true;
  addEventListener('keydown', this.key, true);
  this.stopWorld = this.desktop.world.subscribe(event => {
   if (event.type !== 'objects') return;
   const id = this.ids[this.index];
   if (!valid(id)) {
    this.ids = this.ids.filter(valid); this.index = Math.min(this.index, this.ids.length - 1);
    if (this.ids.length) void this.paint(); else this.close();
   }
  });
  await this.paint();
 }
 async direction(direction:string,extend=false){
  if(!this.active)return;
  if(!this.followsDesktop){await this.move(['ArrowLeft','ArrowUp'].includes(direction)?-1:1);return;}
  const id=this.desktop.items.navigate(direction,extend,false,this.ids[this.index]);if(!id||id===this.ids[this.index])return;
  this.ids=[...this.desktop.items.rects.keys()].filter(id=>!this.desktop.items.byId.get(id)?.uploading);this.index=this.ids.indexOf(id);
  this.restoreFocus=this.desktop.items.nodes.get(id);await this.paint();
 }
 async move(delta: number) {
  if (!this.active || !this.ids.length) return;
  if(this.followsDesktop){await this.direction(delta<0?'ArrowLeft':'ArrowRight');return;}
  const index=Math.max(0,Math.min(this.index+delta,this.ids.length-1));if(index===this.index)return;this.index=index;
  await this.paint();
 }
 async command(command: string,extend=false) {
  if(/^preview\.Arrow(Left|Right|Up|Down)$/.test(command)){await this.direction(command.slice(8),extend);return;}
  if (command === 'preview.dismiss' || command === 'escape') this.close();
  if (command === 'preview.previous') await this.move(-1);
  if (command === 'preview.next') await this.move(1);
 }
 close() {
  ++this.generation;
  this.panel?.destroy(); this.panel = undefined;
  this.stopWorld?.(); this.stopWorld = undefined;
  this.overlay?.remove(); this.overlay = undefined;
  removeEventListener('keydown', this.key, true);
  this.desktop.shell.inert = false;
  dispatchEvent(new Event('ink-preview-closed'));
  if (this.restoreFocus?.isConnected) this.restoreFocus.focus({ preventScroll: true });
 }
 private async paint() {
  const generation = ++this.generation, overlay = this.overlay;
  if (!overlay) return;
  this.panel?.destroy(); this.panel = undefined;
  const file = this.desktop.world.get(this.ids[this.index]);
  if (!file) { this.close(); return; }
  const title = el('h2', {}, file.title || 'Untitled'), provider = el('button', { class: 'text-button', disabled: true }, 'Preview with…');
  const content = el('div', { class: 'quick-look-content', role: 'status' }, 'Loading preview…');
  const previous = button('Previous item', 'chevron-left', () => void this.move(-1));
  const next = button('Next item', 'chevron-right', () => void this.move(1));
  previous.disabled=this.followsDesktop?this.desktop.items.neighbor('ArrowLeft',file.id)===file.id:this.index===0;
  next.disabled=this.followsDesktop?this.desktop.items.neighbor('ArrowRight',file.id)===file.id:this.index===this.ids.length-1;
  const sheet = el('section', { class: 'quick-look', role: 'dialog', 'aria-modal': true, 'aria-label': 'Quick preview', tabIndex: -1 },
   el('header', { class: 'quick-look-header' }, title, previous, el('span', {}, `${this.index + 1} / ${this.ids.length}`), next, provider,
    el('button', { class: 'button', onclick: () => { this.close(); this.desktop.open(file); } }, 'Open'), button('Close preview', 'close', () => this.close())), content);
  overlay.replaceChildren(sheet); sheet.focus({ preventScroll: true });
  if(isAppRegistration(file)){content.replaceChildren(el('div',{class:'quick-look-metadata'},el('h3',{},file.title),el('p',{},'Application'),el('p',{},file.summary||'Open this app to use it.')));provider.hidden=true;return;}
  try {
   const result = await api<{ defaults: Record<string, string> }>('/v1/preview-defaults/reconcile', { method: 'POST', body: '{}' });
   if (generation !== this.generation || !overlay.isConnected) return;
   const apps = fileApps(this.desktop.world.list(), file, 'preview').filter(app => { const meta = appManifest(app); return meta.releaseId || meta.url; });
   const mount = (app: WorldObject) => {
    if (generation !== this.generation || !overlay.isConnected) return;
    this.panel?.destroy();
    const target = fileLaunch(app, file, 'preview');
    const win: DeskWindow = { ...target, key: 'quick-preview-' + generation, workspace: this.desktop.compositor.workspace, x: 0, y: 0, width: 900, height: 650, z: 0, minimized: false, maximized: false };
    const env = { ...this.desktop.env, isActive: () => true, close: () => this.close(), changeRoute: () => {}, open: (object: WorldObject) => { this.close(); this.desktop.open(object); } };
    this.panel = framePanel(win, env); content.removeAttribute('role'); content.replaceChildren(this.panel.node);
    text(provider, app.title + ' ▾');
   };
   const app = preferredFileApp(apps, file, result.defaults, 'preview');
   if (app) mount(app);
   else content.replaceChildren(el('div', { class: 'quick-look-metadata' }, el('strong', {}, file.title), el('p', {}, file.kind), el('p', {}, file.summary || 'No preview provider is installed for this item.')));
   provider.disabled = !apps.length;
   provider.onclick = () => {
    const chooser = openWithDialog(file, apps, async (selected, remember) => {
     if (remember) await api('/v1/preview-defaults', { method: 'PUT', body: JSON.stringify({ fileId: file.id, appId: selected.id }) });
     mount(selected);
    }, false, app?.id, undefined, 'preview');
    chooser.node.addEventListener('closed', () => { if (overlay.isConnected) sheet.focus(); });
   };
  } catch (error) {
   if (generation === this.generation && overlay.isConnected) content.replaceChildren(el('p', { role: 'alert' }, (error as Error).message));
  }
 }
}
