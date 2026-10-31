module ink.knowledge.tagged_run_causal_workspace;
import "word_priority_queue.ink" as heap;

// Run-compressed append-only DAG. Logical versions remain stable when a
// direct-descendant chain extends its final run. Query flags are sparse and
// invocation-local; no per-version mark array is retained.
// This ordinary source alternative still needs its full preservation bridge.
record Node{base:u32,parent:u32,second:u32,frontier:u32,}
record Entry{start:u32,end:u32,parent:u32,second:u32,frontier:u32,}
record Range{start:u32,end:u32,}
record Graph{entries:Buffer<Entry>,next:u32,frontiers:Buffer<List<u32>>,
 queue:Buffer<u64>,removed:Buffer<Range>,added:Buffer<Range>,valid:Bool,}
record Read{entries:List<Entry>,frontiers:List<List<u32>>,}
record Work{bound:u32,queue:Buffer<u64>,shared:u32,
 removed:Buffer<Range>,added:Buffer<Range>,valid:Bool,}
record Search{low:u32,high:u32,}
record Difference{graph:Graph,removed:Buffer<Range>,added:Buffer<Range>,valid:Bool,}
record Run{work:Work,version:u32,flag:u32,base:u32,}
fn nil()->Node{return Node{base:0,parent:0,second:0,frontier:0};}
fn empty()->Graph{return Graph{entries:Buffer.empty(),next:1,frontiers:buffer([[]]),queue:Buffer.empty(),removed:Buffer.empty(),added:Buffer.empty(),valid:true};}
fn chain(count:u32)->Graph{
 if count==0{return empty();}
 return Graph{entries:buffer([Entry{start:1,end:count+1,parent:0,second:0,frontier:0}]),next:count+1,frontiers:buffer([[]]),queue:Buffer.empty(),removed:Buffer.empty(),added:Buffer.empty(),valid:count<4294967295};
}
fn searched(s:Search,entries:List<Entry>,version:u32)->Search{
 let middle=s.low+wrapping_shr(s.high-s.low,1);
 let e=entries.at_or(middle,Entry{start:0,end:0,parent:0,second:0,frontier:0});
 return choose(e.start<=version,Search{low:middle+1,high:s.high},Search{low:s.low,high:middle});
}
fn read_node(read:Read,version:u32)->Node{
 let entries=read.entries;let count=length(entries);
 let s=repeat_until(32,Search{low:0,high:count},fn(s)=>s.low>=s.high,fn(i,s)=>searched(s,entries,version));
 if s.low==0{return nil();}
 let e=entries.at_or(s.low-1,Entry{start:0,end:0,parent:0,second:0,frontier:0});
 if version>=e.end{return nil();}
 let first=version==e.start;
 return Node{base:e.start,parent:choose(first,e.parent,version-1),second:choose(first,e.second,0),frontier:choose(first,e.frontier,0)};
}
fn append(g:Graph,parents:List<u32>)->Graph{
 let slot=g.next;let count=length(parents);let parent=parents.at_or(0,0);
 let valid=g.valid && slot<4294967295 && foldl(parents,true,fn(p,ok)=>ok && p>0 && p<slot);
 let size=g.entries.len();let previous=g.entries.at_or(size-1,Entry{start:0,end:0,parent:0,second:0,frontier:0});
 if size!=0 && count==1 && parent==slot-1 && previous.end==slot{
  return Graph{..g,entries:g.entries.set(size-1,Entry{..previous,end:slot+1}),next:slot+1,valid:valid};
 }
 let frontier=choose(count>2,g.frontiers.len(),0);
 let frontiers=choose(count>2,g.frontiers.push(parents),g.frontiers);
 let entry=Entry{start:slot,end:slot+1,parent:choose(count<=2,parent,0),second:choose(count==2,parents.at_or(1,0),0),frontier:frontier};
 return Graph{..g,entries:g.entries.push(entry),next:slot+1,frontiers:frontiers,valid:valid};
}
// Keep each queue item's colour alongside its version. Equal versions are
// combined while removing a run, avoiding a separate visited-flags map.
fn read_version(item:u64)->u32{return word_narrow_u64_to_u32(wrapping_shr(item,2));}
fn read_flag(item:u64)->u32{return word_narrow_u64_to_u32(item & 3);}
fn enq(w:Work,version:u32,added:u32)->Work{
 if version==0 || version>=w.bound{return Work{..w,valid:false};}
 let item=wrapping_shl(word_widen_u32_to_u64(version),2)|word_widen_u32_to_u64(added);
 return Work{..w,queue:heap.push(w.queue,item),shared:w.shared+choose(added==3,1,0)};
}
fn mark(w:Work,start:u32,end:u32,flag:u32)->Work{
 if start>=end || flag==3{return w;}
 let range=Range{start:start,end:end};
 return Work{..w,removed:choose(flag==1,w.removed.push(range),w.removed),added:choose(flag==2,w.added.push(range),w.added)};
}
fn consume(r:Run)->Run{
 let item=r.work.queue.at_or(0,0);let version=read_version(item);let flag=read_flag(item);
 let w=r.work;let shared=w.shared-choose(flag==3,1,0);let w=Work{..w,queue:heap.pop(w.queue),shared:shared};
 let w=choose(flag!=r.flag,mark(w,version+1,r.version+1,r.flag),w);
 return Run{work:w,version:choose(flag!=r.flag,version,r.version),flag:choose(flag!=r.flag,3,r.flag),base:r.base};
}
fn step(w:Work,read:Read)->Work{
 let item=w.queue.at_or(0,0);let version=read_version(item);let flag=read_flag(item);
 let node=read_node(read,version);let base=node.base;let bound=w.queue.len();
 let w=Work{..w,queue:heap.pop(w.queue),shared:w.shared-choose(flag==3,1,0)};
 let r=repeat_until(bound,Run{work:w,version:version,flag:flag,base:base},fn(r)=>r.work.queue.len()==0 || read_version(r.work.queue.at_or(0,0))<r.base,fn(i,r)=>consume(r));
 let node=read_node(read,base);let flag=r.flag;
 let w=mark(r.work,base,r.version+1,flag);
 if node.frontier==0{
  let w=choose(node.parent==0,w,enq(w,node.parent,flag));
  return choose(node.second==0,w,enq(w,node.second,flag));
 }
 let parents=read.frontiers.at_or(node.frontier,[]);
 return foldl(parents,w,fn(parent,w)=>enq(w,parent,flag));
}
fn difference(g:Graph,left:List<u32>,right:List<u32>)->Difference{
 let bound=g.next;let valid=g.valid;
 let queue=g.queue.truncate(0);let removed=g.removed.truncate(0);let added=g.added.truncate(0);
 let graph_valid=g.valid;let read=Read{entries:g.entries.freeze(),frontiers:g.frontiers.freeze()};
 var w:Work=Work{bound:bound,queue:queue,shared:0,removed:removed,added:added,valid:valid};
 for p in left{w=enq(w,p,1);}for p in right{w=enq(w,p,2);}
 let w=repeat_until(bound,w,fn(w)=>!w.valid || w.queue.len()<=w.shared,fn(i,w)=>step(w,read));
 let g=Graph{entries:buffer(read.entries),next:bound,frontiers:buffer(read.frontiers),queue:w.queue,removed:Buffer.empty(),added:Buffer.empty(),valid:graph_valid};
 return Difference{graph:g,removed:w.removed,added:w.added,valid:w.valid};
}
fn recycled(g:Graph,removed:Buffer<Range>,added:Buffer<Range>)->Graph{
 return Graph{..g,removed:removed,added:added};
}
