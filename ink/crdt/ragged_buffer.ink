module ink.knowledge.ragged_buffer;
// General append-only variable-length rows in a flat arena. Stable row numbers
// identify scalar ranges; replay can observe elements without copying a row.
record Range{start:u32,end:u32,}
record Rows<T>{values:Buffer<T>,ranges:Buffer<Range>,}
fn empty<T>()->Rows<T>{return Rows<T>{values:Buffer.empty(),ranges:Buffer.empty()};}
fn nil()->Range{return Range{start:0,end:0};}
fn append<T>(rows:Rows<T>,values:Buffer<T>)->Rows<T>{
 let start=rows.values.len();let count=values.len();
 return Rows<T>{values:rows.values.append(values),ranges:rows.ranges.push(Range{start:start,end:start+count})};
}
fn range<T>(rows:Rows<T>,index:u32)->Range{return rows.ranges.at_or(index,nil());}
record Reading<T>{rows:Rows<T>,index:u32,end:u32,values:Buffer<T>,fallback:T,}
fn read_step<T>(r:Reading<T>)->Reading<T>{
 let value=r.rows.values.at_or(r.index,r.fallback);
 return Reading<T>{..r,index:r.index+1,values:r.values.push(value)};
}
fn row<T>(rows:Rows<T>,index:u32,fallback:T)->List<T>{
 let r=read<T>(rows,index,fallback);return r.values.freeze();
}
fn read<T>(rows:Rows<T>,index:u32,fallback:T)->Reading<T>{
 let span=rows.ranges.at_or(index,nil());let count=span.end-span.start;
 return repeat_until(count,Reading<T>{rows:rows,index:span.start,end:span.end,values:Buffer.empty(),fallback:fallback},fn(r)=>r.index>=r.end,fn(i,r)=>read_step<T>(r));
}
