import{appIcon}from './app-icons.mjs';
const entry=value=>typeof value==='string'&&/^[a-z][a-z0-9.-]{0,63}$/.test(value);
export const appManifest=object=>{try{const value=JSON.parse(object?.body||'{}');return value.desktop&&value.desktopOverrides?{...value,desktop:{...value.desktop,...value.desktopOverrides}}:value;}catch{return{};}};
const dimensions=value=>{if(!value||!Number.isFinite(value.width)||!Number.isFinite(value.height)||value.width<200||value.height<150||value.width>8192||value.height>8192)throw Error('Invalid app window dimensions');return{width:value.width,height:value.height};};
export function desktopManifest(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input)||!entry(input.entry||'app'))throw Error('App desktop entry must be a route identifier');
 const result={entry:input.entry||'app',icon:appIcon(input.icon??'layers')};if(input.inspect!==undefined){if(!entry(input.inspect))throw Error('Invalid app inspection route');result.inspect=input.inspect;}
 if(input.collaborative!==undefined){if(typeof input.collaborative!=='boolean')throw Error('App collaboration must be true or false');result.collaborative=input.collaborative;}
 if(input.context!==undefined){if(input.context!=='self')throw Error('App context must be self');result.context='self';}
 if(input.dock!==undefined){if(input.dock!==false&&(!Number.isFinite(input.dock)||Math.abs(input.dock)>100000))throw Error('App dock order must be a number or false');result.dock=input.dock;}

 if(input.shortcut!==undefined){if(typeof input.shortcut!=='boolean')throw Error('Desktop shortcut must be true or false');result.shortcut=input.shortcut;}
 if(input.fileTypes!==undefined){if(!Array.isArray(input.fileTypes)||input.fileTypes.length>64||input.fileTypes.some(type=>typeof type!=='string'||! /^(\*|[a-z][a-z0-9-]{0,63}|\.[a-z0-9][a-z0-9.+_-]{0,20}|[a-z0-9.+-]+\/(?:[a-z0-9.+-]+|\*))$/.test(type)))throw Error('App file types must be kinds, MIME types, extensions or *');result.fileTypes=[...new Set(input.fileTypes)];}
 if(input.dropTypes!==undefined){if(!Array.isArray(input.dropTypes)||input.dropTypes.length>64||input.dropTypes.some(type=>typeof type!=='string'||! /^(\*|[a-z][a-z0-9-]{0,63}|\.[a-z0-9][a-z0-9.+_-]{0,20}|[a-z0-9.+-]+\/(?:[a-z0-9.+-]+|\*))$/.test(type)))throw Error('App file types must be kinds, MIME types, extensions or *');result.dropTypes=[...new Set(input.dropTypes)];}
 if(input.window!==undefined)result.window=dimensions(input.window);
 return result;
}
export const isAppRegistration=object=>!!object&&object.kind==='app'&&object.namespace==='os'&&!object.archived;
export const installedApps=objects=>objects.filter(object=>isAppRegistration(object)&&appManifest(object).desktop);
export function windowApplication(objects,window){if(window.appId)return objects.find(object=>object.id===window.appId&&isAppRegistration(object));const target=objects.find(object=>object.id===window.route.id&&isAppRegistration(object));if(target)return target;return installedApps(objects).find(object=>appManifest(object).desktop.entry===window.route.app);}
export function appLaunch(app){if(!isAppRegistration(app))throw Error('An installed app registration is required');const desktop=appManifest(app).desktop;if(!desktop)throw Error('This app has no desktop entry');return{appId:app.id,route:{app:desktop.entry,...(desktop.context==='self'?{id:app.id}:{})}};}
