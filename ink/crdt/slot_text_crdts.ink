module ink.knowledge.slot_text_crdts;
import "measured_sequence.ink" as sequence;
// Stable local handles eliminate repeated external-ID lookups during causal
// walking. External IDs are still validated by the event-graph library.
record Atom{actor:u64,counter:u64,left:u32,right:u32,value:u32,deleted:Bool,}
record Engine{tree:sequence.Tree<u32>,atoms:Buffer<Atom>,error:u32,}
record Located{engine:Engine,rank:u32,}
record Scan{engine:Engine,left:u32,right:u32,parent:u32,current:u32,destination:u32,scanning:Bool,done:Bool,}
fn nil()->Atom{return Atom{actor:0,counter:0,left:0,right:0,value:0,deleted:true};}
fn empty()->Engine{return Engine{tree:sequence.empty<u32>(0),atoms:buffer([nil()]),error:0};}
fn located(e:Engine,slot:u32,right:Bool)->Located{
 if slot==0{let rank=choose(right,e.tree.nodes.len(),0);return Located{engine:e,rank:rank};}
 let p=sequence.rank<u32>(e.tree,slot,false);
 return Located{engine:Engine{tree:p.tree,atoms:e.atoms,error:e.error},rank:p.rank+1};
}
fn scan_step(s:Scan,atom:Atom)->Scan{
 let destination=choose(s.scanning,s.destination,s.current);
 if s.current==0 || s.current==s.right{return Scan{engine:s.engine,left:s.left,right:s.right,parent:s.parent,current:s.current,destination:destination,scanning:s.scanning,done:true};}
 let n=s.engine.tree.nodes.at_or(s.current,sequence.nil<u32>(0));let other=s.engine.atoms.at_or(s.current,nil());
 let left=located(s.engine,other.left,false);let oleft=left.rank;
 let right=located(left.engine,other.right,true);let oright=right.rank;
 let target=s.parent;
 let tie=atom.actor<other.actor || (atom.actor==other.actor && atom.counter<other.counter);
 let done=oleft<s.left || (oleft==s.left && oright==target && tie);
 let scanning=choose(oleft!=s.left,s.scanning,oright<target);
 return Scan{engine:right.engine,left:s.left,right:s.right,parent:s.parent,current:n.next,destination:destination,scanning:scanning,done:done};
}
fn insert(e:Engine,atom:Atom)->Engine{
 let l=located(e,atom.left,false);let left=l.rank;let r=located(l.engine,atom.right,true);let parent=r.rank;
 let current=choose(atom.left==0,r.engine.tree.first,r.engine.tree.nodes.at_or(atom.left,sequence.nil<u32>(0)).next);
 let bound=r.engine.tree.nodes.len();
 let s=repeat_until(bound,Scan{engine:r.engine,left:left,right:atom.right,parent:parent,current:current,destination:current,scanning:false,done:false},fn(s)=>s.done,fn(i)=>fn(s)=>scan_step(s,atom));
 let slot=s.engine.tree.nodes.len();
 return Engine{tree:sequence.insert_before<u32>(s.engine.tree,s.destination,slot,1),atoms:s.engine.atoms.push(atom),error:s.engine.error};
}
fn delete(e:Engine,slot:u32)->Engine{
 let a=e.atoms.at_or(slot,nil());
 let a=Atom{actor:a.actor,counter:a.counter,left:a.left,right:a.right,value:a.value,deleted:true};
 return Engine{tree:sequence.set_weight<u32>(e.tree,slot,0),atoms:e.atoms.set(slot,a),error:e.error};
}
record Output{atoms:Buffer<Atom>,values:Buffer<u32>,}
fn finish(e:Engine)->List<u32>{
 let slots=sequence.values<u32>(e.tree,false);
 var o:Output=Output{atoms:e.atoms,values:Buffer.empty()};
 for slot in slots{let a=o.atoms.at_or(slot,nil());o=Output{atoms:o.atoms,values:choose(a.deleted,o.values,o.values.push(a.value))};}
 return o.values.freeze();
}
