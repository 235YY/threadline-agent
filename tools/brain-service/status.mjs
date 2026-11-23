// Read-only product status & observability CLI.
// Queries running service /health + /stats if live, and summarizes journal & store state.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBrainConfig } from './runtime-config.mjs';
import { officialDay } from '../../src/official-dashboard.mjs';
import { ContinuityStore } from '../../src/store.mjs';

const config = resolveBrainConfig({ root: process.cwd(), env: process.env });
const instanceFile = join(config.stateDirectory, 'brain.instance.json');
const instance = existsSync(instanceFile) ? JSON.parse(readFileSync(instanceFile, 'utf8')) : null;
const url = process.env.BRAIN_URL ?? instance?.url ?? `http://127.0.0.1:${config.port || 8787}`;
const headers = process.env.BRAIN_TOKEN ? { 'x-brain-token': process.env.BRAIN_TOKEN } : {};

async function tryJson(path) {
  try {
    const r = await fetch(url + path, { headers, signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const health = await tryJson('/health');
const stats = await tryJson('/stats');
const ledgerFile = config.ledgerPath ?? join(config.root, '_local/brain/request-journal.json');
let ledgerSummary = null;
if (ledgerFile && existsSync(ledgerFile)) {
  try {
    const j = JSON.parse(readFileSync(ledgerFile, 'utf8'));
    const today = officialDay(Date.now());
    const reqs = j.requests ?? [];
    const todayReqs = reqs.filter(r => officialDay(r.recordedAt ?? r.dispatchedAt ?? 0) === today);
    const spendMicros = todayReqs.filter(r => r.status === 'settled').reduce((n, r) => n + (r.actualMicros ?? 0), 0);
    const uncertain = reqs.filter(r => r.status === 'uncertain' || r.status === 'dispatched').length;
    ledgerSummary = { totalRequests: reqs.length, todayCalls: todayReqs.length, todaySpendYuan: Number((spendMicros / 1_000_000).toFixed(4)), uncertain };
  } catch {}
}

let storeSummary = null;
if (!health && config.storePath !== ':memory:' && existsSync(config.storePath)) {
  try {
    const s = new ContinuityStore(config.storePath, { readOnly: true });
    const intentCount = [...s.all('extension_record')].filter(r => r.stateType === 'intent-compilation').length;
    const errorCount = [...s.all('extension_record')].filter(r => r.stateType === 'operation-feedback').length;
    storeSummary = { events: [...s.all('event')].length, decisions: [...s.all('decision')].length, responses: [...s.all('response')].length, intentCompilations: intentCount, operationErrors: errorCount };
    s.close();
  } catch {}
}

const report = {
  format: 'threadline-status-v1',
  running: Boolean(health?.ok),
  url,
  mode: config.mode,
  openLife: config.openLife,
  intentProtocol: config.profile.intentProtocol,
  ...(health ? { health: { cognitionBusy: health.cognitionBusy, pending: health.pending, recovery: health.recovery, theory: health.theory } } : {}),
  ...(stats ? { counts: stats.counts } : {}),
  ...(storeSummary ? { store: storeSummary } : {}),
  ...(ledgerSummary ? { ledger: ledgerSummary } : {}),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Threadline 状态  ${report.running ? '运行中' : '离线'} (${report.url})  mode=${report.mode}  openLife=${report.openLife}  intent-v1=${report.intentProtocol}`);
  if (ledgerSummary) console.log(`账本: 今日调用 ${ledgerSummary.todayCalls} 次, 今日花费 ¥${ledgerSummary.todaySpendYuan}, 未确认 ${ledgerSummary.uncertain} 条, 累计 ${ledgerSummary.totalRequests} 条`);
  if (health) console.log(`服务: pending=${health.pending?.length ?? 0}, busy=${health.cognitionBusy}, recoveryTurns=${health.recovery?.modelTurnCount ?? 0}, unconfirmedTools=${health.recovery?.toolsUnconfirmed ?? 0}`);
  if (stats?.counts) console.log(`存储: ${JSON.stringify(stats.counts)}`);
  else if (storeSummary) console.log(`离线存储: ${JSON.stringify(storeSummary)}`);
}
