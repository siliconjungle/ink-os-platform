module ink.knowledge.native_event_graph;
import "text_crdts.ink" as reference;
import "slot_text_crdts.ink" as indexed;
import "measured_sequence.ink" as sequence;
import "gap_sequence.ink" as gap;
import "causal_ranges.ink" as causal;

// Positional events with explicit causal frontiers. IDs sequence every event,
// including deletes. This variant also permits an actor to author concurrent
// branches with distinct IDs, matching Diamond Types' author-history interface.
// It does not claim the stricter actor-prefix theorems cover that extension.
record Event{id:u64,parents:List<u64>,position:u32,insert:Bool,value:u32,}
record Applied{insert:Bool,target:u32,}
record Walker{graph:causal.Graph,engine:indexed.Engine,count:u32,slots:Map<u64,u32>,
 applied:Buffer<Applied>,active:Buffer<Bool>,inserted:Buffer<Bool>,deletes:Buffer<u32>,
 actors:Map<u64,u64>,edges:u32,last:u64,error:u32,}
record Find{walker:Walker,slot:u32,}
record Linear{data:gap.Gap<u32>,actors:Map<u64,u64>,previous:u64,error:u32,}

fn empty_event()->Event{return Event{id:0,parents:[],position:0,insert:false,value:0};}
fn empty_applied()->Applied{return Applied{insert:false,target:0};}
fn empty()->Walker{return Walker{graph:causal.empty(),engine:indexed.empty(),count:0,slots:Map.empty(),
 applied:Buffer.empty(),active:Buffer.empty(),inserted:buffer([false]),deletes:buffer([0]),
 actors:Map.empty(),edges:0,last:0,error:0};}
fn with_engine(w:Walker,e:indexed.Engine)->Walker{
 return Walker{graph:w.graph,engine:e,count:w.count,slots:w.slots,applied:w.applied,active:w.active,
 inserted:w.inserted,deletes:w.deletes,actors:w.actors,edges:w.edges,last:w.last,error:w.error};
}
fn failed(w:Walker)->Walker{
 return Walker{graph:w.graph,engine:w.engine,count:w.count,slots:w.slots,applied:w.applied,active:w.active,
 inserted:w.inserted,deletes:w.deletes,actors:w.actors,edges:w.edges,last:w.last,error:4};
}
fn current_weight(w:Walker,slot:u32)->Walker{
 let weight:u32=choose(w.inserted.at_or(slot,false) && w.deletes.at_or(slot,0)==0,1,0);
 let t=sequence.set_weight<u32>(w.engine.tree,slot,weight);
 let e=indexed.Engine{tree:t,atoms:w.engine.atoms,error:w.engine.error};
 return Walker{graph:w.graph,engine:e,count:w.count,slots:w.slots,applied:w.applied,active:w.active,
 inserted:w.inserted,deletes:w.deletes,actors:w.actors,edges:w.edges,last:w.last,error:w.error};
}
fn toggle(w:Walker,at:u32,on:Bool)->Walker{
 let op=w.applied.at_or(at,empty_applied());let slot=op.target;
 let count=w.deletes.at_or(slot,0);
 if slot==0 || (!op.insert && !on && count==0){return failed(w);}
 let inserted=choose(op.insert,w.inserted.set(slot,on),w.inserted);
 let deletes=choose(op.insert,w.deletes,w.deletes.set(slot,choose(on,count+1,count-1)));
 let w=Walker{graph:w.graph,engine:w.engine,count:w.count,slots:w.slots,applied:w.applied,active:w.active.set(at,on),
 inserted:inserted,deletes:deletes,actors:w.actors,edges:w.edges,last:w.last,error:w.error};
 return current_weight(w,slot);
}
record RangeWalk{walker:Walker,index:u32,}
fn retreat_range(w:Walker,r:causal.Range)->Walker{
 let x=repeat_until(r.end-r.start,RangeWalk{walker:w,index:r.end},fn(x)=>x.index<=r.start || x.walker.error!=0,
 fn(i)=>fn(x)=>RangeWalk{walker:toggle(x.walker,x.index-2,false),index:x.index-1});
 return x.walker;
}
fn advance_range(w:Walker,r:causal.Range)->Walker{
 let x=repeat_until(r.end-r.start,RangeWalk{walker:w,index:r.start},fn(x)=>x.index>=r.end || x.walker.error!=0,
 fn(i)=>fn(x)=>RangeWalk{walker:toggle(x.walker,x.index-1,true),index:x.index+1});
 return x.walker;
}
fn prepare(w:Walker,parents:List<u64>)->Walker{
 if (w.last==0 && length(parents)==0) || (w.last!=0 && length(parents)==1 && parents.at_or(0,0)==w.last){return w;}
 var slots:Map<u64,u32>=w.slots;var target:Buffer<u32>=Buffer.empty();
 for parent in parents{target=target.push(slots.get_or(parent,0));slots=slots;}
 let left:List<u32>=choose(w.last==0,[],[slots.get_or(w.last,0)]);
 let d=causal.difference(w.graph,left,target.freeze());let valid=d.valid;
 let removed=d.removed.freeze();let added=d.added.freeze();
 let w=Walker{graph:d.graph,engine:w.engine,count:w.count,slots:slots,applied:w.applied,active:w.active,
 inserted:w.inserted,deletes:w.deletes,actors:w.actors,edges:w.edges,last:w.last,error:w.error};
 if !valid{return failed(w);}
 let w=foldl(removed,w,fn(r)=>fn(w)=>retreat_range(w,r));
 return foldr(added,w,fn(r)=>fn(w)=>advance_range(w,r));
}
fn next_active(f:Find)->Find{
 let next=f.walker.engine.tree.nodes.at_or(f.slot,sequence.nil<u32>(0)).next;
 return Find{walker:f.walker,slot:next};
}
fn valid_id(id:u64,previous:u64)->Bool{
 return reference.actor(id)!=0 && (id & 4294967295)!=0;
}
fn apply(w:Walker,event:Event)->Walker{
 if w.error!=0 || w.engine.error!=0{return w;}
 let actor=reference.actor(event.id);let previous=w.actors.get_or(actor,0);
 if !valid_id(event.id,previous) || w.slots.contains(event.id) || (event.insert && (event.value>=1114112 || (event.value>=55296 && event.value<57344))){return failed(w);}
 let w=prepare(w,event.parents);
 if w.error!=0{return w;}
 let root=w.engine.tree.nodes.at_or(w.engine.tree.root,sequence.nil<u32>(0));
 if event.position>root.live || (!event.insert && event.position==root.live){return failed(w);}
 let r=sequence.seek<u32>(w.engine.tree,choose(event.insert && event.position>0,event.position-1,event.position),true);
 let e=indexed.Engine{tree:r.tree,atoms:w.engine.atoms,error:w.engine.error};
 let w=Walker{graph:w.graph,engine:e,count:w.count,slots:w.slots,applied:w.applied,active:w.active,
 inserted:w.inserted,deletes:w.deletes,actors:w.actors,edges:w.edges,last:w.last,error:w.error};
 let slot=choose(event.insert && event.position==0,0,r.node);
 let target=slot;
 if !event.insert{
  let count=w.deletes.at_or(slot,0);let deletes=w.deletes.set(slot,count+1);
  let e=indexed.delete(w.engine,target);
  let w=Walker{graph:w.graph,engine:e,count:w.count,slots:w.slots,applied:w.applied,active:w.active,inserted:w.inserted,deletes:deletes,actors:w.actors,edges:w.edges,last:w.last,error:w.error};
  return recorded(w,event,Applied{insert:false,target:target});
 }
 let right=choose(slot==0,w.engine.tree.first,w.engine.tree.nodes.at_or(slot,sequence.nil<u32>(0)).next);
 let bound=w.engine.tree.nodes.len();
 let f=repeat_until(bound,Find{walker:w,slot:right},fn(f)=>f.slot==0 || f.walker.inserted.at_or(f.slot,false),fn(i)=>fn(f)=>next_active(f));
 let right=f.slot;
 let atom=indexed.Atom{actor:actor,counter:event.id & 4294967295,left:target,right:right,value:event.value,deleted:false};
 let new_slot=f.walker.engine.tree.nodes.len();let e=indexed.insert(f.walker.engine,atom);
 let w=Walker{graph:f.walker.graph,engine:e,count:f.walker.count,slots:f.walker.slots,applied:f.walker.applied,active:f.walker.active,
 inserted:f.walker.inserted.push(true),deletes:f.walker.deletes.push(0),actors:f.walker.actors,edges:f.walker.edges,last:f.walker.last,error:f.walker.error};
 return recorded(w,event,Applied{insert:true,target:new_slot});
}
fn recorded(w:Walker,event:Event,applied:Applied)->Walker{
 let slot=w.count+1;let actor=reference.actor(event.id);let id=event.id;let edges=w.edges+length(event.parents);
 var slots:Map<u64,u32>=w.slots;var parents:Buffer<u32>=Buffer.empty();
 for parent in event.parents{parents=parents.push(slots.get_or(parent,0));slots=slots;}
 let graph=causal.append(w.graph,parents.freeze());
 return Walker{graph:graph,engine:w.engine,count:slot,slots:slots.set(id,slot),applied:w.applied.push(applied),active:w.active.push(true),
 inserted:w.inserted,deletes:w.deletes,actors:w.actors.set(actor,id),edges:edges,last:id,error:w.error};
}
fn walked(events:List<Event>)->Result<List<u32>,reference.Error>{
 var w:Walker=empty();for event in events{w=apply(w,event);}
 if w.error!=0{return Err(reference.Error.InvalidOperation);}
 return Ok(indexed.finish(w.engine));
}
fn is_linear(events:List<Event>)->Bool{
 var previous:u64=0;var linear:Bool=true;
 for e in events{linear=linear && choose(previous==0,length(e.parents)==0,length(e.parents)==1 && e.parents.at_or(0,0)==previous);previous=e.id;}
 return linear;
}
fn linear_step(s:Linear,e:Event)->Linear{
 let previous=s.actors.get_or(reference.actor(e.id),0);let n=s.data.data.len()-s.data.end+s.data.start;
 if s.error!=0 || !valid_id(e.id,previous) || e.position>n || (!e.insert && e.position==n) ||
 (e.insert && (e.value>=1114112 || (e.value>=55296 && e.value<57344))){return Linear{data:s.data,actors:s.actors,previous:s.previous,error:4};}
 let moved=gap.moved<u32>(s.data,e.position);let changed=choose(e.insert,gap.inserted<u32>(moved,e.value),gap.erased<u32>(moved,1));
 return Linear{data:changed,actors:s.actors.set(reference.actor(e.id),e.id),previous:e.id,error:0};
}
fn linear(events:List<Event>)->Result<List<u32>,reference.Error>{
 var s:Linear=Linear{data:gap.empty<u32>(0),actors:Map.empty(),previous:0,error:0};
 for event in events{s=linear_step(s,event);}
 if s.error!=0{return Err(reference.Error.InvalidOperation);}
 return Ok(gap.freeze<u32>(s.data));
}
fn materialize(events:List<Event>)->Result<List<u32>,reference.Error>{
 return choose(is_linear(events),linear(events),walked(events));
}
