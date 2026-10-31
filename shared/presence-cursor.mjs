const finite=value=>Number.isFinite(value)&&Math.abs(value)<1e8;

export function presenceCursor(value){
 if(!value||!finite(value.x)||!finite(value.y))return null;
 if(value.space==='desktop')return{space:'desktop',x:value.x,y:value.y};
 if(value.space!==undefined)return null;
 return{x:Math.max(0,Math.min(1,value.x)),y:Math.max(0,Math.min(1,value.y))};
}

// Desktop placements and pointers share CSS pixels, independent of viewport size.
export function cursorScreenPoint(value,{left=0,top=0,width,height}){
 const cursor=presenceCursor(value);if(!cursor)return null;
 if(cursor.space!=='desktop')return{x:cursor.x*width,y:cursor.y*height};
 if(cursor.x<0||cursor.y<0||cursor.x>=width||cursor.y>=height)return null;
 return{x:left+cursor.x,y:top+cursor.y};
}
