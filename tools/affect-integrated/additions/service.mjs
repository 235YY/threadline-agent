import {createBrainService,startBrainService} from '../brain-service/server.mjs';
import {affectFactory} from './session.mjs';
import {ensure} from '../../src/contracts.mjs';

// No provider, credential loader, timer or QQ adapter is selected implicitly.
function configured({affect={},...options}={}){
 ensure(typeof options.decide==='function','AFFECT_DECIDER_REQUIRED','explicit model or offline fixture callback required');
 ensure(typeof options.storePath==='string'&&options.storePath!==':memory:','AFFECT_STORE_REQUIRED','explicit isolated persistent database required');
 ensure(options.sessionFactory===undefined,'AFFECT_SESSION_FIXED','use the integrated affect session');
 return {global:true,heartbeatMs:0,allowedActionTools:[],...options,sessionFactory:affectFactory(affect)};
}
export const createAffectBrain=options=>createBrainService(configured(options));
export const startAffectBrain=options=>startBrainService(configured(options));
