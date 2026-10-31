module ink_os_shared_state;
record Register { path:String, value:String, deleted:Bool, clock:u64, actor:u64, seq:u64, }
state Values: Table<String,Register> = Table.empty();
state Versions: Table<u64,u64> = Table.empty();
change merge(next:Register) -> Result<Unit,String> reads(Values,Versions) writes(Values,Versions) {
 let old=Values.get(next.path);
 let newer=match old { None => true, Some(previous) => next.clock>previous.clock || (next.clock==previous.clock && (next.actor>previous.actor || (next.actor==previous.actor && next.seq>previous.seq))), };
 if newer { if Values.contains(next.path) { Values.replace(next.path,next); } else { Values.insert(next.path,next); } }
 let seen=Versions.get(next.actor).unwrap_or(0);
 if next.seq>seen { if Versions.contains(next.actor) { Versions.replace(next.actor,next.seq); } else { Versions.insert(next.actor,next.seq); } }
 return Ok(());
}
query registers() -> List<Register> reads(Values) { return Values.values(); }
query version(actor:u64) -> u64 reads(Versions) { return Versions.get(actor).unwrap_or(0); }
query get(path:String) -> Option<Register> reads(Values) { return Values.get(path); }
