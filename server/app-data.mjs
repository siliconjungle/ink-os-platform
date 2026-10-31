import{hash}from'./world.mjs';
export const stateObjectId=(namespace,key)=>hash(namespace+'\0state\0'+key).slice(0,32);
export function appDataSnapshot(world,namespace){return world.all().filter(o=>o.namespace===namespace&&o.kind!=='collaboration'&&!(o.kind==='file'&&o.tags.includes('app-source')&&(()=>{try{return JSON.parse(o.body).mime==='application/vnd.ink-os.bundle+json';}catch{return false;}})()));}
export function forkData(snapshot,source,target){
 const ids=new Map([[source,target],...snapshot.map(o=>[o.id,o.kind==='state'?stateObjectId(target,o.title):hash(target+'\0fork\0'+o.id).slice(0,32)])]);
 const remap=value=>{if(typeof value==='string')return value.replace(/(?<![a-f0-9])[a-f0-9]{32}(?![a-f0-9])/g,id=>ids.get(id)||id);if(Array.isArray(value))return value.map(remap);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[ids.get(key)||key,remap(item)]));return value;};
 return{ids,remap,objects:snapshot.map(object=>({...object,id:ids.get(object.id),namespace:target,body:remap(object.body),spaces:object.spaces.map(id=>ids.get(id)||id),source:remap(object.source),location:remap(object.location),revision:1}))};
}
