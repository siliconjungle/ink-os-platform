module ink.knowledge.causal_ranges;
import "priority_queue.ink" as heap;
// Append-only DAG, one-based topological slots, with maximal single-parent
// contiguous runs. This is reusable graph machinery, independent of text.
record Node{parents:List<u32>,base:u32,}
record Graph{nodes:Buffer<Node>,valid:Bool,}
record Range{start:u32,end:u32,}
record Difference{graph:Graph,queue:Buffer<u32>,flags:Map<u32,u32>,shared:u32,
 removed:Buffer<Range>,added:Buffer<Range>,valid:Bool,}
record Run{diff:Difference,version:u32,flag:u32,base:u32,}
fn nil()->Node{return Node{parents:[],base:0};}
fn empty()->Graph{return Graph{nodes:buffer([nil()]),valid:true};}
fn append(g:Graph,parents:List<u32>)->Graph{
 let slot=g.nodes.len();let previous=g.nodes.at_or(slot-1,nil());
 let base=choose(length(parents)==1 && parents.at_or(0,0)==slot-1,previous.base,slot);
 let valid=g.valid && foldl(parents,true,fn(p)=>fn(ok)=>ok && p>0 && p<slot);
 return Graph{nodes:g.nodes.push(Node{parents:parents,base:base}),valid:valid};
}
fn enq(d:Difference,version:u32,flag:u32)->Difference{
 if version==0 || version>=d.graph.nodes.len(){return Difference{graph:d.graph,queue:d.queue,flags:d.flags,shared:d.shared,removed:d.removed,added:d.added,valid:false};}
 let current=d.flags.get_or(version,0);
 if current==0{
  return Difference{graph:d.graph,queue:heap.push(d.queue,version),flags:d.flags.set(version,flag),shared:d.shared+choose(flag==3,1,0),removed:d.removed,added:d.added,valid:d.valid};
 }
 let changed=current!=flag && current!=3;
 return Difference{graph:d.graph,queue:d.queue,flags:d.flags.set(version,choose(changed,3,current)),shared:d.shared+choose(changed,1,0),removed:d.removed,added:d.added,valid:d.valid};
}
fn mark(d:Difference,start:u32,end:u32,flag:u32)->Difference{
 if start>=end || flag==3{return d;}
 let range=Range{start:start,end:end};
 return Difference{graph:d.graph,queue:d.queue,flags:d.flags,shared:d.shared,
 removed:choose(flag==1,d.removed.push(range),d.removed),added:choose(flag==2,d.added.push(range),d.added),valid:d.valid};
}
fn consume(r:Run)->Run{
 let version=r.diff.queue.at_or(0,0);let flag=r.diff.flags.get_or(version,0);
 let shared=r.diff.shared-choose(flag==3,1,0);
 let d=Difference{graph:r.diff.graph,queue:heap.pop(r.diff.queue),flags:r.diff.flags,shared:shared,removed:r.diff.removed,added:r.diff.added,valid:r.diff.valid};
 let d=choose(flag!=r.flag,mark(d,version+1,r.version+1,r.flag),d);
 return Run{diff:d,version:choose(flag!=r.flag,version,r.version),flag:choose(flag!=r.flag,3,r.flag),base:r.base};
}
fn step(d:Difference)->Difference{
 let version=d.queue.at_or(0,0);let flag=d.flags.get_or(version,0);
 let node=d.graph.nodes.at_or(version,nil());let base=node.base;
 let bound=d.queue.len();
 let d=Difference{graph:d.graph,queue:heap.pop(d.queue),flags:d.flags,shared:d.shared-choose(flag==3,1,0),removed:d.removed,added:d.added,valid:d.valid};
 let r=repeat_until(bound,Run{diff:d,version:version,flag:flag,base:base},
  fn(r)=>r.diff.queue.len()==0 || r.diff.queue.at_or(0,0)<r.base,fn(i)=>fn(r)=>consume(r));
 let parents=r.diff.graph.nodes.at_or(base,nil()).parents;
 var d:Difference=mark(r.diff,base,r.version+1,r.flag);
 for parent in parents{d=enq(d,parent,r.flag);}
 return d;
}
fn difference(g:Graph,left:List<u32>,right:List<u32>)->Difference{
 let valid=g.valid;let bound=g.nodes.len();
 var d:Difference=Difference{graph:g,queue:Buffer.empty(),flags:Map.empty(),shared:0,removed:Buffer.empty(),added:Buffer.empty(),valid:valid};
 for p in left{d=enq(d,p,1);}for p in right{d=enq(d,p,2);}
 return repeat_until(bound,d,fn(d)=>!d.valid || d.queue.len()<=d.shared,fn(i)=>fn(d)=>step(d));
}
