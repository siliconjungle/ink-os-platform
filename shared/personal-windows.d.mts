import type{DeskWindow}from'../src/window-model';
export function personalWindows(storage:Storage,legacy?:any):{windows:DeskWindow[];workspace?:number};
export function savePersonalWindows(storage:Storage,windows:DeskWindow[],workspace:number):void;
