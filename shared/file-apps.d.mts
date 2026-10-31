import type{WorldObject}from'../src/types';import type{DeskWindow}from'../src/window-model';
export function fileType(file:WorldObject):string;
export function fileApps(objects:WorldObject[],file:WorldObject):WorldObject[];
export function fileLaunch(app:WorldObject,file:WorldObject):{appId:string;route:{app:string;id:string}};
export function applicationWindow(objects:WorldObject[],window:DeskWindow):DeskWindow|undefined;
export function preferredFileApp(objects:WorldObject[],file:WorldObject,defaults?:Record<string,string>):WorldObject|undefined;
export function firstFileApp(objects:WorldObject[],file:WorldObject):WorldObject|undefined;
