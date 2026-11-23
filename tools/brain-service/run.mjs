// Thin executable entry: publish only when ready; clean only owned resources.
import {launchBrain} from './bootstrap.mjs';
const running=await launchBrain({dependencies:{onStopped:()=>process.exit(0)}});
console.log(JSON.stringify(running.summary));
const stop=async()=>{try{await running.stop();process.exit(0);}catch(error){console.error(error.code??'SHUTDOWN_FAILED');}};
process.on('SIGINT',stop);
process.on('SIGTERM',stop);
