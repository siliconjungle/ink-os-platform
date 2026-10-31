import type{WorldObject,Route}from'../src/types';import type{DeskWindow}from'../src/window-model';
export function appManifest(object?:WorldObject):any;
export function desktopManifest(input?:any):any;
export function installedApps(objects:WorldObject[]):WorldObject[];
export function windowApplication(objects:WorldObject[],window:Pick<DeskWindow,'appId'|'route'>):WorldObject|undefined;
export function appLaunch(app:WorldObject):{appId:string;route:Route};
export function isAppRegistration(object?:WorldObject|null):object is WorldObject&{kind:'app';namespace:'os'};
