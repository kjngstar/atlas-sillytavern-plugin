/** Build static artwork with the same ZIP writer and validator used by Atlas. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {readSkinPack,writeSkinPack,imageInfo,SKIN_PACK_LIMITS} from '../ui/atlas-skin-pack.mjs';

export async function buildArtworkSkin({directory,output}) {
  const base=resolve(directory);
  const manifest=JSON.parse(await readFile(resolve(base,'manifest.json'),'utf8'));
  const files=await Promise.all(manifest.assets.map(async asset=>{
    const bytes=new Uint8Array(await readFile(resolve(base,asset.path)));
    return {...asset,...imageInfo(bytes,asset.mime),bytes};
  }));
  const bytes=await writeSkinPack({id:manifest.id,name:manifest.name,theme:manifest.theme,files});
  const restored=await readSkinPack(bytes);
  if(restored.id!==manifest.id||restored.files.length!==files.length)throw Error('ARTWORK_PACK_ROUNDTRIP_FAILED');
  const path=resolve(output);
  await mkdir(dirname(path),{recursive:true});
  await writeFile(path,bytes);
  return {output:path,id:restored.id,name:restored.name,assets:files.length,
    roles:Object.keys(restored.theme.assets).length,bytes:bytes.length,limit:SKIN_PACK_LIMITS.zip,
    pixels:files.reduce((n,f)=>n+f.width*f.height,0),sha256:createHash('sha256').update(bytes).digest('hex')};
}
