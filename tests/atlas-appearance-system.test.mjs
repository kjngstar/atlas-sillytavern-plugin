import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {indexedDB} from 'fake-indexeddb';
import '../ui/atlas-reference/js/skin-runtime.js';
import '../ui/vendor/jszip/jszip.min.js';
import {readSkinPack,writeSkinPack,imageInfo,preflightZip,SKIN_PACK_LIMITS} from '../ui/atlas-skin-pack.mjs';
import {createSkinAssetLoader} from '../ui/atlas-skin-assets.mjs';
import {createSkinStorage} from '../ui/atlas-skin-storage.mjs';
import {createAppearanceController} from '../ui/atlas-appearance-controller.mjs';
import {appearanceSettingsHTML} from '../ui/atlas-appearance-settings.mjs';
const runtime=globalThis.AtlasSkinRuntime,Zip=globalThis.JSZip;
const theme=(patch={})=>({...runtime.builtin('builtin.starmap'),id:'user.test',...patch});
const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aI9sAAAAASUVORK5CYII=','base64'));
const pack=()=>({id:'user.test',name:'测试皮肤',theme:theme({assets:{characterMarker:'dot',placeMarker:'dot'}}),files:[{id:'dot',path:'assets/dot.png',mime:'image/png',bytes:png,width:1,height:1}]});
const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('skin defaults remain data only and the paper palette is independent of its frame',()=>{
 const base=runtime.resolve('builtin.starmap');assert.equal(base.ok,true);assert.deepEqual(base.skin.tokens,{});
 const paper=runtime.resolve(theme({baseTheme:'builtin.parchment',components:{frame:'minimal'}}));assert.equal(paper.skin.components.frame,'minimal');assert.equal(paper.skin.tokens['ui.window.bg'],'#f3e9d3');assert.match(runtime.FONT_REGISTRY.serif,/Atlas Preview Sans/);
 assert.equal(runtime.resolve('unknown').ok,false);
});
for(const [name,patch]of [
 ['unknown top field',{script:'alert(1)'}],['unknown token',{tokens:{'css.raw':'color:red'}}],['remote CSS value',{tokens:{'ui.accent':'url(https://example.invalid)'}}],['numeric string',{tokens:{'ui.window.radius':'12px'}}],['range overflow',{tokens:{'ui.window.radius':29}}],['infinite number',{tokens:{'ui.window.radius':Infinity}}],['unregistered font',{tokens:{'ui.font.family':'https://example.invalid/font.woff'}}],['unknown component',{components:{frame:'javascript'}}],['unknown painter',{mapStyles:{road:'javascript'}}],['nonboolean option',{options:{motion:'false'}}],['invalid asset reference',{assets:{windowFrame:'../frame'}}],['future version',{schemaVersion:2}],['prototype field',JSON.parse('{"tokens":{"__proto__":"#000000"}}')]
])test('skin contract rejects '+name,()=>assert.equal(runtime.validate(theme(patch)).ok,false));
test('legacy JSON migration preserves all view options',()=>{const result=runtime.migrate({kind:'atlas-preview-skin',version:1,accent:'#abcdef',motion:false,radar:false,coordinates:true});assert.equal(result.ok,true);assert.equal(result.skin.tokens['ui.accent'],'#abcdef');assert.deepEqual(result.skin.options,{motion:false,radar:false,coordinates:true});});
test('CSS and Canvas application roll back together on Canvas failure',()=>{
 const dom=new JSDOM('<div id="root"></div>'),root=dom.window.document.querySelector('div');let canvas=null,fail=false;
 const map={state:{showRadar:true},setFlag(_k,v){this.state.showRadar=v;},setSkin(value){if(fail){fail=false;throw Error('paint failed');}canvas=value;}};
 assert.equal(runtime.apply('builtin.starmap',{root,map}).ok,true);const previous=root.outerHTML;fail=true;
 assert.equal(runtime.apply('builtin.parchment',{root,map}).ok,false);assert.equal(root.outerHTML,previous);assert.equal(canvas.markerShape,'classic');assert.equal(map.state.showRadar,true);dom.window.close();
});
test('appearance markup escapes user supplied names',()=>{const html=appearanceSettingsHTML({skin:theme(),runtime,catalog:[{id:'user.test',name:'<img src=x onerror=alert(1)>'}]});assert.ok(!html.includes('<img'));assert.match(html,/&lt;img/);});

test('image ZIP roundtrip preserves typed theme, shared role references and exact bytes',async()=>{
 const original=pack(),bytes=await writeSkinPack(original),restored=await readSkinPack(bytes);assert.equal(restored.id,original.id);assert.deepEqual(restored.theme.assets,original.theme.assets);assert.deepEqual(restored.files[0].bytes,png);assert.deepEqual(imageInfo(png,'image/png'),{width:1,height:1});
});
test('JSON-only builtins export to an installable user package',async()=>{const bytes=await writeSkinPack({name:'Export',files:[]},runtime.builtin('builtin.parchment'));const restored=await readSkinPack(bytes);assert.equal(restored.id,'user.exported');assert.equal(restored.theme.baseTheme,'builtin.parchment');});
test('ZIP buffers from another iframe realm are accepted',async()=>{const bytes=await writeSkinPack(pack()),foreign=vm.runInNewContext(`new Uint8Array(${JSON.stringify([...bytes])}).buffer`);assert.equal((await readSkinPack(foreign)).id,'user.test');});
async function malicious(files,manifest){const zip=new Zip();zip.file('manifest.json',JSON.stringify(manifest||{kind:'atlas-skin-pack',schemaVersion:1,skinApiVersion:1,id:'user.test',name:'Bad',theme:theme(),assets:[]}),{createFolders:false});for(const [path,bytes,options]of files)zip.file(path,bytes,{createFolders:false,...options});return zip.generateAsync({type:'uint8array',compression:'DEFLATE',platform:'UNIX'});}
for(const name of ['../escape.png','assets/../escape.png','assets/.hidden.png','assets/code.js','assets/vector.svg','https://invalid/image.png','assets\\escape.png'])test('skin ZIP rejects unsafe path '+name,async()=>assert.rejects(readSkinPack(await malicious([[name,png]])),/SKIN_PACK_PATH_INVALID/));
test('skin ZIP rejects symlinks and undeclared files',async()=>{await assert.rejects(readSkinPack(await malicious([['assets/link.png',png,{unixPermissions:0xa1ff}]])),/SKIN_ZIP_LINK_REJECTED/);await assert.rejects(readSkinPack(await malicious([['assets/extra.png',png]])),/SKIN_PACK_UNDECLARED_FILE/);});
test('skin ZIP enforces entry and archive limits before unpacking',async()=>{const files=Array.from({length:96},(_,i)=>['assets/'+i+'.png',png]);assert.throws(()=>preflightZip(new Uint8Array(SKIN_PACK_LIMITS.zip+1)),/SKIN_ZIP_TOO_LARGE/);await assert.rejects(readSkinPack(await malicious(files)),/SKIN_PACK_ENTRY_LIMIT/);});
test('maximum 95 assets plus manifest remains portable without implicit folders',async()=>{const original={...pack(),files:Array.from({length:95},(_,i)=>({id:'i'+i,path:'assets/'+i+'.png',mime:'image/png',bytes:png,width:1,height:1})),theme:theme()};assert.equal((await readSkinPack(await writeSkinPack(original))).files.length,95);});
test('skin ZIP rejects false declared sizes even when compression is tiny',async()=>{
 const bytes=await malicious([['assets/bomb.png',new Uint8Array(SKIN_PACK_LIMITS.resource+1)]]),view=new DataView(bytes.buffer);
 for(let i=0;i<bytes.length-46;i++){const signature=view.getUint32(i,true);if(signature===0x02014b50&&new TextDecoder().decode(bytes.subarray(i+46,i+46+view.getUint16(i+28,true)))==='assets/bomb.png'){const local=view.getUint32(i+42,true);view.setUint32(i+24,1,true);view.setUint32(local+22,1,true);break;}}
 await assert.rejects(readSkinPack(bytes),/SKIN_PACK_SIZE_LIMIT/);
});
test('skin ZIP verifies CRC and rejects missing image references',async()=>{
 const bytes=await writeSkinPack(pack()),view=new DataView(bytes.buffer);for(let i=0;i<bytes.length-46;i++)if(view.getUint32(i,true)===0x02014b50){const local=view.getUint32(i+42,true);view.setUint32(i+16,123,true);view.setUint32(local+14,123,true);break;}
 await assert.rejects(readSkinPack(bytes),/SKIN_ZIP_CRC_MISMATCH/);await assert.rejects(writeSkinPack({id:'user.test',name:'Missing',theme:theme({assets:{windowFrame:'absent'}}),files:[]}),/SKIN_ASSET_MISSING/);
});
test('image headers reject animation and dimensions above the decode budget',()=>{
 const huge=png.slice();new DataView(huge.buffer).setUint32(16,2049);assert.throws(()=>imageInfo(huge,'image/png'),/SKIN_IMAGE_DIMENSION_LIMIT/);
 const animated=new Uint8Array(png.length+12);animated.set(png.subarray(0,33));animated.set([0,0,0,0,97,99,84,76,0,0,0,0],33);animated.set(png.subarray(33),45);assert.throws(()=>imageInfo(animated,'image/png'),/SKIN_ANIMATED_IMAGE_REJECTED/);
 assert.throws(()=>imageInfo(png,'image/svg+xml'),/SKIN_IMAGE_MIME_REJECTED/);
});

test('asset decoding deduplicates shared roles and releases every resource once',async()=>{
 let created=0,closed=0,revoked=0;const loader=createSkinAssetLoader({urlApi:{createObjectURL:()=>`blob:${++created}`,revokeObjectURL:()=>revoked++},decode:async()=>({width:1,height:1,close:()=>closed++})});const p=pack(),loaded=await loader.prepare(p,p.theme);assert.equal(loaded.resources.characterMarker,loaded.resources.placeMarker);assert.equal(created,1);loaded.release();loaded.release();assert.equal(closed,1);assert.equal(revoked,1);
});
test('asset cancellation and decode failure clean up prepared resources',async()=>{
 let revoked=0,closed=0;const control=new AbortController(),pending=gate();const loader=createSkinAssetLoader({urlApi:{createObjectURL:()=> 'blob:1',revokeObjectURL:()=>revoked++},decode:()=>pending.promise}),p=pack();const result=loader.prepare(p,p.theme,{signal:control.signal});await tick();control.abort();pending.resolve({width:1,height:1,close:()=>closed++});await assert.rejects(result,/SKIN_ASSET_ABORTED/);assert.equal(revoked,1);assert.equal(closed,1);
 const bad=createSkinAssetLoader({urlApi:{createObjectURL:()=> 'blob:2',revokeObjectURL:()=>revoked++},decode:async()=>{throw Error('bad PNG');}});await assert.rejects(bad.prepare(p,p.theme),/SKIN_IMAGE_DECODE_FAILED/);assert.equal(revoked,2);
});
test('IndexedDB isolates owners, lists metadata and replaces atomically',async()=>{
 const store=createSkinStorage({indexedDB,name:'skin-test-'+Math.random()});await store.put('owner-A',pack());assert.equal((await store.get('owner-B','user.test')),null);assert.equal((await store.list('owner-A'))[0].name,'测试皮肤');assert.ok(!JSON.stringify(await store.list('owner-A')).includes('bytes'));
 await assert.rejects(store.put('owner-A',{...pack(),files:[{bytes:new Uint8Array(64*1024*1024+1)}]}),/SKIN_STORAGE_QUOTA/);assert.equal((await store.get('owner-A','user.test')).name,'测试皮肤');await store.remove('owner-A','user.test');assert.deepEqual(await store.list('owner-A'),[]);store.dispose();await assert.rejects(store.list('owner-A'),/SKIN_STORAGE_DISPOSED/);
});
test('IndexedDB enforces installed count and reports unavailable storage',async()=>{const store=createSkinStorage({indexedDB,name:'skin-count-'+Math.random()});for(let i=0;i<24;i++)await store.put('owner',{...pack(),id:'user.'+i,files:[]});await assert.rejects(store.put('owner',{...pack(),id:'user.25',files:[]}),/SKIN_STORAGE_QUOTA/);store.dispose();await assert.rejects(createSkinStorage({indexedDB:null}).list('owner'),/SKIN_STORAGE_UNAVAILABLE/);});
function controller(options={}){let current=runtime.builtin('builtin.starmap');const saved=[],diagnostics=[],packs=new Map();const host={saveSkin:async skin=>saved.push(skin),getSkinPack:async id=>packs.get(id),putSkinPack:async p=>packs.set(p.id,p),listSkinPacks:async()=>[...packs.values()].map(p=>({id:p.id,name:p.name})),removeSkinPack:async id=>packs.delete(id),...options.host};const assetLoader=options.assetLoader||{prepare:async()=>({resources:{},release(){}})};return {get current(){return current;},saved,diagnostics,packs,api:createAppearanceController({runtime,host,apply:skin=>{current=skin;return {ok:true,skin};},getSkin:()=>current,diagnostic:e=>diagnostics.push(e),assetLoader})};}
test('late installed-skin read cannot override a newer builtin choice',async()=>{const pending=gate(),c=controller({host:{getSkinPack:()=>pending.promise}}),first=c.api.setSkin('user.test');await c.api.setSkin('builtin.parchment');pending.resolve({...pack(),theme:theme()});assert.equal((await first).errorCode,'SKIN_SUPERSEDED');assert.equal(c.current.id,'builtin.parchment');assert.equal(c.saved.at(-1).id,'builtin.parchment');c.api.destroy();});
test('late failed startup does not reset a newer user choice',async()=>{const pending=gate(),c=controller({host:{getSkinPack:()=>pending.promise}}),first=c.api.start('user.missing');await c.api.setSkin('builtin.parchment');pending.reject(Error('not available'));await first;assert.equal(c.current.id,'builtin.parchment');c.api.destroy();});
test('slow pack installation cannot overwrite a newer appearance selection',async()=>{const pending=gate(),c=controller({host:{putSkinPack:()=>pending.promise}}),first=c.api.install(pack());await tick();await c.api.setSkin('builtin.parchment');pending.resolve();assert.equal((await first).errorCode,'SKIN_SUPERSEDED');assert.equal(c.current.id,'builtin.parchment');c.api.destroy();});
test('failed image storage permits preview and export without saving a broken startup reference',async()=>{const c=controller({host:{putSkinPack:async()=>{throw Error('denied');}}});const result=await c.api.install(pack());assert.equal(result.ok,true);assert.equal(result.saved,false);assert.equal(c.saved.length,0);const next={...c.current,tokens:{'ui.accent':'#ffffff'}};await c.api.setSkin(next);assert.equal(c.saved.length,0);assert.equal((await readSkinPack(await c.api.exportPack())).files.length,1);c.api.destroy();});
test('removal saves a builtin fallback before deleting an active pack',async()=>{const c=controller();await c.api.install({...pack(),files:[],theme:theme()});assert.equal((await c.api.remove('user.test')).ok,true);assert.equal(c.current.id,'builtin.starmap');assert.equal(c.packs.size,0);c.api.destroy();assert.equal(await c.api.save(),false);});
test('failed preference save keeps the pack available for recovery',async()=>{const c=controller({host:{saveSkin:async()=>{throw Error('denied');}}});await c.api.install({...pack(),files:[],theme:theme()});assert.equal((await c.api.remove('user.test')).ok,false);assert.equal(c.packs.size,1);c.api.destroy();});
test('legacy JSON becomes a reusable catalog entry and survives export',async()=>{const c=controller();const value={kind:'atlas-preview-skin',version:1,accent:'#abcdef'};assert.equal((await c.api.importFile({name:'old.json',size:100,text:async()=>JSON.stringify(value)})).ok,true);assert.equal((await c.api.list()).length,1);assert.equal((await readSkinPack(await c.api.exportPack())).theme.tokens['ui.accent'],'#abcdef');c.api.destroy();});

const modelContext={module:{exports:{}}};vm.runInNewContext(readFileSync(new URL('../ui/atlas-reference/js/ui-model.js',import.meta.url),'utf8'),modelContext);const model=modelContext.module.exports;
test('display configuration inheritance retains required navigation and independent manual collapse',()=>{const result=model.resolveUIProfile('mapOnly');assert.equal(result.ok,true);assert.equal(result.profile.visible.inspector,false);assert.equal(result.profile.visible.mapControls,true);assert.equal(result.profile.behavior.forceMapPage,true);assert.equal(model.deriveEffectiveLayout(result.profile,{page:'prefs',leftClosed:true}).effectivePage,'map');assert.equal(model.deriveEffectiveLayout(result.profile,{page:'prefs',leftClosed:true}).panels.leftClosed,true);});
test('display configuration rejects cycles, unknown slots and unsupported versions',()=>{assert.equal(model.resolveUIProfile('no').ok,false);assert.equal(model.resolveUIProfile('full',{full:{...model.PROFILE_REGISTRY.full,extends:'full'}}).errorCode,'UI_PROFILE_CYCLE');assert.equal(model.validateUIProfile({...model.PROFILE_REGISTRY.full,visible:{script:true}}).ok,false);assert.equal(model.validateUIProfile({...model.PROFILE_REGISTRY.full,schemaVersion:2}).ok,false);});
test('preference migration and async failures retain the latest UI selection',async()=>{const pending=gate();let calls=0;const preferences=model.preferences({getItem:()=>JSON.stringify({version:1,singleClickEnter:true,legendCollapsed:true}),setItem:()=>++calls===1?pending.promise:Promise.resolve()});assert.equal(preferences.value.singleClickEnter,true);preferences.set('profileId','mapOnly');preferences.set('profileId','full');await preferences.flush();pending.reject(Error('old failure'));await tick();assert.equal(preferences.persistent,true);assert.equal(preferences.value.profileId,'full');});

test('failed image decoding never replaces an installed skin package',async()=>{const c=controller({assetLoader:{prepare:async()=>{throw Object.assign(Error('bad image'),{code:'SKIN_IMAGE_DECODE_FAILED'});}}});const previous={...pack(),name:'previous'};c.packs.set(previous.id,previous);assert.equal((await c.api.install(pack())).ok,false);assert.equal(c.packs.get(previous.id),previous);assert.equal(c.current.id,'builtin.starmap');c.api.destroy();});
