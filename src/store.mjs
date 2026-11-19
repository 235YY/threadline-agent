import * as sqlite from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {APPLICATION_ID, SCHEMA, SCHEMA_VERSION} from './schema.mjs';
import {canonical, digest, ensure, oneOf, refKey, revision, text, time, uniqueRefs} from './contracts.mjs';
import {normalizeStateDelta,personalStateChange,stateIds,normalizeDomains,normalizeAbout} from './personal-state.mjs';
import {normalizeAnchor} from './anchor.mjs';
import {validateMindPatch} from './mind.mjs';
import {GRAPH_RECORD_TYPES,projectGraphRecord,nodeKey,nodeRef,walkKnowledgeGraph,traceQuery} from './knowledge-graph.mjs';
import {lookupRoundId,lookupResultId,lookupPolicy,normalizeLookupQuery,sameRef} from './local-query.mjs';
import {attentionId,emptyAttention,advanceAttention,expandEvents,materialPurposeStatus} from './attention.mjs';
import {maintenancePolicy,maintenanceScheduleId,maintenanceJobId,maintenanceSlot,verifyMaintenancePacket,maintenanceOutput} from './maintenance-protocol.mjs';
import {diagnostic,transactionContext,debugRef,failureMetadata} from './debug-contract.mjs';
import {consultationOperation,consultationState,rankConsultation,consultationCandidate} from './consultation.mjs';
import {consultationCursor,parentPage,isConsultationPage,resolveNavigation,NAVIGATION_LIMIT} from './consultation-navigation.mjs';
import {recoveryPage,exitedUse} from './workbench-recovery.mjs';
import {normalizeContent,contentView} from './node-content.mjs';
import {normalizeMessage,projectText} from './message.mjs';
import {sourceReplyRoute} from './reply-route.mjs';
import {EVENT_PROCESS_THEORY,eventProcessId,eventProcessEvents} from './task-threads.mjs';

const Database = sqlite.Database ?? sqlite.DatabaseSync;
const NOTE_KINDS = ['fact_claim', 'interpretation', 'value', 'preference', 'dream', 'tension', 'feeling', 'skill'];
const TYPES = ['event', 'note', 'workspace', 'link', 'action', 'decision', 'review', 'subject', 'personal_state', 'decision_attempt', 'response', 'lookup_round', 'lookup_result','attention_frame','maintenance_schedule','maintenance_job','entity','binding','agent_task','motivation_state','affect_turn','extension_record','intent'];
const asRef = record => ({id: record.id, revision: record.revision});
const REPLAY_REF='$version';
const DEFAULT_DEBUG_EVENTS_LIMIT=512;
const DEFAULT_DEBUG_PACKET_BYTES=8*1024*1024;
const DEFAULT_HOT_DECISION_PACKETS=64;
const MODEL_PACKET_FIELDS=Object.freeze({
  decision:['input'], review:['input'], decision_attempt:['input'], affect_turn:['packet']
});
const PACKET_REF='$packetRef', PACKET_META='$packetMeta';

// Local persistence and consistency only. This class neither calls a model nor executes actions.
export class ContinuityStore {
  #db; #clock; #readDepth = 0; #closed = false; #transactionWrites=null; #debugFailures=0; #debugFailureCode=null; #maxDebugPacketBytes; #maxDebugEvents; #hotDecisionPackets; #maxModelPacketBytes; #packetWrites=0;
  constructor(path = ':memory:', {clock = Date.now, migrateV1 = false, migrateV2 = false, migrateV3 = false, migrateV4 = false, migrateV5 = false, migrateV6 = false, migrateV7 = false,migrateV8 = false,migrateV9 = false,migrateV10 = false,migrateV11 = false,maxDebugPacketBytes=DEFAULT_DEBUG_PACKET_BYTES,maxDebugEvents=DEFAULT_DEBUG_EVENTS_LIMIT,hotDecisionPackets=DEFAULT_HOT_DECISION_PACKETS,maxModelPacketBytes=DEFAULT_DEBUG_PACKET_BYTES} = {}) {
    this.#clock = clock;
    ensure(Number.isSafeInteger(maxDebugPacketBytes)&&maxDebugPacketBytes>=0&&maxDebugPacketBytes<=1024*1024*1024,'DEBUG_LIMIT','bounded debug snapshot quota required');
    ensure(Number.isSafeInteger(maxDebugEvents)&&maxDebugEvents>=0&&maxDebugEvents<=1000000,'DEBUG_LIMIT','bounded debug event retention required');
    ensure(Number.isSafeInteger(hotDecisionPackets)&&hotDecisionPackets>=0&&hotDecisionPackets<=100000,'MODEL_PACKET_LIMIT','bounded hot packet window required');
    ensure(Number.isSafeInteger(maxModelPacketBytes)&&maxModelPacketBytes>=1024&&maxModelPacketBytes<=1024*1024*1024,'MODEL_PACKET_LIMIT','bounded model packet size required');
    this.#maxDebugPacketBytes=maxDebugPacketBytes;
    this.#maxDebugEvents=maxDebugEvents;
    this.#hotDecisionPackets=hotDecisionPackets;
    this.#maxModelPacketBytes=maxModelPacketBytes;
    this.#db = new Database(path, {timeout: 3000});
    try {
      this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      const applicationId = this.#db.prepare('PRAGMA application_id').get().application_id;
      ensure([0,1,2,3,4,5,6,7,8,9,10,11,SCHEMA_VERSION].includes(version), 'SCHEMA_VERSION', 'unsupported database schema');
      ensure(version !== 11 || migrateV11 === true, 'MIGRATION_REQUIRED', 'schema 11 requires explicit migrateV11=true on a reviewed copy; schema 12 packet references cannot be interpreted by an old reader');
      ensure(version === 0 ? applicationId === 0 : applicationId === APPLICATION_ID,
        'FOREIGN_DATABASE', 'database does not belong to the new core');
      ensure(version !== 1 || migrateV1 === true, 'MIGRATION_REQUIRED', 'schema 1 requires explicit migrateV1=true; no live database is selected automatically');
      ensure(version !== 2 || migrateV2 === true, 'MIGRATION_REQUIRED', 'schema 2 requires explicit migrateV2=true; old files are not upgraded automatically');
      ensure(version !== 3 || migrateV3 === true, 'MIGRATION_REQUIRED', 'schema 3 requires explicit migrateV3=true on a reviewed copy; old study/live files are not upgraded automatically');
      ensure(version !== 4 || migrateV4 === true, 'MIGRATION_REQUIRED', 'schema 4 requires explicit migrateV4=true on a reviewed copy; foreground maintenance fencing is not optional');
      ensure(version !== 5 || migrateV5 === true, 'MIGRATION_REQUIRED', 'schema 5 requires explicit migrateV5=true on a reviewed copy; mind contracts are not optional');
      ensure(version !== 6 || migrateV6 === true, 'MIGRATION_REQUIRED', 'schema 6 requires explicit migrateV6=true on a reviewed copy; derived indexes are rebuilt from original versions');
      ensure(version !== 7 || migrateV7 === true, 'MIGRATION_REQUIRED', 'schema 7 requires explicit migrateV7=true on a reviewed copy; diagnostic storage is not added to online or study files automatically');
      ensure(version !== 8 || migrateV8 === true, 'MIGRATION_REQUIRED', 'schema 8 requires explicit migrateV8=true on a reviewed copy; material residence contracts are not enabled on old archives automatically');
      ensure(version !== 9 || migrateV9 === true, 'MIGRATION_REQUIRED', 'schema 9 requires explicit migrateV9=true on a reviewed copy; focus contracts cannot be bypassed by older writers');
      ensure(version !== 10 || migrateV10 === true, 'MIGRATION_REQUIRED', 'schema 10 requires explicit upgrade of an isolated copy');
      // Refuse unrelated databases; no migration of an existing application's tables.
      if (version === 0) {
        const tables = this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        ensure(tables.length === 0, 'FOREIGN_DATABASE', 'refusing to initialize an unrelated database');
      }
      this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        this.#db.exec(SCHEMA);
        if(version!==SCHEMA_VERSION)this.#rebuildGraph();
        this.#db.exec('COMMIT');
      } catch(error) {this.#db.exec('ROLLBACK');throw error;}
    } catch (error) { this.#db.close(); throw error; }
  }
  close() { if(!this.#closed){this.#db.close();this.#closed=true;} }
  debugHealth(){
    const packets=this.#db.prepare('SELECT count(*) AS n,coalesce(sum(body_bytes),0) AS bytes,coalesce(sum(compressed_bytes),0) AS compressed FROM model_packets').get();
    return {failedWrites:this.#debugFailures,lastErrorCode:this.#debugFailureCode,maxPacketBytes:this.#maxDebugPacketBytes,
      maxEvents:this.#maxDebugEvents,hotDecisionPackets:this.#hotDecisionPackets,
      modelPackets:packets.n,modelPacketBytes:packets.bytes,modelPacketCompressedBytes:packets.compressed};
  }
  #logDebug(value){
    const entry=diagnostic(value),c=entry.context;
    const result=this.#db.prepare('INSERT INTO debug_events(at,stage,status,subject_id,decision_id,packet_id,job_id,entry) VALUES(?,?,?,?,?,?,?,?)')
      .run(this.#now(),entry.stage,entry.status,c.subjectId,c.decisionId,c.packetId,c.jobId,canonical(entry));
    // This journal is diagnostic metadata, not crash recovery or subject memory.
    if(Number(result.lastInsertRowid)%128===0||this.#maxDebugEvents===0)
      this.#db.prepare('DELETE FROM debug_events WHERE seq<=?').run(Number(result.lastInsertRowid)-this.#maxDebugEvents);
  }
  #debugTransactionContext(args,results=[]){
    const context=transactionContext(args),records=[...results];
    for(const c of Array.isArray(args?.commands)?args.commands:[]){
      for(const id of [c?.response?.id,c?.job?.id,c?.actionId])if(typeof id==='string'){const value=this.#read(id);if(value)records.push(value);}
    }
    for(const r of records){
      if(r?.subject&&typeof r.subject==='string')context.subjectId??=r.subject;
      if(r?.type==='response')context.decisionId??=r.decision.id;
      if(r?.type==='maintenance_job'){context.jobId??=r.id;context.packetId??=r.packet.packetId;}
      if(r?.type==='action'&&!context.decisionId){
        const row=this.#db.prepare(`SELECT o.id FROM objects o JOIN versions v ON o.id=v.id AND o.current_revision=v.revision
          WHERE o.type='decision' AND json_extract(v.body,'$.action.id')=? LIMIT 1`).get(r.id);if(row)context.decisionId=row.id;
      }
    }
    if(context.decisionId){const d=this.#read(context.decisionId);if(d?.type==='decision'){
      context.packetId??=d.input.packetId;context.subjectId??=d.input.payload.continuity?.subject.id??null;
      context.eventId??=d.currentEvent?.id??null;context.workspaceId??=d.workspace.id;
    }}
    return context;
  }
  recordDiagnostic(value){
    try{ensure(this.#readDepth===0,'DEBUG_READ_VIEW','diagnostic writes must be outside read snapshots');this.#logDebug(value);return {logged:true};}
    catch(error){this.#debugFailures++;this.#debugFailureCode=failureMetadata(error).errorCode;return {logged:false,errorCode:this.#debugFailureCode};}
  }
  captureDebugPacket(packet){
    try{
      ensure(this.#readDepth===0,'DEBUG_READ_VIEW','snapshot writes must be outside read snapshots');
      ensure(packet&&/^[a-f0-9]{64}$/.test(packet.packetId),'DEBUG_SHAPE','prepared packet required');
      const body=canonical(packet),bytes=Buffer.byteLength(body),fingerprint=digest(body);
      if(bytes>524288)return 'snapshot-too-large';
      const old=this.#db.prepare('SELECT fingerprint FROM debug_packets WHERE packet_id=?').get(packet.packetId);
      if(old){ensure(old.fingerprint===fingerprint,'DEBUG_PACKET_COLLISION','prepared packet content changed');return 'already-captured';}
      this.#db.prepare(`INSERT OR IGNORE INTO debug_packets(packet_id,fingerprint,at,body_bytes,body)
        SELECT ?,?,?,?,? WHERE ?+(SELECT coalesce(sum(body_bytes),0) FROM debug_packets)<=?`)
        .run(packet.packetId,fingerprint,this.#now(),bytes,body,bytes,this.#maxDebugPacketBytes);
      const saved=this.#db.prepare('SELECT fingerprint FROM debug_packets WHERE packet_id=?').get(packet.packetId);
      if(!saved)return 'quota-exceeded';ensure(saved.fingerprint===fingerprint,'DEBUG_PACKET_COLLISION','prepared packet content changed');return 'captured';
    }catch(error){this.#debugFailures++;this.#debugFailureCode=failureMetadata(error).errorCode;return 'capture-failed';}
  }
  view(reader) {
    const outer = this.#readDepth === 0;
    if (outer) this.#db.exec('BEGIN');
    this.#readDepth++;
    try {
      const result = reader(this);
      ensure(!result || typeof result.then !== 'function', 'ASYNC_VIEW', 'read view must be synchronous');
      if (outer) this.#db.exec('COMMIT'); return result;
    } catch (error) { if (outer) this.#db.exec('ROLLBACK'); throw error; }
    finally { this.#readDepth--; }
  }
  integrity() {
    return this.view(() => ({
      database: Object.values(this.#db.prepare('PRAGMA integrity_check').get())[0],
      foreignKeyViolations: this.#db.prepare('PRAGMA foreign_key_check').all().length,
      missingHeads: this.#db.prepare('SELECT count(*) AS n FROM objects o LEFT JOIN versions v ON v.id=o.id AND v.revision=o.current_revision WHERE v.id IS NULL').get().n
    }));
  }
  #now() { return time(this.#clock(), 'clock'); }
  clockNow() { return this.#now(); }
  notifyForeground({subjectId,packetId,subject,attention}) {
    if(!this.#read(maintenanceScheduleId(subjectId)))return null;
    return this.execute({requestId:`foreground-fence:${subjectId}:${packetId}:${randomUUID()}`,commands:[{op:'foreground_fence',subjectId,subject,attention}]}).at(-1);
  }
  readBounded(id,rev,maxBytes=16384) {
    text(id,'id');if(rev!==undefined)revision(rev);
    ensure(Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=65536,'MAINTENANCE_LIMIT','bounded record budget required');
    const row=this.#db.prepare(`SELECT CASE WHEN length(CAST(v.body AS BLOB))<=? THEN v.body ELSE
      json_object('id',o.id,'type',o.type,'revision',v.revision,'omitted','record-byte-budget','byteSize',length(CAST(v.body AS BLOB))) END AS body
      FROM objects o JOIN versions v ON o.id=v.id WHERE o.id=? AND v.revision=${rev===undefined?'o.current_revision':'?'}`).get(...(rev===undefined?[maxBytes,id]:[maxBytes,id,rev]));
    return row?JSON.parse(row.body):null;
  }
  maintenancePage({subjectId,after=null,limit=32,maxRecordBytes=16384}) {
    ensure(this.#read(subjectId)?.type==='subject','MISSING_SUBJECT','unknown maintenance subject');
    ensure((after===null||typeof after==='string')&&Number.isSafeInteger(limit)&&limit>0&&limit<=64&&Number.isSafeInteger(maxRecordBytes)&&maxRecordBytes>0&&maxRecordBytes<=65536,'MAINTENANCE_LIMIT','bounded maintenance page required');
    return this.view(()=>{
      const query=cursor=>this.#db.prepare(`SELECT CASE WHEN length(CAST(v.body AS BLOB))<=? THEN v.body ELSE
        json_object('id',o.id,'type',o.type,'revision',v.revision,'omitted','record-byte-budget','byteSize',length(CAST(v.body AS BLOB))) END AS body
        FROM objects o JOIN versions v ON o.id=v.id AND o.current_revision=v.revision
        WHERE o.id>? AND ((o.type='note' AND json_extract(v.body,'$.status') IN ('current','suspended'))
          OR (o.type='personal_state' AND json_extract(v.body,'$.subject')=? AND json_extract(v.body,'$.status')!='closed')) ORDER BY o.id LIMIT ?`).all(maxRecordBytes,cursor,subjectId,limit).map(r=>JSON.parse(r.body));
      const rows=query(after??'');return rows.length||after===null?rows:query('');
    });
  }
  maintenanceExperiences({subjectId,afterSeq=0,limit=32}) {
    ensure(this.#read(subjectId)?.type==='subject'&&Number.isSafeInteger(afterSeq)&&afterSeq>=0&&Number.isSafeInteger(limit)&&limit>0&&limit<=64,'MAINTENANCE_LIMIT','bounded encounter page required');
    return this.view(()=>{
      const query=after=>this.#db.prepare(`SELECT i.seq,i.event_id AS eventId,i.status FROM subject_inbox i
        LEFT JOIN maintenance_seen m ON m.subject_id=i.subject_id AND m.event_id=i.event_id
        WHERE i.subject_id=? AND i.seq>? AND m.event_id IS NULL ORDER BY i.seq LIMIT ?`).all(subjectId,after,limit);
      const items=query(afterSeq);return {items:items.length||afterSeq===0?items:query(0)};
    });
  }
  // Repeated recovery fields point to their first full version on this same
  // record. Fixed reads and replay still return complete values.
  #decode(body){
    let row=JSON.parse(body);
    if(row.$recoveryFrom){
      const holder=row.type==='extension_record'?row.value:row;
      for(const [field,rev] of Object.entries(row.$recoveryFrom)){
        const source=this.#db.prepare('SELECT body FROM versions WHERE id=? AND revision=?').get(row.id,rev);
        const record=source?this.#decode(source.body):null,origin=row.type==='extension_record'?record?.value:record;
        ensure(origin&&Object.hasOwn(origin,field),'MISSING_REFERENCE','fixed recovery field is unavailable');
        holder[field]=origin[field];
      }
      delete row.$recoveryFrom;
    }
    return this.#hydratePackets(row);
  }
  #packetMeta(packet,{bytes,fingerprint}={}) {
    const payload=packet.payload??{},continuity=payload.continuity??{};
    const current=payload.current??null,workspace=payload.workspace??null;
    const compact=value=>{
      if(value==null)return null;
      const encoded=canonical(value);
      if(Buffer.byteLength(encoded)<=4096)return value;
      return {id:value.id??null,type:value.type??null,revision:value.revision??null,scene:value.scene??null,
        ref:value.ref??null,summary:value.summary??null,compact:true,bytes:Buffer.byteLength(encoded)};
    };
    return {packetId:packet.packetId,stage:packet.stage??null,bytes:bytes??Buffer.byteLength(canonical(packet)),
      fingerprint:fingerprint??digest(canonical(packet)),instructionHash:packet.instruction?digest(packet.instruction):null,
      messageHash:Array.isArray(packet.messages)?digest(canonical(packet.messages)):null,
      current:compact(current),workspace:compact(workspace),subject:continuity.subject??null,
      algorithmV011:payload.algorithmV011??null,format:payload.format??null};
  }
  #putModelPacket(packet){
    const body=canonical(packet),bytes=Buffer.byteLength(body),fingerprint=digest(body);
    if(bytes>this.#maxModelPacketBytes)return null;
    const old=this.#db.prepare('SELECT fingerprint FROM model_packets WHERE packet_id=?').get(packet.packetId);
    if(old){ensure(old.fingerprint===fingerprint,'MODEL_PACKET_COLLISION','model packet content changed');return this.#packetMeta(packet,{bytes,fingerprint});}
    const compressed=gzipSync(Buffer.from(body,'utf8'),{level:6});
    this.#db.prepare('INSERT INTO model_packets(packet_id,fingerprint,at,body_bytes,compressed_bytes,body) VALUES(?,?,?,?,?,?)')
      .run(packet.packetId,fingerprint,this.#now(),bytes,compressed.byteLength,compressed);
    return this.#packetMeta(packet,{bytes,fingerprint});
  }
  #readModelPacket(packetId){
    const row=this.#db.prepare('SELECT body FROM model_packets WHERE packet_id=?').get(packetId);
    if(!row)return null;
    return JSON.parse(gunzipSync(Buffer.from(row.body)).toString('utf8'));
  }
  #packetMissing(ref){
    const meta=ref?.[PACKET_META]??{};
    return {...meta,packetId:meta.packetId??ref?.[PACKET_REF]??null,packetUnavailable:true,
      payload:{current:meta.current??null,workspace:meta.workspace??null,
        continuity:meta.subject?{subject:meta.subject}:{}}};
  }
  #hydratePackets(row){
    const holder=row.type==='extension_record'?row.value:row;
    for(const field of MODEL_PACKET_FIELDS[row.type]??[]){
      const value=holder?.[field];
      if(!value||typeof value!=='object'||!value[PACKET_REF])continue;
      const packet=this.#readModelPacket(value[PACKET_REF]);
      holder[field]=packet??this.#packetMissing(value);
    }
    return row;
  }
  #packetize(record){
    if(!MODEL_PACKET_FIELDS[record.type])return record;
    const next=record.type==='extension_record'?{...record,value:{...record.value}}:{...record};
    const holder=record.type==='extension_record'?next.value:next;
    for(const field of MODEL_PACKET_FIELDS[record.type]){
      const packet=holder[field];
      if(!packet||typeof packet!=='object'||!/^[a-f0-9]{64}$/.test(packet.packetId??''))continue;
      const meta=this.#putModelPacket(packet);
      if(meta)holder[field]={[PACKET_REF]:packet.packetId,[PACKET_META]:meta};
    }
    if(record.type==='affect_turn'&&holder.preview&&!['prepared','dispatched','captured'].includes(holder.status)){
      const preview=holder.preview;
      holder.preview={baseRef:preview.baseRef??null,baseHash:preview.baseHash??null,
        previewHash:preview.previewHash??(preview.snapshot?digest(canonical(preview.snapshot)):null),
        snapshotHash:preview.snapshotHash??(preview.snapshot?digest(canonical(preview.snapshot)):null),
        compact:true};
    }
    return next;
  }
  #pruneModelPackets(){
    const total=this.#db.prepare('SELECT count(*) AS n FROM model_packets').get().n;
    if(total<=this.#hotDecisionPackets)return;
    const keep=new Set();
    const rows=this.#db.prepare(`SELECT o.type AS type,v.body AS body FROM objects o JOIN versions v ON o.id=v.id AND o.current_revision=v.revision
      WHERE o.type IN ('decision','review','decision_attempt','affect_turn') AND v.body LIKE '%"$packetRef"%'`).all();
    const recent=new Set(this.#db.prepare(`SELECT json_extract(v.body,'$.input."$packetRef"') AS packetId FROM objects o JOIN versions v ON o.id=v.id AND o.current_revision=v.revision
      WHERE o.type='decision' ORDER BY o.rowid DESC LIMIT ?`).all(this.#hotDecisionPackets).map(r=>r.packetId).filter(Boolean));
    for(const row of rows){
      const record=JSON.parse(row.body),holder=record.type==='extension_record'?record.value:record;
      const packetIds=[];
      for(const field of MODEL_PACKET_FIELDS[record.type]??[])if(holder[field]?.[PACKET_REF])packetIds.push(holder[field][PACKET_REF]);
      if(!packetIds.length)continue;
      let protect=packetIds.some(id=>recent.has(id));
      if(!protect&&record.type==='decision_attempt'&&['captured','quarantined','deferred'].includes(record.status))protect=true;
      if(!protect&&record.type==='affect_turn'&&['prepared','dispatched','captured','failed','uncertain'].includes(record.status))protect=true;
      if(!protect&&record.type==='review'&&recent.size===0)protect=true;
      if(protect)for(const id of packetIds)keep.add(id);
    }
    const ids=JSON.stringify([...keep]);
    this.#db.prepare('DELETE FROM model_packets WHERE packet_id NOT IN (SELECT value FROM json_each(?))').run(ids);
  }
  #pruneVersions(){
    // Execution records can retire the intermediate snapshots that are no
    // longer referenced by any current record. Memory records are never
    // selected here; they keep their append-only history.
    const current=new Map(),keep=new Set();
    const heads=this.#db.prepare(`SELECT o.id AS id,o.type AS type,o.current_revision AS revision,v.body AS body
      FROM objects o JOIN versions v ON o.id=v.id AND v.revision=o.current_revision
      WHERE o.type IN ('decision_attempt','affect_turn')`).all();
    for(const row of heads)current.set(row.id,{type:row.type,revision:row.revision,status:JSON.parse(row.body).status});
    const refs=this.#db.prepare(`SELECT o.id AS id,v.body AS body FROM objects o JOIN versions v ON o.id=v.id AND v.revision=o.current_revision
      WHERE v.body LIKE '%"$recoveryFrom"%'`).all();
    for(const row of refs){
      const body=JSON.parse(row.body);
      for(const revision of Object.values(body.$recoveryFrom??{}))keep.add(`${row.id}@${revision}`);
    }
    for(const [id,head] of current){
      const versions=this.#db.prepare('SELECT revision,body FROM versions WHERE id=? ORDER BY revision').all(id);
      for(const row of versions){
        if(row.revision===head.revision||keep.has(`${id}@${row.revision}`))continue;
        const old=JSON.parse(row.body);
        const safe=head.type==='decision_attempt'
          ? head.status==='adopted'&&old.status==='captured'
          : ['committed','superseded'].includes(head.status)&&['prepared','dispatched','captured'].includes(old.status);
        if(safe)this.#db.prepare('DELETE FROM versions WHERE id=? AND revision=?').run(id,row.revision);
      }
    }
  }
  #encode(record,previous){
    if(!previous||!(record.type==='decision_attempt'||record.type==='affect_turn'||record.type==='extension_record'&&record.theory==='runtime'&&record.stateType==='turn-activity'))return record;
    const next=record.type==='extension_record'?{...record,value:{...record.value}}:{...record};
    const [before,after]=record.type==='extension_record'?[previous.value,next.value]:[previous,next];
    const stored=JSON.parse(this.#db.prepare('SELECT body FROM versions WHERE id=? AND revision=?').get(previous.id,previous.revision).body);
    const refs={},fields={affect_turn:['rawOutput'],decision_attempt:[],extension_record:['packet','context','output']};
    for(const field of fields[record.type]){
      if(after[field]!=null&&before?.[field]!=null&&canonical(after[field])===canonical(before[field])){
        refs[field]=stored.$recoveryFrom?.[field]??previous.revision;
        delete after[field];
      }
    }
    return Object.keys(refs).length?{...next,$recoveryFrom:refs}:record;
  }
  #read(id, rev) {
    const row = rev === undefined
      ? this.#db.prepare('SELECT v.body FROM objects o JOIN versions v ON v.id=o.id AND v.revision=o.current_revision WHERE o.id=?').get(id)
      : this.#db.prepare('SELECT body FROM versions WHERE id=? AND revision=?').get(id, rev);
    return row ? this.#decode(row.body) : null;
  }
  read(id, rev) { text(id, 'id'); if (rev !== undefined) revision(rev); return this.#read(id, rev); }
  #require(ref, types = TYPES) {
    const [normalized] = uniqueRefs([ref]);
    const record = this.#read(normalized.id, normalized.revision);
    ensure(record, 'MISSING_REFERENCE', 'reference does not exist', normalized);
    ensure(types.includes(record.type), 'REFERENCE_TYPE', 'reference has the wrong type', normalized);
    return record;
  }
  #refs(refs, types) { return uniqueRefs(refs).map(ref => asRef(this.#require(ref, types))); }
  #write(id, type, expected, fields) {
    text(id, 'id'); revision(expected);
    const old = this.#read(id);
    ensure(!old || old.type === type, 'ID_COLLISION', 'id belongs to a different record type');
    ensure((old?.revision ?? 0) === expected, 'VERSION_CONFLICT', 'record changed since the snapshot', {id, expected, actual: old?.revision ?? 0});
    const next = {id, type, revision: expected + 1, ...fields};
    if (old) this.#db.prepare('UPDATE objects SET current_revision=? WHERE id=?').run(next.revision, id);
    else this.#db.prepare('INSERT INTO objects(id,type,current_revision) VALUES(?,?,?)').run(id, type, next.revision);
    this.#db.prepare('INSERT INTO versions(id,revision,body) VALUES(?,?,?)').run(id, next.revision, canonical(this.#packetize(this.#encode(next,old))));
    this.#indexGraph(next);
    this.#transactionWrites?.push(debugRef(next));
    if(++this.#packetWrites%32===0){this.#pruneModelPackets();this.#pruneVersions();}
    return next;
  }
  #indexGraph(record) {
    if(!GRAPH_RECORD_TYPES.includes(record.type))return;
    const projection=projectGraphRecord(record);
    for(const n of projection.nodes){
      const key=nodeKey(n.ref);
      this.#db.prepare('INSERT INTO graph_nodes(node_key,owner_id,owner_revision,node_type,subject_id,descriptor) VALUES(?,?,?,?,?,?)')
        .run(key,record.id,record.revision,n.type,n.subject,canonical(n));
      for(const tag of n.scope)this.#db.prepare('INSERT OR IGNORE INTO graph_tags(node_key,tag) VALUES(?,?)').run(key,tag);
    }
    for(const e of projection.edges)this.#db.prepare('INSERT INTO graph_edges(edge_key,owner_id,owner_revision,source_key,target_key,subject_id,body) VALUES(?,?,?,?,?,?,?)')
      .run(e.key,record.id,record.revision,nodeKey(e.from),nodeKey(e.to),e.subject,canonical(e));
    this.#db.prepare('UPDATE graph_meta SET epoch=epoch+1 WHERE id=1').run();
  }
  #rebuildGraph() {
    const epoch=this.#db.prepare('SELECT epoch FROM graph_meta WHERE id=1').get().epoch;
    // Only derived indexes are replaced; source versions, uses, inbox, decisions and budgets are untouched.
    this.#db.exec('DELETE FROM graph_tags; DELETE FROM graph_edges; DELETE FROM graph_nodes;');
    for(const row of this.#db.prepare(`SELECT v.body FROM versions v JOIN objects o ON o.id=v.id
      WHERE o.type IN ('event','note','personal_state','attention_frame','workspace','action','link') ORDER BY v.rowid`).iterate())this.#indexGraph(JSON.parse(row.body));
    this.#db.prepare('UPDATE graph_meta SET epoch=epoch+1 WHERE id=1').run();
    return {previousEpoch:epoch,epoch:this.#db.prepare('SELECT epoch FROM graph_meta WHERE id=1').get().epoch,
      nodes:this.#db.prepare('SELECT count(*) AS n FROM graph_nodes').get().n,edges:this.#db.prepare('SELECT count(*) AS n FROM graph_edges').get().n};
  }
  #graphNode(subjectId,value) {
    const n=nodeRef(value),row=this.#db.prepare(`SELECT g.descriptor,o.current_revision AS currentRevision
      FROM graph_nodes g JOIN objects o ON o.id=g.owner_id WHERE node_key=? AND (g.subject_id IS NULL OR g.subject_id=?)`).get(nodeKey(n),subjectId);
    if(!row)return null;const descriptor=JSON.parse(row.descriptor);
    return {...descriptor,historical:row.currentRevision!==descriptor.owner.revision||descriptor.status==='historical',latestOwner:{id:descriptor.owner.id,revision:row.currentRevision}};
  }
  #graphNeighbors(subjectId,node,includeHistorical,limit) {
    const key=nodeKey(node.ref);
    return this.#db.prepare(`SELECT e.body FROM graph_edges e JOIN objects o ON o.id=e.owner_id
      WHERE (e.source_key=? OR e.target_key=?) AND (e.subject_id IS NULL OR e.subject_id=?)
      AND (?=1 OR e.owner_revision=o.current_revision OR (e.owner_id=? AND e.owner_revision=?))
      ORDER BY e.edge_key LIMIT ?`).all(key,key,subjectId,includeHistorical?1:0,node.owner.id,node.owner.revision,limit).map(row=>{
        const edge=JSON.parse(row.body),out=nodeKey(edge.from)===key;
        return {edge,direction:out?'out':'in',other:out?edge.to:edge.from};
      });
  }
  #graphDirectory(subjectId,q,cap) {
    const args=[subjectId,q.includeHistorical?1:0],scoped=q.scope.length?` AND EXISTS(SELECT 1 FROM graph_tags t WHERE t.node_key=g.node_key AND t.tag IN (${q.scope.map(()=>'?').join(',')}))`:'';
    args.push(...q.scope,cap+1,q.offset);
    const rows=this.#db.prepare(`SELECT g.descriptor,o.current_revision AS currentRevision FROM graph_nodes g JOIN objects o ON o.id=g.owner_id
      WHERE (g.subject_id IS NULL OR g.subject_id=?) AND (?=1 OR g.owner_revision=o.current_revision)
      AND g.node_type IN ('event','note','personal_state','process')${scoped} ORDER BY g.node_key LIMIT ? OFFSET ?`).all(...args);
    return {nodes:rows.slice(0,cap).map(row=>{const d=JSON.parse(row.descriptor);return {...d,historical:row.currentRevision!==d.owner.revision||d.status==='historical',latestOwner:{id:d.owner.id,revision:row.currentRevision}};}),
      scanned:rows.length,nextOffset:rows.length>cap?q.offset+cap:null};
  }
  graphTrace({subjectId,query,maxNodes=8}) {
    ensure(this.#read(subjectId)?.type==='subject','MISSING_SUBJECT','unknown graph subject');
    ensure(Number.isSafeInteger(maxNodes)&&maxNodes>0&&maxNodes<=16,'TRACE_LIMIT','bounded graph read required');
    return this.view(()=>this.#traceGraph(subjectId,query,maxNodes));
  }
  #traceGraph(subjectId,query,maxNodes) {
    return walkKnowledgeGraph(query,{load:r=>this.#graphNode(subjectId,r),neighbors:(n,h,l)=>this.#graphNeighbors(subjectId,n,h,l),
      directory:(q,cap)=>this.#graphDirectory(subjectId,q,cap),maxNodes,epoch:this.#db.prepare('SELECT epoch FROM graph_meta WHERE id=1').get().epoch});
  }
  readGraphNode({subjectId,ref}) {
    return this.view(()=>{
      const descriptor=this.#graphNode(subjectId,ref);if(!descriptor)return null;
      const owner=this.#require(descriptor.owner),record=ref.kind==='record'?owner:owner.processes.find(p=>p.id===ref.id&&p.revision===ref.revision);
      ensure(record,'TRACE_REF','indexed process is missing from its original frame');
      return {descriptor,record,representation:ref.kind==='record'?'complete-record':'complete-process-with-frame-reference'};
    });
  }
  execute(args) {
    const writes=[];
    try{return this.#execute(args,writes);}
    catch(error){
      try{this.recordDiagnostic({stage:'transaction.rejected',status:'rejected',context:this.#debugTransactionContext(args),
        data:{...failureMetadata(error),attemptedWrites:writes.slice(0,16),writeCount:writes.length}});}
      catch(loggingError){this.#debugFailures++;this.#debugFailureCode=failureMetadata(loggingError).errorCode;}
      throw error;
    }
    finally{this.#transactionWrites=null;}
  }
  #execute({requestId, commands},writes) {
    ensure(this.#readDepth === 0, 'WRITE_IN_READ_VIEW', 'read snapshots cannot perform mutations');
    text(requestId, 'requestId');
    ensure(Array.isArray(commands) && commands.length > 0 && commands.length <= 128, 'INVALID_INPUT', 'expected 1..128 commands');
    const fingerprint = digest(commands);
    ensure(Buffer.byteLength(canonical(commands)) <= 1024 * 1024, 'INPUT_TOO_LARGE', 'transaction exceeds 1 MiB');
    this.#transactionWrites=writes;this.#db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.#db.prepare('SELECT fingerprint,result FROM operations WHERE request_id=?').get(requestId);
      if (previous) {
        ensure(previous.fingerprint === fingerprint, 'REQUEST_COLLISION', 'request id reused with different content');
        this.#logDebug({stage:'transaction.replayed',status:'replayed',context:this.#debugTransactionContext({requestId,commands}),data:{writeCount:0,operations:commands.slice(0,32).map(c=>String(c?.op??'invalid').slice(0,80))}});
        const replay=JSON.parse(previous.result);
        const restored=Array.isArray(replay)?replay:replay.items.map(item=>{
          const decode=r=>r&&Object.hasOwn(r,REPLAY_REF)?this.#require(r[REPLAY_REF]):r;
          return item?.record?{...item,record:decode(item.record)}:decode(item);
        });
        this.#db.exec('COMMIT'); return restored;
      }
      const results = commands.map(command => this.#command(command));
      const written=new Set(writes.map(refKey));
      // Replay points at the revision written by this exact transaction, never the mutable head.
      // Non-record return values and old inline rows remain readable without a migration.
      const encode=r=>r&&typeof r==='object'&&written.has(refKey(r))&&r.type&&canonical(this.#read(r.id,r.revision))===canonical(r)
        ?{[REPLAY_REF]:asRef(r)}:r;
      const items=results.map(r=>r?.record?{...r,record:encode(r.record)}:encode(r));
      this.#db.prepare('INSERT INTO operations(request_id,fingerprint,result) VALUES(?,?,?)').run(requestId, fingerprint, canonical({items}));
      this.#logDebug({stage:'transaction.committed',status:'ok',context:this.#debugTransactionContext({requestId,commands},results),
        data:{writes:writes.slice(0,16),writeCount:writes.length,operations:commands.slice(0,32).map(c=>String(c?.op??'invalid').slice(0,80))}});
      this.#db.exec('COMMIT'); return results;
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  #command(command) {
    ensure(command && typeof command.op === 'string', 'INVALID_INPUT', 'command must declare an operation');
    switch (command.op) {
      case 'assert_current': {
        const r=this.#require(command.ref);
        ensure(this.#read(r.id).revision===r.revision,'STALE_DEPENDENCY','host dependency changed before atomic commit',asRef(r));
        return asRef(r);
      }
      case 'initialize_motivation': return this.#initializeMotivation(command);
      case 'affect_turn': return this.#affectTurn(command);
      case 'append_event': return this.#event(command);
      case 'write_note': return this.#note(command);
      case 'write_entity': return this.#entity(command);
      case 'write_binding': return this.#binding(command);
      case 'attach_content': return this.#attachContent(command);
      case 'detach_content': return this.#detachContent(command);
      case 'set_workspace': return this.#workspace(command);
      case 'write_link': return this.#link(command);
      case 'record_use': return this.#use(command);
      case 'assert_task_control': {
        const task=this.#read(command.id);ensure(task?.type==='agent_task'&&task.status==='running'&&(task.controlRevision??0)===command.controlRevision,'AGENT_CONTROL_CHANGED','current task control supersedes this result');
        ensure((task.lease?.token??null)===command.leaseToken,'AGENT_LEASE_LOST','task lease changed during cognition');return {ok:true};
      }
      case 'claim_action': return this.#claimAction(command);
      case 'propose_action': return this.#propose(command);
      case 'record_receipt': return this.#receipt(command);
      case 'record_decision': return this.#decision(command);
      case 'stage_review': return this.#review(command);
      case 'adopt_review': return this.#adoptReview(command);
      case 'initialize_subject': return this.#initializeSubject(command);
      case 'initialize_attention': return this.#initializeAttention(command);
    case 'update_followup': return this.#updateFollowup(command);
    case 'put_agent_task': return this.#putAgentTask(command);
      case 'put_intent': return this.#putIntent(command);
      case 'put_extension_record': return this.#putExtensionRecord(command);
      case 'quarantine_source': return this.#quarantineSource(command);
      case 'fail_subject_event': return this.#failSubjectEvent(command);
      case 'mark_deferral_eligible': return this.#markDeferralEligible(command);
      case 'initialize_maintenance': return this.#initializeMaintenance(command);
      case 'foreground_fence': return this.#foregroundFence(command);
      case 'configure_maintenance': return this.#configureMaintenance(command);
      case 'prepare_maintenance': return this.#prepareMaintenance(command);
      case 'dispatch_maintenance': return this.#dispatchMaintenance(command);
      case 'capture_maintenance': return this.#captureMaintenance(command);
      case 'adopt_maintenance': return this.#adoptMaintenance(command);
      case 'finish_maintenance': return this.#finishMaintenance(command);
      case 'admit_subject_event': return this.#admitSubjectEvent(command);
      case 'release_completed_workbench': return this.#releaseCompletedWorkbench(command);
      case 'retire_subject_events': return this.#retireSubjectEvents(command);
      case 'capture_decision_attempt': return this.#captureDecisionAttempt(command);
      case 'advance_subject': return this.#advanceSubject(command);
      case 'claim_response': return this.#claimResponse(command);
      case 'record_response_delivery': return this.#responseDelivery(command);
      case 'recover_response': return this.#recoverResponse(command);
      case 'local_memory_lookup': return this.#localMemoryLookup(command);
      case 'rebuild_graph_index': return this.#rebuildGraph();
      default: ensure(false, 'UNKNOWN_COMMAND', 'unknown command');
    }
  }
  #event(c) {
    let messageValue=null;
    if(c.message!==undefined&&c.message!==null){messageValue=normalizeMessage(c.message,{body:typeof c.body==='string'?c.body:undefined});}
    const body=messageValue?projectText(messageValue):c.body;
    text(c.id, 'id'); text(body, 'body'); text(c.scene, 'scene');
    oneOf(c.origin, ['observed', 'reported', 'tool_receipt', 'background', 'imagination'], 'origin');
    text(c.source?.system, 'source.system'); text(c.source?.key, 'source.key');
    text(c.actor, 'actor');
    const occurredAt = c.occurredAt === undefined || c.occurredAt === null ? null : time(c.occurredAt);
    const threadId = c.threadId === undefined || c.threadId === null ? null : c.threadId;
    if(threadId!==null){text(threadId,'event threadId');ensure([...threadId].length<=200,'EVENT_THREAD','event threadId too long');}
    const sender=c.sender===undefined||c.sender===null?null:c.sender;
    if(sender){ensure(typeof sender==='object'&&!Array.isArray(sender),'INVALID_INPUT','sender must be an object');
      for(const k of ['system','id','name','entityId'])text(sender[k],'sender.'+k);
      ensure(typeof sender.isOwner==='boolean','INVALID_INPUT','sender.isOwner must be boolean');}
    const payload = {body, scene: c.scene, actor: c.actor, origin: c.origin, source: c.source, ...(messageValue?{message:messageValue}:{}), ...(sender?{sender}:{}), ...(threadId!==null?{threadId}:{}), occurredAt};
    const old = this.#read(c.id);
    if (old) {
      ensure(old.type === 'event' && old.inputHash === digest(payload), 'IMMUTABLE_EVENT', 'event id cannot be rewritten');
      return old;
    }
    const source = this.#db.prepare('SELECT id FROM event_sources WHERE system=? AND source_key=?').get(c.source.system, c.source.key);
    ensure(!source, 'DUPLICATE_SOURCE', 'original source already has an event id', {id: source?.id});
    const event = this.#write(c.id, 'event', 0, {...payload, inputHash: digest(payload), recordedAt: this.#now()});
    this.#db.prepare('INSERT INTO event_sources(system,source_key,id) VALUES(?,?,?)').run(c.source.system, c.source.key, c.id);
    return event;
  }
  #entity(c) {
    text(c.id,'entity id');oneOf(c.kind,['person','place','org','object','animal','concept'],'entity kind');
    text(c.name,'entity name');ensure([...c.name].length<=200,'ENTITY_NAME','entity name too long');
    const aliases=c.aliases??[];ensure(Array.isArray(aliases)&&aliases.length<=16,'ENTITY_ALIASES','up to sixteen aliases');
    aliases.forEach(a=>{text(a,'alias');ensure([...a].length<=200,'ENTITY_ALIASES','alias too long');});
    const unique=[...new Set(aliases.map(a=>a.trim()).filter(Boolean))];
    ensure(unique.length===aliases.length,'ENTITY_ALIASES','aliases must be unique');
    const description=c.description??'';if(description!=='')ensure([...description].length<=4000,'ENTITY_DESCRIPTION','description too long');
    const status=c.status??'current';oneOf(status,['current','retired'],'entity status');
    const old=this.#read(c.id);ensure(!old||old.type==='entity','ID_COLLISION','entity id already used');
    if(old)ensure(old.kind===c.kind,'ENTITY_KIND','entity kind cannot change');
    return this.#write(c.id,'entity',c.expectedRevision??0,{kind:c.kind,name:c.name.trim(),aliases:unique,description,status,recordedAt:this.#now()});
  }
  #binding(c) {
    const from=this.#require(c.from,['entity']),to=this.#require(c.to,['entity']);
    ensure(from.id!==to.id,'SELF_BINDING','an entity cannot be bound to itself');
    ensure(from.status==='current'&&to.status==='current','BINDING_STATUS','both entities must be current');
    oneOf(c.relation,['spouse','family','colleague','member-of','located-at','associated-with'],'binding relation');
    const symmetric=['spouse','family','associated-with'].includes(c.relation);
    const direction=c.direction??(symmetric?'symmetric':'forward');
    oneOf(direction,['symmetric','forward'],'binding direction');
    ensure(!symmetric||direction==='symmetric','BINDING_DIRECTION','symmetric relations cannot declare forward');
    const label=c.label??null;if(label!==null){text(label,'binding label');ensure([...label].length<=200,'BINDING_LABEL','binding label too long');}
    const source=c.source??'self';oneOf(source,['self','import'],'binding source');
    const evidence=this.#refs(c.evidence??[],['event','note']);ensure(evidence.length<=8,'BINDING_EVIDENCE','up to eight evidence refs');
    const status=c.status??'active';oneOf(status,['active','candidate','retired'],'binding status');
    const old=this.#read(c.id);ensure(!old||old.type==='binding','ID_COLLISION','binding id already used');
    return this.#write(c.id,'binding',c.expectedRevision??0,{from:asRef(from),to:asRef(to),relation:c.relation,direction,label,source,evidence,status,recordedAt:this.#now()});
  }
  #attachContent(c) {
    const record=this.#require(c.node,['note','entity']);
    const merged=normalizeContent(c.items??[],{existing:record.content??[]});
    ensure(merged.length<=32,'CONTENT_LIMIT','at most 32 content items per node');
    const {id,type,revision,...fields}=record;
    return this.#write(id,type,revision,{...fields,content:merged,recordedAt:this.#now()});
  }
  #detachContent(c) {
    const record=this.#require(c.node,['note','entity']);
    const ids=uniqueRefs((c.ids??[]).map(id=>({id,revision:1}))).map(x=>x.id);
    ensure(ids.length>=1&&ids.length<=32,'CONTENT_SHAPE','1..32 content ids');
    const existing=record.content??[];
    ensure(ids.every(id=>existing.some(x=>x.id===id)),'CONTENT_MISSING','content id not found');
    const {id,type,revision,...fields}=record;
    return this.#write(id,type,revision,{...fields,content:existing.filter(x=>!ids.includes(x.id)),recordedAt:this.#now()});
  }
  #putAgentTask(c){
    const t=c.task;ensure(t&&t.format==='agent-task-v1','AGENT_TASK','agent task required');
    text(t.id,'agent task id');text(t.goal,'agent task goal');ensure(['running','waiting','paused','blocked','done','failed','cancelled'].includes(t.status),'AGENT_TASK','bad agent task status');
    ensure(Number.isSafeInteger(t.stepCount)&&Number.isSafeInteger(t.callCount),'AGENT_TASK','agent task counters');
    ensure(Array.isArray(t.observations)&&Array.isArray(t.interrupts),'AGENT_TASK','agent task arrays');
    const current=this.#read(t.id);const expected=c.expectedRevision??0;ensure((current?.revision??0)===expected,'AGENT_TASK_CONFLICT','agent task revision changed');
    const {id,type,revision,...body}=t;return this.#write(t.id,'agent_task',expected,body);
  }
  #putIntent(c){
    const v=c.value;ensure(v&&v.format==='jingyang-intent-v1','INTENT','intent format required');text(v.id,'intent id');text(v.subject,'intent subject');text(v.goal,'intent goal');
    ensure(['open','pursuing','deferred','completed','abandoned','expired'].includes(v.status),'INTENT','intent status required');
    ensure(v.id.startsWith(`intent:${v.subject}:`),'INTENT_ID','intent id must be subject scoped');
    const subject=this.#read(v.subject);ensure(subject?.type==='subject','INTENT_SUBJECT','intent subject required');
    const {id,type,revision,...body}=v;return this.#write(v.id,'intent',c.expectedRevision??0,body);
  }
  // Theory-neutral extension state. The store never parses `value`.
  #putExtensionRecord(c){
    text(c.id,'extension id');text(c.owner,'extension owner');text(c.theory,'extension theory');text(c.stateType,'extension state type');text(c.schemaVersion,'extension schema version');
    ensure(c.id.startsWith(`extension:${c.owner}:${c.theory}:`),'EXTENSION_ID','extension id must be owner/theory scoped');
    const owner=this.#read(c.owner);ensure(owner?.type==='subject','EXTENSION_OWNER','extension owner must be a subject');
    ensure(c.value&&typeof c.value==='object'&&!Array.isArray(c.value),'EXTENSION_VALUE','extension value must be an object');
    if(c.source){ensure(c.source.id&&Number.isSafeInteger(c.source.revision),'EXTENSION_SOURCE','source ref required');
      const source=this.#read(c.source.id);ensure(source,'EXTENSION_SOURCE','source does not exist');
      ensure(source.revision===c.source.revision,'EXTENSION_SOURCE','source changed during migration');
      if(c.source.hash!==undefined)ensure(digest(source)===c.source.hash,'EXTENSION_SOURCE','source hash changed');}
    const body={format:'jingyang-extension-record-v1',owner:c.owner,theory:c.theory,stateType:c.stateType,schemaVersion:c.schemaVersion,value:c.value,
      migration:c.migration??null,recordedAt:this.#now()};
    const old=this.#read(c.id),expected=c.expectedRevision??0;
    if(old){
      ensure(old.type==='extension_record','ID_COLLISION','extension id belongs to another type');
      if(canonical(old)===canonical({...body,id:c.id,type:'extension_record',revision:old.revision}))return old;
      ensure(old.revision===expected,'EXTENSION_CONFLICT','extension record changed');
    }
    return this.#write(c.id,'extension_record',expected,body);
  }
  // Generic model-turn lifecycle marker; no theory-specific semantics.
  #quarantineSource(c){
    const subject=this.#require(c.subject,['subject']),event=this.#require(c.event,['event']);text(c.reason,'quarantine reason');
    const inbox=this.subjectObservation(subject.id,event.id);ensure(inbox,'QUARANTINE_NOT_ADMITTED','source event was not admitted');
    const id=`quarantine:${subject.id}:${event.id}`,old=this.#read(id);
    if(old){ensure(old.type==='decision_attempt'&&old.status==='quarantined'&&old.input?.currentEvent?.id===event.id,'QUARANTINE_COLLISION','quarantine id changed content');
      this.#db.prepare("UPDATE subject_inbox SET status='handled',decision_id=?,updated_at=? WHERE subject_id=? AND event_id=?").run(id,this.#now(),subject.id,event.id);return old;}
    const attempt=this.#write(id,'decision_attempt',0,{decisionId:null,requestKey:`quarantine:${subject.id}:${event.id}`,invocationKey:null,
      input:{currentEvent:asRef(event)},output:null,fingerprint:digest({subject:subject.id,event:asRef(event),reason:c.reason}),status:'quarantined',
      quarantine:{eventRef:asRef(event),reason:c.reason,recordedAt:this.#now()},recordedAt:this.#now()});
    this.#db.prepare("UPDATE subject_inbox SET status='handled',decision_id=?,updated_at=? WHERE subject_id=? AND event_id=?").run(attempt.id,this.#now(),subject.id,event.id);
    return attempt;
  }
  // A capacity failure is not a judgment about the event. Mark it deferred,
  // not handled, so the queue cannot claim it was processed; the source can
  // be retried after context pressure changes. Schema11 has no failed status,
  // so the explicit failure identity lives in decision_id/input-failure.
  #failSubjectEvent(c){
    const subject=this.#require(c.subject,['subject']),event=this.#require(c.event,['event']);text(c.reason,'failure reason');
    const inbox=this.subjectObservation(subject.id,event.id);ensure(inbox,'FAILURE_NOT_ADMITTED','source event was not admitted');
    const id=`input-failure:${subject.id}:${event.id}`,old=this.#read(id);
    ensure(inbox.status==='received'||(inbox.status==='deferred'&&inbox.decisionId===id),'FAILURE_ALREADY_FINAL','cannot replace a handled or independently deferred event with an input failure');
    // decision_id is a foreign key to objects(id). The failure identity used
    // to be referenced without being written, so every retry rolled back and
    // the source stayed 'received'. Create the durable attempt first.
    if(old){
      ensure(old.type==='decision_attempt'&&old.status==='deferred'&&old.input?.currentEvent?.id===event.id,'FAILURE_COLLISION','failure id changed content');
    }else{
      this.#write(id,'decision_attempt',0,{decisionId:null,requestKey:`input-failure:${subject.id}:${event.id}`,invocationKey:null,
        input:{currentEvent:asRef(event)},output:null,fingerprint:digest({subject:subject.id,event:asRef(event),reason:c.reason}),status:'deferred',
        failure:{reason:c.reason,recordedAt:this.#now()},recordedAt:this.#now()});
    }
    this.#db.prepare("UPDATE subject_inbox SET status='deferred',decision_id=?,updated_at=? WHERE subject_id=? AND event_id=?").run(id,this.#now(),subject.id,event.id);
    return {id,status:'deferred'};
  }
  #updateFollowup(c){
    const frame=this.#read(attentionId(c.subjectId));ensure(frame?.type==='attention_frame','FOLLOWUP_FRAME','attention frame required');
    ensure(Number.isSafeInteger(c.expectedRevision)&&frame.revision===c.expectedRevision,'FOLLOWUP_CONFLICT','attention frame changed');
    const current=[...(frame.followups??[])];const index=current.findIndex(f=>f.id===c.id);ensure(index>=0,'FOLLOWUP_MISSING','followup not found');
    oneOf(c.status,['scheduled','claimed','sent','failed','unknown','cancelled','deferred'],'followup status');
    const old=current[index];
    current[index]={...old,status:c.status,attempts:old.attempts+(c.status==='claimed'?1:0),updatedAt:this.#now(),lastResponse:c.lastResponse??old.lastResponse??null};
    return this.#write(attentionId(c.subjectId),'attention_frame',frame.revision,{...frame,followups:current,recordedAt:this.#now()});
  }
  #validateAbout(subjectId,refs,frame){
    for(const r of refs){
      if(r.kind==='scene')continue;
      if(r.kind==='self'){ensure(subjectId&&r.id===subjectId,'ABOUT_REFERENCE','self about must name this subject');continue;}
      if(r.kind==='process'){
        ensure(frame&&frame.processes.some(p=>p.id===r.id),'ABOUT_REFERENCE','process about must resolve in the current attention frame');continue;
      }
      const value=this.#read(r.id);ensure(value,'ABOUT_REFERENCE','about reference does not resolve',r);
      ensure(value.type===r.kind,'ABOUT_REFERENCE','about reference type mismatch',r);
    }
  }
  #note(c) {
    text(c.body, 'body'); oneOf(c.kind, NOTE_KINDS, 'note kind');
    oneOf(c.change, ['new_evidence', 'reinterpretation', 'self_report'], 'change');
    const confidence = c.confidence ?? 'tentative';
    oneOf(confidence, ['tentative', 'uncertain', 'confident'], 'confidence');
    const status = c.status ?? 'current'; oneOf(status, ['current', 'suspended', 'historical'], 'status');
    const evidence = this.#refs(c.evidence ?? [], ['event', 'note']);
    ensure(evidence.every(ref => ref.id !== c.id), 'SELF_SUPPORT', 'a note cannot cite itself as evidence');
    const old = this.#read(c.id);
    const rootIds = [...new Set(evidence.flatMap(ref => {
      const record = this.#require(ref);
      return record.type === 'event' ? [record.id] : record.rootIds;
    }))].sort();
    const newRootIds = rootIds.filter(id => !(old?.rootIds ?? []).includes(id));
    if (c.change === 'new_evidence') ensure(newRootIds.length > 0, 'NO_NEW_SOURCE', 'new evidence needs a new source root');
    const scope = c.scope ?? {scenes: [], people: [], validFrom: null, validUntil: null};
    ensure(Array.isArray(scope.scenes) && Array.isArray(scope.people), 'INVALID_INPUT', 'invalid scope');
    scope.scenes.forEach(x => text(x, 'scene')); scope.people.forEach(x => text(x, 'person'));
    if (scope.validFrom !== null) time(scope.validFrom);
    if (scope.validUntil !== null) time(scope.validUntil);
    ensure(scope.validFrom === null || scope.validUntil === null || scope.validUntil > scope.validFrom, 'INVALID_INPUT', 'invalid validity interval');
    const anchor = normalizeAnchor(c.anchor ?? old?.anchor ?? null);
    const domains = Object.hasOwn(c, 'domains') ? normalizeDomains(c.domains, 'note domains') : old?.domains;
    const about = Object.hasOwn(c, 'about') ? normalizeAbout(c.about, 'note about') : old?.about;
    if(about)this.#validateAbout(null,about,null);
    if(anchor&&about)ensure(about.some(r=>r.kind===anchor.kind&&r.id===anchor.id),'ABOUT_ANCHOR_MISMATCH','anchor must be one of the about targets');
    const record = this.#write(c.id, 'note', c.expectedRevision, {
      body: c.body, kind: c.kind, change: c.change, confidence, status, evidence, rootIds, scope, ...(anchor?{anchor}:{}), ...(domains!==undefined?{domains}:{}), ...(about!==undefined?{about}:{}), recordedAt: this.#now()
    });
    return {record, newRootIds};
  }
  #workspace(c) {
    text(c.scene, 'scene'); text(c.focus?.id, 'focus.id'); text(c.focus?.label, 'focus.label');
    const workingRefs = this.#refs(c.workingRefs ?? [], ['event', 'note']);
    const continuityRefs = this.#refs(c.continuityRefs ?? [], ['event', 'note']);
    const actionRefs = this.#refs(c.actionRefs ?? [], ['action']);
    const resume = c.resume ?? '';
    ensure(typeof resume === 'string', 'INVALID_INPUT', 'invalid resume note');
    return this.#write(c.id, 'workspace', c.expectedRevision, {
      scene: c.scene, focus: c.focus, workingRefs, continuityRefs, actionRefs, resume, recordedAt: this.#now()
    });
  }
  #link(c) {
    oneOf(c.relation, ['related', 'similar', 'supports', 'contradicts'], 'relation');
    const from = asRef(this.#require(c.from, ['event', 'note']));
    const to = asRef(this.#require(c.to, ['event', 'note']));
    ensure(from.id !== to.id, 'SELF_LINK', 'self links are not allowed');
    ensure(Number.isFinite(c.strength) && c.strength > 0 && c.strength <= 1, 'INVALID_INPUT', 'strength must be in (0,1]');
    oneOf(c.direction, ['forward', 'both'], 'direction');
    const basis = this.#refs(c.basis ?? [], ['event', 'note']);
    const status = c.status ?? 'active';
    oneOf(status, ['active', 'retired'], 'link status');
    return this.#write(c.id, 'link', c.expectedRevision, {
      from, to, relation: c.relation, strength: c.strength, direction: c.direction,
      basis, status, recordedAt: this.#now()
    });
  }
  #use(c) {
    const memory = this.#require(c.memory, ['event', 'note']);
    const encounter = this.#require(c.encounter, ['event']);
    ensure(['observed', 'reported', 'tool_receipt'].includes(encounter.origin), 'NOT_AN_ENCOUNTER', 'background or imagination is not a real interaction');
    oneOf(c.reason, ['recalled', 'applied', 'reexperienced'], 'use reason');
    const at = this.#now();
    ensure(encounter.recordedAt <= at && memory.recordedAt <= at, 'INVALID_TIME', 'use precedes its sources');
    const old = this.#db.prepare('SELECT 1 FROM uses WHERE memory_id=? AND encounter_id=?').get(memory.id, encounter.id);
    if (old) return {changed: false};
    this.#db.prepare('INSERT INTO uses(memory_id,encounter_id,revision,used_at,reason) VALUES(?,?,?,?,?)').run(memory.id, encounter.id, memory.revision, at, c.reason);
    return {changed: true};
  }
  #propose(c) {
    const workspace = this.#require(c.workspace, ['workspace']);
    ensure(this.#read(workspace.id).revision === workspace.revision, 'STALE_WORKSPACE', 'action belongs to an outdated workspace');
    text(c.tool, 'tool');
    const inputRefs = this.#refs(c.inputRefs ?? [], ['event', 'note']);
    if(c.intentRef){const intent=this.#require(c.intentRef,['intent']);ensure(c.tool==='start_agent_task'&&c.args?.intentId===intent.id,'INTENT','intent control binding must match task action');ensure(this.#read(intent.id).revision===intent.revision,'STALE_INTENT','intent control binding is stale');}
    return this.#write(c.id, 'action', 0, {
      workspace: asRef(workspace), tool: c.tool, args: c.args ?? {}, inputRefs,...(c.intentRef?{intentRef:c.intentRef}:{}),
      status: 'proposed', receipt: null, recordedAt: this.#now()
    });
  }
  #claimAction(c){
    const action=this.#require(c.action,['action']);text(c.claimId,'action claim');text(c.worker,'action worker');
    ensure(this.#read(action.id).revision===action.revision,'VERSION_CONFLICT','action changed');
    ensure(action.status==='proposed','ACTION_NOT_PENDING','claimed or unknown action must not be retried');
    const {id,type,revision,...fields}=action;
    return this.#write(id,type,revision,{...fields,status:'dispatching',claimId:c.claimId,worker:c.worker,recordedAt:this.#now()});
  }
  #receipt(c) {
    const action = this.#read(c.actionId);
    ensure(action?.type === 'action', 'MISSING_ACTION', 'action does not exist');
    ensure(action.revision === c.expectedRevision, 'VERSION_CONFLICT', 'action changed since snapshot');
    ensure(action.status==='proposed'||action.status==='dispatching'&&c.claimId===action.claimId,'ACTION_FINALIZED','unclaimed action or matching in-flight claim required');
    oneOf(c.status, ['succeeded', 'failed', 'cancelled', 'interrupted'], 'receipt status');
    const event = this.#event({
      id: c.eventId, body: c.body, origin: 'tool_receipt', source: c.source,
      actor: c.actor, scene: sourceReplyRoute({read:(id,revision)=>this.#read(id,revision),all:type=>this.all(type),action:asRef(action)}).scene??this.#require(action.workspace).scene, occurredAt: c.occurredAt
    });
    const {id, type, revision: oldRevision, ...fields} = action;
    return this.#write(id, type, c.expectedRevision, {...fields, status: c.status, receipt: asRef(event), recordedAt: this.#now()});
  }
  #checkCognitionMaterials(materials) {
    ensure(Array.isArray(materials)&&materials.length<=32,'INVALID_INPUT','bounded cognition materials required');
    for(const m of materials){
      ensure(typeof m.historical==='boolean','INVALID_INPUT','material history marker required');
      const r=this.#require(m.ref,['event','note']);
      ensure(m.historical||this.#read(r.id).revision===r.revision,'STALE_MATERIAL','current material changed; rebuild model input',m.ref);
    }
  }
  #decision(c) {
    const reflection=c.reflection===true,workspace=this.#require(c.workspace,['workspace']);
    if(reflection){ensure(c.currentEvent===null,'INVALID_INPUT','reflection decision has no current observation');}
    else{const encounter=this.#require(c.currentEvent,['event']);
      ensure(['observed','reported','tool_receipt'].includes(encounter.origin),'NOT_AN_ENCOUNTER','actual trigger required');}
    ensure(this.#read(workspace.id).revision===workspace.revision,'STALE_WORKSPACE','decision input workspace changed');
    this.#checkCognitionMaterials(c.materials);
    const selected=c.output.options.find(o=>o.id===c.output.selected);
    ensure(selected,'INVALID_CHOICE','selected option missing');
    if(c.action){
      const action=this.#require(c.action,['action']);
      ensure(selected.kind==='act'&&refKey(action.workspace)===refKey(c.workspace)
        && action.tool===selected.payload.tool&&canonical(action.args)===canonical(selected.payload.args),
        'ACTION_MISMATCH','decision does not match proposed action');
    }else ensure(selected.kind!=='act','ACTION_MISMATCH','action choice must have an action intent');
    return this.#write(c.id,'decision',0,{currentEvent:reflection?null:c.currentEvent,workspace:c.workspace,materials:c.materials,
      ...(reflection?{reflection:true}:{}),
      ...(c.input.payload.continuity?{requestKey:c.requestKey,invocationKey:c.invocationKey}:{}),
      input:c.input,output:c.output,action:c.action??null,status:'selected',recordedAt:this.#now()});
  }
  #review(c) {
    const decision=this.#require(c.decision,['decision']);
    this.#checkCognitionMaterials(c.materials);
    const feedbackRefs=this.#refs(c.feedbackRefs,['event']);
    ensure(feedbackRefs.length>0&&feedbackRefs.length<=16,'FEEDBACK_REQUIRED','actual feedback required');
    ensure(feedbackRefs.every(ref=>['observed','reported','tool_receipt'].includes(this.#require(ref).origin)),
      'NOT_AN_ENCOUNTER','background is not execution feedback');
    if(decision.action){
      const action=this.#require(c.action,['action']);
      ensure(action.id===decision.action.id&&this.#read(action.id).revision===action.revision&&action.status!=='proposed'
        && feedbackRefs.some(ref=>refKey(ref)===refKey(action.receipt)),'REVIEW_NOT_READY','matching actual action receipt required');
    }else ensure(c.action===null,'ACTION_MISMATCH','non-action decision has no action receipt');
    return this.#write(c.id,'review',0,{decision:c.decision,action:c.action,feedbackRefs,materials:c.materials,input:c.input,
      output:c.output,status:c.output.disposition==='update'?'proposed':c.output.disposition==='defer'?'deferred':c.output.disposition==='lookup'?'needs-information':'recorded',
      appliedRefs:[],recordedAt:this.#now()});
  }
  #adoptReview(c) {
    const review=this.#require(c.review,['review']);
    ensure(this.#read(review.id).revision===review.revision,'VERSION_CONFLICT','review changed');
    ensure(review.status==='proposed'&&review.output.updates.length>0,'REVIEW_NOT_PENDING','review has no pending updates');
    this.#checkCognitionMaterials(review.materials);
    const results=review.output.updates.map(u=>this.#note(u));
    const {id,type,revision:oldRevision,...fields}=review;
    return this.#write(id,type,review.revision,{...fields,status:'adopted',appliedRefs:results.map(r=>asRef(r.record)),recordedAt:this.#now()});
  }
  #initializeSubject(c) {
    text(c.id,'subject id');
    const maxForeground=c.maxForeground??8;
    ensure(Number.isSafeInteger(maxForeground)&&maxForeground>0&&maxForeground<=32,'STATE_LIMIT','foreground capacity must be 1..32');
    const attentionPolicy=c.attentionPolicy;
    if(attentionPolicy!==undefined)oneOf(attentionPolicy,['task','explore','cautious'],'attention policy');
    const old=this.#read(c.id);
    if(old){ensure(old.type==='subject'&&old.maxForeground===maxForeground,'SUBJECT_EXISTS','cannot reset an existing subject or its capacity');return old;}
    return this.#write(c.id,'subject',0,{foreground:[],changedStates:[],maxForeground,...(attentionPolicy!==undefined?{attentionPolicy}:{}),lastDecision:null,recordedAt:this.#now()});
  }
  #admitSubjectEvent(c) {
    const subject=this.#read(c.subjectId);ensure(subject?.type==='subject','MISSING_SUBJECT','initialize one subject before admitting events');
    const event=this.#require(c.event,['event']);
    ensure(['observed','reported','tool_receipt'].includes(event.origin),'NOT_AN_ENCOUNTER','only actual encounters may enter this inbox');
    this.#db.prepare("INSERT OR IGNORE INTO subject_inbox(subject_id,event_id,status,decision_id,updated_at) VALUES(?,?,'received',NULL,?)").run(subject.id,event.id,this.#now());
    return this.subjectObservation(subject.id,event.id);
  }
  #retireSubjectEvents(c){
    const subject=this.#read(c.subjectId);ensure(subject?.type==='subject','MISSING_SUBJECT','subject required');
    const ids=Array.isArray(c.eventIds)?c.eventIds:[];
    for(const id of ids)this.#db.prepare("UPDATE subject_inbox SET status='handled',updated_at=? WHERE subject_id=? AND event_id=?").run(this.#now(),c.subjectId,id);
    return {retired:ids.length};
  }
  #releaseCompletedWorkbench(c){    text(c.subjectId,'subject id');
    const head=this.#read(c.subjectId);
    const subject=this.#require({id:c.subjectId,revision:head?.revision},['subject']);
    const id=attentionId(subject.id),frame=this.#read(id);
    ensure(frame?.type==='attention_frame'&&frame.subject===subject.id,'ATTENTION_REQUIRED','attention frame required');
    const done=new Set(frame.processes.filter(p=>['completed','abandoned'].includes(p.status)).map(p=>p.id));
    if(!done.size)return {released:0};
    const residences=frame.residences.flatMap(r=>{
      if(r.target?.kind==='process')return done.has(r.target.ref.id)?[]:[r];
      if(r.target?.kind!=='material')return [r];
      const purposes=(r.purposes??[]).filter(p=>materialPurposeStatus(p,frame,null)!=='ended');
      return purposes.length?[{...r,purposes}]:[];
    });
    if(canonical(residences)===canonical(frame.residences))return {released:0};
    const retainedIds=new Set(residences.map(r=>r.id));
    const removed=frame.residences.filter(r=>!retainedIds.has(r.id));
    const removedIds=new Set(removed.map(r=>r.id)),removedTargets=new Set(removed.map(r=>r.target?.ref?.id).filter(Boolean));
    const focus=frame.focus?{...frame.focus,selection:(frame.focus.selection??[]).filter(s=>!(s.kind==='residence'&&removedIds.has(s.id))&&!(s.kind==='material'&&removedTargets.has(s.id)))}:frame.focus;
    const {id:_,type,revision,recordedAt,...fields}=frame;
    return this.#write(id,'attention_frame',frame.revision,{...fields,residences,...(focus?{focus}:{}),recordedAt:this.#now()});
  }
  #initializeAttention(c) {    const subject=this.#read(c.subjectId);ensure(subject?.type==='subject','MISSING_SUBJECT','initialize subject first');
    const id=attentionId(subject.id),old=this.#read(id);
    if(old){ensure(old.type==='attention_frame'&&old.subject===subject.id,'ID_COLLISION','attention identity collision');return old;}
    ensure(subject.foreground.length===0,'ATTENTION_MIGRATION_REQUIRED','nonempty legacy foreground needs explicit migration, never silently clear it');
    return this.#write(id,'attention_frame',0,{...emptyAttention(subject.id),recordedAt:this.#now()});
  }
  #markDeferralEligible(c) {
    text(c.subjectId,'subject id');text(c.deferId,'deferral id');
    const subject=this.#read(c.subjectId);ensure(subject?.type==='subject','MISSING_SUBJECT','subject required');
    const id=attentionId(subject.id),frame=this.#read(id);
    ensure(frame?.type==='attention_frame'&&frame.subject===subject.id,'ATTENTION_REQUIRED','attention frame required');
    const deferrals=Array.isArray(frame.deferrals)?frame.deferrals:[];
    const d=deferrals.find(x=>x.id===c.deferId);ensure(d,'DEFERRAL_MISSING','unknown deferral');
    ensure(d.conditionType==='host'||d.condition?.kind==='host','SUBJECT_CONDITION_NOT_HOST_VERIFIABLE','host cannot verify a subject semantic condition');
    ensure(d.status==='pending','DEFERRAL_STATUS','deferral is not pending');
    const updated={...d,status:'eligible',events:[...(d.events??[]),{type:'defer_became_eligible',at:this.#now()}]};
    const next=deferrals.map(x=>x.id===d.id?updated:x);
    const {id:_,type,revision,recordedAt,...fields}=frame;
    this.#write(id,'attention_frame',frame.revision,{...fields,deferrals:next,recordedAt:this.#now()});
    return updated;
  }
  #captureDecisionAttempt(c) {
    text(c.id,'attempt id');const fingerprint=digest({input:c.input,output:c.output,decisionId:c.decisionId,requestKey:c.requestKey,invocationKey:c.invocationKey});
    const old=this.#read(c.id);
    if(old){ensure(old.type==='decision_attempt'&&old.fingerprint===fingerprint,'ATTEMPT_COLLISION','attempt id changed content');return old;}
    return this.#write(c.id,'decision_attempt',0,{decisionId:c.decisionId,requestKey:c.requestKey,invocationKey:c.invocationKey,input:c.input,output:c.output,fingerprint,status:'captured',recordedAt:this.#now()});
  }
  #localMemoryLookup(c) {
    text(c.subjectId,'subject id');
    const subject=this.#require({id:c.subjectId,revision:this.#read(c.subjectId)?.revision},['subject']);
    const decision=this.#require(c.decision,['decision']),policy=lookupPolicy(c.policy);
    ensure(decision.input.payload.continuity?.subject.id===subject.id,'SUBJECT_MISMATCH','lookup must belong to this subject');
    const selected=decision.output.options.find(o=>o.id===decision.output.selected);
    ensure(selected?.kind==='lookup','NOT_LOOKUP','execute only a committed lookup choice');
    const requested=normalizeLookupQuery(selected.payload),id=lookupResultId(asRef(decision)),roundId=lookupRoundId(subject.id,decision.currentEvent,decision.reflection?decision.input.payload.memoryAccess?.roundScope??null:null);
    const consultEnabled=decision.input.payload.memoryAccess?.consultation?.enabled===true;
    ensure(!requested.consult||consultEnabled&&decision.input.stage==='decisionGraph','CONSULT_CAPABILITY','consultation requires an explicit unified capability');
    ensure(!requested.trace||decision.input.stage==='decisionGraph'||decision.reflection===true&&decision.input.payload.memoryAccess?.historyRecovery?.enabled===true,'UNIFIED_PROTOCOL_REQUIRED','cross-type reads require explicit unified mode');
    const attention=this.#read(attentionId(subject.id));
    ensure(!requested.workbench||decision.input.payload.continuity?.attention?.recoverySupport?.enabled===true,'RECOVERY_CAPABILITY','history route was not granted');
    if(requested.workbench){const source=requested.workbench.frame??requested.workbench.source.frame;
      ensure(source.id===attention?.id&&source.revision<=decision.input.payload.continuity.attention.frame.revision,'RECOVERY_SCOPE','history must be an own delivered-or-older frame');}
    ensure(!requested.graph&&!requested.stateRef||attention&&decision.input.payload.continuity.attention,'ATTENTION_REQUIRED','extended reads require the attention protocol');
    let round=this.#read(roundId);
    if(round)ensure(round.type==='lookup_round'&&canonical(round.policy)===canonical(policy),'LOOKUP_POLICY','cannot reset an existing lookup policy');
    const old=this.#read(id);
    if(old){ensure(old.type==='lookup_result'&&old.subject===subject.id&&sameRef(old.decision,c.decision),'LOOKUP_COLLISION','lookup result identity changed');return old;}
    if(!round)round=this.#write(roundId,'lookup_round',0,{subject:subject.id,anchor:decision.currentEvent,workspace:decision.workspace,
      policy,reads:0,seenRefs:[],queries:[],recordedAt:this.#now()});
    const compile=q=>q.consult?consultationOperation(q.consult,{read:(id,rev)=>this.#read(id,rev),subjectId:subject.id}):q;
    const getEpoch=(q,op)=>op.trace?this.#db.prepare('SELECT epoch FROM graph_meta WHERE id=1').get().epoch:q.consult?
      this.#db.prepare("SELECT coalesce(max(v.rowid),0) AS epoch FROM versions v JOIN objects o ON o.id=v.id WHERE o.type IN ('event','note','personal_state','action')").get().epoch:
      q.workbench?(q.workbench.frame??q.workbench.source.frame).revision:q.graph?attention.revision:q.stateRef?q.stateRef.revision:this.#db.prepare("SELECT coalesce(max(v.rowid),0) AS epoch FROM versions v JOIN objects o ON o.id=v.id WHERE o.type IN ('event','note')").get().epoch;
    let operation=compile(requested),epoch=getEpoch(requested,operation);
    let outcome=null,method=null,total=null,nextOffset=null,entries=[],novelRefs=[],repeatOf=null,readPerformed=false,query=requested,offset=0,graph=null,states=[],failure=null,trace=null,novelNodes=[],consultation=null,workbench=null,opened=null;
    if(!sameRef(subject.lastDecision,c.decision))outcome='superseded';
    else if(this.#read(decision.workspace.id).revision!==decision.workspace.revision)outcome='different-context';
    else if(!sameRef(round.workspace,decision.workspace)){
      // A fresh explicit lookup can follow a deliberate context change without resetting the read budget.
      const {id:ignoredId,type:ignoredType,revision:ignoredRevision,...fields}=round;
      round=this.#write(roundId,'lookup_round',round.revision,{...fields,workspace:decision.workspace,recordedAt:this.#now()});
    }
    if(!outcome&&requested.pageAfter){
      const previous=this.#require(requested.pageAfter,['lookup_result']);
      ensure(previous.subject===subject.id&&previous.round.id===roundId&&sameRef(previous.workspace,decision.workspace)&&previous.nextOffset!==null&&(previous.query.terms||previous.query.context||previous.query.trace?.route==='directory'||previous.query.consult?.via==='find'),
        'LOOKUP_PAGE','pageAfter must name an own prior page in this round');
      ensure(!previous.query.trace||decision.input.stage==='decisionGraph'||decision.reflection===true&&decision.input.payload.memoryAccess?.historyRecovery?.enabled===true,'UNIFIED_PROTOCOL_REQUIRED','trace pages require explicit unified mode');
      ensure(!previous.query.consult||consultEnabled&&decision.input.stage==='decisionGraph','CONSULT_CAPABILITY','consultation pages require explicit capability');
      query=previous.query.consult?{consult:{...previous.query.consult,need:asRef(previous)}}:previous.query.trace?{trace:{...previous.query.trace,offset:previous.nextOffset}}:previous.query.context?{context:previous.query.context}:{terms:previous.query.terms};offset=previous.nextOffset;
      operation=compile(query);epoch=getEpoch(query,operation);
      if(previous.epoch!==epoch)outcome='source-changed';
    }
    if(query.consult)consultation=consultationState(query.consult,{load:(id,rev)=>this.#read(id,rev),subjectId:subject.id,roundId,workspace:decision.workspace,resultRef:{id,revision:1}});
    const signature=digest({query:operation,offset,epoch});
    if(operation.navigate&&!outcome){
      const source=this.#require(query.consult.need,['lookup_result']),pages=this.#consultationPages({subjectId:subject.id,root:consultation.root,currentEvent:decision.currentEvent,workspace:decision.workspace});
      const limited=(round.navigationSteps??0)>=NAVIGATION_LIMIT;
      const visit=resolveNavigation({request:limited?{via:'history'}:operation.navigate,source,root:consultation.root,load:(id,rev)=>this.#read(id,rev),pages,
        subjectId:subject.id,currentEvent:decision.currentEvent,workspace:decision.workspace});
      outcome=limited?'navigation-limit':visit.outcome;method='cached-page-navigation';
      consultation={...consultation,navigation:{isPage:false,page:visit.menu.currentPage,parentPage:visit.page?parentPage(visit.page):null,
        fromPage:visit.fromPage??null,menu:visit.menu,remaining:Math.max(0,NAVIGATION_LIMIT-(round.navigationSteps??0)-(limited?0:1))}};
      if(visit.page){const page=visit.page;
        entries=page.entries;states=page.states??[];trace=page.trace??null;graph=page.graph??null;failure=page.failure??null;
        total=page.total;epoch=page.epoch;operation=page.operation??compile(page.query);
        if(page.consultation.discovery)consultation.discovery=page.consultation.discovery;
      }
      if(!limited){const {id:ignoreId,type:ignoreType,revision:ignoreRevision,...fields}=round;
        round=this.#write(roundId,'lookup_round',round.revision,{...fields,navigationSteps:(round.navigationSteps??0)+1,recordedAt:this.#now()});}
    }else if(!outcome){
      if(consultation&&this.#consultationPages({subjectId:subject.id,root:consultation.root,currentEvent:decision.currentEvent,workspace:decision.workspace}).length>=NAVIGATION_LIMIT)
        outcome='history-page-limit';
      const previous=round.queries.find(q=>q.signature===signature);
      if(!outcome&&previous){const result=this.#require(previous.result,['lookup_result']);outcome='no-progress';repeatOf=asRef(result);
        ({method,total,nextOffset,entries}=result);graph=result.graph??null;states=result.states??[];failure=result.failure??null;trace=result.trace??null;workbench=result.workbench??null;
        if(consultation)consultation={...consultation,...(result.consultation?.discovery?{discovery:result.consultation.discovery}:{})};}
      else if(!outcome&&round.reads>=round.policy.maxReads)outcome='budget-stop';
      else if(!outcome){
        readPerformed=true;
        let hits=[];
        if(operation.workbench){
          method='versioned-material-use-history';const q=operation.workbench;
          if(q.via==='list'){
            const snapshot=this.#require(q.frame,['attention_frame']);ensure(snapshot.subject===subject.id,'RECOVERY_SCOPE','own history only');
            const frames=this.#db.prepare('SELECT body FROM versions WHERE id=? AND revision>1 AND revision<=? ORDER BY revision DESC LIMIT 64')
              .all(q.frame.id,q.cursor?.revision??q.frame.revision).map(r=>JSON.parse(r.body));
            workbench=recoveryPage({query:q,frames,read:(id,rev)=>this.#read(id,rev),subject:subject.id,maxHits:policy.maxHits});
            outcome=workbench.items.length?'found':workbench.nextCursor?'scan-limit':'empty';
          }else{
            workbench=exitedUse(q.source,{read:(id,rev)=>this.#read(id,rev),subject:subject.id});outcome=workbench?'found':'not-found';total=workbench?1:0;
            if(workbench){const m=this.#require(workbench.binding.target.ref,['event','note']);hits=[{ref:asRef(m),hits:[]}];}
          }
        }else if(operation.find){
          const found=this.#consultationSearch(subject.id,operation.find,policy.maxHits,offset,decision.currentEvent);
          method=found.method;total=found.total;nextOffset=found.nextOffset;outcome=found.items.length?'found':found.scanLimited?'scan-limit':'empty';
          consultation={...consultation,discovery:found};
        }else if(operation.versions){
          const target=this.#read(operation.versions.id,operation.versions.revision),head=target?this.#read(target.id):null;
          method='current-head-directory-only';
          if(!target){total=0;outcome='not-found';}
          else if(!['event','note','personal_state'].includes(target.type)||target.type==='personal_state'&&target.subject!==subject.id){total=0;outcome='invalid-target';}
          else{total=1;outcome='found';consultation={...consultation,discovery:{items:[{ref:asRef(head),type:head.type,status:head.status??null,
            requested:operation.versions,representation:'catalog-only-not-delivered-body',applicability:'not-assessed'}],method,total:1,nextOffset:null,scanLimited:false}};}
        }else if(operation.trace){
          method='versioned-cross-type-path-query';
          try{trace=this.#traceGraph(subject.id,operation.trace,policy.maxHits);outcome=trace.stop;nextOffset=trace.nextOffset;}
          catch(error){if(error.code!=='TRACE_REQUIRED_OVERFLOW')throw error;outcome='required-overflow';failure={code:error.code,message:error.message};}
        }else if(operation.graph){
          method='typed-event-graph';
          try{graph=expandEvents(attention,operation.graph,{maxNodes:policy.maxHits});outcome=graph.nodes.length?'found':'empty';total=graph.total??null;}
          catch(error){if(error.code!=='GRAPH_SEED')throw error;outcome='invalid-target';failure={code:error.code,message:error.message};}
        }else if(operation.stateRef){
          const value=this.#read(operation.stateRef.id,operation.stateRef.revision);method='own-state-pinned-read';
          if(!value){outcome='not-found';total=0;}
          else if(value.type!=='personal_state'||value.subject!==subject.id){outcome='invalid-target';total=0;}
          else {states=[{ref:asRef(value),historical:this.#read(value.id).revision!==value.revision}];outcome='found';total=1;}
        }else if(operation.ref){
          method='pinned-read';const record=this.#read(operation.ref.id,operation.ref.revision);
          if(!record){outcome='not-found';total=0;}
          else if(!['event','note'].includes(record.type)){outcome='invalid-target';total=0;}
          else{hits=[{ref:asRef(record),hits:[]}];total=1;outcome='found';}
        }else if(operation.open){
          const node=this.#require(operation.open.ref,['note','entity','binding']),items=node.content??[];
          opened={ref:asRef(node),items:items.length?contentView(items,{item:operation.open.item??null}):[],meaning:items.length?'explicitly-opened':'empty-content-list'};
          outcome=items.length?'found':'empty';total=items.length;method='node-open';
        }else if(operation.entity){
          const name=operation.entity,lower=name.toLocaleLowerCase('zh-CN');
          const entities=[...this.all('entity')].filter(e=>e.status==='current'&&[e.name,...(e.aliases??[])].some(n=>n.toLocaleLowerCase('zh-CN')===lower));
          const ids=new Set(entities.map(e=>e.id));
          const bindings=[...this.all('binding')].filter(b=>b.status!=='retired'&&(ids.has(b.from.id)||ids.has(b.to.id)));
          const all=[...entities,...bindings];
          hits=all.slice(offset,offset+policy.maxHits).map(r=>({ref:asRef(r),hits:[]}));total=all.length;
          nextOffset=offset+hits.length<total?offset+hits.length:null;method='entity-index';outcome=hits.length?'found':'empty';
        }else if(operation.query){
          const page=this.#search({terms:operation.query.terms,types:['event','note'],limit:policy.maxHits,offset,excludeRefs:decision.currentEvent?[decision.currentEvent]:[]});
          hits=page.items;total=page.total;method='free-text-tokenized';
          nextOffset=offset+hits.length<total?offset+hits.length:null;outcome=hits.length?'found':'empty';
        }else if(operation.recall){
          const page=this.#recall(operation.recall,policy.maxHits,offset);
          hits=page.items;total=page.total;method=page.method;
          nextOffset=offset+hits.length<total?offset+hits.length:null;outcome=hits.length?'found':'empty';
        }else if(operation.person){
          // 按人查：笔记的 scope.people 与事件的 actor；只读当前/已记录版本，不做语义猜人。
          const name=operation.person;
          const matches=[...this.all('event').filter(e=>e.actor===name),...this.all('note').filter(n=>n.status==='current'&&(n.scope?.people??[]).includes(name))]
            .sort((a,b)=>(b.recordedAt??0)-(a.recordedAt??0)||a.id.localeCompare(b.id));
          const page=matches.slice(offset,offset+policy.maxHits);
          hits=page.map(record=>({ref:asRef(record),hits:[]}));total=matches.length;
          nextOffset=offset+hits.length<total?offset+hits.length:null;method='person-index';outcome=hits.length?'found':'empty';
        }else{
          const page=this.#search({terms:query.context?.terms??query.terms,...(query.context?{contextAnchor:query.context.anchor}:{}),limit:policy.maxHits,offset,excludeRefs:decision.currentEvent?[decision.currentEvent]:[]});method=page.method;hits=page.items;total=page.total;
          nextOffset=offset+hits.length<total?offset+hits.length:null;outcome=hits.length?'found':'empty';
        }
        entries=hits.map(hit=>{
          const value=this.#require(hit.ref,['event','note','entity','binding']);
          return {ref:asRef(value),type:value.type,kind:value.kind??null,origin:value.origin??'opinion',hits:hit.hits,
            historicalAtRead:this.#read(value.id).revision!==value.revision||value.status==='historical',needsReviewAtRead:this.basisChanged(asRef(value)),
            ...(hit.contextMatch?{contextMatch:hit.contextMatch}:{})};
        });
        novelRefs=[...entries.map(e=>e.ref),...states.map(e=>e.ref)].filter(r=>!round.seenRefs.some(oldRef=>sameRef(oldRef,r)));
        novelNodes=(trace?.nodes??[]).filter(n=>!(round.seenGraphNodes??[]).includes(nodeKey(n.ref))).map(n=>n.ref);
        round=this.#write(roundId,'lookup_round',round.revision,{subject:round.subject,anchor:round.anchor,workspace:round.workspace,policy,
          reads:round.reads+1,seenRefs:uniqueRefs([...round.seenRefs,...novelRefs]),
          ...(round.navigationSteps!==undefined?{navigationSteps:round.navigationSteps}:{}),
          ...((trace||round.seenGraphNodes)?{seenGraphNodes:[...new Set([...(round.seenGraphNodes??[]),...novelNodes.map(nodeKey)])]}:{}),
          queries:[...round.queries,{signature,result:{id,revision:1}}],recordedAt:this.#now()});
      }
    }
    if(consultation&&!consultation.navigation){
      const previous=typeof query.consult.need==='string'?null:this.#read(query.consult.need.id,query.consult.need.revision),cursor=consultationCursor(previous);
      const isPage=readPerformed||outcome==='no-progress';
      consultation.navigation={isPage,page:isPage?{id,revision:1}:cursor,parentPage:isPage?cursor:null};
    }
    return this.#write(id,'lookup_result',0,{subject:subject.id,round:asRef(round),decision:asRef(decision),anchor:decision.currentEvent,
      workspace:decision.workspace,requested,query,offset,epoch,outcome,method,total,nextOffset,entries,novelRefs,repeatOf,readPerformed,
      reads:round.reads,remainingReads:round.policy.maxReads-round.reads,...(operation.graph?{graph}:{}),...(operation.stateRef?{states}:{}),
      ...(trace?{trace,novelNodes}:{}),...(workbench?{workbench}:{}),...(consultation?{consultation,operation}:{}),...(opened?{opened}:{}),...(failure?{failure}:{}),recordedAt:this.#now()});
  }
  #consultationPages({subjectId,root,currentEvent,workspace}){
    return this.#db.prepare(`SELECT v.body FROM objects o JOIN versions v ON v.id=o.id AND v.revision=o.current_revision
      WHERE o.type='lookup_result' AND json_extract(v.body,'$.subject')=?
      AND json_extract(v.body,'$.consultation.root.id')=? AND json_extract(v.body,'$.consultation.root.revision')=?
      AND json_extract(v.body,'$.anchor.id')=? AND json_extract(v.body,'$.anchor.revision')=?
      AND json_extract(v.body,'$.workspace.id')=? AND json_extract(v.body,'$.workspace.revision')=?
      AND (json_extract(v.body,'$.consultation.navigation.isPage')=1 OR
        (json_type(v.body,'$.consultation.navigation') IS NULL AND json_extract(v.body,'$.consultation.via') NOT IN ('back','forward','directory','history')
         AND json_extract(v.body,'$.outcome') NOT IN ('budget-stop','superseded','different-context','source-changed')))
      ORDER BY v.rowid LIMIT 33`).all(subjectId,root.id,root.revision,currentEvent.id,currentEvent.revision,workspace.id,workspace.revision)
      .map(r=>JSON.parse(r.body)).filter(isConsultationPage);
  }
  consultationPages(args){return this.view(()=>this.#consultationPages(args));}
  #consultationSearch(subjectId,q,limit,offset,currentEvent){
    if(q.anchor)this.#require(q.anchor,['event']);
    const roots=new Set(q.anchor?[q.anchor.id]:[]),actions=q.anchor?this.#db.prepare("SELECT v.body FROM objects o JOIN versions v ON v.id=o.id AND v.revision=o.current_revision WHERE o.type='action' AND EXISTS(SELECT 1 FROM json_each(v.body,'$.inputRefs') r WHERE json_extract(r.value,'$.id')=? AND json_extract(r.value,'$.revision')=?) ORDER BY o.id LIMIT 1001").all(q.anchor.id,q.anchor.revision):[];
    for(const row of actions.slice(0,1000)){
      const a=JSON.parse(row.body);if(a.receipt)roots.add(a.receipt.id);
    }
    const rows=this.#db.prepare("SELECT v.body FROM objects o JOIN versions v ON v.id=o.id AND v.revision=o.current_revision WHERE o.type IN ('event','note','personal_state') AND (o.type!='personal_state' OR json_extract(v.body,'$.subject')=?) AND o.id!=? ORDER BY o.id LIMIT 1001").all(subjectId,currentEvent.id);
    const records=rows.slice(0,1000).map(r=>JSON.parse(r.body)),contextRefs=records.filter(r=>roots.has(r.id)||(r.rootIds??[]).some(id=>roots.has(id))
      ||[...(r.basis?.observations??[]),...(r.basis?.memories??[])].some(ref=>roots.has(ref.id))).map(asRef);
    const ranked=rankConsultation(records,q,{contextRefs}),byKey=new Map(records.map(r=>[refKey(r),r]));
    const items=ranked.ranked.slice(offset,offset+limit).map(hit=>{
      const r=byKey.get(refKey(hit.ref));return consultationCandidate(r,hit,{head:this.#read(r.id),needsReview:this.basisChanged(asRef(r))});
    });
    return {items,total:ranked.ranked.length,nextOffset:offset+items.length<ranked.ranked.length?offset+items.length:null,method:ranked.method,
      scanned:records.length,scanLimited:rows.length>1000||actions.length>1000,channelCap:32,candidateMeaning:'rank-is-not-confidence-or-applicability; catalog-is-not-read'};
  }
  #validateCompression(fields){
    const changed=new Set(fields.map(f=>f.id));
    const existing=[...this.all('personal_state')].filter(r=>r.kind==='impression'&&r.stage==='compressed'&&r.status==='open'&&!changed.has(r.id));
    const staged=fields.filter(f=>f.next?.kind==='impression'&&f.next.stage==='compressed'&&f.next.status==='open');
    ensure(existing.length+staged.length<=30,'COMPRESSION_FULL','up to thirty open compressed units; retire or merge explicitly');
    for(const f of fields)if(f.next?.kind==='impression'&&f.next.stage==='compressed'){
      for(const source of f.next.basis?.priorStates??[]){
        const record=this.#read(source.id,source.revision);
        ensure(record&&record.kind==='impression'&&record.stage!=='compressed','COMPRESSION_CHAIN','compressed units cannot cite compressed units as sources');
      }
    }
  }
  #initializeMotivation(c) {
    const subject=this.#require({id:c.subjectId,revision:this.#read(c.subjectId)?.revision},['subject']);
    const id=`motivation:${subject.id}`,old=this.#read(id),snapshot=c.snapshot;
    if(old){ensure(old.type==='motivation_state','AFFECT_PROFILE','cannot reseed/change profile');return old;}
    ensure(!subject.motivationState,'AFFECT_INITIALIZATION','fresh initial state required');
    const record=this.#write(id,'motivation_state',0,{subject:subject.id,snapshot,receipts:[],recordedAt:this.#now()});
    const {id:sid,type,revision,...prior}=subject;this.#write(sid,type,revision,{...prior,motivationState:asRef(record),recordedAt:this.#now()});return record;
  }
  #affectTurn(c) {
    const old=this.#read(c.id);
    if(!old){
      const v=c.value;ensure(c.expectedRevision===0&&v?.status==='prepared'&&v.packet?.payload?.continuity?.subject?.id===v.subject,'AFFECT_TURN','prepared packet required');
      ensure(this.#read(v.subject)?.type==='subject'&&c.id===`affect-turn:${v.packet.packetId}`,'AFFECT_TURN','own packet identity');
      return this.#write(c.id,'affect_turn',0,{...v,recordedAt:this.#now()});
    }
    ensure(old.type==='affect_turn'&&old.revision===c.expectedRevision,'AFFECT_TURN_VERSION','turn changed');
    const allowed={prepared:['dispatched','failed'],dispatched:['captured','uncertain','failed'],captured:['committed','failed','superseded'],committed:[],uncertain:['closed-incomplete'],failed:['closed-incomplete'],superseded:[],'closed-incomplete':[]};
    ensure(allowed[old.status]?.includes(c.status),'AFFECT_TURN_STATUS','invalid capture/adoption phase');
    if(old.status==='dispatched'&&c.status==='failed')ensure(c.transportInvoked===false&&c.failurePhase==='before-transport','AFFECT_TURN_STATUS','failed invocation requires positive evidence of no transport');
    if(c.status==='superseded'){
      const before=old.packet?.payload?.task,task=before?this.#read(before.id):null;
      ensure(task?.type==='agent_task'&&((task.controlRevision??0)!==(before.controlRevision??0)||(task.lease?.token??null)!==(before.leaseToken??null)||['paused','cancelled'].includes(task.status)),'AFFECT_SUPERSESSION','persisted host control change required');
    }
    if(c.status==='closed-incomplete'){
      if(old.status==='uncertain'&&old.error==='NETWORK_PREFLIGHT_FAILED'&&old.transportInvoked==null&&old.rawOutput==null)ensure(c.resolution?.reason==='LEGACY_PREFLIGHT_NOT_DISPATCHED'&&c.resolution?.requestId===null&&c.resolution?.noProviderCall===true&&c.resolution?.ledgerStatus==='not-registered'&&/^[a-f0-9]{64}$/.test(c.resolution?.evidenceHash??'')&&/^[a-f0-9]{64}$/.test(c.resolution?.sourceHash??''),'AFFECT_RESOLUTION','legacy preflight requires reviewed source boundary and complete ledger absence evidence');
      else if(old.status==='uncertain'&&old.error==='MODEL_ERROR'&&old.transportInvoked==null&&old.rawOutput==null&&c.resolution?.reason==='LOCAL_GATE_NOT_DISPATCHED')ensure(c.resolution.requestId===null&&c.resolution.noProviderCall===true&&c.resolution.ledgerStatus==='not-registered'&&['evidenceHash','sourceHash','gateHash','manifestHash'].every(k=>/^[a-f0-9]{64}$/.test(c.resolution[k]??''))&&Number.isSafeInteger(c.resolution.blockedAt)&&c.resolution.blockedAt<=old.recordedAt,'AFFECT_RESOLUTION','reviewed local stop requires source, stop barrier, manifest and complete ledger-absence proof; never use for unknown provider costs');
      else if(old.status==='uncertain'&&old.error==='PACKET_CHANGED'&&old.transportInvoked==null&&old.rawOutput==null&&c.resolution?.reason==='HOST_INPUT_NOT_DISPATCHED')ensure(c.resolution.validationError==='PACKET_CHANGED'&&c.resolution.requestId===null&&c.resolution.noProviderCall===true&&c.resolution.ledgerStatus==='not-registered'&&['evidenceHash','sourceHash','manifestHash','ledgerHash'].every(k=>/^[a-f0-9]{64}$/.test(c.resolution[k]??''))&&Number.isSafeInteger(c.resolution.sourceFrozenAt)&&c.resolution.sourceFrozenAt<=old.recordedAt,'AFFECT_RESOLUTION','reviewed host input rejection requires frozen-source binding and complete ledger-absence evidence; never use for provider or external-operation uncertainty');
      else if(old.status==='failed'&&old.transportInvoked===false)ensure(c.resolution?.reason===old.error&&c.resolution?.requestId===null&&c.resolution?.noProviderCall===true,'AFFECT_RESOLUTION','unsent turn requires explicit no-provider-call closure');
      else if(old.status==='failed')ensure(old.rawOutput!==null&&typeof old.rawOutput==='string'&&c.resolution?.reason==='OUTPUT_REJECTED'&&c.resolution?.outputHash===digest(old.rawOutput)&&c.resolution?.requestId==='turn:'+old.packet.packetId&&c.resolution?.ledgerStatus==='settled'&&Number.isSafeInteger(c.resolution.actualMicros)&&c.resolution.actualMicros>=0&&/^[a-f0-9]{64}$/.test(c.resolution.evidenceHash??''),'AFFECT_RESOLUTION','rejected output requires explicit settled accounting and captured-output evidence');
      else if(old.error==='BUDGET_EXPIRED'||old.error==='BUDGET_HALTED')ensure(c.resolution?.reason===old.error&&c.resolution?.requestId===null&&c.resolution?.noProviderCall===true,'AFFECT_RESOLUTION','budget-blocked request must be explicitly marked no-provider-call');
      else if(old.error==='INTERRUPTED_DISPATCH')ensure(c.resolution?.reason==='INTERRUPTED_DISPATCH'&&c.resolution?.ledgerStatus==='dispatched'&&typeof c.resolution?.requestId==='string'&&Number.isSafeInteger(c.resolution?.reserveMicros)&&/^[a-f0-9]{64}$/.test(c.resolution?.evidenceHash??''),'AFFECT_RESOLUTION','interrupted dispatch must retain its reserve');
      else if(old.error==='UNCERTAIN_REQUEST')ensure(c.resolution?.reason==='UNCERTAIN_REQUEST'&&c.resolution?.ledgerStatus==='uncertain'&&typeof c.resolution?.requestId==='string'&&Number.isSafeInteger(c.resolution?.reserveMicros)&&/^[a-f0-9]{64}$/.test(c.resolution?.evidenceHash??''),'AFFECT_RESOLUTION','uncertain provider request must retain its uncertain ledger row');
      else ensure(old.error==='MODEL_INCOMPLETE'&&c.resolution?.requestId==='turn:'+old.packet.packetId&&c.resolution?.ledgerStatus==='settled'&&Number.isSafeInteger(c.resolution.actualMicros)&&c.resolution.actualMicros>=0&&/^[a-f0-9]{64}$/.test(c.resolution.evidenceHash??''),'AFFECT_RESOLUTION','host must verify settled charge and no adopted output; unknown-cost requests cannot close here');
    }
    const {id,type,revision,...prior}=old;
    if(c.status==='captured')ensure(typeof c.rawOutput==='string'&&Buffer.byteLength(c.rawOutput)<=32768,'AFFECT_OUTPUT_LIMIT','bounded public final only');
    if(c.status==='closed-incomplete'&&old.packet?.payload?.current){
      const subject=this.#read(old.subject);
      if(subject?.type==='subject')this.#quarantineSource({subject:asRef(subject),event:old.packet.payload.current,reason:'closed-incomplete'});
    }
    return this.#write(id,type,revision,{...prior,status:c.status,...(c.status==='captured'?{rawOutput:c.rawOutput}:{}),...(c.decision?{decision:c.decision}:{}),...(c.error?{error:c.error}:{}),...(c.failurePhase?{failurePhase:c.failurePhase}:{}),...(Object.hasOwn(c,'transportInvoked')?{transportInvoked:c.transportInvoked}:{}),...(c.resolution?{resolution:c.resolution}:{}),recordedAt:this.#now()});
  }
  #advanceSubject(c) {
    const subject=this.#require(c.subject,['subject']),decision=this.#require(c.decision,['decision']),reflection=decision.reflection===true;
    ensure(this.#read(subject.id).revision===subject.revision,'STALE_SUBJECT','subject changed while the model was deciding');
    const input=decision.input.payload,context=input.continuity;
    ensure(context&&refKey(context.subject)===refKey(c.subject),'SUBJECT_MISMATCH','state update belongs to another subject input');
    let currentEvent=null,currentObservations=[];
    let observationRefs=uniqueRefs(input.materials.filter(m=>m.record.type==='event').map(m=>m.ref));
    if(!reflection){
      const inbox=this.subjectObservation(subject.id,decision.currentEvent.id);
      ensure(inbox,'OBSERVATION_NOT_ADMITTED','current event was not admitted for this subject');
      currentEvent=decision.currentEvent;currentObservations=[currentEvent];
      observationRefs=uniqueRefs([currentEvent,...observationRefs]);
    }
    const at=this.#now(),delta=normalizeStateDelta(decision.output.continuity,{attention:Boolean(context.attention),reflection});
    const attentionPolicy=delta.attentionPolicy??subject.attentionPolicy;
    const choice=decision.output.options.find(o=>o.id===decision.output.selected);
    const {foreground,fields,attentionFrame,processRefs}=this.#continuationPatch({subject,input,delta,at,currentEvent,
      currentObservations,observationRefs,responseIntent:choice.kind==='respond'?{id:`${decision.id}:response`,revision:1}:null});
    this.#applyEventProcesses({subject,decision,input,delta,attentionFrame,processRefs});
    let motivationState=subject.motivationState??null;
    ensure(!c.affectTurn||c.motivationTransition,'AFFECT_BINDING','turn adoption requires its state transition');
    if(c.motivationTransition){
      ensure(c.affectTurn,'AFFECT_TURN','state adoption requires a captured turn');
      const transition=c.motivationTransition,turn=this.#require(c.affectTurn,['affect_turn']);
      const record=this.#require(transition.baseRef,['motivation_state']);
      ensure(record.subject===subject.id&&sameRef(subject.motivationState,asRef(record))&&sameRef(asRef(this.#read(record.id)),asRef(record)),'STALE_MOTIVATION','motivation changed while deciding');
      ensure(turn.status==='captured'&&turn.subject===subject.id&&canonical(turn.packet)===canonical(decision.input),'AFFECT_TURN','captured public output for this exact packet required');
      ensure(transition.subject===subject.id&&transition.packetId===decision.input.packetId&&sameRef(context.motivation?.ref,asRef(record))&&transition.baseHash===digest(record.snapshot)&&transition.baseHash===turn.preview.baseHash&&sameRef(transition.baseRef,turn.preview.baseRef)&&transition.previewHash===context.motivation.previewHash&&transition.previewHash===digest(turn.preview.snapshot),'AFFECT_BINDING','candidate must bind to the delivered base and preview');
      const updated=this.#write(record.id,'motivation_state',record.revision,{subject:subject.id,snapshot:transition.snapshot,receipts:transition.receipts,decision:c.decision,recordedAt:at});
      motivationState=asRef(updated);
      if(turn)this.#affectTurn({id:turn.id,expectedRevision:turn.revision,status:'committed',decision:c.decision});
    }
    const next=this.#write(subject.id,'subject',subject.revision,{...(motivationState?{motivationState}:{}),foreground:[...foreground].sort().map(id=>asRef(this.#read(id))),
      changedStates:fields.map(f=>asRef(this.#read(f.id))),maxForeground:subject.maxForeground,...(attentionPolicy!==undefined?{attentionPolicy}:{}),lastDecision:c.decision,...(attentionFrame?{attentionFrame:asRef(attentionFrame)}:{}),recordedAt:at});
    if(!reflection)this.#db.prepare('UPDATE subject_inbox SET status=?,decision_id=?,updated_at=? WHERE subject_id=? AND event_id=?').run(delta.observationDisposition,decision.id,at,subject.id,decision.currentEvent.id);
    const selected=decision.output.options.find(o=>o.id===decision.output.selected);
    const currentEventRecord=currentEvent?this.#read(currentEvent.id):null;
    if(selected.kind==='respond')this.#write(`${decision.id}:response`,'response',0,{subject:subject.id,decision:c.decision,scene:selected.payload.target??sourceReplyRoute({read:(id,revision)=>this.#read(id,revision),all:type=>this.all(type),subjectId:subject.id,event:currentEvent}).scene??currentEventRecord?.scene??input.workspace.scene,body:selected.payload.text,
      status:'pending',claimId:null,worker:null,receipts:[],recordedAt:at});
    const attempt=this.#require(c.attempt,['decision_attempt']);
    ensure(attempt.status==='captured'&&attempt.decisionId===decision.id&&attempt.input.packetId===decision.input.packetId
      &&canonical(attempt.output)===canonical(decision.output),'ATTEMPT_MISMATCH','decision differs from captured output');
    const {id,type,revision:oldRevision,...prior}=attempt;
    this.#write(id,type,attempt.revision,{...prior,status:'adopted',decision:c.decision,subjectAfter:asRef(next),recordedAt:at});
    for(const write of c.extensionWrites??[])this.#putExtensionRecord(write);
    return next;
  }
  #applyEventProcesses({subject,decision,input,delta,attentionFrame,processRefs}){
    const patch=delta.attention?.eventProcesses;if(!patch)return;
    ensure(input.continuity.attention?.eventProcessSupport?.enabled===true&&attentionFrame,'EVENT_PROCESS_DISABLED','explicit event-process capability required');
    const events=eventProcessEvents(input),created=delta.attention.processes.filter(p=>p.expectedRevision===0);
    for(const operation of ['add','remove'])for(const entry of patch[operation]){
      const event=this.#require(entry.event,['event']);
      ensure(['observed','reported'].includes(event.origin)&&events.some(r=>sameRef(r,entry.event)),'UNDELIVERED_EVENT','complete fixed-version event must have been delivered');
      ensure(this.subjectObservation(subject.id,event.id),'EVENT_SUBJECT','event was not admitted for this subject');
      const process=attentionFrame.processes.find(p=>p.id===entry.process.id);
      ensure(process,'PROCESS_SUBJECT','process must belong to this subject');
      const isNew=created.some(p=>p.id===entry.process.id&&entry.process.revision===1);
      ensure(isNew||(processRefs??[]).some(r=>sameRef(r,entry.process)),'UNREAD_PROCESS','process source version must be delivered or newly created in this transaction');
      const id=eventProcessId(subject.id,entry.event,process.id),old=this.#read(id),status=operation==='add'?'active':'withdrawn';
      if(old)ensure(old.type==='extension_record'&&old.owner===subject.id&&old.theory===EVENT_PROCESS_THEORY&&old.value.processId===process.id&&sameRef(old.value.event,entry.event),'EVENT_PROCESS_ID','association identity collision');
      if(old?.value.status===status||(!old&&operation==='remove'))continue;
      const source={ref:entry.process,frame:isNew?asRef(attentionFrame):input.continuity.attention.frame};
      const value=operation==='add'?{event:entry.event,processId:process.id,processSource:source,status,establishedBy:asRef(decision),changedBy:asRef(decision)}:{...old.value,status,changedBy:asRef(decision)};
      this.#putExtensionRecord({id,owner:subject.id,theory:EVENT_PROCESS_THEORY,stateType:'event-process-link',schemaVersion:'1',expectedRevision:old?.revision??0,value});
    }
  }
  #continuationPatch({subject,input,delta,at,currentEvent=null,currentObservations=[],observationRefs=[],responseIntent=null}) {
    ensure(this.#read(subject.id).revision===subject.revision,'STALE_SUBJECT','subject changed during background work');
    const context=input.continuity;
    ensure(!delta.attention?.eventProcesses||context.attention?.eventProcessSupport?.enabled===true,'EVENT_PROCESS_DISABLED','explicit event-process capability required');
    const attention=this.#read(attentionId(subject.id));
    ensure(Boolean(attention)===Boolean(context.attention),'ATTENTION_REQUIRED','do not bypass the enabled attention protocol');
    if(attention){
      ensure(sameRef(context.attention.frame,asRef(attention)),'STALE_ATTENTION','event/residence frame changed while deciding');
      for(const q of context.attention.questions)for(const a of q.attempts)
        ensure(sameRef(a.ref,asRef(this.#require({id:a.ref.id,revision:this.#read(a.ref.id)?.revision},['response']))),'STALE_DELIVERY','a sending outcome changed while deciding');
    }
    const memoryStates=[...(context.shortTerm?.items??[]),...(context.subjectiveMemory?.recent?.items??[]),...(context.subjectiveMemory?.compressed?.items??[]),...(context.subjectiveMemory?.maintenance?.olderRecent??[])].map(x=>x.ref);
    const delivered=[...context.foreground,...context.recalled,...memoryStates.map(ref=>({ref}))].map(x=>x.ref);
    for(const entry of [...context.foreground,...context.recalled,...memoryStates.map(ref=>({ref}))]){
      const value=this.#require(entry.ref,['personal_state']);
      ensure(value.subject===subject.id,'SUBJECT_MISMATCH','state belongs to another subject');
      ensure(entry.historical||this.#read(value.id).revision===value.revision,'STALE_STATE','current state changed');
    }
    const memoryRefs=input.materials.map(m=>m.ref),foreground=new Set(subject.foreground.map(r=>r.id));
    const fields=[];
    for(const change of delta.changes){
      const previous=this.#read(change.id);
      // A Process lives in the attention frame, not as a top-level record. Without this
      // check its id would either fail as a misleading revision conflict or, with
      // expectedRevision=0, silently create a personal state that shadows the Process.
      ensure(previous||!attention?.processes.some(p=>p.id===change.id),'WRONG_OBJECT_KIND',
        `“${change.id}”是Process，不是个人状态。修改它请写在continuity.attention.processes；continuity.changes只放个人状态。`,
        {path:'continuity.changes',id:change.id,actualType:'process',updatePath:'continuity.attention.processes'});
      ensure(!previous||previous.type==='personal_state','ID_COLLISION','state id belongs to another record type',
        {path:'continuity.changes',id:change.id,actualType:previous?.type});
      if(Object.hasOwn(change,'mind')||previous?.mind||['concern','condition','expectation','readiness'].includes(change.kind))
        ensure(context.mind?.format==='jingyang-mind-view-v1','MIND_PROTOCOL_REQUIRED','semantic changes need an explicit mind-capable input');
      const next=personalStateChange(change,previous,{subject:subject.id,recordedAt:at,states:delivered,
        observations:observationRefs,currentObservations,memories:memoryRefs});
      if(next?.about)this.#validateAbout(subject.id,next.about,attention);
      if(next)fields.push({id:change.id,expectedRevision:change.expectedRevision,next});
    }
    validateMindPatch({fields,deliveredRecords:delivered.map(r=>this.#require(r,['personal_state'])),subject:subject.id});
    this.#validateCompression(fields);
    for(const update of fields){
      const value=this.#write(update.id,'personal_state',update.expectedRevision,update.next);
      if(!attention){if(value.status==='closed')foreground.delete(value.id);else foreground.add(value.id);}
    }
    let attentionFrame=null,processRefs=[];
    if(attention){
      const attentionRemove=new Set(delta.attention?.residency?.remove??[]);
      const duplicateRemove=delta.residency.remove.filter(id=>attentionRemove.has(id));
      if(delta.residency.add.length===0&&duplicateRemove.length===delta.residency.remove.length){
        delta.residency.remove=delta.residency.remove.filter(id=>!attentionRemove.has(id));
      }
      ensure(delta.residency.add.length===0&&delta.residency.remove.length===0,'RESIDENCY_CONFLICT','attention mode uses only purpose residency');
      const results=input.information?.results??[],graphReads=results.filter(r=>r.graph&&sameRef(r.graph.frame,asRef(attention)));
      const deliveredProcesses=(input.knowledge?.cards??[]).filter(c=>c.type==='process'&&!c.historical&&sameRef(c.ref.frame,asRef(attention))).map(c=>c.record);
      processRefs=[...context.attention.processes,...graphReads.flatMap(r=>r.graph.nodes),...deliveredProcesses].map(asRef);
      const relationRefs=[...context.attention.relations,...context.attention.staleRelations,...graphReads.flatMap(r=>r.graph.relations)].map(asRef);
      const updated=advanceAttention(attention,delta.attention,{read:(id,rev)=>this.#read(id,rev),at,maxForeground:subject.maxForeground,currentEvent:currentEvent,
        processRefs,relationRefs,questionRefs:context.attention.questions.map(asRef),residenceIds:context.attention.residences.map(r=>r.id),stateRefs:delivered,changedStateIds:fields.map(f=>f.id),
        observations:observationRefs.map(r=>this.#require(r,['event'])),memoryRefs,workbenchMaterials:context.attention.materialSupport?.enabled===true,
        workbenchFocus:context.attention.focusSupport?.enabled===true,focusMenu:context.attention.focusSupport?.menu??[],
        workbenchRecovery:context.attention.recoverySupport?.enabled===true,
        recoverySources:results.filter(r=>r.workbench).map(r=>this.#require(r.ref,['lookup_result'])),
        responseIntent});
      const {id:aid,type:atype,revision:arev,recordedAt:recorded,...oldFields}=attention;
      const {id:uid,type:utype,revision:urev,recordedAt:urecorded,...newFields}=updated;
      attentionFrame=canonical(oldFields)===canonical(newFields)?attention:this.#write(aid,'attention_frame',arev,{...newFields,recordedAt:at});
      foreground.clear();for(const r of attentionFrame.residences)if(r.target.kind==='state')foreground.add(r.target.ref.id);
    }
    for(const id of delta.residency.add){const value=this.#read(id);ensure(value?.type==='personal_state'&&value.subject===subject.id,'MISSING_STATE','foreground addition must be an own state');ensure(value.status!=='closed','CLOSED_FOREGROUND','closed state cannot be foreground');foreground.add(id);}
    for(const id of delta.residency.remove){const value=this.#read(id);ensure(value?.type==='personal_state'&&value.subject===subject.id,'MISSING_STATE','foreground removal must name an own state');foreground.delete(id);}
    ensure(foreground.size<=subject.maxForeground,'FOREGROUND_CAPACITY','explicitly choose background states; attempted output has been retained');
    return {foreground,fields,attentionFrame,processRefs};
  }
  #initializeMaintenance(c) {
    ensure(this.#read(c.subjectId)?.type==='subject'&&this.#read(attentionId(c.subjectId))?.type==='attention_frame','ATTENTION_REQUIRED','maintenance needs explicit attention mode');
    const policy=maintenancePolicy(c.policy),id=maintenanceScheduleId(c.subjectId),old=this.#read(id);
    if(old){ensure(old.type==='maintenance_schedule'&&canonical(old.policy)===canonical(policy),'MAINTENANCE_POLICY','use explicit configure for policy changes');return old;}
    return this.#write(id,'maintenance_schedule',0,{subject:c.subjectId,policy,cursors:{residences:null,questions:null,inbox:null,experiences:null,objects:null},nextLane:0,foregroundEpoch:0,lastObservedAt:0,recordedAt:this.#now()});
  }
  #foregroundFence(c) {
    const schedule=this.#read(maintenanceScheduleId(c.subjectId));ensure(schedule?.type==='maintenance_schedule','MAINTENANCE_MISSING','maintenance schedule missing');
    ensure(sameRef(c.subject,this.#read(c.subjectId)),'STALE_SUBJECT','rebuild foreground input before a model request');
    ensure(sameRef(c.attention,this.#read(attentionId(c.subjectId))),'STALE_ATTENTION','rebuild foreground event frame');
    const {id,type,revision:ignored,...fields}=schedule;
    return this.#write(id,type,schedule.revision,{...fields,foregroundEpoch:schedule.foregroundEpoch+1,recordedAt:this.#now()});
  }
  #configureMaintenance(c) {
    const schedule=this.#require(c.schedule,['maintenance_schedule']);ensure(this.#read(schedule.id).revision===schedule.revision,'VERSION_CONFLICT','maintenance configuration changed');
    const {id,type,revision:ignored,...fields}=schedule;
    return this.#write(id,type,schedule.revision,{...fields,policy:maintenancePolicy(c.policy),recordedAt:this.#now()});
  }
  #checkMaintenanceGuards(packet) {
    const p=packet.payload,g=p.guards;
    ensure(g&&sameRef(g.subject,p.subject)&&sameRef(g.subject,p.continuity.subject),'MAINTENANCE_STALE','invalid subject snapshot');
    ensure(g.foregroundEpoch===this.#read(maintenanceScheduleId(g.subject.id)).foregroundEpoch,'MAINTENANCE_STALE','foreground interaction started while reviewing');
    for(const r of [g.subject,g.attention,...g.heads])ensure(sameRef(r,this.#read(r.id)),'MAINTENANCE_STALE','a delivered head changed while reviewing',r);
    ensure(sameRef(g.attention,p.continuity.attention.frame),'MAINTENANCE_STALE','invalid attention snapshot');
    for(const o of g.observations){const actual=this.subjectObservation(g.subject.id,o.ref.id);ensure(actual&&actual.status===o.status,'MAINTENANCE_STALE','pending observation changed');}
  }
  #prepareMaintenance(c) {
    const schedule=this.#read(maintenanceScheduleId(c.subjectId));ensure(schedule?.type==='maintenance_schedule','MAINTENANCE_MISSING','initialize maintenance first');
    verifyMaintenancePacket(c.packet,schedule.policy);const now=this.#now(),slot=maintenanceSlot(now,schedule.policy);
    ensure(now>=schedule.lastObservedAt&&slot.due&&c.packet.payload.day===slot.day&&c.packet.payload.generatedAt<=now,'MAINTENANCE_NOT_DUE','maintenance is disabled, early or clock-regressed');
    ensure(c.packet.payload.subject.id===c.subjectId&&c.packet.payload.candidates.length>0,'MAINTENANCE_SHAPE','nonempty own candidates required');
    this.#checkMaintenanceGuards(c.packet);
    const id=maintenanceJobId(c.subjectId,slot.day),old=this.#read(id);
    if(old&&old.status!=='prepared')return old;
    // Repeated empty/idle checks must not grow a new full input record every minute.
    if(old&&canonical(old.packet.payload.guards)===canonical(c.packet.payload.guards)&&old.packet.payload.identity===c.packet.payload.identity&&canonical(old.policy)===canonical(schedule.policy))return old;
    const job=this.#write(id,'maintenance_job',old?.revision??0,{subject:c.subjectId,day:slot.day,policy:schedule.policy,packet:c.packet,status:'prepared',calls:0,output:null,error:null,recordedAt:now});
    const {id:sid,type,revision:ignored,...fields}=schedule;
    this.#write(sid,type,schedule.revision,{...fields,lastObservedAt:now,recordedAt:now});return job;
  }
  #dispatchMaintenance(c) {
    const job=this.#require(c.job,['maintenance_job']),schedule=this.#read(maintenanceScheduleId(job.subject)),now=this.#now();
    text(c.claimId,'maintenance dispatch claim');
    ensure(sameRef(job,this.#read(job.id))&&job.status==='prepared','VERSION_CONFLICT','maintenance already dispatched or changed');
    const slot=maintenanceSlot(now,schedule.policy);
    ensure(slot.due&&slot.day===job.day&&now>=schedule.lastObservedAt&&canonical(schedule.policy)===canonical(job.policy),'MAINTENANCE_STALE','maintenance day or configuration changed');
    verifyMaintenancePacket(job.packet,job.policy);this.#checkMaintenanceGuards(job.packet);
    const {id,type,revision:ignored,...fields}=job;
    return this.#write(id,type,job.revision,{...fields,status:'dispatched',calls:1,claimId:c.claimId,recordedAt:now});
  }
  #captureMaintenance(c) {
    const job=this.#require(c.job,['maintenance_job']);ensure(sameRef(job,this.#read(job.id))&&job.status==='dispatched','VERSION_CONFLICT','maintenance no longer awaits this output');
    const raw=typeof c.output==='string'?c.output:canonical(c.output);ensure(Buffer.byteLength(raw)<=job.policy.maxOutputBytes,'MAINTENANCE_OVERFLOW','maintenance output exceeds bound');
    const {id,type,revision:ignored,...fields}=job;
    return this.#write(id,type,job.revision,{...fields,status:'proposed',output:raw,recordedAt:this.#now()});
  }
  #adoptMaintenance(c) {
    const job=this.#require(c.job,['maintenance_job']);ensure(sameRef(job,this.#read(job.id))&&job.status==='proposed','VERSION_CONFLICT','maintenance proposal changed');
    verifyMaintenancePacket(job.packet,job.policy);const schedule=this.#read(maintenanceScheduleId(job.subject));
    ensure(canonical(schedule.policy)===canonical(job.policy),'MAINTENANCE_STALE','maintenance disabled or reconfigured while reviewing');
    this.#checkMaintenanceGuards(job.packet);
    const {out,delta}=maintenanceOutput(job.output,job.packet,job.policy),p=job.packet.payload,at=this.#now(),applied=[];
    if(out.disposition==='update'){
      const subject=this.#read(job.subject),materials=[...p.materials,...p.sources],input={continuity:p.continuity,materials};
      const observationRefs=uniqueRefs(materials.filter(m=>m.record.type==='event').map(m=>m.ref));
      const {foreground,fields,attentionFrame}=this.#continuationPatch({subject,input,delta,at,observationRefs});
      for(const note of out.noteUpdates)applied.push(asRef(this.#note(note).record));
      for(const [i,link] of out.links.entries())applied.push(asRef(this.#link({id:`maintenance-link:${job.id}:${i}`,expectedRevision:0,from:link.from,to:link.to,relation:link.relation,strength:1,direction:'both',basis:[],status:'active'})));
      for(const o of out.observations)this.#db.prepare('UPDATE subject_inbox SET status=?,updated_at=? WHERE subject_id=? AND event_id=?').run(o.status,at,job.subject,o.ref.id);
      const {id,type,revision:ignored,...prior}=subject;
      this.#write(id,type,subject.revision,{...prior,foreground:[...foreground].sort().map(id=>asRef(this.#read(id))),changedStates:fields.map(f=>asRef(this.#read(f.id))),
        ...(attentionFrame?{attentionFrame:asRef(attentionFrame)}:{}),recordedAt:at});
      applied.push(...fields.map(f=>asRef(this.#read(f.id))));
    }
    // Presentation bookkeeping is not recall reinforcement, understanding, or a new personal experience.
    if(out.disposition!=='defer')for(const e of p.presentedEncounters)
      this.#db.prepare('INSERT OR IGNORE INTO maintenance_seen(subject_id,event_id,job_id,reviewed_at) VALUES(?,?,?,?)').run(job.subject,e.ref.id,job.id,at);
    const {id:sid,type:stype,revision:srev,...sfields}=schedule;
    this.#write(sid,stype,srev,{...sfields,cursors:p.cursors,nextLane:p.nextLane,lastObservedAt:Math.max(schedule.lastObservedAt,at),recordedAt:at});
    const {id,type,revision:ignored,...fields}=job;
    return this.#write(id,type,job.revision,{...fields,status:'adopted',disposition:out.disposition,requests:out.requests,appliedRefs:applied,recordedAt:at});
  }
  #finishMaintenance(c) {
    const job=this.#require(c.job,['maintenance_job']);ensure(sameRef(job,this.#read(job.id))&&['prepared','dispatched','proposed'].includes(job.status),'VERSION_CONFLICT','maintenance is already terminal');
    oneOf(c.status,['failed','uncertain','stale'],'maintenance failure');text(c.code,'maintenance failure code');
    const {id,type,revision:ignored,...fields}=job;return this.#write(id,type,job.revision,{...fields,status:c.status,error:{code:c.code},recordedAt:this.#now()});
  }
  #claimResponse(c) {
    const response=this.#require(c.response,['response']);text(c.claimId,'claim id');text(c.worker,'worker');
    ensure(this.#read(response.id).revision===response.revision,'VERSION_CONFLICT','response changed');
    ensure(response.status==='pending','RESPONSE_NOT_PENDING','never automatically resend claimed or uncertain responses');
    const {id,type,revision:oldRevision,...fields}=response;
    return this.#write(id,type,response.revision,{...fields,status:'dispatching',claimId:c.claimId,worker:c.worker,recordedAt:this.#now()});
  }
  #responseDelivery(c) {
    const response=this.#require(c.response,['response']);
    ensure(this.#read(response.id).revision===response.revision,'VERSION_CONFLICT','response changed');
    ensure(['dispatching','unknown'].includes(response.status)&&response.claimId===c.claimId,'RESPONSE_NOT_CLAIMED','matching response claim required');
    oneOf(c.outcome,['sent','failed','unknown'],'delivery outcome');
    const receipt=this.#event({id:c.eventId,body:c.body,origin:'tool_receipt',source:c.source,actor:c.actor,scene:response.scene,occurredAt:c.occurredAt});
    // 发送回执是事实记录，不是新的对话观察；入箱但立即 handled，避免叫醒她。
    this.#admitSubjectEvent({subjectId:response.subject,event:asRef(receipt)});
    this.#db.prepare("UPDATE subject_inbox SET status='handled',updated_at=? WHERE subject_id=? AND event_id=?").run(this.#now(),response.subject,receipt.id);
    const {id,type,revision:oldRevision,...fields}=response;
    return this.#write(id,type,response.revision,{...fields,status:c.outcome,receipts:[...response.receipts,asRef(receipt)],recordedAt:this.#now()});
  }
  #recoverResponse(c) {
    const response=this.#require(c.response,['response']);
    ensure(response.status==='dispatching','RESPONSE_NOT_IN_FLIGHT','recover only an interrupted delivery');
    return this.#responseDelivery({...c,outcome:'unknown'});
  }
  subjectObservation(subjectId,eventId) {
    const row=this.#db.prepare('SELECT seq,subject_id AS subjectId,event_id AS eventId,status,decision_id AS decisionId,updated_at AS updatedAt FROM subject_inbox WHERE subject_id=? AND event_id=?').get(subjectId,eventId);
    return row?{...row}:null;
  }
  subjectInbox({subjectId,afterSeq=0,limit=32,pendingOnly=true}) {
    const subject=this.#read(subjectId);ensure(subject?.type==='subject','MISSING_SUBJECT','unknown subject');
    ensure(Number.isSafeInteger(afterSeq)&&afterSeq>=0&&Number.isSafeInteger(limit)&&limit>0&&limit<=100&&typeof pendingOnly==='boolean','INVALID_INPUT','bounded inbox page required');
    return this.view(()=>{
      const filter=pendingOnly?" AND (status='received' OR (status='deferred' AND decision_id IN (SELECT id FROM objects WHERE type='decision')))":'',rows=this.#db.prepare(`SELECT seq,event_id AS eventId,status,decision_id AS decisionId FROM subject_inbox WHERE subject_id=? AND seq>?${filter} ORDER BY seq LIMIT ?`).all(subjectId,afterSeq,limit+1);
      const items=rows.slice(0,limit).map(row=>({...row}));
      const total=this.#db.prepare(`SELECT count(*) AS n FROM subject_inbox WHERE subject_id=?${filter}`).get(subjectId).n;
      return {items,total,next:rows.length>limit?items.at(-1).seq:null};
    });
  }
  roots(ref) {
    const record = this.#require(ref, ['event', 'note']);
    return record.type === 'event' ? [record.id] : record.rootIds;
  }
  basisChanged(ref, visited = new Set()) {
    const key = refKey(ref);
    if (visited.has(key)) return false;
    visited.add(key);
    const record = this.#require(ref);
    const refs = record.type === 'note' ? record.evidence : record.type === 'link' ? [record.from, record.to, ...record.basis] : [];
    return refs.some(r => this.#read(r.id).revision !== r.revision || this.basisChanged(r, visited));
  }
  uses(id) {
    ensure(this.#read(id), 'MISSING_REFERENCE', 'memory does not exist');
    return this.#db.prepare('SELECT encounter_id AS encounterId,revision,used_at AS at,reason FROM uses WHERE memory_id=? ORDER BY used_at,encounter_id').all(id).map(row => ({...row}));
  }
  list({type, after = '', limit = 50} = {}) {
    oneOf(type, TYPES, 'record type');
    ensure(Number.isSafeInteger(limit) && limit > 0 && limit <= 500, 'INVALID_INPUT', 'limit must be 1..500');
    const rows = this.#db.prepare('SELECT v.body FROM objects o JOIN versions v ON v.id=o.id AND v.revision=o.current_revision WHERE o.type=? AND o.id>? ORDER BY o.id LIMIT ?').all(type, after, limit + 1);
    const items = rows.slice(0, limit).map(row => this.#decode(row.body));
    return {items, next: rows.length > limit ? items.at(-1).id : null};
  }
  // Indexed, read-only lookups over current record versions (see versions_by_* in schema).
  // Each returns parsed records; "newest" ones are ordered newest first.
  #byIndex(sql,...args){return this.#db.prepare(`SELECT v.body FROM versions v CROSS JOIN objects o ON o.id=v.id AND o.current_revision=v.revision WHERE ${sql}`).all(...args).map(r=>this.#decode(r.body));}
  #bound(limit){ensure(Number.isSafeInteger(limit)&&limit>0&&limit<=1000,'INVALID_INPUT','limit must be 1..1000');return limit;}
  newestInScene({type,scene,limit=50,since=null}){text(type,'type');text(scene,'scene');
    return since===null?this.#byIndex(`o.type=? AND json_extract(v.body,'$.scene')=? ORDER BY coalesce(json_extract(v.body,'$.occurredAt'),json_extract(v.body,'$.recordedAt')) DESC LIMIT ?`,type,scene,this.#bound(limit))
      :this.#byIndex(`o.type=? AND json_extract(v.body,'$.scene')=? AND coalesce(json_extract(v.body,'$.occurredAt'),json_extract(v.body,'$.recordedAt'))>=? ORDER BY coalesce(json_extract(v.body,'$.occurredAt'),json_extract(v.body,'$.recordedAt')) DESC LIMIT ?`,type,scene,since,this.#bound(limit));}
  newestFromSender({senderId,limit=50}){text(senderId,'sender id');
    return this.#byIndex(`o.type='event' AND json_extract(v.body,'$.sender.id')=? ORDER BY coalesce(json_extract(v.body,'$.occurredAt'),json_extract(v.body,'$.recordedAt')) DESC LIMIT ?`,String(senderId),this.#bound(limit));}
  eventsInThread(threadId){text(threadId,'thread id');return this.#byIndex(`o.type='event' AND json_extract(v.body,'$.threadId')=? ORDER BY o.id`,threadId);}
  decisionsForEvent(eventId){text(eventId,'event id');return this.#byIndex(`o.type='decision' AND json_extract(v.body,'$.currentEvent.id')=? ORDER BY o.id`,eventId);}
  actionForReceipt(receiptId){text(receiptId,'receipt id');return this.#byIndex(`o.type='action' AND json_extract(v.body,'$.receipt.id')=? LIMIT 1`,receiptId)[0]??null;}
  extensionRecords({stateType,owner}){text(stateType,'state type');text(owner,'owner');
    return this.#byIndex(`o.type='extension_record' AND json_extract(v.body,'$.stateType')=? AND json_extract(v.body,'$.owner')=? ORDER BY o.id`,stateType,owner);}
  linksForProcess({owner,processId}){text(owner,'owner');text(processId,'process id');
    return this.#byIndex(`o.type='extension_record' AND json_extract(v.body,'$.value.processId')=? AND json_extract(v.body,'$.owner')=? ORDER BY o.id`,processId,owner);}
  countAdmittedEvents({subjectId,excludeOrigins=[]}){text(subjectId,'subject id');
    return this.#db.prepare(`SELECT count(*) AS n FROM subject_inbox i CROSS JOIN objects o ON o.id=i.event_id CROSS JOIN versions v ON v.id=o.id AND v.revision=o.current_revision
      WHERE i.subject_id=? AND o.type='event' AND json_extract(v.body,'$.origin') NOT IN (SELECT value FROM json_each(?))`).get(subjectId,JSON.stringify(excludeOrigins)).n;}
  queryPlan(sql){return this.#db.prepare('EXPLAIN QUERY PLAN '+sql).all().map(r=>r.detail);}
  *all(type) {
    let after = '';
    do { const page = this.list({type, after, limit: 500}); yield* page.items; after = page.next; } while (after !== null);
  }
  #recall({person=null,place=null,time=null,terms=null},limit,offset){
    const segments=scene=>String(scene??'').split(/[:/]+/).filter(Boolean);
    const under=(scene,prefix)=>{const a=segments(scene),b=segments(prefix);return b.length>0&&b.every((s,i)=>a[i]===s);};
    const records=[...this.all('event'),...this.all('note').filter(n=>n.status==='current')];
    const matches=[];
    for(const r of records){
      const body=String(r.body??'').toLocaleLowerCase('zh-CN');
      const hits=terms?terms.filter(t=>body.includes(t)):[];
      if(person){const ok=r.type==='event'?r.actor===person:(r.scope?.people??[]).includes(person);if(!ok)continue;}
      if(place){const scenes=r.type==='event'?[r.scene].filter(Boolean):(r.scope?.scenes??[]);if(!scenes.some(s=>under(s,place)))continue;}
      if(time){const ts=r.type==='event'?(r.occurredAt??r.recordedAt??0):(r.recordedAt??0);if(ts<time.from||ts>time.until)continue;}
      if(terms&&hits.length!==terms.length)continue;
      matches.push({ref:asRef(r),hits,score:hits.length,ts:r.type==='event'?(r.occurredAt??r.recordedAt??0):(r.recordedAt??0)});
    }
    matches.sort((a,b)=>b.score-a.score||b.ts-a.ts||a.ref.id.localeCompare(b.ref.id));
    return {items:matches.slice(offset,offset+limit).map(({ts,score,...hit})=>hit),total:matches.length,method:'recall-intersection'};
  }
  search(options) { return this.view(() => this.#search(options)); }
  #search({terms, types = ['event', 'note'], scene, origins, from, until, limit = 20, offset = 0, excludeRefs = [],contextAnchor}) {
    ensure(Array.isArray(terms) && terms.length > 0 && terms.length <= 16, 'INVALID_INPUT', 'supply 1..16 explicit terms');
    terms.forEach(term => text(term, 'term')); types.forEach(type => oneOf(type, ['event', 'note'], 'search type'));
    ensure(Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'INVALID_INPUT', 'invalid search limit');
    ensure(Number.isSafeInteger(offset)&&offset>=0&&offset<=1000000,'INVALID_INPUT','invalid search offset');
    if (from !== undefined) time(from); if (until !== undefined) time(until);
    if (origins !== undefined) ensure(Array.isArray(origins), 'INVALID_INPUT', 'origins must be an array');
    const excluded=new Set(uniqueRefs(excludeRefs).map(refKey));
    const contextRoots=new Set();
    if(contextAnchor){
      const anchor=this.#require(uniqueRefs([contextAnchor])[0],['event']);contextRoots.add(anchor.id);
      // Reuse existing, version-pinned action inputs -> actual receipt links.
      // Neither text similarity nor a model guess creates batch membership.
      for(const a of this.all('action'))if(a.inputRefs.some(r=>sameRef(r,contextAnchor))&&a.receipt)contextRoots.add(a.receipt.id);
    }
    // Exact substring baseline over all retained records; deliberately no claim of semantic recall.
    const normalized = [...new Set(terms.map(term => term.toLocaleLowerCase('zh-CN')))];
    const matches = [];
    // Substring prefilter inside SQLite: only records whose body contains a term are parsed.
    // Exact parity with the JS check needs SQLite's ASCII lower() to agree with JS lowercasing,
    // so terms with non-ASCII cased letters, and lineage (contextAnchor) searches, use the full scan.
    const caseSafe=normalized.every(t=>[...t].every(ch=>ch.charCodeAt(0)<128||ch.toLowerCase()===ch.toUpperCase()));
    const candidates=type=>!contextAnchor&&caseSafe
      ?this.#db.prepare(`SELECT v.body FROM objects o CROSS JOIN versions v ON v.id=o.id AND v.revision=o.current_revision WHERE o.type=? AND (${normalized.map(()=>"instr(lower(json_extract(v.body,'$.body')),?)>0").join(' OR ')})`).all(type,...normalized).map(r=>JSON.parse(r.body))
      :this.all(type);
    for (const type of [...new Set(types)]) for (const record of candidates(type)) {
      if(excluded.has(refKey(record)))continue;
      if (record.type === 'note' && record.status !== 'current') continue;
      if (scene && (record.type === 'event' ? record.scene !== scene : record.scope.scenes.length && !record.scope.scenes.includes(scene))) continue;
      if (origins && !origins.includes(record.origin)) continue;
      const timestamp = record.type === 'event' ? record.occurredAt ?? record.recordedAt : record.recordedAt;
      if (from !== undefined && timestamp < from || until !== undefined && timestamp >= until) continue;
      const body = record.body.toLocaleLowerCase('zh-CN');
      const hits = normalized.filter(term => body.includes(term));
      const contextMatch=contextAnchor&&(record.type==='event'?record.id!==contextAnchor.id&&contextRoots.has(record.id):record.rootIds.some(id=>contextRoots.has(id)));
      if (hits.length||contextMatch) matches.push({ref: asRef(record), hits, score: hits.length, basisChanged: this.basisChanged(asRef(record)),
        ...(contextAnchor?{contextMatch:contextMatch?'explicit-action-or-evidence-lineage':null}:{})});
    }
    matches.sort((a,b) => Number(Boolean(b.contextMatch))-Number(Boolean(a.contextMatch)) || b.score - a.score || (a.ref.id<b.ref.id?-1:a.ref.id>b.ref.id?1:0));
    return {items: matches.slice(offset, offset+limit), total: matches.length, method:contextAnchor?'explicit-context-then-substring':'exact-substring'};
  }
  activeAssociationEdges() {
    return this.view(() => [...this.all('link')].filter(link => link.status === 'active'
      && ['related', 'similar'].includes(link.relation) && !this.basisChanged(asRef(link))
      && [link.from, link.to].every(ref => {
        const record = this.#require(ref); return record.type === 'event' || record.status === 'current';
      })));
  }
  snapshot() {
    return this.view(() => ({schemaVersion: SCHEMA_VERSION, objects: TYPES.flatMap(type => [...this.all(type)]),
      operations: this.#db.prepare('SELECT request_id FROM operations ORDER BY request_id').all().map(row => row.request_id)}));
  }
}
