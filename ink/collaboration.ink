module ink_os_collaboration;
import "crdt/ordered_run_text_document.ink" as document;
import "crdt/batched_event_graph.ink" as batches;
import "crdt/text_crdts.ink" as text;
state Text: document.Document = document.empty();
change receive(changes: List<batches.Change>) -> Result<Unit,text.Error> reads(Text) writes(Text) {
 Text = document.merge(Text,changes)?;
 return Ok(());
}
query visible() -> Result<List<u32>,text.Error> reads(Text) { return document.visible(Text); }
query save() -> Result<List<u32>,text.Error> reads(Text) { return document.save(Text); }
change load(words: List<u32>) -> Result<Unit,text.Error> writes(Text) { Text = document.load(words)?; return Ok(()); }
