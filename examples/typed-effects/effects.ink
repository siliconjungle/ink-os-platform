module ink_effects;
record EffectError {code:String,message:String,certainty:String,retryable:Bool,}
record HttpEffectRequest {method:String,path:String,body:Option<String>,bytes:Option<List<u32>>,expected:Option<String>,}
record FileEffectRequest {action:String,name:String,value:Option<String>,bytes:Option<List<u32>>,expected:Option<u64>,}
record ClockEffectRequest {delayMs:u32,}
record RandomEffectRequest {count:u32,}
record ProcessEffectRequest {input:Option<String>,bytes:Option<List<u32>>,}
record SubscriptionEffectRequest {action:String,handle:Option<String>,}
record HttpEffectResponse {status:u32,body:Option<String>,bytes:List<u32>,etag:Option<String>,}
record FileEffectResponse {exists:Bool,value:Option<String>,bytes:List<u32>,version:u64,}
record ClockEffectResponse {unixMs:u64,}
record RandomEffectResponse {bytes:List<u32>,}
record ProcessEffectResponse {stdout:Option<String>,stderr:Option<String>,stdoutBytes:List<u32>,stderrBytes:List<u32>,exitCode:i32,signal:Option<String>,}
record SubscriptionEffectEvent {type:String,id:String,namespace:String,version:u64,}
record SubscriptionEffectResponse {handle:String,version:u64,event:Option<SubscriptionEffectEvent>,}
record EffectRequest<A> {
 operation:String,http:Option<HttpEffectRequest>,file:Option<FileEffectRequest>,clock:Option<ClockEffectRequest>,random:Option<RandomEffectRequest>,process:Option<ProcessEffectRequest>,subscription:Option<SubscriptionEffectRequest>,app:Option<A>,
}
record EffectReply<B> {
 operation:String,sequence:u32,version:Option<String>,error:Option<EffectError>,http:Option<HttpEffectResponse>,file:Option<FileEffectResponse>,clock:Option<ClockEffectResponse>,random:Option<RandomEffectResponse>,process:Option<ProcessEffectResponse>,subscription:Option<SubscriptionEffectResponse>,app:Option<B>,
}
record EffectPending<S,A> {state:S,request:EffectRequest<A>,}
fn effect_http<A>(operation:String,request:HttpEffectRequest)->EffectRequest<A>{return EffectRequest<A>{operation:operation,http:Some(request),file:None,clock:None,random:None,process:None,subscription:None,app:None};}
fn effect_file<A>(operation:String,request:FileEffectRequest)->EffectRequest<A>{return EffectRequest<A>{operation:operation,http:None,file:Some(request),clock:None,random:None,process:None,subscription:None,app:None};}
fn effect_clock<A>(operation:String,delayMs:u32)->EffectRequest<A>{return EffectRequest<A>{operation:operation,http:None,file:None,clock:Some(ClockEffectRequest{delayMs:delayMs}),random:None,process:None,subscription:None,app:None};}
fn effect_random<A>(operation:String,count:u32)->EffectRequest<A>{return EffectRequest<A>{operation:operation,http:None,file:None,clock:None,random:Some(RandomEffectRequest{count:count}),process:None,subscription:None,app:None};}
fn effect_process<A>(operation:String,request:ProcessEffectRequest)->EffectRequest<A>{return EffectRequest<A>{operation:operation,http:None,file:None,clock:None,random:None,process:Some(request),subscription:None,app:None};}
fn effect_subscription<A>(operation:String,action:String,handle:Option<String>)->EffectRequest<A>{return EffectRequest<A>{operation:operation,http:None,file:None,clock:None,random:None,process:None,subscription:Some(SubscriptionEffectRequest{action:action,handle:handle}),app:None};}
fn effect_app<A>(operation:String,input:A)->EffectRequest<A>{return EffectRequest<A>{operation:operation,http:None,file:None,clock:None,random:None,process:None,subscription:None,app:Some(input)};}
