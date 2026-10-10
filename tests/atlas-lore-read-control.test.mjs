import test from 'node:test';
import assert from 'node:assert/strict';
import {createReferenceLorePort,atlasLoreEntryId,isAtlasLoreEntryReadable} from '../ui/atlas-reference-lore.mjs';
import {readCardLoreSupplementViaSelector} from '../index.js';
import {selectAtlasLoreSupplement} from '../src/atlas-lore-selection.ts';
import {JSDOM} from 'jsdom';
import {mountReferenceUi} from '../ui/atlas-reference-host.mjs';

function fixture(){
 let saved=0,written=0;
 const books={Book:{entries:{1:{uid:1,comment:'城市',content:'桥梁连接河两岸。',disable:false,order:80}}},Other:{entries:{1:{uid:1,comment:'森林',content:'松林位于北方。',disable:false}}}};
 const context={chatId:'A',characterId:0,chatMetadata:{world_info:'Book'},extensionSettings:{atlas_world_sim:{sqlMode:true}},characters:[],saveSettingsDebounced:()=>{saved++;}};
 const port=createReferenceLorePort(()=>context,async()=>({loadWorldInfo:async name=>structuredClone(books[name]),saveWorldInfo:async(name,data)=>{written++;books[name]=data;}}),async()=>['Other']);
 return {books,context,port,get saved(){return saved},get written(){return written}};
}

test('ATLAS exclusion persists by book and entry, without changing host activation, content or other settings',async()=>{
 const f=fixture(),original=structuredClone(f.books),id=atlasLoreEntryId('Book',1);
 await f.port.setAtlasRead(id,false);
 assert.deepEqual(f.books,original);assert.equal(f.written,0);assert.equal(f.saved,1);assert.equal(f.context.extensionSettings.atlas_world_sim.sqlMode,true);
 const rows=await f.port.read();assert.equal(rows.find(x=>x.book==='Book').enabled,true);assert.equal(rows.find(x=>x.book==='Book').atlasReadable,false);
 assert.equal(rows.find(x=>x.book==='Other').atlasReadable,true);
 const reloaded={extensionSettings:structuredClone(f.context.extensionSettings)};assert.equal(isAtlasLoreEntryReadable(reloaded,'Book',1),false);
 await f.port.setAtlasRead(id,true);assert.equal(isAtlasLoreEntryReadable(f.context,'Book',1),true);
 assert.deepEqual(f.context.extensionSettings.atlas_world_sim.excludedLoreEntries,[]);
});

test('host activation and ATLAS reading can be toggled independently',async()=>{
 const f=fixture(),id=atlasLoreEntryId('Book',1);
 await f.port.setAtlasRead(id,false);await f.port.toggle(id);
 let row=(await f.port.read()).find(x=>x.id===id);assert.equal(row.enabled,false);assert.equal(row.atlasReadable,false);
 await f.port.setAtlasRead(id,true);row=(await f.port.read()).find(x=>x.id===id);assert.equal(row.enabled,false);assert.equal(row.atlasReadable,true);
 await f.port.toggle(id);row=(await f.port.read()).find(x=>x.id===id);assert.equal(row.enabled,true);
});

test('a delayed reading toggle cannot write after switching chat, and failed persistence rolls back',async()=>{
 const f=fixture();let context=f.context,release;
 const gate=new Promise(r=>{release=r});
 const port=createReferenceLorePort(()=>context,async()=>({loadWorldInfo:async()=>{await gate;return f.books.Book;}}));
 const write=port.setAtlasRead(atlasLoreEntryId('Book',1),false);await new Promise(r=>setImmediate(r));context={...context,chatId:'B',chatMetadata:{world_info:'Book'}};release();
 await assert.rejects(write,/聊天已切换/);assert.equal(f.saved,0);
 f.context.saveSettingsDebounced=()=>{throw Error('save failed')};const previous=f.context.extensionSettings.atlas_world_sim;
 await assert.rejects(f.port.setAtlasRead(atlasLoreEntryId('Book',1),false),/save failed/);assert.equal(f.context.extensionSettings.atlas_world_sim,previous);
});

test('ordinary, geography and bootstrap selectors exclude only user-selected Atlas entries and retain full included text',async()=>{
 const previous={SillyTavern:globalThis.SillyTavern,TavernHelper:globalThis.TavernHelper,window:globalThis.window};
 const f=fixture();f.context.characters=[{data:{extensions:{world:'Book'}}}];f.books.Other.entries[1].content='长地理资料。'.repeat(3000);
 await f.port.setAtlasRead(atlasLoreEntryId('Book',1),false);
 globalThis.SillyTavern={getContext:()=>f.context};globalThis.TavernHelper={getCharWorldbookNames:async()=>['Book','Other']};globalThis.window={__atlasWorldInfoModule:{loadWorldInfo:async name=>f.books[name]}};
 try{for(const mode of ['turn','geo','bootstrap']){
  const text=await readCardLoreSupplementViaSelector({chatId:'A',characterId:0,mode,userText:'城市',assistantText:'城市',recentAssistantTexts:[]},selectAtlasLoreSupplement,()=>{});
  assert.ok(!text.includes('桥梁连接'));assert.ok(text.includes(f.books.Other.entries[1].content));assert.equal(f.books.Book.entries[1].disable,false);
 }}finally{Object.assign(globalThis,previous)}
});

test('direct map and layout UI requests obey the same independent reading flag',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'}),context={chatId:'A',chatMetadata:{atlas:{database:{data:'fixture',sha256:'a'}}},extensionSettings:{atlas_world_sim:{sqlMode:true}},chat:[]};
 const sent=[],state={chatId:'A',binding:{branchId:'main',enabled:true},stateData:{revision:1},receipts:[],panelOpen:true};
 const api={request:async(method,path,body)=>{
  if(path==='/settings')return {status:200,body:{ok:true,data:{}}};
  if(['/sql/chat/map/layout','/sql/chat/map/build'].includes(path)){sent.push(body);throw Error('fixture stop');}
  const items=body?.kind==='map'?[{mapId:'world',name:'世界',kind:'world',parentMapId:null,containerLocationId:null,points:[]}]:[];
  return {status:200,body:{ok:true,data:{items,revision:1,branchId:'main',metadata:{}}}};
 }};
 const core={getState:()=>state,setPage:()=>{},refresh:async()=>{}};
 const render=mountReferenceUi({root:dom.window.document.getElementById('root'),core,api,getContext:()=>context,lorePort:{read:async()=>[
  {content:'included geography',enabled:true,atlasReadable:true},
  {content:'excluded only for Atlas',enabled:true,atlasReadable:false},
  {content:'host disabled',enabled:false,atlasReadable:true}]},loadSqlRuntime:async()=>({})});
 const bridge=dom.window.document.getElementById('atlas-extension-panel-root').firstChild.__atlasHost;
 try{await bridge.boot();for(const action of ['build','layout'])await assert.rejects(bridge[action]('world'),/fixture stop/);
  assert.equal(sent.length,2);for(const body of sent)assert.equal(body.loreSupplement,'included geography');
 }finally{await render.dispose();dom.window.close()}
});
