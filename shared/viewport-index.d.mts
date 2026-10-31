export interface SpatialItem<T=unknown>{key:string;x:number;y:number;width:number;height:number;value?:T}
export class ViewportIndex<T=unknown>{constructor(items?:SpatialItem<T>[]);set(items:SpatialItem<T>[]):void;upsert(item:SpatialItem<T>):void;remove(key:string):void;query(view:{x:number;y:number;width:number;height:number},overscan?:number):SpatialItem<T>[];lastCandidates:number}
