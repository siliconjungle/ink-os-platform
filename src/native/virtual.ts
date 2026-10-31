import {VirtualList,type Cell,type ListOptions} from '../../shared/virtual.mjs';
export type {Cell};
export class VirtualSurface<T> extends VirtualList<T>{
 constructor(options:ListOptions<T>){super(options);this.node.classList.add('virtual-scroll');this.node.tabIndex=0;this.canvas.classList.add('virtual-canvas');}
 get live(){return this.cells;}
}
