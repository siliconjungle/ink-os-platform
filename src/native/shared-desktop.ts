import{DesktopSync}from '../../shared/desktop-sync.mjs';
import{documents}from './documents';import type{Compositor}from './compositor';
export class SharedDesktop extends DesktopSync{constructor(compositor:Compositor,dock?:{get:()=>Record<string,string[]>;set:(value:Record<string,string[]>)=>void}){super(compositor,dock,documents());}}
