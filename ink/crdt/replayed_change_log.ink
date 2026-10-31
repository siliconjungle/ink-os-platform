module ink.knowledge.replayed_change_log;
import "batched_event_graph.ink" as batches;
import "text_crdts.ink" as text;
record Canonical{history:Buffer<batches.Change>,seen:Map<u64,batches.Change>,valid:Bool,}
record Rebuilt{history:List<batches.Change>,visible:List<u32>,}
fn step(s:Canonical,c:batches.Change)->Canonical{
 if !s.valid{return s;}
 if s.seen.contains(c.id){let equal=s.seen.get_or(c.id,c)==c;return Canonical{..s,valid:equal};}
 let codes=foldl(c.text,true,fn(value,ok)=>ok && value<1114112 && !(value>=55296 && value<57344));
 if !batches.valid(c) || !codes{return Canonical{..s,valid:false};}
 return Canonical{history:s.history.push(c),seen:s.seen.set(c.id,c),valid:true};
}
fn rebuilt(changes:List<batches.Change>)->Result<Rebuilt,text.Error>{
 let s=foldl(changes,Canonical{history:Buffer.empty(),seen:Map.empty(),valid:true},fn(c,s)=>step(s,c));
 if !s.valid{return Err(text.Error.InvalidOperation);}
 let history=s.history.freeze();let visible=batches.materialize(history)?;
 return Ok(Rebuilt{history:history,visible:visible});
}
fn extended(history:List<batches.Change>,incoming:List<batches.Change>)->Result<Rebuilt,text.Error>{
 let changes=foldl(incoming,buffer(history),fn(c,changes)=>changes.push(c)).freeze();return rebuilt(changes);
}
