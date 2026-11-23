import {readFileSync,existsSync,mkdirSync,openSync} from 'node:fs';
import {dirname} from 'node:path';
import {StudyLedger} from '../model-study/client.mjs';
import {digest,ensure,canonical} from '../../src/contracts.mjs';

export const SCALE_POLICY=Object.freeze({totalMicros:10000000,totalCalls:200,phase:'scale1',phaseMicros:2000000,phaseCalls:80});
export const REVISION_PHASE=Object.freeze({phase:'scale2-revision',phaseMicros:500000,phaseCalls:8});
export const ROBUSTNESS_PHASE=Object.freeze({phase:'scale3-robustness',phaseMicros:1500000,phaseCalls:24});
export const CONSULTATION_PHASE=Object.freeze({phase:'scale4-consultation',phaseMicros:1500000,phaseCalls:24});
export const NAVIGATION_PHASE=Object.freeze({phase:'scale5-navigation',phaseMicros:500000,phaseCalls:8});
export const PROGRESS_PHASE=Object.freeze({phase:'scale6-progress',phaseMicros:1000000,phaseCalls:16});
export const WORKBENCH_PHASE=Object.freeze({phase:'scale7-workbench',phaseMicros:1000000,phaseCalls:16});
export const FOCUS_PHASE=Object.freeze({phase:'scale8-focus',phaseMicros:1000000,phaseCalls:7});
export const liability=rows=>rows.reduce((s,r)=>s+(r.status==='settled'?r.actualMicros:r.status==='released'?0:r.reserveMicros),0);
// Reuse the tested metering operations; only the explicitly expanded policy and
// import are different. The exhausted old ledger remains immutable, not reset.
export class ScaleLedger {
  constructor(path,{sourcePath,policy=SCALE_POLICY,acknowledgeUncertain=null,revisionPhase=false,startRevisionPhase=false,robustnessPhase=false,startRobustnessPhase=false,consultationPhase=false,startConsultationPhase=false,navigationPhase=false,startNavigationPhase=false,progressPhase=false,startProgressPhase=false,workbenchPhase=false,startWorkbenchPhase=false,focusPhase=false,startFocusPhase=false}={}) {
    ensure(canonical(policy)===canonical(SCALE_POLICY),'BUDGET_POLICY','fixed approved total and first-phase limits required');
    this.path=path;this.lock=path+'.lock';this.policy=policy;mkdirSync(dirname(path),{recursive:true});
    try {this.fd=openSync(this.lock,'wx');} catch {ensure(false,'LEDGER_LOCKED','another worker or unreviewed interruption exists');}
    try {
      const raw=readFileSync(sourcePath,'utf8'), source=JSON.parse(raw), inheritedHash=digest(raw);
      ensure(source.requests.length===24 && source.requests.every(r=>['settled','held-uncertain','released'].includes(r.status)),
        'CARRY_NOT_CLOSED','import only the closed 24-attempt study, including held reserves');
      this.data=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{format:'jingyang-scale-budget-v1',limitMicros:policy.totalMicros,
        maxCalls:policy.totalCalls,policy,importedFrom:{sourcePath,inheritedHash,requests:source.requests.length,liabilityMicros:liability(source.requests)},
        requests:JSON.parse(JSON.stringify(source.requests)),halted:null,auditEvents:[{operation:'explicit-budget-expansion-with-full-carry-in',
          userOfferCny:10,firstPhaseCny:2,oldRequestsRetained:24,oldLedgerReset:false}]};
      ensure(!this.data.appendPhase,'APPEND_LEDGER_REQUIRED','an activated successor phase cannot be reopened through legacy phase code');
      ensure(this.data.maxCalls===policy.totalCalls&&this.data.limitMicros===policy.totalMicros,'BUDGET_POLICY','stored legacy ceilings must match their approved policy');
      ensure(this.data.format==='jingyang-scale-budget-v1'&&canonical(this.data.policy)===canonical(policy)&&
        this.data.importedFrom.inheritedHash===inheritedHash&&this.data.importedFrom.sourcePath===sourcePath,'CARRY_CHANGED','policy or closed source changed');
      ensure(canonical(this.data.requests.slice(0,24))===canonical(source.requests),'CARRY_CHANGED','imported costs and holds cannot be edited away');
      ensure(typeof revisionPhase==='boolean'&&typeof startRevisionPhase==='boolean'&&(!startRevisionPhase||revisionPhase),'BUDGET_PHASE','explicit revision phase selection');
      const firstPhase=this.data.requests.filter(r=>r.id.startsWith('scale1:'));
      if(startRevisionPhase&&!this.data.revisionPhase){
        ensure(firstPhase.length===80&&firstPhase.every(r=>['settled','held-uncertain','released'].includes(r.status))
          &&!this.data.halted,'UNCERTAIN_SPEND','close and retain the first phase before explicit next-phase authorization');
        this.data.revisionPhase={...REVISION_PHASE,sealedFirstPhaseHash:digest(firstPhase),sealedFirstPhaseCalls:80};
        this.data.auditEvents.push({operation:'user-requested-revision-continuity-test-2026-11-04',at:new Date().toISOString(),
          maxNewCalls:8,maxNewMicros:500000,totalBudgetUnchanged:true,firstPhaseRetained:true});
      }
      if(this.data.revisionPhase){const extension=this.data.revisionPhase;
        ensure(extension.phase===REVISION_PHASE.phase&&extension.phaseCalls===8&&extension.phaseMicros===500000
          &&extension.sealedFirstPhaseCalls===80&&extension.sealedFirstPhaseHash===digest(firstPhase),
          'CARRY_CHANGED','sealed first-phase requests and revision-phase limits cannot change');}
      ensure(!revisionPhase||this.data.revisionPhase,'BUDGET_PHASE','next phase requires an explicit audited authorization');
      ensure(typeof robustnessPhase==='boolean'&&typeof startRobustnessPhase==='boolean'&&(!startRobustnessPhase||robustnessPhase)&&!(revisionPhase&&robustnessPhase),
        'BUDGET_PHASE','choose one explicit active phase');
      const revisionRows=this.data.requests.filter(r=>r.id.startsWith('scale2-revision:'));
      if(startRobustnessPhase&&!this.data.robustnessPhase){
        ensure(this.data.revisionPhase&&revisionRows.length===8&&revisionRows.every(r=>['settled','held-uncertain','released'].includes(r.status))&&!this.data.halted,
          'UNCERTAIN_SPEND','retain and close revision phase before new authorization');
        this.data.robustnessPhase={...ROBUSTNESS_PHASE,sealedRevisionHash:digest(revisionRows)};
        this.data.auditEvents.push({operation:'user-requested-retrieval-ablation-continuity-study-2026-11-04',at:new Date().toISOString(),
          maxNewCalls:24,maxNewMicros:1500000,totalBudgetUnchanged:true,oldRequestsRetained:true});
      }
      if(this.data.robustnessPhase){const extension=this.data.robustnessPhase;
        ensure(extension.phase===ROBUSTNESS_PHASE.phase&&extension.phaseCalls===24&&extension.phaseMicros===1500000
          &&extension.sealedRevisionHash===digest(revisionRows),'CARRY_CHANGED','sealed revision phase and robustness limits cannot change');}
      ensure(!robustnessPhase||this.data.robustnessPhase,'BUDGET_PHASE','robustness phase requires explicit audited authorization');
      ensure(typeof consultationPhase==='boolean'&&typeof startConsultationPhase==='boolean'&&(!startConsultationPhase||consultationPhase)
        &&[revisionPhase,robustnessPhase,consultationPhase].filter(Boolean).length<=1,'BUDGET_PHASE','choose one active phase');
      const robustnessRows=this.data.requests.filter(r=>r.id.startsWith('scale3-robustness:'));
      if(startConsultationPhase&&!this.data.consultationPhase){
        ensure(this.data.robustnessPhase&&robustnessRows.length===23&&robustnessRows.every(r=>['settled','held-uncertain','released'].includes(r.status))&&!this.data.halted,
          'UNCERTAIN_SPEND','retain the completed 23-call robustness campaign before starting this explicitly authorized study');
        this.data.consultationPhase={...CONSULTATION_PHASE,sealedRobustnessHash:digest(robustnessRows),sealedRobustnessCalls:23};
        this.data.auditEvents.push({operation:'user-requested-consultation-validation-2026-11-04',at:new Date().toISOString(),
          maxNewCalls:24,maxNewMicros:1500000,totalBudgetUnchanged:true,unusedOldPhaseCallNotReused:true,oldRequestsRetained:true});
      }
      if(this.data.consultationPhase){const extension=this.data.consultationPhase;
        ensure(extension.phase===CONSULTATION_PHASE.phase&&extension.phaseCalls===24&&extension.phaseMicros===1500000&&extension.sealedRobustnessCalls===23
          &&extension.sealedRobustnessHash===digest(robustnessRows),'CARRY_CHANGED','retain sealed robustness requests and fixed consultation limits');
        ensure(consultationPhase||navigationPhase||progressPhase||workbenchPhase||focusPhase,'BUDGET_PHASE','earlier phases are sealed after consultation activation');}
      ensure(!consultationPhase||this.data.consultationPhase,'BUDGET_PHASE','consultation study requires explicit audited activation');
      ensure(typeof navigationPhase==='boolean'&&typeof startNavigationPhase==='boolean'&&(!startNavigationPhase||navigationPhase)
        &&[revisionPhase,robustnessPhase,consultationPhase,navigationPhase].filter(Boolean).length<=1,'BUDGET_PHASE','choose one active phase');
      const consultationRows=this.data.requests.filter(r=>r.id.startsWith('scale4-consultation:'));
      if(startNavigationPhase&&!this.data.navigationPhase){
        ensure(this.data.consultationPhase&&consultationRows.length===22&&consultationRows.every(r=>['settled','held-uncertain','released'].includes(r.status))&&!this.data.halted,
          'UNCERTAIN_SPEND','retain completed consultation campaign before navigation study');
        this.data.navigationPhase={...NAVIGATION_PHASE,sealedConsultationHash:digest(consultationRows),sealedConsultationCalls:22};
        this.data.auditEvents.push({operation:'user-requested-navigation-repair-test-2026-11-04',at:new Date().toISOString(),
          maxNewCalls:8,maxNewMicros:500000,totalBudgetUnchanged:true,oldRequestsRetained:true});
      }
      if(this.data.navigationPhase){const n=this.data.navigationPhase;
        ensure(n.phase===NAVIGATION_PHASE.phase&&n.phaseCalls===8&&n.phaseMicros===500000&&n.sealedConsultationCalls===22
          &&n.sealedConsultationHash===digest(consultationRows),'CARRY_CHANGED','sealed consultation requests and navigation limits cannot change');
        ensure(navigationPhase||progressPhase||workbenchPhase||focusPhase,'BUDGET_PHASE','earlier phases are sealed after navigation activation');}
      ensure(!navigationPhase||this.data.navigationPhase,'BUDGET_PHASE','navigation phase requires explicit audited activation');
      ensure(typeof progressPhase==='boolean'&&typeof startProgressPhase==='boolean'&&(!startProgressPhase||progressPhase)
        &&[revisionPhase,robustnessPhase,consultationPhase,navigationPhase,progressPhase].filter(Boolean).length<=1,'BUDGET_PHASE','choose one active phase');
      const navigationRows=this.data.requests.filter(r=>r.id.startsWith('scale5-navigation:'));
      if(startProgressPhase&&!this.data.progressPhase){
        ensure(this.data.navigationPhase&&navigationRows.length===8&&navigationRows.every(r=>['settled','held-uncertain','released'].includes(r.status))&&!this.data.halted,
          'UNCERTAIN_SPEND','close and retain navigation study before new progress experiment');
        this.data.progressPhase={...PROGRESS_PHASE,sealedNavigationHash:digest(navigationRows)};
        this.data.auditEvents.push({operation:'user-requested-progress-continuation-test-2026-11-04',at:new Date().toISOString(),maxNewCalls:16,maxNewMicros:1000000,totalBudgetUnchanged:true,oldRequestsRetained:true});
      }
      if(this.data.progressPhase){const p=this.data.progressPhase;
        ensure(p.phase===PROGRESS_PHASE.phase&&p.phaseCalls===16&&p.phaseMicros===1000000&&p.sealedNavigationHash===digest(navigationRows),'CARRY_CHANGED','sealed navigation requests and progress limits cannot change');
        ensure(progressPhase||workbenchPhase||focusPhase,'BUDGET_PHASE','earlier phases are sealed after progress activation');}
      ensure(!progressPhase||this.data.progressPhase,'BUDGET_PHASE','progress study requires explicit activation');
      ensure(typeof workbenchPhase==='boolean'&&typeof startWorkbenchPhase==='boolean'&&(!startWorkbenchPhase||workbenchPhase)
        &&[revisionPhase,robustnessPhase,consultationPhase,navigationPhase,progressPhase,workbenchPhase].filter(Boolean).length<=1,'BUDGET_PHASE','choose one active phase');
      const progressRows=this.data.requests.filter(r=>r.id.startsWith('scale6-progress:'));
      if(startWorkbenchPhase&&!this.data.workbenchPhase){
        ensure(this.data.progressPhase&&progressRows.length===15&&progressRows.every(r=>['settled','held-uncertain','released'].includes(r.status))&&!this.data.halted,
          'UNCERTAIN_SPEND','retain all fifteen closed progress requests before workbench testing');
        this.data.workbenchPhase={...WORKBENCH_PHASE,sealedProgressHash:digest(progressRows),sealedProgressCalls:15};
        this.data.auditEvents.push({operation:'user-requested-workbench-exit-test-2026-11-04',at:new Date().toISOString(),
          maxNewCalls:16,maxNewMicros:1000000,totalBudgetUnchanged:true,oldRequestsRetained:true,unusedProgressCallNotReused:true});
      }
      if(this.data.workbenchPhase){const w=this.data.workbenchPhase;
        ensure(w.phase===WORKBENCH_PHASE.phase&&w.phaseCalls===16&&w.phaseMicros===1000000&&w.sealedProgressCalls===15
          &&w.sealedProgressHash===digest(progressRows),'CARRY_CHANGED','sealed progress requests and workbench limits cannot change');
        ensure(workbenchPhase||focusPhase,'BUDGET_PHASE','earlier phases are sealed after workbench activation');}
      ensure(!workbenchPhase||this.data.workbenchPhase,'BUDGET_PHASE','workbench study requires explicit activation');
      ensure(typeof focusPhase==='boolean'&&typeof startFocusPhase==='boolean'&&(!startFocusPhase||focusPhase)&&
        [revisionPhase,robustnessPhase,consultationPhase,navigationPhase,progressPhase,workbenchPhase,focusPhase].filter(Boolean).length<=1,'BUDGET_PHASE','choose one explicit active focus phase');
      const workbenchRows=this.data.requests.filter(r=>r.id.startsWith('scale7-workbench:'));
      if(startFocusPhase&&!this.data.focusPhase){
        ensure(this.data.workbenchPhase&&workbenchRows.length===13&&workbenchRows.every(r=>['settled','held-uncertain','released'].includes(r.status))&&
          this.data.requests.length===193&&!this.data.halted,'UNCERTAIN_SPEND','retain all 193 old attempts including thirteen closed workbench calls before focus study');
        this.data.focusPhase={...FOCUS_PHASE,sealedWorkbenchHash:digest(workbenchRows),sealedWorkbenchCalls:13,sealedPriorHash:digest(this.data.requests),sealedPriorCalls:193};
        this.data.auditEvents.push({operation:'user-requested-focus-interface-and-natural-switch-test-2026-11-05',at:new Date().toISOString(),
          maxNewCalls:7,maxNewMicros:1000000,totalBudgetUnchanged:true,totalCallsUnchanged:true,oldRequestsRetained:true,unusedWorkbenchCallsNotReused:true});
      }
      if(this.data.focusPhase){const f=this.data.focusPhase;
        ensure(f.phase===FOCUS_PHASE.phase&&f.phaseCalls===7&&f.phaseMicros===1000000&&f.sealedWorkbenchCalls===13&&f.sealedWorkbenchHash===digest(workbenchRows)&&
          f.sealedPriorCalls===193&&f.sealedPriorHash===digest(this.data.requests.slice(0,193)),'CARRY_CHANGED','all prior requests and focus ceilings must remain sealed');
        ensure(focusPhase,'BUDGET_PHASE','old phases remain sealed after focus activation');
      }
      ensure(!focusPhase||this.data.focusPhase,'BUDGET_PHASE','focus phase requires explicit audited activation');
      this.activePolicy=focusPhase?FOCUS_PHASE:workbenchPhase?WORKBENCH_PHASE:progressPhase?PROGRESS_PHASE:navigationPhase?NAVIGATION_PHASE:consultationPhase?CONSULTATION_PHASE:robustnessPhase?ROBUSTNESS_PHASE:revisionPhase?REVISION_PHASE:policy;
      if(acknowledgeUncertain!==null){
        const pending=this.data.requests.filter(r=>r.status==='uncertain');
        ensure(acknowledgeUncertain.reason==='user-authorized-new-cases-after-network-diagnosis'
          &&Array.isArray(acknowledgeUncertain.requestIds)&&pending.length>0
          &&canonical([...acknowledgeUncertain.requestIds].sort())===canonical(pending.map(r=>r.id).sort())
          &&pending.every(r=>r.id.startsWith(policy.phase+':')&&r.error==='ENOTFOUND'&&Number.isSafeInteger(r.reserveMicros)&&r.reserveMicros>0)
          &&this.data.halted==='request cost not confirmed; do not auto-retry'
          &&!this.data.requests.some(r=>['reserved','dispatched'].includes(r.status)),
          'UNCERTAIN_POLICY','explicit exact DNS-failure acknowledgement required; preserve every reserve and never resend');
        for(const row of pending)row.status='held-uncertain';
        this.data.auditEvents.push({operation:'user-authorized-new-cases-with-full-uncertain-reserves',at:new Date().toISOString(),
          reason:acknowledgeUncertain.reason,requestIds:pending.map(r=>r.id),reserveMicros:liability(pending),oldRequestsRetained:true,noResend:true});
        this.data.halted=null;
      }
      ensure(!this.data.halted&&!this.data.requests.some(r=>['reserved','dispatched','uncertain'].includes(r.status)),
        'UNCERTAIN_SPEND','unfinished request blocks continuation; never retry automatically');
      ensure(liability(this.data.requests)<=policy.totalMicros,'SPEND_LIMIT','total carry-in and new liabilities exceed budget');
      this.save();
    } catch(error) {this.close();throw error;}
  }
  reserve(id,fingerprint,reserveMicros) {
    const active=this.activePolicy;
    ensure(id.startsWith(active.phase+':'),'BUDGET_PHASE','request belongs to another phase');
    const rows=this.data.requests.filter(r=>r.id.startsWith(active.phase+':'));
    ensure(rows.filter(r=>r.status!=='released').length<active.phaseCalls,'CALL_LIMIT','active phase call ceiling reached');
    ensure(liability(rows)+reserveMicros<=active.phaseMicros,'SPEND_LIMIT','active phase conservative reserve ceiling reached');
    return StudyLedger.prototype.reserve.call(this,id,fingerprint,reserveMicros);
  }
}
for(const method of ['save','dispatch','release','settle','uncertain','find','close'])
  Object.defineProperty(ScaleLedger.prototype,method,{value:StudyLedger.prototype[method]});
