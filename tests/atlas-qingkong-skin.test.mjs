import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readSkinPack,SKIN_PACK_LIMITS} from '../ui/atlas-skin-pack.mjs';
import '../ui/atlas-reference/js/skin-runtime.js';

const directory=new URL('../skins/qingkong-xinjian/',import.meta.url);
const load=async()=>readSkinPack(await readFile(new URL('Atlas-QingkongXinjian-1.0.0.zip',directory)));

test('Qingkong install ZIP contains all 18 supported artwork roles within the image budget',async()=>{
  const pack=await load();
  assert.equal(pack.id,'user.qingkong-xinjian');
  assert.equal(pack.name,'晴空信笺');
  assert.equal(pack.files.length,11);
  assert.deepEqual(Object.keys(pack.theme.assets).sort(),[...AtlasSkinRuntime.ASSET_ROLES].sort());
  assert.equal(new Set(Object.values(pack.theme.assets)).size,11);
  assert.ok(pack.files.reduce((n,f)=>n+f.width*f.height,0)<SKIN_PACK_LIMITS.pixels);
  assert.ok((await readFile(new URL('Atlas-QingkongXinjian-1.0.0.zip',directory))).length<512*1024);
});

test('Qingkong shipped ZIP matches the checked-in manifest and exact artwork bytes',async()=>{
  const pack=await load();
  const manifest=JSON.parse(await readFile(new URL('manifest.json',directory),'utf8'));
  const provenance=JSON.parse(await readFile(new URL('asset-build.json',directory),'utf8'));
  assert.deepEqual(pack.theme,AtlasSkinRuntime.resolve(manifest.theme).skin);
  for(const file of pack.files){
    const bytes=await readFile(new URL(file.path,directory));
    assert.deepEqual(file.bytes,new Uint8Array(bytes));
    const recorded=provenance.runtimeAssets.find(row=>row.path===file.path);
    assert.equal(recorded.sha256,createHash('sha256').update(bytes).digest('hex'));
    assert.equal(recorded.width,file.width);assert.equal(recorded.height,file.height);
  }
});

test('Qingkong stationery, selection, primary controls and status text keep readable contrast',async()=>{
  const {theme}=await load(),tokens=theme.tokens;
  const luminance=hex=>hex.slice(1).match(/../g).map(s=>parseInt(s,16)/255)
    .map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4)
    .reduce((n,x,i)=>n+x*[.2126,.7152,.0722][i],0);
  const pairs=[['ui.text.primary','ui.panel.bg'],['ui.text.muted','ui.panel.bg'],
    ['ui.text.onAccent','ui.accent'],['ui.selection.text','ui.selection.bg'],
    ['map.label.primary','map.label.background'],
    ...['info','success','warning','error'].map(role=>['ui.status.'+role,'ui.panel.bg'])];
  for(const [fg,bg] of pairs){
    const a=luminance(tokens[fg]),b=luminance(tokens[bg]);
    assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,fg+' contrast');
  }
});
