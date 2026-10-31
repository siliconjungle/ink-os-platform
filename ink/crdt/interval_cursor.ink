module ink.knowledge.interval_cursor;
import "interval_index.ink" as intervals;
// A hint names an append-only index node, not a cached answer. Validate its
// current bounds on every use, including after changed_end or an insertion.
// Rotations preserve node handles. Invalid hints use ordinary predecessor search.
record Found{index:intervals.Index,value:u32,start:u64,end:u64,hint:u32,}
fn locate(index:intervals.Index,key:u64,hint:u32)->Found{
 let n=index.nodes.at_or(hint,intervals.nil());
 if index.valid && hint!=0 && hint<index.nodes.len() && n.value!=0 && n.start<=key && (n.end==0 || key<n.end){
  return Found{index:index,value:n.value,start:n.start,end:n.end,hint:hint};
 }
 let root=index.root;let bound=index.nodes.len();
 let c=repeat_until(bound,intervals.Cursor{index:index,node:root,best:0},fn(c)=>c.node==0,fn(i,c)=>intervals.predecessor_step(c,key));
 let n=c.index.nodes.at_or(c.best,intervals.nil());let value=choose(c.best!=0 && (n.end==0 || key<n.end),n.value,0);
 return Found{index:c.index,value:value,start:n.start,end:n.end,hint:choose(value==0,0,c.best)};
}
