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
