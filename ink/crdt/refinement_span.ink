module ink.knowledge.refinement_span;
// A stable prefix handle may cache an interval that has subsequently split.
// Validate membership without overflowing the upper endpoint.
fn covers(start:u64,length:u32,key:u64)->Bool{
 return start<=key && key-start<word_widen_u32_to_u64(length);
}
