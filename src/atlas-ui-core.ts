/**
 * atlas-ui-core.ts — Atlas UI Extension 纯核心（零 DOM、零 ST 全局、零密钥）。
 *
 * 职责（上级 README 第 5 / 6 节 + ATLAS-03 验收）：
 * - 聊天绑定状态机：服务离线 / 协议不兼容 / 未绑定 / 世界不存在 / 就绪 五种模式；
 *   每次事件都从 host **重新读取** chatMetadata（不缓存旧聊天对象引用）。
 * - 只监听本包已实现的事件（APP_READY / CHAT_CHANGED）；dispose 必须成对注销。
 * - 绑定写入只包含契约 AtlasChatBinding 形状——绝无 apiKey / 密钥字段。
 * - 面板开关状态经 host 持久化（extensionSettings），刷新后恢复。
 * - 真实 ST 接线在 atlas-extension/index.js（薄适配）；harness 测试注入 mock 三件套。
 */

import type { AtlasChatBinding } from "./atlas-contract.ts";
import {
  ATLAS_ERROR_CODES,
  ATLAS_LIMITS,
  ATLAS_PROTOCOL_VERSION,
  parseAtlasChatBinding,
  parseAtlasTurnCommitRequest,
  parseAtlasTurnPrepareRequest,
  parseAtlasTurnPrepareResponse,
  parseAtlasTurnReceipt,
  type AtlasTurnPrepareResponse,
  type AtlasTurnReceipt,
} from "./atlas-contract.ts";
import { parseAtlasLorebookPlans, type AtlasLorebookPlans } from "./atlas-lorebook.ts";

export type AtlasUiMode = "offline" | "protocol-incompatible" | "unbound" | "world-missing" | "ready";
export type AtlasUiPage = "overview" | "map" | "nearby" | "changes" | "settings";
export type AtlasServiceStatus = "checking" | "online" | "offline" | "incompatible";

/** 在途回合：MESSAGE_SENT 后 prepare 的产物；停止 / 失败即放弃，绝不推进世界。 */
export interface AtlasPendingTurn {
  turnId: string;
  chatId: string;
  messageId: string;
  userText: string;
  injectionText: string;
  sourceRefs: string[];
  relevantNpcIds: string[];
  triggerIds: string[];
}

/** 变化页回执记录（去重后 ≤10 条；摘要截断，无密钥）。 */
export interface AtlasReceiptRecord {
  receiptId: string;
  status: string;
  summary: string;
  previousTime: number;
  currentTime: number;
  currentLocationId: string | null;
  adoptedEventCount: number;
  recordedAt: number;
}

export interface AtlasUiState {
  mode: AtlasUiMode;
  page: AtlasUiPage;
  panelOpen: boolean;
  serviceStatus: AtlasServiceStatus;
  /** 服务端协议版本（incompatible 时记录实际值） */
  serviceProtocolVersion: number | null;
  binding: AtlasChatBinding | null;
  /** chatMetadata 里有绑定形状但未通过严格解析（不可静默采用） */
  bindingInvalid: boolean;
  chatId: string | null;
  /** 就绪时的 /state 有界数据（世界名、位置、附近 NPC、地图点集、最近推进等） */
  stateData: Record<string, unknown> | null;
  /** 旅行预览（地图点击目的地后暂存；确认 = 只填酒馆输入框，不自动发送） */
  destinationPreview: AtlasDestinationPreview | null;
  /** 在途回合（MESSAGE_SENT → prepare 成功；停止 / 失败即放弃） */
  pendingTurn: AtlasPendingTurn | null;
  /** 最近回执（去重 ≤10；持久化于 extensionSettings，刷新后仍在） */
  receipts: AtlasReceiptRecord[];
  /** commit 失败后的可重试回合（仅会话内） */
  retryableCommit: { chatId: string; userMessageId: string; assistantMessageId: string; swipeId: string | null } | null;
  /** 用户可读的模式说明（空状态文案） */
  modeHint: string | null;
  /** 世界书写入状态提示（失败 / 冲突时非空；成功写图为 null） */
  lorebookHint: string | null;
  lastError: string | null;
}

export interface AtlasDestinationPreview {
  destinationId: string;
  destinationName: string;
  distance: number;
  estimatedDuration: number;
  factors: string[];
}

/** 地图缩放钳制：1x..3x，防止把底图推出视口。 */
export function atlasClampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(3, Math.max(1, value));
}

/** Server Plugin HTTP 客户端（index.js 提供同源 fetch 实现）。 */
export interface AtlasUiApi {
  request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
}

/** 宿主适配：chatMetadata / extensionSettings 的读写（每次调用都重新取当前聊天）。 */
export interface AtlasUiHost {
  getChatId(): string | null;
  readBinding(): unknown;
  writeBinding(binding: AtlasChatBinding): Promise<void>;
  clearBinding(): Promise<void>;
  readPanelOpen(): boolean;
  writePanelOpen(open: boolean): void;
  /** 把建议行动填入酒馆输入框（不自动发送；由 index.js 适配具体输入框） */
  fillInput(text: string): void;
  /** extensionSettings 下的键值读写（回执持久化；core 侧保证有界） */
  readData(key: string): unknown;
  writeData(key: string, value: unknown): void;
}

/** 事件源适配（eventSource.on / off）。 */
export interface AtlasUiEmitter {
  on(event: string, handler: (payload?: unknown) => void): void;
  off(event: string, handler: (payload?: unknown) => void): void;
}

/** 本包注册的酒馆事件；只在实现对应能力后追加，禁止注册后不处理。 */
export const ATLAS_UI_EVENTS = [
  "APP_READY",
  "CHAT_CHANGED",
  "MESSAGE_SENT",
  "MESSAGE_RECEIVED",
  "GENERATION_ENDED",
  "GENERATION_STOPPED",
] as const;

/** 事件载荷适配结果（ST 各事件数据形状不统一，适配在 index.js 完成）。 */
export type AtlasAdaptedEvent =
  | { kind: "message-sent"; messageId: string; userText: string }
  | { kind: "generation-ended"; assistantMessageId: string; assistantText: string }
  | { kind: "generation-stopped" };

export interface AtlasUiCore {
  init(): void;
  dispose(): void;
  handleEvent(event: string): Promise<void>;
  refresh(): Promise<void>;
  getState(): AtlasUiState;
  setPanelOpen(open: boolean): void;
  setPage(page: AtlasUiPage): void;
  bindToWorld(worldId: string): Promise<void>;
  unbind(): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
  requestWorlds(): Promise<Array<Record<string, unknown>>>;
  selectDestination(pointId: string): Promise<void>;
  confirmTravel(): void;
  cancelTravel(): void;
  /** 回合流（ATLAS-05）：见各闭包函数注释；事件路径经 handleEventSync 分发。 */
  onMessageSent(messageId: string, userText: string): Promise<void>;
  onGenerationEnded(assistantMessageId: string, assistantText: string): Promise<void>;
  onGenerationStopped(): void;
  retryLastCommit(): Promise<void>;
  /**
   * 等待最近一次 MESSAGE_SENT 触发的 prepare 落定（有界超时）。
   * 真实酒馆的事件监听是 fire-and-forget；生成拦截器在注入前必须调用本方法，
   * 否则会在 prepare 返回前读到 pendingTurn=null 造成确定性竞态（AR-ATLAS-07 P0-04）。
   * 无在途 prepare（未绑定 / 停用 / 失败）时立即返回，绝不阻断普通聊天。
   */
  waitPendingTurn(timeoutMs?: number): Promise<void>;
}

const HEALTH_CACHE_MS = 30_000;

function modeHintFor(
  mode: AtlasUiMode,
  bindingInvalid: boolean,
  protocolVersion: number | null,
  bindingDisabled: boolean,
): string | null {
  if (bindingInvalid) return "聊天中的 Atlas 绑定数据损坏，已按未绑定处理；可重新绑定世界。";
  if (bindingDisabled && mode === "unbound") return "已在当前聊天停用 Atlas 推演；可随时重新启用。";
  switch (mode) {
    case "offline":
      // ATLAS-09 纯浏览器模式：引擎核心打进扩展进程内，"offline" 只可能是
      // 扩展内部异常（如 dist 载荷损坏），不再引导用户安装 Server Plugin。
      return "Atlas 本地引擎未就绪：刷新页面或重进聊天即可恢复；酒馆聊天不受影响。";
    case "protocol-incompatible":
      return `Atlas 引擎协议版本（${String(protocolVersion)}）与扩展（${ATLAS_PROTOCOL_VERSION}）不一致，安装包可能不完整：请重新安装最新版插件。`;
    case "unbound":
      return "当前聊天未绑定 Atlas 世界。在设置页选择一个世界即可开始。";
    case "world-missing":
      return "绑定的世界不存在或已被删除。请解绑后重新选择世界。";
    case "ready":
      return null;
  }
}

export function createAtlasUiCore(deps: {
  api: AtlasUiApi;
  host: AtlasUiHost;
  emitter: AtlasUiEmitter;
  now?: () => number;
  /** 任意状态变化后的回调（UI 层重绘用；同步调用，不等待异步刷新完成） */
  onStateChange?: () => void;
  /**
   * 世界书写入钩子（ATLAS-09；index.js 注入酒馆 world-info 适配）。
   * commit 成功且引擎给出条目规划时调用；失败只记 lorebookHint，绝不影响回合成功。
   */
  onLorebookSync?: (plans: AtlasLorebookPlans) => Promise<unknown>;
  /** 酒馆事件载荷适配（ST 事件数据形状不统一；返回 null = 无法适配，忽略该事件） */
  adaptEvent?: (event: string, payload: unknown) => AtlasAdaptedEvent | null;
}): AtlasUiCore {
  const { api, host, emitter } = deps;
  const now = deps.now ?? Date.now;

  let state: AtlasUiState = {
    mode: "unbound",
    page: "overview",
    panelOpen: false,
    serviceStatus: "checking",
    serviceProtocolVersion: null,
    binding: null,
    bindingInvalid: false,
    chatId: null,
    stateData: null,
    destinationPreview: null,
    pendingTurn: null,
    receipts: [],
    retryableCommit: null,
    modeHint: modeHintFor("unbound", false, null, false),
    lorebookHint: null,
    lastError: null,
  };
  let initialized = false;
  let disposed = false;
  let healthCheckedAt = -Infinity;
  let commitInFlight = false;
  /** 最近一次 MESSAGE_SENT 触发的 prepare 任务（waitPendingTurn 等它落定）。 */
  let lastPrepareTask: Promise<void> | null = null;
  const listeners: Array<{ event: string; handler: (payload?: unknown) => void }> = [];

  function setState(patch: Partial<AtlasUiState>): void {
    state = { ...state, ...patch };
    if (patch.mode !== undefined || patch.bindingInvalid !== undefined || patch.serviceProtocolVersion !== undefined) {
      state.modeHint = modeHintFor(state.mode, state.bindingInvalid, state.serviceProtocolVersion, state.binding !== null && !state.binding.enabled);
    }
    deps.onStateChange?.();
  }

  /** 回执记录：去重、摘要截断（≤300）、有界（≤10）并持久化到 extensionSettings。 */
  const RECEIPTS_MAX = 10;
  function addReceipt(receipt: AtlasTurnReceipt): void {
    if (state.receipts.some((r) => r.receiptId === receipt.receiptId)) return;
    const record: AtlasReceiptRecord = {
      receiptId: receipt.receiptId,
      status: receipt.status,
      summary: receipt.summary.slice(0, 300),
      previousTime: receipt.previousTime,
      currentTime: receipt.currentTime,
      currentLocationId: typeof receipt.currentLocationId === "string" ? receipt.currentLocationId : null,
      adoptedEventCount: receipt.adoptedEventIds.length,
      recordedAt: now(),
    };
    const receipts = [record, ...state.receipts].slice(0, RECEIPTS_MAX);
    setState({ receipts });
    host.writeData("receipts", receipts);
  }

  /** 世界书绑定冲突 / 写入失败 → 用户可读提示；成功且无冲突 → null。 */
  function lorebookHintFromResult(result: unknown): string | null {
    if (!result || typeof result !== "object" || Array.isArray(result)) return null;
    const record = result as Record<string, unknown>;
    if (record.binding === "conflict") {
      const existing = typeof record.existingBookName === "string" ? record.existingBookName : "";
      return `Atlas 条目已写入《${String(record.bookName ?? "")}》，但本聊天已绑定世界书《${existing}》——条目要生效需在酒馆世界书里切换或同时激活。`;
    }
    return null;
  }

  /**
   * commit / retry 成功后同步世界书条目（ATLAS-09）。
   * 引擎只在 committed 回执里附带 lorebook 规划；没有字段 / 没有钩子 → 静默跳过。
   * 写入失败只记 lorebookHint，绝不影响回合成功（世界已原子落库）。
   */
  async function syncLorebookAfterCommit(body: { data?: unknown }): Promise<void> {
    if (!deps.onLorebookSync) return;
    const data = body?.data as Record<string, unknown> | undefined;
    const lorebookRaw = data?.lorebook;
    if (!lorebookRaw) return;
    const parsed = parseAtlasLorebookPlans(lorebookRaw);
    if (!parsed.ok) {
      setState({ lorebookHint: "世界书条目载荷异常，本轮跳过写入。" });
      return;
    }
    try {
      const result = await deps.onLorebookSync(parsed.value);
      setState({ lorebookHint: lorebookHintFromResult(result) });
    } catch (error) {
      setState({ lorebookHint: `世界书写入失败：${error instanceof Error ? error.message : String(error)}` });
    }
  }

  function register(event: string, handler: (payload?: unknown) => void): void {
    emitter.on(event, handler);
    listeners.push({ event, handler });
  }

  async function checkHealth(): Promise<void> {
    if (now() - healthCheckedAt < HEALTH_CACHE_MS && state.serviceStatus !== "checking") return;
    healthCheckedAt = now();
    try {
      const result = await api.request("GET", "/health");
      // 响应契约 = { ok: true, data: { protocolVersion, ... } }（与 /state 等分支同形）。
      const body = result.body as { ok?: boolean; data?: Record<string, unknown> };
      const payload = body?.data;
      const version = payload && typeof payload.protocolVersion === "number" ? payload.protocolVersion : null;
      if (version !== ATLAS_PROTOCOL_VERSION) {
        setState({ serviceStatus: "incompatible", serviceProtocolVersion: version, mode: "protocol-incompatible" });
        return;
      }
      setState({ serviceStatus: "online", serviceProtocolVersion: version });
    } catch {
      setState({ serviceStatus: "offline", serviceProtocolVersion: null, mode: "offline" });
    }
  }

  /** 从宿主重新读取当前聊天与绑定（绝不缓存聊天对象引用）。 */
  async function syncFromHost(): Promise<void> {
    const chatId = host.getChatId();
    const panelOpen = host.readPanelOpen();
    setState({ chatId, panelOpen, destinationPreview: null });
    if (state.serviceStatus === "offline" || state.serviceStatus === "incompatible") return;

    const raw = host.readBinding();
    if (raw === null || raw === undefined) {
      setState({ binding: null, bindingInvalid: false, mode: "unbound", stateData: null });
      return;
    }
    const parsed = parseAtlasChatBinding(raw);
    if (!parsed.ok) {
      setState({ binding: null, bindingInvalid: true, mode: "unbound", stateData: null });
      return;
    }
    const binding = parsed.value;
    if (chatId !== null && binding.chatId !== chatId) {
      // 绑定属于另一个聊天（不该发生；防御性处理为未绑定）
      setState({ binding: null, bindingInvalid: false, mode: "unbound", stateData: null });
      return;
    }
    setState({ binding, bindingInvalid: false });
  }

  async function loadStateData(): Promise<void> {
    const binding = state.binding;
    if (!binding || state.serviceStatus !== "online" || state.chatId === null) return;
    if (!binding.enabled) {
      setState({ mode: "unbound", stateData: null });
      return;
    }
    try {
      const result = await api.request("GET", `/state/${encodeURIComponent(binding.chatId)}`);
      const body = result.body as { ok?: boolean; error?: { code?: string; message?: string }; data?: Record<string, unknown> };
      if (result.status === 200 && body.ok && body.data) {
        setState({ mode: "ready", stateData: body.data, lastError: null });
        return;
      }
      const code = body.error?.code ?? "";
      if (code === ATLAS_ERROR_CODES.WORLD_NOT_FOUND) {
        setState({ mode: "world-missing", stateData: null });
        return;
      }
      if (code === ATLAS_ERROR_CODES.NOT_BOUND) {
        setState({ mode: "unbound", stateData: null });
        return;
      }
      setState({ lastError: body.error?.message ?? `状态读取失败（HTTP ${result.status}）` });
    } catch {
      setState({ serviceStatus: "offline", mode: "offline", stateData: null });
    }
  }

  async function refresh(): Promise<void> {
    await checkHealth();
    await syncFromHost();
    if (state.binding && state.serviceStatus === "online") {
      await loadStateData();
    }
  }

  /** 在途异步工作登记（handleEvent 测试入口等待用）。 */
  let asyncWork: Promise<unknown>[] = [];
  function track<T>(task: Promise<T>): Promise<T> {
    asyncWork.push(task);
    return task;
  }
  async function flushAsyncWork(): Promise<void> {
    while (asyncWork.length > 0) {
      const batch = asyncWork;
      asyncWork = [];
      await Promise.allSettled(batch);
    }
  }

  function handleEventSync(event: string, payload?: unknown): void {
    if (disposed) return;
    if (event === "APP_READY" || event === "CHAT_CHANGED") {
      healthCheckedAt = -Infinity; // 事件驱动时强制重新检查服务
      void track(refresh());
      return;
    }
    // 回合事件：经适配器转成结构化动作；无法适配（形状未知）则忽略，绝不猜测
    const adapted = deps.adaptEvent?.(event, payload) ?? null;
    if (!adapted) return;
    if (adapted.kind === "message-sent") {
      const task = onMessageSent(adapted.messageId, adapted.userText);
      lastPrepareTask = task;
      void track(task);
    } else if (adapted.kind === "generation-ended") void track(onGenerationEnded(adapted.assistantMessageId, adapted.assistantText));
    else onGenerationStopped();
  }

  /**
   * 等待最近一次 MESSAGE_SENT 的 prepare 落定（有界超时；P0-04 竞态消除）。
   * 真实酒馆事件监听 fire-and-forget，拦截器注入前必须先调本方法；
   * 无在途 prepare 时立即返回，绝不阻断未启用 / 离线下的普通聊天。
   */
  async function waitPendingTurn(timeoutMs = 10_000): Promise<void> {
    const task = lastPrepareTask;
    if (!task) return;
    try {
      await Promise.race([
        task.catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, timeoutMs))),
      ]);
    } catch {
      // 任何失败都不阻断生成；拦截器随后读不到 pendingTurn 会走清理路径
    }
  }

  /** MESSAGE_SENT：建 pending turn 并调用 prepare（失败不阻断酒馆生成，只提示）。 */
  async function onMessageSent(messageId: string, userText: string): Promise<void> {
    if (disposed || !messageId) return;
    const binding = state.binding;
    const chatId = state.chatId;
    if (!binding?.enabled || !chatId || state.serviceStatus !== "online") return;
    if (state.pendingTurn) return; // 同一时刻只允许一条在途回合
    const request = {
      chatId,
      messageId: messageId.slice(0, ATLAS_LIMITS.ID_CHARS),
      worldId: binding.worldId,
      branchId: binding.branchId,
      userText: String(userText ?? "").slice(0, ATLAS_LIMITS.USER_TEXT_CHARS),
      recentMessageRefs: [],
    };
    const parsed = parseAtlasTurnPrepareRequest(request);
    if (!parsed.ok) return;
    try {
      const result = await api.request("POST", "/turns/prepare", parsed.value);
      const body = result.body as { ok?: boolean; data?: { response?: unknown }; error?: { message?: string } };
      if (result.status === 200 && body.ok && body.data?.response) {
        const parsedResponse = parseAtlasTurnPrepareResponse(body.data.response);
        if (!parsedResponse.ok) {
          setState({ lastError: "prepare 响应形状异常，本轮不注入。" });
          return;
        }
        const response: AtlasTurnPrepareResponse = parsedResponse.value;
        setState({
          pendingTurn: {
            turnId: response.turnId,
            chatId: parsed.value.chatId,
            messageId: parsed.value.messageId,
            userText: parsed.value.userText,
            injectionText: response.injectionText,
            sourceRefs: response.sourceRefs,
            relevantNpcIds: response.relevantNpcIds,
            triggerIds: response.triggerIds,
          },
          lastError: null,
        });
        return;
      }
      setState({ lastError: body.error?.message ?? `本轮未注入阿特拉斯上下文（HTTP ${result.status}）` });
    } catch {
      setState({ lastError: "本轮未注入阿特拉斯上下文：服务不可用。" });
    }
  }

  /** 最终回复完成：commit（至多 1 次请求；重复通知 / 空回复 / 停止不推进世界）。 */
  async function onGenerationEnded(assistantMessageId: string, assistantText: string): Promise<void> {
    if (disposed) return;
    const pending = state.pendingTurn;
    if (!pending) return;
    if (commitInFlight) return; // 同一条回复的重复事件通知只 commit 一次
    if (!assistantMessageId || !assistantText || assistantText.trim().length === 0) {
      setState({ pendingTurn: null }); // 空回复：放弃 pending，不推进世界
      return;
    }
    const request = {
      turnId: pending.turnId,
      chatId: pending.chatId,
      userMessageId: pending.messageId,
      assistantMessageId: assistantMessageId.slice(0, ATLAS_LIMITS.ID_CHARS),
      swipeId: null,
      userText: pending.userText,
      assistantText: assistantText.slice(0, ATLAS_LIMITS.ASSISTANT_TEXT_CHARS),
    };
    const parsed = parseAtlasTurnCommitRequest(request);
    if (!parsed.ok) {
      setState({ pendingTurn: null });
      return;
    }
    commitInFlight = true;
    try {
      const result = await api.request("POST", "/turns/commit", parsed.value);
      const body = result.body as { ok?: boolean; data?: { receipt?: unknown }; error?: { message?: string; code?: string } };
      const receiptParsed = body.data?.receipt ? parseAtlasTurnReceipt(body.data.receipt) : null;
      if (result.status === 200 && body.ok && receiptParsed?.ok) {
        addReceipt(receiptParsed.value);
        setState({ pendingTurn: null, lastError: null });
        if (receiptParsed.value.status === "committed" || receiptParsed.value.status === "duplicate") {
          healthCheckedAt = -Infinity;
          await refresh();
        }
        await syncLorebookAfterCommit(body);
        return;
      }
      // commit 失败：保留可重试信息，清 pending；零部分写入由服务端保证
      setState({
        pendingTurn: null,
        retryableCommit: {
          chatId: parsed.value.chatId,
          userMessageId: parsed.value.userMessageId,
          assistantMessageId: parsed.value.assistantMessageId,
          swipeId: null,
        },
        lastError: body.error?.message ?? `世界推演失败（HTTP ${result.status}），可从「变化」页重试。`,
      });
    } catch {
      setState({
        pendingTurn: null,
        retryableCommit: {
          chatId: parsed.value.chatId,
          userMessageId: parsed.value.userMessageId,
          assistantMessageId: parsed.value.assistantMessageId,
          swipeId: null,
        },
        lastError: "世界推演失败：服务不可用，可从「变化」页重试。",
      });
    } finally {
      commitInFlight = false;
    }
  }

  /** 停止 / 生成失败：放弃 pending，不推进世界。 */
  function onGenerationStopped(): void {
    if (disposed) return;
    if (state.pendingTurn) setState({ pendingTurn: null });
  }

  /** 重试失败的 commit（沿用原幂等键；服务端 retry 端点）。 */
  async function retryLastCommit(): Promise<void> {
    if (disposed) return;
    const failed = state.retryableCommit;
    if (!failed) return;
    try {
      const result = await api.request("POST", "/turns/retry", failed);
      const body = result.body as { ok?: boolean; data?: { receipt?: unknown }; error?: { message?: string } };
      const receiptParsed = body.data?.receipt ? parseAtlasTurnReceipt(body.data.receipt) : null;
      if (result.status === 200 && body.ok && receiptParsed?.ok) {
        addReceipt(receiptParsed.value);
        setState({ retryableCommit: null, lastError: null });
        if (receiptParsed.value.status === "committed" || receiptParsed.value.status === "duplicate") {
          healthCheckedAt = -Infinity;
          await refresh();
        }
        await syncLorebookAfterCommit(body);
        return;
      }
      setState({ lastError: body.error?.message ?? `重试失败（HTTP ${result.status}）` });
    } catch {
      setState({ lastError: "重试失败：服务不可用。" });
    }
  }

  return {
    init() {
      if (initialized || disposed) return;
      initialized = true;
      for (const event of ATLAS_UI_EVENTS) {
        register(event, (payload) => handleEventSync(event, payload));
      }
      setState({ panelOpen: host.readPanelOpen() });
      // 回执恢复（extensionSettings 持久化；形状不可信，逐条严格校验）
      const storedReceipts = host.readData("receipts");
      if (Array.isArray(storedReceipts)) {
        const restored: AtlasReceiptRecord[] = [];
        for (const raw of storedReceipts.slice(0, 10)) {
          if (!raw || typeof raw !== "object") continue;
          const record = raw as Record<string, unknown>;
          if (typeof record.receiptId !== "string" || typeof record.summary !== "string") continue;
          restored.push({
            receiptId: record.receiptId,
            status: typeof record.status === "string" ? record.status : "committed",
            summary: record.summary.slice(0, 300),
            previousTime: typeof record.previousTime === "number" ? record.previousTime : 0,
            currentTime: typeof record.currentTime === "number" ? record.currentTime : 0,
            currentLocationId: typeof record.currentLocationId === "string" ? record.currentLocationId : null,
            adoptedEventCount: typeof record.adoptedEventCount === "number" ? record.adoptedEventCount : 0,
            recordedAt: typeof record.recordedAt === "number" ? record.recordedAt : 0,
          });
        }
        if (restored.length > 0) setState({ receipts: restored });
      }
      void refresh();
    },

    dispose() {
      disposed = true;
      for (const { event, handler } of listeners) {
        emitter.off(event, handler);
      }
      listeners.length = 0;
      initialized = false;
    },

    async handleEvent(event: string, payload?: unknown) {
      if (disposed) return;
      handleEventSync(event, payload);
      await flushAsyncWork();
    },

    async refresh() {
      if (disposed) return;
      await refresh();
    },

    getState(): AtlasUiState {
      return { ...state, binding: state.binding ? { ...state.binding } : null };
    },

    setPanelOpen(open: boolean) {
      setState({ panelOpen: open });
      host.writePanelOpen(open);
    },

    setPage(page: AtlasUiPage) {
      setState({ page });
    },

    async bindToWorld(worldId: string) {
      const chatId = host.getChatId();
      if (!chatId) {
        setState({ lastError: "当前没有可绑定的聊天。" });
        return;
      }
      const binding: AtlasChatBinding = {
        schemaVersion: 1,
        enabled: true,
        chatId,
        characterId: null,
        worldId,
        branchId: null,
        currentLocationId: null,
        worldTimeCursor: 0,
        lastCommittedMessageId: null,
        lastCheckpointId: null,
      };
      const result = await api.request("POST", "/bindings", { action: "bind", binding });
      const body = result.body as { ok?: boolean; error?: { code?: string; message?: string } };
      if (result.status !== 200 || !body.ok) {
        setState({ lastError: body.error?.message ?? `绑定失败（HTTP ${result.status}）` });
        return;
      }
      await host.writeBinding(binding);
      healthCheckedAt = -Infinity;
      await refresh();
    },

    async unbind() {
      const chatId = host.getChatId();
      if (!chatId) return;
      const result = await api.request("POST", "/bindings", { action: "unbind", chatId });
      const body = result.body as { ok?: boolean; error?: { message?: string } };
      if (result.status !== 200 || !body.ok) {
        setState({ lastError: body.error?.message ?? `解绑失败（HTTP ${result.status}）` });
        return;
      }
      await host.clearBinding();
      await refresh();
    },

    async setEnabled(enabled: boolean) {
      const binding = state.binding;
      if (!binding) return;
      const next = { ...binding, enabled };
      const result = await api.request("POST", "/bindings", { action: "bind", binding: next });
      const body = result.body as { ok?: boolean; error?: { message?: string } };
      if (result.status !== 200 || !body.ok) {
        setState({ lastError: body.error?.message ?? `更新启用状态失败（HTTP ${result.status}）` });
        return;
      }
      await host.writeBinding(next);
      await refresh();
    },

    /** 设置页世界列表（绑定用）；失败返回空数组并记录错误。 */
    async requestWorlds() {
      try {
        const result = await api.request("GET", "/worlds");
        const body = result.body as { ok?: boolean; data?: { worlds?: Array<Record<string, unknown>> } };
        if (result.status === 200 && body.ok && body.data?.worlds) return body.data.worlds;
        setState({ lastError: `世界列表读取失败（HTTP ${result.status}）` });
        return [];
      } catch {
        setState({ lastError: "世界列表读取失败：服务不可用。" });
        return [];
      }
    },

    /** 地图点击目的地：只读旅行预览（不推进时间、不改状态）。 */
    async selectDestination(pointId: string) {
      const binding = state.binding;
      const chatId = state.chatId;
      if (!binding || !binding.enabled || !chatId) return;
      const points = (state.stateData?.map as { points?: Array<Record<string, unknown>> } | undefined)?.points ?? [];
      const point = points.find((p) => String(p.id) === String(pointId));
      try {
        const result = await api.request("POST", "/map/travel-preview", {
          chatId,
          destinationPointId: String(pointId).slice(0, ATLAS_LIMITS.ID_CHARS),
        });
        const body = result.body as {
          ok?: boolean;
          data?: { preview?: { destinationId: string; distance: number; estimatedDuration: number; factors: string[] } | null };
          error?: { message?: string };
        };
        if (result.status === 200 && body.ok) {
          const preview = body.data?.preview ?? null;
          if (preview) {
            setState({
              destinationPreview: {
                destinationId: preview.destinationId,
                destinationName: typeof point?.name === "string" ? point.name : preview.destinationId,
                distance: preview.distance,
                estimatedDuration: preview.estimatedDuration,
                factors: Array.isArray(preview.factors) ? preview.factors.map(String) : [],
              },
              lastError: null,
            });
          } else {
            setState({ lastError: "无法预览该目的地（未知起点或终点）。" });
          }
          return;
        }
        setState({ lastError: body.error?.message ?? `旅行预览失败（HTTP ${result.status}）` });
      } catch {
        setState({ lastError: "旅行预览失败：服务不可用。" });
      }
    },

    /** 确认出发：只把建议行动填入酒馆输入框，绝不自动发送。 */
    confirmTravel() {
      const preview = state.destinationPreview;
      if (!preview) return;
      host.fillInput(`前往 ${preview.destinationName}。`);
      setState({ destinationPreview: null });
    },

    cancelTravel() {
      setState({ destinationPreview: null });
    },

    /** MESSAGE_SENT：建 pending turn 并调用 prepare（失败不阻断酒馆生成，只提示）。 */
    onMessageSent,
    /** 最终回复完成：commit（至多 1 次请求；重复通知 / 空回复 / 停止不推进世界）。 */
    onGenerationEnded,
    /** 停止 / 生成失败：放弃 pending，不推进世界。 */
    onGenerationStopped,
    /** 重试失败的 commit（沿用原幂等键；服务端 retry 端点）。 */
    retryLastCommit,
    /** 等待最近一次 prepare 落定（有界；生成拦截器注入前必调）。 */
    waitPendingTurn,
  };
}
