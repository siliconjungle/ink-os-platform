module ink.knowledge.endpoint_batch_state_codec_ordered_runs;
import "endpoint_index_span_graph_ordered_runs.ink" as spans;
import "blocked_measure_sequence.ink" as sequence;
import "interval_index.ink" as intervals;
import "tagged_run_causal_workspace.ink" as causal;
import "ragged_buffer.ink" as ragged;
record Stored{
 prefix:u32,prefix_id:u64,prefix_width:u32,identity_hint:u32,insert_hint:u32,nodes:List<sequence.Node<u32>>,blocks:List<sequence.Block>,children:List<u32>,root:u32,first:u32,last:u32,fallback:u32,
 spans:List<spans.Span>,payload:List<u32>,ids:List<intervals.Node>,ids_root:u32,ids_valid:Bool,engine_error:u32,
 graph:List<causal.Entry>,graph_next:u32,frontiers:List<List<u32>>,queue:List<u64>,removed:List<causal.Range>,added:List<causal.Range>,graph_valid:Bool,
 identities:List<intervals.Node>,identities_root:u32,identities_valid:Bool,targets:List<spans.Target>,ranges:List<ragged.Range>,last_id:u64,error:u32,
}
fn stored(w:spans.Walker)->Stored{
 return Stored{prefix:w.prefix,prefix_id:w.prefix_id,prefix_width:w.prefix_width,identity_hint:w.identity_hint,insert_hint:w.engine.insert_hint,nodes:w.engine.tree.nodes.freeze(),blocks:w.engine.tree.blocks.freeze(),children:w.engine.tree.children.freeze(),root:w.engine.tree.root,first:w.engine.tree.first,last:w.engine.tree.last,fallback:w.engine.tree.fallback,
 spans:w.engine.spans.freeze(),payload:w.engine.payload.freeze(),ids:w.engine.ids.nodes.freeze(),ids_root:w.engine.ids.root,ids_valid:w.engine.ids.valid,engine_error:w.engine.error,
 graph:w.graph.entries.freeze(),graph_next:w.graph.next,frontiers:w.graph.frontiers.freeze(),queue:w.graph.queue.freeze(),removed:w.graph.removed.freeze(),added:w.graph.added.freeze(),graph_valid:w.graph.valid,
 identities:w.identities.nodes.freeze(),identities_root:w.identities.root,identities_valid:w.identities.valid,targets:w.applied.values.freeze(),ranges:w.applied.ranges.freeze(),last_id:w.last,error:w.error};
}
fn loaded(s:Stored)->spans.Walker{
 return spans.Walker{prefix:s.prefix,prefix_id:s.prefix_id,prefix_width:s.prefix_width,identity_hint:s.identity_hint,
 engine:spans.Engine{insert_hint:s.insert_hint,tree:sequence.Tree<u32>{nodes:buffer(s.nodes),blocks:buffer(s.blocks),children:buffer(s.children),root:s.root,first:s.first,last:s.last,fallback:s.fallback},spans:buffer(s.spans),payload:buffer(s.payload),ids:intervals.Index{nodes:buffer(s.ids),root:s.ids_root,valid:s.ids_valid},error:s.engine_error},
 graph:causal.Graph{entries:buffer(s.graph),next:s.graph_next,frontiers:buffer(s.frontiers),queue:buffer(s.queue),removed:buffer(s.removed),added:buffer(s.added),valid:s.graph_valid},
 identities:intervals.Index{nodes:buffer(s.identities),root:s.identities_root,valid:s.identities_valid},applied:ragged.Rows<spans.Target>{values:buffer(s.targets),ranges:buffer(s.ranges)},last:s.last_id,error:s.error};
}
fn empty()->Stored{return stored(spans.empty());}
