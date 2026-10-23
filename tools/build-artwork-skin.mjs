/** Build static artwork with the same ZIP writer and validator used by Atlas. */
import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
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
  const {stdout}=await promisify(execFile)(process.env.ATLAS_ARTWORK_PYTHON||'python3',[
    fileURLToPath(new URL('./artwork-image.py',import.meta.url)),'audit',base
  ],{maxBuffer:1024*1024});
  const pixelAudit=JSON.parse(stdout);
  if(!pixelAudit.ok)throw Error('ARTWORK_PIXEL_AUDIT_FAILED');
  for(const file of files){const audit=pixelAudit.images.find(image=>image.id===file.id);
    if(!audit||audit.width!==file.width||audit.height!==file.height||audit.sha256!==createHash('sha256').update(file.bytes).digest('hex'))throw Error('ARTWORK_CHANGED_DURING_BUILD');
  }
  const path=resolve(output);
  await mkdir(dirname(path),{recursive:true});
  const temporary=path+'.'+process.pid+'.'+createHash('sha256').update(String(Math.random())).digest('hex').slice(0,12)+'.tmp';
  try{await writeFile(temporary,bytes,{flag:'wx'});await rename(temporary,path);}finally{await rm(temporary,{force:true});}
  return {output:path,id:restored.id,name:restored.name,assets:files.length,
    roles:Object.keys(restored.theme.assets).length,bytes:bytes.length,limit:SKIN_PACK_LIMITS.zip,
    pixels:files.reduce((n,f)=>n+f.width*f.height,0),pixelAudit,sha256:createHash('sha256').update(bytes).digest('hex')};
}
