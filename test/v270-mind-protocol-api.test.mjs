import test from 'node:test';
import {measureApiReply,summarizeChannelMetrics} from '../tools/ops/bench-api-channels.mjs';
import assert from 'node:assert/strict';
import {
  MIND_PROTOCOL_PRESETS,
  parseModelTarget,
  normalizeMindProtocol,
  createMindProtocolRegistry,
} from '../src/mind-protocol.mjs';
import {
  createIdempotencyCache,
  createCircuitBreaker,
  classifyApiRequest,
  filterMemoriesByAudience,
  createWorldStateStore,
  purifyOutputForModality,
  buildPartialCommitRecord,
  crystallizeSession,
} from '../src/brain-api-pipeline.mjs';
import {createEcosystemGateway} from '../src/openai-gateway.mjs';

test('parseModelTarget resolves resident ID and preset suffixes cleanly', () => {
  assert.deepEqual(parseModelTarget('jingyang:voice'), {model: 'jingyang:voice', residentId: 'jingyang', presetId: 'voice-live', explicitPreset: true});
  assert.deepEqual(parseModelTarget('jingyang:game'), {model: 'jingyang:game', residentId: 'jingyang', presetId: 'game-coop', explicitPreset: true});
  assert.deepEqual(parseModelTarget('jingyang:work'), {model: 'jingyang:work', residentId: 'jingyang', presetId: 'work-agent', explicitPreset: true});
  assert.deepEqual(parseModelTarget('jingyang:raw'), {model: 'jingyang:raw', residentId: 'jingyang', presetId: 'raw-passthrough', explicitPreset: true});
  assert.equal(parseModelTarget('jingyang').presetId, 'companion-chat');
});

test('classifyApiRequest routes noise to transparent ephemeral, tool chains to task-preserving, and normal chat to mind-native', () => {
  const noise = classifyApiRequest({messages: [{role: 'user', content: '请给这段对话起一个简短标题'}]}, MIND_PROTOCOL_PRESETS['companion-chat']);
  assert.equal(noise.channel, 'transparent');
  assert.equal(noise.isNoise, true);
  assert.equal(noise.allowMemoryWrite, false);

  const work = classifyApiRequest({
    messages: [{role: 'user', content: '帮我修这个 bug'}],
    tools: [{type: 'function', function: {name: 'read_file'}}],
  }, MIND_PROTOCOL_PRESETS['companion-chat']);
  assert.equal(work.channel, 'task-preserving');
  assert.equal(work.preserveExternalHistory, true);

  const chat = classifyApiRequest({messages: [{role: 'user', content: '今天好累呀'}]}, MIND_PROTOCOL_PRESETS['companion-chat']);
  assert.equal(chat.channel, 'mind-native');
  assert.equal(chat.allowMemoryWrite, true);
});

test('filterMemoriesByAudience physically strips private memories in public mode', () => {
  const mems = [
    {id: 'm1', kind: 'preference', body: '喜欢拿铁', scene: 'qq/group/9001', audience: 'public'},
    {id: 'm2', kind: 'health', body: '昨天体检结果', scene: 'qq/private/1001'},
    {id: 'm3', kind: 'secret', body: '银行卡密码提示', private: true},
  ];
  assert.equal(filterMemoriesByAudience(mems, 'owner').length, 3);
  const pub = filterMemoriesByAudience(mems, 'public');
  assert.equal(pub.length, 1);
  assert.equal(pub[0].id, 'm1');
});

test('purifyOutputForModality strips Markdown and extracts stage brackets in voice mode', () => {
  const res = purifyOutputForModality('**太好了！**（轻轻摇了摇尾巴）我们马上出发吧~', {outputMode: 'voice'});
  assert.equal(res.text, '太好了！我们马上出发吧~');
  assert.equal(res.actions.length, 1);
  assert.equal(res.actions[0].cue, '轻轻摇了摇尾巴');
});

test('WorldStateStore overwrites in place with deadband and CircuitBreaker trips at 3 errors', () => {
  const ws = createWorldStateStore();
  const r1 = ws.upsert('room1', {temp: 24.0, hp: 100}, {deadband: {temp: 1.0}});
  assert.equal(r1.changed, true);
  const r2 = ws.upsert('room1', {temp: 24.3}, {deadband: {temp: 1.0}});
  assert.equal(r2.changed, false);
  assert.equal(ws.get('room1').state.temp, 24.0);

  const cb = createCircuitBreaker({maxConsecutiveErrors: 3});
  assert.equal(cb.recordFailure('sceneA').tripped, false);
  assert.equal(cb.recordFailure('sceneA').tripped, false);
  assert.equal(cb.recordFailure('sceneA').tripped, true);
  cb.recordSuccess('sceneA');
  assert.equal(cb.isTripped('sceneA'), false);
});

test('Idempotency cache, duplex partial commit, and session-end candidates work deterministically', async () => {
  const idem = createIdempotencyCache();
  assert.deepEqual(await idem.claim('req-1','fp',()=>({id:'chatcmpl-1'})),{id:'chatcmpl-1'});
  assert.deepEqual(await idem.claim('req-1','fp',()=>assert.fail('unexpected replay')),{id:'chatcmpl-1'});
  assert.throws(()=>idem.claim('req-1','other',()=>{}),{code:'IDEMPOTENCY_CONFLICT'});

  const partial = buildPartialCommitRecord({sceneId: 'voice-1', spokenText: '我觉得今天', fullPlannedText: '我觉得今天天气特别适合出去散步', interrupted: true});
  assert.equal(partial.committedText, '我觉得今天');
  assert.equal(partial.interrupted, true);
  assert.ok(partial.discardedChars > 0);

  const cry = crystallizeSession({
    sceneId: 'game-sts',
    protocol: MIND_PROTOCOL_PRESETS['game-coop'],
    turns: [
      {text: 'HP 80', ephemeral: true},
      {text: '请起个标题', isNoise: true},
      {text: '今晚和主人一起用铁甲战士丝血通关了 A20 心脏！', source_refs:[{id:'ev:99',revision:2}], milestone: true},
    ],
  });
  assert.equal(cry.crystals.length, 1);
  assert.equal(cry.crystals[0].source_refs[0].id, 'ev:99');
  assert.equal(cry.crystals[0].playful, true);
});

test('OpenAI gateway supports Idempotency-Key, voice purification, /v1/protocols, /v1/world/state, and /v1/sessions/end', async () => {
  let calls = 0;
  const registry = createMindProtocolRegistry();
  const gw = createEcosystemGateway({
    protocolRegistry: registry,
    getSessionTurns:()=>[{text:'今晚丝血通关了 Boss！',source_refs:[{id:'ev:1',revision:2}]}],
    onChat: async (_userText, {protocol, classification, worldState}) => {
      calls++;
      return {
        reply: '**收到啦！**（开心摇了摇尾巴）血量还有 ' + (worldState?.hp ?? '?'),
        meta: {protocolId: protocol.id, channel: classification.channel},
      };
    },
    getStatusSnapshot: () => ({}),
    getConfig: () => ({modelName:'jingyang',apiKey:'fixture-owner-key'}),
  });
  const {port:p}=await gw.start({port:0});
  try {
    // 1) Upsert world state
    const wsRes = await fetch(`http://127.0.0.1:${p}/v1/world/state`, {
      method: 'POST',
      headers: {'content-type':'application/json',authorization:'Bearer fixture-owner-key'},
      body: JSON.stringify({sceneId: 'game-1', state: {hp: 88}}),
    });
    assert.equal(wsRes.status, 200);

    // 2) Voice call with Idempotency-Key -> Markdown & stage brackets stripped!
    const headers = {
      'content-type': 'application/json',
      authorization:'Bearer fixture-owner-key',
      'idempotency-key': 'idem-abc-123',
      'x-threadline-scene': 'game-1',
    };
    const r1 = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({model: 'jingyang:voice', stream: false, messages: [{role: 'user', content: '我还有多少血'}]}),
    });
    assert.equal(r1.status, 200);
    const j1 = await r1.json();
    assert.equal(j1.choices[0].message.content, '收到啦！血量还有 88');
    assert.equal(calls, 1);

    // 3) Repeat with same Idempotency-Key -> cached, onChat NOT invoked a second time!
    const r2 = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({model: 'jingyang:voice', stream: false, messages: [{role: 'user', content: '我还有多少血'}]}),
    });
    const j2 = await r2.json();
    assert.equal(j2.id, j1.id);
    assert.equal(calls, 1);

    // 4) List protocols & end session
    const pr=await (await fetch(`http://127.0.0.1:${p}/v1/protocols`,{headers})).json();
    assert.ok(pr.presets.length >= 5);

    const endRes = await fetch(`http://127.0.0.1:${p}/v1/sessions/end`, {
      method: 'POST',
      headers: {'content-type':'application/json',authorization:'Bearer fixture-owner-key'},
      body: JSON.stringify({sceneId: 'game-1', protocolId: 'game-coop'}),
    });
    assert.equal(endRes.status, 200);
    const ej = await endRes.json();
    assert.equal(ej.crystals.length,1);
    assert.equal(ej.persisted,false);
    assert.deepEqual(ej.crystals[0].source_refs,[{id:'ev:1',revision:2}]);
  } finally {
    await gw.stop();
  }
});

test('API probe times actual nonempty reply from loopback and keeps billing separate',async()=>{
 let calls=0;
 const auth='fixture-bench-gateway';
 const gateway=createEcosystemGateway({getConfig:()=>({apiKey:auth,modelName:'bench'}),onChat:async text=>{
  calls++;
  return {text:text==='等候'?'':'第一段有效正文',usage:{prompt_tokens:10,completion_tokens:2,prompt_cache_hit_tokens:4}};
 }});
 const {baseUrl}=await gateway.start({port:0});
 const measure=(content,id,stream=true)=>measureApiReply({endpoint:baseUrl+'/v1/chat/completions',apiKey:auth,
  idempotencyKey:id,scene:'bench',body:{model:'bench',stream,...(stream?{stream_options:{include_usage:true}}:{}),
   messages:[{role:'user',content}]}});
 try{
  const first=await measure('吃饭了吗','warm-up');
  const repeated=await measure('吃饭了吗','warm-up');
  const silent=await measure('等候','next');
  const json=await measure('吃饭了吗','json',false);
  assert.equal(first.promptTokens,10);
  assert.equal(first.cacheHitTokens,4);
  assert.ok(first.firstContentMs>=0&&first.totalMs>=first.firstContentMs);
  assert.equal(first.completionId,repeated.completionId);
  assert.equal(silent.protocolOk,true);
  assert.equal(silent.effectiveReply,false);
  assert.equal(silent.firstContentMs,null);
  assert.ok(json.effectiveReply);
  assert.equal(calls,3);
  const result=summarizeChannelMetrics([first,repeated,silent,json]).byProtocol['bench [api-client, sse]'];
  assert.equal(result.effectiveReplies,1);
  assert.equal(result.firstContentSamples,1);
  assert.equal(result.officialCnyPerEffectiveReply,null);
 }finally{await gateway.stop();}
});

test('API probe stops after a truncated response without counting heartbeats or retrying',async()=>{
 let calls=0,now=0;
 const trace=await measureApiReply({endpoint:'http://127.0.0.1:1234/v1/chat/completions',apiKey:'fixture',idempotencyKey:'partial',
  body:{messages:[{role:'user',content:'合成请求'}],stream:true},clock:()=>now,fetchImpl:async()=>{
   calls++;
   const e=new TextEncoder();
   const frames=[': keepalive','data: {"id":"reply","choices":[{"delta":{"role":"assistant","content":" "}}]}',
    'data: {"id":"reply","choices":[{"delta":{"content":"正文"}}]}'];
   return new Response(new ReadableStream({
    pull(controller){
     if(!frames.length){controller.close();return;}
     now+=25;
     controller.enqueue(e.encode(frames.shift()+'\n\n'));
    },
   }));
  }});
 assert.equal(calls,1);
 assert.equal(trace.result,'incomplete');
 assert.equal(trace.firstContentMs,75);
 assert.equal(trace.effectiveReply,false);
});

test('gateway guards owner scope, coalesces live duplicates and preserves committed SSE text',async()=>{
  let calls=0,now=1000,resident='resident-a';
  const line='？！第一段。\nSecond segment 🙂';
  let entered,release;
  const started=new Promise(resolve=>{entered=resolve;});
  const ready=new Promise(resolve=>{release=resolve;});
  const gw=createEcosystemGateway({clock:()=>now,getActiveResidentId:()=>resident,getConfig:()=>({apiKey:'owner'}),
    async onChat(text,{signal}){
      calls++;
      if(text==='失败'){throw Object.assign(Error('provider detail is private'),{code:'UNCERTAIN_REQUEST'});}
      entered();
      await ready;
      assert.equal(signal.aborted,false,'finishing the HTTP request body does not cancel active cognition');
      return {text:line,usage:{prompt_tokens:7,completion_tokens:5,total_tokens:12}};
    }});
  const {baseUrl}=await gw.start({port:0});
  const headers={authorization:'Bearer owner','content-type':'application/json'};
  const request=(path,body,extra={})=>fetch(baseUrl+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  const chat=(text,extra={},body={})=>request('/v1/chat/completions',{messages:[{role:'user',content:text}],...body},extra);
  try{
    assert.equal((await fetch(baseUrl+'/v1/models')).status,401);
    assert.equal((await chat('朋友可以听吗',{'x-threadline-audience':'public'})).status,403);
    assert.equal((await chat('请给这段对话起一个简短标题')).status,501);
    assert.equal((await chat('原样处理',{}, {model:'threadline-brain:raw'})).status,501);
    assert.equal((await chat('要 JSON',{}, {response_format:{type:'json_schema'}})).status,501);
    assert.equal((await chat('调用工具',{}, {tools:[{type:'function'}]})).status,501);
    assert.equal((await chat('错模型',{}, {model:'different'})).status,404);
    assert.equal((await chat('错协议',{'x-threadline-protocol':'unknown'})).status,404);
    assert.equal((await request('/v1/sessions/end',{turns:[{eventId:'invented'}]})).status,400);
    assert.equal((await request('/v1/world/state',{sceneId:'room',state:{nested:{invalid:true}}})).status,400);
    assert.equal(calls,0);
    await request('/v1/world/state',{sceneId:'room',state:{hp:88}});
    resident='resident-b';
    assert.deepEqual((await (await fetch(baseUrl+'/v1/world/state?sceneId=room',{headers})).json()).state,{});
    resident='resident-a';
    assert.deepEqual((await (await fetch(baseUrl+'/v1/world/state?sceneId=room',{headers})).json()).state,{hp:88});

    const key={'idempotency-key':'pending-key','x-threadline-scene':'main'};
    const first=chat('说两句',key);
    await started;
    const stream=chat('说两句',key,{stream:true,stream_options:{include_usage:true}});
    assert.equal((await chat('不同内容',key)).status,409);
    release();
    const payload=await (await first).json();
    const chunks=(await (await stream).text()).split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)));
    assert.equal(chunks[0].id,payload.id);
    assert.equal(chunks.map(c=>c.choices[0]?.delta.content??'').join(''),line);
    assert.deepEqual(chunks.at(-1).usage,payload.usage);
    assert.equal(calls,1);
    for(let i=0;i<3;i++)assert.equal((await chat('失败')).status,500);
    assert.equal(calls,4);
    const cooldown=await chat('另一条');
    assert.equal(cooldown.status,503);
    assert.ok(Number(cooldown.headers.get('retry-after'))>0);
    now+=31_000;
    assert.equal((await chat('另一条')).status,200);
    assert.equal(calls,5);
  }finally{release();await gw.stop();}
});
