/** Image payloads belong to the envelope attachment area, never SQLite rows. */
import {sha256Hex} from './atlas-db-envelope.ts';
import {AtlasDbError,queryBound,runBound} from './atlas-db-runtime.ts';
import type {AtlasAssetRef} from './atlas-db-contract.ts';
import type {SqlSession} from './atlas-sql-session.ts';
export async function imageAsset(dataUrl:unknown):Promise<AtlasAssetRef>{
 if(typeof dataUrl!=='string'||dataUrl.length>8*1024*1024||!/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(dataUrl))
  throw new AtlasDbError('IMAGE_INVALID','底图需为不超过 8 MB 的 PNG、JPEG、WebP 或 GIF 数据',{});
 const mime=dataUrl.slice(5,dataUrl.indexOf(';')),payload=dataUrl.slice(dataUrl.indexOf(',')+1);
 const bytes=Uint8Array.from(atob(payload),c=>c.charCodeAt(0)),sha256=await sha256Hex(bytes);
 return {key:`map-image:${sha256}`,mime,sha256,storage_ref:dataUrl};
}
export function readSqlMapImage(session:SqlSession,mapId:unknown){
 const key=String(mapId??'world'),root=session.repo.internal.branchRow()?.root_map_id;
 const row=queryBound(session.repo.db,'SELECT background_asset_key FROM maps WHERE branch_id=? AND id=?',[session.branchId,key==='world'?String(root??''):key])[0];
 const atlas=session.chatMetadata.atlas as {database?:{assets?:AtlasAssetRef[]}}|undefined;
 const asset=atlas?.database?.assets?.find(asset=>asset.key===row?.background_asset_key);
 return {dataUrl:asset&&/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/.test(asset.storage_ref)?asset.storage_ref:null,assetKey:row?.background_asset_key??null,coreSaved:false};
}
export async function restoreMigrationImage(session:SqlSession,legacy:unknown){
 const raw=legacy as {world?:{mapImage?:unknown};atlas?:{world?:{mapImage?:unknown}};chatMetadata?:{atlas?:{world?:{mapImage?:unknown}}}};
 const url=raw?.world?.mapImage??raw?.atlas?.world?.mapImage??raw?.chatMetadata?.atlas?.world?.mapImage;
 if(url==null||url==='')return;
 const asset=await imageAsset(url),root=session.repo.internal.branchRow()?.root_map_id;
 if(!root)throw new AtlasDbError('IMAGE_MAP_MISSING','旧底图缺少可迁移的根地图；原档保留',{});
 runBound(session.repo.db,'UPDATE maps SET background_asset_key=? WHERE branch_id=? AND id=?',[asset.key,session.branchId,String(root)]);
 session.repo.internal.setMigrationAssets([asset]);
}
