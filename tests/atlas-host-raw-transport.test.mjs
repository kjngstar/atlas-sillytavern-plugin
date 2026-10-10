import test from 'node:test';
import assert from 'node:assert/strict';
import {createTavernMainFetch} from '../src/atlas-host-connections.ts';
import {extractAssistantText} from '../src/atlas-api-client.ts';
import {sanitizeDiagnostic} from '../src/atlas-diagnostics.ts';

const name='emit_complete_response_0df06b26e8cb1be7b390c5c9';
const content='{"op":"noop"}';
const input={messages:[{role:'user',content:'资料中的 <% invalid\\n <user> %> 只作为数据'}],max_tokens:0};
const init={method:'POST',body:JSON.stringify(input)};
const raw={choices:[{message:{content:null},finish_reason:'stop'}],responseContent:{parts:[{functionCall:{name,args:{content}}}]}};

test('safe transport provenance survives diagnostic redaction without retaining prompts or arbitrary strings',()=>{
 const entry=sanitizeDiagnostic({level:'info',source:'model',code:'MODEL_HOST_COMPLETE',operation:'generation',phase:'response',outcome:'success',details:{transport:'chat-completions-raw',hostHttpStatus:200,toolCallCount:1,transportCarrier:true,finishReason:'stop',prompt:'private',hostMainApi:'openai'}});
 assert.equal(entry.details.transport,'chat-completions-raw');assert.equal(entry.details.hostHttpStatus,200);assert.equal(entry.details.toolCallCount,1);assert.equal(entry.details.finishReason,'stop');assert.equal(entry.details.prompt,undefined);
 const bad=sanitizeDiagnostic({...entry,details:{transport:'private-string',finishReason:'private-string',hostMainApi:'private-string'}});assert.equal(bad.details,undefined);
});

test('main raw bridge preserves prebuilt sources, current host routing, gateway fetch wrapper and abort signal',async()=>{
 let generated,wire,calls=0;const signal=new AbortController().signal;
 const context={mainApi:'openai',getChatCompletionModel:()=> 'gemini-test',getRequestHeaders:()=>({'X-CSRF-Token':'fixture'}),ChatCompletionService:{
  presetToGeneratePayload:async(preset,overrides,payload)=>{generated=payload;return {...payload,custom_url:'https://fixture.invalid/v1',chat_completion_source:'custom'};}
 }};
 const fetchFn=createTavernMainFetch({getContext:()=>context,getTavernHelper:()=>({generateRaw:()=>{throw Error('must not reexecute templates');}}),fetchFn:async(url,opts)=>{
  calls++;assert.equal(url,'/api/backends/chat-completions/generate');assert.equal(opts.signal,signal);assert.equal(opts.headers['X-CSRF-Token'],'fixture');wire=JSON.parse(opts.body);return Response.json(raw);
 }});
 const response=await fetchFn('atlas://host',{...init,signal});const json=await response.json();
 assert.equal(response.ok,true);assert.equal(json.choices[0].message.content,content);assert.deepEqual(generated.messages,input.messages);
 assert.equal(generated.model,'gemini-test');assert.equal(Object.hasOwn(generated,'max_tokens'),false);assert.equal(wire.chat_completion_source,'custom');assert.equal(calls,1);
 assert.equal(json.hostTransport.transportCarrier,true);assert.equal(json.hostTransport.toolCallCount,1);assert.equal(json.hostTransport.hostHttpStatus,200);
});

test('native Google and Tavern wrapped carriers decode as data; unknown or multiple tools never execute',()=>{
 assert.equal(extractAssistantText(raw),content);
 assert.equal(extractAssistantText({candidates:[{content:raw.responseContent}]}),content);
 for(const parts of [[{functionCall:{name:'run_code',args:{content}}}],[...raw.responseContent.parts,...raw.responseContent.parts]])assert.equal(extractAssistantText({responseContent:{parts}}),null);
});

test('empty raw response retains finish reason without inventing success or losing diagnostic information',async()=>{
 const fetchFn=createTavernMainFetch({getTavernHelper:()=>null,getContext:()=>({mainApi:'openai',getChatCompletionModel:()=> 'fixture',getRequestHeaders:()=>({}),ChatCompletionService:{presetToGeneratePayload:async(a,b,c)=>c}}),fetchFn:async()=>Response.json({choices:[{message:{content:''},finish_reason:'content_filter'}]})});
 const response=await fetchFn('atlas://host',init),json=await response.json();
 assert.equal(response.ok,false);assert.equal(json.error.reasonCode,'HOST_EMPTY_RESPONSE');assert.equal(json.hostTransport.finishReason,'content_filter');assert.equal(json.hostTransport.toolCallCount,0);
});
