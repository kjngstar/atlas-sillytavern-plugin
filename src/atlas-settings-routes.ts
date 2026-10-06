/** Settings persistence and local permission checks, independent of world storage. */
import { ATLAS_ERROR_CODES, AtlasError } from './atlas-contract.ts';
import { okResult, type AtlasRouteResult } from './atlas-route-result.ts';
import type { AtlasDocumentStore, AtlasRequestContext } from './atlas-server-contract.ts';
import {
 ATLAS_SETTINGS_SCHEMA_VERSION, applyLegacySettingsPatch, applySettingsCommand,
 createDefaultSettingsV2, migrateAtlasSettings, sanitizeSettingsV2, settingsViewV2,
 type AtlasServerSettingsV2, type AtlasSettingsCommand,
} from './atlas-settings.ts';
export function createAtlasSettingsRoutes(deps: {
 store: AtlasDocumentStore; now?:()=>number; override?:()=>AtlasServerSettingsV2|null;
 log?:(entry:Record<string,unknown>)=>void;
}) {
 const store=deps.store,now=deps.now??Date.now,SETTINGS_DOC='settings';
 let settings=createDefaultSettingsV2(),settingsLoaded=false,settingsPromptRecoveryCount=0;
  /**
   * 惰性加载设置：识别 schemaVersion 2 与 v1。
   * - v2：sanitize（非法条目丢弃、悬挂引用归一为 null）。
   * - v1（或形状可疑的旧数据）：纯函数迁移，**不写 store**；首个成功写入时落库 v2。
   */
  async function loadSettings(): Promise<AtlasServerSettingsV2> {
    const override=deps.override?.();
    if (override) return override;
    if (settingsLoaded) return settings;
    const raw = await store.read(SETTINGS_DOC);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      if (record.schemaVersion === ATLAS_SETTINGS_SCHEMA_VERSION) {
        const sanitized = sanitizeSettingsV2(record, { now });
        settings = sanitized.settings;
        settingsPromptRecoveryCount = sanitized.diagnostics.promptSkipped;
        if (sanitized.diagnostics.skipped > 0) {
          deps.log?.({ at: now(), kind: "settings-sanitize", skipped: sanitized.diagnostics.skipped });
        }
      } else {
        const migrated = migrateAtlasSettings(record, { now });
        settings = migrated.settings;
        settingsPromptRecoveryCount = migrated.diagnostics.promptSkipped;
        deps.log?.({
          at: now(),
          kind: "settings-migrate",
          from: typeof record.schemaVersion === "number" ? record.schemaVersion : "unknown",
          to: ATLAS_SETTINGS_SCHEMA_VERSION,
          apiPresets: migrated.settings.apiPresets.length,
          promptPresets: migrated.settings.promptPresets.length,
          skipped: migrated.diagnostics.skipped,
        });
      }
    }
    settingsLoaded = true;
    return settings;
  }

  /** 写入设置：先落 store，成功后替换内存（失败保持旧值——不留下半更新状态）。 */
  async function persistSettings(next: AtlasServerSettingsV2): Promise<AtlasServerSettingsV2> {
    await store.write(SETTINGS_DOC, next);
    settings = next;
    settingsLoaded = true;
    return settings;
  }

  async function handleHealth(): Promise<AtlasRouteResult> {
    return okResult({
      ok: true,
      plugin: "atlas",
      // 0.9.18 起与 ATLAS_PLUGIN_VERSION 同步（此前自 0.9.2 起一直烂着没人查——
      // tests/atlas-server-plugin.test.mjs 的 health 版本一致性断言防再犯）
      version: "0.9.82",
      protocolVersion: 1,
      time: now(),
    });
  }

  async function handleGetSettings(ctx: AtlasRequestContext): Promise<AtlasRouteResult> {
    // 0.9.48（T07 权限闸）：读取与写入同一道门——配置含连接端点与密钥信息，
    // 只有本机会话（浏览器默认模式恒 local=true）或部署方授权的 admin（server plugin）可读。
    // 远程匿名 / 普通用户 403，不再存在「改设置要登录、读配置公网可扫」的不对称。
    if (!ctx.local) throw new AtlasError(ATLAS_ERROR_CODES.FORBIDDEN, "只有本机已登录会话可以读取 Atlas 设置。");
    const current = await loadSettings();
    // 视图语义（0.9.12 作者令，照抄 shujuku）：本机会话回填明文 Key（编辑器免重输）；
    // 该语义以 local 闸为前提——远程非本机用户根本到不了这一行。
    // 0.9.48 补 hasApiKey / apiKeyLast4 供 UI 展示尾号；响应体绝不含密钥以外的敏感头原文。
    return okResult({ ...settingsViewV2(current), recoveryPromptCount: settingsPromptRecoveryCount });
  }

  /**
   * PUT /settings：
   * - 新形态 = **命令**（带 action 字段）：校验 → 生成全新 next 快照 → 写 store → 成功后才替换缓存。
   * - 兼容形态 = v1 部分更新载荷（worldTurn / presetLibrary / autoCommit / rpmLimit）：
   *   立即按 v2 语义迁移应用（不保留组合式存储），并在同一次写入里落库 v2。
   */
  async function handlePutSettings(body: unknown, ctx: AtlasRequestContext): Promise<AtlasRouteResult> {
    if (!ctx.local) throw new AtlasError(ATLAS_ERROR_CODES.FORBIDDEN, "只有本机已登录会话可以修改 Atlas 设置。");
    const current = await loadSettings();
    // A sanitized snapshot would irreversibly omit rejected legacy presets.
    if (settingsPromptRecoveryCount > 0) {
      throw new AtlasError(
        ATLAS_ERROR_CODES.INVALID_PAYLOAD,
        "原始设置中有 " + settingsPromptRecoveryCount + " 条提示词预设无法读取。设置写入已暂停，请先备份原始设置并恢复这些预设。",
      );
    }
    const isCommand = Boolean(body) && typeof body === "object" && !Array.isArray(body) &&
      typeof (body as { action?: unknown }).action === "string";
    const result = isCommand
      ? applySettingsCommand(current, body as AtlasSettingsCommand, { now })
      : applyLegacySettingsPatch(current, body, { now });
    if (!result.ok) {
      throw new AtlasError(
        (result.code === "FIELD_LIMIT_EXCEEDED" ? ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED : ATLAS_ERROR_CODES.INVALID_PAYLOAD),
        result.message ?? "设置更新被拒绝。",
      );
    }
    const saved = await persistSettings(result.settings);
    if (!isCommand) {
      deps.log?.({ at: now(), kind: "settings-legacy-patch", apiPresets: saved.apiPresets.length });
    }
    const view = settingsViewV2(saved);
    /**
     * E02：`prompt.migrate-legacy` 的结果随视图一起返回，UI 据此：
     * ① 预览新草稿（原文一字未改，只新建了一份）；② 让作者显式选择是否启用。
     * 旧预设仍在 `promptPresets` 里原样可见、可复制。
     */
    if (result.migratedPresetId) {
      return okResult({
        ...view,
        migratedPromptPresetId: result.migratedPresetId,
        migratedPromptPresetName: result.migratedPresetName ?? "",
        replacedKeywords: result.replacedKeywords ?? [],
      });
    }
    return okResult(view);
  }

 return {loadSettings,persistSettings,handleHealth,handleGetSettings,handlePutSettings,current:()=>deps.override?.()??settings};
}
