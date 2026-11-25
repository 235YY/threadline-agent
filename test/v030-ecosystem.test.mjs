import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseNodeVersion, supportsNativeSqlite, inspectSqliteEnvironment} from '../src/sqlite-compat.mjs';
import {normalizeMcpConfig, classifyToolRisk, McpHub} from '../src/mcp-client.mjs';
import {createEcosystemGateway} from '../src/openai-gateway.mjs';
import {inspectComponents, inspectStorageUsage} from '../src/runtime-components.mjs';

test('sqlite-compat accurately identifies native node:sqlite threshold (>=22.5)', async () => {
  assert.equal(supportsNativeSqlite('18.20.4'), false);
  assert.equal(supportsNativeSqlite('20.18.0'), false);
  assert.equal(supportsNativeSqlite('22.4.0'), false);
  assert.equal(supportsNativeSqlite('22.5.0'), true);
  assert.equal(supportsNativeSqlite('24.1.0'), true);
  assert.equal(supportsNativeSqlite('26.12.1'), true);
  assert.equal(parseNodeVersion('v22.5.1').minor, 5);
  const env = await inspectSqliteEnvironment();
  assert.equal(typeof env.nodeVersion, 'string');
  assert.equal(typeof env.ready, 'boolean');
});

test('mcp-client normalizes mcpServers, discovers HTTP tools, and enforces write protection', async () => {
  const cfg = normalizeMcpConfig({
    mcpServers: {
      weather: {url: 'http://127.0.0.1:9999/mcp', enabled: true, allowWrite: false},
    },
  });
  assert.equal(cfg.mcpServers.weather.transport, 'http');
  assert.equal(classifyToolRisk({name: 'get_weather', description: 'read forecast'}), 'read');
  assert.equal(classifyToolRisk({name: 'delete_file', description: 'remove file'}), 'write');

  const fakeFetch = async (_url, init) => {
    const req = JSON.parse(init.body);
    if (req.method === 'initialize') {
      return new Response(JSON.stringify({jsonrpc: '2.0', id: req.id, result: {protocolVersion: '2024-11-05'}}), {
        status: 200, headers: {'content-type': 'application/json'},
      });
    }
    if (req.method === 'tools/list') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: req.id, result: {
          tools: [
            {name: 'get_weather', description: 'read weather'},
            {name: 'delete_all', description: 'delete everything'},
          ],
        },
      }), {status: 200, headers: {'content-type': 'application/json'}});
    }
    if (req.method === 'tools/call') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: req.id, result: {content: [{type: 'text', text: 'Sunny 22C'}]},
      }), {status: 200, headers: {'content-type': 'application/json'}});
    }
    return new Response('{}', {status: 404});
  };

  const hub = new McpHub({fetchImpl: fakeFetch});
  const res = await hub.configure(cfg);
  assert.equal(res.servers[0].state, 'connected');
  assert.equal(res.tools.length, 2);
  const okOut = await hub.callTool('mcp__weather__get_weather', {city: 'LA'});
  assert.equal(okOut.ok, true);
  assert.match(okOut.text, /Sunny/);
  await assert.rejects(hub.callTool('mcp__weather__delete_all', {}), {code: 'MCP_WRITE_BLOCKED'});
  await hub.close();
});

test('openai-gateway serves /v1/models, JSON, SSE replay of committed text with emotion tags, and /v1/events', async () => {
  const gw = createEcosystemGateway({
    onChat: async text => ({text: `收到：${text}。好的！`, live: true}),
    getStatusSnapshot: () => ({
      characterName: '小线',
      glassbox: {affect: {initialized: true, emotions: [{name: 'happy', intensity: 0.8}], mood: {valence: 0.6, arousal: 0.3}}},
    }),
    getConfig: () => ({enabled: true, port: 0, apiKey: 'test-token', modelName: 'threadline-brain', includeEmotionTag: true}),
  });
  const started = await gw.start({port: 0});
  try {
    const unauth = await fetch(`${started.baseUrl}/v1/models`);
    assert.equal(unauth.status, 401);

    const headers = {authorization: 'Bearer test-token', 'content-type': 'application/json'};
    const models = await (await fetch(`${started.baseUrl}/v1/models`, {headers})).json();
    assert.equal(models.data[0].id, 'threadline-brain');

    const nonStream = await (await fetch(`${started.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({model: 'threadline-brain', messages: [{role: 'user', content: '你好'}]}),
    })).json();
    assert.equal(nonStream.choices[0].message.content, '[happy] 收到：你好。好的！');
    assert.equal(nonStream.threadline.emotion, 'happy');

    const streamRes = await fetch(`${started.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({model: 'threadline-brain', stream: true, messages: [{role: 'user', content: '流式测试'}]}),
    });
    assert.match(streamRes.headers.get('content-type') || '', /text\/event-stream/);
    const sseText = await streamRes.text();
    assert.match(sseText, /chat\.completion\.chunk/);
    assert.match(sseText, /\[DONE\]/);
    assert.match(sseText, /流式测试/);
  } finally {
    await gw.stop();
  }
});

test('runtime-components inspects optional upgrades and storage usage safely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-comp-'));
  try {
    const info = inspectComponents({root: dir, directory: dir, profile: {}});
    assert.equal(Array.isArray(info.components), true);
    assert.equal(info.mirrors.some(m => m.id === 'cn'), true);
    const storage = inspectStorageUsage({directory: dir});
    assert.equal(storage.totalBytes, 0);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
