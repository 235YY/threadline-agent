import {readFileSync,writeFileSync,copyFileSync,existsSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url)),candidate=join(root,'evaluation/affect-integrated_2026-11-11/candidate-v1');
if(existsSync(join(candidate,'AFFECT-PATCHED.json')))throw Error('candidate already patched');
const edit=(file,changes)=>{let text=readFileSync(join(candidate,file),'utf8');for(const [old,value] of changes){if(!text.includes(old))throw Error('missing anchor '+file+' '+old.slice(0,100));text=text.replace(old,value);}writeFileSync(join(candidate,file),text);};
copyFileSync(new URL('./additions/affect-contract.mjs',import.meta.url),join(candidate,'src/affect-contract.mjs'));
copyFileSync(new URL('./additions/decision-affect.zh.md',import.meta.url),join(candidate,'prompts/decision-affect.zh.md'));
edit('src/schema.mjs',[["SCHEMA_VERSION = 10","SCHEMA_VERSION = 11"]]);
const storeMethods=`  #initializeMotivation(c) {
    const subject=this.#require({id:c.subjectId,revision:this.#read(c.subjectId)?.revision},['subject']);
    const id=motivationId(subject.id),old=this.#read(id),snapshot=validateSnapshot(c.snapshot);
    if(old){ensure(old.type==='motivation_state'&&digest(old.snapshot.config)===digest(snapshot.config),'AFFECT_PROFILE','cannot reseed/change profile');return old;}
    ensure(snapshot.revision===0&&!subject.motivationState,'AFFECT_INITIALIZATION','fresh initial state required');
    const record=this.#write(id,'motivation_state',0,{subject:subject.id,snapshot,receipts:[],recordedAt:this.#now()});
    const {id:sid,type,revision,...prior}=subject;this.#write(sid,type,revision,{...prior,motivationState:asRef(record),recordedAt:this.#now()});return record;
  }
  #affectTurn(c) {
    const old=this.#read(c.id);
    if(!old){
      const v=c.value;ensure(c.expectedRevision===0&&v?.status==='prepared'&&v.packet?.payload?.continuity?.subject?.id===v.subject,'AFFECT_TURN','prepared packet required');
      ensure(this.#read(v.subject)?.type==='subject'&&c.id===affectTurnId(v.packet),'AFFECT_TURN','own packet identity');
      validateSnapshot(v.preview.snapshot);return this.#write(c.id,'affect_turn',0,{...v,recordedAt:this.#now()});
    }
    ensure(old.type==='affect_turn'&&old.revision===c.expectedRevision,'AFFECT_TURN_VERSION','turn changed');
    const allowed={prepared:['dispatched','failed'],dispatched:['captured','uncertain'],captured:['committed','failed'],committed:[],uncertain:[],failed:[]};
    ensure(allowed[old.status]?.includes(c.status),'AFFECT_TURN_STATUS','invalid capture/adoption phase');
    const {id,type,revision,...prior}=old;
    if(c.status==='captured')ensure(typeof c.rawOutput==='string'&&Buffer.byteLength(c.rawOutput)<=32768,'AFFECT_OUTPUT_LIMIT','bounded public final only');
    return this.#write(id,type,revision,{...prior,status:c.status,...(c.status==='captured'?{rawOutput:c.rawOutput}:{}),...(c.decision?{decision:c.decision}:{}),...(c.error?{error:c.error}:{}),recordedAt:this.#now()});
  }
`;
edit('src/store.mjs',[
 ["import * as sqlite from 'node:sqlite';","import * as sqlite from 'node:sqlite';\nimport {motivationId,affectTurnId,validateSnapshot,verifyTransition} from './affect-contract.mjs';"],
 ["'binding','agent_task'];","'binding','agent_task','motivation_state','affect_turn'];"],
 ['migrateV9 = false,maxDebugPacketBytes','migrateV9 = false,migrateV10 = false,maxDebugPacketBytes'],
 ['[0,1,2,3,4,5,6,7,8,9,SCHEMA_VERSION]','[0,1,2,3,4,5,6,7,8,9,10,SCHEMA_VERSION]'],
 ["      // Refuse unrelated databases;", "      ensure(version !== 10 || migrateV10 === true, 'MIGRATION_REQUIRED', 'schema 10 requires explicit upgrade of an isolated copy');\n      // Refuse unrelated databases;"],
 ["      case 'append_event':", "      case 'initialize_motivation': return this.#initializeMotivation(command);\n      case 'affect_turn': return this.#affectTurn(command);\n      case 'append_event':"],
 ['  #advanceSubject(c) {',storeMethods+'  #advanceSubject(c) {'],
 ["    const next=this.#write(subject.id,'subject',subject.revision,{foreground:",`    let motivationState=subject.motivationState??null;
    if(motivationState||context.motivation){
      ensure(motivationState&&context.motivation&&c.motivationTransition&&c.affectTurn,'AFFECT_COMMIT_REQUIRED','cannot bypass enabled affect state');
      const record=this.#require(context.motivation.ref,['motivation_state']);
      ensure(record.subject===subject.id&&canonical(asRef(this.#read(record.id)))===canonical(asRef(record))&&canonical(motivationState)===canonical(asRef(record)),'STALE_MOTIVATION','motivation changed while deciding');
      const turn=this.#require(c.affectTurn,['affect_turn']);
      ensure(turn.status==='captured'&&turn.subject===subject.id&&turn.packet.packetId===decision.input.packetId,'AFFECT_TURN','captured public output required');
      const raw=JSON.parse(turn.rawOutput);
      ensure(digest(raw.affectAppraisal??null)===digest(decision.output.affectAppraisal??null),'AFFECT_BINDING','adopted appraisal differs from captured output');
      const snapshot=verifyTransition(c.motivationTransition,{record,packet:decision.input,output:decision.output,subjectId:subject.id});
      const updated=this.#write(record.id,'motivation_state',record.revision,{subject:subject.id,snapshot,receipts:c.motivationTransition.receipts,decision:c.decision,recordedAt:at});
      motivationState=asRef(updated);
      this.#affectTurn({id:turn.id,expectedRevision:turn.revision,status:'committed',decision:c.decision});
    }else ensure(!c.motivationTransition&&!c.affectTurn,'AFFECT_DISABLED','no candidate without enabled state');
    const next=this.#write(subject.id,'subject',subject.revision,{...(motivationState?{motivationState}:{}),foreground:`]
]);
edit('src/continuity.mjs',[
 ["import {ensure,refKey,text,uniqueRefs}","import {motivationInput} from './affect-contract.mjs';\nimport {ensure,refKey,text,uniqueRefs}"],
 ['candidateScope=null})','candidateScope=null,motivationPreview=null})'],
 ['    return {subject:ref(subject),maxForeground:', '    const motivation=motivationInput({store,subjectId,currentEvent,motivationPreview,preview:motivationPreview});\n    return {...(motivation?{motivation}:{}),subject:ref(subject),maxForeground:']
]);
edit('src/cognition.mjs',[
 ["const APPERCEPTION_V1_PROMPT=", "const AFFECT_PROMPT=readFileSync(new URL('../prompts/decision-affect.zh.md',import.meta.url),'utf8');\nconst APPERCEPTION_V1_PROMPT="],
 ["import {", "import {normalizeAffectAppraisal} from './affect-contract.mjs';\nimport {"],
 ["const instruction=baseInstruction+", "const instruction=baseInstruction+(payload.continuity?.motivation?'\\n\\n'+AFFECT_PROMPT:'')+"],
 ['anchorDirectory=false,task=null})','anchorDirectory=false,task=null,motivationPreview=null})'],
 ['continuityInput({store,subjectId,stateRefs:', 'continuityInput({store,subjectId,motivationPreview,stateRefs:'],
 ['memoryUpdateDue=false,followup=null})','memoryUpdateDue=false,followup=null,motivationPreview=null})'],
 ['continuityInput({store,subjectId,currentEvent:null,','continuityInput({store,subjectId,motivationPreview,currentEvent:null,'],
 ['invocationKey=null,guardRefs=[]})','invocationKey=null,guardRefs=[],motivationTransition=null,affectTurn=null})'],
 ["  exact(out,['packetId','options'", "  if(Object.hasOwn(out,'affectAppraisal')){ensure(packet.payload.continuity?.motivation,'AFFECT_DISABLED','appraisal disabled');out.affectAppraisal=normalizeAffectAppraisal(out.affectAppraisal,packet);}\n  exact(out,['packetId','options'"],
 ["...(Object.hasOwn(out,'apperception')?['apperception']:[])],'decision');", "...(Object.hasOwn(out,'apperception')?['apperception']:[]),...(Object.hasOwn(out,'affectAppraisal')?['affectAppraisal']:[])],'decision');"],
 ["commands.push({op:'advance_subject',subject:","commands.push({op:'advance_subject',motivationTransition,affectTurn,subject:"]
]);
edit('src/continuity-session.mjs',[
 ['prepareDecision,commitDecision,verifiedModelInput','prepareDecision,prepareReflection,commitDecision,verifiedModelInput'],
 ['  prepare(args) {','  invoke(packet,fn){return fn(packet);}\n  prepareReflection(args){return prepareReflection({...args,store:this.#store,subjectId:this.#subjectId});}\n  prepare(args) {']
]);
edit('src/turn-driver.mjs',[
 ['anchorDirectory=process.env.JY_ANCHOR_DIRECTORY===\'1\'}={})','anchorDirectory=process.env.JY_ANCHOR_DIRECTORY===\'1\',sessionFactory=null}={})'],
 ['this.#session=new ContinuitySession({store,subjectId,attention:true,maxForeground});','this.#session=sessionFactory?sessionFactory({store,subjectId,attention:true,maxForeground}):new ContinuitySession({store,subjectId,attention:true,maxForeground});'],
 ['const packet=prepareReflection({store:', 'const packet=await this.#session.prepareReflection({store:'],
 ['const packet=this.#session.prepare(', 'const packet=await this.#session.prepare('],
 ['packet=this.#session.prepare(', 'packet=await this.#session.prepare('],
 ['const output=await this.#decide(packet);','const output=await this.#session.invoke(packet,this.#decide);'],
 ['const output=await this.#decide(packet);','const output=await this.#session.invoke(packet,this.#decide);'],
 ['const output=await this.#decide(packet);','const output=await this.#session.invoke(packet,this.#decide);'],
 ['decision=this.#session.commit(', 'decision=await this.#session.commit('],
 ['decision=this.#session.commit(', 'decision=await this.#session.commit('],
 ['decision=this.#session.commit(', 'decision=await this.#session.commit(']
]);
// The same driver factory covers ordinary chat, task steps and reflection.
edit('tools/brain-service/server.mjs',[
 ['hostAllowedTools=null,rhythmReset=false}={})','hostAllowedTools=null,rhythmReset=false,sessionFactory=null}={})'],
 ['new TurnDriver({','new TurnDriver({sessionFactory,'],
 ['new TurnDriver({store,','new TurnDriver({sessionFactory,store,']
]);
edit('src/debug-reader.mjs',[["import {APPLICATION_ID}","import {APPLICATION_ID,SCHEMA_VERSION}"],['this.#version<=10','this.#version<=SCHEMA_VERSION']]);
edit('test/workbench-materials.test.mjs',[['assert.equal(SCHEMA_VERSION,10)','assert.equal(SCHEMA_VERSION,11)']]);
writeFileSync(join(candidate,'AFFECT-PATCHED.json'),JSON.stringify({candidate:true,schema:11,liveSourceChanged:false,requiresExplicitV10CopyUpgrade:true},null,2));
console.log(JSON.stringify({candidate,schema:11,liveSourceChanged:false}));
