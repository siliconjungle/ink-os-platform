module ink.knowledge.interval_index;
// General disjoint half-open u64 intervals with stable integer handles.
// End zero denotes 2^64, so the largest u64 key remains representable.
// A key-ordered treap supports predecessor lookup without expanding an interval.
record Node{start:u64,end:u64,value:u32,left:u32,right:u32,parent:u32,priority:u32,}
record Index{nodes:Buffer<Node>,root:u32,valid:Bool,}
record Cursor{index:Index,node:u32,best:u32,}
record Found{index:Index,value:u32,start:u64,end:u64,}
fn nil()->Node{return Node{start:0,end:0,value:0,left:0,right:0,parent:0,priority:0};}
fn empty()->Index{return Index{nodes:buffer([nil()]),root:0,valid:true};}
fn priority(slot:u32)->u32{let x=(slot ^ wrapping_shr(slot,16))*2246822507;let x=(x ^ wrapping_shr(x,13))*3266489909;return x ^ wrapping_shr(x,16);}
fn children(n:Node,left:u32,right:u32,parent:u32)->Node{return Node{start:n.start,end:n.end,value:n.value,left:left,right:right,parent:parent,priority:n.priority};}
fn predecessor_step(c:Cursor,key:u64)->Cursor{let n=c.index.nodes.at_or(c.node,nil());let take=n.start<=key;return Cursor{index:c.index,node:choose(take,n.right,n.left),best:choose(take,c.node,c.best)};}
fn locate(index:Index,key:u64)->Found{
 let root=index.root;let bound=index.nodes.len();let c=repeat_until(bound,Cursor{index:index,node:root,best:0},fn(c)=>c.node==0,fn(i)=>fn(c)=>predecessor_step(c,key));
 let n=c.index.nodes.at_or(c.best,nil());let value=choose(c.best!=0 && (n.end==0 || key<n.end),n.value,0);
 return Found{index:c.index,value:value,start:n.start,end:n.end};
}
fn rotate(index:Index,slot:u32)->Index{
 let n=index.nodes.at_or(slot,nil());let p=index.nodes.at_or(n.parent,nil());let left=p.left==slot;let mid=choose(left,n.right,n.left);let m=index.nodes.at_or(mid,nil());let g=index.nodes.at_or(p.parent,nil());
 let nodes=index.nodes.set(n.parent,children(p,choose(left,mid,p.left),choose(left,p.right,mid),slot));
 let nodes=nodes.set(slot,children(n,choose(left,n.left,n.parent),choose(left,n.parent,n.right),p.parent));
 let nodes=choose(mid==0,nodes,nodes.set(mid,children(m,m.left,m.right,n.parent)));
 let nodes=choose(p.parent==0,nodes,nodes.set(p.parent,children(g,choose(g.left==n.parent,slot,g.left),choose(g.right==n.parent,slot,g.right),g.parent)));
 return Index{nodes:nodes,root:choose(p.parent==0,slot,index.root),valid:index.valid};
}
fn destination(c:Cursor,key:u64)->Cursor{let n=c.index.nodes.at_or(c.node,nil());return Cursor{index:c.index,node:choose(key<n.start,n.left,n.right),best:c.node};}
fn insert(index:Index,start:u64,end:u64,value:u32)->Index{
 let f=locate(index,start);let free=f.value==0;
 let root=f.index.root;let bound=f.index.nodes.len();let c=repeat_until(bound,Cursor{index:f.index,node:root,best:0},fn(c)=>c.node==0,fn(i)=>fn(c)=>destination(c,start));
 let p=c.index.nodes.at_or(c.best,nil());let left=start<p.start;
 // The following successor search is independent of how the tree is balanced.
 let successor=successor(c.index,start);let next=successor.start;
 let valid=successor.index.valid && (start<end || end==0) && value!=0 && free && (successor.value==0 || (end!=0 && end<=next));
 if !valid{return Index{nodes:successor.index.nodes,root:successor.index.root,valid:false};}
 let slot=successor.index.nodes.len();let n=Node{start:start,end:end,value:value,left:0,right:0,parent:c.best,priority:priority(slot)};
 let nodes=successor.index.nodes.push(n);let nodes=choose(c.best==0,nodes,nodes.set(c.best,children(p,choose(left,slot,p.left),choose(left,p.right,slot),p.parent)));
 let index=Index{nodes:nodes,root:choose(c.best==0,slot,successor.index.root),valid:valid};
 let r=repeat_until(bound,Cursor{index:index,node:slot,best:0},fn(c)=>c.index.nodes.at_or(c.node,nil()).parent==0 || c.index.nodes.at_or(c.node,nil()).priority>=c.index.nodes.at_or(c.index.nodes.at_or(c.node,nil()).parent,nil()).priority,fn(i)=>fn(c)=>Cursor{index:rotate(c.index,c.node),node:c.node,best:0});
 return r.index;
}
fn successor_step(c:Cursor,key:u64)->Cursor{let n=c.index.nodes.at_or(c.node,nil());let take=n.start>=key;return Cursor{index:c.index,node:choose(take,n.left,n.right),best:choose(take,c.node,c.best)};}
fn successor(index:Index,key:u64)->Found{let root=index.root;let bound=index.nodes.len();let c=repeat_until(bound,Cursor{index:index,node:root,best:0},fn(c)=>c.node==0,fn(i)=>fn(c)=>successor_step(c,key));let n=c.index.nodes.at_or(c.best,nil());return Found{index:c.index,value:n.value,start:choose(c.best==0,18446744073709551615,n.start),end:n.end};}
fn changed_end(index:Index,start:u64,end:u64)->Index{
 let root=index.root;let bound=index.nodes.len();let c=repeat_until(bound,Cursor{index:index,node:root,best:0},fn(c)=>c.node==0,fn(i)=>fn(c)=>predecessor_step(c,start));let n=c.index.nodes.at_or(c.best,nil());
 let next=choose(start==18446744073709551615,Found{index:c.index,value:0,start:0,end:0},successor(c.index,start+1));
 let valid=next.index.valid && c.best!=0 && n.start==start && (start<end || end==0) && (next.value==0 || (end!=0 && end<=next.start));
 return Index{nodes:choose(valid,next.index.nodes.set(c.best,Node{start:n.start,end:end,value:n.value,left:n.left,right:n.right,parent:n.parent,priority:n.priority}),next.index.nodes),root:next.index.root,valid:valid};
}
