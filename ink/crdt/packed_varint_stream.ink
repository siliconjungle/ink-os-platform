module ink.knowledge.packed_varint_stream;
// Canonical unsigned LEB128 octets packed into little-endian u32 words.
// Header: format tag, octet count, low/high halves of a rolling integrity hash.
// The hash detects accidental corruption; it is not an authentication scheme.
enum Error{Invalid,Limit,}
record Writer{words:Buffer<u32>,packed:u32,lanes:u32,length:u32,hash:u64,valid:Bool,}
record Reader{words:Buffer<u32>,length:u32,position:u32,valid:Bool,error:u32,}
record Octet{reader:Reader,value:u32,}
record Word{reader:Reader,value:u64,}
record Small{reader:Reader,value:u32,}
record Writing{writer:Writer,value:u64,done:Bool,}
record Reading{reader:Reader,value:u64,index:u32,done:Bool,}
record Integrity{words:Buffer<u32>,index:u32,end:u32,hash:u64,}
fn mixed(hash:u64,word:u32)->u64{return (hash ^ word_widen_u32_to_u64(word))*1099511628211;}
fn begin()->Writer{return Writer{words:buffer([1229867830,0,0,0]),packed:0,lanes:0,length:0,hash:14695981039346656037,valid:true};}
fn byte(w:Writer,value:u32)->Writer{
 if !w.valid || value>255 || w.length==4294967295{return Writer{..w,valid:false};}
 let packed=w.packed | wrapping_shl(value,w.lanes*8);let lanes=w.lanes+1;
 if lanes==4{return Writer{words:w.words.push(packed),packed:0,lanes:0,length:w.length+1,hash:mixed(w.hash,packed),valid:true};}
 return Writer{..w,packed:packed,lanes:lanes,length:w.length+1};
}
fn write_step(s:Writing)->Writing{
 let more=s.value>=128;let octet=word_narrow_u64_to_u32(s.value & 127) | choose(more,128,0);
 return Writing{writer:byte(s.writer,octet),value:wrapping_shr(s.value,7),done:!more};
}
fn write(w:Writer,value:u64)->Writer{
 let s=repeat_until(10,Writing{writer:w,value:value,done:false},fn(s)=>s.done || !s.writer.valid,fn(i,s)=>write_step(s));return s.writer;
}
fn write_small(w:Writer,value:u32)->Writer{return write(w,word_widen_u32_to_u64(value));}
fn finish(w:Writer)->Result<List<u32>,Error>{
 if !w.valid{return Err(Error.Limit);}
 let hash=choose(w.lanes==0,w.hash,mixed(w.hash,w.packed));
 let words=choose(w.lanes==0,w.words,w.words.push(w.packed));
 return Ok(words.set(1,w.length).set(2,word_narrow_u64_to_u32(hash)).set(3,word_narrow_u64_to_u32(wrapping_shr(hash,32))).freeze());
}
fn failed(words:List<u32>,error:u32)->Reader{return Reader{words:buffer(words),length:0,position:0,valid:false,error:error};}
fn open(words:List<u32>,maximum:u32)->Reader{
 if length(words)<4 || words.at_or(0,0)!=1229867830{return failed(words,1);}
 let count=words.at_or(1,0);if count>maximum{return failed(words,2);}
 let lanes=rem_or(count,4,0);let expected=4+quot_or(count,4,0)+choose(lanes==0,0,1);
 if length(words)!=expected{return failed(words,1);}
 if lanes!=0 && wrapping_shr(words.at_or(expected-1,0),lanes*8)!=0{return failed(words,1);}
 let stored=word_widen_u32_to_u64(words.at_or(2,0)) | wrapping_shl(word_widen_u32_to_u64(words.at_or(3,0)),32);
 let checked=repeat_until(expected-4,Integrity{words:buffer(words),index:4,end:expected,hash:14695981039346656037},fn(s)=>s.index>=s.end,fn(i,s)=>integrity_step(s));
 return Reader{words:checked.words,length:count,position:0,valid:checked.hash==stored,error:choose(checked.hash==stored,0,1)};
}
fn integrity_step(s:Integrity)->Integrity{let hash=mixed(s.hash,s.words.at_or(s.index,0));return Integrity{..s,index:s.index+1,hash:hash};}
fn validity(r:Reader,valid:Bool)->Reader{return Reader{..r,valid:valid};}
fn read_byte(r:Reader)->Octet{
 if !r.valid || r.position>=r.length{return Octet{reader:Reader{..r,valid:false},value:0};}
 let slot=4+quot_or(r.position,4,0);let shift=rem_or(r.position,4,0)*8;
 let value=wrapping_shr(r.words.at_or(slot,0),shift) & 255;
 return Octet{reader:Reader{..r,position:r.position+1},value:value};
}
fn read_step(s:Reading)->Reading{
 let octet=read_byte(s.reader);let byte=octet.value;let part=byte & 127;let last=byte<128;
 let valid=octet.reader.valid && !(s.index==9 && byte>1) && !(s.index>0 && last && part==0);
 let value=s.value | wrapping_shl(word_widen_u32_to_u64(part),s.index*7);
 return Reading{reader:validity(octet.reader,valid),value:value,index:s.index+1,done:last || !valid};
}
fn read(r:Reader)->Word{
 let s=repeat_until(10,Reading{reader:r,value:0,index:0,done:false},fn(s)=>s.done,fn(i,s)=>read_step(s));
 let valid=s.reader.valid && s.done;return Word{reader:validity(s.reader,valid),value:s.value};
}
fn read_small(r:Reader)->Small{
 let word=read(r);let valid=word.reader.valid && word.value<=4294967295;return Small{reader:validity(word.reader,valid),value:word_narrow_u64_to_u32(word.value)};
}
fn end(r:Reader)->Bool{return r.valid && r.position==r.length;}
