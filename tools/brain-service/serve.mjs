// Product runner around launchBrain(): supports --open-life and --local-budget
// (JY_SPEND_MODE=journal) without relaxing any store, journal, or permission contract.
import { launchBrain } from './bootstrap.mjs';
import { resolveBrainConfig } from './runtime-config.mjs';
import { RequestJournal } from '../../src/request-journal.mjs';
import { officialDay } from '../../src/official-dashboard.mjs';
import { createOpenLifeHost } from '../open-life/host.mjs';

const args = new Set(process.argv.slice(2));
const env = { ...process.env };
if (args.has('--open-life')) env.JY_OPEN_LIFE = '1';
if (args.has('--local-budget')) env.JY_SPEND_MODE = 'journal';

const config = resolveBrainConfig({ root: process.cwd(), env });
const spendMode = env.JY_SPEND_MODE ?? 'official';
if (!['official', 'journal'].includes(spendMode)) {
  throw Object.assign(new Error('JY_SPEND_MODE must be official or journal'), { code: 'RUNTIME_CONFIG' });
}

let requestJournal = null;
let officialSpend = null;
if (config.live && spendMode === 'journal') {
  const capMicros = Number(env.JY_DAILY_MICROS ?? env.JY_TEST_DAILY_MICROS ?? config.profile?.dailyMicros ?? 5_000_000);
  requestJournal = new RequestJournal(config.ledgerPath);
  officialSpend = {
    gate() {
      const today = officialDay(Date.now());
      let spendMicros = 0;
      let requestCount = 0;
      for (const r of requestJournal.data.requests) {
        const day = officialDay(r.recordedAt ?? r.dispatchedAt ?? Date.now());
        if (day !== today) continue;
        if (r.status === 'settled') {
          spendMicros += Number.isSafeInteger(r.actualMicros) ? r.actualMicros : 0;
          requestCount += 1;
        } else if (r.status === 'dispatched' || r.status === 'uncertain') {
          spendMicros += 500_000;
          requestCount += 1;
        }
      }
      const allow = spendMicros < capMicros;
      return {
        known: true,
        allow,
        reason: allow ? 'LOCAL_JOURNAL_BELOW_LIMIT' : 'LOCAL_JOURNAL_LIMIT_REACHED',
        usage: { mode: 'journal', day: today, spendMicros, limitMicros: capMicros, requestCount },
        platformDelayAcceptedMs: 0,
      };
    },
    accept() {
      throw Object.assign(new Error('local journal spend mode is active'), { code: 'LOCAL_SPEND_MODE' });
    },
  };
}

let serviceRef = null;
let openLifeHost = null;
if (config.live && config.openLife) {
  openLifeHost = createOpenLifeHost({
    root: config.root,
    stateDirectory: config.stateDirectory,
    botId: env.QQ_UIN,
    ownerId: env.QQ_OWNER ?? env.QQ_TEST_ONLY_OWNER,
    officeRoot: env.JY_OFFICE_ROOT ?? null,
    voiceDirectory: env.JY_VOICE_DIRECTORY ?? null,
    storeGetter: () => serviceRef?.store ?? null,
  });
}

let running;
try {
  running = await launchBrain({
    root: config.root,
    env,
    dependencies: {
      ...(requestJournal ? { requestJournal } : {}),
      ...(officialSpend ? { officialSpend } : {}),
      ...(openLifeHost ? { lifePolicy: openLifeHost.policy } : {}),
      onStopped: () => process.exit(0),
    },
  });
  serviceRef = running.service;
} catch (error) {
  try { requestJournal?.close(); } catch {}
  throw error;
}

console.log(JSON.stringify({
  ...running.summary,
  openLife: config.openLife,
  spendMode,
  ...(openLifeHost ? { officeRoot: openLifeHost.officeRoot } : {}),
}));

const stop = async () => {
  try { await running.stop(); process.exit(0); }
  catch (error) { console.error(error.code ?? 'SHUTDOWN_FAILED'); process.exit(1); }
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
