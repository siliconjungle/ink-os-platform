module ink.knowledge.measure_successor;
import "blocked_measure_sequence.ink" as sequence;
// First positive-measure item after a stable slot. A short local scan handles
// nearby items; rank/select skips longer zero-measure stretches. This requires
// the sequence constructors' maintained measures and links, like seek/rank.
record Located<T>{tree:sequence.Tree<T>,node:u32,}
fn advanced<T>(x:Located<T>)->Located<T>{
 let next=x.tree.nodes.at_or(x.node,sequence.nil<T>(x.tree.fallback)).next;
 return Located<T>{tree:x.tree,node:next};
}
fn after<T>(tree:sequence.Tree<T>,slot:u32,measure:u32)->Located<T>{
 let next=choose(slot==0,tree.first,tree.nodes.at_or(slot,sequence.nil<T>(tree.fallback)).next);
 let x=repeat_until(4,Located<T>{tree:tree,node:next},fn(x)=>x.node==0 || sequence.item_measure<T>(x.tree.nodes.at_or(x.node,sequence.nil<T>(x.tree.fallback)),measure)!=0,fn(i,x)=>advanced<T>(x));
 if x.node==0 || sequence.item_measure<T>(x.tree.nodes.at_or(x.node,sequence.nil<T>(x.tree.fallback)),measure)!=0{return x;}
 let n=x.tree.nodes.at_or(slot,sequence.nil<T>(x.tree.fallback));
 let extent=choose(slot==0,0,sequence.item_measure<T>(n,measure));
 let p=sequence.rank_measure<T>(x.tree,slot,measure);
 if p.rank>4294967295-extent{
  let bound=p.tree.nodes.len();return repeat_until(bound,Located<T>{tree:p.tree,node:x.node},fn(x)=>x.node==0 || sequence.item_measure<T>(x.tree.nodes.at_or(x.node,sequence.nil<T>(x.tree.fallback)),measure)!=0,fn(i,x)=>advanced<T>(x));
 }
 let found=sequence.seek_measure<T>(p.tree,p.rank+extent,measure);
 return Located<T>{tree:found.tree,node:found.node};
}
