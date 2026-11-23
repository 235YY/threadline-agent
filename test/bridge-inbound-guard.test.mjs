// Phase 3.2 M2 IR-02 — bridge inbound guard tests (TE-owned new file; A has no bridge test).
// Contract: with `JY_REQUIRE_BRAIN_TOKEN=1` the connector must refuse to start without a
// >=16 char `BRAIN_TOKEN` (before loading the QQ SDK); brain 401/403 are TERMINAL for that
// inbound request — counted/sanitized (`inbound-rejected`), never retried, and the serialized
// chain keeps serving other messages. No real SDK/QQ/network: a stub SDK module and a local
// loopback HTTP stub only; temporary dirs are removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const BRIDGE = join(PROJECT, 'tools', 'qq-connect', 'bridge.mjs');
const OWNER = '1234567890';
const UIN = '555000111';
const TOKEN = 'te-bridge-brain-token-0123456789';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jy-ir02-bridge-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

test('IR-02-B1: bridge refuses to start when require-token is on and BRAIN_TOKEN is missing/short', () => {
  const cases = [{label: 'missing', value: undefined}, {label: 'empty', value: ''}, {label: 'short', value: 'short-token'}];
  for (const {label, value} of cases) {
    const env = {...process.env, JY_REQUIRE_BRAIN_TOKEN: '1'};
    if (value === undefined) delete env.BRAIN_TOKEN; else env.BRAIN_TOKEN = value;
    const result = spawnSync(process.execPath, [BRIDGE], {cwd: PROJECT, env, encoding: 'utf8', timeout: 15000});
    assert.equal(result.status, 1, `${label}: bridge must exit non-zero before loading the SDK`);
    assert.match(String(result.stderr), /BRAIN_TOKEN_REQUIRED/, `${label}: typed startup failure`);
  }
});

function stubSdkSource() {
  // Emits two owner private messages after identity is ready; mirrors the SDK surface bridge uses.
  return [
    'export class SnowLumaWebSocketClient {',
    '  constructor(options) { this.options = options; this.handlers = {}; this.privateHandler = null; this.keepAlive = setInterval(() => {}, 1000); }',
    '  on(name, handler) { this.handlers[name] = handler; return this; }',
    '  onPrivateMessage(handler) { this.privateHandler = handler; return this; }',
    '  onGroupMessage() { return this; }',
    '  onNotice() { return this; }',
    '  onBotStatus() { return this; }',
    '  async connect() { return {ok: true}; }',
    '  async getLoginInfo() {',
    '    const owner = Number(process.env.QQ_OWNER);',
    '    const emit = (messageId, text) => setTimeout(() => {',
    '      try { this.privateHandler?.({message_type: "private", user_id: owner, message_id: messageId,',
    '        time: Math.ceil(Date.now() / 1000), sender: {user_id: owner, nickname: "owner"},',
    '        message: [{type: "text", data: {text}}]}, {}); } catch {}',
    '    }, 300 + (messageId % 10));',
    '    emit(9101, "synthetic message one");',
    '    emit(9102, "synthetic message two");',
    '    return {user_id: process.env.QQ_UIN, nickname: "stub"};',
    '  }',
    '  async sendPrivateMessage() { return {message_id: 1}; }',
    '  async sendGroupMessage() { return {message_id: 2}; }',
    '  async close() { clearInterval(this.keepAlive); }',
    '}',
    'export default {SnowLumaWebSocketClient};',
    '',
  ].join('\n');
}

test('IR-02-B2: brain 401/403 are terminal, counted and never retried (chain keeps running)', async t => {
  const dir = tempDir(t);
  const snowHome = join(dir, 'SnowLuma');
  mkdirSync(join(snowHome, 'config'), {recursive: true});
  mkdirSync(join(dir, 'state'), {recursive: true});
  const replies = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/v1/reply') {
        const count = replies.length + 1;
        const status = count === 1 ? 401 : 403;
        const error = count === 1 ? 'UNAUTHORIZED' : 'INBOUND_SCENE_NOT_AUTHORIZED';
        replies.push({count, status, token: req.headers['x-brain-token'] ?? null});
        res.writeHead(status, {'content-type': 'application/json'});
        return res.end(JSON.stringify({error, message: 'synthetic terminal rejection'}));
      }
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({data: []}));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));
  writeFileSync(join(snowHome, 'config', `onebot_${UIN}.json`), JSON.stringify({networks: {
    httpServers: [{host: '127.0.0.1', port}], wsServers: [{host: '127.0.0.1', port, accessToken: 'stub'}]}}), 'utf8');
  const sdkPath = join(dir, 'stub-sdk.mjs');
  writeFileSync(sdkPath, stubSdkSource(), 'utf8');

  const child = spawn(process.execPath, [BRIDGE], {cwd: PROJECT, env: {
    ...process.env,
    QQ_SDK_MODULE: pathToFileURL(sdkPath).href,
    SNOWLUMA_HOME: snowHome,
    QQ_UIN: UIN,
    QQ_OWNER: OWNER,
    QQ_CHAT_SCOPE: 'owner-test',
    QQ_CONNECTOR_LOCK_ROOT: join(dir, 'locks'),
    BRAIN_STATE: join(dir, 'state'),
    BRAIN_URL: `http://127.0.0.1:${port}`,
    BRAIN_TOKEN: TOKEN,
    JY_REQUIRE_BRAIN_TOKEN: '0',
    QQ_RECEIVE_RECONCILE_MS: '0',
  }, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    for (let waited = 0; waited < 8000; waited += 100) {
      if (replies.length >= 2) break;
      await sleep(100);
    }
    // Give the child a moment to flush the rejection logs and prove it stays alive.
    await sleep(400);
    assert.equal(replies.length, 2, `exactly one brain /v1/reply per inbound message (no retry). stdout=${stdout} stderr=${stderr}`);
    assert.deepEqual(replies.map(reply => reply.status), [401, 403]);
    assert.ok(replies.every(reply => reply.token === TOKEN), 'the bridge sends x-brain-token on inbound replies');
    const rejected = stdout.split('\n').filter(line => line.includes('inbound-rejected'));
    assert.equal(rejected.length, 2, `both terminal rejections are counted/logged. stdout=${stdout} stderr=${stderr}`);
    assert.match(rejected[0], /"status":401/);
    assert.match(rejected[0], /UNAUTHORIZED/);
    assert.match(rejected[1], /"status":403/);
    assert.match(rejected[1], /INBOUND_SCENE_NOT_AUTHORIZED/);
    assert.match(rejected[0], /"count":1/);
    assert.match(rejected[1], /"count":1/);
    // Terminal means: no second HTTP attempt for the same message (still exactly 2 requests for
    // 2 messages) and the serialized chain keeps serving the next message. The receive ledger
    // records the terminal rejection as an unconfirmed delivery (audit only, no resend).
    assert.equal(child.exitCode, null, 'the connector keeps serving other messages after terminal rejections');
    assert.equal((stdout.match(/receive-start/g) ?? []).length, 2, 'both inbound messages entered the serialized chain');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      sleep(3000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); }),
    ]);
  }
});
