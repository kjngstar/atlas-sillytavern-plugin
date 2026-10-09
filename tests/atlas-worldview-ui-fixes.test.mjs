import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {callAtlasWorldTurnApi} from '../src/atlas-api-client.ts';
import {createStProxyFetch} from '../src/atlas-proxy-fetch.ts';
import {selectAtlasLoreSupplement} from '../src/atlas-lore-selection.ts';
import {createDefaultSettingsV2,applySettingsCommand,resolveWorldTurnPreset} from '../src/atlas-settings.ts';
import {referencePresetDocument,referenceSettingsCommands} from '../ui/atlas-reference-presets.mjs';
import {mountReferenceUi} from '../ui/atlas-reference-host.mjs';
import {projectReferenceData} from '../ui/atlas-reference-data.mjs';

const tool={name:'emit_atlas_operations',description:'Return operations',parameters:{type:'object',properties:{content:{type:'string'}},required:['content']}};
const preset={endpoint:'https://example.test/v1',model:'test',apiKey:'test-only',systemPrompt:'Return operations',timeoutMs:1000};
const prompt={injectionText:'test',userText:'',assistantText:''};
test('function response travels through the Tavern proxy and is read without treating arguments as prose',async()=>{
 let body,url;const proxy=createStProxyFetch({getContext:()=>({getRequestHeaders:()=>({'X-CSRF-Token':'test'})}),fetchFn:async(u,o)=>{url=u;body=JSON.parse(o.body);return new Response(JSON.stringify({choices:[{message:{content:null,tool_calls:[{type:'function',function:{name:tool.name,arguments:JSON.stringify({content:'{"op":"noop"}'})}}]},finish_reason:'tool_calls'}]}));}});
 const result=await callAtlasWorldTurnApi(preset,prompt,{fetchFn:proxy,responseTool:tool});
 assert.equal(result.ok,true);assert.equal(result.text,'{"op":"noop"}');assert.equal(url,'/api/backends/chat-completions/generate');assert.equal(body.tools[0].function.name,tool.name);assert.equal(body.tool_choice,'auto');
});
test('unknown, multiple and malformed tool replies are rejected even when accompanied by plausible text',async()=>{
 for(const calls of [[{function:{name:'other',arguments:'{"content":"{\\"op\\":\\"noop\\"}"}'}}],[{function:{name:tool.name,arguments:'bad'}}],[{function:{name:tool.name,arguments:'{}'}},{function:{name:tool.name,arguments:'{}'}}]]){
  const result=await callAtlasWorldTurnApi(preset,prompt,{responseTool:tool,fetchFn:async()=>new Response(JSON.stringify({choices:[{message:{content:'{"op":"noop"}',tool_calls:calls}}]}))});assert.equal(result.ok,false);assert.equal(result.code,'RESPONSE_MALFORMED');
 }
});
test('long character biographies do not push explicit world locations out of the source budget',()=>{
 const result=selectAtlasLoreSupplement({entries:[{uid:'bio',title:'角色档案',enabled:true,content:'人物'.repeat(4000)},{uid:'world',title:'世界观',enabled:true,content:'测试帝国，无电力'},{uid:'places',title:'主要剧情地点',enabled:true,content:'帝都、农业城、集镇、两层住所'}],includeAllEnabled:true,prioritizeGeography:true,maxChars:6000,mode:'turn',chatKeywords:new Set(),sceneKeywords:new Set()});
 assert.ok(result.text.includes('两层住所'));assert.ok(result.text.includes('无电力'));assert.ok(result.text.length<=6000);assert.equal(result.selectedUids[0],'?:world');
});
test('function output selection survives UI save, settings normalization and transport resolution',()=>{
 const settings=createDefaultSettingsV2();const doc=referencePresetDocument(settings);const c=doc.connections[0];Object.assign(c,{toolCalling:true,url:'https://example.test/v1',model:'test',provider:'openai-compatible'});
 const commands=referenceSettingsCommands(doc,settings,{kind:'save',type:'connection',id:c.id});const saved=applySettingsCommand(settings,{action:'batch',commands});assert.equal(saved.ok,true);assert.equal(resolveWorldTurnPreset(saved.settings).toolCalling,true);assert.equal(referencePresetDocument(saved.settings).connections[0].toolCalling,true);
});
test('model listing uses the host CSRF proxy, preserves its endpoint prefix, deduplicates IDs and reports absent support',async()=>{
 const dom=new JSDOM('<div id="root"></div>'),root=dom.window.document.querySelector('#root');let body,path;
 const render=mountReferenceUi({root,core:{getState:()=>({chatId:null,panelOpen:false}),setPage(){}},api:{request:async()=>({status:200,body:{ok:true,data:{}}})},getContext:()=>({chatMetadata:{},getRequestHeaders:()=>({'X-CSRF-Token':'fixture'})}),fetchFn:async(u,o)=>{path=u;body=JSON.parse(o.body);assert.equal(o.headers['X-CSRF-Token'],'fixture');return new Response(JSON.stringify({data:[{id:'m2'},{id:'m1'},{id:'m2'}]}));}});
 try{const bridge=root.firstChild.__atlasHost;assert.deepEqual(await bridge.fetchModels({url:'https://example.test/custom/v1/chat/completions',apiKey:'fixture'}),['m1','m2']);assert.equal(path,'/api/backends/chat-completions/status');assert.equal(body.custom_url,'https://example.test/custom/v1');assert.equal(body.custom_include_headers,'Authorization: Bearer fixture');await assert.rejects(bridge.fetchModels({provider:'sillytavern'}),/酒馆 API 设置/);}finally{await render.dispose();dom.window.close();}
});
test('mobile vehicles have no fixed geographic footprint and journeys link to their location interior',()=>{
 const view=items=>({items});const map={mapId:'world',parentMapId:null,connectionQuality:'root',points:[],name:'测试世界'};
 const result=projectReferenceData({mapView:view([map]),catalogView:view([{entityId:'cart',entityKind:'location',locationKind:'vehicle',mobility:'mobile',name:'测试马车'}]),flowView:view([{kind:'journey',flowId:'j',moverEntityId:'cart',mapId:'world',status:'moving',progress:0.25,path:{points:[{x:0,y:0},{x:1,y:1}],units:'cells'}}]),sceneView:view([])});
 assert.equal(result.LOCATIONS[0].tag,'移动载具');assert.equal(result.JOURNEYS.world[0].entityKind,'vehicle');assert.equal(result.JOURNEYS.world[0].entityId,'cart');assert.equal(result.JOURNEYS.world[0].progress,0.25);
});
