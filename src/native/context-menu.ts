import './context-menu.css';import{el}from './dom';import type{MenuItem}from '../../shared/app-context-menu.mjs';
export function contextMenuNode(x:number,y:number,items:MenuItem[]){
 const node=el('div',{class:'desktop-context ink-context-menu',role:'menu',style:{left:Math.max(8,Math.min(x,innerWidth-208))+'px',top:Math.max(8,Math.min(y,innerHeight-Math.min(items.length*34,innerHeight-32)-15))+'px'}});
 for(const[label,run,disabled]of items)node.append(el('button',{role:'menuitem',disabled:!!disabled,onclick:()=>{node.remove();run();}},label));
 node.addEventListener('contextmenu',event=>event.preventDefault());
 node.addEventListener('keydown',event=>{const buttons=[...node.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')],index=buttons.indexOf(document.activeElement as HTMLButtonElement);if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();buttons[(index+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();}if(event.key==='Escape'){event.preventDefault();event.stopPropagation();node.remove();}});
 document.body.append(node);node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
 // Wraps/translated labels can exceed the estimated menu dimensions.
 const rect=node.getBoundingClientRect();if(rect.right>innerWidth-8)node.style.left=Math.max(8,innerWidth-rect.width-8)+'px';if(rect.bottom>innerHeight-8)node.style.top=Math.max(8,innerHeight-rect.height-8)+'px';return node;
}
