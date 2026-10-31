module ink.knowledge.list_buffer_append;
// Ordinary list-to-buffer copying. Checked lexical loans can keep the input
// borrowed while elements are copied directly into the destination allocation.
fn append<T>(data:Buffer<T>,values:List<T>)->Buffer<T>{
 return foldl(values,data,fn(value,out)=>out.push(value));
}
