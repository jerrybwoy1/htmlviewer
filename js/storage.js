const DB_NAME='debooger2000-project-history-v1';
const STORE='snapshots';

function openDb(){
  return new Promise((resolve,reject)=>{
    if(!('indexedDB' in globalThis)){reject(new Error('IndexedDB unavailable'));return}
    const req=indexedDB.open(DB_NAME,1);
    req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'id'})};
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error||new Error('Could not open saved-project storage'));
  });
}
async function withStore(mode,fn){
  const db=await openDb();
  try{
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,mode),store=tx.objectStore(STORE);
      let result;
      try{result=fn(store)}catch(e){reject(e);return}
      tx.oncomplete=()=>resolve(result);
      tx.onerror=()=>reject(tx.error||new Error('Saved-project storage failed'));
      tx.onabort=()=>reject(tx.error||new Error('Saved-project storage stopped'));
    });
  }finally{db.close()}
}

export const Storage={
  key:'debooger2000:state:v2',
  legacyKey:'debooger2000:state:v1',
  sessionKey:'debooger2000:providers:session:v1',
  load(){
    try{
      const current=localStorage.getItem(this.key);
      if(current)return JSON.parse(current);
      const legacy=localStorage.getItem(this.legacyKey);
      if(legacy){const parsed=JSON.parse(legacy);this.save(parsed);return parsed}
      return{};
    }catch{return{}}
  },
  save(next){localStorage.setItem(this.key,JSON.stringify(next));return next},
  history(){return this.load().history||[]},
  pushAudit(audit){
    const s=this.load();
    const history=[audit,...(s.history||[]).filter(x=>x.id!==audit.id)].slice(0,12);
    this.save({...s,history});
    return history;
  },
  async saveSnapshot(audit,files){
    if(!audit?.id||!files?.size||!globalThis.JSZip)return false;
    try{
      const zip=new JSZip();
      for(const [name,file] of files)zip.file(name,file);
      const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:3}});
      const safe=(audit.meta?.projectLabel||'project').replace(/[^a-z0-9._-]+/gi,'-').replace(/^-+|-+$/g,'').slice(0,80)||'project';
      const name=`${safe}-audit-${new Date(audit.createdAt).toISOString().replace(/[:.]/g,'-')}.zip`;
      await withStore('readwrite',store=>store.put({id:audit.id,name,createdAt:audit.createdAt,blob}));
      audit.snapshotId=audit.id;
      audit.snapshotName=name;
      audit.snapshotBytes=blob.size;
      return true;
    }catch(e){
      audit.snapshotError=String(e?.message||e);
      return false;
    }
  },
  async getSnapshot(id){
    if(!id)return null;
    try{
      const db=await openDb();
      return await new Promise((resolve,reject)=>{
        const tx=db.transaction(STORE,'readonly'),req=tx.objectStore(STORE).get(id);
        req.onsuccess=()=>resolve(req.result||null);
        req.onerror=()=>reject(req.error);
        tx.oncomplete=()=>db.close();
      });
    }catch{return null}
  },
  async pruneSnapshots(keepIds=[]){
    try{
      const keep=new Set(keepIds.filter(Boolean));
      const db=await openDb();
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE),req=store.openCursor();
        req.onsuccess=()=>{const c=req.result;if(!c)return;if(!keep.has(c.key))c.delete();c.continue()};
        req.onerror=()=>reject(req.error);
        tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
      });
      db.close();
    }catch{}
  },
  providerSettings(){const saved=this.load().providers||{groq:{enabled:false},google:{enabled:false}};let session={};try{session=JSON.parse(sessionStorage.getItem(this.sessionKey)||'{}')}catch{}return{groq:{enabled:!!saved.groq?.enabled,key:session.groq?.key||''},google:{enabled:!!saved.google?.enabled,key:session.google?.key||''}}},
  saveProviders(providers){const s=this.load();this.save({...s,providers:{groq:{enabled:!!providers.groq?.enabled},google:{enabled:!!providers.google?.enabled}}});sessionStorage.setItem(this.sessionKey,JSON.stringify({groq:{key:providers.groq?.key||''},google:{key:providers.google?.key||''}}))},
  clearProviderKeys(){sessionStorage.removeItem(this.sessionKey)}
};
