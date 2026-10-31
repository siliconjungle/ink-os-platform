import{appManifest,installedApps,windowApplication}from'./app-desktop.mjs';

/** Each running window owns an entry; an idle pin is a launcher for its app. */
export function dockEntries(objects,windows,workspace,pins){
 const running=new Map();
 for(const window of windows){
  if(window.workspace!==workspace)continue;
  const app=windowApplication(objects,window);if(!app)continue;
  const list=running.get(app.id)||[];list.push(window);running.set(app.id,list);
 }
 const apps=installedApps(objects),pinned=pins?pins.map(id=>apps.find(app=>app.id===id)).filter(Boolean):apps.filter(app=>Number.isFinite(appManifest(app).desktop.dock)).sort((a,b)=>appManifest(a).desktop.dock-appManifest(b).desktop.dock||a.id.localeCompare(b.id)),ids=new Set(pinned.map(app=>app.id));
 const transient=[...running.keys()].filter(id=>!ids.has(id)).map(id=>apps.find(app=>app.id===id)).filter(Boolean);
 return[...pinned,...transient].flatMap(app=>{const opened=running.get(app.id)||[];return opened.length?opened.map(window=>({key:'window:'+app.id+':'+window.key,app,pinned:ids.has(app.id),window})):[{key:'app:'+app.id,app,pinned:true,window:undefined}];});
}

/** Keep a pin's position when it changes between a launcher and running windows. */
export function orderDockEntries(entries,order=[]){
 order=Array.isArray(order)?order.filter(key=>typeof key==='string'):[];
 const rank=entry=>{let index=order.indexOf(entry.key);if(index<0)index=entry.window?order.indexOf('app:'+entry.app.id):order.findIndex(key=>key.startsWith('window:'+entry.app.id+':'));return index<0?Infinity:index;};
 return entries.map((entry,index)=>({entry,index,rank:rank(entry)})).sort((a,b)=>a.rank-b.rank||a.index-b.index).map(item=>item.entry);
}

export function personalDockEntries(objects,windows,workspace,pins,order=[]){const entries=dockEntries(objects,windows,workspace,pins);return[...pins.flatMap(id=>orderDockEntries(entries.filter(entry=>entry.pinned&&entry.app.id===id),order)),...orderDockEntries(entries.filter(entry=>!entry.pinned),order)];}
