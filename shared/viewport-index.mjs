import {PackedPointIndex} from './vendor/rill-spatial.mjs';
// Exact rectangle visibility over Rill's immutable packed point hierarchy.
// Geometry changes invalidate the snapshot; camera queries never rebuild it.
export class ViewportIndex {
 constructor(items=[]){this.items=new Map();this.dirty=true;this.set(items);}
 set(items){this.items=new Map(items.map(item=>[item.key,Object.freeze({...item})]));this.dirty=true;}
 upsert(item){const old=this.items.get(item.key);if(old&&old.x===item.x&&old.y===item.y&&old.width===item.width&&old.height===item.height&&old.value===item.value)return;this.items.set(item.key,Object.freeze({...item}));this.dirty=true;}
 remove(key){if(this.items.delete(key))this.dirty=true;}
 query(view,overscan=0){
  if(![view.x,view.y,view.width,view.height,overscan].every(Number.isFinite)||view.width<0||view.height<0||overscan<0)return [];
  if(this.dirty){this.halfExtent=0;const points=[];for(const item of this.items.values()){if(![item.x,item.y,item.width,item.height].every(Number.isFinite)||item.width<0||item.height<0)continue;this.halfExtent=Math.max(this.halfExtent,item.width/2,item.height/2);points.push({item,pos:[item.x+item.width/2,0,item.y+item.height/2]});}this.index=new PackedPointIndex(points,{splitAxes:[0,2]});this.dirty=false;}
  const left=view.x-overscan,top=view.y-overscan,right=view.x+view.width+overscan,bottom=view.y+view.height+overscan;
  const candidates=this.index.withinBox([view.x+view.width/2,0,view.y+view.height/2],Math.max(view.width,view.height)/2+overscan+this.halfExtent);this.lastCandidates=candidates.length;
  return candidates.map(point=>point.item).filter(item=>item.x+item.width>=left&&item.x<=right&&item.y+item.height>=top&&item.y<=bottom);
 }
}
