/** Host-owned IndexedDB. Skin bytes never enter the world database. */
export const SKIN_STORAGE_LIMITS=Object.freeze({packs:24,bytes:64*1024*1024});
const failure=(code,cause)=>Object.assign(Error(code),{code,cause});
export function createSkinStorage({indexedDB=globalThis.indexedDB,name='atlas-ui-skins-v1'}={}){
 let opening=null,db=null,disposed=false;
 async function open(){
  if(disposed)throw failure('SKIN_STORAGE_DISPOSED');
  if(!indexedDB)throw failure('SKIN_STORAGE_UNAVAILABLE');
  if(!opening)opening=new Promise((resolve,reject)=>{
   let refused=false,request;
   try{request=indexedDB.open(name,1);}catch(error){reject(failure('SKIN_STORAGE_UNAVAILABLE',error));return;}
   request.onupgradeneeded=()=>{const database=request.result;const store=database.createObjectStore('packs',{keyPath:'key'});store.createIndex('owner','owner',{unique:false});};
   request.onerror=()=>reject(failure('SKIN_STORAGE_UNAVAILABLE',request.error));
   request.onblocked=()=>{refused=true;reject(failure('SKIN_STORAGE_BLOCKED'));};
   request.onsuccess=()=>{if(disposed||refused){request.result.close();reject(failure('SKIN_STORAGE_DISPOSED'));return;}db=request.result;db.onversionchange=()=>{db.close();db=null;opening=null;};resolve(db);};
  }).catch(error=>{opening=null;throw error;});
  return opening;
 }
 const ownerKey=owner=>{if(typeof owner!=='string'||!/^[-a-zA-Z0-9]{1,100}$/.test(owner))throw failure('SKIN_STORAGE_OWNER_INVALID');return owner;};
 async function run(owner,mode,fn){
  ownerKey(owner);const database=await open();if(disposed)throw failure('SKIN_STORAGE_DISPOSED');
  return new Promise((resolve,reject)=>{
   const tx=database.transaction('packs',mode),store=tx.objectStore('packs');let value,error;
   const abort=e=>{error=e;try{tx.abort();}catch(_){};};
   tx.oncomplete=()=>resolve(value);tx.onerror=tx.onabort=()=>reject(error||failure(tx.error?.name==='QuotaExceededError'?'SKIN_STORAGE_QUOTA':'SKIN_STORAGE_FAILED',tx.error));
   try{fn(store,v=>{value=v;},abort);}catch(e){abort(e);}
  });
 }
 return {
  async list(owner){return run(owner,'readonly',(store,done,abort)=>{const result=[];const request=store.index('owner').openCursor(owner);request.onerror=()=>abort(failure('SKIN_STORAGE_READ_FAILED',request.error));request.onsuccess=()=>{try{const cursor=request.result;if(!cursor){done(result);return;}const {id,name,size,updatedAt}=cursor.value;result.push({id,name,size,updatedAt});cursor.continue();}catch(error){abort(error);}};});},
  async get(owner,id){return run(owner,'readonly',(store,done,abort)=>{const request=store.get(owner+'\0'+id);request.onsuccess=()=>done(request.result?.pack??null);request.onerror=()=>abort(failure('SKIN_STORAGE_READ_FAILED',request.error));});},
  async put(owner,pack){
   const size=(pack.files||[]).reduce((n,f)=>n+(f.bytes?.byteLength??0),0);if(size>SKIN_STORAGE_LIMITS.bytes)throw failure('SKIN_STORAGE_QUOTA');
   return run(owner,'readwrite',(store,done,abort)=>{
    let count=0,bytes=0;const request=store.index('owner').openCursor(owner);
    request.onsuccess=()=>{try{const cursor=request.result;if(cursor){if(cursor.value.id!==pack.id){count++;bytes+=cursor.value.size;}cursor.continue();return;}if(count>=SKIN_STORAGE_LIMITS.packs||bytes+size>SKIN_STORAGE_LIMITS.bytes){abort(failure('SKIN_STORAGE_QUOTA'));return;}store.put({key:owner+'\0'+pack.id,owner,id:pack.id,name:pack.name||pack.id,size,updatedAt:Date.now(),pack});done(true);}catch(error){abort(error);}};request.onerror=()=>abort(request.error);
   });
  },
  async remove(owner,id){return run(owner,'readwrite',(store,done)=>{store.delete(owner+'\0'+id);done(true);});},
  dispose(){disposed=true;db?.close();db=null;}
 };
}
