module ink.knowledge.uniform_interval_index;
// A virtual index for adjacent intervals of equal width. Values are their
// one-based ordinals. Closed-end arithmetic permits the top-of-word sentinel.
// This library supplies no maintained-index or caller-invariant assumptions.
record Prefix{start:u64,width:u32,count:u32,}
record Found{value:u32,start:u64,end:u64,}
fn extent(p:Prefix)->u64{return word_widen_u32_to_u64(p.width)*word_widen_u32_to_u64(p.count);}
fn valid(p:Prefix)->Bool{return p.width!=0 && p.count!=0 && extent(p)-1<=18446744073709551615-p.start;}
fn locate(p:Prefix,key:u64)->Found{
 if !valid(p) || key<p.start{return Found{value:0,start:0,end:0};}
 let offset=key-p.start;if offset>=extent(p){return Found{value:0,start:0,end:0};}
 let width=word_widen_u32_to_u64(p.width);let ordinal=quot_or(offset,width,0);let start=p.start+ordinal*width;
 return Found{value:word_narrow_u64_to_u32(ordinal)+1,start:start,end:start+width};
}
fn overlaps(p:Prefix,start:u64,end:u64)->Bool{
 let last=p.start+extent(p);
 return valid(p) && (start<last || last==0) && (p.start<end || end==0);
}
