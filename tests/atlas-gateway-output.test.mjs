import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {callAtlasWorldTurnApi} from '../src/atlas-api-client.ts';
import {createStProxyFetch} from '../src/atlas-proxy-fetch.ts';
import {createTavernMainFetch,createTavernProfileFetch} from '../src/atlas-host-connections.ts';
import {createSqlModelPort} from '../src/atlas-sql-model-port.ts';
import {createDefaultSettingsV2,applySettingsCommand,resolveWorldTurnPreset,sanitizeSettingsV2} from '../src/atlas-settings.ts';
import {referencePresetDocument,referenceSettingsCommands} from '../ui/atlas-reference-presets.mjs';
import {buildStagePrompt} from '../src/atlas-ops-prompts.ts';

const content='{"op":"noop","why":"验收传输"}';
const carrier='emit_complete_response_0df06b26e8cb1be7b390c5c9';
const envelope=(name=carrier,args=JSON.stringify({content}))=>({choices:[{message:{content:null,tool_calls:[{type:'function',function:{name,arguments:args}}]},finish_reason:'tool_calls'}]});
const preset={name:'fixture',endpoint:'https://example.test/v1',model:'fixture',apiKey:'fixture',timeoutMs:1000,maxTokens:0};
const prompt={injectionText:'Return operations',userText:'',assistantText:''};

test('main adapter reads TavernHelper detail results and reasoning without stringifying objects',async()=>{
 for (const detail of [{content}, {content:'',reasoning:content},
   {content:'',tool_calls:envelope().choices[0].message.tool_calls},envelope()]) {
  let calls=0;
  const fetchFn=createTavernMainFetch({getTavernHelper:()=>({generateRaw:async opts=>{
    calls++;assert.equal(opts.should_return_reasoning,true);return detail;
  }})});
  const result=await callAtlasWorldTurnApi({...preset,connectionMode:'main'},prompt,{fetchFn});
  assert.equal(result.ok,true);assert.equal(result.text,content);assert.equal(calls,1);
  assert.equal(result.status,null,'宿主助手结果不虚构供应商 HTTP 状态');
 }
});

test('host empty/unsupported replies are failures with accurate origin and no phantom HTTP success or retry',async()=>{
 for(const detail of ['', {content:''}, {unrecognized:'data'}, envelope('execute_code')]) {
  let calls=0;
  const fetchFn=createTavernMainFetch({getTavernHelper:()=>({generateRaw:async()=>{calls++;return detail;}})});
  const result=await callAtlasWorldTurnApi({...preset,connectionMode:'main'},prompt,{fetchFn});
  assert.equal(result.ok,false);assert.equal(result.code,'RESPONSE_MALFORMED');assert.equal(calls,1);
  assert.match(result.message,/酒馆主 API/);assert.doesNotMatch(result.message,/HTTP 200|通常是模型名/);
  assert.equal(result.status,undefined);
 }
});

test('main preserves explicitly requested response tool definitions and decodes only that tool',async()=>{
 const responseTool={name:'emit_fixture',description:'data',parameters:{type:'object'}};
 const fetchFn=createTavernMainFetch({getTavernHelper:()=>({generateRaw:async opts=>{
  assert.deepEqual(opts.tools,[{type:'function',function:responseTool}]);assert.equal(opts.tool_choice,'auto');
  return {content:'',tool_calls:envelope(responseTool.name).choices[0].message.tool_calls};
 }})});
 const result=await callAtlasWorldTurnApi({...preset,connectionMode:'main'},prompt,{fetchFn,responseTool});
 assert.equal(result.ok,true);assert.equal(result.text,content);
});

test('unlimited and explicit large values survive UI/settings save and reload without a token ceiling',()=>{
 for(const maxTokens of [0,262144]){
  const settings=createDefaultSettingsV2(),doc=referencePresetDocument(settings),c=doc.connections[0];
  Object.assign(c,{url:preset.endpoint,model:preset.model,maxTokens});
  const result=applySettingsCommand(settings,{action:'batch',commands:referenceSettingsCommands(doc,settings,{kind:'save',type:'connection',id:c.id})});
  assert.equal(result.ok,true);const normalized=sanitizeSettingsV2(JSON.parse(JSON.stringify(result.settings))).settings;
  normalized.activeApiPresetId=normalized.apiPresets[0].id;
  assert.equal(resolveWorldTurnPreset(normalized).maxTokens,maxTokens);
  assert.equal(referencePresetDocument(normalized).connections[0].maxTokens,maxTokens);
 }
});

test('zero and absent limits omit max_tokens through the real API client and Tavern proxy; large values pass unchanged',async()=>{
 for(const maxTokens of [0,undefined,262144]){
  let body;const fetchFn=createStProxyFetch({getContext:()=>({getRequestHeaders:()=>({})}),fetchFn:async(url,init)=>{body=JSON.parse(init.body);return Response.json(envelope());}});
  const result=await callAtlasWorldTurnApi({...preset,maxTokens},prompt,{fetchFn});
  assert.equal(result.ok,true);assert.equal(result.text,content);
  if(maxTokens)assert.equal(body.max_tokens,maxTokens);else assert.equal(Object.hasOwn(body,'max_tokens'),false);
 }
});

test('Kemini transport accepts random and namespaced carriers as data, including restored ordinary replies',async()=>{
 for(const payload of [envelope(),envelope('functions:'+carrier,{content}),{choices:[{message:{content},finish_reason:'stop'}]}]){
  const result=await callAtlasWorldTurnApi(preset,prompt,{fetchFn:async()=>Response.json(payload)});
  assert.equal(result.ok,true);assert.equal(result.text,content);
 }
});

test('transport cannot bypass malformed/multiple/unknown function or upstream truncation checks',async()=>{
 const multiple=envelope();multiple.choices[0].message.tool_calls.push(multiple.choices[0].message.tool_calls[0]);
 for(const payload of [envelope('execute_code'),envelope(carrier,'{broken'),envelope(carrier,'{"content":42}'),multiple]){
  const result=await callAtlasWorldTurnApi(preset,prompt,{fetchFn:async()=>Response.json(payload)});assert.equal(result.ok,false);assert.equal(result.code,'RESPONSE_MALFORMED');
 }
 const truncated=envelope();truncated.choices[0].finish_reason='length';
 const result=await callAtlasWorldTurnApi(preset,prompt,{fetchFn:async()=>Response.json(truncated)});
 assert.equal(result.ok,false);assert.equal(result.code,'RESPONSE_MALFORMED');assert.match(result.message,/长度截断/);
});

test('host main and profile paths add no Atlas output cap and accept carrier restoration',async()=>{
 let main,profile;const mainFetch=createTavernMainFetch({getTavernHelper:()=>({generateRaw:async opts=>{main=opts;return content;}})});
 assert.equal((await callAtlasWorldTurnApi({...preset,connectionMode:'main'},prompt,{fetchFn:mainFetch})).ok,true);assert.equal(Object.hasOwn(main,'max_tokens'),false);
 const profileFetch=createTavernProfileFetch({getContext:()=>({ConnectionManagerRequestService:{sendRequest:async(id,messages,max)=>{profile=max;return {result:envelope()};}}}),getTavernHelper:()=>({})});
 const result=await callAtlasWorldTurnApi({...preset,connectionMode:'profile',profileId:'p'},prompt,{fetchFn:profileFetch});
 assert.equal(result.ok,true);assert.equal(result.text,content);assert.equal(profile,undefined);
});

test('SQL stage receives only the carrier content and does not reapply its stage output budget',async()=>{
 for(const phase of ['observe','geography','repair']){
 const settings={...createDefaultSettingsV2(),activeApiPresetId:'p',apiPresets:[{...preset,id:'p',temperature:.7,updatedAt:1}]};let body;
 const port=createSqlModelPort({readSettings:async()=>settings,fetchFn:async(url,init)=>{body=JSON.parse(init.body);return Response.json(envelope());}});
 const request=buildStagePrompt({phase,userSource:'测试',assistantSource:'验收'});request.maxTokens=4096;
 assert.equal((await port.request(request)).text,content);assert.equal(Object.hasOwn(body,'max_tokens'),false);
 }
});

test('actual reference editor defaults to unspecified and preserves large and zero values across export/import',async()=>{
 const dom=new JSDOM('',{runScripts:'outside-only'});
 dom.window.eval(readFileSync(new URL('../ui/atlas-reference/js/presets.js',import.meta.url),'utf8'));
 const store=dom.window.AtlasPresetStore.create([],{storage:null,onPersist:async()=>{}});
 assert.equal(store.draft('connection').maxTokens,0);
 for(const maxTokens of [262144,0]){store.draft('connection').maxTokens=maxTokens;await store.save('connection');assert.equal(store.status.error,'');}
 const exported=store.exportValue('all');assert.equal(exported.connections[0].maxTokens,0);
 assert.equal(store.parseImport(exported).connections[0].maxTokens,0);
 const tokens=readFileSync(new URL('../ui/atlas-reference/js/preset-ui.js',import.meta.url),'utf8').match(/id="connectionTokens"[^>]+/)[0];
 assert.ok(!tokens.includes('max='));assert.ok(tokens.includes('min="0"'));dom.window.close();
});
