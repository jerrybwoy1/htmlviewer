export const Storage={
  key:'debooger2000:state:v1',
  sessionKey:'debooger2000:providers:session:v1',
  load(){try{return JSON.parse(localStorage.getItem(this.key)||'{}')}catch{return{}}},
  save(next){localStorage.setItem(this.key,JSON.stringify(next));return next},
  history(){return this.load().history||[]},
  pushAudit(audit){const s=this.load();const history=[audit,...(s.history||[])].slice(0,12);this.save({...s,history});return history},
  providerSettings(){const saved=this.load().providers||{groq:{enabled:false},google:{enabled:false}};let session={};try{session=JSON.parse(sessionStorage.getItem(this.sessionKey)||'{}')}catch{}return{groq:{enabled:!!saved.groq?.enabled,key:session.groq?.key||''},google:{enabled:!!saved.google?.enabled,key:session.google?.key||''}}},
  saveProviders(providers){const s=this.load();this.save({...s,providers:{groq:{enabled:!!providers.groq?.enabled},google:{enabled:!!providers.google?.enabled}}});sessionStorage.setItem(this.sessionKey,JSON.stringify({groq:{key:providers.groq?.key||''},google:{key:providers.google?.key||''}}))},
  clearProviderKeys(){sessionStorage.removeItem(this.sessionKey)}
};