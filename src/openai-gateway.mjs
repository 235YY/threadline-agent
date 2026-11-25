// OpenAI-compatible HTTP Gateway + Real-Time Emotion/Status SSE Stream.
// Lets external ecosystems (AstrBot, SillyTavern, Open-LLM-VTuber, Fay,
// Cortico / Coopanion, DeepSeek Harness / DSH, Live2D / VRM avatars)
// plug directly into Threadline as their long-term memory + emotion brain.
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {digest} from './contracts.mjs';
import {validateWorkApiRequest} from './work-channel.mjs';
import {createMindProtocolRegistry,parseModelTarget} from './mind-protocol.mjs';
import {createRateLimiter,redactSensitiveEgress} from './security-guard.mjs';
import {createIdempotencyCache,createCircuitBreaker,classifyApiRequest,createWorldStateStore,purifyOutputForModality,crystallizeSession} from './brain-api-pipeline.mjs';

function readUserText(messages) {
  if(!Array.isArray(messages)||messages.length===0||messages.length>256)return null;
  for(const message of messages){
    if(!['user','assistant'].includes(message?.role)||message.tool_calls)return null;
    if(typeof message.content==='string')continue;
    if(!Array.isArray(message.content)||!message.content.every(part=>part?.type==='text'&&typeof part.text==='string'))return null;
  }
  const last=messages.at(-1);
  if(last.role!=='user')return null;
  return (typeof last.content==='string'?last.content:last.content.map(p=>p.text).join('\n')).trim();
}

function failGateway(status,code,message,headers={}) {
  throw Object.assign(Error(message),{status,code,headers});
}

function readScene(value='default') {
  if(typeof value!=='string'||!/^[a-z0-9._-]{1,64}$/i.test(value))failGateway(400,'SCENE_INVALID','Provide a scene ID of up to 64 letters, numbers, dots, underscores or dashes');
  return value;
}

async function readObject(req,limit) {
  if(Number(req.headers['content-length'])>limit){req.resume();failGateway(413,'INPUT_TOO_LONG','Request body is too large');}
  const parts=[];
  let bytes=0;
  for await(const chunk of req.iterator({destroyOnReturn:false})){
    bytes+=chunk.length;
    if(bytes>limit){req.resume();failGateway(413,'INPUT_TOO_LONG','Request body is too large');}
    parts.push(chunk);
  }
  let result;
  try{result=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{failGateway(400,'INVALID_JSON','Invalid JSON body');}
  if(!result||typeof result!=='object'||Array.isArray(result))failGateway(400,'INVALID_JSON','Request body must be an object');
  return result;
}

function validateWorldState(value,deadband) {
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
  const key=name=>/^[a-z0-9][a-z0-9_.-]{0,39}$/i.test(name)&&!['constructor','prototype'].includes(name);
  if(!object(value)||Object.keys(value).length>64||Object.entries(value).some(([name,v])=>!key(name)||
     !(v===null||typeof v==='boolean'||Number.isFinite(v)||typeof v==='string'&&v.length<=200))||
     deadband!==undefined&&(!object(deadband)||Object.keys(deadband).length>64||Object.entries(deadband).some(([name,v])=>!key(name)||!Number.isFinite(v)||v<0))){
    failGateway(400,'WORLD_STATE_INVALID','Provide up to 64 scalar world fields and optional numeric deadbands');
  }
}

const UNSUPPORTED_FIELDS=['temperature','top_p','logprobs','top_logprobs','logit_bias','stop','frequency_penalty','presence_penalty','max_tokens','max_completion_tokens','reasoning_effort','thinking','functions','function_call','parallel_tool_calls','seed','modalities','audio','prediction'];
const PROVIDER_FAILURES=new Set(['UNCERTAIN_REQUEST','MODEL_INCOMPLETE','NETWORK_PREFLIGHT_FAILED','MODEL_OUTCOME_UNKNOWN','PROVIDER_OUTPUT','PROVIDER_HTTP','BRAIN_ERROR']);

export function emotionTagFromGlassbox(glassbox) {
  const affect = glassbox?.affect;
  if (!affect?.initialized) return {tag: 'neutral', mood: null, emotions: []};
  const top = Array.isArray(affect.emotions) && affect.emotions.length
    ? [...affect.emotions].sort((a, b) => (b.intensity ?? b.value ?? 0) - (a.intensity ?? a.value ?? 0))[0]
    : null;
  const mood = affect.mood ?? null;
  let tag = 'neutral';
  if (top?.name) tag = String(top.name).toLowerCase();
  else if (mood) {
    if ((mood.valence ?? 0) > 0.25) tag = (mood.arousal ?? 0) > 0.2 ? 'excited' : 'happy';
    else if ((mood.valence ?? 0) < -0.25) tag = (mood.arousal ?? 0) > 0.2 ? 'annoyed' : 'sad';
    else if ((mood.arousal ?? 0) < -0.3) tag = 'sleepy';
  }
  return {tag, mood, emotions: affect.emotions ?? []};
}

// Stream only finished text fragments. A token can span provider chunks;
// an open PEM block cannot be released before it is redacted at completion.
function safeTextBoundary(text){
  const pem=text.search(/-----BEGIN/i);
  let cut=0,pathLike=false;
  for(let i=0;i<(pem<0?text.length:pem);i++){
    if(/\s/u.test(text[i])){cut=i+1;pathLike=false;}
    else if(/[\\/]/u.test(text[i]))pathLike=true;
    else if(/[。！？]/u.test(text[i])&&!pathLike)cut=i+1;
  }
  return cut;
}

async function deliverFastChat({res,onFastChat,messages,requestKey,model,includeUsage}){
  const controller=new AbortController();
  const onClose=()=>{if(!res.writableEnded)controller.abort();};
  res.once('close',onClose);
  const id='chatcmpl-fast-'+requestKey.slice(0,32),created=Math.floor(Date.now()/1000);
  let raw='',emitted='';
  const send=(choices,extra={})=>{
    if(res.destroyed||controller.signal.aborted)failGateway(499,'CLIENT_CLOSED','Client closed the stream');
    if(!res.write(`data: ${JSON.stringify({id,created,model,object:'chat.completion.chunk',choices,...extra})}\n\n`)){
      controller.abort();
      failGateway(499,'CLIENT_BACKPRESSURE','Client stopped reading the stream');
    }
  };
  function emit(text){
    if(!text)return;
    if(!res.headersSent){
      res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform'});
      send([{index:0,delta:{role:'assistant'},finish_reason:null}]);
    }
    send([{index:0,delta:{content:text},finish_reason:null}]);
    emitted+=text;
  }
  try{
    if(res.destroyed)controller.abort();
    const result=await onFastChat({messages,requestKey,signal:controller.signal,onTextDelta:text=>{
      raw+=text;
      const cut=safeTextBoundary(raw);
      if(cut){emit(redactSensitiveEgress(raw.slice(0,cut)).text);raw=raw.slice(cut);}
    }});
    if(typeof result?.text!=='string'||!result.text.startsWith(emitted))failGateway(502,'FAST_CHAT_STREAM_CHANGED','Fast chat stream could not be safely finalized');
    emit(result.text.slice(emitted.length));
    if(!res.headersSent)failGateway(502,'MODEL_INCOMPLETE','No plain text available');
    send([{index:0,delta:{},finish_reason:'stop'}],{threadline:{streamMode:'upstream-text',protocolId:'fast-chat'}});
    if(includeUsage&&result.usage){
      const {prompt,completion,hit,miss}=result.usage;
      send([],{usage:{prompt_tokens:prompt,completion_tokens:completion,total_tokens:prompt+completion,
        prompt_cache_hit_tokens:hit,prompt_cache_miss_tokens:miss}});
    }
    return res.end('data: [DONE]\n\n');
  }catch(error){
    if(res.headersSent){res.destroy();return;}
    if(error.status)throw error;
    const errors={SERVICE_BUSY:429,DESKTOP_BUDGET_LIMIT:402,OFFICIAL_BUDGET_LIMIT:402,OFFICIAL_USAGE_UNAVAILABLE:503,
      FAST_CHAT_INPUT:400,FAST_CHAT_PRIVATE_INPUT:400,IDEMPOTENCY_CONFLICT:409,GATEWAY_RESULT_UNAVAILABLE:409,
      UNCERTAIN_REQUEST:502,MODEL_INCOMPLETE:502,CANCELLED:499};
    failGateway(errors[error.code]??500,error.code??'FAST_CHAT_FAILED','Fast chat could not complete');
  }finally{res.off('close',onClose);}
}

export function createEcosystemGateway({
  onChat,
  onFastChat=null,
  onWork=null,
  getStatusSnapshot,
  getConfig,
  sensoryGate = null,
  getActiveResidentId = () => null,
  getSessionTurns = null,
  protocolRegistry = null,
  clock = Date.now,
} = {}) {
  let server = null;
  let boundPort = null;
  const sseClients = new Set();
  const registry=protocolRegistry??createMindProtocolRegistry();
  const idempotency=createIdempotencyCache({clock});
  const breaker=createCircuitBreaker({clock});
  const worldStates=createWorldStateStore({clock});
  const rateLimiter=createRateLimiter({maxPerMinute:120,clock});

  function broadcast(eventName, payload) {
    const line = `event: ${eventName}\ndata: ${JSON.stringify({...payload, ts: Date.now()})}\n\n`;
    for (const res of sseClients) {
      try { if(!res.write(line)){res.destroy();sseClients.delete(res);} } catch { sseClients.delete(res); }
    }
  }

  function emitPhase(kind, text, detail = null) {
    // Cortico / Coopanion + DSH + VTuber friendly status event
    const snap = getStatusSnapshot?.() ?? {};
    const emotion = emotionTagFromGlassbox(snap.glassbox);
    broadcast('status', {
      t: 'status',
      status: kind === 'idle' ? null : {kind, text, detail},
      emotion: emotion.tag,
      mood: emotion.mood,
    });
  }

  async function handleRequest(req, res) {
    const cfg = getConfig?.() ?? {};
    const origin = req.headers.origin;
    const sameOrigin=origin===`http://${req.headers.host}`;
    const tauriOrigin=['tauri://localhost','http://tauri.localhost','https://tauri.localhost'].includes(origin);
    if (origin && !sameOrigin && !tauriOrigin && !(Array.isArray(cfg.allowedOrigins) && cfg.allowedOrigins.includes(origin))) {
      res.writeHead(403, {'content-type': 'application/json; charset=utf-8'});
      return res.end(JSON.stringify({error: {message: 'Cross-origin access blocked by local security guard', code: 'CORS_ORIGIN_FORBIDDEN'}}));
    }
    if (origin) {res.setHeader('access-control-allow-origin', origin);res.setHeader('vary','Origin');}
    res.setHeader('access-control-allow-headers', 'authorization, content-type, x-threadline-client-token, idempotency-key, x-threadline-protocol, x-threadline-audience, x-threadline-output-mode, x-threadline-scene');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const json = (code, value) => {
      res.writeHead(code, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
      res.end(JSON.stringify(value));
    };

    const port=req.socket.localPort;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return json(403,{error:{message:'Loopback Host required'}});
    const auth=req.headers.authorization??'';
    const bearer=auth.startsWith('Bearer ')?auth.slice(7):'';
    const admin=Boolean(cfg.apiKey)&&bearer===cfg.apiKey;
    const scopedHeader=req.headers['x-threadline-client-token'];
    const scoped=sensoryGate?.verifyClientToken(scopedHeader??bearer);
    const denied=(code,message)=>json(code,{error:{message,type:'authentication_error'}});
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/health') {
      return json(200, {ok: true, service: 'threadline-gateway', port: boundPort, version: '2.9.0', sensoryGate: Boolean(sensoryGate)});
    }

    if (req.method === 'GET' && path === '/v1/sensory/status') {
      if (!sensoryGate) return json(404, {error: {message: 'Sensory gate not enabled'}});
      if(admin&&!scopedHeader)return json(200,sensoryGate.status(getActiveResidentId()));
      if(!scoped?.ok)return denied(401,'Sensory token required');
      if(!scoped.scopes.includes('sensory:read'))return denied(403,'INSUFFICIENT_SCOPE');
      const {effectiveLevel,curtain,activeSignals}=sensoryGate.status(scoped.residentId);
      return json(200,{effectiveLevel,curtain,activeSignals:activeSignals.filter(signal=>signal.source===scoped.clientId)});
    }

    if (req.method === 'POST' && (path === '/v1/context/signal' || path === '/v1/sensory/curtain')) {
      if (!sensoryGate) return json(404, {error: {message: 'Sensory gate not enabled'}});
      const curtainPath=path==='/v1/sensory/curtain';
      if(curtainPath&&(!admin||scopedHeader))return denied(403,'Owner authorization required');
      if(!curtainPath&&!scoped?.ok)return denied(401,'Sensory token required');
      if(!curtainPath&&!scoped.scopes.includes('sensory:push'))return denied(403,'INSUFFICIENT_SCOPE');
      if(!curtainPath){
        const rate=rateLimiter.check(`sensory:${scoped.clientId}`);
        if(!rate.allowed)failGateway(429,'RATE_LIMIT','Client rate limit reached',{'retry-after':String(rate.retryAfterSec)});
      }
      const chunks = [];
      let total = 0;
      for await (const c of req) {
        total += c.length;
        if (total > 256 * 1024) return json(413, {error: {message: 'Signal payload too large'}});
        chunks.push(c);
      }
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return json(400, {error: {message: 'Invalid JSON'}}); }
      if(!body||typeof body!=='object'||Array.isArray(body))return json(400,{error:{message:'Object body required'}});
      if(curtainPath){
        if(typeof body.curtain!=='boolean')return json(400,{error:{message:'Explicit curtain state required'}});
        return json(200,sensoryGate.setCurtain(body.curtain));
      }
      if(body.residentId!==undefined&&body.residentId!==scoped.residentId)return denied(403,'RESIDENT_SCOPE');
      const resSig=sensoryGate.ingestSignal({...body,source:scoped.clientId,residentId:scoped.residentId});
      return json(resSig.accepted?200:resSig.reason==='INVALID_SIGNAL'?400:403,resSig);
    }

    if(!admin||scopedHeader)return denied(scoped?.ok?403:401,'Owner gateway credential required');
    const principal='owner';
    const modelId=cfg.modelName||'threadline-brain';

    const fastModel=`${modelId}:fast-chat`;
    const fastEnabled=cfg.fastChat===true&&typeof onFastChat==='function';
    const workModel=`${modelId}:work`;
    const workEnabled=cfg.workChannel===true&&typeof onWork==='function';
    const chatModels=[modelId,`${modelId}:chat`,`${modelId}:voice`,`${modelId}:call`,`${modelId}:game`];
    const chooseProtocol=({model,protocolId,audience,outputMode})=>{
      const target=model??modelId;
      if(typeof target!=='string'||parseModelTarget(target).residentId!==modelId)failGateway(404,'MODEL_NOT_FOUND','Model is unavailable for the active resident');
      if(!chatModels.includes(target)){
        if([`${modelId}:work`,`${modelId}:raw`].includes(target))failGateway(501,'CHANNEL_UNSUPPORTED','Task-preserving and transparent provider channels are not available');
        failGateway(404,'MODEL_NOT_FOUND','Unknown model or preset');
      }
      if(audience!==undefined&&audience!=='owner')failGateway(403,'AUDIENCE_UNAVAILABLE','This gateway only supports owner-audience cognition');
      if(outputMode!==undefined&&!['text','voice'].includes(outputMode))failGateway(400,'OUTPUT_MODE_INVALID','Only text and voice output are supported');
      let resolved;
      try{resolved=registry.resolve({protocolId,model:target,overrides:outputMode?{outputMode,speakableOnly:outputMode==='voice'}:null});}
      catch(error){if(error.code==='PROTOCOL_NOT_FOUND')failGateway(404,error.code,'Unknown mind protocol');throw error;}
      if(resolved.protocol.audienceLevel!=='owner')failGateway(403,'AUDIENCE_UNAVAILABLE','This gateway only supports owner-audience cognition');
      if(!['mind-native','auto'].includes(resolved.protocol.channelMode)||resolved.protocol.outputMode==='action')failGateway(501,'CHANNEL_UNSUPPORTED','This protocol requires an unavailable execution channel');
      return {target,protocol:resolved.protocol};
    };
    const resident=getActiveResidentId()??modelId;
    const ownerScope=digest({principal,resident});
    const scopeFor=sceneId=>digest({ownerScope,sceneId});
    const advertised=[...chatModels,...(fastEnabled?[fastModel]:[]),...(workEnabled?[workModel]:[])];
    if(req.method==='GET'&&path==='/v1/models'){
      return json(200,{object:'list',data:advertised.map(id=>({id,object:'model',created:Math.floor(Date.now()/1000),owned_by:'threadline-agent'}))});
    }
    if(req.method==='GET'&&path==='/v1/protocols'){
      return json(200,{...registry.list(),supportedModels:advertised,capabilities:{audiences:['owner'],fastTextStream:fastEnabled,workToolCalls:workEnabled,toolCalls:false,structuredOutputs:false,upstreamStream:false,worldStateInPrompt:false,externalActions:false,sessionMemoryWrites:false,mindPolicy:'resident-config'}});
    }
    if(req.method==='GET'&&path==='/v1/world/state'){
      const sceneId=readScene(url.searchParams.get('sceneId')??undefined);
      return json(200,{sceneId,...worldStates.get(scopeFor(sceneId))});
    }
    if(req.method==='POST'&&(path==='/v1/world/state'||path==='/v1/sessions/end')){
      const body=await readObject(req,32*1024);
      const sceneId=readScene(body.sceneId),sceneKey=scopeFor(sceneId);
      if(path==='/v1/world/state'){
        validateWorldState(body.state,body.deadband);
        return json(200,{sceneId,...worldStates.upsert(sceneKey,body.state,{deadband:body.deadband})});
      }
      if(Object.hasOwn(body,'turns'))failGateway(400,'SESSION_REFS_HOST_ONLY','Session source records come from the active resident store');
      if(!getSessionTurns)failGateway(501,'SESSION_HISTORY_UNAVAILABLE','No resident session history is connected');
      const {protocol}=chooseProtocol(body);
      const turns=await getSessionTurns({sceneKey});
      const result=crystallizeSession({sceneId,protocol,turns});
      worldStates.clear(sceneKey);
      return json(200,{...result,persisted:false});
    }

    if (req.method === 'GET' && (path === '/v1/events' || path === '/v1/status/stream')) {
      if(sseClients.size>=16)failGateway(503,'STATUS_STREAM_LIMIT','Status stream capacity reached');
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      sseClients.add(res);
      const snap = getStatusSnapshot?.() ?? {};
      const emotion = emotionTagFromGlassbox(snap.glassbox);
      res.write(`event: init\ndata: ${JSON.stringify({
        t: 'init',
        status: null,
        emotion: emotion.tag,
        mood: emotion.mood,
        character: snap.characterName ?? 'Threadline',
      })}\n\n`);
      const keepalive = setInterval(() => {
        try { res.write(': keepalive\n\n'); } catch { clearInterval(keepalive); sseClients.delete(res); }
      }, 20000);
      keepalive.unref?.();
      req.on('close', () => { clearInterval(keepalive); sseClients.delete(res); });
      return;
    }

    if(req.method==='POST'&&path==='/v1/chat/completions'){
      const rate=rateLimiter.check(principal);
      if(!rate.allowed)failGateway(429,'RATE_LIMIT','Client rate limit reached',{'retry-after':String(rate.retryAfterSec)});
      const body=await readObject(req,256*1024);
      if(body.stream!==undefined&&typeof body.stream!=='boolean')failGateway(400,'STREAM_INVALID','stream must be boolean');
      if(body.model===workModel){
        if(!workEnabled)failGateway(501,'CHANNEL_UNSUPPORTED','Work channel is disabled');
        if(body.stream)failGateway(501,'WORK_STREAM_UNSUPPORTED','Work channel currently uses non-streaming replies');
        if(req.headers['x-threadline-audience']&&req.headers['x-threadline-audience']!=='owner')
          failGateway(403,'AUDIENCE_UNAVAILABLE','Work channel is owner-only');
        if(req.headers['x-threadline-protocol']||req.headers['x-threadline-output-mode'])
          failGateway(400,'WORK_REQUEST','Work channel uses the caller tool protocol only');
        const validation=validateWorkApiRequest(body);
        if(!validation.ok)failGateway(400,validation.code,validation.message);
        const sceneId=readScene(req.headers['x-threadline-scene']??body.user);
        const key=req.headers['idempotency-key'];
        if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(key??''))failGateway(400,'IDEMPOTENCY_KEY_INVALID','Work channel requires Idempotency-Key');
        const requestKey=digest({scope:scopeFor(sceneId),channel:'work',key});
        const controller=new AbortController(),onClose=()=>{if(!res.writableEnded)controller.abort();};
        res.once('close',onClose);
        try{
          if(res.destroyed||req.aborted)controller.abort();
          const reply=await onWork({body,requestKey,signal:controller.signal});
          if(!res.destroyed)return json(200,reply);
          return;
        }catch(error){
          const codes={SERVICE_BUSY:429,DESKTOP_BUDGET_LIMIT:402,OFFICIAL_BUDGET_LIMIT:402,OFFICIAL_USAGE_UNAVAILABLE:503,
            IDEMPOTENCY_CONFLICT:409,GATEWAY_RESULT_UNAVAILABLE:409,WORK_REQUEST:400,WORK_RESPONSE:502,UNCERTAIN_REQUEST:502,CANCELLED:499};
          const code=Object.hasOwn(codes,error.code)?error.code:'WORK_FAILED';
          failGateway(codes[code]??502,code,'Work request could not complete');
        }finally{res.off('close',onClose);}
      }
      const explicitField=UNSUPPORTED_FIELDS.find(name=>body[name]!=null);
      if(explicitField||body.n!=null&&body.n!==1)failGateway(501,'PARAMETER_UNSUPPORTED',`Unsupported parameter: ${explicitField??'n'}`);
      if(body.tools!=null&&(!Array.isArray(body.tools)||body.tools.length)||body.tool_choice!=null&&!['none','auto'].includes(body.tool_choice)||
         body.response_format!=null&&body.response_format.type!=='text'||Array.isArray(body.messages)&&body.messages.some(m=>m?.role==='tool'||m?.tool_calls?.length)){
        failGateway(501,'CONTRACT_UNSUPPORTED','External tools and strict structured output are not available on this model');
      }
      if(body.stream_options!=null&&(!body.stream||typeof body.stream_options.include_usage!=='boolean'||Object.keys(body.stream_options).length!==1))failGateway(400,'STREAM_OPTIONS_INVALID','stream_options supports include_usage for SSE only');
      const userText=readUserText(body.messages);
      if(userText===null)failGateway(501,'MESSAGE_TYPE_UNSUPPORTED','Only user and assistant text messages are accepted');
      if(!userText||userText.length>8000)failGateway(400,'CHAT_SIZE','The final user message must contain 1–8000 characters');

      if(body.model===fastModel){
        if(!fastEnabled)failGateway(501,'FAST_CHAT_DISABLED','The experimental fast chat route is disabled');
        if(!body.stream)failGateway(400,'FAST_CHAT_STREAM_REQUIRED','Fast chat requires stream=true');
        if(req.headers['x-threadline-audience']&&req.headers['x-threadline-audience']!=='owner')
          failGateway(403,'AUDIENCE_UNAVAILABLE','Fast chat is owner-only');
        if(req.headers['x-threadline-protocol']||req.headers['x-threadline-output-mode']&&req.headers['x-threadline-output-mode']!=='text')
          failGateway(400,'FAST_CHAT_INPUT','Fast chat uses the fixed plain text contract');
        if(classifyApiRequest(body).isNoise)failGateway(501,'AUXILIARY_CHANNEL_UNAVAILABLE','Auxiliary requests are unavailable');
        const sceneId=readScene(req.headers['x-threadline-scene']??body.user);
        const key=req.headers['idempotency-key'];
        if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(key??''))failGateway(400,'IDEMPOTENCY_KEY_INVALID','Fast chat requires Idempotency-Key');
        const requestKey=digest({scope:scopeFor(sceneId),channel:'fast-chat',key});
        const messages=body.messages.map(({role,content})=>({role,content:typeof content==='string'?content:content.map(part=>part.text).join('\n')}));
        return deliverFastChat({res,onFastChat,messages,requestKey,model:fastModel,includeUsage:body.stream_options?.include_usage===true});
      }
      const {target:model,protocol}=chooseProtocol({model:body.model,protocolId:req.headers['x-threadline-protocol'],
        audience:req.headers['x-threadline-audience'],outputMode:req.headers['x-threadline-output-mode']});
      const classification=classifyApiRequest(body,protocol);
      if(classification.channel!=='mind-native')failGateway(501,classification.isNoise?'AUXILIARY_CHANNEL_UNAVAILABLE':'CHANNEL_UNSUPPORTED',
        classification.isNoise?'Auxiliary requests do not enter resident cognition':'This request needs the external-history channel');

      const sceneId=readScene(req.headers['x-threadline-scene']??body.user),sceneKey=scopeFor(sceneId);
      const key=req.headers['idempotency-key'];
      if(key!==undefined&&!/^[A-Za-z0-9_.:-]{1,128}$/.test(key))failGateway(400,'IDEMPOTENCY_KEY_INVALID','Invalid Idempotency-Key');
      const requestKey=key===undefined?null:digest({sceneKey,key});
      // SSE and JSON are delivery formats for the same accepted decision.
      const fingerprint=digest({model,protocol,messages:body.messages});
      const controller=new AbortController();
      const onClose=()=>{if(!res.writableEnded)controller.abort();};
      res.once('close',onClose);
      if(res.destroyed||req.aborted)controller.abort();
      let payload;
      try{
        payload=await idempotency.claim(requestKey,fingerprint,async()=>{
          const retrySeconds=breaker.retryAfter(ownerScope);
          if(retrySeconds)failGateway(503,'CIRCUIT_OPEN','The model circuit is cooling down',{'retry-after':String(retrySeconds)});
          if(controller.signal.aborted)failGateway(499,'CLIENT_CLOSED','Client disconnected before admission');

          emitPhase('thinking','正在思考回复…');
          let result;
          try{
            result=await onChat(userText,{sceneId,sceneKey,residentId:resident,model,protocol,classification,
              worldState:worldStates.get(sceneKey).state,signal:controller.signal,requestKey});
            breaker.recordSuccess(ownerScope);
          }catch(error){
            const code=error.code??'BRAIN_ERROR';
            if(PROVIDER_FAILURES.has(code))breaker.recordFailure(ownerScope);
            const status={SERVICE_BUSY:429,DESKTOP_BUDGET_LIMIT:402,IDEMPOTENCY_CONFLICT:409,GATEWAY_RESULT_UNAVAILABLE:409,CLIENT_CLOSED:499}[code]??500;
            failGateway(status,code,status===500?'Brain request failed':error.message??code,status===429?{'retry-after':'1'}:{});
          }finally{emitPhase('idle',null);}

          const emotion=emotionTagFromGlassbox(getStatusSnapshot?.()?.glassbox);
          const raw=redactSensitiveEgress(result?.text??result?.reply??'').text;
          const purified=purifyOutputForModality(raw,{outputMode:protocol.outputMode,speakableOnly:protocol.speakableOnly,maxChars:protocol.maxCharsPerUtterance});
          const text=cfg.includeEmotionTag&&protocol.outputMode!=='voice'&&purified.text&&emotion.tag!=='neutral'?`[${emotion.tag}] ${purified.text}`:purified.text;
          const usage=result?.usage??null;
          return {id:'chatcmpl-'+randomUUID().replace(/-/g,'').slice(0,20),object:'chat.completion',created:Math.floor(Date.now()/1000),model,
            choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],...(usage?{usage}:{}),
            threadline:{emotion:emotion.tag,live:Boolean(result?.live),protocolId:protocol.id,channel:classification.channel,actions:purified.actions,
              streamMode:'committed-replay'}};
        });
      }finally{res.off('close',onClose);}
      if(res.destroyed)return;
      if(!body.stream)return json(200,payload);

      res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform'});
      const {id,created}=payload;
      const send=(choices,extra={})=>res.write(`data: ${JSON.stringify({id,object:'chat.completion.chunk',created,model,choices,...extra})}\n\n`);
      const delta=(value,finish_reason=null,extra={})=>send([{index:0,delta:value,finish_reason}],extra);
      delta({role:'assistant',content:''});
      for(const text of payload.choices[0].message.content.match(/[\s\S]{1,64}/gu)??[])delta({content:text});
      delta({},'stop',{threadline:payload.threadline});
      if(body.stream_options?.include_usage&&payload.usage)send([],{usage:payload.usage});
      return res.end('data: [DONE]\n\n');
    }

    return json(404, {error: {message: 'Not found'}});
  }

  async function start({port = 18792, host = '127.0.0.1'} = {}) {
    if(host!=='127.0.0.1')throw Object.assign(Error('Gateway requires IPv4 loopback'),{code:'GATEWAY_HOST'});
    await stop();
    const listenOn = p => new Promise((resolve, reject) => {
      const s=createServer((req,res)=>{
        void handleRequest(req,res).catch(error=>{
          if(res.destroyed)return;
          if(res.headersSent){res.destroy();return;}
          const status={IDEMPOTENCY_CONFLICT:409,IDEMPOTENCY_CAPACITY:503,WORLD_STATE_LIMIT:400}[error.code]??error.status??500;
          res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...error.headers});
          res.end(JSON.stringify({error:{message:status===500?'Gateway request failed':error.message,
            type:status>=500?'server_error':'invalid_request_error',code:error.code??'GATEWAY_ERROR'}}));
        });
      });
      s.once('error', reject);
      s.listen(p, host, () => resolve(s));
    });
    let candidate = Number.isInteger(port) && port >= 0 ? port : 18792;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        server = await listenOn(candidate);
        boundPort = server.address().port;
        return {running: true, host, port: boundPort, baseUrl: `http://${host}:${boundPort}`};
      } catch (err) {
        if (err.code === 'EADDRINUSE' && candidate > 0) { candidate++; continue; }
        throw err;
      }
    }
    server = await listenOn(0);
    boundPort = server.address().port;
    return {running: true, host, port: boundPort, baseUrl: `http://${host}:${boundPort}`};
  }

  async function stop() {
    for (const res of sseClients) {
      try { res.end(); } catch { /* ignore */ }
    }
    sseClients.clear();
    worldStates.clearAll();
    breaker.clear();
    idempotency.clear();
    if (!server) return;
    const s = server;
    server = null;
    boundPort = null;
    await new Promise(resolve => s.close(() => resolve()));
  }

  return {
    start,
    stop,
    broadcast,
    emitPhase,
    status: () => ({
      running: Boolean(server),
      port: boundPort,
      baseUrl: boundPort ? `http://127.0.0.1:${boundPort}` : null,
      clients: sseClients.size,
    }),
  };
}
