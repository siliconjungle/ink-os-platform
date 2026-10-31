export type AppIcon=string|{svg:string};
export function appIcon(input?:unknown):AppIcon;
export function desktopOverrides(input?:unknown):{icon?:AppIcon;dock?:number|false;shortcut?:boolean};
