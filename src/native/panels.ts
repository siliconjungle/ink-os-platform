import{settingsPanel}from './settings';import{el,icon,button,text}from './dom';import{VirtualSurface}from './virtual';import{explorerPanel}from './explorer';import{objectPanel}from './object';import{studioPanel}from './studio';import type{DeskWindow}from '../window-model';import type{Environment,Panel}from './contracts';import{api}from '../api';
export function makePanel(win:DeskWindow,env:Environment):Panel{
 if(['explore','space','view','notes','board'].includes(win.route.app))return explorerPanel(win,env);
 if(['object','info'].includes(win.route.app))return objectPanel(win,env);
 if(win.route.app==='studio'||win.route.app==='run')return studioPanel(win,env,win.route.app==='run');
 if(win.route.app==='settings')return settingsPanel(env);
 if(win.route.app==='activity'){
  const node=el('div',{class:'native-activity'}),surface=new VirtualSurface<any>({rowHeight:62,key:h=>h.id,create:()=>{let current:any;const title=el('strong'),meta=el('small'),row=el('button',{class:'native-activity-row',onclick:async()=>{const o=env.world.get(current.objectId)||await api<any>('/objects/'+current.objectId);if(!o)return;if(o.archived){await env.world.update(o.id,{archived:false},o.revision);env.toast('Restored');}else env.open(o);}},icon('clock',15),el('span',{},title,meta)),node=el('div',{class:'virtual-cell'},row);return{node,update:h=>{current=h;text(title,h.title||'Untitled');text(meta,h.actor+' · '+h.action);}};}});node.append(surface.node);surface.set(env.world.history);const off=env.world.subscribe(e=>{if(e.type==='ready')surface.set(env.world.history);});return{node,destroy:()=>{off();surface.destroy();},suspend:v=>surface.suspend(v)};
 }
 return{node:el('div',{class:'window-empty'},'Unavailable'),destroy:()=>{}};
}
