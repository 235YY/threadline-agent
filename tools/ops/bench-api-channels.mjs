// Step 4 Read-Only Channel Benchmark & Cost/Latency Evaluator ('bench-api-channels-v1'):
// Separately reports protocol correctness, cache hit rate, firstContentMs (p50/p95),
// finalReplyMs (p50/p95), and estimated cost per scenario before widening context windows.
//
// Usage:
//   node tools/ops/bench-api-channels.mjs <traces.json>
//   node tools/ops/bench-api-channels.mjs --probe <request.json> --send-one

import {readFileSync, statSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {parseProviderSSEStream} from '../../src/upstream-sse.mjs';

function pct(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1))];
}

export function summarizeChannelMetrics(traces = []) {
  const byProtocol = Object.create(null);
  for (const t of traces) {
    const protocol = t?.protocolId || 'unknown';
    const key = t?.measurement === 'api-client' ? `${protocol} [api-client, ${t.delivery}]` : protocol;
    (byProtocol[key] ??= []).push(t);
  }

  const report = Object.create(null);
  for (const [proto, list] of Object.entries(byProtocol)) {
    const completions=new Set();
    const timed=list.filter(x=>{
      if(x.measurement!=='api-client')return true;
      if(!x.effectiveReply||!x.completionId||completions.has(x.completionId))return false;
      completions.add(x.completionId);
      return true;
    });
    const firstMs = timed.map(x => x.firstContentMs).filter(v => Number.isFinite(v) && v >= 0);
    const totalMs = timed.map(x => x.totalMs).filter(v => Number.isFinite(v) && v >= 0);
    const cache=list.filter(x=>[x.promptTokens,x.cacheHitTokens].every(v=>Number.isSafeInteger(v)&&v>=0)&&x.cacheHitTokens<=x.promptTokens);
    const totalPrompt=cache.reduce((sum,x)=>sum+x.promptTokens,0);
    const totalHit=cache.reduce((sum,x)=>sum+x.cacheHitTokens,0);
    const costs = list.map(x => x.costMicros).filter(v => Number.isSafeInteger(v) && v >= 0);
    const classified = list.filter(x => typeof x.protocolOk === 'boolean');
    const okCount = classified.filter(x => x.protocolOk).length;
    const measured=list.filter(x=>x.measurement==='api-client');
    // Reused completion IDs can represent an idempotent result, not another effective model reply.
    const effective=completions.size;
    const confirmed=measured.map(x=>x.officialCostMicros).filter(v=>Number.isSafeInteger(v)&&v>=0);
    const allCosts=effective>0&&confirmed.length===measured.length;

    report[proto] = {
      count: list.length,
      ...(measured.length?{effectiveReplies:effective,officialCostSamples:confirmed.length,
        officialCnyPerEffectiveReply:allCosts?confirmed.reduce((sum,v)=>sum+v,0)/effective/1_000_000:null}:{}),
      protocolCorrectnessRate: classified.length ? Number((okCount / classified.length).toFixed(4)) : null,
      correctnessSamples: classified.length,
      firstContentSamples: firstMs.length,
      finalReplySamples: totalMs.length,
      costSamples: costs.length,
      cacheSamples:cache.length,
      weightedCacheHitRate: totalPrompt > 0 ? Number((totalHit / totalPrompt).toFixed(4)) : null,
      firstContentP50Ms: pct(firstMs, 0.5),
      firstContentP95Ms: pct(firstMs, 0.95),
      finalReplyP50Ms: pct(totalMs, 0.5),
      finalReplyP95Ms: pct(totalMs, 0.95),
      avgCostMicros: costs.length ? Math.round(costs.reduce((sum,v) => sum+v,0) / costs.length) : null,
      noiseFilteredCount: list.filter(x => x.filteredNoise).length,
      interruptedCount: list.filter(x => x.interrupted).length,
    };
  }
  return {totalTraces: traces.length, byProtocol: report};
}

export function tracesFromJournal(rows) {
  return rows.filter(row => row?.status === 'settled' && row.usage).map(row => ({
    protocolId:row.wireTelemetry?.protocolId ?? (['full','incremental'].includes(row.wireTelemetry?.reflectionProjection)?'reflection-'+row.wireTelemetry.reflectionProjection:row.wireTelemetry?.sourceKind ?? row.source?.kind ?? 'untagged'),
    firstContentMs:row.wireTelemetry?.firstContentMs,
    totalMs:row.wireTelemetry?.durationMs,
    promptTokens:row.usage.prompt,
    cacheHitTokens:row.usage.hit,
    costMicros:row.accounting?.calculatedMicros ?? row.actualMicros ?? row.usage.upperMicros,
    protocolOk:row.validation?.status === 'accepted' ? true : row.validation?.status === 'rejected' ? false : undefined,
  }));
}

export function channelMarkdown(report){
  const rows=['| 通道 | 样本 | 有效回复 | 协议通过率 | 加权命中 | 首段 P50/P95 ms | 完成 P50/P95 ms | 估算 ¥/请求 | 官方 ¥/有效回复 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|'];
  const pct=v=>v==null?'—':(v*100).toFixed(1)+'%';
  for(const [label,s] of Object.entries(report.byProtocol)){
    const name=label.replace(/[<>&|`\r\n]/g,char=>`&#${char.charCodeAt(0)};`);
    rows.push(`| ${name} | ${s.count} | ${s.effectiveReplies??'—'} | ${pct(s.protocolCorrectnessRate)} | ${pct(s.weightedCacheHitRate)} | ${s.firstContentP50Ms??'—'} / ${s.firstContentP95Ms??'—'} | ${s.finalReplyP50Ms??'—'} / ${s.finalReplyP95Ms??'—'} | ${s.avgCostMicros==null?'—':(s.avgCostMicros/1e6).toFixed(5)} | ${s.officialCnyPerEffectiveReply?.toFixed(5)??'—'} |`);
  }
  return rows.join('\n');
}

export async function measureApiReply({endpoint,apiKey,body,scene,idempotencyKey,timeoutMs=180_000,
  fetchImpl=fetch,clock=()=>performance.now()}={}){
  const url=new URL(endpoint);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/v1/chat/completions'||
     url.username||url.password||url.search||url.hash)throw Error('PROBE_LOOPBACK_REQUIRED');
  if(!apiKey||!body||typeof body!=='object'||!Array.isArray(body.messages)||
     !/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey??''))throw Error('PROBE_CONFIG');
  const headers={authorization:`Bearer ${apiKey}`,'content-type':'application/json','idempotency-key':idempotencyKey};
  if(scene)headers['x-threadline-scene']=scene;
  const stream=body.stream===true;
  const trace={measurement:'api-client',delivery:stream?'sse':'json',protocolId:body.model??'default',
    idempotencyKey,scene:scene??null,startedAt:new Date().toISOString(),status:null,protocolOk:false,effectiveReply:false,completionId:null,firstContentMs:null,totalMs:null};
  const start=clock();
  const elapsed=()=>Math.max(0,Math.round(clock()-start));
  try{
    const response=await fetchImpl(url,{method:'POST',redirect:'error',headers,body:JSON.stringify(body),
      signal:AbortSignal.timeout(timeoutMs)});
    trace.status=response.status;
    if(!response.ok){
      trace.result='http-error';
      await response.body?.cancel().catch(()=>{});
      return trace;
    }
    let content,finish,usage;
    if(stream){
      const parsed=await parseProviderSSEStream(response.body,{onContentDelta:delta=>{
        if(trace.firstContentMs===null&&delta.trim())trace.firstContentMs=elapsed();
      }});
      if(!parsed.sawDone){trace.result='incomplete';return trace;}
      ({content,usage,finishReason:finish,providerResponseId:trace.completionId}=parsed);
    }else{
      const raw=await response.json();
      const choice=raw?.choices?.[0];
      ({content}=choice?.message??{});
      finish=choice?.finish_reason;
      usage=raw?.usage;
      trace.completionId=raw?.id??null;
      if(typeof content==='string'&&content.trim())trace.firstContentMs=elapsed();
    }
    trace.protocolOk=typeof trace.completionId==='string'&&typeof content==='string'&&finish==='stop';
    trace.effectiveReply=trace.protocolOk&&Boolean(content.trim());
    trace.result=!trace.protocolOk?'invalid-reply':trace.effectiveReply?'reply':'silent';
    if(Number.isSafeInteger(usage?.prompt_tokens))trace.promptTokens=usage.prompt_tokens;
    if(Number.isSafeInteger(usage?.prompt_cache_hit_tokens))trace.cacheHitTokens=usage.prompt_cache_hit_tokens;
    return trace;
  }catch{
    trace.result='unconfirmed';
    return trace;
  }finally{
    trace.totalMs=elapsed();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && process.argv[2]==='--probe') {
  if(process.argv.length!==5||process.argv[4]!=='--send-one')throw Error('usage: --probe <request.json> --send-one');
  const options=JSON.parse(readFileSync(process.argv[3],'utf8'));
  const trace=await measureApiReply({...options,apiKey:process.env.THREADLINE_BENCH_GATEWAY_KEY,fetchImpl:fetch});
  console.log(JSON.stringify(trace,null,2));
  if(!trace.effectiveReply)process.exitCode=1;
}else if (isMain) {
  const file = process.argv[2];
  if (!file || !statSync(file).isFile()) {
    throw new Error('usage: node tools/ops/bench-api-channels.mjs <traces.json> [--json]');
  }
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const traces = Array.isArray(raw) ? raw : raw.traces ?? (Array.isArray(raw.requests) ? tracesFromJournal(raw.requests) : []);
  const summary=summarizeChannelMetrics(traces);
  console.log(process.argv.includes('--markdown')?channelMarkdown(summary):JSON.stringify(summary,null,2));
}
