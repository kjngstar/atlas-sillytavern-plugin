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
  type AtlasTurnCommitRequest,
  type AtlasTurnPrepareResponse,
  type AtlasTurnReceipt,
} from "./atlas-contract.ts";
import { parseAtlasLorebookPlans, type AtlasLorebookPlans } from "./atlas-lorebook.ts";
import type { AtlasDiagnosticInput } from "./atlas-diagnostics.ts";
import { createAtlasGenerationLifecycle, type AtlasGenerationMetadata, type AtlasGenerationSignal } from "./atlas-generation-lifecycle.ts";

/** 内置默认推演提示词（API 页「查看内置默认提示词」用；开发态 src 直载时也必须可见）。 */
export { DEFAULT_WORLD_TURN_SYSTEM_PROMPT } from "./atlas-api-client.ts";
// ATLAS-FIX-02：custom_include_headers 的唯一序列化口径（模型列表 / 生成共用；随 bundle 供给 index.js）。
export { atlasCustomIncludeHeaders } from "./atlas-proxy-fetch.ts";

export type AtlasUiMode = "offline" | "protocol-incompatible" | "unbound" | "world-missing" | "ready";
export type AtlasUiPage =
  | "overview" | "map" | "nearby" | "changes" | "progression"
  // U14：目录类页面（人物 / 物品 / 事件）与提示词页；数据来自 Q 系列只读口与既有提示词库。
  | "characters" | "items" | "events" | "prompts"
  | "api" | "replace" | "skin" | "logs";

/**
 * 侧边栏（顺序不可自行调整）。0.9.7 新增「日志」；0.9.16 新增「替换」
 * （内容替换规则库，照抄 shujuku + 开关增强）；0.9.46 新增「皮肤」。
 * 已取消含义模糊的「设置」：世界初始化回到「概览」，推进行为在「推进」，连接资料在「API」。
 *
 * U14（空间接入 M5）：新增「人物 / 物品 / 事件 / 提示词」四项。
 * - 人物 / 物品 / 事件走 Q04 目录只读口（分页，POV 只给可见条目）；
 * - 提示词沿用既有提示词库（与「推进」同一套编辑器，这里是它的独立入口，不新建第二份草稿状态）。
 * 原有 overview / nearby / progression / api / skin / logs 全部保留，功能不因新导航消失。
 *
 * C6（0.9.54）：本清单是**唯一权威**——index.js 不再自带 PAGES 副本，改为从
 * atlas-browser-entry 导出后消费。此前两处清单漂移：index.js 有 9 页（含 skin），
 * 本清单只有 8 页，而所谓一致性测试只检查「本清单是 UI 清单的子集」，
 * 因此 skin 缺失永远测不出来。
 */
export const ATLAS_UI_PAGES: ReadonlyArray<{ id: AtlasUiPage; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "map", label: "地图" },
  { id: "nearby", label: "附近" },
  { id: "changes", label: "变化" },
  { id: "progression", label: "推进" },
  { id: "characters", label: "人物" },
  { id: "items", label: "物品" },
  { id: "events", label: "事件" },
  { id: "api", label: "API" },
  { id: "replace", label: "替换" },
  { id: "prompts", label: "提示词" },
  { id: "skin", label: "皮肤" },
  { id: "logs", label: "日志" },
];
export type AtlasServiceStatus = "checking" | "online" | "offline" | "incompatible";

/** 在途回合：MESSAGE_SENT 后 prepare 的产物；停止 / 失败即放弃，绝不推进世界。 */
export interface AtlasPendingTurn {
  sqlMode?: boolean;
  turnId: string;
  chatId: string;
  messageId: string;
  userText: string;
  injectionText: string;
  sourceRefs: string[];
  relevantNpcIds: string[];
  triggerIds: string[];
}

/** 变化页回执记录（归属聊天；去重后 ≤10 条；摘要截断，无密钥）。 */
export interface AtlasReceiptRecord {
  /** 0.9.28 归属聊天：回执只属于产生它的聊天，换卡 / 换聊天不再串显 */
  chatId: string;
  receiptId: string;
  status: string;
  summary: string;
  previousTime: number;
  currentTime: number;
  currentLocationId: string | null;
  adoptedEventCount: number;
  recordedAt: number;
  retryable?: boolean;
  errorCode?: string;
  detail?: Record<string, unknown>;
}

/** Persist structured receipts only; request/response bodies and credentials
 * never become receipt logs. Existing summary-only records remain readable. */
function receiptDetail(value:unknown,depth=0):unknown{
  if(depth>8)return '[depth]';
  if(Array.isArray(value))return value.map(v=>receiptDetail(v,depth+1));
  if(typeof value==='string')return value.replace(/sk-[A-Za-z0-9_-]{6,}|Bearer\s+\S+/gi,'[redacted]');
  if(value===null||typeof value==='number'||typeof value==='boolean')return value;
  if(!value||typeof value!=='object')return undefined;
  const keys=new Set(['turnId','status','summary','groups','groupId','opIds','changedRows','issues','code','message','path','schemaPath','severity','retryable','dependsOn','dependencies','dependency','opId','phase','stage','attempt','attempts','batchId','httpStatus','durationMs','errorCode','clockBeforeS','clockAfterS','simulatedUntilS','worldChanged','timeChanged','coreSaved','coreCommitted','receipt']);
  return Object.fromEntries(Object.entries(value).filter(([k])=>keys.has(k)).map(([k,v])=>[k,receiptDetail(v,depth+1)]));
}

/**
 * D06：`/state` 的后台推演只读视图（服务端投影见 atlas-server 的 simulationView）。
 * 这里只做**有界校验**：形状不对就当没有（旧版 /state 不带该字段同样走这条路）。
 */
export interface AtlasSimulationView {
  branchKey: string;
  tasks: Array<Record<string, unknown>>;
  signals: Array<Record<string, unknown>>;
  deliveries: Array<Record<string, unknown>>;
  recentEvents: Array<Record<string, unknown>>;
  latestTurn: { receiptId: string; period: number; highlights: AtlasSimulationHighlight[]; events: Array<Record<string, unknown>> } | null;
  counts: {
    tasks: number; signals: number; deliveries: number; events: number;
    activeTasks: number; blockedTasks: number;
  };
  truncated: { tasks: number; signals: number; deliveries: number; events: number };
  /** 当前位置是否已知：「尚未确定当前位置」与「附近没有人」是两件事（§2.4）。 */
  currentLocationKnown: boolean;
  visibility: "known" | "all";
  /** 服务端明确报告模块损坏时为 true（数据已保留，绝不静默当成空表）。 */
  corrupt: boolean;
}

/** 与 atlas-ui-core 的渲染上限对齐：解析期就截断，绝不把无界数组带进面板。 */
const SIMULATION_VIEW_ROW_CAP = 64;

function simulationRows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const row of value.slice(0, SIMULATION_VIEW_ROW_CAP)) {
    if (row && typeof row === "object" && !Array.isArray(row)) rows.push(row as Record<string, unknown>);
  }
  return rows;
}

function boundedCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), 1_000_000) : 0;
}

/**
 * P1-05:从 `/state` 的 `latestTurn.highlights` 解析结构化高亮。
 * 文本长度 ≤ 140,数量 ≤ 8;缺字段/乱序/非对象统一按 hidden 兼容。
 */
export interface AtlasSimulationHighlight {
  text: string;
  visibility: "known" | "hidden";
  sourceRef?: string;
}

const SIMULATION_HIGHLIGHT_TEXT_CAP = 140;
const SIMULATION_HIGHLIGHT_ROW_CAP = 8;

function parseAtlasSimulationHighlights(raw: unknown): AtlasSimulationHighlight[] {
  if (!Array.isArray(raw)) return [];
  const out: AtlasSimulationHighlight[] = [];
  for (const item of raw.slice(0, SIMULATION_HIGHLIGHT_ROW_CAP)) {
    if (typeof item === "string") {
      // 旧存档字符串:无可见性证据,默认 hidden
      out.push({ text: item.slice(0, SIMULATION_HIGHLIGHT_TEXT_CAP), visibility: "hidden" });
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const obj = item as { text?: unknown; visibility?: unknown; sourceRef?: unknown };
      const t = typeof obj.text === "string" ? obj.text.slice(0, SIMULATION_HIGHLIGHT_TEXT_CAP) : "";
      if (t.length === 0) continue;
      const v = obj.visibility === "known" ? "known" : "hidden";
      const r = typeof obj.sourceRef === "string" && obj.sourceRef.length > 0
        ? obj.sourceRef.slice(0, 160) : undefined;
      out.push({ text: t, visibility: v, sourceRef: r });
    }
  }
  return out;
}

/**
 * D06：校验 `/state` 的 `simulationView`。
 * 返回 null = 旧版响应 / 形状非法 —— 调用方保持既有行为（不回退成「空推演」结论）。
 */
export function parseAtlasSimulationView(raw: unknown): AtlasSimulationView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const branchKey = typeof value.branchKey === "string" ? value.branchKey : "";
  if (branchKey.length === 0 || branchKey.length > 120) return null;
  const counts = (value.counts && typeof value.counts === "object" && !Array.isArray(value.counts)
    ? value.counts : {}) as Record<string, unknown>;
  const truncated = (value.truncated && typeof value.truncated === "object" && !Array.isArray(value.truncated)
    ? value.truncated : {}) as Record<string, unknown>;
  const latest = value.latestTurn && typeof value.latestTurn === "object" && !Array.isArray(value.latestTurn)
    ? value.latestTurn as Record<string, unknown> : null;
  return {
    branchKey,
    tasks: simulationRows(value.tasks),
    signals: simulationRows(value.signals),
    deliveries: simulationRows(value.deliveries),
    recentEvents: simulationRows(value.recentEvents),
    latestTurn: latest && typeof latest.receiptId === "string" && latest.receiptId.length <= 160
      ? {
          receiptId: latest.receiptId,
          period: boundedCount(latest.period),
          highlights: parseAtlasSimulationHighlights(latest.highlights),
          events: simulationRows(latest.events).slice(0, 8),
        }
      : null,
    counts: {
      tasks: boundedCount(counts.tasks),
      signals: boundedCount(counts.signals),
      deliveries: boundedCount(counts.deliveries),
      events: boundedCount(counts.events),
      activeTasks: boundedCount(counts.activeTasks),
      blockedTasks: boundedCount(counts.blockedTasks),
    },
    truncated: {
      tasks: boundedCount(truncated.tasks),
      signals: boundedCount(truncated.signals),
      deliveries: boundedCount(truncated.deliveries),
      events: boundedCount(truncated.events),
    },
    currentLocationKnown: value.currentLocationKnown === true,
    visibility: value.visibility === "all" ? "all" : "known",
    corrupt: value.corrupt === true,
  };
}

export interface AtlasUiState {
  mode: AtlasUiMode;
  page: AtlasUiPage;
  /**
   * ATLAS-18：首条消息自动建世的可见状态（idle = 已绑定或无需初始化）。
   * 失败时 worldInitializationError 只保留脱敏分类，不含路径 / Key / 请求正文。
   */
  worldInitialization: "idle" | "initializing" | "failed" | "ready";
  worldInitializationError?: string | null;
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
  /**
   * D06：后台推演模块的只读视图（`/state` 的 `simulationView`）。
   * 校验失败或旧版 /state 不带该字段时为 null —— 旧客户端行为一字不变。
   */
  simulationView: AtlasSimulationView | null;
  /**
   * D08：幕后动向的可见范围。默认只显示「已知」；作者可显式切到「全部（含未被主角得知）」，
   * 界面必须解释全量视图会包含角色秘密。切聊天即复位为 `known`。
   */
  simulationVisibility: "known" | "all";
  /** 旅行预览（地图点击目的地后暂存；确认 = 只填酒馆输入框，不自动发送） */
  destinationPreview: AtlasDestinationPreview | null;
  /** 在途回合（MESSAGE_SENT → prepare 成功；停止 / 失败即放弃） */
  pendingTurn: AtlasPendingTurn | null;
  turnPhase: "idle" | "awaiting-reply" | "queued" | "reading-context" | "committing";
  /** 最近回执（当前聊天；去重 ≤10；按聊天分桶持久化于 extensionSettings，刷新 / 切回后仍在） */
  receipts: AtlasReceiptRecord[];
  /** commit 失败后的可重试回合（仅会话内；换聊天即弃——绝不带进新聊天） */
  retryableCommit: { chatId: string; userMessageId: string; assistantMessageId: string; swipeId: string | null; sqlMode?: boolean } | null;
  /** 用户可读的模式说明（空状态文案） */
  modeHint: string | null;
  /** 世界书写入状态提示（失败 / 冲突时非空；成功写图为 null） */
  lorebookHint: string | null;
  lastError: string | null;
  /** ATLAS-06：楼层变动（swipe / 编辑 / 删除）回退提示（非错误；渲染为普通提示） */
  worldNotice: string | null;
  /** ATLAS-06：swipe 回退后暂存的同级重推演输入（生成结束后用它重建回合） */
  rearmTurn: { userMessageId: string; userText: string; swipeId: string } | null;
}

export interface AtlasDestinationPreview {
  destinationId: string;
  destinationName: string;
  distance: number;
  estimatedDuration: number;
  distanceUnit?: 'm';
  durationUnit?: 's';
  factors: string[];
}

/** Server Plugin HTTP 客户端（index.js 提供同源 fetch 实现）。 */
export interface AtlasUiApi {
  request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
}

/** 宿主适配：chatMetadata / extensionSettings 的读写（每次调用都重新取当前聊天）。 */
export interface AtlasUiHost {
  getChatId(): string | null;
  /** 0.9.42 起为异步：宿主可能需要先把旧世界文档迁移进会话（chatMetadata.atlas）再返回绑定。 */
  readBinding(): unknown | Promise<unknown>;
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
  "GENERATION_STARTED",
  "MESSAGE_SWIPED",
  "MESSAGE_EDITED",
  "MESSAGE_DELETED",
] as const;

/**
 * 事件载荷适配结果（ST 各事件数据形状不统一，适配在 index.js 完成）。
 * ATLAS-06 新增：
 * - generation-started：酒馆生成门控（quiet / dryRun / automatic_trigger → gated，shujuku 同款）；
 * - message-swiped：regenerating = 适配器据 swipes 形状判断「是否正在生成新变体」；
 *   无法判定时为 null → UI 跳过（宁可漏回退，不可误回退）；
 * - message-edited / message-deleted：楼层变动回退触发器。
 */
export type AtlasAdaptedEvent =
  | { kind: "message-sent"; messageId: string; userText: string }
  | { kind: "generation-ended"; assistantMessageId: string; assistantText: string; foreground?: boolean; completionSignal?: AtlasGenerationSignal }
  | { kind: "generation-stopped" }
  | { kind: "generation-started"; gated: boolean; metadata?: AtlasGenerationMetadata; retryTurn?: { userMessageId: string; userText: string; assistantMessageId: string } }
  | { kind: "message-swiped"; messageId: string; userMessageId: string; userText: string; regenerating: boolean | null }
  | { kind: "message-edited"; messageId: string }
  | { kind: "message-deleted"; messageId: string };

export interface AtlasUiCore {
  init(): void;
  dispose(): void;
  handleEvent(event: string): Promise<void>;
  refresh(): Promise<void>;
  getState(): AtlasUiState;
  setPanelOpen(open: boolean): void;
  setPage(page: AtlasUiPage): void;
  /**
   * D08：作者的「查看全部幕后推演」开关。
   * 默认 `known`（只给主角可知的）；切到 `all` 会带上 hidden 内容并**明确标注**。
   * 它只影响读取视图，不改任何数据本体，也绝不跨聊天保留。
   */
  setSimulationVisibility(visibility: "known" | "all"): Promise<void>;
  /** ATLAS-18：手动重试首条消息自动建世（概览页按钮）。 */
  initializeWorld(): Promise<boolean>;
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
  /** 0.9.22 立即推演：不发言也让世界流动（推进页按钮；合成一回合）。 */
  manualAdvance(): Promise<void>;
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
      return "当前聊天未绑定 Atlas 世界。发送第一条消息会按角色卡自动建世；也可在「概览」的高级区绑定已有世界。";
    case "world-missing":
      return "绑定的世界不存在或已被删除。请解绑后重新选择世界。";
    case "ready":
      return null;
  }
}

export function createAtlasUiCore(deps: {
  api: AtlasUiApi;
  sqlEnabled?: () => boolean;
  getPlayerName?: () => string;
  getCommitIdentity?: (request: AtlasTurnCommitRequest) => { messageUID: string; variantKey: string } | null;
  isCommitCurrent?: (request: AtlasTurnCommitRequest) => boolean;
  /** Capture complete host text once; model request budgets must not invalidate long floors. */
  createCommitGuard?: (request: AtlasTurnCommitRequest) => () => boolean;
  /** Read the same visible floors again after asynchronous host postprocessing. */
  resolveCommitFloor?: (userMessageId: string, assistantMessageId: string) => { userText: string; assistantText: string } | null;
  host: AtlasUiHost;
  emitter: AtlasUiEmitter;
  onDiagnostic?: (event: AtlasDiagnosticInput) => void;
  /** Clear foreground prompt injection only after its own completion or stop. */
  onGenerationComplete?: () => void;
  now?: () => number;
  /** 任意状态变化后的回调（UI 层重绘用；同步调用，不等待异步刷新完成） */
  onStateChange?: () => void;
  /** Host-only context reads must not hold a completed prose turn indefinitely. */
  contextTimeoutMs?: number;
  /**
   * 世界书写入钩子（ATLAS-09；index.js 注入酒馆 world-info 适配）。
   * commit 成功且引擎给出条目规划时调用；失败只记 lorebookHint，绝不影响回合成功。
   */
  /** null keeps the legacy scene; SQL failure returns empty text, never author data. */
  getNarrativeContext?: () => Promise<string | null>;
  onLorebookSync?: (plans: AtlasLorebookPlans) => Promise<unknown>;
  /**
   * 0.9.47 世界书聊天级生命周期钩子：CHAT_CHANGED 且数据隔离清理完成后触发。
   * bound = 新聊天已绑定世界：壳层应按会话世界状态重建「Atlas 动向」；
   * !bound = 新聊天未绑定（开场白阶段）：壳层应清理书里残留的 Atlas 条目
   * （学 shujuku 新对话抑制——旧聊天的动向不给新聊天看）。
   * 失败静默：世界书只影响注入，绝不影响聊天与推演。
   */
  onLorebookChatSwitch?: (info: { chatId: string | null; bound: boolean }) => Promise<unknown>;
  /** 酒馆事件载荷适配（ST 事件数据形状不统一；返回 null = 无法适配，忽略该事件） */
  adaptEvent?: (event: string, payload: unknown) => AtlasAdaptedEvent | null;
  /**
   * ATLAS-06 楼层重解析（shujuku 意图快照）：GENERATION_ENDED 的锚点可能早于宿主把
   * AI 楼层 push 进 chat，防抖窗口结束后用本钩子重读真实末条 AI 楼层；
   * 返回 null（无 AI 楼层 / 聊天不可读）→ 回退用事件锚点。
   */
  resolveAssistantFloor?: () => { assistantMessageId: string; assistantText: string } | null;
  /** GENERATION_ENDED 防抖窗口（ms；测试可调小）。 */
  endedDebounceMs?: number;
  /** 楼层变动（swipe / 编辑 / 删除）聚合防抖窗口（ms；测试可调小）。 */
  mutationDebounceMs?: number;
  /**
   * 首条消息自动建世（0.8.2）：聊天未绑定且服务在线时，MESSAGE_SENT 先调用本钩子
   * （index.js：读角色卡 → buildStarterWorld → /worlds/import → bindToWorld）。
   * 返回 true = 绑定就绪，本条消息照常 prepare；false / 未注入 = 保持未绑定，跳过。
   */
  ensureWorld?: () => Promise<boolean>;
  /** 把早期自动建世误用的角色卡名纠正为当前用户人设名；失败留待下次刷新。 */
  syncProtagonistIdentity?: (chatId: string, worldId: string) => Promise<boolean>;
  /** 当前聊天第一条已完成的助手开场白；无开场时返回 null。 */
  getOpeningMessage?: () => Promise<{ messageId: string; text: string } | null>;
  /**
   * 0.9.21 世界书资料（可选）：宿主侧读当前角色卡世界书 → 有界文本。
   * commit 前调用；失败 / 未注入 → 无资料块，照常推演（绝不因资料失败阻断回合）。
   * 只进推演请求，不进主聊天注入（主聊天由酒馆世界书激活管线负责）。
   */
  getLoreSupplement?: (context: {
    chatId: string;
    characterId: string | number | null;
    mode: "turn" | "geo" | "bootstrap";
    userText: string;
    assistantText: string;
    recentAssistantTexts: readonly string[];
  }) => Promise<string>;
  /**
   * 0.9.22 立即推演（可选）：读最近一条助手楼层正文作为推演素材；
   * 未注入 / 失败 / 空 → 用占位正文（仅时间与日程流动）。
   */
  getLastAssistantText?: () => Promise<string | null>;
  /**
   * 0.9.25 shujuku 占位符体系（可选）：commit 前采集宿主上下文——
   * recentAssistantTexts（$7 前文 AI 楼层，已排除当前楼层）/ personaDescription（$U）/
   * charDescription（$C）。失败 / 未注入 → 字段缺省，照常推演（绝不因上下文失败阻断回合）。
   */
  getCommitContext?: (assistantText: string) => Promise<{
    recentAssistantTexts?: string[];
    personaDescription?: string;
    charDescription?: string;
  } | null>;
}): AtlasUiCore {
  const { api, host, emitter } = deps;
  const now = deps.now ?? Date.now;
  const traces = new Map<string, string>();
  const attempts = new Map<string, number>();
  const syncedProtagonistChats = new Set<string>();
  let activeTraceId: string | null = null;
  let activeAttemptId: string | null = null;
  let traceSequence = 0;
  function diagnostic(event: AtlasDiagnosticInput): void {
    try {
      deps.onDiagnostic?.({
        ...event,
        ...(activeTraceId && !event.traceId ? { traceId: activeTraceId } : {}),
        ...(activeAttemptId && !event.attemptId ? { attemptId: activeAttemptId } : {}),
      });
    } catch { /* diagnostics must not affect the turn */ }
  }

  let state: AtlasUiState = {
    mode: "unbound",
    page: "overview",
    worldInitialization: "idle",
    worldInitializationError: null,
    panelOpen: false,
    serviceStatus: "checking",
    serviceProtocolVersion: null,
    binding: null,
    bindingInvalid: false,
    chatId: null,
    stateData: null,
    simulationView: null,
    simulationVisibility: "known",
    destinationPreview: null,
    pendingTurn: null,
    turnPhase: "idle",
    receipts: [],
    retryableCommit: null,
    modeHint: modeHintFor("unbound", false, null, false),
    lorebookHint: null,
    lastError: null,
    worldNotice: null,
    rearmTurn: null,
  };
  let initialized = false;
  let disposed = false;
  let healthCheckedAt = -Infinity;
  type CommitFlight = { turnId: string; done: Promise<void>; finish: () => void };
  let commitFlight: CommitFlight | null = null;
  function claimCommit(turnId: string): CommitFlight {
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const flight = { turnId, done, finish };
    commitFlight = flight;
    return flight;
  }
  function releaseCommit(flight: CommitFlight): void {
    if (commitFlight === flight) commitFlight = null;
    flight.finish();
  }
  function reportHostTurnFailure(turn: { turnId: string; chatId: string }, summary: string, code: string): void {
    if (state.chatId !== turn.chatId) return;
    diagnostic({ level: 'error', source: 'host', code, operation: 'commit', phase: 'validation', outcome: 'failed' });
    addReceipt({ receiptId: turn.turnId, status: 'failed', branchId: state.binding?.branchId ?? null,
      previousTime: state.binding?.worldTimeCursor ?? 0, currentTime: state.binding?.worldTimeCursor ?? 0,
      currentLocationId: state.binding?.currentLocationId ?? null, triggeredNpcIds: [], adoptedEventIds: [],
      summary, retryable: false }, turn.chatId, { errorCode: code, coreSaved: false });
    setState({ pendingTurn: null, rearmTurn: null, retryableCommit: null, lastError: summary });
  }
  let generationRevision = 0;
  const sqlEnabled = () => deps.sqlEnabled?.() === true;
  let sqlRetryRequest: AtlasTurnCommitRequest | null = null;
  let sqlPartialTurnId: string | null = null;
  const bootstrappedBranches = new Set<string>();
  const openingAttemptedMessages = new Set<string>();
  let stoppedGeneration = false;
  /** 最近一次 MESSAGE_SENT 触发的 prepare 任务（waitPendingTurn 等它落定）。 */
  let lastPrepareTask: Promise<void> | null = null;
  let lastMutationTask: Promise<void> | null = null;
  let retryRollbackFloor: string | null = null;
  /** ATLAS-06：当前生成是否被门控（quiet / dryRun / automatic_trigger → 事件全部忽略）。 */
  const generationLifecycle = createAtlasGenerationLifecycle(now);
  /** ATLAS-06：rearm 重推演时本次 commit 使用的唯一 swipeId。 */
  let swipeIdForNextCommit: string | null = null;
  /** ATLAS-06 防抖计时器（ENDED 重解析 / 楼层变动聚合）。 */
  let endedTimer: ReturnType<typeof setTimeout> | null = null;
  let mutationTimer: ReturnType<typeof setTimeout> | null = null;
  let lastEndedEvent: { assistantMessageId: string; assistantText: string } | null = null;
  let mutationQueue: Extract<AtlasAdaptedEvent, { kind: "message-swiped" | "message-edited" | "message-deleted" }>[] = [];
  /** ATLAS-06：本会话已回退过的楼层（防抖窗口外的重复事件也不再二次回退；切聊天清空）。 */
  const rolledBackFloors = new Set<string>();
  const listeners: Array<{ event: string; handler: (payload?: unknown) => void }> = [];

  function setState(patch: Partial<AtlasUiState>): void {
    state = { ...state, ...patch };
    if (patch.pendingTurn === null) state.turnPhase = "idle";
    else if (patch.pendingTurn && patch.turnPhase === undefined) state.turnPhase = "awaiting-reply";
    if (patch.mode !== undefined || patch.bindingInvalid !== undefined || patch.serviceProtocolVersion !== undefined) {
      state.modeHint = modeHintFor(state.mode, state.bindingInvalid, state.serviceProtocolVersion, state.binding !== null && !state.binding.enabled);
    }
    deps.onStateChange?.();
  }

  async function readContextWithDeadline<T>(work: Promise<T>): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), Math.max(1, deps.contextTimeoutMs ?? 10_000));
      })]);
    } catch { return null; }
    finally { if (timer) clearTimeout(timer); }
  }

  /** 回执记录：归属当前聊天、去重、摘要截断（≤300）、有界（每聊天 ≤10）并按聊天分桶持久化。 */
  const RECEIPTS_MAX = 10;
  /** 0.9.28 分桶持久化最多保留的聊天数（按各桶最新回执时间修剪）。 */
  const RECEIPTS_CHATS_MAX = 20;
  let legacyReceiptsCleared = false;

  /** 持久化桶形状不可信：逐桶逐条校验（宽容降级，绝不炸面板）。 */
  function sanitizeReceiptRecord(raw: unknown, fallbackChatId: string): AtlasReceiptRecord | null {
    if (!raw || typeof raw !== "object") return null;
    const record = raw as Record<string, unknown>;
    if (typeof record.receiptId !== "string" || typeof record.summary !== "string") return null;
    return {
      receiptId: record.receiptId,
      chatId: typeof record.chatId === "string" && record.chatId ? record.chatId : fallbackChatId,
      status: typeof record.status === "string" ? record.status : "committed",
      summary: record.summary.slice(0, 300),
      previousTime: typeof record.previousTime === "number" ? record.previousTime : 0,
      currentTime: typeof record.currentTime === "number" ? record.currentTime : 0,
      currentLocationId: typeof record.currentLocationId === "string" ? record.currentLocationId : null,
      adoptedEventCount: typeof record.adoptedEventCount === "number" ? record.adoptedEventCount : 0,
      recordedAt: typeof record.recordedAt === "number" ? record.recordedAt : 0,
      ...(typeof record.retryable==='boolean'?{retryable:record.retryable}:{}),
      ...(typeof record.errorCode==='string'?{errorCode:record.errorCode}:{}),
      ...(record.detail&&typeof record.detail==='object'?{detail:receiptDetail(record.detail) as Record<string,unknown>}:{}),
    };
  }

  function readReceiptBuckets(): Record<string, AtlasReceiptRecord[]> {
    const raw = host.readData("receiptsByChat");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const buckets: Record<string, AtlasReceiptRecord[]> = {};
    for (const [chatId, list] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const records = list.slice(0, RECEIPTS_MAX)
        .map((item) => sanitizeReceiptRecord(item, chatId))
        .filter((item): item is AtlasReceiptRecord => item !== null);
      if (records.length > 0) buckets[chatId] = records;
    }
    return buckets;
  }

  function persistReceipts(chatId: string, receipts: AtlasReceiptRecord[]): void {
    const buckets = readReceiptBuckets();
    if (receipts.length > 0) buckets[chatId] = receipts;
    else delete buckets[chatId];
    const kept = Object.entries(buckets)
      .sort((left, right) => (right[1][0]?.recordedAt ?? 0) - (left[1][0]?.recordedAt ?? 0))
      .slice(0, RECEIPTS_CHATS_MAX);
    host.writeData("receiptsByChat", Object.fromEntries(kept));
    // 0.9.28 迁移：旧全局 receipts 键（无聊天归属）一次性废弃，不再恢复
    if (!legacyReceiptsCleared) {
      legacyReceiptsCleared = true;
      host.writeData("receipts", null);
    }
  }

  /** 恢复指定聊天的回执（切聊天 / init 时调用；无聊天 = 空列表）。 */
  function restoreReceiptsForChat(chatId: string | null): void {
    if (chatId === null) {
      setState({ receipts: [] });
      return;
    }
    setState({ receipts: readReceiptBuckets()[chatId] ?? [] });
  }

  function addReceipt(receipt: AtlasTurnReceipt, chatId: string, extra:Record<string,unknown>={}): void {
    // 0.9.28 归属守卫：跨聊天迟到的回执直接丢弃（服务端世界已一致，只是 UI 不显示过期回执）
    if (chatId !== state.chatId) return;
    const previous = state.receipts.find(r => r.receiptId === receipt.receiptId);
    if (previous && !(sqlEnabled() && (previous.status === 'failed' && receipt.status !== 'failed' || previous.summary !== receipt.summary || JSON.stringify(previous.detail)!==JSON.stringify(receiptDetail(extra))))) return;
    const record: AtlasReceiptRecord = {
      receiptId: receipt.receiptId,
      chatId,
      status: receipt.status,
      summary: receipt.summary.slice(0, 300),
      previousTime: receipt.previousTime,
      currentTime: receipt.currentTime,
      currentLocationId: typeof receipt.currentLocationId === "string" ? receipt.currentLocationId : null,
      adoptedEventCount: receipt.adoptedEventIds.length,
      recordedAt: now(),
      retryable:receipt.retryable,
      ...(typeof extra.errorCode==='string'?{errorCode:extra.errorCode}:{}),
      detail:receiptDetail(extra) as Record<string,unknown>,
    };
    const receipts = [record, ...state.receipts.filter(r => r.receiptId !== receipt.receiptId)].slice(0, RECEIPTS_MAX);
    setState({ receipts });
    persistReceipts(chatId, receipts);
  }

  /** 世界书绑定冲突 / 写入失败 → 用户可读提示；成功且无冲突 → null。 */
  function lorebookHintFromResult(result: unknown): string | null {
    if (!result || typeof result !== "object" || Array.isArray(result)) return null;
    const record = result as Record<string, unknown>;
    if (record.sharedClean === false) return "旧 Atlas 动态条目未能全部清理；可重试上下文同步。";
    if (record.contentTarget === "none") return "宿主暂时无法注入场景上下文；本轮没有写入世界书作为替代。";
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
      diagnostic({ level: "warn", source: "lorebook", code: "LOREBOOK_PLAN_INVALID",
        operation: "lorebook", phase: "validation", outcome: "failed",
        details: { coreCommitted: true } });
      setState({ lorebookHint: "世界书条目载荷异常，本轮跳过写入。" });
      return;
    }
    try {
      const result = await deps.onLorebookSync(parsed.value);
      diagnostic({ level: "info", source: "lorebook", code: "LOREBOOK_SYNC_COMPLETE",
        operation: "lorebook", phase: "write", outcome: "success",
        details: { coreCommitted: true } });
      setState({ lorebookHint: lorebookHintFromResult(result) });
    } catch (error) {
      diagnostic({ level: "warn", source: "lorebook", code: "LOREBOOK_SYNC_FAILED",
        operation: "lorebook", phase: "write", outcome: "failed",
        details: { coreCommitted: true } });
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
        diagnostic({ level: "error", source: "engine", code: "ENGINE_PROTOCOL_MISMATCH",
          operation: "health", phase: "response", outcome: "failed",
          httpStatus: result.status });
        setState({ serviceStatus: "incompatible", serviceProtocolVersion: version, mode: "protocol-incompatible" });
        return;
      }
      diagnostic({ level: "debug", source: "engine", code: "ENGINE_HEALTH_OK",
        operation: "health", phase: "response", outcome: "success",
        httpStatus: result.status });
      setState({ serviceStatus: "online", serviceProtocolVersion: version });
    } catch {
      diagnostic({ level: "error", source: "engine", code: "ENGINE_HEALTH_FAILED",
        operation: "health", phase: "request", outcome: "failed", retryable: true });
      setState({ serviceStatus: "offline", serviceProtocolVersion: null, mode: "offline" });
    }
  }

  /** 从宿主重新读取当前聊天与绑定（绝不缓存聊天对象引用）。 */
  async function syncFromHost(): Promise<void> {
    const chatId = host.getChatId();
    const panelOpen = host.readPanelOpen();
    setState({ chatId, panelOpen, destinationPreview: null });
    if (state.serviceStatus === "offline" || state.serviceStatus === "incompatible") return;

    // 0.9.17 数据隔离（shujuku hasActiveChatContext 口径）：没有活动聊天 = 没有任何数据。
    // 宿主 chatMetadata 可能仍滞留上一个聊天的绑定（关聊天 / 切卡瞬间），绝不能拿来用。
    if (chatId === null) {
      setState({ binding: null, bindingInvalid: false, mode: "unbound", stateData: null });
      return;
    }
    let raw: unknown;
    if (sqlEnabled()) {
      try {
        const result = await api.request('POST', '/sql/chat/binding', { chatUid: chatId });
        const body = result.body as { ok?: boolean; data?: { binding?: unknown }; error?: { message?: string } };
        if (state.chatId !== chatId || !sqlEnabled()) return;
        if (result.status !== 200 || !body.ok || !body.data?.binding) {
          setState({ binding: null, stateData: null, mode: 'unbound', lastError: body.error?.message ?? 'SQL 聊天初始化未完成。' });
          return;
        }
        raw = body.data.binding;
      } catch {
        setState({ binding: null, stateData: null, mode: 'unbound', lastError: 'SQL 聊天初始化失败。' });
        return;
      }
    } else raw = await host.readBinding();
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
    if (binding.chatId !== chatId) {
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
    // 0.9.17：请求与绑定必须同属当前聊天；响应必须自报同一 chatId 才收（跨聊天竞态丢弃）。
    if (binding.chatId !== state.chatId) {
      setState({ binding: null, mode: "unbound", stateData: null });
      return;
    }
    try {
      // 0.9.42 会话承载：/state 改 POST，chatId 随体携带（世界文档由 api 封装随请求带上）
      const useSql = sqlEnabled();
      const result = await api.request("POST", useSql ? '/sql/chat/state' : "/state", {
        chatId: binding.chatId,
        ...(useSql ? { chatUid: binding.chatId } : {}),
        // D08：只有作者显式切到「全部」时才带上这个字段——默认请求形状与旧版一致
        ...(state.simulationVisibility === "all" ? { simulationVisibility: "all" } : {}),
      });
      const body = result.body as { ok?: boolean; error?: { code?: string; message?: string }; data?: Record<string, unknown> };
      // 等待期间聊天已切换 → 响应属于旧聊天，丢弃（stateData 绝不跨聊天存活）
      if (state.chatId === null || binding.chatId !== state.chatId || useSql !== sqlEnabled()) {
        diagnostic({ level: "debug", source: "ui", code: "STALE_CHAT_RESPONSE_DROPPED",
          operation: "state", phase: "response", outcome: "skipped" });
        return;
      }
      if (result.status === 200 && body.ok && body.data) {
        const responseChatId = typeof (body.data as Record<string, unknown>).chatId === "string"
          ? (body.data as Record<string, unknown>).chatId as string
          : binding.chatId;
        if (responseChatId !== state.chatId) {
          diagnostic({ level: "warn", source: "ui", code: "STALE_CHAT_RESPONSE_DROPPED",
            operation: "state", phase: "response", outcome: "skipped" });
          return;
        }
        diagnostic({ level: "debug", source: "ui", code: "STATE_REFRESH_COMPLETE",
          operation: "state", phase: "response", outcome: "success",
          httpStatus: result.status });
        /**
         * D06：推演视图必须**校验后**才进面板（无界数组在解析期截断）。
         * 跨聊天竞态由上面的 chatId 复核 + 切聊天清空共同保证；
         * 旧版 /state 没有该字段时保持既有行为（simulationView = null，绝不回退成「空推演」结论）。
         */
        const simulationView = parseAtlasSimulationView((body.data as Record<string, unknown>).simulationView);
        setState({
          mode: "ready",
          stateData: body.data,
          simulationView,
          lastError: null,
        });
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
      diagnostic({ level: "warn", source: "ui", code: "STATE_REFRESH_FAILED",
        operation: "state", phase: "response", outcome: "failed",
        httpStatus: result.status, errorCode: body.error?.code, retryable: true });
      setState({ lastError: body.error?.message ?? `状态读取失败（HTTP ${result.status}）` });
    } catch {
      diagnostic({ level: "warn", source: "ui", code: "STATE_REFRESH_FAILED",
        operation: "state", phase: "request", outcome: "failed", retryable: true });
      setState({ serviceStatus: "offline", mode: "offline", stateData: null });
    }
  }

  async function refresh(): Promise<void> {
    await checkHealth();
    await syncFromHost();
    if (state.binding && state.serviceStatus === "online") {
      const key = `${state.binding.chatId}|${state.binding.worldId}`;
      if (!sqlEnabled() && deps.syncProtagonistIdentity && !syncedProtagonistChats.has(key)) {
        try {
          if (await deps.syncProtagonistIdentity(state.binding.chatId, state.binding.worldId)) {
            syncedProtagonistChats.add(key);
          }
        } catch { /* 用户聊天和地图仍可正常读取，下一次刷新再试。 */ }
      }
      await loadStateData();
    }
  }

  /** 在途异步工作登记（handleEvent 测试入口等待用）。 */
  let asyncWork: Promise<unknown>[] = [];
  function track<T>(task: Promise<T>): Promise<T> {
    // Attach a rejection handler immediately; flushAsyncWork may run later.
    void task.catch(() => diagnostic({
      level: "error", source: "ui", code: "UNEXPECTED_ERROR",
      operation: "event", phase: "async", outcome: "failed",
    }));
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
      // 切聊天：清回合/门控/防抖状态（rearm 属于旧聊天的楼层，绝不能带过去）
      generationLifecycle.reset();
      retryRollbackFloor = null;
      lastMutationTask = null;
      stoppedGeneration = false;
      generationRevision += 1;
      sqlRetryRequest = null;
      swipeIdForNextCommit = null;
      activeTraceId = null;
      activeAttemptId = null;
      traces.clear();
      attempts.clear();
      clearTimers();
      rolledBackFloors.clear();
      setState({ rearmTurn: null });
      // 0.9.17 数据隔离：先把旧聊天的数据从面板上摘掉再刷新——
      // 切卡 / 关聊天的瞬间绝不能让上一张卡的世界还挂在界面上。
      // 0.9.28 补全：回执 / 重试挂单 / 错误同样归属聊天——一并摘掉，
      // 然后恢复新聊天自己的回执桶（换卡后看到的永远是当前聊天的世界变化）。
      setState({
        binding: null,
        stateData: null,
        // D06：推演视图同属旧聊天——切聊天必须一起摘掉，绝不让上一聊天的幕后动向留在面板上
        simulationView: null,
        // D08：全量视图开关同样不跨聊天保留（作者在 A 打开的「含秘密」不该在 B 继续生效）
        simulationVisibility: "known",
        mode: "unbound",
        modeHint: null,
        pendingTurn: null,
        retryableCommit: null,
        lastError: null,
      });
      restoreReceiptsForChat(host.getChatId());
      // 0.9.47 世界书聊天级生命周期（学 shujuku 的开场清理 + 隔离）：
      // 切到新聊天（未绑定世界）→ 清掉书里上一聊天留下的 Atlas 条目；
      // 切回已绑定的聊天 → 由壳层按会话世界状态重建「Atlas 动向」。
      // 世界数据在 chatMetadata.atlas 会话里零丢失，书里只留当前聊天的动向。
      if (!sqlEnabled() && deps.onLorebookChatSwitch) {
        const chatId = host.getChatId();
        void track(
          Promise.resolve()
            .then(() => host.readBinding())
            .then((raw) => deps.onLorebookChatSwitch!({ chatId, bound: parseAtlasChatBinding(raw).ok }))
            .catch(() => {}),
        );
      }
      void track(refresh());
      return;
    }
    // 回合事件：经适配器转成结构化动作；无法适配（形状未知）则忽略，绝不猜测
    const adapted = deps.adaptEvent?.(event, payload) ?? null;
    if (!adapted) return;
    if (adapted.kind === "message-sent") {
      const generation = generationLifecycle.message();
      if (generation.gated) {
        diagnostic({ level: "debug", source: "host", code: "GENERATION_GATED",
          operation: "generation", phase: "message", outcome: "skipped",
          details: { reasonCode: "QUIET_OR_AUTOMATIC", ...generation.details } });
        return;
      } // quiet / dryRun / automatic_trigger
      stoppedGeneration = false;
      retryRollbackFloor = null;
      setState({ rearmTurn: null }); // 真实用户回合优先于 swipe rearm
      swipeIdForNextCommit = null;
      const task = onMessageSent(adapted.messageId, adapted.userText);
      lastPrepareTask = task;
      void track(task);
    } else if (adapted.kind === "generation-started") {
      const generation = generationLifecycle.start(adapted.gated, adapted.metadata);
      diagnostic({ level: "debug", source: "host", code: "HOST_GENERATION_STARTED",
        operation: "generation", phase: "started", outcome: adapted.gated ? "skipped" : "started",
        details: { ...generation.details, gated: generation.gated } });
      if (!adapted.gated) stoppedGeneration = false;
      // Regenerating an uncommitted/failed floor emits no new MESSAGE_SENT.
      // A committed floor still waits for its normal mutation/rollback path.
      if (!adapted.gated && adapted.retryTurn && !state.pendingTurn) {
        const retry = adapted.retryTurn;
        if (state.binding?.enabled) {
          retryRollbackFloor = state.binding.lastCommittedMessageId === retry.assistantMessageId ? retry.assistantMessageId : null;
          setState({ rearmTurn: { userMessageId: retry.userMessageId, userText: retry.userText, swipeId: 'swipe-' + now() } });
        }
      }
      // Menu regeneration has no MESSAGE_SENT event. Reprepare the stopped turn.
      if (!adapted.gated && state.rearmTurn && !state.pendingTurn && retryRollbackFloor === null) {
        const rearm = state.rearmTurn;
        swipeIdForNextCommit = rearm.swipeId;
        const task = onMessageSent(rearm.userMessageId, rearm.userText);
        lastPrepareTask = task;
        void track(task);
      }
    } else if (adapted.kind === "generation-ended") {
      const completionSignal = adapted.completionSignal ?? "received";
      const generation = generationLifecycle.complete(completionSignal, adapted.foreground === true);
      if (generation.duplicate) return;
      if (stoppedGeneration) {
        diagnostic({ level: "info", source: "host", code: "GENERATION_STOPPED",
          operation: "generation", phase: "ended", outcome: "skipped" });
        return;
      }
      // An internal completion restores the still-running foreground request.
      if (generation.gated) {
        diagnostic({ level: "debug", source: "host", code: "GENERATION_GATED",
          operation: "generation", phase: "ended", outcome: "skipped",
          details: { reasonCode: "QUIET_OR_AUTOMATIC", completionSignal, ...generation.details } });
        return;
      }
      deps.onGenerationComplete?.();
      scheduleGenerationEnded(adapted);
    } else if (adapted.kind === "generation-stopped") {
      const generation = generationLifecycle.stop();
      if (generation.gated) {
        diagnostic({ level: "debug", source: "host", code: "GENERATION_GATED",
          operation: "generation", phase: "stopped", outcome: "skipped",
          details: { reasonCode: "QUIET_OR_AUTOMATIC", ...generation.details } });
        return;
      }
      deps.onGenerationComplete?.();
      onGenerationStopped();
    } else {
      // 楼层变动（swipe / 编辑 / 删除）：300ms 级防抖聚合——批量删除与 regenerate
      // 「先删后加」会连发事件（shujuku 纪要 §5），绝不能逐事件回退（会连环建分支）。
      scheduleMutation(adapted);
    }
  }

  function clearTimers(): void {
    if (endedTimer) { clearTimeout(endedTimer); endedTimer = null; }
    if (mutationTimer) { clearTimeout(mutationTimer); mutationTimer = null; }
    lastEndedEvent = null;
    mutationQueue = [];
  }

  /**
   * ATLAS-06 ENDED 楼层重解析：GENERATION_ENDED 的 message_id 只作锚点——
   * 事件到达时宿主可能还没把 AI 楼层 push 进 chat（shujuku 意图快照同款问题）。
   * 防抖窗口结束后用 resolveAssistantFloor 重读真实末条 AI 楼层，读不到再退回事件锚点。
   */
  function scheduleGenerationEnded(adapted: Extract<AtlasAdaptedEvent, { kind: "generation-ended" }>): void {
    lastEndedEvent = { assistantMessageId: adapted.assistantMessageId, assistantText: adapted.assistantText };
    if (endedTimer) clearTimeout(endedTimer);
    endedTimer = setTimeout(() => {
      endedTimer = null;
      void track(consumeGenerationEnded());
    }, Math.max(0, deps.endedDebounceMs ?? 350));
  }

  async function consumeGenerationEnded(): Promise<void> {
    const fromHost = deps.resolveAssistantFloor?.() ?? null;
    // 重解析结果只在「完整可用」时采用；否则退回事件锚点。
    // 空文本不在这里拦截——交给 onGenerationEnded 统一走「放弃 pending」路径。
    const resolved =
      fromHost && fromHost.assistantMessageId && fromHost.assistantText.trim()
        ? fromHost
        : lastEndedEvent;
    lastEndedEvent = null;
    if (!resolved || !resolved.assistantMessageId) {
      diagnostic({ level: "warn", source: "host", code: "AI_FLOOR_UNRESOLVED",
        operation: "generation", phase: "ended", outcome: "skipped" });
      if (!state.pendingTurn && !lastPrepareTask && !state.rearmTurn) return;
      generationRevision += 1;
      setState({ pendingTurn: null, rearmTurn: null, lastError: "正文生成已结束，但没有取得助手回复，本轮世界状态未更新。" });
      return;
    }
    await onGenerationEnded(resolved.assistantMessageId, String(resolved.assistantText ?? ""));
  }

  function scheduleMutation(adapted: Extract<AtlasAdaptedEvent, { kind: "message-swiped" | "message-edited" | "message-deleted" }>): void {
    if (sqlEnabled() && (adapted.kind !== 'message-swiped' || adapted.regenerating === true)) {
      generationRevision += 1;
      sqlRetryRequest = null;
    }
    mutationQueue.push(adapted);
    if (mutationTimer) clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      const queue = mutationQueue;
      mutationQueue = [];
      const previous = lastMutationTask;
      lastMutationTask = (async () => { await previous; await processMutations(queue); })();
      void track(lastMutationTask);
    }, Math.max(0, deps.mutationDebounceMs ?? 400));
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
    const revision = generationRevision;
    const useSql = sqlEnabled();
    if (!traces.has(messageId)) traces.set(messageId, "turn-" + now().toString(36) + "-" + (++traceSequence));
    activeTraceId = traces.get(messageId) ?? null;
    const attempt = (attempts.get(messageId) ?? 0) + 1;
    attempts.set(messageId, attempt);
    activeAttemptId = "attempt-" + attempt;
    diagnostic({ level: "info", source: "host", code: "TURN_STARTED",
      operation: "generation", phase: "message", outcome: "started" });
    const chatId = state.chatId;
    if (!chatId || state.serviceStatus !== "online") {
      diagnostic({ level: "warn", source: "ui", code: "TURN_SKIPPED_NOT_READY",
        operation: "prepare", phase: "skipped", outcome: "skipped",
        details: { reasonCode: "SERVICE_NOT_READY" } });
      return;
    }
    if (state.pendingTurn) {
      diagnostic({ level: "info", source: "ui", code: "TURN_SKIPPED_PENDING",
        operation: "prepare", phase: "skipped", outcome: "skipped",
        details: { reasonCode: "PENDING_EXISTS" } });
      return;
    }
    // 0.8.2 自动建世：未绑定（且未手动停用）时先经宿主钩子建最小世界并绑定；
    // 失败绝不阻断酒馆生成，只是本条消息不推演（与未绑定行为一致）。
    let binding = state.binding;
    if (!binding && !useSql && deps.ensureWorld) {
      setState({ worldInitialization: "initializing", worldInitializationError: null });
      let ensured = false;
      try {
        ensured = await deps.ensureWorld();
      } catch {
        ensured = false;
      }
      if (disposed) return;
      binding = state.binding;
      if (!ensured || !binding) {
        diagnostic({ level: "error", source: "ui", code: "WORLD_ENSURE_FAILED",
          operation: "prepare", phase: "world", outcome: "failed", retryable: true });
        // 失败绝不阻断酒馆生成：本条消息不推演，下一条消息或「重试初始化」可再试
        setState({
          worldInitialization: "failed",
          worldInitializationError: "世界初始化未完成——可在「概览」重试，本条消息未推演。",
        });
        return;
      }
      setState({ worldInitialization: "ready", worldInitializationError: null });
    }
    if (!binding?.enabled) {
      diagnostic({ level: "info", source: "ui", code: "GENERATION_GATED",
        operation: "prepare", phase: "binding", outcome: "skipped",
        details: { reasonCode: "BINDING_DISABLED" } });
      return;
    }
    // 首条用户消息送出后、普通 prepare 前，读取已经完成的开场白；失败不阻断酒馆正文。
    const openingScope = `${chatId}|${binding.worldId}|${binding.branchId ?? "canon"}`;
    if (!useSql && deps.getOpeningMessage && !bootstrappedBranches.has(openingScope)
      && !openingAttemptedMessages.has(`${openingScope}|${messageId}`)
      && !state.receipts.some((row) => row.status === "committed")) {
      openingAttemptedMessages.add(`${openingScope}|${messageId}`);
      try {
        const opening = await readContextWithDeadline(deps.getOpeningMessage());
        if (opening?.messageId && opening.text.trim() && !disposed && state.chatId === chatId
          && generationRevision === revision) {
          let loreSupplement = "";
          try {
            loreSupplement = deps.getLoreSupplement ? await readContextWithDeadline(deps.getLoreSupplement({ chatId, characterId: null,
              mode: "bootstrap", userText: String(userText ?? ""), assistantText: opening.text,
              recentAssistantTexts: [] })) ?? "" : "";
          } catch { loreSupplement = ""; }
          if (disposed || state.chatId !== chatId || generationRevision !== revision) return;
          const response = await api.request("POST", "/scene/bootstrap", {
            chatId, apply: true, auto: true, openingMessageId: opening.messageId,
            userText: String(userText ?? ""), assistantText: opening.text,
            ...(loreSupplement ? { loreSupplement } : {}),
          });
          if (disposed || state.chatId !== chatId || generationRevision !== revision) return;
          if (response.status === 200 && (response.body as { ok?: boolean })?.ok) {
            bootstrappedBranches.add(openingScope);
            diagnostic({ level: "info", source: "ui", code: "SCENE_BOOTSTRAP_COMPLETE",
              operation: "bootstrap", phase: "response", outcome: "success" });
            await refresh();
          } else {
            diagnostic({ level: "warn", source: "ui", code: "SCENE_BOOTSTRAP_RETRYABLE",
              operation: "bootstrap", phase: "response", outcome: "failed", retryable: true });
          }
        }
      } catch {
        diagnostic({ level: "warn", source: "ui", code: "SCENE_BOOTSTRAP_RETRYABLE",
          operation: "bootstrap", phase: "request", outcome: "failed", retryable: true });
      }
    }
    const request = {
      chatId,
      messageId: messageId.slice(0, ATLAS_LIMITS.ID_CHARS),
      worldId: binding.worldId,
      branchId: binding.branchId,
      userText: String(userText ?? "").slice(0, ATLAS_LIMITS.USER_TEXT_CHARS),
      recentMessageRefs: [],
    };
    const parsed = parseAtlasTurnPrepareRequest(request);
    if (!parsed.ok) {
      diagnostic({ level: "error", source: "ui", code: "PREPARE_REQUEST_INVALID",
        operation: "prepare", phase: "validation", outcome: "failed" });
      return;
    }
    try {
      const result = await api.request("POST", useSql ? '/sql/chat/prepare' : "/turns/prepare", {
        ...parsed.value, ...(useSql ? { chatUid: chatId } : {}),
      });
      const body = result.body as { ok?: boolean; data?: { response?: unknown }; error?: { message?: string } };
      if (revision !== generationRevision || state.chatId !== chatId || useSql !== sqlEnabled()) {
        diagnostic({ level: "debug", source: "ui", code: "STALE_PREPARE_DROPPED",
          operation: "prepare", phase: "response", outcome: "skipped" });
        return;
      }
      if (result.status === 200 && body.ok && body.data?.response) {
        const parsedResponse = parseAtlasTurnPrepareResponse(body.data.response);
        if (!parsedResponse.ok) {
          diagnostic({ level: "error", source: "ui", code: "PREPARE_RESPONSE_INVALID",
            operation: "prepare", phase: "parsed", outcome: "failed" });
          setState({ lastError: "prepare 响应形状异常，本轮不注入。" });
          return;
        }
        const response: AtlasTurnPrepareResponse = parsedResponse.value;
        if (deps.getNarrativeContext) {
          try {
            const text = await readContextWithDeadline(deps.getNarrativeContext());
            response.injectionText = typeof text === "string" ? text.slice(0, ATLAS_LIMITS.INJECTION_CHARS) : "";
          } catch { response.injectionText = ""; }
          if (revision !== generationRevision || state.chatId !== chatId || disposed) return;
        }
        diagnostic({ level: "info", source: "ui", code: "PREPARE_COMPLETE",
          operation: "prepare", phase: "prepared", outcome: "success" });
        setState({
          pendingTurn: {
            sqlMode: useSql,
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
      diagnostic({ level: "error", source: "ui", code: "PREPARE_FAILED",
        operation: "prepare", phase: "request", outcome: "failed", retryable: true });
      setState({ lastError: "本轮未注入阿特拉斯上下文：服务不可用。" });
    }
  }

  /**
   * 0.9.25 shujuku 占位符体系采集：宿主钩子失败 / 形状不对 → 全部缺省，绝不阻断回合。
   * recentAssistantTexts 过滤掉与当前楼层相同的正文（$7 是「前文」，不含本楼层）。
   */
  async function safeCommitContext(
    hook: (assistantText: string) => Promise<{
      recentAssistantTexts?: string[];
      personaDescription?: string;
      charDescription?: string;
    } | null>,
    assistantText: string,
  ): Promise<{ recentAssistantTexts?: string[]; personaDescription?: string; charDescription?: string } | null> {
    try {
      const raw = await readContextWithDeadline(hook(assistantText));
      if (!raw || typeof raw !== "object") return null;
      const texts = Array.isArray(raw.recentAssistantTexts)
        ? raw.recentAssistantTexts
            .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            .filter((item) => item !== assistantText)
            .slice(-10)
        : [];
      return {
        ...(texts.length > 0 ? { recentAssistantTexts: texts } : {}),
        ...(typeof raw.personaDescription === "string" && raw.personaDescription.trim()
          ? { personaDescription: raw.personaDescription }
          : {}),
        ...(typeof raw.charDescription === "string" && raw.charDescription.trim()
          ? { charDescription: raw.charDescription }
          : {}),
      };
    } catch {
      return null;
    }
  }

  /** 最终回复完成：commit（至多 1 次请求；重复通知 / 空回复 / 停止不推进世界）。 */
  async function onGenerationEnded(assistantMessageId: string, assistantText: string): Promise<void> {
    if (disposed) return;
    const endingChat = state.chatId;
    await waitPendingTurn();
    // A quick regeneration can complete before the mutation debounce expires.
    // Finish its rollback before preparing the replacement against a revision.
    if (mutationTimer) {
      clearTimeout(mutationTimer); mutationTimer = null;
      const queue = mutationQueue; mutationQueue = [];
      const previous = lastMutationTask;
      lastMutationTask = (async () => { await previous; await processMutations(queue); })();
      void track(lastMutationTask);
    }
    await lastMutationTask;
    if (disposed || state.chatId !== endingChat) return;
    if (retryRollbackFloor !== null) {
      if (state.binding?.lastCommittedMessageId === retryRollbackFloor) {
        setState({ pendingTurn: null, rearmTurn: null, lastError: state.lastError ?? '重新生成前的世界回退未完成，本轮未推演。' });
        return;
      }
      retryRollbackFloor = null;
    }
    let pending = state.pendingTurn;
    // ATLAS-06 swipe 同级重推演：回退后没有 pending；用 rearm 暂存的用户楼层重建回合。
    // swipeId 换成唯一新值（swipe-<ts>）——同键重提交会被账本幂等判 duplicate，永远推不动。
    if (!pending && state.rearmTurn) {
      const rearm = state.rearmTurn;
      await onMessageSent(rearm.userMessageId, rearm.userText);
      pending = state.pendingTurn;
      if (pending) {
        swipeIdForNextCommit = rearm.swipeId;
      } else {
        diagnostic({ level: "warn", source: "ui", code: "TURN_SKIPPED_NO_PENDING",
          operation: "commit", phase: "rearm", outcome: "skipped",
          details: { reasonCode: "REARM_PREPARE_FAILED" } });
        setState({ rearmTurn: null });
        return;
      }
    }
    if (!pending) {
      const gated = !state.binding?.enabled || state.serviceStatus !== "online" || !state.chatId;
      diagnostic({ level: gated ? "info" : "warn", source: "ui",
        code: gated ? "GENERATION_GATED" : "TURN_SKIPPED_NO_PENDING",
        operation: "commit", phase: "ended", outcome: "skipped",
        details: { reasonCode: gated ? "BINDING_OR_SERVICE_DISABLED" : "NO_PENDING" } });
      return;
    }
    if (pending.sqlMode !== undefined && pending.sqlMode !== sqlEnabled()) {
      setState({ pendingTurn: null, rearmTurn: null, lastError: '存储模式已切换，本轮推演已取消，请重新生成。' });
      return;
    }
    if (commitFlight) {
      if (commitFlight.turnId !== pending.turnId) {
        const queuedRevision = generationRevision;
        setState({ turnPhase: "queued" });
        await commitFlight.done;
        if (!disposed && state.chatId === pending.chatId && generationRevision === queuedRevision
          && state.pendingTurn?.turnId === pending.turnId) {
          await onGenerationEnded(assistantMessageId, assistantText);
        }
        return;
      }
      diagnostic({ level: "debug", source: "ui", code: "DUPLICATE_EVENT",
        operation: "commit", phase: "ended", outcome: "skipped" });
      return;
    }
    if (!assistantMessageId || !assistantText || assistantText.trim().length === 0) {
      diagnostic({ level: "info", source: "ui", code: "EMPTY_REPLY",
        operation: "commit", phase: "ended", outcome: "skipped" });
      setState({ pendingTurn: null });
      return;
    }
    // A failed host generation may resolve the previous assistant floor. It is not this turn's reply.
    if (/^\d+$/.test(pending.messageId) && /^\d+$/.test(assistantMessageId)
      && Number(assistantMessageId) <= Number(pending.messageId)) {
      diagnostic({ level: "warn", source: "host", code: "AI_FLOOR_UNRESOLVED",
        operation: "generation", phase: "ended", outcome: "skipped" });
      setState({ pendingTurn: null, rearmTurn: null, lastError: "正文生成已结束，但没有取得本轮助手回复，本轮世界状态未更新。" });
      return;
    }
    const commitRevision = generationRevision;
    const commitSwipeId = swipeIdForNextCommit;
    swipeIdForNextCommit = null;
    const flight = claimCommit(pending.turnId);
    setState({ turnPhase: "reading-context" });
    try {
      let userText = pending.userText;
      let commitContext: Awaited<ReturnType<typeof safeCommitContext>> = null;
      let loreSupplement: string | undefined;
      for (let read = 0; read < 3; read++) {
        const floor = deps.resolveCommitFloor?.(pending.messageId, assistantMessageId);
        if (deps.resolveCommitFloor && !floor) {
          reportHostTurnFailure(pending, '本轮聊天楼层已变化，无法读取当前正文，请重新生成。', 'HOST_FLOOR_CHANGED');
          return;
        }
        if (floor) { userText = floor.userText; assistantText = floor.assistantText; }
        commitContext = deps.getCommitContext ? await safeCommitContext(deps.getCommitContext, assistantText) : null;
        if (disposed || state.chatId !== pending.chatId || generationRevision !== commitRevision) return;
        loreSupplement = undefined;
        if (deps.getLoreSupplement) {
          try {
            const text = await readContextWithDeadline(deps.getLoreSupplement({
              chatId: pending.chatId, characterId: null, mode: "turn",
              userText, assistantText,
              recentAssistantTexts: commitContext?.recentAssistantTexts ?? [],
            }));
            if (disposed || state.chatId !== pending.chatId || generationRevision !== commitRevision) return;
            if (typeof text === "string" && text.trim().length > 0) loreSupplement = text;
          } catch {
            loreSupplement = undefined;
          }
        }
        const current = deps.resolveCommitFloor?.(pending.messageId, assistantMessageId);
        if (!deps.resolveCommitFloor || current?.userText === userText && current.assistantText === assistantText) break;
        diagnostic({ level: 'info', source: 'host', code: 'HOST_FLOOR_REFRESHED',
          operation: 'commit', phase: 'context', outcome: 'recovered', details: { attempt: read + 1 } });
        if (read === 2) {
          reportHostTurnFailure(pending, '其他插件仍在更新本轮正文，暂未推演；正文稳定后请重新推演。', 'HOST_FLOOR_UNSTABLE');
          return;
        }
      }
      // SQL prepare is bound to the original user input hash. Host preprocessing
      // can replace that input; prepare it again before committing current text.
      if (userText.slice(0, ATLAS_LIMITS.USER_TEXT_CHARS) !== pending.userText) {
        const previous = pending;
        setState({ pendingTurn: null });
        await onMessageSent(previous.messageId, userText);
        if (disposed || state.chatId !== previous.chatId || generationRevision !== commitRevision) return;
        pending = state.pendingTurn;
        if (!pending) return;
        flight.turnId = pending.turnId;
        setState({ turnPhase: 'reading-context' });
      }
      // 0.9.25 shujuku 占位符体系：$7 前文 / $U 用户设定 / $C 角色描述（可选钩子，失败即缺省）
      const request = {
        turnId: pending.turnId,
        chatId: pending.chatId,
        userMessageId: pending.messageId,
        assistantMessageId: assistantMessageId.slice(0, ATLAS_LIMITS.ID_CHARS),
        swipeId: commitSwipeId,
        userText: userText.slice(0, ATLAS_LIMITS.USER_TEXT_CHARS),
        assistantText: assistantText.slice(0, ATLAS_LIMITS.ASSISTANT_TEXT_CHARS),
        ...(loreSupplement ? { loreSupplement } : {}),
        ...(commitContext?.recentAssistantTexts?.length ? { recentAssistantTexts: commitContext.recentAssistantTexts } : {}),
        ...(commitContext?.personaDescription ? { personaDescription: commitContext.personaDescription } : {}),
        ...(commitContext?.charDescription ? { charDescription: commitContext.charDescription } : {}),
      };
      const parsed = parseAtlasTurnCommitRequest(request);
      if (!parsed.ok) {
        diagnostic({ level: "error", source: "ui", code: "COMMIT_REQUEST_INVALID",
          operation: "commit", phase: "validation", outcome: "failed" });
        setState({ pendingTurn: null, rearmTurn: null });
        return;
      }
      await executeCommitRequest(parsed.value, commitSwipeId, flight);
    } finally { releaseCommit(flight); }
  }

  /**
   * 共享 commit 执行器（正常回合 / 手动立即推演共用）：请求已过契约解析。
   * committed / duplicate → 记回执 + 刷新；failed / HTTP 错误 → 记可重试信息。
   */
  async function executeCommitRequest(value: AtlasTurnCommitRequest, swipeId: string | null, reservedFlight?: CommitFlight): Promise<void> {
    const flight = reservedFlight ?? claimCommit(value.turnId);
    const useSql = sqlEnabled();
    const revision = generationRevision;
    const identity = useSql ? deps.getCommitIdentity?.(value) : null;
    const hostGuard = useSql ? deps.createCommitGuard?.(value) : undefined;
    const isCurrent = () => !disposed && host.getChatId() === value.chatId && state.chatId === value.chatId
      && generationRevision === revision && useSql === sqlEnabled() && (hostGuard?.() ?? deps.isCommitCurrent?.(value) ?? true)
      && (!identity || JSON.stringify(deps.getCommitIdentity?.(value)) === JSON.stringify(identity));
    if (useSql) { sqlPartialTurnId = null; sqlRetryRequest = value; }
    if (state.chatId === value.chatId) setState({ turnPhase: "committing" });
    diagnostic({ level: "info", source: "ui", code: "COMMIT_STARTED",
      operation: "commit", phase: "request", outcome: "started" });
    try {
      const result = await api.request("POST", useSql ? '/sql/chat/commit' : "/turns/commit", {
        ...value, ...(useSql ? { chatUid: value.chatId, playerName: deps.getPlayerName?.() ?? '', isCurrent,
          ...(identity ? { hostMessageUid: identity.messageUID, variantKey: identity.variantKey } : {}) } : {}),
      });
      const body = result.body as { ok?: boolean; data?: { receipt?: unknown; nativeReceipt?: unknown; issues?: unknown; coreSaved?: boolean }; error?: { message?: string; code?: string; retryable?: boolean; details?:Record<string,unknown> } };
      if (useSql && !isCurrent()) {
        diagnostic({ level: 'warn', source: 'host', code: 'COMMIT_STALE_SKIPPED',
          operation: 'commit', phase: 'response', outcome: 'skipped' });
        if (state.chatId === value.chatId && generationRevision === revision && useSql === sqlEnabled())
          reportHostTurnFailure(value, '本轮聊天正文或楼层身份已变化，推演结果未保存；请重新推演当前正文。', 'HOST_FLOOR_CHANGED');
        return;
      }
      const receiptParsed = body.data?.receipt ? parseAtlasTurnReceipt(body.data.receipt) : null;
      // 0.9.28 归属守卫：请求在途时用户可能已切聊天——过期回执 / 失败挂单绝不写进新聊天
      const stale = state.chatId !== value.chatId;
      if (result.status === 200 && body.ok && receiptParsed?.ok && (!useSql || body.data?.coreSaved === true || receiptParsed.value.status === 'failed')) {
        const receiptStatus = receiptParsed.value.status;
        diagnostic({
          level: receiptStatus === "failed" ? "error" : "info", source: "ui",
          code: receiptStatus === "committed" ? "COMMIT_SUCCEEDED" :
            receiptStatus === "duplicate" ? "TURN_DUPLICATE" : "COMMIT_FAILED",
          operation: "commit", phase: "receipt",
          outcome: receiptStatus === "committed" ? "success" :
            receiptStatus === "duplicate" ? "skipped" : "failed",
          httpStatus: result.status, retryable: receiptParsed.value.retryable,
          details: { coreCommitted: receiptStatus === "committed" || receiptStatus === "duplicate" },
        });
        if (stale) diagnostic({ level: "warn", source: "ui", code: "STALE_CHAT_RESPONSE_DROPPED",
          operation: "commit", phase: "receipt", outcome: "skipped" });
        addReceipt(receiptParsed.value, value.chatId,{receipt:body.data?.nativeReceipt,issues:body.data?.issues,coreSaved:body.data?.coreSaved,httpStatus:result.status});
        // 0.9.54 A13：HTTP 200 + body.ok 只说明接口处理成功，不代表世界已提交。
        // 必须按 receipt.status 分流：failed 要展示失败摘要、置 lastError、按 retryable
        // 保留或清空挂单，并且**不得**刷新地图 / 同步世界书（世界确实没变）。
        if (receiptParsed.value.status === "failed") {
          setState({
            pendingTurn: null,
            rearmTurn: null,
            ...(stale ? {} : {
              lastError: receiptParsed.value.summary,
              retryableCommit: receiptParsed.value.retryable
                ? {
                    chatId: value.chatId,
                    userMessageId: value.userMessageId,
                    assistantMessageId: value.assistantMessageId,
                    swipeId,
                    ...(useSql ? { sqlMode: true } : {}),
                  }
                : null,
            }),
          });
          return;
        }
        setState({ pendingTurn: null, rearmTurn: null, ...(stale ? {} : { lastError: null }) });
        if (useSql) {
          sqlPartialTurnId = receiptParsed.value.retryable ? receiptParsed.value.receiptId : null;
          if (!sqlPartialTurnId) sqlRetryRequest = null;
          setState({ retryableCommit: sqlPartialTurnId ? { chatId: value.chatId, userMessageId: value.userMessageId,
            assistantMessageId: value.assistantMessageId, swipeId, sqlMode: true } : null });
        }
        if (receiptParsed.value.status === "committed" || receiptParsed.value.status === "duplicate") {
          rolledBackFloors.delete(`${value.chatId}:${value.assistantMessageId}`);
          healthCheckedAt = -Infinity;
          if (!stale) await refresh();
        }
        if (!useSql && state.chatId === value.chatId) await syncLorebookAfterCommit(body);
        if (!useSql && receiptParsed.value.status === "committed" && state.chatId === value.chatId) {
          try {
            const expansion = await api.request("POST", "/worlds/geo/suggest", {
              chatId: value.chatId, triggerId: value.turnId, autoApply: true,
              loreSupplement: [value.charDescription, value.loreSupplement].filter(Boolean).join("\n").slice(0, ATLAS_LIMITS.LORE_SUPPLEMENT_CHARS),
              recentTexts: [...(value.recentAssistantTexts ?? []), value.assistantText].slice(-8),
            });
            if (expansion.status === 200 && (expansion.body as { ok?: boolean })?.ok && state.chatId === value.chatId) {
              await refresh();
            }
          } catch {
            // 场景补全是已提交回合后的附加工作；失败绝不回退剧情或误报 commit 失败。
          }
        }
        return;
      }
      diagnostic({ level: "error", source: "ui", code: "COMMIT_FAILED",
        operation: "commit", phase: "response", outcome: "failed",
        httpStatus: result.status, errorCode: body.error?.code, retryable: true });
      if(!stale)addReceipt({receiptId:value.turnId,status:'failed',branchId:state.binding?.branchId??null,previousTime:state.binding?.worldTimeCursor??0,currentTime:state.binding?.worldTimeCursor??0,
        currentLocationId:state.binding?.currentLocationId??null,triggeredNpcIds:[],adoptedEventIds:[],summary:body.error?.message??`世界推演失败（HTTP ${result.status}）`,retryable:body.error?.retryable!==false},value.chatId,
        {...body.error?.details,errorCode:body.error?.code,httpStatus:result.status,message:body.error?.message,coreSaved:false});
      // commit 失败：保留可重试信息，清 pending；零部分写入由服务端保证
      setState({
        pendingTurn: null,
        rearmTurn: null,
        ...(stale ? {} : {
          retryableCommit: useSql && body.error?.retryable === false ? null : {
            chatId: value.chatId,
            userMessageId: value.userMessageId,
            assistantMessageId: value.assistantMessageId,
            swipeId,
            ...(useSql ? { sqlMode: true } : {}),
          },
          lastError: body.error?.message ?? `世界推演失败（HTTP ${result.status}），可从「变化」页重试。`,
        }),
      });
    } catch {
      diagnostic({ level: "error", source: "ui", code: "COMMIT_FAILED",
        operation: "commit", phase: "request", outcome: "failed", retryable: true });
      const stale = state.chatId !== value.chatId || (useSql && !isCurrent());
      if(!stale)addReceipt({receiptId:value.turnId,status:'failed',branchId:state.binding?.branchId??null,previousTime:state.binding?.worldTimeCursor??0,currentTime:state.binding?.worldTimeCursor??0,
        currentLocationId:state.binding?.currentLocationId??null,triggeredNpcIds:[],adoptedEventIds:[],summary:'世界推演失败：服务不可用',retryable:true},value.chatId,{errorCode:'SERVICE_UNAVAILABLE',coreSaved:false});
      setState({
        pendingTurn: null,
        rearmTurn: null,
        ...(stale ? {} : {
          retryableCommit: {
            chatId: value.chatId,
            userMessageId: value.userMessageId,
            assistantMessageId: value.assistantMessageId,
            swipeId,
            ...(useSql ? { sqlMode: true } : {}),
          },
          lastError: "世界推演失败：服务不可用，可从「变化」页重试。",
        }),
      });
    } finally {
      if (useSql && !isCurrent() && state.chatId === value.chatId) setState({ pendingTurn: null, retryableCommit: null });
      releaseCommit(flight);
    }
  }

  /**
   * 0.9.22 立即推演：不发言也让世界流动。合成一回合——用户行动 = 固定占位
   * （不新增剧情），助手正文 = 最近楼层正文（宿主钩子提供，缺省用占位）。
   * 消息 id 用 manual-<ts> 合成，幂等键每次按下都不同 → 每按一次推进一回合。
   */
  async function manualAdvance(): Promise<void> {
    if (disposed || commitFlight) return;
    const manualRevision = generationRevision;
    const chatId = state.chatId;
    const binding = state.binding;
    if (!chatId || state.serviceStatus !== "online") {
      setState({ lastError: "引擎未就绪，无法立即推演。" });
      return;
    }
    if (!binding?.enabled) {
      setState({ lastError: "本聊天推演未启用——先在「推进」页启用再立即推演。" });
      return;
    }
    if (state.pendingTurn) {
      setState({ lastError: "有回合正在推演，稍后再试。" });
      return;
    }
    const ts = now();
    let lastAssistant = "";
    try {
      const text = deps.getLastAssistantText ? await readContextWithDeadline(deps.getLastAssistantText()) : null;
      if (disposed) return;
      if (typeof text === "string") lastAssistant = text;
    } catch {
      lastAssistant = "";
    }
    const manualAssistantText = (lastAssistant.trim().length > 0 ? lastAssistant : "（无新剧情，仅时间与日程流动。）")
      .slice(0, ATLAS_LIMITS.ASSISTANT_TEXT_CHARS);
    const commitContext = deps.getCommitContext ? await safeCommitContext(deps.getCommitContext, manualAssistantText) : null;
    if (disposed || state.chatId !== chatId || generationRevision !== manualRevision) return;
    let loreSupplement: string | undefined;
    if (deps.getLoreSupplement) {
      try {
        const text = await readContextWithDeadline(deps.getLoreSupplement({
          chatId, characterId: null, mode: "turn",
          userText: "（手动推进，无新用户行动。）", assistantText: manualAssistantText,
          recentAssistantTexts: commitContext?.recentAssistantTexts ?? [],
        }));
        if (disposed || state.chatId !== chatId || generationRevision !== manualRevision) return;
        if (typeof text === "string" && text.trim().length > 0) loreSupplement = text;
      } catch { loreSupplement = undefined; }
    }
    const request = {
      turnId: `turn-manual-${ts}`,
      chatId,
      userMessageId: `manual-u-${ts}`,
      assistantMessageId: `manual-a-${ts}`,
      swipeId: null,
      userText: "（手动推进：不新增剧情，仅让世界按日程与惯性流动。）",
      assistantText: manualAssistantText,
      ...(loreSupplement ? { loreSupplement } : {}),
      ...(commitContext?.recentAssistantTexts?.length ? { recentAssistantTexts: commitContext.recentAssistantTexts } : {}),
      ...(commitContext?.personaDescription ? { personaDescription: commitContext.personaDescription } : {}),
      ...(commitContext?.charDescription ? { charDescription: commitContext.charDescription } : {}),
    };
    const parsed = parseAtlasTurnCommitRequest(request);
    if (!parsed.ok) {
      setState({ lastError: "立即推演请求组装失败（契约校验未过）。" });
      return;
    }
    await executeCommitRequest(parsed.value, null);
  }

  /** 停止 / 生成失败：放弃 pending，不推进世界。 */
  function onGenerationStopped(): void {
    if (disposed) return;
    stoppedGeneration = true;
    generationRevision += 1;
    sqlRetryRequest = null;
    swipeIdForNextCommit = null;
    diagnostic({ level: "info", source: "host", code: "GENERATION_STOPPED",
      operation: "generation", phase: "stopped", outcome: "skipped",
      details: { coreCommitted: false } });
    if (state.pendingTurn) {
      const pending = state.pendingTurn;
      setState({
        pendingTurn: null,
        rearmTurn: {
          userMessageId: pending.messageId,
          userText: pending.userText,
          swipeId: "swipe-" + now(),
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // ATLAS-06：楼层变动（swipe / 编辑 / 删除）→ 世界回退
  // -------------------------------------------------------------------------

  /**
   * 防抖窗口结束后统一处理楼层变动（顺序重放，语义 = 最终状态）。
   * SQL 的编辑/删楼撤销该楼及依赖后文；旧兼容流程仍只回退最近一次回复。
   */
  async function processMutations(
    queue: Extract<AtlasAdaptedEvent, { kind: "message-swiped" | "message-edited" | "message-deleted" }>[],
  ): Promise<void> {
    for (const event of queue) {
      if (disposed) return;
      const binding = state.binding;
      if (!binding?.enabled || !state.chatId || state.serviceStatus !== "online") return;
      if (binding.lastCommittedMessageId !== event.messageId) {
        const sqlEarlier = sqlEnabled() && event.kind !== 'message-swiped'
          && binding.lastCommittedMessageId !== null && Number.isFinite(Number(event.messageId))
          && Number(event.messageId) < Number(binding.lastCommittedMessageId);
        if(!sqlEarlier)continue;
      }
      if (rolledBackFloors.has(`${state.chatId}:${event.messageId}`)) continue; // 本会话已回退过
      if (event.kind === "message-swiped") {
        if (event.regenerating === false) continue; // 仅切换查看旧变体：不动世界
        if (event.regenerating === null) continue; // 形状无法判定：宁可漏回退，不可误回退
        const rolledBack = await rollbackLastTurn(event.messageId);
        if (rolledBack) {
          rolledBackFloors.add(`${state.chatId}:${event.messageId}`);
          if (event.userMessageId && event.userText) {
            setState({
              rearmTurn: { userMessageId: event.userMessageId, userText: event.userText, swipeId: `swipe-${now()}` },
              worldNotice: "已回退到本回合之前；新变体生成完成后将重新推演为同级结果。",
            });
          }
        }
      } else {
        const rolledBack = await rollbackLastTurn(event.messageId);
        if (rolledBack) {
          rolledBackFloors.add(`${state.chatId}:${event.messageId}`);
          setState({
            worldNotice: event.kind === "message-edited"
              ? "该回复已编辑：世界已回退到本回合之前；如需按新文本重新推演，请重新生成（swipe）该回复。"
              : "该回复已删除：世界已回退到本回合之前（推演历史保留在检查点里，可追溯）。",
          });
        }
      }
    }
  }

  /** 调服务端 /turns/rollback 回退最近一次已推演回合；成功后刷新世界状态。 */
  async function rollbackLastTurn(assistantMessageId: string): Promise<boolean> {
    const chatId = state.chatId;
    if (!chatId) return false;
    try {
      const useSql = sqlEnabled();
      const result = await api.request("POST", useSql ? '/sql/chat/rollback' : "/turns/rollback", { chatId, assistantMessageId, ...(useSql ? { chatUid: chatId } : {}) });
      const response = result.body as { ok?: boolean; data?: { coreSaved?: boolean; issues?: Array<{ message?: string }> } };
      if (result.status === 200 && (!useSql || response.ok && response.data?.coreSaved === true)) {
        healthCheckedAt = -Infinity;
        await refresh();
        if (!useSql && state.chatId === chatId && deps.onLorebookChatSwitch) {
          try { await deps.onLorebookChatSwitch({ chatId, bound: Boolean(state.binding) }); } catch { /* generation stays available */ }
        }
        return true;
      }
      const body = result.body as { error?: { message?: string } };
      setState({ lastError: body.error?.message ?? (response.data?.issues?.map(i => i.message).join('；') || `世界回退被拒绝（HTTP ${result.status}）。`) });
      return false;
    } catch {
      setState({ lastError: "世界回退失败：服务不可用。" });
      return false;
    }
  }

  /** 重试失败的 commit（沿用原幂等键；服务端 retry 端点）。 */
  async function retryLastCommit(): Promise<void> {
    if (disposed) return;
    const failed = state.retryableCommit;
    if (!failed) return;
    // 0.9.28 归属守卫：挂单属于旧聊天 → 直接作废（服务端零部分写入，世界一致）
    if (failed.chatId !== state.chatId) {
      setState({ retryableCommit: null });
      return;
    }
    if ((failed.sqlMode === true) !== sqlEnabled()) {
      sqlRetryRequest = null;
      setState({ retryableCommit: null, lastError: '存储模式已切换，旧重试请求已取消，请重新生成。' });
      return;
    }
    if (sqlEnabled()) {
      if (!sqlRetryRequest || commitFlight) return;
      if (sqlPartialTurnId) {
        const original = sqlRetryRequest, turnId = sqlPartialTurnId, revision = generationRevision;
        const flight = claimCommit(turnId);
        const identity = deps.getCommitIdentity?.(original);
        const hostGuard = deps.createCommitGuard?.(original);
        const isCurrent = () => !disposed && state.chatId === failed.chatId && host.getChatId() === failed.chatId && sqlEnabled()
          && generationRevision === revision && (hostGuard?.() ?? deps.isCommitCurrent?.(original) ?? true)
          && (!identity || JSON.stringify(deps.getCommitIdentity?.(original)) === JSON.stringify(identity));
        try {
          const result = await api.request('POST', '/sql/chat/retry', { ...original, chatUid: failed.chatId,
            sqlTurnId: turnId, playerName: deps.getPlayerName?.() ?? '', isCurrent });
          if (!isCurrent()) return;
          const body = result.body as { ok?: boolean; data?: { coreSaved?: boolean; receipt?: unknown; nativeReceipt?:unknown; issues?:unknown }; error?: { message?: string; retryable?: boolean } };
          const parsed = body.data?.receipt ? parseAtlasTurnReceipt(body.data.receipt) : null;
          if (result.status === 200 && body.ok && parsed?.ok) {
            addReceipt(parsed.value, failed.chatId,{receipt:body.data?.nativeReceipt,issues:body.data?.issues,coreSaved:body.data?.coreSaved,httpStatus:result.status});
            setState({ lastError: parsed.value.status === 'failed' ? parsed.value.summary : null,
              retryableCommit: parsed.value.retryable ? failed : null });
            if (!parsed.value.retryable) { sqlPartialTurnId = null; sqlRetryRequest = null; }
            if (body.data?.coreSaved === true) await refresh();
          } else setState({ lastError: body.error?.message ?? '失败组补交未完成。',
            ...(body.error?.retryable === false ? { retryableCommit: null } : {}) });
        } catch { if (isCurrent()) setState({ lastError: '失败组补交请求失败，已保存结果保持原状。' }); }
        finally { releaseCommit(flight); }
        return;
      }
      await executeCommitRequest(sqlRetryRequest, failed.swipeId);
      return;
    }
    try {
      const result = await api.request("POST", "/turns/retry", failed);
      const body = result.body as { ok?: boolean; data?: { receipt?: unknown }; error?: { message?: string } };
      const receiptParsed = body.data?.receipt ? parseAtlasTurnReceipt(body.data.receipt) : null;
      if (result.status === 200 && body.ok && receiptParsed?.ok) {
        addReceipt(receiptParsed.value, failed.chatId);
        // 0.9.54 A14：HTTP 200 不等于提交成功。failed 回执要展示真实摘要、
        // 按 retryable 保留或清除挂单，并且不刷新、不写世界书、不提示「重试成功」。
        if (receiptParsed.value.status === "failed") {
          if (state.chatId === failed.chatId) {
            setState({
              lastError: receiptParsed.value.summary,
              retryableCommit: receiptParsed.value.retryable ? failed : null,
            });
          }
          return;
        }
        setState({ retryableCommit: null, lastError: null });
        if (receiptParsed.value.status === "committed" || receiptParsed.value.status === "duplicate") {
          healthCheckedAt = -Infinity;
          await refresh();
        }
        if (state.chatId === failed.chatId) await syncLorebookAfterCommit(body);
        return;
      }
      if (state.chatId === failed.chatId) {
        setState({ lastError: body.error?.message ?? `重试失败（HTTP ${result.status}）` });
      }
    } catch {
      if (state.chatId === failed.chatId) {
        setState({ lastError: "重试失败：服务不可用。" });
      }
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
      // 0.9.28 回执按聊天分桶持久化：init 只恢复当前聊天的回执（旧全局键废弃不迁移；
      // 形状不可信，逐条严格校验）
      restoreReceiptsForChat(host.getChatId());
      void refresh();
    },

    dispose() {
      disposed = true;
      clearTimers();
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

    /** 0.9.22 立即推演：不发言也让世界流动（推进页按钮）。 */
    manualAdvance,

    /** ATLAS-18：概览页「重试初始化」按钮用（未注入 ensureWorld 时安全无操作）。 */
    async initializeWorld(): Promise<boolean> {      if (disposed) return false;
      if (sqlEnabled()) { await refresh(); return Boolean(state.binding); }
      if (state.binding) {
        setState({ worldInitialization: "ready", worldInitializationError: null });
        return true;
      }
      if (!deps.ensureWorld) return false;
      setState({ worldInitialization: "initializing", worldInitializationError: null });
      try {
        const ensured = await deps.ensureWorld();
        if (disposed) return false;
        setState(ensured && state.binding
          ? { worldInitialization: "ready", worldInitializationError: null }
          : { worldInitialization: "failed", worldInitializationError: "世界初始化未完成，可重试。" });
        return Boolean(ensured && state.binding);
      } catch {
        if (!disposed) setState({ worldInitialization: "failed", worldInitializationError: "世界初始化失败，可重试。" });
        return false;
      }
    },

    setPage(page: AtlasUiPage) {
      setState({ page });
    },

    /**
     * D08：切换幕后动向的可见范围。
     * 只改读取参数并刷新——**不写任何数据**，也不改变谁真的知道什么。
     */
    async setSimulationVisibility(visibility: "known" | "all") {
      const next = visibility === "all" ? "all" : "known";
      if (state.simulationVisibility === next) return;
      setState({ simulationVisibility: next });
      diagnostic({
        level: "info", source: "ui", code: "SIMULATION_VISIBILITY_CHANGED",
        operation: "state", phase: "simulation", outcome: "success",
      });
      await refresh();
    },

    async bindToWorld(worldId: string) {
      if (sqlEnabled()) {
        await refresh();
        if (state.binding) await host.writeBinding({...state.binding,enabled:true});
        await refresh();
        return;
      }
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
      if (sqlEnabled()) {
        generationRevision += 1;
        sqlRetryRequest = null;
        await host.writeBinding({ ...state.binding!, enabled: false });
        setState({ pendingTurn: null, retryableCommit: null });
        await refresh();
        return;
      }
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
      if (sqlEnabled()) {
        generationRevision += 1;
        sqlRetryRequest = null;
        await host.writeBinding(next);
        setState({ pendingTurn: null, retryableCommit: null });
        await refresh();
        return;
      }
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
        const result = await api.request("POST", sqlEnabled()?"/sql/chat/travel-preview":"/map/travel-preview", {
          chatId,
          destinationPointId: String(pointId).slice(0, ATLAS_LIMITS.ID_CHARS),
        });
        const body = result.body as {
          ok?: boolean;
          data?: { preview?: { destinationId: string; distance: number; estimatedDuration: number; distanceUnit?: 'm'; durationUnit?: 's'; factors: string[] } | null };
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
                distanceUnit: preview.distanceUnit,
                durationUnit: preview.durationUnit,
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
