module ink.knowledge.batched_event_graph;
import "native_event_graph.ink" as graph;
import "text_crdts.ink" as reference;
import "gap_sequence.ink" as gap;
// A batch is a contiguous, nonempty actor event interval. Deletes come first
// at one position, then insertion codepoints at increasing positions. Only its
// first event carries the external parent frontier; the rest form a chain.
record Change{id:u64,parents:List<u64>,position:u32,remove:u32,text:List<u32>,}
record Linear{data:gap.Gap<u32>,actors:Map<u64,u64>,error:u32,}
record Expansion{events:Buffer<graph.Event>,parents:List<u64>,position:u32,next:u64,previous:u64,index:u32,}
fn width(c:Change)->u64{return word_widen_u32_to_u64(c.remove)+word_widen_u32_to_u64(length(c.text));}
fn valid(c:Change)->Bool{let n=width(c);return reference.actor(c.id)!=0 && (c.id & 4294967295)!=0 && n>0 && n<=4294967295 && (c.id & 4294967295)+n-1<=4294967295;}
fn is_linear(changes:List<Change>)->Bool{
 var previous:u64=0;var result:Bool=true;
 for c in changes{result=result && valid(c) && choose(previous==0,length(c.parents)==0,length(c.parents)==1 && c.parents.at_or(0,0)==previous);previous=c.id+width(c)-1;}
 return result;
}
fn write(s:Linear,value:u32)->Linear{return Linear{data:gap.inserted<u32>(s.data,value),actors:s.actors,error:s.error};}
fn linear_step(s:Linear,c:Change)->Linear{
 if s.error!=0{return s;}
 let actor=reference.actor(c.id);let previous=s.actors.get_or(actor,0);let n=s.data.data.len()-s.data.end+s.data.start;
 let codes=foldl(c.text,true,fn(value)=>fn(ok)=>ok && value<1114112 && !(value>=55296 && value<57344));
 if !valid(c) || (c.id & 4294967295)!=previous+1 || c.position>n || c.remove>n-c.position || !codes{return Linear{data:s.data,actors:s.actors,error:4};}
 let data=gap.erased<u32>(gap.moved<u32>(s.data,c.position),c.remove);
 return Linear{data:gap.inserted_many<u32>(data,c.text),actors:s.actors.set(actor,(c.id & 4294967295)+width(c)-1),error:0};
}
fn linear(changes:List<Change>)->Result<List<u32>,reference.Error>{
 var s:Linear=Linear{data:gap.empty<u32>(0),actors:Map.empty(),error:0};for c in changes{s=linear_step(s,c);}
 return choose(s.error==0,Ok(gap.freeze<u32>(s.data)),Err(reference.Error.InvalidOperation));
}
fn deleted(e:Expansion)->Expansion{
 let next=e.next;let position=e.position;
 let parents=choose(e.previous==0,e.parents,[e.previous]);let event=graph.Event{id:next,parents:parents,position:position,insert:false,value:0};
 return Expansion{events:e.events.push(event),parents:e.parents,position:position,next:next+1,previous:next,index:0};
}
fn inserted(e:Expansion,value:u32)->Expansion{
 let next=e.next;let position=e.position;let index=e.index;
 let parents=choose(e.previous==0,e.parents,[e.previous]);let event=graph.Event{id:next,parents:parents,position:position+index,insert:true,value:value};
 return Expansion{events:e.events.push(event),parents:e.parents,position:position,next:next+1,previous:next,index:index+1};
}
fn expanded(events:Buffer<graph.Event>,c:Change)->Buffer<graph.Event>{
 let n=c.remove;let id=c.id;let position=c.position;let parents=c.parents;let text=c.text;
 let e=repeat_until(n,Expansion{events:events,parents:parents,position:position,next:id,previous:0,index:0},fn(e)=>false,fn(i)=>fn(e)=>deleted(e));
 let e=foldl(text,e,fn(value)=>fn(e)=>inserted(e,value));return e.events;
}
fn expand(changes:List<Change>)->List<graph.Event>{var events:Buffer<graph.Event>=Buffer.empty();for c in changes{events=expanded(events,c);}return events.freeze();}
fn materialize(changes:List<Change>)->Result<List<u32>,reference.Error>{
 if !foldl(changes,true,fn(c)=>fn(ok)=>ok && valid(c)){return Err(reference.Error.InvalidOperation);}
 return choose(is_linear(changes),linear(changes),graph.walked(expand(changes)));
}
