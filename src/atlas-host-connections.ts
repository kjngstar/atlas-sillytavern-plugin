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
 * 宿主侧失败（酒馆助手缺失 / 服务缺失）→ 200 包错误 JSON（引擎的网关错误路径会把
 * message 原文报给用户），不走 HTTP 错误码。
 */

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

function textResponse(text: string): Response {
  const body = JSON.stringify({ choices: [{ message: { content: text } }] });
  return toResponse({
    ok: true,
    status: 200,
    text: async () => body,
    json: async () => JSON.parse(body),
    clone: () => ({ text: async () => body }),
  });
}

/** 宿主侧失败：200 包错误 JSON（引擎的网关错误路径会把 message 原文报给用户；不用 HTTP 错误码）。 */
function hostErrorJsonResponse(message: string): Response {
  const body = JSON.stringify({ error: { message } });
  return toResponse({
    ok: true,
    status: 200,
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
}

/** 酒馆主 API 适配：拦截引擎请求 → TavernHelper.generateRaw → OpenAI 形状回包。 */
export function createTavernMainFetch(deps: TavernMainFetchDeps): typeof fetch {
  return async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const payload = parseHostPayload(init);
    const helper = deps.getTavernHelper() as { generateRaw?: (opts: Record<string, unknown>) => Promise<unknown> } | null | undefined;
    if (!helper || typeof helper.generateRaw !== "function") {
      return hostErrorJsonResponse("主API生成不可用：未检测到酒馆助手（TavernHelper.generateRaw）。请安装酒馆助手（JS-Slash-Runner），或改用自定义 API 连接。");
    }
    const prompts = payload ? orderedPromptsOf(payload) : [];
    if (prompts.length === 0) return hostErrorJsonResponse("主API生成失败：请求缺少有效的 messages。");
    const maxTokens = typeof payload?.max_tokens === "number" ? payload.max_tokens : undefined;
    try {
      const response = await helper.generateRaw({ ordered_prompts: prompts, should_stream: false, ...(maxTokens ? { max_tokens: maxTokens } : {}) });
      const text = typeof response === "string" ? response : String(response ?? "");
      if (!text.trim()) return hostErrorJsonResponse("主API生成返回为空。");
      return textResponse(text.trim());
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
    const ctx = deps.getContext() as { ConnectionManagerRequestService?: { sendRequest?: (id: string, msgs: unknown, max: number) => Promise<unknown> } } | null | undefined;
    const service = ctx?.ConnectionManagerRequestService;
    if (!service || typeof service.sendRequest !== "function") {
      return hostErrorJsonResponse("ConnectionManagerRequestService 不可用。请检查酒馆版本或连接管理器配置。");
    }
    const profileId = typeof payload?.xAtlasProfileId === "string" ? payload.xAtlasProfileId.trim() : "";
    if (!profileId) return hostErrorJsonResponse("酒馆连接预设模式未选择连接预设。");
    const prompts = payload ? orderedPromptsOf(payload) : [];
    if (prompts.length === 0) return hostErrorJsonResponse("酒馆连接预设调用失败：请求缺少有效的 messages。");
    const maxTokens = typeof payload?.max_tokens === "number" ? payload.max_tokens : 1024;

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
        const content =
          (response as { result?: { choices?: Array<{ message?: { content?: unknown } }> } })?.result?.choices?.[0]?.message?.content ??
          (response as { content?: unknown })?.content;
        const text = typeof content === "string" ? content : "";
        if (!text.trim()) return hostErrorJsonResponse("酒馆连接预设返回为空或形状不支持。");
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
