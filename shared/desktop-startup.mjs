import {desktopWrites, emptyLayout} from './desktop-layout.mjs';

// Before a first snapshot supplies the Lamport clock, retain semantic changes.
// Materialization runs inside the cache transaction that replaces these intents
// with durable wire operations. A second tab cannot materialize them again.
export function materializeDesktopIntents(intents, state) {
  const batches = [];
  for (const intent of intents) {
    state.actor = BigInt(intent.actor); state.seq = 0n;
    const before = state.get('/schema') >= 2 ? intent.before : emptyLayout();
    const writes = desktopWrites(before, intent.after, state, {...intent.options,personalWindows:true});
    for (let i = 0; i < writes.length; i += 128) batches.push(state.commit(writes.slice(i, i + 128)));
  }
  return batches;
}
