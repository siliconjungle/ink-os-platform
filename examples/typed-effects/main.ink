module example;
record SaveState {name:String,expected:u64,}

// Ink controls the entire sequence: request bytes, then CAS-write those bytes.
fn save_nonce(name:String,expected:u64)->Result<EffectReply<Unit>,EffectPending<SaveState,Unit>> {
 return Err(EffectPending<SaveState,Unit>{
  state:SaveState{name:name,expected:expected},
  request:effect_random<Unit>("sample",16)
 });
}
fn resume(state:SaveState,reply:EffectReply<Unit>)->Result<EffectReply<Unit>,EffectPending<SaveState,Unit>> {
 if(reply.operation=="sample") {
  return reply.random.fold(
   fn(value)=>Err(EffectPending<SaveState,Unit>{state:state,request:effect_file<Unit>("save",FileEffectRequest{action:"write",name:state.name,value:None,bytes:Some(value.bytes),expected:Some(state.expected)})}),
   fn(none)=>Ok(reply)
  );
 }
 return Ok(reply);
}
