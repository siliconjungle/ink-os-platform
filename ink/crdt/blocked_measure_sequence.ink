module ink.knowledge.blocked_measure_sequence;
// General stable-slot sequence with three independent additive measures.
// Leaves and branches have at most 32 children. Splits preserve stable item IDs.
// This is ordinary source, not a compiler primitive or an admitted rewrite.
record Node<T>{value:T,previous:u32,next:u32,leaf:u32,index:u32,extent:u32,weight:u32,weight2:u32,}
record Block{start:u32,count:u32,parent:u32,index:u32,leaf:Bool,size:u32,live:u32,second:u32,}
record Tree<T>{nodes:Buffer<Node<T>>,blocks:Buffer<Block>,children:Buffer<u32>,root:u32,first:u32,last:u32,fallback:T,}
record Position<T>{tree:Tree<T>,node:u32,rank:u32,offset:u32,}
fn nil<T>(value:T)->Node<T>{return Node<T>{value:value,previous:0,next:0,leaf:0,index:0,extent:0,weight:0,weight2:0};}
fn empty_block()->Block{return Block{start:0,count:0,parent:0,index:0,leaf:true,size:0,live:0,second:0};}
fn empty<T>(value:T)->Tree<T>{let blocks:Buffer<Block>=Buffer.empty();return Tree<T>{nodes:buffer([nil<T>(value)]),blocks:blocks.push(empty_block()).push(Block{..empty_block(),start:33}),children:buffer_fill(66,0),root:1,first:0,last:0,fallback:value};}
fn measured(n:Block,measure:u32)->u32{return choose(measure==1,n.live,choose(measure==2,n.second,n.size));}
fn item_measure<T>(n:Node<T>,measure:u32)->u32{return choose(measure==1,n.weight,choose(measure==2,n.weight2,n.extent));}
fn total<T>(t:Tree<T>,measure:u32)->u32{return measured(t.blocks.at_or(t.root,empty_block()),measure);}
record Sum<T>{tree:Tree<T>,block:u32,index:u32,size:u32,live:u32,second:u32,}
fn sum_step<T>(s:Sum<T>)->Sum<T>{
 let b=s.tree.blocks.at_or(s.block,empty_block());let slot=s.tree.children.at_or(b.start+s.index,0);
 let n=s.tree.nodes.at_or(slot,nil<T>(s.tree.fallback));let c=s.tree.blocks.at_or(slot,empty_block());
 return Sum<T>{..s,index:s.index+1,size:s.size+choose(b.leaf,n.extent,c.size),live:s.live+choose(b.leaf,n.weight,c.live),second:s.second+choose(b.leaf,n.weight2,c.second)};
}
fn pull<T>(t:Tree<T>,slot:u32)->Tree<T>{
 let b=t.blocks.at_or(slot,empty_block());let count=b.count;
 let s=repeat_until(count,Sum<T>{tree:t,block:slot,index:0,size:0,live:0,second:0},fn(s)=>false,fn(i,s)=>sum_step<T>(s));
 let t=s.tree;return Tree<T>{..t,blocks:t.blocks.set(slot,Block{..b,size:s.size,live:s.live,second:s.second})};
}
record Adjust<T>{tree:Tree<T>,block:u32,old_size:u32,old_live:u32,old_second:u32,size:u32,live:u32,second:u32,}
fn adjust_step<T>(a:Adjust<T>)->Adjust<T>{
 let b=a.tree.blocks.at_or(a.block,empty_block());let parent=b.parent;
 let b=Block{..b,size:b.size-a.old_size+a.size,live:b.live-a.old_live+a.live,second:b.second-a.old_second+a.second};
 let t=a.tree;return Adjust<T>{..a,tree:Tree<T>{..t,blocks:t.blocks.set(a.block,b)},block:parent};
}
fn adjusted<T>(t:Tree<T>,block:u32,old_size:u32,old_live:u32,old_second:u32,size:u32,live:u32,second:u32)->Tree<T>{
 let bound=t.blocks.len();let a=repeat_until(bound,Adjust<T>{tree:t,block:block,old_size:old_size,old_live:old_live,old_second:old_second,size:size,live:live,second:second},fn(a)=>a.block==0,fn(i,a)=>adjust_step<T>(a));return a.tree;
}
record Indexed<T>{tree:Tree<T>,block:u32,index:u32,}
fn index_step<T>(s:Indexed<T>)->Indexed<T>{
 let b=s.tree.blocks.at_or(s.block,empty_block());let slot=s.tree.children.at_or(b.start+s.index,0);let t=s.tree;
 if b.leaf{let n=t.nodes.at_or(slot,nil<T>(t.fallback));return Indexed<T>{tree:Tree<T>{..t,nodes:t.nodes.set(slot,Node<T>{..n,leaf:s.block,index:s.index})},block:s.block,index:s.index+1};}
 let c=t.blocks.at_or(slot,empty_block());return Indexed<T>{tree:Tree<T>{..t,blocks:t.blocks.set(slot,Block{..c,parent:s.block,index:s.index})},block:s.block,index:s.index+1};
}
fn indexed<T>(t:Tree<T>,block:u32)->Tree<T>{
 let bound=t.blocks.at_or(block,empty_block()).count;
 let s=repeat_until(bound,Indexed<T>{tree:t,block:block,index:0},fn(s)=>false,fn(i,s)=>index_step<T>(s));return s.tree;
}
fn added_child<T>(t:Tree<T>,block:u32,index:u32,child:u32)->Tree<T>{
 let b=t.blocks.at_or(block,empty_block());let children=t.children.copy_within(b.start+index,b.start+index+1,b.count-index).set(b.start+index,child);
 let t=Tree<T>{..t,blocks:t.blocks.set(block,Block{..b,count:b.count+1}),children:children};return indexed<T>(t,block);
}
record Splitting<T>{tree:Tree<T>,block:u32,}
fn split_step<T>(s:Splitting<T>)->Splitting<T>{
 let b=s.tree.blocks.at_or(s.block,empty_block());if b.count<=32{return Splitting<T>{tree:s.tree,block:0};}
 let t=s.tree;let right=t.blocks.len();let count=b.count;let parent=b.parent;let index=b.index;
 let start=t.children.len();let children=t.children.append(buffer_fill(33,0)).copy_within(b.start+16,start,count-16);
 let r=Block{..b,start:start,count:count-16,index:index+1,size:0,live:0,second:0};
 let l=Block{..b,count:16,size:0,live:0,second:0};
 let t=Tree<T>{..t,blocks:t.blocks.set(s.block,l).push(r),children:children};
 let t=pull<T>(pull<T>(indexed<T>(indexed<T>(t,s.block),right),s.block),right);
 if parent!=0{return Splitting<T>{tree:added_child<T>(t,parent,index+1,right),block:parent};}
 let root=t.blocks.len();let start=t.children.len();let children=t.children.append(buffer_fill(33,0)).set(start,s.block).set(start+1,right);
 let t=Tree<T>{..t,blocks:t.blocks.push(Block{start:start,count:2,parent:0,index:0,leaf:false,size:0,live:0,second:0}),children:children,root:root};
 return Splitting<T>{tree:pull<T>(indexed<T>(t,root),root),block:0};
}
fn insert_before<T>(t:Tree<T>,before:u32,value:T,extent:u32,weight:u32,weight2:u32)->Tree<T>{
 let slot=t.nodes.len();let next=t.nodes.at_or(before,nil<T>(t.fallback));let previous=choose(before==0,t.last,next.previous);
 let prior=t.nodes.at_or(previous,nil<T>(t.fallback));
 let leaf=choose(before!=0,next.leaf,choose(previous!=0,prior.leaf,t.root));
 let b=t.blocks.at_or(leaf,empty_block());let index=choose(before!=0,next.index,b.count);
 let nodes=t.nodes.push(Node<T>{value:value,previous:previous,next:before,leaf:leaf,index:index,extent:extent,weight:weight,weight2:weight2});
 let nodes=choose(previous==0,nodes,nodes.set(previous,Node<T>{..prior,next:slot}));
 let next=nodes.at_or(before,nil<T>(t.fallback));let nodes=choose(before==0,nodes,nodes.set(before,Node<T>{..next,previous:slot}));
 let t=Tree<T>{..t,nodes:nodes,first:choose(previous==0,slot,t.first),last:choose(before==0,slot,t.last)};
 let t=adjusted<T>(added_child<T>(t,leaf,index,slot),leaf,0,0,0,extent,weight,weight2);let bound=t.blocks.len()+1;
 let s=repeat_until(bound,Splitting<T>{tree:t,block:leaf},fn(s)=>s.block==0,fn(i,s)=>split_step<T>(s));return s.tree;
}
fn set_extent<T>(t:Tree<T>,slot:u32,extent:u32,weight:u32,weight2:u32)->Tree<T>{
 if slot==0{return t;}let n=t.nodes.at_or(slot,nil<T>(t.fallback));let leaf=n.leaf;
 let t=Tree<T>{..t,nodes:t.nodes.set(slot,Node<T>{..n,extent:extent,weight:weight,weight2:weight2})};
 return adjusted<T>(t,leaf,n.extent,n.weight,n.weight2,extent,weight,weight2);
}
fn set_weights<T>(t:Tree<T>,slot:u32,weight:u32,weight2:u32)->Tree<T>{let n=t.nodes.at_or(slot,nil<T>(t.fallback));return set_extent<T>(t,slot,n.extent,weight,weight2);}
fn set_weight<T>(t:Tree<T>,slot:u32,weight:u32)->Tree<T>{let n=t.nodes.at_or(slot,nil<T>(t.fallback));return set_extent<T>(t,slot,n.extent,weight,n.weight2);}
fn set_second<T>(t:Tree<T>,slot:u32,weight:u32)->Tree<T>{let n=t.nodes.at_or(slot,nil<T>(t.fallback));return set_extent<T>(t,slot,n.extent,n.weight,weight);}
fn set_value<T>(t:Tree<T>,slot:u32,value:T)->Tree<T>{if slot==0{return t;}let n=t.nodes.at_or(slot,nil<T>(t.fallback));return Tree<T>{..t,nodes:t.nodes.set(slot,Node<T>{..n,value:value})};}
record Seeking<T>{tree:Tree<T>,block:u32,index:u32,position:u32,node:u32,offset:u32,done:Bool,}
fn seek_step<T>(s:Seeking<T>,measure:u32)->Seeking<T>{
 let b=s.tree.blocks.at_or(s.block,empty_block());if s.index>=b.count{return Seeking<T>{..s,done:true};}
 let slot=s.tree.children.at_or(b.start+s.index,0);let n=s.tree.nodes.at_or(slot,nil<T>(s.tree.fallback));let c=s.tree.blocks.at_or(slot,empty_block());
 let weight=choose(b.leaf,item_measure<T>(n,measure),measured(c,measure));
 if s.position>=weight{return Seeking<T>{..s,index:s.index+1,position:s.position-weight};}
 return choose(b.leaf,Seeking<T>{..s,node:slot,offset:s.position,done:true},Seeking<T>{..s,block:slot,index:0});
}
fn seek_measure<T>(t:Tree<T>,position:u32,measure:u32)->Position<T>{
 let root=t.root;let count=t.blocks.len();let bound=choose(count>130150524,4294967295,count*33);let s=repeat_until(bound,Seeking<T>{tree:t,block:root,index:0,position:position,node:0,offset:0,done:false},fn(s)=>s.done,fn(i,s)=>seek_step<T>(s,measure));
 return Position<T>{tree:s.tree,node:s.node,rank:choose(s.node!=0,4294967295,s.position),offset:s.offset};
}
record Ranking<T>{tree:Tree<T>,block:u32,index:u32,rank:u32,}
fn rank_step<T>(s:Ranking<T>,measure:u32)->Ranking<T>{
 let b=s.tree.blocks.at_or(s.block,empty_block());
 if s.index==0{return Ranking<T>{..s,block:b.parent,index:b.index};}
 let index=s.index-1;let slot=s.tree.children.at_or(b.start+index,0);let n=s.tree.nodes.at_or(slot,nil<T>(s.tree.fallback));let c=s.tree.blocks.at_or(slot,empty_block());
 return Ranking<T>{..s,index:index,rank:s.rank+choose(b.leaf,item_measure<T>(n,measure),measured(c,measure))};
}
fn rank_measure<T>(t:Tree<T>,slot:u32,measure:u32)->Position<T>{
 if slot==0{return Position<T>{tree:t,node:0,rank:0,offset:0};}
 let n=t.nodes.at_or(slot,nil<T>(t.fallback));let count=t.blocks.len();let bound=choose(count>130150524,4294967295,count*33);
 let s=repeat_until(bound,Ranking<T>{tree:t,block:n.leaf,index:n.index,rank:0},fn(s)=>s.block==0,fn(i,s)=>rank_step<T>(s,measure));
 return Position<T>{tree:s.tree,node:0,rank:s.rank,offset:0};
}
fn seek<T>(t:Tree<T>,position:u32,visible:Bool)->Position<T>{return seek_measure<T>(t,position,choose(visible,1,0));}
fn rank<T>(t:Tree<T>,slot:u32,visible:Bool)->Position<T>{return rank_measure<T>(t,slot,choose(visible,1,0));}
record Read<T>{tree:Tree<T>,node:u32,values:Buffer<T>,}
fn read_step<T>(r:Read<T>,visible:Bool)->Read<T>{let n=r.tree.nodes.at_or(r.node,nil<T>(r.tree.fallback));return Read<T>{tree:r.tree,node:n.next,values:choose(!visible || n.weight!=0,r.values.push(n.value),r.values)};}
fn values<T>(t:Tree<T>,visible:Bool)->List<T>{let first=t.first;let bound=t.nodes.len();let r=repeat_until(bound,Read<T>{tree:t,node:first,values:Buffer.empty()},fn(r)=>r.node==0,fn(i,r)=>read_step<T>(r,visible));return r.values.freeze();}
