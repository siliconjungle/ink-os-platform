import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { exclusive, summary } from './lib/ink-system-profile.mjs';

export function analyse(run) {
  const p = run.profile, count = p.edits.length, server = exclusive(p.server), byId = new Map(server.map(s => [s.id,s]));
  const samples = p.edits.map(edit => {
    const browser = p.browser.filter(s => s.trace === edit.trace), host = server.filter(s => s.trace === edit.trace);
    const applies = browser.filter(s => s.name === 'ui.apply' && s.detail.operations > 0).sort((a,b) => a.end - b.end);
    const last = applies.at(-1);
    assert.ok(last && new Set(applies.map(s => s.detail.name)).size === 2, 'both panes must apply a changed patch');
    const refresh = browser.filter(s => s.name === 'http.client' && s.detail.action === 'refresh' && s.detail.name === last.detail.name && s.end <= last.start + .01).at(-1);
    const invalidation = browser.find(s => s.name === 'sse.received' && s.detail.trace === edit.trace);
    assert.ok(refresh && invalidation && refresh.start >= invalidation.start);
    const phases = {
      submitToInvalidation: invalidation.start - edit.start,
      invalidationToRefresh: refresh.start - invalidation.start,
      refreshRpc: refresh.end - refresh.start,
      applyDispatch: last.start - refresh.end,
      domApply: last.end - last.start,
      observationAndFrameTail: edit.end - last.end,
    };
    assert.ok(Math.abs(Object.values(phases).reduce((a,b)=>a+b,0) - (edit.end-edit.start)) < .001);
    const total = name => host.filter(s => s.name === name).reduce((n,s) => n+s.duration,0);
    return { trace: edit.trace, elapsed: edit.end-edit.start, domComplete: last.end-edit.start, phases,
      walBytes: p.wal.filter(s => s.trace === edit.trace).reduce((n,s) => n+s.bytes,0),
      checkpointBytes: (p.checkpoints || []).filter(s => s.trace === edit.trace).reduce((n,s) => n+s.bytes,0),
      appCheckpoint: host.some(s => s.name === 'resident.request' && s.detail.op === 'checkpoint'),
      collaborationCheckpoint: host.some(s => s.name === 'collaboration.checkpoint'),
      fsyncMs: total('wal.fsync'), serverEncodeMs: total('http.encode'),
    };
  });
  const byteGroups = {};
  for (const rpc of p.rpc) {
    const key = rpc.action + (rpc.name ? ':'+rpc.name : ''), group = byteGroups[key] ||= { requests: 0, requestBytes: 0, responseBytes: 0, responseFields: {} };
    group.requests++; group.requestBytes += rpc.received.bytes; group.responseBytes += rpc.sent.bytes;
    for (const [key,value] of Object.entries(rpc.sent.fields)) group.responseFields[key] = (group.responseFields[key] || 0) + value;
    assert.equal(Object.values(rpc.sent.fields).reduce((a,b)=>a+b,0), rpc.sent.bytes);
    assert.equal(Object.values(rpc.received.fields).reduce((a,b)=>a+b,0), rpc.received.bytes);
  }
  for (const group of Object.values(byteGroups)) {
    group.requestBytesPerEdit = group.requestBytes / count;
    group.responseBytesPerEdit = group.responseBytes / count;
    group.responseFieldsPerReply = Object.fromEntries(Object.entries(group.responseFields).map(([k,n]) => [k,n/group.requests]));
  }
  const stages = {};
  for (const span of server) {
    if (!span.trace.startsWith('edit-')) continue;
    const inherited = span.name.startsWith('worker.') ? byId.get(span.parent)?.detail.entry : span.detail.entry;
    const key = span.name + (inherited ? ':'+inherited : '');
    const group = stages[key] ||= { calls: 0, inclusiveMs: 0, exclusiveMs: 0 };
    group.calls++; group.inclusiveMs += span.duration; group.exclusiveMs += span.exclusive;
  }
  for (const group of Object.values(stages)) {
    group.callsPerEdit = group.calls / count;
    group.inclusiveMsPerEdit = group.inclusiveMs / count;
    group.exclusiveMsPerEdit = group.exclusiveMs / count;
  }
  const transport = p.browser.filter(s => s.name === 'http.client').map(client => {
    const candidates = server.filter(s => s.name === 'http.server' && s.trace === client.trace && s.detail.action === client.detail.action && s.detail.name === client.detail.name);
    return candidates.length === 1 ? { action: client.detail.action, residual: client.end-client.start-candidates[0].duration } : null;
  }).filter(Boolean);
  return { mode: run.mode, rows: run.workload.seedRows, count,
    elapsedMs: summary(samples.map(s=>s.elapsed)), domCompleteMs: summary(samples.map(s=>s.domComplete)),
    phaseMs: Object.fromEntries(Object.keys(samples[0].phases).map(key => [key,summary(samples.map(s=>s.phases[key]))])),
    byteGroups, rpcBytesPerEdit: run.transferred.bytesPerEdit,
    walBytesPerEdit: run.persisted.bytesPerEdit,
    checkpointBytesPerEdit: (p.checkpoints || []).reduce((n,s)=>n+s.bytes,0)/count,
    fsyncMs: summary(samples.map(s=>s.fsyncMs)),
    transportResidualMs: Object.fromEntries(['put','refresh'].map(action=>[action,summary(transport.filter(s=>s.action===action).map(s=>s.residual))])),
    normalEdits: summary(samples.filter(s=>!s.appCheckpoint && !s.collaborationCheckpoint).map(s=>s.elapsed)),
    checkpointEdits: samples.filter(s=>s.appCheckpoint || s.collaborationCheckpoint),
    stages, samples, dropped: p.dropped, clockUncertaintyMs: p.clock.uncertainty };
}

export function chromeTrace(run) {
  const p = run.profile, origin = p.browserOrigin;
  return { displayTimeUnit: 'ms', traceEvents: [
    ...p.server.map(s => ({ name:s.name + (s.detail.entry ? ':'+s.detail.entry : ''), cat:'server', ph:'X', pid:1, tid:s.trace.startsWith('edit-') ? Number(s.trace.slice(5)) + 1 : 0,
      ts:(s.start + p.clock.offset-origin)*1000, dur:Math.max(0,s.end-s.start)*1000, args:s.detail })),
    ...p.browser.map(s => ({ name:s.name, cat:'browser', ph:'X', pid:2, tid:{tables:1,dashboard:2}[s.detail.name] || 3, ts:s.start*1000, dur:Math.max(0,s.end-s.start)*1000, args:{ trace:s.trace,...s.detail } })),
  ] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = process.argv[2];
  if (!input) throw Error('Usage: node scripts/analyse-ink-system-profile.mjs REPORT.json [OUTPUT_BASE]');
  const bytes = await readFile(input), report = JSON.parse(input.endsWith('.gz') ? gunzipSync(bytes, { maxOutputLength:64*1024*1024 }) : bytes), runs = report.runs || [report], base = process.argv[3] || input.replace(/\.json(?:\.gz)?$/, '');
  const result = { schema:1, recordedAt:report.recordedAt, scope:'Browser critical-path phases partition each sample. Server stages are nested inclusive/exclusive work and are not additive across concurrent requests. Native resident rounds include IPC/codecs.', runs:runs.map(analyse) };
  await writeFile(base+'.summary.json', JSON.stringify(result,null,2)+'\n');
  const representative = runs.find(r=>r.mode==='javascript' && r.workload.seedRows===64) || runs[0];
  await writeFile(base+'.trace.json', JSON.stringify(chromeTrace(representative))+'\n');
  console.log(JSON.stringify(result.runs.map(r=>({mode:r.mode,rows:r.rows,dom:r.domCompleteMs.p50,observed:r.elapsedMs.p50,bytes:r.rpcBytesPerEdit}))));
}
