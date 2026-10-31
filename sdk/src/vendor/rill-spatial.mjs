// Rill's packed leaf hierarchy in portable JavaScript. No native addon, Wasm,
// GPU or Node-specific API. This is an immutable position snapshot: values keep
// their identity, while coordinates and original tie order are captured once.
const minXZ = (t,n,x,z) => Math.hypot(Math.max(t.x0[n]-x,0,x-t.x1[n]),Math.max(t.z0[n]-z,0,z-t.z1[n]));
const min3D = (t,n,x,y,z) => Math.max(t.x0[n]-x,0,x-t.x1[n])**2+Math.max(t.y0[n]-y,0,y-t.y1[n])**2+Math.max(t.z0[n]-z,0,z-t.z1[n])**2;

function select(order, coordinates, left, right, middle) {
  const compare=(a,b)=>coordinates[a]-coordinates[b]||a-b;
  let budget=2*Math.ceil(Math.log2(right-left+2));
  while(left<right){
    if(--budget<0){order.set(Array.from(order.subarray(left,right+1)).sort(compare),left);return;}
    const pivot=order[(left+right)>>>1];let i=left,j=right;
    while(i<=j){
      while(compare(order[i],pivot)<0)i++;
      while(compare(order[j],pivot)>0)j--;
      if(i<=j){const swap=order[i];order[i++]=order[j];order[j--]=swap;}
    }
    if(middle<=j)right=j;else if(middle>=i)left=i;else return;
  }
}

export class PackedPointIndex {
  constructor(values,{position=v=>v?.pos??v,unique=false,leafSize=24,splitAxes=[0,1,2]}={}){
    if(!Number.isInteger(leafSize)||leafSize<1||leafSize>1024)throw new RangeError('leafSize must be an integer from 1 to 1024');
    if(!splitAxes.length||splitAxes.some(d=>!Number.isInteger(d)||d<0||d>2))throw new RangeError('splitAxes must contain coordinate axes');
    const xs=[],ys=[],zs=[],kept=[],seen=unique?new Set():null;
    for(const value of values){
      const p=position(value);
      if(!p||p.length!==3||!Number.isFinite(p[0])||!Number.isFinite(p[1])||!Number.isFinite(p[2]))continue;
      if(seen){const key=p.join(',');if(seen.has(key))continue;seen.add(key);}
      kept.push(value);xs.push(p[0]);ys.push(p[1]);zs.push(p[2]);
    }
    this.values=kept;this.size=kept.length;
    const size=this.size,capacity=2*2**Math.ceil(Math.log2(Math.max(1,size/leafSize)));
    for(const key of ['x0','x1','y0','y1','z0','z1'])this[key]=new Float64Array(capacity);
    for(const key of ['begin','end','left','right','first'])this[key]=new Int32Array(capacity);
    const order=Int32Array.from({length:size},(_,i)=>i),coords=[xs,ys,zs];let count=0;
    const build=(begin,end)=>{
      const n=count++;let x0=Infinity,y0=Infinity,z0=Infinity,x1=-Infinity,y1=-Infinity,z1=-Infinity,first=Infinity;
      for(let j=begin;j<end;j++){const i=order[j],x=xs[i],y=ys[i],z=zs[i];x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);z0=Math.min(z0,z);z1=Math.max(z1,z);first=Math.min(first,i);}
      this.x0[n]=x0;this.x1[n]=x1;this.y0[n]=y0;this.y1[n]=y1;this.z0[n]=z0;this.z1[n]=z1;
      this.begin[n]=begin;this.end[n]=end;this.first[n]=first;this.left[n]=-1;this.right[n]=-1;
      if(end-begin>leafSize){
        const spans=[x1-x0,y1-y0,z1-z0];let axis=splitAxes[0];for(const d of splitAxes)if(spans[d]>spans[axis])axis=d;
        const mid=(begin+end)>>>1;select(order,coords[axis],begin,end-1,mid);this.left[n]=build(begin,mid);this.right[n]=build(mid,end);
      }
      return n;
    };
    if(size)build(0,size);this.nodes=count;
    this.order=order;this.x=new Float64Array(size);this.y=new Float64Array(size);this.z=new Float64Array(size);
    for(let j=0;j<size;j++){const i=order[j];this.x[j]=xs[i];this.y[j]=ys[i];this.z[j]=zs[i];}
  }

  nearXZ(origin,radius){
    if(!this.size)return false;
    const x=origin[0],z=origin[2],limit=radius*radius,stack=[0];
    while(stack.length){
      const n=stack.pop(),dx=Math.max(this.x0[n]-x,0,x-this.x1[n]),dz=Math.max(this.z0[n]-z,0,z-this.z1[n]);
      if(dx*dx+dz*dz>limit)continue;
      if(this.left[n]<0){for(let j=this.begin[n];j<this.end[n];j++){const dx=this.x[j]-x,dz=this.z[j]-z;if(dx*dx+dz*dz<=limit)return true;}}
      else {stack.push(this.right[n],this.left[n]);}
    }
    return false;
  }

  nearestXZ(origin,maxHeight=Infinity){
    if(!this.size||!(maxHeight>0))return null;
    const x=origin[0],y=origin[1],z=origin[2],stack=[0],bounds=[minXZ(this,0,x,z)];let best=-1,distance=Infinity;
    while(stack.length){
      const n=stack.pop(),bound=bounds.pop();
      if(Math.max(this.y0[n]-y,0,y-this.y1[n])>=maxHeight||bound>distance||bound===distance&&best>=0&&this.first[n]>=best)continue;
      if(this.left[n]<0){
        for(let j=this.begin[n];j<this.end[n];j++)if(Math.abs(this.y[j]-y)<maxHeight){
          const d=Math.hypot(this.x[j]-x,this.z[j]-z),rank=this.order[j];
          if(d<distance||best>=0&&d===distance&&rank<best){best=rank;distance=d;}
        }
      }else{
        const a=this.left[n],b=this.right[n],ad=minXZ(this,a,x,z),bd=minXZ(this,b,x,z);
        if(ad<bd||ad===bd&&this.first[a]<this.first[b]){stack.push(b,a);bounds.push(bd,ad);}else{stack.push(a,b);bounds.push(ad,bd);}
      }
    }
    return best<0?null:{value:this.values[best],distance};
  }

  nearest3D(origin){
    if(!this.size||!origin||!Number.isFinite(origin[0])||!Number.isFinite(origin[1])||!Number.isFinite(origin[2]))return null;
    const x=origin[0],y=origin[1],z=origin[2],stack=[0],bounds=[min3D(this,0,x,y,z)];let best=-1,distance=Infinity;
    while(stack.length){
      const n=stack.pop(),bound=bounds.pop();if(bound>distance||bound===distance&&best>=0&&this.first[n]>=best)continue;
      if(this.left[n]<0){
        for(let j=this.begin[n];j<this.end[n];j++){
          const d=(x-this.x[j])**2+(y-this.y[j])**2+(z-this.z[j])**2,rank=this.order[j];
          if(d<distance||best>=0&&d===distance&&rank<best){best=rank;distance=d;}
        }
      }else{
        const a=this.left[n],b=this.right[n],ad=min3D(this,a,x,y,z),bd=min3D(this,b,x,y,z);
        if(ad<bd||ad===bd&&this.first[a]<this.first[b]){stack.push(b,a);bounds.push(bd,ad);}else{stack.push(a,b);bounds.push(ad,bd);}
      }
    }
    return best<0?null:{value:this.values[best],distance};
  }

  // Earliest input matches, with bounded result storage. `exclude` is a pure
  // predicate; traversal may prune rows that cannot enter the selected prefix.
  firstWithin3D(origin,radius,limit,{exclude=()=>false}={}){
    if(!this.size||!Number.isInteger(limit)||limit<1||!(radius>0))return [];
    const x=origin[0],y=origin[1],z=origin[2],heap=[],stack=[0];
    const keep=rank=>{
      if(heap.length<limit){let i=heap.length;heap.push(rank);while(i){const p=(i-1)>>1;if(rank<=heap[p])break;heap[i]=heap[p];i=p;}heap[i]=rank;}
      else if(rank<heap[0]){let i=0;while(i*2+1<heap.length){let c=i*2+1;if(c+1<heap.length&&heap[c+1]>heap[c])c++;if(heap[c]<=rank)break;heap[i]=heap[c];i=c;}heap[i]=rank;}
    };
    while(stack.length){
      const n=stack.pop();if(heap.length===limit&&this.first[n]>=heap[0])continue;
      const dx=Math.max(this.x0[n]-x,0,x-this.x1[n]),dy=Math.max(this.y0[n]-y,0,y-this.y1[n]),dz=Math.max(this.z0[n]-z,0,z-this.z1[n]);
      if(Math.hypot(dx,dy,dz)>=radius)continue;
      if(this.left[n]<0){
        for(let j=this.begin[n];j<this.end[n];j++){
          const rank=this.order[j];if(heap.length===limit&&rank>=heap[0])continue;
          if(Math.hypot(this.x[j]-x,this.y[j]-y,this.z[j]-z)<radius&&!exclude(this.values[rank]))keep(rank);
        }
      }else{
        const a=this.left[n],b=this.right[n];if(this.first[a]<this.first[b])stack.push(b,a);else stack.push(a,b);
      }
    }
    heap.sort((a,b)=>a-b);return heap.map(rank=>this.values[rank]);
  }

  within3D(origin,radius){return this._within(origin,radius,3);}
  withinXZ(origin,radius){return this._within(origin,radius,2);}
  withinBox(origin,radius){return this._within(origin,radius,0);}
  _within(origin,radius,mode){
    const found=[];if(!this.size||!(radius>=0)||mode!==0&&radius===0)return found;
    const x=origin[0],y=origin[1],z=origin[2],stack=[0];
    while(stack.length){
      const n=stack.pop(),dx=Math.max(this.x0[n]-x,0,x-this.x1[n]),dy=Math.max(this.y0[n]-y,0,y-this.y1[n]),dz=Math.max(this.z0[n]-z,0,z-this.z1[n]);
      if(mode===0?this.x1[n]<x-radius||this.x0[n]>x+radius||this.y1[n]<y-radius||this.y0[n]>y+radius||this.z1[n]<z-radius||this.z0[n]>z+radius:(mode===3?Math.hypot(dx,dy,dz):Math.hypot(dx,dz))>=radius)continue;
      if(this.left[n]<0){
        for(let j=this.begin[n];j<this.end[n];j++){
          const dx=this.x[j]-x,dy=this.y[j]-y,dz=this.z[j]-z;
          if(mode===0?Math.abs(dx)<=radius&&Math.abs(dy)<=radius&&Math.abs(dz)<=radius:(mode===3?Math.hypot(dx,dy,dz):Math.hypot(dx,dz))<radius)found.push(this.order[j]);
        }
      }else{stack.push(this.right[n],this.left[n]);}
    }
    found.sort((a,b)=>a-b);return found.map(i=>this.values[i]);
  }
}
