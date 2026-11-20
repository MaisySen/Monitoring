#!/usr/bin/env node
// Summarize one or more result folders from run-all.sh as a Markdown table.
//   node summarize.js results/monitoring-postgres results/monitoring-clickhouse
'use strict';
const fs = require('fs'), path = require('path');
const dirs = process.argv.slice(2);
if (!dirs.length) { console.error('usage: node summarize.js <results dir> [more dirs]'); process.exit(2); }
const load = (d, f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return null; } };
const cell = (v, unit = '') => (v === null || v === undefined ? '—' : `${typeof v === 'number' ? v.toLocaleString('en-US') : v}${unit}`);
const med = (a) => { const s = a.filter((x) => x !== null && x !== undefined).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const rows = [];
const add = (name, f) => rows.push([name, ...dirs.map((d) => { try { return f(d); } catch { return '—'; } })]);
const M = (d) => load(d, 'metrics.json'), L = (d) => load(d, 'logs.json'), T = (d) => load(d, 'traces.json');
const lastStep = (d) => M(d)?.steps.at(-1);
const ok = (j) => (j ? (j.all_correct ? 'yes' : '**NO**') : '—');
add('All answers correct: metrics / logs / traces', (d) => `${ok(M(d))} / ${ok(L(d))} / ${ok(T(d))}`);
add('Metrics ingest, points/s (largest step)', (d) => cell(lastStep(d)?.ingest.points_per_s));
add('Metrics ingest request p99', (d) => cell(lastStep(d)?.ingest.request_p99_ms, ' ms'));
add('Metrics series at largest step', (d) => cell(lastStep(d)?.series));
add('Metrics visible after (largest step)', (d) => cell(lastStep(d)?.visible_after_s, ' s'));
add('Metrics query median (largest step, 5 queries)', (d) => cell(med(lastStep(d)?.queries.map((q) => q.median_ms) ?? []), ' ms'));
add('Metrics slowest query (largest step)', (d) => cell(Math.max(...lastStep(d).queries.map((q) => q.median_ms)), ' ms'));
add('Logs ingest, logs/s', (d) => cell(L(d)?.ingest.logs_per_s));
add('Logs ingest request p99', (d) => cell(L(d)?.ingest.request_p99_ms, ' ms'));
add('Last log searchable after', (d) => cell(L(d)?.last_log_searchable_after_s, ' s'));
add('Log search median (6 queries)', (d) => cell(med(L(d)?.queries.map((q) => q.median_ms) ?? []), ' ms'));
add('Traces ingest, spans/s', (d) => cell(T(d)?.ingest.spans_per_s));
add('Traces ingest request p99', (d) => cell(T(d)?.ingest.request_p99_ms, ' ms'));
add('Last trace searchable after', (d) => cell(T(d)?.last_trace_searchable_after_s, ' s'));
add('Span search median (6 queries)', (d) => cell(med(T(d)?.queries.map((q) => q.median_ms) ?? []), ' ms'));
add('Ingest errors (metrics + logs + traces)', (d) => cell((M(d)?.steps.reduce((a, s) => a + s.ingest.errors, 0) ?? 0) + (L(d)?.ingest.errors ?? 0) + (T(d)?.ingest.errors ?? 0)));
const head = ['', ...dirs.map((d) => path.basename(d))];
console.log(`| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |`);
for (const r of rows) console.log(`| ${r.join(' | ')} |`);
const wrong = [];
for (const d of dirs) for (const [k, j] of [['metrics', M(d)], ['logs', L(d)], ['traces', T(d)]]) {
  if (!j) continue;
  const qs = k === 'metrics' ? j.steps.flatMap((s) => s.queries.map((q) => ({ ...q, name: `C=${s.cardinality} ${q.name}` }))) : j.queries;
  for (const q of qs) if (!q.correct) wrong.push(`- ${path.basename(d)} ${k}: ${q.name} (status ${q.status}${q.returned !== undefined ? `, returned ${q.returned}` : ''}${q.expected !== undefined ? `, expected ${q.expected}` : ''})`);
}
if (wrong.length) console.log(`\nWrong answers:\n${wrong.join('\n')}`);
