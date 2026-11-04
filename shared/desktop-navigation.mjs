const vectors={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
const center=rect=>({x:rect.x+rect.width/2,y:rect.y+rect.height/2});
const overlaps=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;

/** Navigate displayed geometry, independently of storage order or camera scale. */
export function desktopNeighbor(items,current,direction,viewport){
 const vector=vectors[direction];if(!vector)return current;
 const entries=[...items].filter(([,rect])=>rect&&[rect.x,rect.y,rect.width,rect.height].every(Number.isFinite)&&rect.width>0&&rect.height>0);
 const source=entries.find(([id])=>id===current);
 if(!source){
  const visible=viewport?entries.filter(([,rect])=>overlaps(rect,{x:viewport.x||0,y:viewport.y||0,width:viewport.width,height:viewport.height})):entries;
  return(visible.length?visible:entries).sort(([a,r],[b,s])=>r.y-s.y||r.x-s.x||a.localeCompare(b))[0]?.[0];
 }
 const origin=center(source[1]),horizontal=vector[0]!==0,candidates=[];
 for(const[id,rect]of entries){
  if(id===current)continue;const point=center(rect),primary=(point.x-origin.x)*vector[0]+(point.y-origin.y)*vector[1];
  if(primary<=.01)continue;
  const cross=Math.abs(horizontal?point.y-origin.y:point.x-origin.x);
  const beam=horizontal?rect.y<source[1].y+source[1].height&&rect.y+rect.height>source[1].y:rect.x<source[1].x+source[1].width&&rect.x+rect.width>source[1].x;
  candidates.push({id,beam,primary,cross,score:Math.hypot(primary,cross)+cross});
 }
 candidates.sort((a,b)=>Number(b.beam)-Number(a.beam)||(a.beam?a.primary-b.primary:a.score-b.score)||a.cross-b.cross||a.id.localeCompare(b.id));
 return candidates[0]?.id||current;
}
