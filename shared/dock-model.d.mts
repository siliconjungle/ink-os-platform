import type{WorldObject}from'../src/types';
import type{DeskWindow}from'../src/window-model';
export interface DockEntry{key:string;app:WorldObject;pinned:boolean;window?:DeskWindow}
export function dockEntries(objects:WorldObject[],windows:DeskWindow[],workspace:number,pins?:string[]):DockEntry[];
export function orderDockEntries(entries:DockEntry[],order?:string[]):DockEntry[];

export function personalDockEntries(objects:WorldObject[],windows:DeskWindow[],workspace:number,pins:string[],order?:string[]):DockEntry[];
