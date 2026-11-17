import {readFileSync,existsSync,openSync,closeSync,unlinkSync,mkdirSync} from 'node:fs';import {dirname} from 'node:path';import {writeLedgerAtomically} from './ledger-io.mjs';
// Execution identity and captured output only; no spending authority or aggregate reserves.
export class RequestJournal {
 constructor(file,{history}={}){this.path=file;this.lock=file+'.lock';mkdirSync(dirname(file),{recursive:true});this.fd=openSync(this.lock,'wx');try{this.data=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{format:'jingyang-request-journal-v1',requests:[]};if(this.data.format!=='jingyang-request-journal-v1'||!Array.isArray(this.data.requests))throw Error('REQUEST_JOURNAL_FORMAT');this.history=new Map((history?JSON.parse(readFileSync(history,'utf8')).requests:[]).map(r=>[r.id,r]));}catch(e){this.close();throw e;}}
 save(){writeLedgerAtomically(this.path,this.data);}
 tryFind(id){return this.data.requests.find(r=>r.id===id)??this.history.get(id)??null;}
 find(id){const r=this.data.requests.find(r=>r.id===id);if(!r)throw Error('REQUEST_NOT_REGISTERED');return r;}
 reserve(id,fingerprint){if(this.tryFind(id))throw Object.assign(Error('request already attempted; no automatic resend'),{code:'ALREADY_REQUESTED',transportInvoked:false});this.data.requests.push({id,fingerprint,status:'reserved',recordedAt:Date.now()});this.save();}
 dispatch(id){const r=this.find(id);if(r.status!=='reserved')throw Error('REQUEST_STATE');r.status='dispatched';this.save();}
 release(id){const r=this.find(id);if(r.status!=='reserved')throw Error('REQUEST_STATE');r.status='released';this.save();}
 settle(id,usage){const r=this.find(id);if(r.status!=='dispatched')throw Error('REQUEST_STATE');r.status='settled';r.usage=usage;r.actualMicros=usage.upperMicros;r.accountingMeaning='legacy compatibility field is token-rate estimate, NOT official deduction or budget authority';this.save();}
 uncertain(id,error){const r=this.find(id);if(r.status!=='dispatched')throw Error('REQUEST_STATE');r.status='uncertain';r.error=error;this.save();}
 attachOutput(id,output){this.find(id).output=output;this.save();}
 attachProviderResult(id,response){this.find(id).providerResult={complete:response.complete===true,finishReason:response.finishReason,output:response.output,providerResponseId:response.providerResponseId};this.save();}
 state(){return {source:'request-identity-journal; official page controls spending',calls:this.data.requests.length,uncertain:this.data.requests.filter(r=>r.status==='uncertain').length,halted:null};}
 refreshDay(){}
 close(){if(this.fd===undefined)return;closeSync(this.fd);this.fd=undefined;unlinkSync(this.lock);}
}
