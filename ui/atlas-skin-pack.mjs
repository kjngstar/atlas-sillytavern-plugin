/** Static skin packages only; reject executable, remote and unbounded resources. */
export const SKIN_PACK_LIMITS=Object.freeze({zip:8*1024*1024,total:32*1024*1024,resource:8*1024*1024,manifest:64*1024,entries:96,side:2048,pixels:8388608});
const fail=code=>{throw Object.assign(Error(code),{code});};
const ascii=new TextDecoder('utf-8',{fatal:true}),encoder=new TextEncoder();
const own=(v,k)=>Object.prototype.hasOwnProperty.call(v,k);
function fields(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('SKIN_PACK_FIELD_INVALID');}
function bytesOf(v){if(Object.prototype.toString.call(v)==='[object ArrayBuffer]')return new Uint8Array(v);if(ArrayBuffer.isView(v))return new Uint8Array(v.buffer,v.byteOffset,v.byteLength);fail('SKIN_PACK_BYTES_INVALID');}
function pathAllowed(path){return path==='manifest.json'||/^assets\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(png|webp)$/.test(path);}
function extraCheck(view,start,length){for(let p=start;p<start+length;){if(p+4>start+length)fail('SKIN_ZIP_INVALID');const id=view.getUint16(p,true),n=view.getUint16(p+2,true);if(id===1||id===0x7075)fail('SKIN_ZIP_EXTRA_UNSUPPORTED');p+=4+n;if(p>start+length)fail('SKIN_ZIP_INVALID');}}
export function preflightZip(input){
 const bytes=bytesOf(input),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),n=bytes.length;
 if(n>SKIN_PACK_LIMITS.zip)fail('SKIN_ZIP_TOO_LARGE');if(n<22)fail('SKIN_ZIP_INVALID');
 let end=-1;for(let p=n-22;p>=Math.max(0,n-65557);p--)if(view.getUint32(p,true)===0x06054b50&&p+22+view.getUint16(p+20,true)===n){end=p;break;}
 if(end<0)fail('SKIN_ZIP_INVALID');
 const count=view.getUint16(end+10,true),size=view.getUint32(end+12,true),start=view.getUint32(end+16,true);
 if(view.getUint16(end+4,true)||view.getUint16(end+6,true)||view.getUint16(end+8,true)!==count||count===65535||size===0xffffffff||start+size!==end)fail('SKIN_ZIP_UNSUPPORTED');
 if(!count||count>SKIN_PACK_LIMITS.entries)fail('SKIN_PACK_ENTRY_LIMIT');
 const entries=[],paths=new Set(),ranges=[];let p=start,total=0;
 for(let i=0;i<count;i++){
  if(p+46>end||view.getUint32(p,true)!==0x02014b50)fail('SKIN_ZIP_INVALID');
  const flags=view.getUint16(p+8,true),method=view.getUint16(p+10,true),compressed=view.getUint32(p+20,true),size=view.getUint32(p+24,true),nl=view.getUint16(p+28,true),el=view.getUint16(p+30,true),cl=view.getUint16(p+32,true),local=view.getUint32(p+42,true);
  if(p+46+nl+el+cl>end||view.getUint16(p+34,true)!==0||(flags&~0x808)||![0,8].includes(method)||compressed===0xffffffff||size===0xffffffff||local===0xffffffff)fail('SKIN_ZIP_UNSUPPORTED');
  const path=ascii.decode(bytes.subarray(p+46,p+46+nl)),directory=path.endsWith('/');
  if(directory?!/^assets\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*$/.test(path):!pathAllowed(path))fail('SKIN_PACK_PATH_INVALID');
  if(paths.has(path))fail('SKIN_PACK_DUPLICATE_PATH');paths.add(path);
  const unix=(view.getUint32(p+38,true)>>>16)&0xf000;if(unix&&unix!==0x8000&&unix!==0x4000)fail('SKIN_ZIP_LINK_REJECTED');
  extraCheck(view,p+46+nl,el);
  if(local+30>start||view.getUint32(local,true)!==0x04034b50||view.getUint16(local+6,true)!==flags||view.getUint16(local+8,true)!==method)fail('SKIN_ZIP_INVALID');
  const ln=view.getUint16(local+26,true),le=view.getUint16(local+28,true),data=local+30+ln+le;
  if(data+compressed>start||ascii.decode(bytes.subarray(local+30,local+30+ln))!==path)fail('SKIN_ZIP_INVALID');
  extraCheck(view,local+30+ln,le);
  if(!(flags&8)&&(view.getUint32(local+18,true)!==compressed||view.getUint32(local+22,true)!==size||view.getUint32(local+14,true)!==view.getUint32(p+16,true)))fail('SKIN_ZIP_INVALID');
  ranges.push([local,data+compressed]);total+=size;
  if(total>SKIN_PACK_LIMITS.total||size>(path==='manifest.json'?SKIN_PACK_LIMITS.manifest:SKIN_PACK_LIMITS.resource)||directory&&size!==0)fail('SKIN_PACK_SIZE_LIMIT');
  entries.push({path,directory,size,crc:view.getUint32(p+16,true)});p+=46+nl+el+cl;
 }
 ranges.sort((a,b)=>a[0]-b[0]);for(let i=1;i<ranges.length;i++)if(ranges[i][0]<ranges[i-1][1])fail('SKIN_ZIP_OVERLAP');
 if(p!==end||!paths.has('manifest.json'))fail('SKIN_MANIFEST_MISSING');return {bytes,entries};
}
export function imageInfo(input,mime){
 const b=bytesOf(input),v=new DataView(b.buffer,b.byteOffset,b.byteLength);let width,height;
 if(mime==='image/png'){
  if(b.length<33||[137,80,78,71,13,10,26,10].some((x,i)=>b[i]!==x)||ascii.decode(b.subarray(12,16))!=='IHDR'||v.getUint32(8)!==13)fail('SKIN_IMAGE_INVALID');
  width=v.getUint32(16);height=v.getUint32(20);let p=8,ended=false;
  while(p+12<=b.length){const size=v.getUint32(p),kind=ascii.decode(b.subarray(p+4,p+8));if(p+12+size>b.length)fail('SKIN_IMAGE_INVALID');if(kind==='acTL')fail('SKIN_ANIMATED_IMAGE_REJECTED');p+=12+size;if(kind==='IEND'){ended=true;break;}}
  if(!ended||p!==b.length)fail('SKIN_IMAGE_INVALID');
 }else if(mime==='image/webp'){
  if(b.length<20||ascii.decode(b.subarray(0,4))!=='RIFF'||ascii.decode(b.subarray(8,12))!=='WEBP'||v.getUint32(4,true)+8!==b.length)fail('SKIN_IMAGE_INVALID');
  let p=12,frames=0,extended=null;const u24=o=>b[o]|b[o+1]<<8|b[o+2]<<16;
  while(p+8<=b.length){const kind=ascii.decode(b.subarray(p,p+4)),size=v.getUint32(p+4,true),q=p+8;if(q+size>b.length)fail('SKIN_IMAGE_INVALID');
   if(kind==='ANIM'||kind==='ANMF')fail('SKIN_ANIMATED_IMAGE_REJECTED');
   if(kind==='VP8X'){if(size!==10||b[q]&2)fail('SKIN_ANIMATED_IMAGE_REJECTED');extended=[u24(q+4)+1,u24(q+7)+1];}
   if(kind==='VP8 '){if(size<10||b[q+3]!==157||b[q+4]!==1||b[q+5]!==42)fail('SKIN_IMAGE_INVALID');width=v.getUint16(q+6,true)&16383;height=v.getUint16(q+8,true)&16383;frames++;}
   if(kind==='VP8L'){if(size<5||b[q]!==47)fail('SKIN_IMAGE_INVALID');const bits=v.getUint32(q+1,true);width=(bits&16383)+1;height=((bits>>>14)&16383)+1;frames++;}
   p=q+size+(size&1);
  }
  if(p!==b.length||frames!==1||extended&&(extended[0]!==width||extended[1]!==height))fail('SKIN_IMAGE_INVALID');
 }else fail('SKIN_IMAGE_MIME_REJECTED');
 if(!width||!height||width>SKIN_PACK_LIMITS.side||height>SKIN_PACK_LIMITS.side)fail('SKIN_IMAGE_DIMENSION_LIMIT');return {width,height};
}
const crcTable=Uint32Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
let zipPromise=null;
async function zipLibrary(){if(!zipPromise)zipPromise=import('./vendor/jszip/jszip.min.js').then(()=>globalThis.JSZip).then(zip=>{if(!zip)fail('SKIN_ZIP_LIBRARY_UNAVAILABLE');return zip;}).catch(error=>{zipPromise=null;throw error;});return zipPromise;}
async function contract(){if(!globalThis.AtlasSkinRuntime)await import('./atlas-reference/js/skin-runtime.js');return globalThis.AtlasSkinRuntime;}
function streamBytes(file,limit,budget){return new Promise((resolve,reject)=>{let size=0,chunks=[],settled=false;const stream=file.internalStream('uint8array');stream.on('data',chunk=>{if(settled)return;size+=chunk.length;budget.used+=chunk.length;if(size>limit||budget.used>SKIN_PACK_LIMITS.total){settled=true;stream.pause();chunks=[];reject(Object.assign(Error('SKIN_PACK_SIZE_LIMIT'),{code:'SKIN_PACK_SIZE_LIMIT'}));return;}chunks.push(chunk);});stream.on('error',error=>{if(!settled){settled=true;reject(error);}});stream.on('end',()=>{if(settled)return;settled=true;const output=new Uint8Array(size);let p=0;for(const chunk of chunks){output.set(chunk,p);p+=chunk.length;}resolve(output);});stream.resume();});}
export async function readSkinPack(input){
 const {bytes,entries}=preflightZip(input),Zip=await zipLibrary(),zip=await Zip.loadAsync(bytes,{createFolders:false}),budget={used:0},contents=new Map();
 for(const entry of entries){if(entry.directory)continue;const file=zip.file(entry.path);if(!file)fail('SKIN_ZIP_INVALID');const content=await streamBytes(file,entry.path==='manifest.json'?SKIN_PACK_LIMITS.manifest:SKIN_PACK_LIMITS.resource,budget);if(content.length!==entry.size||crc32(content)!==entry.crc)fail('SKIN_ZIP_CRC_MISMATCH');contents.set(entry.path,content);}
 let manifest;try{manifest=JSON.parse(ascii.decode(contents.get('manifest.json')));}catch(_){fail('SKIN_MANIFEST_INVALID');}
 fields(manifest,['kind','schemaVersion','skinApiVersion','id','name','theme','assets']);
 if(manifest.kind!=='atlas-skin-pack'||manifest.schemaVersion!==1||manifest.skinApiVersion!==1)fail('SKIN_PACK_VERSION_UNSUPPORTED');
 if(typeof manifest.id!=='string'||!/^[-a-zA-Z0-9._]{1,80}$/.test(manifest.id)||manifest.id.startsWith('builtin.'))fail('SKIN_PACK_ID_INVALID');
 if(typeof manifest.name!=='string'||!manifest.name.trim()||manifest.name.length>100||!Array.isArray(manifest.assets)||manifest.assets.length>95)fail('SKIN_MANIFEST_INVALID');
 const runtime=await contract(),resolved=runtime.resolve(manifest.theme);if(!resolved.ok)fail(resolved.errorCode);if(manifest.theme.id!==manifest.id)fail('SKIN_PACK_ID_MISMATCH');
 const ids=new Set(),paths=new Set(),files=[];let pixels=0;
 for(const item of manifest.assets){fields(item,['id','path','mime']);if(typeof item.id!=='string'||!/^[-a-zA-Z0-9._]{1,80}$/.test(item.id)||ids.has(item.id)||paths.has(item.path)||!pathAllowed(item.path)||item.path==='manifest.json')fail('SKIN_ASSET_INVALID');if(item.mime!==(item.path.endsWith('.png')?'image/png':'image/webp'))fail('SKIN_IMAGE_MIME_REJECTED');ids.add(item.id);paths.add(item.path);const content=contents.get(item.path);if(!content)fail('SKIN_ASSET_MISSING');const info=imageInfo(content,item.mime);pixels+=info.width*info.height;if(pixels>SKIN_PACK_LIMITS.pixels)fail('SKIN_IMAGE_PIXEL_LIMIT');files.push({...item,...info,bytes:content});}
 if(contents.size!==files.length+1)fail('SKIN_PACK_UNDECLARED_FILE');for(const id of Object.values(resolved.skin.assets))if(!ids.has(id))fail('SKIN_ASSET_MISSING');
 return {id:manifest.id,name:manifest.name,theme:resolved.skin,files};
}
export async function writeSkinPack(pack,theme=pack.theme){
 const runtime=await contract(),resolved=runtime.resolve(theme);if(!resolved.ok)fail(resolved.errorCode);
 const id=resolved.skin.id.startsWith('builtin.')?'user.exported':resolved.skin.id,skin={...resolved.skin,id},manifest={kind:'atlas-skin-pack',schemaVersion:1,skinApiVersion:1,id,name:pack?.name||id,theme:skin,assets:(pack?.files||[]).map(({id,path,mime})=>({id,path,mime}))};
 const json=encoder.encode(JSON.stringify(manifest,null,2));if(json.length>SKIN_PACK_LIMITS.manifest)fail('SKIN_MANIFEST_TOO_LARGE');
 const Zip=await zipLibrary(),zip=new Zip();zip.file('manifest.json',json,{createFolders:false});for(const file of pack?.files||[])zip.file(file.path,bytesOf(file.bytes),{createFolders:false});
 const bytes=await zip.generateAsync({type:'uint8array',compression:'DEFLATE'});await readSkinPack(bytes);return bytes;
}
