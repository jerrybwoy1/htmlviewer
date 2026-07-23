export const Storage={
  key:'debooger2000:state:v1',
  load(){try{return JSON.parse(localStorage.getItem(this.key)||'{}')}catch{return{}}},
  save(next){localStorage.setItem(this.key,JSON.stringify(next));return next},
  history(){return this.load().history||[]},
  pushAudit(audit){const s=this.load();const history=[audit,...(s.history||[])].slice(0,12);this.save({...s,history});return history},
  providerSettings(){return this.load().providers||{groq:{enabled:false,key:''},google:{enabled:false,key:''}}},
  saveProviders(providers){const s=this.load();this.save({...s,providers})}
};
