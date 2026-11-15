import {resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
let transport;
async function load(){
 const name=process.env.JY_VIDEO_FETCH_MODULE;
 if(!name)throw Object.assign(new Error('Reviewed video fetch transport is not configured; inject fetchText/fetchImage or set JY_VIDEO_FETCH_MODULE'),{code:'TOOL_DEPENDENCY_MISSING',transportInvoked:false});
 if(!transport){const specifier=isAbsolute(name)||name.startsWith('.')?pathToFileURL(resolve(name)).href:name;transport=import(specifier).catch(error=>{transport=null;throw error;});}
 return transport;
}
export async function safeFetch(...args){const module=await load();if(typeof module.safeFetch!=='function')throw new Error('Video transport must export safeFetch');return module.safeFetch(...args);}
export async function safeFetchBuffer(...args){const module=await load();if(typeof module.safeFetchBuffer!=='function')throw new Error('Video transport must export safeFetchBuffer');return module.safeFetchBuffer(...args);}
