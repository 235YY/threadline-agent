import {readFileSync} from 'node:fs';
import {join} from 'node:path';
export function readAccount({home,uin}={}){
 if(!/^\d+$/.test(String(uin??'')))throw Object.assign(Error('explicit QQ_UIN required; no first-account fallback'),{code:'QQ_ACCOUNT_REQUIRED'});
 const config=JSON.parse(readFileSync(join(home,'config',`onebot_${uin}.json`),'utf8'));
 const http=config.networks?.httpServers?.[0],ws=config.networks?.wsServers?.[0];
 if(!http||!ws)throw Error('QQ_ENDPOINT_REQUIRED');
 for(const endpoint of [http,ws])if(!['127.0.0.1','localhost','::1'].includes(endpoint.host||'127.0.0.1'))throw Error('QQ_LOCAL_ENDPOINT_REQUIRED');
 return {uin:String(uin),http,ws,httpUrl:`http://${http.host||'127.0.0.1'}:${http.port||3000}`};
}
