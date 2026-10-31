module ink.knowledge.word_priority_queue;
// A general maximum heap over indices. Comparisons and ownership are ordinary
// language semantics; neither the compiler nor runtime selects this algorithm.
record Cursor{values:Buffer<u64>,index:u32,}
fn up_step(c:Cursor)->Cursor{
 let parent=quot_or(c.index-1,2,0);
 return Cursor{values:c.values.swap(parent,c.index),index:parent};
}
fn push(values:Buffer<u64>,value:u64)->Buffer<u64>{
 let index=values.len();let values=values.push(value);let bound=values.len();
 let c=repeat_until(bound,Cursor{values:values,index:index},
 fn(c)=>c.index==0 || c.values.at_or(quot_or(c.index-1,2,0),0)>=c.values.at_or(c.index,0),
 fn(i)=>fn(c)=>up_step(c));
 return c.values;
}
fn down_step(c:Cursor)->Cursor{
 let n=c.values.len();let left=c.index*2+1;let right=left+1;
 let child=choose(right<n && c.values.at_or(right,0)>c.values.at_or(left,0),right,left);
 if c.values.at_or(c.index,0)>=c.values.at_or(child,0){return Cursor{values:c.values,index:n};}
 return Cursor{values:c.values.swap(c.index,child),index:child};
}
fn pop(values:Buffer<u64>)->Buffer<u64>{
 let n=values.len();if n==0{return values;}
 let values=values.swap(0,n-1).pop();let bound=values.len();
 let c=repeat_until(bound,Cursor{values:values,index:0},
 fn(c)=>c.values.len()<2 || c.index>quot_or(c.values.len()-2,2,0),fn(i)=>fn(c)=>down_step(c));
 return c.values;
}
