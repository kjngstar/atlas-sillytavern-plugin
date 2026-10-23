import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import '../ui/atlas-reference/js/skin-runtime.js';
import {imageInfo,readSkinPack,writeSkinPack,SKIN_PACK_LIMITS} from '../ui/atlas-skin-pack.mjs';
import {createSkinAssetLoader} from '../ui/atlas-skin-assets.mjs';
import {createAppearanceController} from '../ui/atlas-appearance-controller.mjs';
const runtime=globalThis.AtlasSkinRuntime;
async function artwork(){
 const manifest=JSON.parse(await readFile(new URL('../skins/shanhezhi/manifest.json',import.meta.url),'utf8'));
 const files=await Promise.all(manifest.assets.map(async asset=>{const bytes=new Uint8Array(await readFile(new URL('../skins/shanhezhi/'+asset.path,import.meta.url)));return {...asset,...imageInfo(bytes,asset.mime),bytes};}));
 return {id:manifest.id,name:manifest.name,theme:manifest.theme,files};
}
function rootFixture(){
 const values=new Map(),classes=new Set();
 return {dataset:{},style:{setProperty:(k,v)=>values.set(k,v),removeProperty:k=>values.delete(k),getPropertyValue:k=>values.get(k)||''},classList:{contains:k=>classes.has(k),toggle(k,on){if(on)classes.add(k);else classes.delete(k);}},getAttribute(){return [...values].map(([k,v])=>k+':'+v).join(';')||null;},setAttribute(_k,text){values.clear();for(const pair of text.split(';')){const i=pair.indexOf(':');values.set(pair.slice(0,i),pair.slice(i+1));}},removeAttribute(){values.clear();}};
}
test('Shanhe real artwork roundtrips through the shipped ZIP importer within budgets',async()=>{
 const original=await artwork(),bytes=await writeSkinPack(original),restored=await readSkinPack(bytes);
 assert.equal(restored.id,'user.shanhezhi');assert.equal(restored.files.length,14);assert.equal(Object.keys(restored.theme.assets).length,18);
 assert.ok(bytes.length<512*1024);assert.ok(original.files.reduce((n,f)=>n+f.width*f.height,0)<SKIN_PACK_LIMITS.pixels);
 for(const file of restored.files){assert.deepEqual(file.bytes,original.files.find(f=>f.id===file.id).bytes);assert.ok(file.width<=2048&&file.height<=2048);}
});
test('18 artwork roles share exactly 14 decoded resources and release each exactly once',async()=>{
 const pack=await artwork();let created=0,decoded=0,revoked=0,closed=0;
 const loader=createSkinAssetLoader({urlApi:{createObjectURL:()=>`blob:fixture-${++created}`,revokeObjectURL:()=>revoked++},decode:async blob=>{decoded++;const info=imageInfo(new Uint8Array(await blob.arrayBuffer()),blob.type);return {...info,close:()=>closed++};}});
 const prepared=await loader.prepare(pack,pack.theme);
 assert.equal(created,14);assert.equal(decoded,14);assert.equal(prepared.resources.mapBackdrop,prepared.resources.windowBackdrop);assert.notEqual(prepared.resources.avatarFrame,prepared.resources.windowFrame);assert.equal(prepared.resources.mapTexture,prepared.resources.panelTexture);assert.equal(prepared.resources.inputFrame,prepared.resources.panelFrame);assert.equal(prepared.resources.controlFrame,prepared.resources.panelFrame);
 prepared.release();prepared.release();assert.equal(revoked,14);assert.equal(closed,14);
});
test('switching to starmap clears every optional artwork URL and the map backdrop',async()=>{
 const pack=await artwork(),root=rootFixture(),map={state:{showRadar:true},setFlag(_key,value){this.state.showRadar=value;},setSkin(value){this.skin=value;return true;}};
 const resources=Object.fromEntries(Object.keys(pack.theme.assets).map(role=>[role,{url:'blob:'+role,bitmap:{width:256,height:256}}]));
 assert.equal(runtime.apply(pack.theme,{root,map,resources}).ok,true);
 assert.equal(map.skin.backdrop,resources.mapBackdrop.bitmap);assert.match(root.style.getPropertyValue('--skin-avatar-frame'),/blob:avatarFrame/);
 assert.equal(runtime.apply('builtin.starmap',{root,map}).ok,true);
 for(const key of Object.values(runtime.CSS_ASSET_ROLES))assert.equal(root.style.getPropertyValue(key),'');
 for(const key of ['--skin-selection-bg','--skin-status-error','--skin-control-width','--skin-panel-slice'])assert.equal(root.style.getPropertyValue(key),'');
 assert.equal(map.skin.backdrop,null);assert.equal(map.skin.texture,null);assert.equal(root.dataset.skinBase,'starmap');
});
test('older packs reusing the square window frame leave avatars free of that frame',async()=>{
 const pack=await artwork(),root=rootFixture(),map={state:{showRadar:true},setFlag(){},setSkin(){return true;}};
 const legacy={...pack.theme,assets:{...pack.theme.assets,avatarFrame:pack.theme.assets.windowFrame}};
 const shared={url:'blob:old-square-frame',bitmap:{width:256,height:256}};
 assert.equal(runtime.apply(legacy,{root,map,resources:{windowFrame:shared,avatarFrame:shared}}).ok,true);
 assert.match(root.style.getPropertyValue('--skin-window-frame'),/old-square-frame/);
 assert.equal(root.style.getPropertyValue('--skin-avatar-frame'),'');
 const avatar={url:'blob:round-avatar',bitmap:{width:128,height:128}};
 assert.equal(runtime.apply(pack.theme,{root,map,resources:{windowFrame:shared,avatarFrame:avatar}}).ok,true);
 assert.match(root.style.getPropertyValue('--skin-avatar-frame'),/round-avatar/);
});
test('a failed Canvas appearance transaction restores the previous artwork and CSS',async()=>{
 const pack=await artwork(),root=rootFixture(),map={state:{showRadar:true},setFlag(_k,v){this.state.showRadar=v;},setSkin(){return true;}};
 runtime.apply('builtin.starmap',{root,map});const before=root.getAttribute('style');let first=true;
 map.setSkin=()=>{if(first){first=false;return false;}return true;};
 assert.equal(runtime.apply(pack.theme,{root,map,resources:{windowBackdrop:{url:'blob:late'}}}).ok,false);
 assert.equal(root.getAttribute('style'),before);assert.equal(root.dataset.skinBase,'starmap');assert.equal(map.state.showRadar,true);
});
test('optional artwork tokens retain a typed whitelist and reject remote image references',async()=>{
 const {theme}=await artwork();assert.equal(runtime.resolve(theme).ok,true);
 for(const opacity of [-.01,.51,NaN,'0.2'])assert.equal(runtime.validate({...theme,tokens:{'map.backdrop.opacity':opacity}}).ok,false);
 assert.equal(runtime.validate({...theme,assets:{mapBackdrop:'https://invalid/art.webp'}}).ok,false);
 assert.equal(runtime.validate({...theme,assets:{javascript:'x'}}).ok,false);
});
const mapSource=readFileSync(new URL('../ui/atlas-reference/js/map.js',import.meta.url),'utf8');
const cut=(a,b)=>mapSource.slice(mapSource.indexOf(a),mapSource.indexOf(b));
test('backdrop is drawn below geometry with a viewport cover crop and no world mutation',()=>{
 const log=[],st={kind:'world',node:{host:false},cam:{s:1}},g={},before=JSON.stringify(g);
 const ctx={fillRect(){log.push('background');},save(){},restore(){},createLinearGradient(){return {addColorStop(){}};},drawImage(...args){log.push(args);}};
 const sandbox=vm.createContext({ctx,st,SURFACE_PAINT:{},canvasStyle:{background:'#f3ead8',backdrop:{width:1536,height:1024},backdropOpacity:.22},texturePattern:null,extent:()=>[-400,400,-200,200],worldMap:()=>log.push('geometry'),pushLabel(){}});
 // terrainWorld ends at the next renderer function, so braces remain intact.
 const start=mapSource.indexOf('  function terrainWorld('),end=mapSource.indexOf('\n  function ',start+12);
 vm.runInContext(mapSource.slice(start,end),sandbox);sandbox.terrainWorld(g,800,400);
 assert.equal(log[0],'background');assert.ok(Array.isArray(log[1]));assert.equal(log[2],'geometry');
 const image=log[1];assert.equal(image.length,9);assert.deepEqual(image.slice(5),[-400,-200,800,400]);assert.equal(JSON.stringify(g),before);
});
test('ink stroke contrast stays ordered by quality and default appearance is untouched',()=>{
 const sandbox=vm.createContext({canvasStyle:{painters:{furniture:'ink'}},layerPaint:()=>({stroke:'#6f5035'}),hexA:(color,alpha)=>({color,alpha})});
 vm.runInContext(cut('  function skinColor(', '\n  const listeners='),sandbox);
 const weak=sandbox.skinColor('furniture','stroke','rgba(1,2,3,.22)'),strong=sandbox.skinColor('furniture','stroke','rgba(1,2,3,.85)');
 assert.ok(weak.alpha>.35);assert.ok(strong.alpha>weak.alpha);assert.ok(strong.alpha<1);
 sandbox.canvasStyle=null;assert.equal(sandbox.skinColor('furniture','stroke','rgba(1,2,3,.22)'),'rgba(1,2,3,.22)');
});
test('install, export, restart and remove keep the portable artwork with the correct saved theme',async()=>{
 const pack=await artwork(),packs=new Map();let chosen=runtime.builtin('builtin.starmap'),saved=null,releases=0;
 const host={saveSkin:async s=>{saved=s;},putSkinPack:async p=>packs.set(p.id,p),getSkinPack:async id=>packs.get(id),listSkinPacks:async()=>[...packs.values()].map(p=>({id:p.id,name:p.name})),removeSkinPack:async id=>packs.delete(id)};
 const make=()=>createAppearanceController({runtime,host,getSkin:()=>chosen,apply:s=>{chosen=s;return {ok:true,skin:s};},assetLoader:{prepare:async()=>({resources:{},release(){releases++;}})}});
 let controller=make();assert.equal((await controller.install(pack)).saved,true);assert.equal(saved.id,pack.id);
 const exported=await readSkinPack(await controller.exportPack());assert.equal(exported.files.length,14);controller.destroy();
 controller=make();assert.equal((await controller.start(saved)).ok,true);assert.equal(chosen.id,pack.id);
 assert.equal((await controller.remove(pack.id)).ok,true);assert.equal(saved.id,'builtin.starmap');assert.equal(packs.size,0);assert.ok(releases>=3);controller.destroy();
});

test('component frame slices stay unitless, widths use pixels and malformed values are rejected',async()=>{
 const {theme}=await artwork(),root=rootFixture(),map={state:{showRadar:true},setFlag(){},setSkin(){return true;}};
 assert.equal(runtime.apply(theme,{root,map}).ok,true);
 for(const role of ['panel','control','input','selection']){
  assert.equal(root.style.getPropertyValue('--skin-'+role+'-slice'),String(theme.tokens['ui.'+role+'.frameSlice']));
  assert.equal(root.style.getPropertyValue('--skin-'+role+'-width'),theme.tokens['ui.'+role+'.frameWidth']+'px');
  for(const value of [-1,257,'24',NaN])assert.equal(runtime.validate({...theme,tokens:{['ui.'+role+'.frameSlice']:value}}).ok,false);
  assert.equal(runtime.validate({...theme,tokens:{['ui.'+role+'.frameWidth']:17}}).ok,false);
 }
});

test('a failed switch restores all previously committed component artwork',async()=>{
 const {theme}=await artwork(),root=rootFixture();let current=null,fail=false;
 const map={state:{showRadar:true},setFlag(_key,value){this.state.showRadar=value;},setSkin(value){if(fail){fail=false;return false;}current=value;return true;}};
 const resources=Object.fromEntries(Object.keys(theme.assets).map(role=>[role,{url:'blob:old-'+role,bitmap:{width:256,height:256}}]));
 assert.equal(runtime.apply(theme,{root,map,resources}).ok,true);
 const before=root.getAttribute('style'),prior=current;fail=true;
 assert.equal(runtime.apply('builtin.starmap',{root,map}).ok,false);
 assert.equal(root.getAttribute('style'),before);assert.equal(current,prior);assert.equal(root.dataset.skinBase,'parchment');
 for(const role of ['panelFrame','controlFrame','controlActiveFrame','inputFrame','selectionFrame','divider'])assert.match(root.style.getPropertyValue(runtime.CSS_ASSET_ROLES[role]),new RegExp('blob:old-'+role));
});

test('v1 image packages without component frames still install and apply',async()=>{
 const pack=await artwork(),theme={...runtime.builtin('builtin.parchment'),id:'user.older-paper',assets:{windowFrame:'jade-frame',characterMarker:'character-seal'}};
 const original={id:theme.id,name:'Older v1 paper',theme,files:pack.files.filter(f=>Object.values(theme.assets).includes(f.id))};
 const restored=await readSkinPack(await writeSkinPack(original));assert.equal(restored.files.length,2);
 const root=rootFixture(),map={state:{showRadar:false},setFlag(){},setSkin(){return true;}};
 assert.equal(runtime.apply(restored.theme,{root,map}).ok,true);
 for(const role of ['panelFrame','controlFrame','controlActiveFrame','inputFrame','selectionFrame','divider'])assert.equal(root.style.getPropertyValue(runtime.CSS_ASSET_ROLES[role]),'');
});

test('paper, selection, primary control and status text colors keep readable contrast',async()=>{
 const {theme}=await artwork(),t=theme.tokens;
 const luminance=hex=>{const c=hex.slice(1).match(/../g).map(s=>parseInt(s,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;};
 const ratio=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
 for(const [fg,bg]of [['ui.text.primary','ui.panel.bg'],['ui.text.muted','ui.panel.bg'],['ui.text.onAccent','ui.accent'],['ui.selection.text','ui.selection.bg'],...['info','success','warning','error'].map(k=>['ui.status.'+k,'ui.panel.bg'])])assert.ok(ratio(t[fg],t[bg])>=4.5,fg+' contrast');
});
