import fs from 'node:fs';import {join,relative,resolve,dirname} from 'node:path';import {createHash} from 'node:crypto';import {EvidenceRun} from '../review-tools/evidence-run.mjs';
const base='_local/acceptance/investigation-adversarial-20261113',prior='_local/acceptance/investigation-continuity-20261113/continuity-fix-5ccc49ec-830a-42e0-9bdf-f84576bb11f5';
const sha=b=>createHash('sha256').update(b).digest('hex');
const pointer=process.argv[2]??'ENTERED.json';if(!/^ENTERED(?:-v[2-9][0-9]*)?\.json$/.test(pointer))throw Error('explicit versioned pointer required');
if(fs.existsSync(join(base,pointer)))throw Error('already prepared; preserve existing run');
const candidate=JSON.parse(fs.readFileSync(join(prior,'FINAL-CANDIDATE.json'))),seal=JSON.parse(fs.readFileSync(join(prior,'MANIFEST.json')));
for(const e of candidate.files)if(sha(fs.readFileSync(e.file))!==e.sha256)throw Error('candidate drift: '+e.file);
for(const e of seal.files)if(sha(fs.readFileSync(join(prior,e.file)))!==e.sha256)throw Error('prior evidence drift: '+e.file);
const regression=fs.readFileSync(join(prior,'REGRESSION-ACCEPTED.txt'),'utf8');if(!regression.includes('pass 629')||!regression.includes('fail 0'))throw Error('629 gate absent');
const ledgerFile='_local/acceptance/rc-stability-20261113/paid/budget.json',ledger=JSON.parse(fs.readFileSync(ledgerFile));
if(ledger.halted||ledger.requests.some(r=>!['settled','released'].includes(r.status)))throw Error('accounting unresolved');
const held=ledger.requests.reduce((s,r)=>s+(r.status==='released'?0:r.actualMicros??r.reserveMicros),0),maxCalls=48,maxRequestMicros=(131072+4096)*2+6000*8;
if(held+maxCalls*maxRequestMicros>20000000)throw Error('worst-case run cannot fit existing authorization');
const run=new EvidenceRun({base,label:'continuity-live'}),copy=join(run.root,'candidate');fs.mkdirSync(copy);
const files=new Set(candidate.files.map(e=>e.file));
// Source-only snapshot. No _local, config identities, credentials, databases, QQ data or runtime files.
function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.isSymbolicLink()||['__pycache__','node_modules','.git'].includes(e.name))continue;const p=join(dir,e.name);if(e.isDirectory())visit(p);else if(/\.(mjs|py|md|json|ps1)$/.test(e.name))files.add(relative(process.cwd(),resolve(p)).replaceAll('\\','/'));}}
for(const d of ['src','prompts','tools/brain-service','tools/affect-integrated','tools/affect-shadow','tools/qq-connect','tools/ops'])visit(d);
for(const f of ['scripts/study-key.ps1','experiments/rc-stability/ledger.mjs','experiments/review-tools/evidence-run.mjs','experiments/investigation-study/prepare.mjs','experiments/investigation-study/run.mjs','experiments/investigation-study/PLAN.md'])files.add(f);
// Full native verification assets and the standalone interpreter; source-only pattern matching is insufficient.
const vendor='tools/affect-shadow/vendor';for(const f of Object.keys(JSON.parse(fs.readFileSync(join(vendor,'MANIFEST.json'))).files))files.add(join(vendor,f).replaceAll('\\','/'));
function native(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isSymbolicLink()||e.name==='__pycache__')continue;if(e.isDirectory())native(p);else files.add(p.replaceAll('\\','/'));}}
native('_local/affect-runtime/python-3.13.9');
const campaign='evaluation/focus-study_2026-11-05';for(const pointer of ['current.json','supplement-current.json']){const p=JSON.parse(fs.readFileSync(join(campaign,pointer))),id=pointer==='current.json'?'f01':'f03';files.add(join(campaign,pointer).replaceAll('\\','/'));for(const step of ['r0','r1'])files.add(join(campaign,p.hash,id,step,'call/wire.json').replaceAll('\\','/'));}
// Literal imports/assets plus the declared runtime directories. Computed plugin loading is disabled by this configuration.
for(const f of files){if(!f.endsWith('.mjs'))continue;const text=fs.readFileSync(f,'utf8');const specs=[...text.matchAll(/(?:import|export)\s+(?:[^;'"\n]*?\s+from\s*)?['"]([^'"]+)['"]/g),...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g),...text.matchAll(/new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)];for(const m of specs){if(!m[1].startsWith('.'))continue;const path=resolve(dirname(f),m[1]),rel=relative(process.cwd(),path).replaceAll('\\','/');if(rel.startsWith('../')||rel.startsWith('_local/'))continue;if(fs.existsSync(path)&&fs.statSync(path).isFile())files.add(rel);}}
const rows=[...files].sort().map(file=>{const bytes=fs.readFileSync(file),path=join(copy,file);fs.mkdirSync(join(path,'..'),{recursive:true});fs.writeFileSync(path,bytes,{flag:'wx'});return {file,sha256:sha(bytes)};});
run.write('FREEZE.json',{format:'investigation-adversarial-freeze-v1',candidate:copy,priorCandidate:prior,priorSealSha256:sha(fs.readFileSync(join(prior,'MANIFEST.json'))),source:rows,node:process.version,configuration:{investigationContinuityV1:true,memoryScopeV1:false,affect:false,apperceptionV1:true,model:'deepseek-flash',reasoning:'low',maxTokens:6000,inputBudgetBytes:131072,heartbeatMs:0},limits:{maxCalls,maxRequestMicros,worstCaseAdditionalMicros:maxCalls*maxRequestMicros,parentMaxMicros:20000000},ledger:{file:resolve(ledgerFile),sha256:sha(fs.readFileSync(ledgerFile)),calls:ledger.requests.length,heldMicros:held},credentialBoundary:{module:resolve('src/model-credential.mjs'),sha256:sha(fs.readFileSync('src/model-credential.mjs')),scriptSha256:sha(fs.readFileSync('scripts/study-key.ps1')),dedicatedDPAPIOnly:true,copied:false},production:false});
run.write('PREREGISTRATION.json',{planSha256:sha(fs.readFileSync('experiments/investigation-study/PLAN.md')),order:['ABC','D','E'],independentBatches:true,unexpectedFailureStopsCurrentBatch:true,noFailedRequestRetry:true,syntheticOnly:true,externalWrites:false,hiddenReasoningCapture:false,judgingModel:false});
fs.writeFileSync(join(base,pointer),JSON.stringify({root:run.root,runId:run.runId,copy},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({root:run.root,sourceFiles:rows.length,priorVerified:seal.files.length,existingCalls:ledger.requests.length,existingMicros:held,worstAdditionalMicros:maxCalls*maxRequestMicros}));
