module ink.knowledge.streamed_gap_sequence;
// General editor sequence; no IDs, replica state, CRDTs or compiler dispatch.
record Gap<T>{data:Buffer<T>,start:u32,end:u32,fallback:T,}
fn empty<T>(fallback:T)->Gap<T>{return Gap<T>{data:buffer_fill(32,fallback),start:0,end:32,fallback:fallback};}
fn length<T>(g:Gap<T>)->u32{return g.data.len()-g.end+g.start;}
fn moved<T>(g:Gap<T>,position:u32)->Gap<T>{
 let length=g.data.len()-g.end+g.start;
 let position=choose(position>length,length,position);
 if position<g.start {
  let count=g.start-position;
  return Gap<T>{data:g.data.copy_within(position,g.end-count,count),start:position,end:g.end-count,fallback:g.fallback};
 }
 let count=position-g.start;
 return Gap<T>{data:g.data.copy_within(g.end,g.start,count),start:position,end:g.end+count,fallback:g.fallback};
}
fn grown<T>(g:Gap<T>)->Gap<T>{
 if g.start<g.end{return g;}
 let old=g.data.len();let extra=choose(old<32,32,old);
 let fallback=g.fallback;
 let b=repeat_until(extra,g.data,fn(b)=>false,fn(i)=>fn(b)=>b.push(fallback));
 return Gap<T>{data:b.copy_within(g.end,g.end+extra,old-g.end),start:g.start,end:g.end+extra,fallback:g.fallback};
}
fn inserted<T>(g:Gap<T>,value:T)->Gap<T>{
 let g=grown<T>(g);
 return Gap<T>{data:g.data.set(g.start,value),start:g.start+1,end:g.end,fallback:g.fallback};
}
record Writing<T>{data:Buffer<T>,index:u32,}
fn write_one<T>(w:Writing<T>,value:T)->Writing<T>{
 return Writing<T>{data:w.data.set(w.index,value),index:w.index+1};
}
// Reserve the entire insertion before writing. Inactive gap contents/capacity
// are implementation state; the decoded sequence agrees with scalar insertion.
// Malformed layouts and overflowing growth retain the original scalar path.
fn inserted_many<T>(g:Gap<T>,values:List<T>)->Gap<T>{
 let count:u32=word_narrow_u64_to_u32(count(values));let old=g.data.len();
 if g.start>g.end || g.end>old{return foldl(values,g,fn(value,g)=>inserted<T>(g,value));}
 let available=g.end-g.start;
 let deficit=choose(count>available,count-available,0);
 let doubled=choose(old<32,32,old);let extra=choose(deficit>doubled,deficit,doubled);
 if deficit>0 && old>4294967295-extra{return foldl(values,g,fn(value,g)=>inserted<T>(g,value));}
 let g=choose(deficit==0,g,reserved<T>(g,extra));
 let start=g.start;let end=g.end;let fallback=g.fallback;let old=g.data.len();
 // The reserved gap is disjoint from the visible suffix. Copy input values
 // directly into that gap, preserving its inactive contents elsewhere.
 if count>4294967295-old{return foldl(values,g,fn(value,g)=>inserted<T>(g,value));}
 let written=foldl(values,Writing<T>{data:g.data,index:start},fn(value,w)=>write_one<T>(w,value));let data=written.data;
 return Gap<T>{data:data,start:start+count,end:end,fallback:fallback};
}
fn reserved<T>(g:Gap<T>,extra:u32)->Gap<T>{
 let old=g.data.len();let fallback=g.fallback;
 let data=g.data.append(buffer_fill(extra,fallback));
 return Gap<T>{data:data.copy_within(g.end,g.end+extra,old-g.end),start:g.start,end:g.end+extra,fallback:fallback};
}
fn erased<T>(g:Gap<T>,count:u32)->Gap<T>{
 let count=choose(count>g.data.len()-g.end,g.data.len()-g.end,count);
 return Gap<T>{data:g.data,start:g.start,end:g.end+count,fallback:g.fallback};
}
fn freeze<T>(g:Gap<T>)->List<T>{
 let suffix=g.data.len()-g.end;
 return g.data.copy_within(g.end,g.start,suffix).truncate(g.start+suffix).freeze();
}
