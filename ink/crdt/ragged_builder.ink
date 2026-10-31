module ink.knowledge.ragged_builder;
import "ragged_buffer.ink" as ragged;

// Affine construction of one variable-length row in its destination arena.
// The pending owner retains earlier rows; finishing also records an empty row.
record Pending<T>{rows:ragged.Rows<T>,start:u32,}
fn begin<T>(rows:ragged.Rows<T>)->Pending<T>{
 let start=rows.values.len();return Pending<T>{rows:rows,start:start};
}
fn push<T>(pending:Pending<T>,value:T)->Pending<T>{
 let rows=pending.rows;return Pending<T>{..pending,rows:ragged.Rows<T>{..rows,values:rows.values.push(value)}};
}
fn finish<T>(pending:Pending<T>)->ragged.Rows<T>{
 let rows=pending.rows;let end=rows.values.len();
 return ragged.Rows<T>{..rows,ranges:rows.ranges.push(ragged.Range{start:pending.start,end:end})};
}
