/** Rebuild the installable pack from checked-in static artwork, with the real importer. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {readSkinPack,writeSkinPack,imageInfo,SKIN_PACK_LIMITS} from '../ui/atlas-skin-pack.mjs';
const base=resolve('skins/shanhezhi'),manifest=JSON.parse(await readFile(base+'/manifest.json','utf8'));
const files=await Promise.all(manifest.assets.map(async asset=>{
 const bytes=new Uint8Array(await readFile(resolve(base,asset.path)));
 return {...asset,...imageInfo(bytes,asset.mime),bytes};
}));
const bytes=await writeSkinPack({id:manifest.id,name:manifest.name,theme:manifest.theme,files});
const restored=await readSkinPack(bytes);
if(restored.id!==manifest.id||restored.files.length!==manifest.assets.length)throw Error('SHANHE_PACK_ROUNDTRIP_FAILED');
const output=resolve(process.argv[2]||'release/Atlas-ShanheZhi-1.1.0.zip');
await mkdir(dirname(output),{recursive:true});await writeFile(output,bytes);
console.log(JSON.stringify({output,id:restored.id,name:restored.name,assets:files.length,roles:Object.keys(restored.theme.assets).length,bytes:bytes.length,limit:SKIN_PACK_LIMITS.zip,pixels:files.reduce((n,f)=>n+f.width*f.height,0),sha256:createHash('sha256').update(bytes).digest('hex')},null,2));
