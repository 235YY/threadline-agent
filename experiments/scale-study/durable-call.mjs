import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {canonical,ensure} from '../../src/contracts.mjs';

export async function durableCall({directory,id,wire,client,ledger}) {
  mkdirSync(directory,{recursive:true});
  const input=join(directory,'wire.json'), raw=join(directory,'response.json');
  if(existsSync(input))ensure(canonical(JSON.parse(readFileSync(input,'utf8')))===canonical(wire),'SAVED_PACKET_CHANGED','do not reissue changed input');
  else writeFileSync(input,JSON.stringify(wire,null,2)+'\n',{flag:'wx'});
  const prior=ledger.data.requests.find(r=>r.id===id);let response;
  if(existsSync(raw)) {
    ensure(prior?.status==='settled','PAID_RESPONSE_MISSING','response has no settled request');response=JSON.parse(readFileSync(raw,'utf8'));
  } else {
    ensure(!prior,'PAID_RESPONSE_MISSING','request exists without saved response; never resend');
    response=await client.call({id,packet:wire});writeFileSync(raw,JSON.stringify(response,null,2)+'\n',{flag:'wx'});
  }
  ensure(response.id===id&&response.packetId===wire.packetId,'SAVED_PACKET_CHANGED','response identity changed');
  ensure(response.model==='deepseek-flash','STUDY_MODEL_CHANGED','model identifier changed');
  ensure(response.complete,'STUDY_INCOMPLETE','incomplete output is not retried');
  return response;
}
