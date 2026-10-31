import type{WorldObject}from'./types';
const json=(body:string)=>{try{const value=JSON.parse(body);return value&&typeof value==='object'?value:{};}catch{return{};}};
export async function collectionCopyPlan(objects:WorldObject[],sourceId:string,target?:WorldObject,namespace?:string){
 const source=objects.find(o=>o.id===sourceId);if(!source||!['space','view'].includes(source.kind))throw Error('Collection not found');const rootId=target?.id||crypto.randomUUID().replaceAll('-',''),selected=new Set([sourceId]),folders=new Set(source.kind==='space'?[sourceId]:[]),config=json(source.body),projection=config.projection||config;
 if(source.kind==='view'){for(const id of projection.objectIds||[])selected.add(id);if(projection.space)folders.add(projection.space);}
 let changed=true;while(changed){changed=false;for(const object of objects){if(object.kind==='app'||selected.has(object.id))continue;if(object.spaces.some(id=>folders.has(id))){selected.add(object.id);if(object.kind==='space')folders.add(object.id);changed=true;}}}
 const originals=objects.filter(o=>selected.has(o.id)&&o.kind!=='app'),ids=new Map<string,string>([[sourceId,rootId]]);
 for(const object of originals){if(object.id===sourceId)continue;const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(rootId+'\0copy\0'+object.id));ids.set(object.id,[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,32));}
 const remap=(value:string)=>value.replace(/(?<![a-f0-9])[a-f0-9]{32}(?![a-f0-9])/g,id=>ids.get(id)||id),rootBody={...JSON.parse(remap(JSON.stringify(json(target?.body||source.body)))),duplicateOf:sourceId,duplicateVersion:1,duplicateMembers:Object.fromEntries([...ids].filter(([old])=>old!==sourceId))};
 const copy=(object:WorldObject)=>({id:ids.get(object.id)!,namespace:namespace||target?.namespace||source.namespace,kind:object.kind,title:object.id===sourceId?(target?.title||source.title+' copy'):object.title,body:object.id===sourceId?JSON.stringify(rootBody):remap(object.body),summary:object.summary,tags:[...object.tags],spaces:object.id===sourceId?[...source.spaces]:object.spaces.filter(id=>ids.has(id)).map(id=>ids.get(id)!),status:object.status,cover:object.cover,source:remap(object.source),location:object.location,starred:object.starred});
 return{root:copy(source),members:originals.filter(o=>o.id!==sourceId).map(copy)};
}
