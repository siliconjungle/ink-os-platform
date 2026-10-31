module ink.knowledge.measured_sequence;
// A general implicit treap with stable slots, parent links and two measures.
// Algorithms and balancing policy are library definitions, not compiler cases.
record Node<T> { value:T, left:u32, right:u32, parent:u32, previous:u32, next:u32,
 priority:u32, size:u32, live:u32, weight:u32, }
record Tree<T> { nodes:Buffer<Node<T>>, root:u32, first:u32, last:u32, fallback:T, }
record Position<T> { tree:Tree<T>, node:u32, rank:u32, }

fn nil<T>(value:T)->Node<T> {return Node<T>{value:value,left:0,right:0,parent:0,previous:0,next:0,priority:0,size:0,live:0,weight:0};}
fn empty<T>(value:T)->Tree<T> {
 return Tree<T>{nodes:buffer([nil<T>(value)]),root:0,first:0,last:0,fallback:value};
}
fn links<T>(n:Node<T>,left:u32,right:u32,parent:u32,previous:u32,next:u32)->Node<T> {
 return Node<T>{value:n.value,left:left,right:right,parent:parent,previous:previous,next:next,
 priority:n.priority,size:n.size,live:n.live,weight:n.weight};
}
fn measured<T>(n:Node<T>,size:u32,live:u32,weight:u32)->Node<T> {
 return Node<T>{value:n.value,left:n.left,right:n.right,parent:n.parent,previous:n.previous,next:n.next,
 priority:n.priority,size:size,live:live,weight:weight};
}
fn priority(slot:u32)->u32 {
 let x=(slot ^ wrapping_shr(slot,16))*2246822507;
 let x=(x ^ wrapping_shr(x,13))*3266489909;
 return x ^ wrapping_shr(x,16);
}
fn pull<T>(t:Tree<T>,slot:u32)->Tree<T> {
 if slot==0 {return t;}
 let n=t.nodes.at_or(slot,nil<T>(t.fallback));
 let l=t.nodes.at_or(n.left,nil<T>(t.fallback));let r=t.nodes.at_or(n.right,nil<T>(t.fallback));
 let nodes=t.nodes.set(slot,measured<T>(n,l.size+r.size+1,l.live+r.live+n.weight,n.weight));
 return Tree<T>{nodes:nodes,root:t.root,first:t.first,last:t.last,fallback:t.fallback};
}
fn refresh_step<T>(r:Position<T>)->Position<T> {
  let parent=r.tree.nodes.at_or(r.node,nil<T>(r.tree.fallback)).parent;
  return Position<T>{tree:pull<T>(r.tree,r.node),node:parent,rank:0};
}
fn refresh<T>(t:Tree<T>,slot:u32)->Tree<T> {
 let bound=t.nodes.len();
 let result=repeat_until(bound,Position<T>{tree:t,node:slot,rank:0},fn(r)=>r.node==0,
 fn(i)=>fn(r)=>refresh_step<T>(r));
 return result.tree;
}
fn seek_step<T>(r:Position<T>,visible:Bool)->Position<T> {
  let n=r.tree.nodes.at_or(r.node,nil<T>(r.tree.fallback));
  let l=r.tree.nodes.at_or(n.left,nil<T>(r.tree.fallback));
  let before=choose(visible,l.live,l.size);let weight=choose(visible,n.weight,1);
  let next=choose(r.rank<before,n.left,choose(r.rank<before+weight,r.node,n.right));
  let rank=choose(r.rank<before,r.rank,choose(r.rank<before+weight,4294967295,r.rank-before-weight));
  return Position<T>{tree:r.tree,node:next,rank:rank};
}
fn seek<T>(t:Tree<T>,position:u32,visible:Bool)->Position<T> {
 let bound=t.nodes.len();let root=t.root;
 return repeat_until(bound,Position<T>{tree:t,node:root,rank:position},
 fn(r)=>r.node==0 || r.rank==4294967295,
 fn(i)=>fn(r)=>seek_step<T>(r,visible));
}
fn rank_step<T>(r:Position<T>,visible:Bool)->Position<T> {
  let n=r.tree.nodes.at_or(r.node,nil<T>(r.tree.fallback));
  let p=r.tree.nodes.at_or(n.parent,nil<T>(r.tree.fallback));
  let l=r.tree.nodes.at_or(p.left,nil<T>(r.tree.fallback));
  let add=choose(n.parent!=0 && p.right==r.node,choose(visible,l.live+p.weight,l.size+1),0);
  return Position<T>{tree:r.tree,node:n.parent,rank:r.rank+add};
}
fn rank<T>(t:Tree<T>,slot:u32,visible:Bool)->Position<T> {
 if slot==0 {return Position<T>{tree:t,node:0,rank:0};}
 let n=t.nodes.at_or(slot,nil<T>(t.fallback));let l=t.nodes.at_or(n.left,nil<T>(t.fallback));
 let bound=t.nodes.len();let initial=choose(visible,l.live,l.size);
 return repeat_until(bound,Position<T>{tree:t,node:slot,rank:initial},fn(r)=>r.node==0,
 fn(i)=>fn(r)=>rank_step<T>(r,visible));
}
fn rotate<T>(t:Tree<T>,slot:u32)->Tree<T> {
 let n=t.nodes.at_or(slot,nil<T>(t.fallback));let p=t.nodes.at_or(n.parent,nil<T>(t.fallback));
 let left=p.left==slot;let middle=choose(left,n.right,n.left);
 let m=t.nodes.at_or(middle,nil<T>(t.fallback));
 let g=t.nodes.at_or(p.parent,nil<T>(t.fallback));
 let nodes=t.nodes.set(n.parent,links<T>(p,choose(left,middle,p.left),choose(left,p.right,middle),slot,p.previous,p.next));
 let nodes=nodes.set(slot,links<T>(n,choose(left,n.left,n.parent),choose(left,n.parent,n.right),p.parent,n.previous,n.next));
 let nodes=choose(middle==0,nodes,nodes.set(middle,links<T>(m,m.left,m.right,n.parent,m.previous,m.next)));
 let nodes=choose(p.parent==0,nodes,nodes.set(p.parent,links<T>(g,choose(g.left==n.parent,slot,g.left),choose(g.right==n.parent,slot,g.right),g.parent,g.previous,g.next)));
 let t=Tree<T>{nodes:nodes,root:choose(p.parent==0,slot,t.root),first:t.first,last:t.last,fallback:t.fallback};
 return pull<T>(pull<T>(t,n.parent),slot);
}
fn insert_before<T>(t:Tree<T>,before:u32,value:T,weight:u32)->Tree<T> {
 let slot=t.nodes.len();let b=t.nodes.at_or(before,nil<T>(t.fallback));
 let previous=choose(before==0,t.last,b.previous);
 let p=t.nodes.at_or(previous,nil<T>(t.fallback));
 // The predecessor/successor pair determines an empty child without search.
 let parent=choose(before!=0 && b.left==0,before,previous);
 let a=t.nodes.at_or(parent,nil<T>(t.fallback));let as_left=before!=0 && b.left==0;
 let n=Node<T>{value:value,left:0,right:0,parent:parent,previous:previous,next:before,
 priority:priority(slot),size:1,live:weight,weight:weight};
 let nodes=t.nodes.push(n);
 let nodes=choose(previous==0,nodes,nodes.set(previous,links<T>(p,p.left,p.right,p.parent,p.previous,slot)));
 let b=nodes.at_or(before,nil<T>(t.fallback));
 let nodes=choose(before==0,nodes,nodes.set(before,links<T>(b,b.left,b.right,b.parent,slot,b.next)));
 let a=nodes.at_or(parent,nil<T>(t.fallback));
 let nodes=choose(parent==0,nodes,nodes.set(parent,links<T>(a,choose(as_left,slot,a.left),choose(as_left,a.right,slot),a.parent,a.previous,a.next)));
 let t=Tree<T>{nodes:nodes,root:choose(parent==0,slot,t.root),first:choose(previous==0,slot,t.first),last:choose(before==0,slot,t.last),fallback:t.fallback};
 let t=refresh<T>(t,parent);let bound=t.nodes.len();
 let r=repeat_until(bound,Position<T>{tree:t,node:slot,rank:0},
 fn(r)=>r.tree.nodes.at_or(r.node,nil<T>(r.tree.fallback)).parent==0 ||
 r.tree.nodes.at_or(r.node,nil<T>(r.tree.fallback)).priority>=
 r.tree.nodes.at_or(r.tree.nodes.at_or(r.node,nil<T>(r.tree.fallback)).parent,nil<T>(r.tree.fallback)).priority,
 fn(i)=>fn(r)=>Position<T>{tree:rotate<T>(r.tree,r.node),node:r.node,rank:0});
 return r.tree;
}
fn set_weight<T>(t:Tree<T>,slot:u32,weight:u32)->Tree<T> {
 if slot==0 {return t;}
 let n=t.nodes.at_or(slot,nil<T>(t.fallback));
 let nodes=t.nodes.set(slot,measured<T>(n,n.size,n.live,weight));
 return refresh<T>(Tree<T>{nodes:nodes,root:t.root,first:t.first,last:t.last,fallback:t.fallback},slot);
}
fn set_value<T>(t:Tree<T>,slot:u32,value:T)->Tree<T> {
 if slot==0 {return t;}
 let n=t.nodes.at_or(slot,nil<T>(t.fallback));
 let replacement=Node<T>{value:value,left:n.left,right:n.right,parent:n.parent,previous:n.previous,next:n.next,
 priority:n.priority,size:n.size,live:n.live,weight:n.weight};
 return Tree<T>{nodes:t.nodes.set(slot,replacement),root:t.root,first:t.first,last:t.last,fallback:t.fallback};
}
record Read<T>{tree:Tree<T>,slot:u32,output:Buffer<T>,}
fn read_step<T>(r:Read<T>,visible:Bool)->Read<T> {
  let n=r.tree.nodes.at_or(r.slot,nil<T>(r.tree.fallback));
  let out=choose(!visible || n.weight!=0,r.output.push(n.value),r.output);
  return Read<T>{tree:r.tree,slot:n.next,output:out};
}
fn values<T>(t:Tree<T>,visible:Bool)->List<T> {
 let bound=t.nodes.len();let first=t.first;
 let r=repeat_until(bound,Read<T>{tree:t,slot:first,output:Buffer.empty()},fn(r)=>r.slot==0,
 fn(i)=>fn(r)=>read_step<T>(r,visible));
 return r.output.freeze();
}
