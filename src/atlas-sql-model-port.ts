import { callAtlasWorldTurnApi, substitutePromptPlaceholders, type AtlasWorldTurnPromptInput } from './atlas-api-client.ts';
import { migrateAtlasSettings, resolveWorldTurnPreset, sanitizeSettingsV2 } from './atlas-settings.ts';
import type { AtlasModelPort } from './atlas-db-contract.ts';
import type { ModelBatchRequest } from './atlas-ops-contract.ts';
import { DEFAULT_SQL_PROMPT_SEGMENTS, hasLegacySqlPromptProtocol } from './atlas-sql-prompts.ts';
import { budgetedModelPort, transportBudgetPort, type GenerationBudgetPort } from './atlas-sql-generation-budget.ts';

type Options = {
  readSettings: () => Promise<unknown>;
  fetchFn?: typeof fetch;
  now?: () => number;
  /**
   * M3-03 / M3-03A：本回合局部模型预算。提供时——
   * 1) 每个真实发送前统一 claim（含 API 内部兼容路由的第二次发送）；
   * 2) 未提供则保持既有单次行为（直接调用方自行负责记账）。
   * 预算实例由调用方传入，绝不使用全局单例：不同聊天 / 并发任务互相隔离。
   */
  budget?: GenerationBudgetPort;
  /** 端口默认阶段名；请求自带 phase 时以 phase 为准。 */
  stage?: string;
};

function failure(code: string, message: string, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

/** SQL uses the existing connection library and host transport, not a second API configuration. */
export function createSqlModelPort(options: Options): AtlasModelPort {
 async function prepare(request:ModelBatchRequest){
  const raw = await options.readSettings();
  const normalized = raw && typeof raw === 'object' && (raw as { schemaVersion?: unknown }).schemaVersion === 2
    ? sanitizeSettingsV2(raw, { now: options.now })
    : migrateAtlasSettings(raw, { now: options.now });
  if (normalized.diagnostics.promptSkipped > 0) {
    throw failure('SQL_PROMPT_UNREADABLE', '原设置含无法读取的提示词预设，SQL 推演已暂停；请先恢复原预设');
  }
  const settings = normalized.settings;
  const preset = resolveWorldTurnPreset(settings);
  if (!preset) throw failure('API_NOT_CONFIGURED', 'SQL 推演尚未配置活动 API 连接');
  const sources = request.sourceSnapshot ?? [];
  const input: AtlasWorldTurnPromptInput = {
    injectionText: request.messages[1]?.content ?? '',
    userText: sources.filter(s => s.kind === 'user').map(s => s.text).join('\n'),
    assistantText: sources.filter(s => s.kind === 'story').map(s => s.text).join('\n'),
    loreSupplement: sources.filter(s => s.kind === 'lorebook').map(s => s.text).join('\n'),
    baseRevision: request.anchor.baseRevision,
    ...request.promptInput,
  };
  const custom = Array.isArray(preset.promptSegments) && preset.promptSegments.length
    ? preset.promptSegments.filter(s => s.enabled !== false && s.content.trim())
    : preset.systemPrompt?.trim() ? [{ role: 'system', content: preset.systemPrompt }] : DEFAULT_SQL_PROMPT_SEGMENTS;
  if (preset.promptSegments?.length && custom.length === 0) {
    throw failure('SQL_PROMPT_EMPTY', '活动提示词没有启用条目；未发送 SQL 推演请求');
  }
  // Preserve user assets byte for byte. A conflicting old protocol must be
  // reported before spending tokens, never rewritten or silently discarded.
  if (custom.some(s => hasLegacySqlPromptProtocol(s.content))) {
    throw failure('SQL_PROMPT_INCOMPATIBLE', '活动提示词使用旧表格增量格式，与 SQL 语义操作不兼容。原预设已保留；请使用内置阶段提示词或另存兼容预设');
  }
  const messages = [request.messages[0], ...custom.map(s => ({
    role: s.role, content: substitutePromptPlaceholders(s.content, input),
  })), ...request.messages.slice(1)];
  return {preset,input,messages,promptSource: preset.systemPrompt?.trim()?'connection':preset.promptSegments?.length?'preset':'builtin'};
 }
 const port: AtlasModelPort = {
  async preview(request:ModelBatchRequest){
   const {input,messages,promptSource}=await prepare(request);
   return {messages:messages.map(message=>({...message,chars:message.content.length})),promptSource,
    missing:{worldState:Boolean(input.injectionText),lastTurn:false,recentContext:Boolean(input.assistantText)},coreSaved:false};
  },
  async request(request:ModelBatchRequest){
   const {preset,input,messages}=await prepare(request);
      const budget = options.budget;
      const phase = (request as { phase?: string }).phase || options.stage || 'observe';
      const result = await callAtlasWorldTurnApi({ ...preset,
        // Stage budgets are defaults; explicit saved connection settings take priority.
        maxTokens: preset.maxTokens ?? request.maxTokens,
        timeoutMs: preset.timeoutMs ?? request.timeoutMs,
      }, input, {
        fetchFn: options.fetchFn, now: options.now, messagesOverride: messages,
        // M3-03A：API 内部兼容路由的第二次真实发送，也走同一局部预算。缺预算 port 时不传，
        // 由 api-client 按最严策略拒发并明确报错（绝不隐藏重试）。
        ...(budget ? { rescueTransport: () => transportBudgetPort(budget, phase, request.batchId).claim() } : {}),
      });
      if (!result.ok) throw failure(result.code, result.message, result.retryable);
      return { batchId: request.batchId, text: result.text, finishReason: null,
        httpStatus: result.status, durationMs: result.durationMs };
    },
  };
  // 局部预算：真实发送前统一 claimBatch + claimTransport；不提供预算时保持既有单次行为。
  return options.budget ? budgetedModelPort(port, options.budget, options.stage ?? 'observe') : port;
}
