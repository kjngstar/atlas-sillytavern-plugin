/** Serial decode and idempotent resource disposal, shared across asset roles. */
export function createSkinAssetLoader({urlApi=globalThis.URL,decode=blob=>createImageBitmap(blob)}={}){
 let queue=Promise.resolve();
 function prepare(pack,skin,{signal}={}){
  const pending=queue.then(async()=>{
   const byId=new Map(),resources={};let released=false;
   const release=()=>{if(released)return;released=true;for(const asset of byId.values()){try{asset.bitmap?.close?.();}catch(_){}try{urlApi.revokeObjectURL(asset.url);}catch(_){}}byId.clear();};
   const check=()=>{if(signal?.aborted)throw Object.assign(Error('SKIN_ASSET_ABORTED'),{code:'SKIN_ASSET_ABORTED'});};
   try{
    for(const [role,id]of Object.entries(skin.assets||{})){
     check();let asset=byId.get(id);
     if(!asset){
      const file=pack?.files?.find(f=>f.id===id);if(!file)throw Error('SKIN_ASSET_MISSING');
      const blob=new Blob([file.bytes],{type:file.mime});asset={url:urlApi.createObjectURL(blob),bitmap:null};byId.set(id,asset);
      asset.bitmap=await decode(blob);check();
      if(asset.bitmap.width!==file.width||asset.bitmap.height!==file.height)throw Error('SKIN_IMAGE_DIMENSION_MISMATCH');
     }
     resources[role]=asset;
    }
    check();return {resources,release};
   }catch(error){release();if(error.code==='SKIN_ASSET_ABORTED')throw error;throw Object.assign(Error('SKIN_IMAGE_DECODE_FAILED'),{code:'SKIN_IMAGE_DECODE_FAILED',cause:error});}
  });
  queue=pending.catch(()=>{});return pending;
 }
 return {prepare};
}
