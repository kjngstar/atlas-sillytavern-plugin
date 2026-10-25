import { normalizeWorkBatching } from './atlas-work-batching.ts';
import { callAtlasWorldTurnApi, substitutePromptPlaceholders, type AtlasWorldTurnPromptInput } from './atlas-api-client.ts';
import { migrateAtlasSettings, resolveWorldTurnPreset, sanitizeSettingsV2 } from './atlas-settings.ts';
import type { AtlasModelPort } from './atlas-db-contract.ts';
import type { ModelBatchRequest } from './atlas-ops-contract.ts';
import { DEFAULT_SQL_PROMPT_SEGMENTS, hasLegacySqlPromptProtocol } from './atlas-sql-prompts.ts';
import { assemblePromptLayers } from './atlas-prompt-layers.ts';
import { transportBudgetPort, type GenerationBudgetPort } from './atlas-sql-generation-budget.ts';
import { normalizeModelBatching } from './atlas-model-batching.ts';
import { atlasDiagnosticContext, observeDiagnostic, type DiagnosticObserver } from './atlas-request-diagnostics.ts';
import { atlasRefFingerprint } from './atlas-diagnostics.ts';

/** 用户策略段的角色白名单：作者选定的角色必须原样保留，不合法才退回 system。 */
const PROMPT_ROLES = new Set(['system', 'user', 'assistant']);
function promptRole(role: unknown): 'system' | 'user' | 'assistant' {
  const value = typeof role === 'string' ? role.trim().toLowerCase() : '';
  return (PROMPT_ROLES.has(value) ? value : 'system') as 'system' | 'user' | 'assistant';
}

type Options = {
  readSettings: () => Promise<unknown>;
  fetchFn?: typeof fetch;
  now?: () => number;
  onDiagnostic?: DiagnosticObserver;
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
  const messages = assemblePromptLayers({
    // §21.5 分层：固定协议（程序）→ 用户策略（作者，角色原样保留）→ 任务上下文（程序填充）。
    protocol: request.messages[0]?.content ?? '',
    policy: request.promptMode === 'atlas-spatial-extract' ? [] : custom.map(s => ({ role: promptRole(s.role), content: substitutePromptPlaceholders(s.content, input) })),
    task: request.messages.slice(1).map(m => m.content),
  });
  return {preset,input,messages,promptSource: preset.systemPrompt?.trim()?'connection':preset.promptSegments?.length?'preset':'builtin'};
 }
 const port: AtlasModelPort = {
  async generationOptions(){
    const raw=await options.readSettings();
    const {settings}=raw&&typeof raw==='object'&&(raw as {schemaVersion?:unknown}).schemaVersion===2?sanitizeSettingsV2(raw):migrateAtlasSettings(raw);
    return {maxTokens:resolveWorldTurnPreset(settings)?.maxTokens??0,batching:normalizeModelBatching(settings.modelBatching),workBatching:normalizeWorkBatching(settings.workBatching)};
  },
  withBudget: (budget, stage) => createSqlModelPort({ ...options, budget, stage }),
  async preview(request:ModelBatchRequest){
   const {input,messages,promptSource}=await prepare(request);
   return {messages:messages.map(message=>({...message,chars:message.content.length})),promptSource,
    missing:{worldState:Boolean(input.injectionText),lastTurn:false,recentContext:Boolean(input.assistantText)},coreSaved:false};
  },
  async request(request:ModelBatchRequest){
   const scoped = options.budget?.diagnosticContext ?? atlasDiagnosticContext(request.anchor);
   const context = { ...scoped, details: { ...scoped.details, batchRef: atlasRefFingerprint(request.batchId),
     stage: request.promptMode === 'atlas-spatial-extract' ? 'spatial-extract' : options.stage && options.stage !== 'observe' ? options.stage : request.phase,
     phase: request.phase,
     workClass: request.workClass??(request.batchTargets?.kind==='maps'?'maps':request.batchTargets?.kind==='characters'?'characters':request.promptMode==='atlas-spatial-extract'?'evidence':request.phase==='geography'?'construction':request.phase==='decision'?'characters':request.phase==='outcome'?'outcomes':'observe'),
     callReason: request.diagnosticCause??(request.phase==='repair'?'validation_repair':request.retryOf?'retry_unspecified':'scheduled'),
     ...((request.retryOf??request.repairOfBatchId)?{retryOfBatchRef:atlasRefFingerprint(request.retryOf??request.repairOfBatchId!)}:{}),
     retryKind: request.phase === 'repair' ? 'repair' : request.retryOf || request.repairOfBatchId ? 'retry' : 'normal',
     ...(request.batchTargets ? { targetCount: request.batchTargets.count } : {}) } };
   let prepared;
   try { prepared = await prepare(request); }
   catch (error) {
     observeDiagnostic(options.onDiagnostic, { ...context, level: 'error', source: 'model', code: 'MODEL_REQUEST_FAILED',
       operation: 'generation', phase: 'preparation', outcome: 'failed', errorCode: (error as {code?:string})?.code,
       details: { ...context.details, failureStage: 'preparation', modelRequests: 0 } });
     throw error;
   }
   const {preset,input,messages}=prepared;
      if(preset.toolCalling&&((preset.connectionMode??'custom')!=='custom'||(preset.apiFormat??'openai')!=='openai'))throw failure('TOOL_PROTOCOL_UNSUPPORTED','函数输出目前仅支持自定义 OpenAI 兼容连接，请关闭函数输出或切换连接');
      const budget = options.budget;
      const phase = options.stage === 'background' ? 'background' : request.phase || options.stage || 'observe';
      const logical = budget?.claimBatch(phase, request.batchId,{kind:request.workClass??(request.batchTargets?.kind==='maps'?'maps':request.batchTargets?.kind==='characters'?'characters':request.promptMode==='atlas-spatial-extract'?'evidence':undefined),retry:Boolean(request.retryOf)||request.phase==='repair',cause:request.diagnosticCause??(request.phase==='repair'?'validation_repair':request.retryOf?'retry_unspecified':'scheduled'),retryOf:request.retryOf??request.repairOfBatchId,targetCount:request.batchTargets?.count,targetIds:request.diagnosticTargets});
      if (logical && !logical.ok) {
        observeDiagnostic(options.onDiagnostic, { ...context, level: 'warn', source: 'model', code: 'MODEL_REQUEST_DEFERRED',
          operation: 'generation', phase: 'budget', outcome: 'skipped', errorCode: logical.code,
          details: { ...context.details, failureStage: 'budget', modelRequests: 0, budgetUsed: budget?.used() ?? 0 } });
        throw failure(logical.code, logical.reason);
      }
      const result = await callAtlasWorldTurnApi({ ...preset,
        // Output length comes only from the connection; stages must not add a hidden cap.
        maxTokens: preset.maxTokens,
        timeoutMs: preset.timeoutMs ?? request.timeoutMs,
      }, input, {
        fetchFn: options.fetchFn, now: options.now, messagesOverride: messages,
        onDiagnostic: event => {
          try { budget?.recordDiagnostic?.(event); } catch { /* diagnostics must not alter request behavior */ }
          observeDiagnostic(options.onDiagnostic, event);
        }, diagnosticContext: context,
        ...(preset.toolCalling&&request.promptMode!=='atlas-spatial-extract'?{responseTool:{name:'emit_atlas_operations',description:'Return the complete Atlas operations exactly once as JSONL in content. Follow the stage operation contract; do not write text outside this call.',parameters:{type:'object',properties:{content:{type:'string',description:'Complete stage reply, one validated operation JSON object per line'}},required:['content'],additionalProperties:false}}}:{}),
        // M3-03A：API 内部兼容路由的第二次真实发送，也走同一局部预算。缺预算 port 时不传，
        // 由 api-client 按最严策略拒发并明确报错（绝不隐藏重试）。
        ...(budget ? { initialTransport: () => transportBudgetPort(budget, phase, request.batchId).claim(), rescueTransport: () => transportBudgetPort(budget, phase, request.batchId).claim() } : {}),
      });
      budget?.finishBatch(request.batchId, result.ok ? 'completed' : 'failed');
      if (!result.ok) throw failure(result.code, result.message, result.retryable);
      return { batchId: request.batchId, text: result.text, finishReason: result.finishReason ?? null,
        httpStatus: result.status, durationMs: result.durationMs };
    },
  };
  // 局部预算：真实发送前统一 claimBatch + claimTransport；不提供预算时保持既有单次行为。
  return port;
}
