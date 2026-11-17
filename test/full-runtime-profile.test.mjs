import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveBrainConfig} from '../tools/brain-service/runtime-config.mjs';
import {launchBrain} from '../tools/brain-service/bootstrap.mjs';
import {buildStudyRequest} from '../src/model-client.mjs';

test('explicit production reasoning/output profile reaches provider contract without altering defaults or budget',()=>{
  const base={JY_AFFECT:'0',BRAIN_STORE:':memory:'},a=resolveBrainConfig({env:base}),b=resolveBrainConfig({env:{...base,BRAIN_REASONING:'high',BRAIN_MAX_TOKENS:'6000'}});
  assert.equal(a.profile.reasoning,'low');assert.equal(a.profile.maxTokens,3000);assert.equal(b.profile.dailyMicros,a.profile.dailyMicros);assert.notEqual(b.configFingerprint,a.configFingerprint);
  const request=buildStudyRequest([{role:'user',content:'synthetic JSON test'}],b.profile);assert.equal(request.reasoning_effort,'high');assert.equal(request.max_tokens,6000);assert.equal(request.thinking.type,'enabled');assert.equal(request.response_format.type,'json_object');
});

test('invalid runtime reasoning/output settings fail before credentials or model construction',()=>{
  for(const value of ['max','HIGH','',null])assert.throws(()=>resolveBrainConfig({env:{JY_AFFECT:'0',BRAIN_STORE:':memory:',BRAIN_REASONING:value}}),{code:'RUNTIME_CONFIG'});
  for(const value of ['0','6001','-1','3.5',''])assert.throws(()=>resolveBrainConfig({env:{JY_AFFECT:'0',BRAIN_STORE:':memory:',BRAIN_MAX_TOKENS:value}}),{code:'RUNTIME_CONFIG'});
});

test('standard launch with affect fusion, memory V2 and bounded investigation handoff survives restart',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'jy-full-profile-'));writeFileSync(join(dir,'identity.txt'),'隔离合成主体，不是真实用户。');
  const env={BRAIN_LIVE:'1',JY_LIVE_CONFIRM:'YES',BRAIN_PORT:'0',BRAIN_HEARTBEAT_MS:'0',BRAIN_MAINTENANCE:'0',BRAIN_STORE:join(dir,'s.sqlite'),BRAIN_STATE:join(dir,'state'),BRAIN_STYLE_DIR:join(dir,'style'),BRAIN_IDENTITY_FILE:join(dir,'identity.txt'),BRAIN_LEDGER:join(dir,'fake-budget.json'),JY_BUDGET_DIR:dir,BRAIN_MAX_CALLS:'96',BRAIN_MAX_MICROS:'1000000',BRAIN_REASONING:'high',BRAIN_MAX_TOKENS:'6000',BRAIN_GLOBAL:'1',JY_AFFECT:'1',JY_AFFECT_FUSION:'1',JY_APPERCEPTION_V1:'1',JY_TASK_THREADS:'1',JY_SUBJECTIVE_DOMAINS:'1',JY_SUBJECTIVE_MEMORY:'0',JY_SUBJECTIVE_MEMORY_V2:'1',JY_ALGORITHM_V011:'1',JY_ANCHOR_DIRECTORY:'1',JY_EXPERIENCE_LEARNING_V1:'0',JY_MEMORY_SCOPE_V1:'1',JY_INVESTIGATION_CONTINUITY_V1:'1'};
  const packets=[],profiles=[];const dependencies={officialSpend:{gate:()=>({known:true,allow:true})},auditBudgets:()=>{throw Error('legacy budget must not gate standard launch');},tools:{TOOL_NAMES:[],executeTool:()=>{throw Error('NO_EXTERNAL_TOOL_IN_OFFLINE_TEST');}},createModelDecision:({profile})=>{profiles.push(profile);return {close(){},decide:p=>{
    packets.push(p);return JSON.stringify({packetId:p.packetId,options:[{id:'wait',kind:'wait',payload:{}}],selected:'wait',summary:'SYNTHETIC_INVESTIGATION_PHASE_'+packets.length,used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:{processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]}}});
  }};}};
  let brain=await launchBrain({env,dependencies});t.after(async()=>{if(brain)await brain.stop();});
  const first=await brain.service.reply({source:'fixture',key:'first',scene:'synthetic',message_id:'one',messages:[{role:'user',content:'隔离材料第一阶段'}]});assert.equal(first.ok,true);assert.ok(first.result?.decision??[...brain.service.store.all('decision')].length);
  const prior=[...brain.service.store.all('decision')].at(-1);await brain.stop();brain=null;
  brain=await launchBrain({env,dependencies});await new Promise(r=>setTimeout(r,1100));
  const next=await brain.service.reply({source:'fixture',key:'second',scene:'synthetic',message_id:'two',messages:[{role:'user',content:'继续隔离调查'}]});assert.equal(next.ok,true);assert.equal(packets.length,2);
  const p=packets[1];assert.ok(p.payload.previousDecisions.some(d=>d.summary===prior.output.summary));assert.ok(p.payload.previousDecisions.length<=2);assert.match(p.instruction,/【记忆调用与认识范围】/);assert.ok(p.payload.continuity.motivation);assert.equal(p.payload.subjectiveMemoryV2.enabled,true);assert.equal(p.payload.taskThreads.enabled,true);assert.ok(p.bytes<=131072);assert.equal(profiles[1].reasoning,'high');assert.equal(profiles[1].maxTokens,6000);assert.equal(brain.config.cognition.experienceLearningV1,false);assert.equal(brain.config.maintenance,false);
});
