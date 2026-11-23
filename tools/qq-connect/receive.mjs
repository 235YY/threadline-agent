import fs from 'node:fs';
import path from 'node:path';
import {writeLedgerAtomically} from '../../src/ledger-io.mjs';
import {isClosedRejection} from '../../src/processing-outcome.mjs';

const fail=(code,message)=>Object.assign(new Error(message),{code});
const chatKey=c=>`${c.kind}:${c.id}`;
const eventChat=e=>e.message_type==='private'?{kind:'private',id:String(e.user_id)}:{kind:'group',id:String(e.group_id)};
const validId=id=>typeof id==='string'&&/^-?\d+$/.test(id)||Number.isSafeInteger(id);

// Transport facts only. Neither a reply nor a cognitive choice is required.
// One connector is the writer, as enforced by the production process launcher.
export class MessageReceiver {
  constructor({stateFile,selfId,since=Date.now(),now=Date.now,save=writeLedgerAtomically,diagnose=()=>{}}){
    if(!stateFile||!validId(selfId)||!Number.isSafeInteger(since)||since<0)throw fail('RECEIVE_CONFIG','valid state, account and history floor required');
    Object.assign(this,{stateFile,selfId:String(selfId),now,save,diagnose,poisoned:false});
    fs.mkdirSync(path.dirname(stateFile),{recursive:true});
    if(fs.existsSync(stateFile+'.new'))throw fail('RECEIVE_RECOVERY_REQUIRED','unreviewed receive-state candidate exists');
    this.data=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{format:'qq-receive-v1',selfId:this.selfId,since,chats:{},counters:{push:0,history:0,duplicate:0}};
    const d=this.data;
    if(d.format!=='qq-receive-v1'||d.selfId!==this.selfId||!Number.isSafeInteger(d.since)||d.since<0||!d.chats||!d.counters)throw fail('RECEIVE_STATE_INVALID','receive state belongs to another account or format');
    for(const [key,c] of Object.entries(d.chats)){
      if(!/^(private|group):-?\d+$/.test(key)||!Number.isSafeInteger(c.through)||c.through<d.since||!Array.isArray(c.messages)||c.messages.some(r=>!validId(r.id)||!Number.isSafeInteger(r.at)||!['started','completed','unconfirmed'].includes(r.status)))throw fail('RECEIVE_STATE_INVALID','invalid persisted message identity');
    }
    if(!fs.existsSync(stateFile))this.persist();
  }
  persist(){
    if(this.poisoned)throw fail('RECEIVE_STATE_UNAVAILABLE','receive persistence failed; no further delivery');
    try{this.save(this.stateFile,this.data);}catch(error){this.poisoned=true;throw error;}
  }
  chat(c){const key=chatKey(c);return this.data.chats[key]??=( {through:this.data.since,messages:[]} );}
  async accept(event,{source='push',deliver}={}){
    if(this.poisoned)throw fail('RECEIVE_STATE_UNAVAILABLE','receive persistence failed; no further delivery');
    if(!event||!['private','group'].includes(event.message_type)||event.post_type==='message_sent'||String(event.user_id)===this.selfId)return {ignored:true};
    if(!validId(event.message_id)||!validId(event.user_id)||event.message_type==='group'&&!validId(event.group_id)||!Number.isSafeInteger(event.time)||event.time<=0||!Array.isArray(event.message))throw fail('RECEIVE_EVENT_INVALID','message identity, time and array body required');
    const at=event.time*1000;
    if(at>this.now()+30000)throw fail('RECEIVE_EVENT_INVALID','message time is ahead of local clock');
    const c=this.chat(eventChat(event)),id=String(event.message_id);
    const existing=c.messages.find(r=>r.id===id);
    if(existing){this.data.counters.duplicate++;return {duplicate:true,status:existing.status};}
    if(at<this.data.since||at<c.through-5000)return {ignored:true,reason:'before-receive-window'};
    if(c.messages.length>=1024)throw fail('RECEIVE_BACKLOG_LIMIT','receive identity window requires a complete history scan');
    const row={id,at,status:'started',source};c.messages.push(row);this.persist();
    this.diagnose('receive-start',{chat:chatKey(eventChat(event)),id,source});
    try{
      const result=await deliver(event);
      if(result?.ok===false&&!isClosedRejection(result.processingOutcome))throw fail('RECEIVE_DELIVERY_FAILED','brain did not confirm a terminal processing result');
      if(isClosedRejection(result?.processingOutcome))row.processingOutcome=result.processingOutcome;
      row.status='completed';row.completedAt=this.now();
      this.data.counters[source==='history'?'history':'push']++;this.persist();
      this.diagnose('receive-complete',{chat:chatKey(eventChat(event)),id,source});
      return {accepted:true,result};
    }catch(error){
      row.status='unconfirmed';row.error=String(error.code??error.name??'DELIVERY_FAILED');
      if(!this.poisoned){try{this.persist();}catch{}}
      this.diagnose('receive-unconfirmed',{chat:chatKey(eventChat(event)),id,error:row.error});
      throw error;
    }
  }
  async reconcile(chat,{fetchHistory,enqueue,limit=50}={}){
    if(this.poisoned)throw fail('RECEIVE_STATE_UNAVAILABLE','receive persistence failed; no further delivery');
    const startedAt=this.now(),c=this.chat(chat),response=await fetchHistory(chat,limit);
    if(!Array.isArray(response)||response.length>limit)throw fail('RECEIVE_HISTORY_INVALID','bounded history array required');
    if(response.some(e=>e.message_type&&e.message_type!==chat.kind||chat.kind==='group'&&e.group_id!==undefined&&String(e.group_id)!==chat.id))throw fail('RECEIVE_HISTORY_INVALID','history conversation identity disagrees with request');
    const rows=response.map(e=>({...e,post_type:e.post_type??'message',message_type:e.message_type??chat.kind,...(chat.kind==='group'&&e.group_id===undefined?{group_id:chat.id}:{})}));
    if(rows.some(e=>!Number.isSafeInteger(e.time)||e.time<=0||e.time*1000>this.now()+30000||!validId(e.message_id)||chat.kind==='private'&&String(e.user_id)!==chat.id&&String(e.user_id)!==this.selfId||chat.kind==='group'&&String(e.group_id)!==chat.id))throw fail('RECEIVE_HISTORY_INVALID','history does not belong to requested conversation');
    if(rows.length===limit&&Math.min(...rows.map(e=>e.time*1000))>c.through){
      this.diagnose('receive-history-gap',{chat:chatKey(chat),limit,through:c.through});
      throw fail('RECEIVE_HISTORY_GAP','history window does not reach receive cursor; do not silently skip messages');
    }
    let recovered=0;
    for(const e of rows.sort((a,b)=>a.time-b.time)){
      if(String(e.user_id)===this.selfId||e.post_type==='message_sent'||e.time*1000<c.through-5000)continue;
      const result=await enqueue(e,'history');if(result?.accepted)recovered++;
    }
    // A successful HTTP read does not prove history has caught up to wall time.
    // Advance only to a timestamp actually observed in this bounded history.
    c.through=Math.max(c.through,...rows.map(e=>Math.min(startedAt,e.time*1000)));
    c.messages=c.messages.filter(r=>r.status!=='completed'||r.at>=c.through-5000);
    c.checkedAt=this.now();this.persist();return {recovered,through:c.through};
  }
}
