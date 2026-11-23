import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeProposal} from '../src/proposal-normalization.mjs';
for(const seed of [17,99,24301])test(`种子${seed}：128组结构噪声不改变认识、引用、选择或工具权限`,()=>{
 let state=seed;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
 for(let n=0;n<128;n++){
  const change={id:'s-'+random(),expectedRevision:random()%5,kind:'belief',body:'条件未确认，保留未知。'+String.fromCodePoint(0x1f30a),nature:'reappraisal',basis:{priorStates:[{id:'nonexistent-'+random(),revision:2}]},['extra-'+random()]:{hint:'noise'}};
  const original={packetId:'p-'+random(),selected:'choice',options:[{id:'choice',kind:n%2?'act':'wait',payload:n%2?{tool:'not-granted',args:{value:random()}}:{mode:'next-event'}}],summary:'synthetic',used:[{ref:{id:'missing',revision:99},aspect:'belief',effect:'support'}],continuity:{changes:[change],observationDisposition:'handled'},['unknown-'+random()]:true};
  const before=JSON.stringify(original),r=normalizeProposal(original,{stage:'decisionGraph'}).value;
  assert.equal(JSON.stringify(original),before);assert.deepEqual(r.options,original.options);assert.deepEqual(r.used,original.used);assert.deepEqual(r.continuity.changes[0].basis,change.basis);assert.equal(r.continuity.changes[0].nature,change.nature);assert.equal(r.continuity.changes[0].body,change.body);assert.equal(r.continuity.changes[0].expectedRevision,change.expectedRevision);assert.equal(r.selected,original.selected);
 }
});
