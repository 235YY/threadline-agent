// Read-only diagnostic: enumerate QQ PIDs via the installed public native entry point.
import {Worker} from 'node:worker_threads';
import {resolve} from 'node:path';
import {readdir} from 'node:fs/promises';
const path=resolve('../SnowLuma/dist/native/snowluma-win32-x64.node'),m={exports:{}};
process.dlopen(m,path);const main=m.exports.getAllMainProcess();
const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');try{const m={exports:{}};process.dlopen(m,workerData);parentPort.postMessage({pids:m.exports.getAllMainProcess()});}catch(e){parentPort.postMessage({error:e.message});}`,{eval:true,workerData:path});
const result=await new Promise((res,rej)=>{const timer=setTimeout(()=>{worker.terminate();rej(Error('enumeration timed out'));},8000);worker.once('message',r=>{clearTimeout(timer);res(r);});worker.once('error',rej);});
await worker.terminate();
const pipes=await Promise.race([readdir('\\\\.\\pipe\\').then(names=>({count:names.length,hookPipes:names.filter(n=>/^mojo\.\d+\.control$/i.test(n))})).catch(e=>({error:e.code})),new Promise(r=>setTimeout(()=>r({timeout:true}),4000))]);
console.log(JSON.stringify({main,worker:result,pipes}));process.exit(0);
