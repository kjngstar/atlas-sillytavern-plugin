import { callAtlasWorldTurnApi, substitutePromptPlaceholders, type AtlasWorldTurnPromptInput } from './atlas-api-client.ts';
import { migrateAtlasSettings, resolveWorldTurnPreset, sanitizeSettingsV2 } from './atlas-settings.ts';
import type { AtlasModelPort } from './atlas-db-contract.ts';
import type { ModelBatchRequest } from './atlas-ops-contract.ts';
import { DEFAULT_SQL_PROMPT_SEGMENTS, hasLegacySqlPromptProtocol } from './atlas-sql-prompts.ts';

type Options = {
  readSettings: () => Promise<unknown>;
  fetchFn?: typeof fetch;
  now?: () => number;
};

function failure(code: string, message: string, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

/** SQL uses the existing connection library and host transport, not a second API configuration. */
export function createSqlModelPort(options: Options): AtlasModelPort {
  return {
    async request(request: ModelBatchRequest) {
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
      const result = await callAtlasWorldTurnApi({ ...preset,
        maxTokens: Math.min(preset.maxTokens ?? request.maxTokens, request.maxTokens),
        timeoutMs: Math.min(preset.timeoutMs ?? request.timeoutMs, request.timeoutMs),
      }, input, { fetchFn: options.fetchFn, now: options.now, messagesOverride: messages });
      if (!result.ok) throw failure(result.code, result.message, result.retryable);
      return { batchId: request.batchId, text: result.text, finishReason: null,
        httpStatus: result.status, durationMs: result.durationMs };
    },
  };
}
