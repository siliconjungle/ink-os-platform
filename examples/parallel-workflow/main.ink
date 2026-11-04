module parallel_example;
state Total:u64=0;
fn twice(n:u64)->u64{return n*2;}
fn combine(a:u64,b:u64)->u64{return a+b;}
change save(value:u64)->u64 writes(Total){Total=value;return Total;}
query total()->u64 reads(Total){return Total;}
