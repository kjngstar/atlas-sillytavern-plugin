/**
 * atlas-host-connections.ts — 0.9.13 酒馆主 API / 酒馆连接预设 适配层（全抄 shujuku 干法）。
 *
 * shujuku 参照：src/data/gateways/ai-gateway.ts + src/service/ai/api-call.ts
 * （sendConnectionManagerRequestWithProfileSwitch_ACU 的串行队列 + /profile 切换恢复语义）。
 *
 * 引擎核心 callAtlasWorldTurnApi 对 main / profile 模式发 POST atlas://host（body 含
 * xAtlasConnectionMode / xAtlasProfileId 保留字段）。本模块的 fetch 适配器拦截该请求：
 * - main   → TavernHelper.generateRaw({ ordered_prompts, max_tokens, should_stream:false })
 * - profile→ /profile 斜杠切换 + ConnectionManagerRequestService.sendRequest + 恢复
 * 两者都把宿主结果包回 OpenAI 形状的 Response-like，引擎零改动。
 *
 * 宿主侧失败返回带来源标记的本地错误，不能冒充上游 HTTP 200 成功。
 */

import { extractAssistantText } from './atlas-api-client.ts';
import { assembleHostStream } from './atlas-host-stream.ts';

/** Response-like 最小实现：引擎只用 ok / status / text()；日志层用 clone().text()。 */
interface AtlasHostResponseLike {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
  clone: () => { text: () => Promise<string> };
}

function toResponse(like: AtlasHostResponseLike): Response {
  // 引擎消费面只触 ok / status / text / json / clone().text()，零改动复用引擎路径。
  return like as unknown as Response;
}

function textResponse(text: string, hostTransport?: Record<string, unknown>): Response {
  const body = JSON.stringify({ choices: [{ message: { content: text }, ...(typeof hostTransport?.finishReason==='string'?{finish_reason:hostTransport.finishReason}:{}) }], ...(hostTransport ? {hostTransport} : {}) });
  return toResponse({
    ok: true,
    status: 200,
    text: async () => body,
    json: async () => JSON.parse(body),
    clone: () => ({ text: async () => body }),
  });
}

/** 502 是适配层状态，不代表已观察到模型服务商的 HTTP 状态。 */
function hostErrorJsonResponse(message: string, code = "API_REQUEST_FAILED", reasonCode = "HOST_GENERATION_FAILED", hostTransport?: Record<string, unknown>): Response {
  const body = JSON.stringify({ error: { message, code, reasonCode, origin: "atlas-host", retryable: false }, ...(hostTransport ? {hostTransport} : {}) });
  return toResponse({
    ok: false,
    status: 502,
    text: async () => body,
    json: async () => JSON.parse(body),
    clone: () => ({ text: async () => body }),
  });
}

interface HostRequestPayload {
  messages?: unknown;
  max_tokens?: unknown;
  xAtlasConnectionMode?: unknown;
  xAtlasProfileId?: unknown;
  tools?: Array<{ type: string; function: { name: string; parameters?: unknown } }>;
  tool_choice?: unknown;
}

/** 酒馆助手新版返回详情对象；保持工具信封为数据，绝不执行工具。 */
function hostAssistantText(response: unknown, responseTool?: string): string | null {
  if (typeof response === "string") return response;
  if (!response || typeof response !== "object") return null;
  const detail = response as { content?: unknown; reasoning?: unknown; tool_calls?: unknown };
  if (Array.isArray(detail.tool_calls) || typeof detail.reasoning === "string") {
    return extractAssistantText({ choices: [{ message: {
      content: detail.content, reasoning_content: detail.reasoning, tool_calls: detail.tool_calls,
    } }] }, responseTool);
  }
  return extractAssistantText(response, responseTool);
}

function parseHostPayload(init?: RequestInit): HostRequestPayload | null {
  if (typeof init?.body !== "string" || !init.body.trimStart().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(init.body);
    return parsed && typeof parsed === "object" ? (parsed as HostRequestPayload) : null;
  } catch {
    return null;
  }
}

function orderedPromptsOf(payload: HostRequestPayload): Array<{ role: string; content: string }> {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  return messages
    .filter((m): m is { role: string; content: string } =>
      !!m && typeof m === "object" && typeof (m as { role?: unknown }).role === "string" && typeof (m as { content?: unknown }).content === "string")
    .map((m) => ({ role: m.role, content: m.content }));
}

/** TavernHelper 可用性（照抄 shujuku isGenerateRawAvailable_ACU）。 */
export function isTavernMainAvailable(getHost: () => unknown): boolean {
  const helper = getHost() as { generateRaw?: unknown } | null | undefined;
  return !!helper && typeof helper.generateRaw === "function";
}

/** ConnectionManagerRequestService 可用性（照抄 shujuku isConnectionManagerAvailable_ACU）。 */
export function isConnectionManagerAvailable(getContext: () => unknown): boolean {
  const ctx = getContext() as { ConnectionManagerRequestService?: { sendRequest?: unknown } } | null | undefined;
  return !!ctx?.ConnectionManagerRequestService && typeof ctx.ConnectionManagerRequestService.sendRequest === "function";
}

/** 连接管理器 profile 列表（照抄 shujuku getConnectionManagerProfiles_ACU）。 */
export function getConnectionManagerProfiles(getContext: () => unknown): Array<{ id: string; name: string }> {
  const ctx = getContext() as { extensionSettings?: { connectionManager?: { profiles?: unknown } } } | null | undefined;
  const profiles = ctx?.extensionSettings?.connectionManager?.profiles;
  if (!Array.isArray(profiles)) return [];
  return profiles
    .filter((p): p is { id: string; name: string } => !!p && typeof p === "object" && typeof (p as { id?: unknown }).id === "string")
    .map((p) => ({ id: p.id, name: String(p.name ?? p.id) }));
}

export interface TavernMainFetchDeps {
  /** 通常 = () => globalThis.TavernHelper；测试注入 fake。 */
  getTavernHelper: () => unknown;
  /** 新版酒馆原始 Chat Completion 通道；不让已装配的资料再次执行 EJS。 */
  getContext?: () => unknown;
  /** 在发送时查找当前 fetch，保留外部脚本网关的包装链。 */
  fetchFn?: typeof fetch;
}

interface MainContext {
  mainApi?: string;
  chatCompletionSettings?: Record<string, unknown>;
  getChatCompletionModel?: () => string;
  getRequestHeaders?: () => Record<string, string>;
  eventTypes?: Record<string, string>;
  event_types?: Record<string, string>;
  eventSource?: { emit: (event: string, payload: Record<string, unknown>) => Promise<unknown> };
  ChatCompletionService?: {
    presetToGeneratePayload?: (preset: Record<string, unknown>, overrides: Record<string, unknown>, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
}

/** Structural diagnostics only: never retain prompt, reply, error text or signatures. */
export function summarizeHostResponse(data: any, hostHttpStatus: number, responseBytes: number): Record<string, unknown> {
  const candidate=data?.candidates?.[0],message=data?.choices?.[0]?.message;
  const parts=data?.responseContent?.parts ?? candidate?.content?.parts;
  const googleParts=Array.isArray(parts)?parts:[];
  const calls=message?.tool_calls ?? googleParts.filter((part:any)=>part?.functionCall).map((part:any)=>({function:{name:part.functionCall.name}}));
  const finishReason=data?.choices?.[0]?.finish_reason ?? candidate?.finishReason ?? data?.responseContent?.finishReason ?? null;
  const blockReason=data?.promptFeedback?.blockReason ?? data?.responseContent?.promptFeedback?.blockReason ?? null;
  const refusalPresent=typeof message?.refusal==='string'&&message.refusal.trim().length>0;
  const errorMessage=typeof data?.error?.message==='string'?data.error.message:'';
  const filtered=refusalPresent||['SAFETY','BLOCKLIST','PROHIBITED_CONTENT','SPII','IMAGE_SAFETY'].includes(blockReason)
    ||['content_filter','SAFETY','BLOCKLIST','PROHIBITED_CONTENT','SPII','IMAGE_SAFETY'].includes(finishReason)
    || /(?:blocked due to\s*:\s*(?:SAFETY|BLOCKLIST|PROHIBITED_CONTENT)|content[_ -]filter|safety filter)/i.test(errorMessage);
  const truncated=['length','MAX_TOKENS'].includes(finishReason);
  return {transport:'chat-completions-raw',hostHttpStatus,finishReason,blockReason,
    responseShape:data?.error?'error':Array.isArray(data?.choices)?'openai':Array.isArray(data?.candidates)?'google':'unknown',
    responseChoiceCount:Array.isArray(data?.choices)?data.choices.length:0,
    candidateCount:Array.isArray(data?.candidates)?data.candidates.length:0,
    googlePartCount:googleParts.length,thoughtPartCount:googleParts.filter((part:any)=>part?.thought===true).length,
    textPartCount:googleParts.filter((part:any)=>part?.thought!==true&&typeof part?.text==='string').length,
    visibleTextChars:googleParts.filter((part:any)=>part?.thought!==true&&typeof part?.text==='string').reduce((n:number,part:any)=>n+part.text.length,0)
      +(typeof message?.content==='string'?message.content.length:0),
    refusalPresent,upstreamErrorPresent:!!data?.error,
    providerErrorKind:filtered?'content-filter':truncated?'output-limit':data?.error?'upstream-error':'none',
    toolCallCount:Array.isArray(calls)?calls.length:0,
    transportCarrier:Array.isArray(calls)&&calls.some((call:any)=>typeof call?.function?.name==='string'&&/^(?:[^:]+:)*emit_complete_response_[a-f0-9]{24}$/.test(call.function.name)),
    responseBytes};
}

async function rawMainResponse(ctx: MainContext, deps: TavernMainFetchDeps, payload: HostRequestPayload, prompts: Array<{role:string;content:string}>, init?: RequestInit): Promise<Response> {
  const request = await ctx.ChatCompletionService!.presetToGeneratePayload!({}, {}, {
    messages: prompts, model: ctx.getChatCompletionModel!(), stream: ctx.chatCompletionSettings?.stream_openai === true,
    ...(typeof payload.max_tokens === 'number' && payload.max_tokens > 0 ? {max_tokens:payload.max_tokens} : {}),
    ...(payload.tools?.length ? {tools:payload.tools, tool_choice:payload.tool_choice ?? 'auto'} : {}),
  });
  // Match the host's settings hook; prebuilt sources must not pass through prompt/EJS assembly again.
  const readyEvent = (ctx.eventTypes ?? ctx.event_types)?.CHAT_COMPLETION_SETTINGS_READY;
  if (readyEvent && ctx.eventSource?.emit) await ctx.eventSource.emit(readyEvent, request);
  if (init?.signal?.aborted) throw new Error('HOST_REQUEST_ABORTED');
  // Do not set tool_choice=none or cache fetch: external transport extensions own their wrapper.
  const response = await (deps.fetchFn ?? globalThis.fetch)('/api/backends/chat-completions/generate', {
    method:'POST', headers:{...ctx.getRequestHeaders!(), 'Content-Type':'application/json'},
    cache:'no-cache', body:JSON.stringify(request), signal:init?.signal,
  });
  const wire = await response.text();
  if (init?.signal?.aborted) throw new Error('HOST_REQUEST_ABORTED');
  let data: any;
  let streamMeta: Record<string, unknown> = { streamed: false };
  try {
    if (/^data:/m.test(wire)) { const assembled = assembleHostStream(wire); data = assembled.data; streamMeta = assembled.meta; }
    else data=JSON.parse(wire);
  } catch (error) {
    const incomplete = error instanceof Error && error.message === 'HOST_STREAM_INCOMPLETE';
    return hostErrorJsonResponse(incomplete ? '模型流式响应未完整结束；本轮未提交，请查看网关或连接日志。' : '酒馆生成端点未返回合法完整响应；模型结果未提交。', 'RESPONSE_MALFORMED', incomplete ? 'HOST_STREAM_INCOMPLETE' : 'HOST_INVALID_JSON', {transport:'chat-completions-raw',hostHttpStatus:response.status,responseBytes:wire.length,streamed:/^data:/m.test(wire),streamComplete:false});
  }
  const meta={...summarizeHostResponse(data,response.status,wire.length),...streamMeta};
  if(!response.ok||data?.error) return hostErrorJsonResponse(meta.providerErrorKind==='content-filter'
    ?'模型响应明确包含内容审核拦截标记；本轮未提交。'
    :`酒馆生成端点请求失败（HTTP ${response.status}）；模型结果未提交。`, 'API_REQUEST_FAILED', 'HOST_HTTP_FAILED', meta);
  if (meta.providerErrorKind === 'content-filter' || meta.providerErrorKind === 'output-limit') return hostErrorJsonResponse(
    meta.providerErrorKind === 'content-filter' ? '模型响应明确包含内容审核拦截标记；本轮未提交。' : '模型响应标记输出额度耗尽；不提交可能被截断的结果。',
    'RESPONSE_MALFORMED', 'HOST_EMPTY_RESPONSE', meta);
  const text=hostAssistantText(data,payload.tools?.[0]?.function?.name);
  if(!text?.trim()) return hostErrorJsonResponse(meta.providerErrorKind==='content-filter'
    ?'模型响应明确包含内容审核拦截标记；本轮未提交。'
    :meta.providerErrorKind==='output-limit'?'模型响应标记输出额度耗尽，且没有可用正文；本轮未提交。'
    :'酒馆生成端点未返回可用正文；模型结果未提交。当前响应未提供明确审核拦截或输出截断标记，请查看响应结构诊断。', 'RESPONSE_MALFORMED', 'HOST_EMPTY_RESPONSE', meta);
  return textResponse(text.trim(),meta);
}

/** 酒馆主 API 适配：拦截引擎请求 → TavernHelper.generateRaw → OpenAI 形状回包。 */
export function createTavernMainFetch(deps: TavernMainFetchDeps): typeof fetch {
  return async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const payload = parseHostPayload(init);
    const ctx = deps.getContext?.() as MainContext | undefined;
    const prompts = payload ? orderedPromptsOf(payload) : [];
    if (prompts.length === 0) return hostErrorJsonResponse("主API生成失败：请求缺少有效的 messages。");
    if(ctx?.mainApi === 'openai' && typeof ctx.ChatCompletionService?.presetToGeneratePayload === 'function' && typeof ctx.getChatCompletionModel === 'function' && typeof ctx.getRequestHeaders === 'function') {
      try { return await rawMainResponse(ctx,deps,payload!,prompts,init); }
      catch(error) { return hostErrorJsonResponse(`酒馆原始生成请求失败：${error instanceof Error?error.message:String(error)}`, 'API_REQUEST_FAILED', 'HOST_RAW_REQUEST_FAILED', {transport:'chat-completions-raw'}); }
    }
    const helper = deps.getTavernHelper() as { generateRaw?: (opts: Record<string, unknown>) => Promise<unknown> } | null | undefined;
    const fallbackMeta={transport:'tavern-helper',hostMainApi:ctx?.mainApi??null,
      rawServiceAvailable:typeof ctx?.ChatCompletionService?.presetToGeneratePayload==='function',
      modelReaderAvailable:typeof ctx?.getChatCompletionModel==='function',headersAvailable:typeof ctx?.getRequestHeaders==='function'};
    if (!helper || typeof helper.generateRaw !== "function") {
      return hostErrorJsonResponse("主API生成不可用：未检测到酒馆助手（TavernHelper.generateRaw）。请安装酒馆助手（JS-Slash-Runner），或改用自定义 API 连接。", "API_NOT_CONFIGURED", "HOST_HELPER_UNAVAILABLE");
    }
    const maxTokens = typeof payload?.max_tokens === "number" ? payload.max_tokens : undefined;
    try {
      const response = await helper.generateRaw({ ordered_prompts: prompts, should_stream: false,
        should_return_reasoning: true,
        ...(payload?.tools?.length ? { tools: payload.tools, tool_choice: payload.tool_choice ?? "auto" } : {}),
        ...(maxTokens ? { max_tokens: maxTokens } : {}) });
      const text = hostAssistantText(response, payload?.tools?.[0]?.function?.name);
      if (!text?.trim()) return hostErrorJsonResponse("酒馆主 API 未返回可用正文（空回复或无法识别的响应）。模型结果未提交。请核对酒馆当前连接与脚本网关的响应日志；Atlas 未观察到上游 HTTP 状态，不能据此判断模型不存在或地址错误。", "RESPONSE_MALFORMED", "HOST_EMPTY_RESPONSE");
      return textResponse(text.trim(),fallbackMeta);
    } catch (error) {
      return hostErrorJsonResponse(`主API生成失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

export interface TavernProfileFetchDeps {
  getContext: () => unknown;
  /** 通常 = () => globalThis.TavernHelper；测试注入 fake（/profile 切换走 triggerSlash）。 */
  getTavernHelper: () => unknown;
}

/** /profile 串行队列尾（shujuku 同款：并发切换互相踩，必须串行「切换→发送→恢复」）。 */
let profileCallTail: Promise<unknown> = Promise.resolve();

function triggerSlash(helper: unknown, command: string): Promise<string> {
  const fn = (helper as { triggerSlash?: (c: string) => Promise<string> } | null | undefined)?.triggerSlash;
  if (typeof fn !== "function") return Promise.resolve("");
  return fn(command);
}

/** 酒馆连接预设适配：/profile 切换保护下 ConnectionManagerRequestService.sendRequest。 */
export function createTavernProfileFetch(deps: TavernProfileFetchDeps): typeof fetch {
  return async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const payload = parseHostPayload(init);
    const ctx = deps.getContext() as { ConnectionManagerRequestService?: { sendRequest?: (id: string, msgs: unknown, max?: number) => Promise<unknown> } } | null | undefined;
    const service = ctx?.ConnectionManagerRequestService;
    if (!service || typeof service.sendRequest !== "function") {
      return hostErrorJsonResponse("ConnectionManagerRequestService 不可用。请检查酒馆版本或连接管理器配置。");
    }
    const profileId = typeof payload?.xAtlasProfileId === "string" ? payload.xAtlasProfileId.trim() : "";
    if (!profileId) return hostErrorJsonResponse("酒馆连接预设模式未选择连接预设。");
    const prompts = payload ? orderedPromptsOf(payload) : [];
    if (prompts.length === 0) return hostErrorJsonResponse("酒馆连接预设调用失败：请求缺少有效的 messages。");
    const maxTokens = typeof payload?.max_tokens === "number" && payload.max_tokens > 0 ? payload.max_tokens : undefined;

    const profiles = getConnectionManagerProfiles(deps.getContext);
    const target = profiles.find((p) => p.id === profileId);
    const targetName = target?.name ?? profileId;

    const run = async (): Promise<Response> => {
      const helper = deps.getTavernHelper();
      const originalProfile = await triggerSlash(helper, "/profile");
      const needSwitch = !!originalProfile && originalProfile !== targetName;
      try {
        if (needSwitch) {
          await triggerSlash(helper, `/profile await=true "${targetName.replace(/"/g, '\\"')}"`);
        }
        const response = await service.sendRequest!(profileId, prompts, maxTokens);
        const content = hostAssistantText((response as {result?: unknown})?.result ?? response, payload?.tools?.[0]?.function?.name);
        const text = typeof content === "string" ? content : "";
        if (!text.trim()) return hostErrorJsonResponse("酒馆连接预设返回为空或形状不支持，本轮未提交。请核对所选连接与脚本网关响应。", "RESPONSE_MALFORMED", "HOST_EMPTY_RESPONSE");
        return textResponse(text.trim());
      } catch (error) {
        return hostErrorJsonResponse(`酒馆连接预设调用失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (needSwitch) {
          try {
            const current = await triggerSlash(helper, "/profile");
            if (current !== originalProfile) {
              await triggerSlash(helper, `/profile await=true "${originalProfile.replace(/"/g, '\\"')}"`);
            }
          } catch { /* 恢复失败不影响主流程（shujuku 同款容忍） */ }
        }
      }
    };
    const result = profileCallTail.then(run, run);
    profileCallTail = result.catch(() => undefined);
    return result;
  };
}
