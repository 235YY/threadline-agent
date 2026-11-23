// Additional research slice; parent history and monetary ceiling remain authoritative.
export class SliceLedger {
 constructor(parent,{maxCalls=12,maxMicros=500000}={}){if(maxCalls!==12||maxMicros!==500000)throw Error('frozen slice limits');this.parent=parent;this.start=parent.data.requests.length;}
 get data(){return this.parent.data;}
 get rows(){return this.data.requests.slice(this.start);}
 get held(){return this.rows.reduce((n,r)=>n+(r.status==='released'?0:r.actualMicros??r.reserveMicros),0);}
 reserve(id,fp,amount){if(this.rows.length>=12||this.held+amount>500000)throw Object.assign(Error('12 requests / 0.5 yuan slice reached before send'),{code:'SLICE_LIMIT'});return this.parent.reserve(id,fp,amount);}
 dispatch(id){return this.parent.dispatch(id);}release(id){return this.parent.release(id);}settle(id,u){this.parent.settle(id,u);if(this.held>500000)throw Object.assign(Error('actual charge retained; slice overrun stops'),{code:'SLICE_OVERRUN'});}
 uncertain(id,c){return this.parent.uncertain(id,c);}find(id){return this.parent.find(id);}row(id){return this.parent.row(id);}save(){return this.parent.save();}
}
