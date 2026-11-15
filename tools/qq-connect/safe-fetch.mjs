// 受限媒体获取：只允许公网 http(s)，每次重定向重新校验，限制大小与超时。
import dns from 'node:dns/promises';
import net from 'node:net';

const MAX=8*1024*1024;
function privateIp(ip){
  const v=String(ip??'').replace(/^\[|\]$/g,'');
  if(net.isIPv4(v)){
    const p=v.split('.').map(Number);
    return p[0]===10||p[0]===127||p[0]===0||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168)||(p[0]===100&&p[1]>=64&&p[1]<=127)||p[0]>=224;
  }
  if(net.isIPv6(v))return v==='::'||v==='::1'||/^f[cd]/i.test(v)||/^fe[89ab]/i.test(v)||v.startsWith('2001:db8');
  return true;
}
async function assertPublic(url){
  const u=new URL(String(url));
  if(!['http:','https:'].includes(u.protocol))throw new Error('MEDIA_URL_SCHEME');
  if(u.username||u.password)throw new Error('MEDIA_URL_CREDENTIALS');
  if(['localhost','localhost.localdomain'].includes(u.hostname)||u.hostname.endsWith('.local'))throw new Error('MEDIA_URL_PRIVATE');
  const addresses=net.isIP(u.hostname)?[{address:u.hostname}]:await dns.lookup(u.hostname,{all:true,verbatim:true});
  if(!addresses.length||addresses.some(x=>privateIp(x.address)))throw new Error('MEDIA_URL_PRIVATE');
  return u;
}
export async function safeFetchBuffer(url,{maxBytes=MAX,timeoutMs=15000,maxRedirects=3}={}){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX)throw new Error('MEDIA_MAX');
  let current=String(url);
  for(let redirect=0;redirect<=maxRedirects;redirect++){
    const u=await assertPublic(current);
    const r=await fetch(u,{redirect:'manual',signal:AbortSignal.timeout(timeoutMs),headers:{accept:'image/*'}});
    if([301,302,303,307,308].includes(r.status)){
      const next=r.headers.get('location');if(!next)throw new Error('MEDIA_REDIRECT');
      current=new URL(next,u).toString();continue;
    }
    if(!r.ok)throw new Error('MEDIA_HTTP_'+r.status);
    const reader=r.body?.getReader();if(!reader)throw new Error('MEDIA_BODY');
    const chunks=[];let total=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>maxBytes)throw new Error('MEDIA_TOO_LARGE');chunks.push(Buffer.from(value));}}
    finally{try{await reader.cancel();}catch{}}
    const mediaType=(r.headers.get('content-type')??'application/octet-stream').split(';')[0].trim().toLowerCase();
    return {bytes:Buffer.concat(chunks),mediaType,url:u.toString()};
  }
  throw new Error('MEDIA_REDIRECT_LIMIT');
}
