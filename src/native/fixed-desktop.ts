import './fixed-desktop.css';import type{Compositor}from './compositor';import type{DesktopItems}from './desktop-items';
/** The view uses bounded CSS pixels; saved icon centres are proportional to its size. */
export class FixedDesktop{
 constructor(readonly shell:HTMLElement,readonly compositor:Compositor,readonly items:DesktopItems){shell.classList.add('fixed-desktop');items.viewport=()=>({width:shell.clientWidth,height:shell.clientHeight});const observer=new ResizeObserver(()=>this.refresh());observer.observe(shell);observer.observe(compositor.stage);this.refresh();}
 worldPoint(x:number,y:number){const r=this.shell.getBoundingClientRect();return{x:x-r.left,y:y-r.top};}
 refresh(){const c=this.compositor;c.area={width:c.stage.clientWidth,height:c.stage.clientHeight};for(const scene of c.scenes.values())c.paint(scene);c.visibility(false);this.items.layoutDirty=true;this.items.paint();}
}
