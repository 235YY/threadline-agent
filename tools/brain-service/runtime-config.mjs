import {existsSync,readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {runtimeSourceIdentity} from './instance-guard.mjs';
import {resolve} from 'node:path';
import {ensure,digest} from '../../src/contracts.mjs';
import {affectRuntimeConfig} from '../affect-integrated/runtime-config.mjs';

export function assertSupportedNode(version=process.versions.node){
 const match=/^(\d+)\.(\d+)\.(\d+)$/.exec(version);ensure(match&&(Number(match[1])>26||Number(match[1])===26&&Number(match[2])>=8),'NODE_VERSION','Node >=26.8.0 stable is required');
}
export const COGNITION_FLAGS=Object.freeze({algorithmV011:'JY_ALGORITHM_V011',apperceptionV1:'JY_APPERCEPTION_V1',subjectiveDomains:'JY_SUBJECTIVE_DOMAINS',subjectiveMemory:'JY_SUBJECTIVE_MEMORY',subjectiveMemoryV2:'JY_SUBJECTIVE_MEMORY_V2',taskThreads:'JY_TASK_THREADS',anchorDirectory:'JY_ANCHOR_DIRECTORY',memoryScopeV1:'JY_MEMORY_SCOPE_V1',investigationContinuityV1:'JY_INVESTIGATION_CONTINUITY_V1',experienceLearningV1:'JY_EXPERIENCE_LEARNING_V1'});
export function flag(env,name,fallback=false){
 const value=env[name];if(value===undefined)return fallback;
 ensure(value==='0'||value==='1','RUNTIME_CONFIG',`${name} must be 0 or 1`);return value==='1';
}
function integer(env,name,fallback,min,max){
 const raw=env[name]??fallback;
 ensure((typeof raw==='number'||typeof raw==='string'&&/^\d+$/.test(raw))&&Number.isSafeInteger(Number(raw))&&Number(raw)>=min&&Number(raw)<=max,'RUNTIME_CONFIG',`${name} is outside its integer range`);
 return Number(raw);
}
const file=(root,value)=>value===':memory:'?value:resolve(root,value);
export function resolveBrainConfig({root=process.cwd(),env=process.env}={}){
 root=resolve(root);
 for(const name of ['BRAIN_STORE','BRAIN_STATE','BRAIN_STYLE_DIR','BRAIN_IDENTITY_FILE','BRAIN_LEDGER','JY_BUDGET_DIR'])if(env[name]!==undefined)ensure(typeof env[name]==='string'&&env[name].trim(),'RUNTIME_CONFIG',`${name} must be a nonempty path`);
 const live=flag(env,'BRAIN_LIVE');
 if(live){ensure(env.JY_LIVE_CONFIRM==='YES','LIVE_CONFIRM_REQUIRED','live start requires explicit confirmation');ensure(typeof env.BRAIN_LEDGER==='string'&&env.BRAIN_LEDGER.trim(),'LIVE_BUDGET_REQUIRED','live start requires its existing request journal path');}
 if(env.JY_AFFECT!==undefined)flag(env,'JY_AFFECT');
 const isolatedStore=live?env.BRAIN_STORE:env.BRAIN_STORE??'_local/dry-run/subject.sqlite';
 const affect=affectRuntimeConfig({root,env:{...env,...(isolatedStore!==undefined?{BRAIN_STORE:isolatedStore}:{})}});
 const fusion=flag(env,'JY_AFFECT_FUSION');ensure(!fusion||affect.enabled,'RUNTIME_CONFIG','affect fusion requires affect enabled');
 const cognition=Object.fromEntries(Object.entries(COGNITION_FLAGS).map(([key,name])=>[key,flag(env,name)]));
 if(fusion)cognition.apperceptionV1=true;
 ensure(!(cognition.subjectiveMemory&&cognition.subjectiveMemoryV2),'RUNTIME_CONFIG','choose one subjective memory generation');
 const callLimit=env.BRAIN_MAX_CALLS==='unlimited'?null:integer(env,'BRAIN_MAX_CALLS',96,1,1000);
 const reasoning=env.BRAIN_REASONING===undefined?'low':env.BRAIN_REASONING;
 ensure(['low','high','off'].includes(reasoning),'RUNTIME_CONFIG','BRAIN_REASONING must be low, high or off');
 const rhythm={dailyCallCap:live?null:callLimit};
 if(env.JY_QUIET_FROM!==undefined)rhythm.quietFromHour=integer(env,'JY_QUIET_FROM',0,0,23);
 if(env.JY_QUIET_TO!==undefined)rhythm.quietToHour=integer(env,'JY_QUIET_TO',0,0,23);
 const config={root,mode:live?'live':'dry-run',live,port:integer(env,'BRAIN_PORT',8787,0,65535),
  storePath:file(root,isolatedStore??affect.storePath),
  stateDirectory:resolve(root,env.BRAIN_STATE??(live?'_local/brain/state':'_local/dry-run/state')),
  styleDirectory:resolve(root,env.BRAIN_STYLE_DIR??(live?'_local/style':'_local/dry-run/style')),
  identityFile:resolve(root,env.BRAIN_IDENTITY_FILE??'_local/migrate/persona.txt'),
  ledgerPath:live?resolve(root,env.BRAIN_LEDGER):null,budgetDirectory:resolve(root,env.JY_BUDGET_DIR??'_local/brain'),
  heartbeatMs:integer(env,'BRAIN_HEARTBEAT_MS',live?60000:0,0,3600000),idleIntervalMs:integer(env,'JY_IDLE_INTERVAL_MS',7200000,0,86400000),
  openLife:flag(env,'JY_OPEN_LIFE'),autonomy:flag(env,'JY_AUTONOMY'),affect:{enabled:affect.enabled,fusion},cognition,rhythm,global:flag(env,'BRAIN_GLOBAL'),rhythmReset:flag(env,'JY_RHYTHM_RESET'),
  maintenance:live&&flag(env,'BRAIN_MAINTENANCE',true),
  profile:{dailyMicros:integer(env,'BRAIN_MAX_MICROS',3000000,1,20000000),dailyCalls:callLimit,maxTokens:integer(env,'BRAIN_MAX_TOKENS',3000,1,6000),reasoning,intentProtocol:flag(env,'JY_INTENT_PROTOCOL')},
  authenticationConfigured:typeof env.BRAIN_TOKEN==='string'&&env.BRAIN_TOKEN.length>0};
 // The token is passed to the server separately; it never enters fingerprints or instance records.
 const fingerprint=digest(config);return Object.freeze({...config,cognition:Object.freeze(config.cognition),affect:Object.freeze(config.affect),rhythm:Object.freeze(config.rhythm),profile:Object.freeze(config.profile),configFingerprint:fingerprint});
}

export function launchIdentity(config,{explicit=false}={}){
 if(config.live||explicit)ensure(existsSync(config.identityFile),'IDENTITY_MISSING','explicit identity source is unavailable');
 let identity='你是一个具有连续记忆的数字主体。';if(existsSync(config.identityFile)){identity=readFileSync(config.identityFile,'utf8').trim();ensure(identity.length>0,'IDENTITY_EMPTY','identity source is empty');}
 ensure([...identity].length<=4000,'IDENTITY_BUDGET','identity exceeds cognition input contract; provide an explicitly reviewed compact source');
 return {identity,configFingerprint:digest({config:config.configFingerprint,identityHash:digest(identity)})};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 assertSupportedNode();
 const rootIndex=process.argv.indexOf('--root'),config=resolveBrainConfig({root:rootIndex<0?process.cwd():process.argv[rootIndex+1]}),identity=launchIdentity(config,{explicit:process.env.BRAIN_IDENTITY_FILE!==undefined});
 console.log(JSON.stringify({mode:config.mode,storePath:config.storePath,ledgerPath:config.ledgerPath,stateDirectory:config.stateDirectory,configFingerprint:identity.configFingerprint,buildFingerprint:runtimeSourceIdentity(config.root).fingerprint}));
}
