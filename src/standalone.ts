import './native/command-system.mjs';
import{installInteropHost}from './native/interop-host';
import{appContentActions}from '../shared/app-context-menu.mjs';
import{contextMenuNode}from './native/context-menu';
import './theme.css';
import './native.css';
import './standalone.css';
import{appPath,parseAppLink}from '../shared/app-links.mjs';
import{appLaunch,isAppRegistration,appManifest,installedApps}from '../shared/app-desktop.mjs';
import{desktopFile}from '../shared/desktop-placements.mjs';
import{preferredFileApp}from '../shared/file-apps.mjs';
import{StateReplica}from '../shared/state-replica.mjs';
import{projectDesktop}from '../shared/desktop-layout.mjs';
import{World}from './native/world';
import{framePanel}from './native/frame';
import{documents}from './native/documents';
import{el}from './native/dom';
import{api}from './api';
import type{Environment,Panel}from './native/contracts';
import type{DeskWindow}from './window-model';
import type{WorldObject,Route}from './types';

const root=document.getElementById('root')!;root.className='standalone-root';
const host=el('main',{class:'standalone-host','aria-label':'Ink app'});root.replaceChildren(host);
let menu:HTMLElement|undefined;
addEventListener('pointerdown',event=>{if(!(event.target as Element)?.closest?.('.desktop-context'))menu?.remove();});
let panel:Panel|undefined,win:DeskWindow|undefined,toastNode:HTMLElement|undefined,toastTimer=0;
const toast=(message:string)=>{toastNode?.remove();clearTimeout(toastTimer);toastNode=el('div',{class:'standalone-toast',role:'status'},message);root.append(toastNode);toastTimer=window.setTimeout(()=>toastNode?.remove(),5000);};
const message=(title:string,detail:string)=>{panel?.destroy();panel=undefined;host.replaceChildren(el('div',{class:'standalone-message'},el('h1',{},title),el('p',{},detail),el('a',{class:'button',href:'/'},'Open Ink desktop'),el('button',{class:'button',onclick:()=>location.reload()},'Try again')));};
const initial=parseAppLink(location.href);
if(!initial)message('App link unavailable','Check that you have a complete Ink app link.');
else void start(initial);

async function start(initial:{appId:string;objectId?:string}){
 host.replaceChildren(el('div',{class:'standalone-message',role:'status'},'Opening app…'));
 const world=new World();
 const env:Environment={world,contextMenu:context=>{menu?.remove();menu=undefined;const items=appContentActions(context);if(items.length)menu=contextMenuNode(context.x,context.y,items);},isActive:()=>true,toast,
  open:object=>void openObject(object),
  launch:(route,options)=>{const app=world.get(options?.appId)||installedApps(world.list()).find(app=>appManifest(app).desktop.entry===route.app);if(app)void show(app.id,route.id);else toast('App unavailable');},
  changeRoute:(_key,route)=>{if(!win)return;const objectId=route.id;history.replaceState(null,'',appPath(win.appId!,objectId));win={...win,route};panel?.context?.(win);},
  close:()=>{panel?.destroy();panel=undefined;host.replaceChildren(el('div',{class:'standalone-message'},el('h1',{},'App closed'),el('button',{class:'button',onclick:()=>void navigate()},'Reopen app'),el('a',{class:'button',href:'/'},'Open Ink desktop')));},
  create:(kind,space,status)=>panel?.command?.({type:'create',kind,space,status}),
  saveView:()=>toast('Open the Ink desktop to save an app.'),
  sessions:()=>void import('./native/dialogs').then(m=>m.sessionsDialog()),
  keys:()=>void import('./native/api-keys').then(m=>m.apiKeysDialog()),
  environment:id=>{const app=world.get(id||win?.appId);if(app)void import('./native/environment').then(m=>m.environmentDialog(app));},
  appearance:()=>{document.documentElement.dataset.theme='dark';if(win)panel?.context?.(win);},getAppearance:()=> 'dark',
  transparency:reduce=>{document.documentElement.dataset.reduceTransparency=String(reduce);if(win)panel?.context?.(win);},getTransparency:()=>document.documentElement.dataset.reduceTransparency==='true',
  place:(object,point)=>void place(object,point).catch(error=>toast(error.message))
 };
 async function place(object:WorldObject,point?:{x:number;y:number}){
  // Open the layout only for an explicit placement; never restore desktop windows.
  const replica=new StateReplica({host:documents(),key:'desktop',onError:(error:Error)=>toast(error.message)});
  try{await replica.open();const layout=projectDesktop(replica.state),space=layout.workspaces[0]?.id;if(space===undefined)throw Error('Create a desktop in Ink first.');const entries=layout.placements?.[space]||{},position=point||entries[object.id]||{x:40+(Object.keys(entries).length%8)*100,y:40+Math.floor(Object.keys(entries).length/8)*110};await replica.commit([{path:'/placements/'+space+'/'+object.id,value:position}]);toast('Added to desktop');}finally{await replica.close();}
 }
 async function openObject(object:WorldObject){
  if(isAppRegistration(object)){await show(object.id);return;}
  if(desktopFile(object)){let defaults={};try{defaults=(await api('/v1/file-defaults')).defaults||{};}catch{}const app=preferredFileApp(world.list(),object,defaults);if(app){await show(app.id,object.id);return;}}
  toast('No app is available to open this item.');
 }
 async function show(appId:string,objectId?:string,push=true){
  try{
   const app=world.get(appId);if(!isAppRegistration(app))throw Error('This app has been removed or is unavailable to your account.');
   const launch=appLaunch(app),route:Route=objectId?{...launch.route,id:objectId}:launch.route;
   if(objectId&&!world.get(objectId))throw Error('This file has been removed or is unavailable to your account.');
   panel?.destroy();panel=undefined;win={key:'standalone-'+crypto.randomUUID(),appId,route,x:0,y:0,width:innerWidth,height:innerHeight,workspace:0,z:1,minimized:false,maximized:true};
   release=appManifest(app).releaseId;document.title=app.title+' · Ink';host.setAttribute('aria-label',app.title);if(push)history.pushState(null,'',appPath(appId,objectId));
   panel=framePanel(win,env);host.replaceChildren(panel.node);
  }catch(error){message('App unavailable',(error as Error).message);}
 }
 async function navigate(){const target=parseAppLink(location.href);if(target)await show(target.appId,target.objectId,false);else message('App link unavailable','Check your app link.');}
 installInteropHost({world,frames:()=>win&&panel?[{key:win.key,appId:win.appId,frame:panel.node.querySelector('iframe')}]:[],open:async appId=>{await show(appId);return win?.key;},toast});
 let mounted=false;
 let release:string|undefined;
 const unsubscribe=world.subscribe(event=>{
  if(event.type==='ready'&&!mounted){mounted=true;void navigate();}
  if(event.type==='status'&&!world.loaded&&world.error)message('Could not connect',world.error);
  if(event.type==='objects'&&win&&event.ids.has(win.appId!)){
   const app=world.get(win.appId);if(!app)message('App unavailable','This app has been removed.');
   else if(appManifest(app).releaseId!==release){release=appManifest(app).releaseId;void navigate();}
  }
 });
 // World emits ready after the initial snapshot; update watching thereafter.
 world.subscribe(event=>{if(event.type==='ready'&&win)release=appManifest(world.get(win.appId)).releaseId;});
 addEventListener('popstate',()=>void navigate());
 addEventListener('visibilitychange',()=>panel?.suspend?.(document.hidden));
 addEventListener('pagehide',()=>{panel?.suspend?.(true);});
 addEventListener('pageshow',()=>{panel?.suspend?.(false);});
 addEventListener('beforeunload',()=>{unsubscribe();panel?.destroy();world.destroy();});
}
