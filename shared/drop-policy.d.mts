export function acceptsDropPreview(types:string[],files:any[]):boolean;
export function dropDestination(window:{key:string;name:string;node?:HTMLElement}|undefined,accepted:boolean,desktop?:string):{kind:'desktop'|'window'|'reject';key?:string;name:string;node?:HTMLElement;reason?:string};

export function windowAtPoint(windows:{key:string;hidden?:boolean;z:number;rect:{x:number;y:number;width:number;height:number}}[],x:number,y:number):string|undefined;
