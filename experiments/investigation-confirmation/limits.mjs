// This is a bounded view of the one existing research ledger, not a new ledger.
import {ensure} from '../../src/contracts.mjs';
export class ConfirmationSlice {
  constructor(parent){this.parent=parent;this.start=parent.data.requests.length;}
  get data(){return this.parent.data;}
  get rows(){return this.parent.data.requests.slice(this.start);}
  get held(){return this.rows.reduce((n,r)=>n+(r.status==='released'?0:r.actualMicros??r.reserveMicros),0);}
  reserve(id,fingerprint,amount){ensure(this.rows.length<24,'SLICE_CALL_LIMIT','24 attempts reached; do not resend');ensure(this.held+amount<=750000,'SLICE_SPEND_LIMIT','cannot reserve inside explicit 0.75 yuan slice');return this.parent.reserve(id,fingerprint,amount);}
  dispatch(...args){return this.parent.dispatch(...args);}
  release(...args){return this.parent.release(...args);}
  settle(...args){this.parent.settle(...args);if(this.held>750000){this.data.halted='confirmation slice overrun; actual charge retained';this.parent.save();ensure(false,'SLICE_OVERRUN','actual charge retained; stop');}}
  uncertain(...args){return this.parent.uncertain(...args);}
  find(...args){return this.parent.find(...args);}
  row(...args){return this.parent.row(...args);}
  save(){return this.parent.save();}
}
