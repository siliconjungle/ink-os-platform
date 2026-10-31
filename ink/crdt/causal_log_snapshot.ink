module ink.knowledge.causal_log_snapshot;
import "packed_varint_stream.ink" as stream;
import "batched_event_graph.ink" as batches;
record Parents{reader:stream.Reader,values:Buffer<u64>,remaining:u32,id:u64,}
record Text{reader:stream.Reader,values:Buffer<u32>,remaining:u32,}
record Decoding{reader:stream.Reader,changes:Buffer<batches.Change>,previous_id:u64,previous_position:u32,}
fn encode(changes:List<batches.Change>)->Result<List<u32>,stream.Error>{
 var writer:stream.Writer=stream.write_small(stream.begin(),length(changes));
 var previous_id:u64=0;var previous_position:u32=0;
 for c in changes{
  writer=stream.write(writer,c.id ^ previous_id);
  writer=stream.write_small(writer,c.position ^ previous_position);
  writer=stream.write_small(writer,c.remove);
  writer=stream.write_small(writer,length(c.parents));writer=stream.write_small(writer,length(c.text));
  for parent in c.parents{writer=stream.write(writer,parent ^ c.id);}
  for point in c.text{writer=stream.write_small(writer,point);}
  previous_id=c.id;previous_position=c.position;
 }
 return stream.finish(writer);
}
fn parent_step(p:Parents)->Parents{let parent=stream.read(p.reader);return Parents{reader:parent.reader,values:p.values.push(parent.value ^ p.id),remaining:p.remaining-1,id:p.id};}
fn text_step(t:Text)->Text{let point=stream.read_small(t.reader);return Text{reader:point.reader,values:t.values.push(point.value),remaining:t.remaining-1};}
fn decode_one(s:Decoding)->Decoding{
  let identity=stream.read(s.reader);let position=stream.read_small(identity.reader);let remove=stream.read_small(position.reader);
  let parent_count=stream.read_small(remove.reader);let text_count=stream.read_small(parent_count.reader);
  let id=identity.value ^ s.previous_id;let at=position.value ^ s.previous_position;
  let remaining=text_count.reader.length-text_count.reader.position;
  if !text_count.reader.valid || parent_count.value>remaining || text_count.value>remaining-parent_count.value{return Decoding{..s,reader:stream.validity(text_count.reader,false)};}
  let parents=repeat_until(parent_count.value,Parents{reader:text_count.reader,values:Buffer.empty(),remaining:parent_count.value,id:id},fn(p)=>p.remaining==0 || !p.reader.valid,fn(i,p)=>parent_step(p));
  let text=repeat_until(text_count.value,Text{reader:parents.reader,values:Buffer.empty(),remaining:text_count.value},fn(t)=>t.remaining==0 || !t.reader.valid,fn(i,t)=>text_step(t));
  return Decoding{reader:text.reader,changes:s.changes.push(batches.Change{id:id,parents:parents.values.freeze(),position:at,remove:remove.value,text:text.values.freeze()}),previous_id:id,previous_position:at};
}
fn decode(words:List<u32>,maximum_changes:u32,maximum_octets:u32)->Result<List<batches.Change>,stream.Error>{
 let opened=stream.open(words,maximum_octets);
 if !opened.valid{return Err(choose(opened.error==2,stream.Error.Limit,stream.Error.Invalid));}
 let count=stream.read_small(opened);
 if !count.reader.valid{return Err(stream.Error.Invalid);}
 if count.value>maximum_changes{return Err(stream.Error.Limit);}
 if count.value>quot_or(count.reader.length-count.reader.position,5,0){return Err(stream.Error.Invalid);}
 let decoded=repeat_until(count.value,Decoding{reader:count.reader,changes:Buffer.empty(),previous_id:0,previous_position:0},fn(s)=>!s.reader.valid,fn(i,s)=>decode_one(s));
 if !stream.end(decoded.reader){return Err(stream.Error.Invalid);}
 return Ok(decoded.changes.freeze());
}
