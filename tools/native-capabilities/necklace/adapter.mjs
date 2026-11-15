import {resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
let implementation;
async function load(){
 const configured=process.env.NECKLACE_ADAPTER_MODULE;
 if(!configured)throw Object.assign(new Error('Optional possession adapter is not configured'),{code:'TOOL_DEPENDENCY_MISSING',transportInvoked:false});
 if(!implementation){
  const specifier=isAbsolute(configured)||configured.startsWith('.')?pathToFileURL(resolve(configured)).href:configured;
  implementation=import(specifier).then(module=>{if(typeof module.runNecklace!=='function')throw Object.assign(new Error('Adapter must export runNecklace'),{code:'TOOL_DEPENDENCY_MISSING',transportInvoked:false});return module;}).catch(error=>{implementation=null;throw error;});
 }
 return implementation;
}
export async function runNecklace(input={}){
 if(!process.env.NECKLACE_ADAPTER_MODULE&&(input.action??'status')==='status')return {available:false,configured:false,reason:'optional private possession extension is not distributed'};
 return (await load()).runNecklace(input);
}
export function necklaceContext(){return '';}
