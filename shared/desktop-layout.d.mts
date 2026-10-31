import type{Placements}from './desktop-placements.mjs';
import type {DeskWindow} from '../src/window-model';import type {Workspace} from '../src/workspace-model';
export type Layout={windows:DeskWindow[];workspaces:Workspace[];icons:Record<string,{x:number;y:number}>;placements?:Placements;dockOrder?:Record<string,string[]>;pins?:Record<string,string[]>};
export function sameWindow(a:DeskWindow,b:DeskWindow):boolean;
export function emptyLayout():Layout;
export function desktopWrites(before:Layout,after:Layout,state:any,options?:{workspaceMoves?:number[];personalWindows?:boolean}):any[];
export function projectDesktop(state:any):Layout;
export function workspaceIdentity():number;
export function comparePositions(a:number[],b:number[]):number;
export function betweenPositions(left?:number[],right?:number[],id?:number):number[];

export const RECOVERY_WORKSPACE:number;
