import{desktopFile}from'./desktop-placements.mjs';
import{appManifest,installedApps}from'./app-desktop.mjs';
import{fileInfo,acceptsFile}from './file-types.mjs';
export function fileType(file){if(!desktopFile(file))return file.kind;const info=fileInfo(file);return info.extension||info.mime||file.kind;}
export function fileActionTypes(app,action='open'){const desktop=appManifest(app).desktop;return(action==='preview'?desktop?.preview?.fileTypes:desktop?.fileTypes)||[];}
export function fileApps(objects,file,action='open'){
 if(!file||file.archived)return[];
 const{extension,mime}=fileInfo(file);
 const score=app=>{const types=fileActionTypes(app,action);let value=0;for(const type of types){if(type==='*')value=Math.max(value,1);else if(type===extension)value=Math.max(value,400);else if(type===mime)value=Math.max(value,300);else if(type.endsWith('/*')&&(mime.startsWith(type.slice(0,-1))||file.kind===type.slice(0,-2)))value=Math.max(value,200);else if(type===file.kind)value=Math.max(value,100);}return value&&file.namespace===app.id?value+500:value;};
 return installedApps(objects).map(app=>({app,score:score(app)})).filter(entry=>entry.score>0).sort((a,b)=>b.score-a.score||a.app.title.localeCompare(b.app.title)||a.app.id.localeCompare(b.app.id)).map(entry=>entry.app);
}
export function fileLaunch(app,file,action='open'){return{appId:app.id,route:{app:appManifest(app).desktop.entry,id:file.id,...(action==='preview'?{mode:'preview'}:{})}};}
/** Read legacy saved views once; every live file window belongs to an ordinary app. */
export function applicationWindow(objects,window){return !window.appId&&window.route.app==='os-file'?undefined:window;}

export function firstFileApp(objects,file,action='open'){const apps=fileApps(objects,file,action),specific=apps.filter(app=>acceptsFile(fileActionTypes(app,action).filter(type=>type!=='*'),file));const owned=action==='preview'?apps.filter(app=>app.id===file.namespace):[];return(owned.length?owned:specific.length?specific:apps).sort((a,b)=>(appManifest(a).installedAt||a.created||0)-(appManifest(b).installedAt||b.created||0)||a.id.localeCompare(b.id))[0];}
export function preferredFileApp(objects,file,defaults={},action='open'){const apps=fileApps(objects,file,action),{extension,mime}=fileInfo(file),keys=action==='preview'&&!desktopFile(file)?[file.kind]:[extension,mime,mime.includes('/')?mime.split('/')[0]+'/*':'',file.kind];for(const key of keys){const app=apps.find(app=>app.id===defaults[key]);if(app)return app;}return firstFileApp(objects,file,action);}

export function previewableObject(object){return !!object&&!object.archived&&object.kind!=='app'&&!object.tags?.includes('app-source')&&(desktopFile(object)||object.namespace&&object.namespace!=='os');}
