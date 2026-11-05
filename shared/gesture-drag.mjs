/** A physical stroke owns one axis until release. Position is never latched. */
export class GestureDrag {
  constructor(begin,now=()=>performance.now()) {this.begin=begin;this.now=now;this.clear();}
  clear(){this.x=0;this.y=0;this.travelX=0;this.travelY=0;this.samples=[{time:this.now(),x:0,y:0}];this.axis=undefined;this.eligible=undefined;this.motion=undefined;this.consuming=false;}
  start(){this.end();}
  wheel(event,eligible){
    const {deltaX,deltaY,deltaMode=0,ctrlKey,metaKey,altKey,shiftKey}=event;
    if(![deltaX,deltaY].every(Number.isFinite)||ctrlKey||metaKey||altKey||shiftKey){this.end(true);return false;}
    if(this.eligible===undefined&&(deltaX||deltaY))this.eligible=eligible;
    const scale=deltaMode===1?16:deltaMode===2?800:1;
    this.x+=deltaX*scale;this.y+=deltaY*scale;
    this.travelX+=Math.abs(deltaX*scale);this.travelY+=Math.abs(deltaY*scale);
    const time=this.now();this.samples.push({time,x:this.x,y:this.y});
    while(this.samples.length>2&&this.samples[1].time<time-80)this.samples.shift();
    if(!this.axis&&Math.max(Math.abs(this.x),Math.abs(this.y))>=8){
      if(Math.abs(this.x)>Math.abs(this.y)*1.5)this.axis='horizontal';
      else if(Math.abs(this.y)>Math.abs(this.x)*1.5)this.axis='vertical';
      if(this.axis){this.motion=this.axis==='horizontal'||this.eligible?this.begin(this.axis):undefined;this.consuming=!!this.motion;}
    }
    this.motion?.move(this.axis==='horizontal'?this.x:this.y);
    return this.consuming;
  }
  end(cancelled=false){
    const motion=this.motion,axis=this.axis==='horizontal'?'x':'y',first=this.samples[0],last=this.samples.at(-1),travel=axis==='x'?this.travelX:this.travelY;
    const velocity=travel>=30&&this.now()-last.time<90&&last.time-first.time>=8?(last[axis]-first[axis])/(last.time-first.time):0;
    this.clear();motion?.end(cancelled,velocity);
  }
}

/** A deliberate flick completes the next step; a paused/slow stroke uses distance. */
export function releaseTarget(position,velocity=0,min=0,max=1){
  const target=Math.abs(velocity)>=.65?(velocity>0?Math.floor(position)+1:Math.ceil(position)-1):Math.round(position);
  return Math.max(min,Math.min(max,target));
}
