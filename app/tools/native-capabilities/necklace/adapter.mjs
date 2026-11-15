// 原生项链：只复用旧模块的状态机/相册/信箱；不接旧 DSH token。
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Necklace} from './necklace.js';

const here=fileURLToPath(new URL('.',import.meta.url));
const defaultData=process.env.AGENT_DATA?resolve(process.env.AGENT_DATA,'necklace'):resolve(here,'../../../data/necklace');
const dataDir=process.env.NECKLACE_DIR??defaultData;
const file=resolve(dataDir,'necklace.json');
const memory={enabled:false,store:{data:{self:{entries:[]}}}};
const necklace=new Necklace({file,ownerKey:process.env.NECKLACE_OWNER_KEY??'owner',memory,experiences:{},journal:{},canReadMemory:()=>false});

export async function runNecklace(input={}){
  return necklace.request({...input,action:input.action??'status'},{actor:'agent'});
}
export function necklaceContext(){try{return necklace.context();}catch{return '';}}