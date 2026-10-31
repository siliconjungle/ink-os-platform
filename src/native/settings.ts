import{textHeight}from './text-metrics';import {el,icon} from './dom';
import type {Environment,Panel} from './contracts';
export function settingsPanel(env:Environment):Panel{
 const node=el('div',{class:'native-settings'}),heading=el('header',{class:'settings-heading'},el('h1',{},'Settings'));
 const group=(label:string,...rows:HTMLElement[])=>el('section',{class:'settings-group'},el('h2',{},label),el('div',{class:'settings-group-body'},...rows));
 const row=(title:string,description:string,glyph:string,run:()=>void)=>el('button',{class:'settings-action',onclick:run},el('span',{class:'settings-glyph'},icon(glyph,17)),el('span',{class:'settings-copy'},el('strong',{},title),el('small',{},description)),icon('arrow',14));
 const reduce=el('input',{type:'checkbox',role:'switch','aria-label':'Reduce transparency',checked:env.getTransparency()}),display=el('label',{class:'settings-action settings-toggle'},el('span',{class:'settings-glyph'},icon('layers',17)),el('span',{class:'settings-copy'},el('strong',{},'Reduce transparency'),el('small',{},'Use solid surfaces for menus and windows.')),reduce);
 reduce.addEventListener('change',()=>env.transparency(reduce.checked));
 node.append(heading,group('Display',display),group('Workspace',row('Environment variables','Private variables for this app.','code',()=>env.environment?.()),row('Sessions','Devices and people in this workspace.','layers',env.sessions)));
 const observer=new ResizeObserver(entries=>{const width=entries[0].contentRect.width-100;for(const copy of node.querySelectorAll<HTMLElement>('.settings-copy')){const description=copy.querySelector('small')!;copy.parentElement!.style.minHeight=Math.max(72,46+textHeight(description.textContent||'',width,16,'400 10px "Inter Variable"'))+'px';}});observer.observe(node);
 return{node,destroy:()=>observer.disconnect(),context:()=>{reduce.checked=env.getTransparency();}};
}
