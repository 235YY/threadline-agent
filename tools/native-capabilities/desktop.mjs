// Optional integration supplied by the operator; no machine-specific default.
import {isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function runDesktop(input={}){
 const path=process.env.THREADLINE_DESKTOP_ADAPTER;
 if(!path){
  if((input.action??'status')==='status')return {available:false,configured:false};
  throw Object.assign(Error('Desktop adapter is not configured'),{code:'TOOL_DEPENDENCY_MISSING',transportInvoked:false});
 }
 const m=await import(isAbsolute(path)||path.startsWith('.')?pathToFileURL(resolve(path)).href:path);
 if(typeof m.runDesktop!=='function')throw Object.assign(Error('Adapter must export runDesktop'),{code:'TOOL_DEPENDENCY_MISSING',transportInvoked:false});
 return m.runDesktop(input);
}
