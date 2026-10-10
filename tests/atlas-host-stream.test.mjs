import test from 'node:test';
import assert from 'node:assert/strict';
import {createTavernMainFetch} from '../src/atlas-host-connections.ts';
import {assembleHostStream} from '../src/atlas-host-stream.ts';
import {sanitizeDiagnostic} from '../src/atlas-diagnostics.ts';
import {atlasChatTailInjectionOptions,createLorebookPort} from '../index.js';

const reply='{"op":"noop"}', carrier='emit_complete_response_0df06b26e8cb1be7b390c5c9';
const event=value=>`data: ${JSON.stringify(value)}\n\n`;
const delta=(value,finish_reason=null)=>({choices:[{index:0,delta:value,finish_reason}]});
const init={body:JSON.stringify({messages:[{role:'user',content:'中性世界资料'}],max_tokens:0})};
function bridge(body,{stream=true,hook,controller,response}={}){
 const sent=[];
 const ctx={mainApi:'openai',chatCompletionSettings:{stream_openai:stream},getChatCompletionModel:()=> 'fixture',getRequestHeaders:()=>({}),
  eventTypes:{CHAT_COMPLETION_SETTINGS_READY:'ready'},eventSource:{emit:async(type,payload)=>{assert.equal(type,'ready');await hook?.(payload)}},
  ChatCompletionService:{presetToGeneratePayload:async(a,b,p)=>p}};
 return {sent,run:async()=>{const fetch=createTavernMainFetch({getContext:()=>ctx,getTavernHelper:()=>null,fetchFn:async(url,opts)=>{
  sent.push(JSON.parse(opts.body));return response??new Response(body,{headers:{'Content-Type':'text/event-stream'}});
 }});return (await fetch('atlas://host',{...init,...(controller?{signal:controller.signal}:{})})).json()}};
}

test('main streaming follows host setting, preserves settings hook and aggregates all content across SSE frames',async()=>{
 const body=': ping\r\n\r\n'+event(delta({content:'{"op":'})).replaceAll('\n','\r\n')+event(delta({content:'"noop"}'}))+event(delta({},'stop'))+'data: [DONE]\n\n';
 const b=bridge(body,{hook:p=>{p.fixtureHook=true}}),result=await b.run();
 assert.equal(b.sent[0].stream,true);assert.equal(b.sent[0].fixtureHook,true);assert.deepEqual(b.sent[0].messages,JSON.parse(init.body).messages);
 assert.equal(result.choices[0].message.content,reply);assert.equal(result.hostTransport.streamed,true);assert.equal(result.hostTransport.streamEventCount,3);assert.equal(result.hostTransport.streamComplete,true);
 const safe=sanitizeDiagnostic({code:'MODEL_HOST_COMPLETE',level:'info',source:'model',operation:'generation',phase:'response',outcome:'success',details:result.hostTransport});
 assert.equal(safe.details.streamed,true);assert.equal(safe.details.streamEventCount,3);
});

test('fragmented gateway function name and arguments are assembled as data, including unicode split at byte boundaries',async()=>{
 const args=JSON.stringify({content:'{"op":"noop","why":"中性测试"}'});
 const body=event(delta({tool_calls:[{index:0,type:'function',function:{name:carrier.slice(0,15),arguments:args.slice(0,9)}}]}))
  +event(delta({tool_calls:[{index:0,function:{name:carrier.slice(15),arguments:args.slice(9)}}]}))+event(delta({},'tool_calls'))+'data: [DONE]\n\n';
 const bytes=new TextEncoder().encode(body),response=new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.slice(i,i+7));c.close()}}));
 const result=await bridge('',{response}).run();
 assert.equal(result.choices[0].message.content,JSON.parse(args).content);assert.equal(result.hostTransport.transportCarrier,true);assert.equal(result.hostTransport.toolCallCount,1);
});

test('Google streaming ignores thought text and combines visible parts before submission',async()=>{
 const body=event({candidates:[{content:{parts:[{thought:true,text:'private reasoning'},{text:'{"op":'}]}}]})
  +event({candidates:[{content:{parts:[{text:'"noop"}'}]},finishReason:'STOP'}]});
 const result=await bridge(body).run();assert.equal(result.choices[0].message.content,reply);assert.equal(result.hostTransport.thoughtPartCount,1);
 assert.ok(!JSON.stringify(result.hostTransport).includes('private reasoning'));
});

test('incomplete, malformed, filtered, truncated and unknown-tool streams cannot commit even a complete-looking operation',async()=>{
 const cases=[
  [event(delta({content:reply})),'HOST_STREAM_INCOMPLETE'],
  ['data: {broken}\n\n'+'data: [DONE]\n\n','HOST_INVALID_JSON'],
  [event(delta({content:reply},'length')),'HOST_EMPTY_RESPONSE'],
  [event({candidates:[{content:{parts:[{text:reply}]},finishReason:'MAX_TOKENS'}]}),'HOST_EMPTY_RESPONSE'],
  [event(delta({content:reply,refusal:'blocked'},'content_filter')),'HOST_EMPTY_RESPONSE'],
  [event(delta({tool_calls:[{index:0,function:{name:'run_code',arguments:JSON.stringify({content:reply})}}]},'tool_calls')),'HOST_EMPTY_RESPONSE'],
  [event({error:{message:'Prompt was blocked due to : SAFETY'}}),'HOST_HTTP_FAILED'],
 ];
 for(const [body,reason]of cases){const result=await bridge(body).run();assert.equal(result.error.reasonCode,reason);assert.equal(result.choices,undefined)}
 assert.throws(()=>assembleHostStream(event(delta({content:reply}))+'data: [DONE]\n\n'+event(delta({content:'extra'}))),/HOST_STREAM_INVALID/);
});

test('host nonstream preference and gateway-rewritten JSON remain supported; no hidden second request',async()=>{
 const b=bridge(JSON.stringify({choices:[{message:{content:reply},finish_reason:'stop'}]}),{stream:false}),result=await b.run();
 assert.equal(b.sent[0].stream,false);assert.equal(result.choices[0].message.content,reply);assert.equal(result.hostTransport.streamed,false);assert.equal(b.sent.length,1);
 const rewritten=await bridge(JSON.stringify({choices:[{message:{content:reply},finish_reason:'stop'}]})).run();assert.equal(rewritten.choices[0].message.content,reply);
});

test('aborted settings hook prevents sending and aborted body cannot return successful operations',async()=>{
 const controller=new AbortController(),b=bridge('',{controller,hook:()=>controller.abort()}),result=await b.run();assert.equal(b.sent.length,0);assert.equal(result.error.reasonCode,'HOST_RAW_REQUEST_FAILED');
 const second=new AbortController(),response={text:async()=>{second.abort();return JSON.stringify({choices:[{message:{content:reply}}]})}},r=await bridge('',{controller:second,response}).run();assert.equal(r.choices,undefined);
});

test('host-provided named injection enums override fallback and lore injection/clearing both use chat tail',async()=>{
 const ctx={extensionPromptTypes:{IN_CHAT:7},extensionPromptRoles:{SYSTEM:3},chatId:'A',setExtensionPrompt:(...args)=>calls.push(args)},calls=[];
 assert.deepEqual(atlasChatTailInjectionOptions(ctx),{position:7,depth:0,role:3});assert.deepEqual(atlasChatTailInjectionOptions({}),{position:1,depth:0,role:0});
 const port=createLorebookPort(()=>ctx,{},async()=>({worldId:'W'}));await port.injectTurn('k','context');await port.injectTurn('k','');
 assert.deepEqual(calls,[['k','context',7,0,false,3],['k','',7,0,false,3]]);
});
