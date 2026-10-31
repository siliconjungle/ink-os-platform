import{el,text}from'./dom';
import{textWidth}from'./text-metrics';
import{cursorLabel,peerColor,PRESENCE_INK}from'../../shared/presence-colors.mjs';
import{cursorScreenPoint}from'../../shared/presence-cursor.mjs';
import type{Peer}from'../types';
interface Cursor{node:HTMLElement;label:HTMLElement;name:string;x:number;y:number}
/** Screen-space multiplayer pointers. They never capture input or inherit desktop camera zoom. */
export class PeerCursors{
 readonly entries=new Map<string,Cursor>();last?:{peers:Peer[];self:string;view:string};
 constructor(readonly host:HTMLElement,readonly nodes=new Map<string,HTMLElement>(),readonly visible:(peer:Peer)=>boolean=peer=>!peer.appId&&!peer.window){addEventListener('resize',this.refresh);addEventListener('ink-text-metrics',this.refresh);}
 refresh=()=>{if(this.last)this.update(this.last.peers,this.last.self,this.last.view);};
 update(peers:Peer[],self:string,view:string,width=innerWidth,height=innerHeight){this.last={peers,self,view};const bounds=this.host.getBoundingClientRect(),wanted=new Set<string>();for(const peer of peers){if(peer.id===self||peer.view!==view||!this.visible(peer)||!peer.cursor||![peer.cursor.x,peer.cursor.y].every(Number.isFinite))continue;const point=cursorScreenPoint(peer.cursor,{left:bounds.left,top:bounds.top,width:peer.cursor.space==='desktop'?bounds.width:width,height:peer.cursor.space==='desktop'?bounds.height:height});if(!point)continue;wanted.add(peer.id);const name=peer.name.trim()||'Guest',{x,y}=point;let cursor=this.entries.get(peer.id);if(!cursor){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');for(const[key,value]of Object.entries({viewBox:'0 0 24 30',width:'22',height:'27.5',class:'peer-pointer','aria-hidden':'true'}))svg.setAttribute(key,value);const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M2 2 7.8 26 12.8 17.4 22 14.8Z');svg.append(path);const label=el('span',{class:'peer-name'},name),node=el('div',{class:'peer-cursor','aria-hidden':true,'data-peer-id':peer.id},svg,label);cursor={node,label,name,x,y};this.entries.set(peer.id,cursor);this.nodes.set(peer.id,node);this.host.append(node);}const {node,label}=cursor;color(node,peerColor(peer));text(label,name);label.title=name;node.dataset.moving=String(Math.hypot(x-cursor.x,y-cursor.y)<360&&node.dataset.placed==='true');node.style.transform=`translate3d(${x}px,${y}px,0)`;node.dataset.placed='true';const position=cursorLabel(x,y,textWidth(name,'550 11px "Inter Variable"'),width,height);Object.assign(label.style,{left:position.x+'px',top:position.y+'px',width:position.width+'px'});node.dataset.side=position.side;Object.assign(cursor,{name,x,y});}for(const[id,cursor]of this.entries)if(!wanted.has(id)){cursor.node.remove();this.entries.delete(id);this.nodes.delete(id);}}
 destroy(){removeEventListener('resize',this.refresh);removeEventListener('ink-text-metrics',this.refresh);this.last=undefined;for(const cursor of this.entries.values())cursor.node.remove();this.entries.clear();this.nodes.clear();}
}
function color(node:HTMLElement,value:string){node.style.setProperty('--peer-color',value);node.style.setProperty('--peer-ink',PRESENCE_INK);}

export function peerAvatar(peer:Peer){const node=el('span',{title:peer.name,'aria-label':peer.name},Array.from(peer.name.trim())[0]||'?');color(node,peerColor(peer));return node;}
