module ink.knowledge.sequence_order;
import "blocked_measure_sequence.ink" as sequence;
// Compare positions in a maintained, balanced stable-slot sequence. Equal-depth
// leaves ascend together; the first pair of siblings determines their order.
// No subtree sums or absolute prefix ranks are needed. Invalid/nil handles fail.
record Compared<T>{tree:sequence.Tree<T>,order:i32,valid:Bool,}
record Climb<T>{tree:sequence.Tree<T>,left:u32,right:u32,order:i32,valid:Bool,done:Bool,}
fn ordered(left:u32,right:u32)->i32{return choose(left<right,-1,choose(left==right,0,1));}
fn climbed<T>(c:Climb<T>)->Climb<T>{
 let left=c.tree.blocks.at_or(c.left,sequence.empty_block());
 let right=c.tree.blocks.at_or(c.right,sequence.empty_block());
 if left.parent==0 || right.parent==0{return Climb<T>{..c,done:true};}
 if left.parent==right.parent{return Climb<T>{..c,order:ordered(left.index,right.index),valid:true,done:true};}
 return Climb<T>{..c,left:left.parent,right:right.parent};
}
fn compare<T>(tree:sequence.Tree<T>,left:u32,left_offset:u32,right:u32,right_offset:u32)->Compared<T>{
 let count=tree.nodes.len();
 if left==0 || right==0 || left>=count || right>=count{return Compared<T>{tree:tree,order:0,valid:false};}
 if left==right{return Compared<T>{tree:tree,order:ordered(left_offset,right_offset),valid:true};}
 let a=tree.nodes.at_or(left,sequence.nil<T>(tree.fallback));let b=tree.nodes.at_or(right,sequence.nil<T>(tree.fallback));
 if a.leaf==0 || b.leaf==0{return Compared<T>{tree:tree,order:0,valid:false};}
 if a.leaf==b.leaf{return Compared<T>{tree:tree,order:ordered(a.index,b.index),valid:true};}
 let bound=tree.blocks.len();let c=repeat_until(bound,Climb<T>{tree:tree,left:a.leaf,right:b.leaf,order:0,valid:false,done:false},fn(c)=>c.done,fn(i,c)=>climbed<T>(c));
 return Compared<T>{tree:c.tree,order:c.order,valid:c.valid};
}
