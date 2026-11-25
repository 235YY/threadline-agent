// Read-only operator comparison tool for Phase 1 wireLayout ('legacy' vs 'staged-v1').
// Reads existing DailyBudgetLedger, RequestJournal, or StudyLedger JSON files without
// acquiring locks or mutating anything.
//
// Usage:
//   node tools/ops/compare-wire-layout.mjs <ledger-or-journal.json> [--last 100] [--json | --markdown]

import {readFileSync, statSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

function parseArgs(argv) {
  const args = {file: null, last: null, json: false, markdown:false};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--markdown') args.markdown = true;
    else if (a === '--last') {
      const n = Number(argv[++i]);
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error('--last requires a positive integer');
      args.last = n;
    } else if (!a.startsWith('-') && !args.file) {
      args.file = a;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!args.file||args.json&&args.markdown) throw new Error('usage: node tools/ops/compare-wire-layout.mjs <ledger-or-journal.json> [--last N] [--json]');
  return args;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1));
  return s[idx];
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function classifyScenario(row) {
  const kind = row?.wireTelemetry?.sourceKind ?? row?.source?.kind ?? null;
  const scene = row?.wireTelemetry?.scene ?? null;
  if (kind === 'task') return 'task-tool';
  if (kind === 'reflection') return ['full','incremental'].includes(row.wireTelemetry?.reflectionProjection)?'reflection-'+row.wireTelemetry.reflectionProjection:'reflection';
  if(kind==='fast-chat'||kind==='work')return kind;
  if (typeof scene === 'string' && scene.startsWith('local/gateway/')) return 'api-chat';
  if (typeof scene === 'string' && scene.startsWith('qq/')) return 'qq-chat';
  if (kind === 'event') return 'chat-event';
  return 'other';
}

export function summarizeRows(rows, {last = null} = {}) {
  const settled = (rows ?? []).filter(r =>
    r &&
    r.status === 'settled' &&
    r.usage &&
    Number.isSafeInteger(r.usage.prompt) &&
    Number.isSafeInteger(r.usage.hit) &&
    Number.isSafeInteger(r.usage.miss)
  );
  const sample = last ? settled.slice(-last) : settled;

  function aggregate(list) {
    const prompts = list.map(r => r.usage.prompt);
    const hits = list.map(r => r.usage.hit);
    const misses = list.map(r => r.usage.miss);
    const completions = list.map(r => r.usage.completion ?? 0);
    const costs = list.map(r => r.accounting?.calculatedMicros ?? r.actualMicros ?? r.usage.upperMicros ?? 0);
    const durations = list.map(r => r.wireTelemetry?.durationMs).filter(v => Number.isFinite(v) && v >= 0);
    const first = list.map(r => r.wireTelemetry?.firstContentMs).filter(v => Number.isFinite(v) && v >= 0);
    const totalPrompt = prompts.reduce((a, b) => a + b, 0);
    const totalHit = hits.reduce((a, b) => a + b, 0);
    const totalCostMicros = costs.reduce((a, b) => a + b, 0);
    const validated = list.filter(r => r.validation?.status === 'accepted' || r.validation?.status === 'rejected');
    const accepted = validated.filter(r => r.validation?.status === 'accepted');
    const fallbacks = list.filter(r => r.wireTelemetry?.fallback === true);
    const rolls = list.filter(r => r.wireTelemetry?.rolled === true);

    return {
      count: list.length,
      totalPromptTokens: totalPrompt,
      totalHitTokens: totalHit,
      weightedCacheHitRate: totalPrompt > 0 ? Number((totalHit / totalPrompt).toFixed(4)) : null,
      medianPromptTokens: median(prompts),
      avgPromptTokens: prompts.length ? Math.round(mean(prompts)) : null,
      avgHitTokens: hits.length ? Math.round(mean(hits)) : null,
      avgMissTokens: misses.length ? Math.round(mean(misses)) : null,
      avgCompletionTokens: completions.length ? Math.round(mean(completions)) : null,
      totalCostCny: Number((totalCostMicros / 1_000_000).toFixed(6)),
      avgCostMicros: costs.length ? Math.round(mean(costs)) : null,
      medianCostMicros: median(costs) !== null ? Math.round(median(costs)) : null,
      medianDurationMs: durations.length ? Math.round(median(durations)) : null,
      p90DurationMs: durations.length ? Math.round(percentile(durations, 0.9)) : null,
      p95DurationMs: percentile(durations,0.95),
      durationSamples:durations.length,
      firstContentP50Ms:percentile(first,0.5),
      firstContentP95Ms:percentile(first,0.95),
      firstContentSamples:first.length,
      validationAcceptRate: validated.length ? Number((accepted.length / validated.length).toFixed(4)) : null,
      fallbackCount: fallbacks.length,
      batchRollCount: rolls.length,
    };
  }

  const byLayout = {};
  const byLayoutAndScenario = {};

  const matched = new Map();
  for (const r of sample) {
    const tag = r.wireTelemetry?.wireLayout;
    const layout = r.wireTelemetry?.fallback ? 'fallback' : ['legacy','staged-v1'].includes(tag) ? tag : 'unclassified';
    const scenario = classifyScenario(r);
    (byLayout[layout] ??= []).push(r);
    const key = `${layout}::${scenario}`;
    (byLayoutAndScenario[key] ??= []).push(r);
    const t=r.wireTelemetry;
    if(['legacy','staged-v1'].includes(layout)&&typeof t.reportedModel==='string'&&typeof t.reasoning==='string'&&
       Number.isSafeInteger(t.maxTokens)&&typeof t.stream==='boolean'){
      const profile=JSON.stringify([scenario,t.reportedModel,t.reasoning,t.maxTokens,t.stream]);
      if(!matched.has(profile))matched.set(profile,{legacy:[],'staged-v1':[]});
      matched.get(profile)[layout].push(r);
    }
  }

  const layouts = Object.fromEntries(Object.entries(byLayout).map(([k, v]) => [k, aggregate(v)]));
  const breakdown = Object.fromEntries(Object.entries(byLayoutAndScenario).map(([k, v]) => [k, aggregate(v)]));

  // Unmarked historical rows and fallbacks remain visible in the totals.
  function compareScenario(scenario){
    const a=breakdown['legacy::'+scenario],b=breakdown['staged-v1::'+scenario];
    if(!a||!b)return null;
    return {
      scenario,
      legacyCount:a.count,
      stagedCount:b.count,
      cacheHitRateDelta: (a.weightedCacheHitRate !== null && b.weightedCacheHitRate !== null)
        ? Number((b.weightedCacheHitRate - a.weightedCacheHitRate).toFixed(4))
        : null,
      avgCostMicrosDelta: (a.avgCostMicros !== null && b.avgCostMicros !== null)
        ? b.avgCostMicros - a.avgCostMicros
        : null,
      avgCostPctChange: (a.avgCostMicros > 0 && b.avgCostMicros !== null)
        ? Number((((b.avgCostMicros - a.avgCostMicros) / a.avgCostMicros) * 100).toFixed(2))
        : null,
      medianPromptDelta: (a.medianPromptTokens !== null && b.medianPromptTokens !== null)
        ? b.medianPromptTokens - a.medianPromptTokens
        : null,
      medianDurationMsDelta: (a.medianDurationMs !== null && b.medianDurationMs !== null)
        ? b.medianDurationMs - a.medianDurationMs
        : null,
    };
  }

  return {
    totalSettledWithUsage: settled.length,
    analyzedCount: sample.length,
    overall: aggregate(sample),
    byLayout: layouts,
    byLayoutAndScenario: breakdown,
    comparison:compareScenario('qq-chat'),
    apiComparison:compareScenario('api-chat'),
    matchedProfiles:[...matched].filter(([,rows])=>rows.legacy.length&&rows['staged-v1'].length).map(([profile,rows])=>{
      const [scenario,model,reasoning,maxTokens,stream]=JSON.parse(profile);
      return {scenario,model,reasoning,maxTokens,stream,legacy:aggregate(rows.legacy),staged:aggregate(rows['staged-v1'])};
    }),
  };
}

function fmtPct(v) {
  return v === null || v === undefined ? '-' : `${(v * 100).toFixed(1)}%`;
}

function fmtCny(micros) {
  return micros === null || micros === undefined ? '-' : `¥${(micros / 1_000_000).toFixed(5)}`;
}

export function wireMarkdown(report){
  const lines=['| 布局与入口 | 结算样本 | 加权命中 | 输入中位 tokens | 估算 ¥/请求 | 首段 / 完成 P95 ms | 采用率 | 回退 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|'];
  for(const [name,s] of Object.entries(report.byLayoutAndScenario)){
    lines.push(`| ${name} | ${s.count} | ${fmtPct(s.weightedCacheHitRate)} | ${s.medianPromptTokens??'—'} | ${fmtCny(s.avgCostMicros)} | ${s.firstContentP95Ms??'—'} / ${s.p95DurationMs??'—'} | ${fmtPct(s.validationAcceptRate)} | ${s.fallbackCount} |`);
  }
  return lines.join('\n');
}

function printHuman(report, file) {
  console.log(`Threadline Wire Layout Comparison (read-only)`);
  console.log(`Source: ${file}`);
  console.log(`Settled with usage: ${report.totalSettledWithUsage} (analyzed: ${report.analyzedCount})\n`);

  const rows = Object.entries(report.byLayout);
  if (!rows.length) {
    console.log('No settled requests with complete token usage found.');
    return;
  }

  console.log('Layout      | Count | Weighted Hit | Median Input | Est. Cost/Req | Median Total | Fallbacks');
  console.log('------------|-------|--------------|--------------|---------------|----------------|----------');
  for (const [layout, s] of rows) {
    console.log(
      `${layout.padEnd(11)} | ${String(s.count).padStart(5)} | ${fmtPct(s.weightedCacheHitRate).padStart(12)} | ${String(s.medianPromptTokens ?? '-').padStart(12)} | ${fmtCny(s.avgCostMicros).padStart(13)} | ${String(s.medianDurationMs !== null ? s.medianDurationMs + 'ms' : '-').padStart(14)} | ${String(s.fallbackCount).padStart(9)}`
    );
  }

  for(const c of [report.apiComparison,report.comparison].filter(Boolean)){
    console.log(`\n${c.scenario} delta (staged-v1 vs legacy):`);
    console.log(`  Cache hit rate: ${c.cacheHitRateDelta >= 0 ? '+' : ''}${fmtPct(c.cacheHitRateDelta)}`);
    console.log(`  Est. cost/req : ${c.avgCostPctChange !== null ? `${c.avgCostPctChange >= 0 ? '+' : ''}${c.avgCostPctChange}%` : '-'} (${c.avgCostMicrosDelta} micros)`);
    console.log(`  Median input  : ${c.medianPromptDelta >= 0 ? '+' : ''}${c.medianPromptDelta} tokens`);
    if (c.medianDurationMsDelta !== null) {
      console.log(`  Median latency: ${c.medianDurationMsDelta >= 0 ? '+' : ''}${c.medianDurationMsDelta} ms`);
    }
  }

  const scRows = Object.entries(report.byLayoutAndScenario);
  if (scRows.length > 1) {
    console.log('\nScenario Breakdown:');
    for (const [k, s] of scRows) {
      console.log(`  ${k.padEnd(24)} count=${s.count}, hit=${fmtPct(s.weightedCacheHitRate)}, medianIn=${s.medianPromptTokens}, avgCost=${fmtCny(s.avgCostMicros)}`);
    }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!statSync(args.file).isFile()) throw new Error(`not a file: ${args.file}`);
  const raw = JSON.parse(readFileSync(args.file, 'utf8'));
  const report = summarizeRows(raw.requests ?? [], {last: args.last});
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if(args.markdown)console.log(wireMarkdown(report));
  else printHuman(report, args.file);
}
