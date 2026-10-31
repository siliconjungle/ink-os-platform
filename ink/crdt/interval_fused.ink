module ink.knowledge.interval_fused;
import "interval_index.ink" as base;
// An ordinary source alternative for maintained disjoint interval treaps.
// One search finds the insertion parent and both bounding intervals. The
// invariant and complete source equivalence must be proved before a rewrite
// can select this implementation automatically.
record Search{index:base.Index,node:u32,parent:u32,previous:u32,next:u32,}
fn step(s:Search,key:u64)->Search{
 let n=s.index.nodes.at_or(s.node,base.nil());
 let next=choose(n.start>=key && (s.next==0 || n.start<s.index.nodes.at_or(s.next,base.nil()).start),s.node,s.next);
 return Search{..s,node:choose(key<n.start,n.left,n.right),parent:s.node,
 previous:choose(n.start<=key,s.node,s.previous),next:next};
}
fn insert(index:base.Index,start:u64,end:u64,value:u32)->base.Index{
 let root=index.root;let bound=index.nodes.len();
 let s=repeat_until(bound,Search{index:index,node:root,parent:0,previous:0,next:0},fn(s)=>s.node==0,fn(i,s)=>step(s,start));
 let before=s.index.nodes.at_or(s.previous,base.nil());let after=s.index.nodes.at_or(s.next,base.nil());
 let free=s.previous==0 || before.value==0 || (before.end!=0 && start>=before.end);
 let valid=s.index.valid && (start<end || end==0) && value!=0 && free && (s.next==0 || after.value==0 || (end!=0 && end<=after.start));
 if !valid{return base.Index{..s.index,valid:false};}
 let slot=s.index.nodes.len();let p=s.index.nodes.at_or(s.parent,base.nil());let left=start<p.start;
 let n=base.Node{start:start,end:end,value:value,left:0,right:0,parent:s.parent,priority:base.priority(slot)};
 let nodes=s.index.nodes.push(n);let nodes=choose(s.parent==0,nodes,nodes.set(s.parent,base.children(p,choose(left,slot,p.left),choose(left,p.right,slot),p.parent)));
 let index=base.Index{nodes:nodes,root:choose(s.parent==0,slot,s.index.root),valid:valid};
 let r=repeat_until(bound,base.Cursor{index:index,node:slot,best:0},fn(c)=>c.index.nodes.at_or(c.node,base.nil()).parent==0 || c.index.nodes.at_or(c.node,base.nil()).priority>=c.index.nodes.at_or(c.index.nodes.at_or(c.node,base.nil()).parent,base.nil()).priority,fn(i,c)=>base.Cursor{index:base.rotate(c.index,c.node),node:c.node,best:0});
 return r.index;
}
