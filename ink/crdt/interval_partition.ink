module ink.knowledge.interval_partition;
import "interval_index.ink" as base;
import "interval_fused.ink" as fused;
// Interior refinement of a maintained disjoint interval treap. Cached node
// handles are checked against the complete old interval before use. The right
// subtree contains only later intervals, so the new boundary takes its leftmost
// insertion position. Arbitrary-state equivalence needs a separate invariant.
fn descend(c:base.Cursor)->base.Cursor{
 let node=c.index.nodes.at_or(c.node,base.nil()).left;let best=c.node;
 return base.Cursor{index:c.index,node:node,best:best};
}
fn partition(index:base.Index,start:u64,end:u64,cut:u64,value:u32,suffix:u32,hint:u32)->base.Index{
 let old=index.nodes.at_or(hint,base.nil());
 let valid=index.valid && hint!=0 && hint<index.nodes.len() && old.start==start && old.end==end && old.value==value && value!=0 && suffix!=0 && start<cut && (end==0 || cut<end);
 if !valid{return fused.insert(base.changed_end(index,start,cut),cut,end,suffix);}
 let bound=index.nodes.len();
 let c=repeat_until(bound,base.Cursor{index:index,node:old.right,best:hint},fn(c)=>c.node==0,fn(i,c)=>descend(c));
 let slot=c.index.nodes.len();let parent=c.best;let root=c.index.root;let valid=c.index.valid;
 let prefix=base.Node{..old,end:cut};let nodes=c.index.nodes.set(hint,prefix);
 let p=nodes.at_or(parent,base.nil());
 let n=base.Node{start:cut,end:end,value:suffix,left:0,right:0,parent:parent,priority:base.priority(slot)};
 let nodes=nodes.push(n).set(parent,base.children(p,choose(parent==hint,p.left,slot),choose(parent==hint,slot,p.right),p.parent));
 let index=base.Index{nodes:nodes,root:root,valid:valid};
 let r=repeat_until(bound,base.Cursor{index:index,node:slot,best:0},fn(c)=>c.index.nodes.at_or(c.node,base.nil()).parent==0 || c.index.nodes.at_or(c.node,base.nil()).priority>=c.index.nodes.at_or(c.index.nodes.at_or(c.node,base.nil()).parent,base.nil()).priority,fn(i,c)=>base.Cursor{index:base.rotate(c.index,c.node),node:c.node,best:0});
 return r.index;
}
