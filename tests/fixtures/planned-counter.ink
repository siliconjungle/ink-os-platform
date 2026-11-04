module planned_counter;
enum Error { Refused, }
state Total:u64=0;
event seen:u64;
fn identity(n:u64)->u64{return n;}
fn amount(n:u64)->u64{return identity(n);}
change add(n:u64)->u64 reads(Total) writes(Total) emits(seen){
  Total=Total+amount(n);emit seen(Total);return Total;
}
change fail(n:u64)->Result<Unit,Error> reads(Total) writes(Total) emits(seen){
  Total=Total+amount(n);emit seen(Total);return Err(Error.Refused);
}
query total()->u64 reads(Total){return Total;}
