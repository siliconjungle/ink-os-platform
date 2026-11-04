export type NavigationRect={x:number;y:number;width:number;height:number};
export function desktopNeighbor(items:Iterable<[string,NavigationRect]>,current:string|undefined,direction:string,viewport?:{x?:number;y?:number;width:number;height:number}):string|undefined;
