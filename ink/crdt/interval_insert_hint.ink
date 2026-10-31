module ink.knowledge.interval_insert_hint;
import "interval_index.ink" as base;
import "interval_fused.ink" as fused;
// General stable-handle insertion finger. A maintained BST supplies successor
// ordering; every hinted interval boundary and parent link is checked on use.
// This ordinary alternative still needs its maintained-tree refinement proof.
record Descending{index:base.Index,node:u32,best:u32,}
fn descend(s:Descending)->Descending{let n=s.index.nodes.at_or(s.node,base.nil());return Descending{index:s.index,node:n.left,best:s.node};}
record Ascending{index:base.Index,node:u32,done:Bool,}
fn ascend(s:Ascending)->Ascending{
 let n=s.index.nodes.at_or(s.node,base.nil());let p=s.index.nodes.at_or(n.parent,base.nil());
 return Ascending{index:s.index,node:n.parent,done:n.parent==0 || p.left==s.node};
}
fn insert(index:base.Index,start:u64,end:u64,value:u32,hint:u32)->base.Index{
 let h=index.nodes.at_or(hint,base.nil());
 if !index.valid || hint==0 || hint>=index.nodes.len() || h.value==0 || h.end==0 || start<h.end{return fused.insert(index,start,end,value);}
 let bound=index.nodes.len();
 if h.right!=0{
  let s=repeat_until(bound,Descending{index:index,node:h.right,best:0},fn(s)=>s.node==0,fn(i,s)=>descend(s));
  let next=s.index.nodes.at_or(s.best,base.nil());
  if s.best==0 || next.left!=0 || end==0 || end>next.start{return fused.insert(s.index,start,end,value);}
  return attached(s.index,start,end,value,s.best,true);
 }
 let a=repeat_until(bound,Ascending{index:index,node:hint,done:false},fn(a)=>a.done,fn(i,a)=>ascend(a));
 let next=a.index.nodes.at_or(a.node,base.nil());
 if a.node!=0 && (end==0 || end>next.start){return fused.insert(a.index,start,end,value);}
 return attached(a.index,start,end,value,hint,false);
}
fn attached(index:base.Index,start:u64,end:u64,value:u32,parent:u32,left:Bool)->base.Index{
 let p=index.nodes.at_or(parent,base.nil());
 let valid=index.valid && (start<end || end==0) && value!=0 && parent!=0 && parent<index.nodes.len() && choose(left,p.left==0 && end!=0 && end<=p.start,p.right==0 && p.end!=0 && start>=p.end);
 if !valid{return fused.insert(index,start,end,value);}
 let slot=index.nodes.len();let bound=slot;let n=base.Node{start:start,end:end,value:value,left:0,right:0,parent:parent,priority:base.priority(slot)};
 let nodes=index.nodes.push(n).set(parent,base.children(p,choose(left,slot,p.left),choose(left,p.right,slot),p.parent));
 let index=base.Index{..index,nodes:nodes};
 return repeat_until(bound,base.Cursor{index:index,node:slot,best:0},fn(c)=>c.index.nodes.at_or(c.node,base.nil()).parent==0 || c.index.nodes.at_or(c.node,base.nil()).priority>=c.index.nodes.at_or(c.index.nodes.at_or(c.node,base.nil()).parent,base.nil()).priority,fn(i,c)=>base.Cursor{index:base.rotate(c.index,c.node),node:c.node,best:0}).index;
}
