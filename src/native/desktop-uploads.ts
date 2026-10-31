import {freeIconPosition,iconRect,intersects,type Point} from '../desktop-model.ts';
import type {Area} from '../window-model';
import type {WorldObject} from '../types';
export type DesktopUploadItem=WorldObject&{uploading?:boolean};
interface PendingUpload{file:File;object:DesktopUploadItem;point:Point;workspace:number}
interface UploadHost{
 area:()=>Area;
 positions:(workspace:number)=>Record<string,Point>;
 changed:()=>void;
 upload:(file:File)=>Promise<{objects:WorldObject[]}>;
 complete:(object:WorldObject,point:Point,workspace:number)=>void;
}
/** File bytes and upload UI stay local; only completed files enter the shared DB/layout. */
export class DesktopUploads{
 readonly pending=new Map<string,PendingUpload>();
 readonly host:UploadHost;
 constructor(host:UploadHost){this.host=host;}
 objects(workspace:number){return [...this.pending.values()].filter(item=>item.workspace===workspace).map(item=>item.object);}
 positions(workspace:number){return Object.fromEntries([...this.pending].filter(([,item])=>item.workspace===workspace).map(([id,item])=>[id,item.point]));}
 async import(files:File[],point:Point|undefined,workspace:number){
  const area=this.host.area(),occupied=[...Object.values(this.host.positions(workspace)),...Object.values(this.positions(workspace))],jobs:PendingUpload[]=[],result={uploaded:0,errors:[] as string[]};
  // Stage the entire batch before the first network request, including queued files.
  for(const file of files){const index=jobs.length,desired=point?iconRect(index,area,{x:point.x+index%5*104,y:point.y+Math.floor(index/5)*94}):undefined,position=desired&&!occupied.some(p=>intersects(desired,iconRect(0,area,p)))?{x:desired.x,y:desired.y}:freeIconPosition(area,occupied),id='upload:'+crypto.randomUUID(),now=Date.now();occupied.push(position);const item:PendingUpload={file,workspace,point:position,object:{id,namespace:'os',kind:'file',title:file.name,source:file.name,body:JSON.stringify({mime:file.type,bytes:file.size}),summary:'',status:'uploading',tags:[],spaces:[],cover:'',location:'',revision:0,created:now,updated:now,starred:false,archived:false,uploading:true}};this.pending.set(id,item);jobs.push(item);}
  this.host.changed();let next=0;
  const work=async()=>{while(next<jobs.length){const item=jobs[next++];try{if(item.file.size>24*1024*1024)throw Error('Keep each file below 24 MiB');const response=await this.host.upload(item.file);if(response.objects.length!==1)throw Error('The upload did not return a file');this.pending.delete(item.object.id);this.host.complete(response.objects[0],item.point,item.workspace);result.uploaded++;}catch(error){result.errors.push(item.file.name+': '+(error instanceof Error?error.message:'Upload failed'));}finally{this.pending.delete(item.object.id);this.host.changed();}}};
  await Promise.all(Array.from({length:Math.min(3,jobs.length)},()=>work()));return result;
 }
}
