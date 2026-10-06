/**
 * U10：这一轮的世界动向摘要（默认程序模板；模型摘要可选）。
 *
 * 纪律：
 * - 只从**已按视角过滤**的 changes/events/tasks 生成，绝不重读全世界书、不改事实。
 * - 侧栏是给读者看的：不出现「应用 5 行」「TABLE_MIGRATED」「第 0→0 时段」这类技术计数。
 * - 没有公开变化时给出正常空说明，不拿技术日志充数。
 * - 可选模型摘要只收到可见小集合；失败一律回退程序模板。
 */

export type WorldSummaryViewMode = "pov" | "author";

export interface WorldSummaryEntry {
  readonly kind?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly actorName?: string;
  readonly locationName?: string;
  readonly fromLocationName?: string;
  readonly toLocationName?: string;
  readonly hidden?: boolean;
  readonly secret?: boolean;
  readonly blocked?: boolean;
  readonly status?: string;
  readonly occurred?: boolean;
}

export interface WorldSummaryInput {
  readonly turnId?: string | null;
  readonly revision?: number | null;
  readonly viewMode?: WorldSummaryViewMode;
  readonly povId?: string | null;
  readonly events?: readonly WorldSummaryEntry[];
  readonly changes?: readonly WorldSummaryEntry[];
  readonly tasks?: readonly WorldSummaryEntry[];
  readonly fronts?: readonly WorldSummaryEntry[];
  readonly maxLines?: number;
  /** 可选摘要模型：只收到可见小集合，返回 1–3 行自然语言；抛错或返回空即回退程序模板。 */
  readonly model?: (payload: WorldSummaryPayload) => string | null | undefined | Promise<string | null | undefined>;
}

export interface WorldSummaryPayload {
  readonly turnId: string | null;
  readonly revision: number | null;
  readonly viewMode: WorldSummaryViewMode;
  readonly lines: readonly string[];
}

export interface WorldSummaryResult {
  readonly turnId: string | null;
  readonly revision: number | null;
  readonly viewMode: WorldSummaryViewMode;
  /** 1–3 条读者可懂的动向；无内容时为空数组。 */
  readonly lines: readonly string[];
  readonly source: "program" | "model" | "empty";
  /** 无可见变化时的正常说明（不是错误）。 */
  readonly note: string | null;
  /** 参与生成的可见条目数（只用于调试面板，不进侧栏文案）。 */
  readonly visibleCount: number;
  readonly modelFailed: boolean;
}

/** 技术串黑名单：这些属于日志，不是世界动向。 */
const TECHNICAL_PATTERNS: readonly RegExp[] = [
  /MIGRATED/i, /TABLE_MIGRATED/i, /SCHEMA/i, /SQL_/i, /WORLD_TURN/i, /RECEIPT/i,
  /第\s*\d+\s*[→\->]\s*\d+\s*时段/, /应用\s*\d+\s*行/, /^[A-Z][A-Z0-9_]{5,}$/,
];

function text(value: unknown): string {
  if (value == null) return "";
  const out = String(value).trim();
  return out;
}
function isTechnical(line: string): boolean {
  return TECHNICAL_PATTERNS.some((pattern) => pattern.test(line));
}
function visible(input: WorldSummaryInput, rows: readonly WorldSummaryEntry[] | undefined): WorldSummaryEntry[] {
  if (!Array.isArray(rows)) return [];
  const author = input.viewMode === "author";
  return rows.filter((row) => row && typeof row === "object" && (author || (row.hidden !== true && row.secret !== true)));
}
function nameOf(row: WorldSummaryEntry): string {
  return text(row.actorName) || text(row.title) || text(row.summary);
}

function lineForEvent(row: WorldSummaryEntry): string | null {
  const actor = text(row.actorName);
  const where = text(row.locationName);
  const what = text(row.title) || text(row.summary);
  if (!actor && !what) return null;
  if (actor && where && what) return `${actor} 在${where}：${what}`;
  if (actor && what) return `${actor}：${what}`;
  if (actor && where) return `${actor} 出现在${where}`;
  return what || null;
}
function lineForTask(row: WorldSummaryEntry): string | null {
  const actor = text(row.actorName);
  const to = text(row.toLocationName);
  const from = text(row.fromLocationName);
  if (row.blocked === true || row.status === "blocked") {
    return actor ? `${actor} 还在等待条件，没有出发` : null;
  }
  if (actor && from && to) return `${actor} 从${from}前往${to}`;
  if (actor && to) return `${actor} 正在前往${to}`;
  return lineForEvent(row);
}
function lineForFront(row: WorldSummaryEntry): string | null {
  const where = text(row.locationName);
  const what = text(row.title) || text(row.summary);
  if (!what) return null;
  return where ? `${where}传出消息：${what}` : `有消息在传：${what}`;
}
function lineForChange(row: WorldSummaryEntry): string | null {
  const who = nameOf(row);
  const where = text(row.locationName) || text(row.toLocationName);
  const kind = text(row.kind);
  if (kind === "departed" || kind === "leave") return who && where ? `${who} 离开了${where}` : null;
  if (kind === "arrived" || kind === "arrival") return who && where ? `${who} 抵达${where}` : null;
  return lineForEvent(row);
}

/** 程序模板：固定 1–3 条，按 事件 → 任务 → 风声 → 变化 的优先级取。 */
export function buildProgramLines(input: WorldSummaryInput, limit = 3): string[] {
  const out: string[] = [];
  const push = (value: string | null) => {
    const line = text(value);
    if (!line || isTechnical(line) || out.includes(line)) return;
    out.push(line);
  };
  for (const row of visible(input, input.events)) { if (out.length >= limit) break; push(lineForEvent(row)); }
  for (const row of visible(input, input.tasks)) { if (out.length >= limit) break; push(lineForTask(row)); }
  for (const row of visible(input, input.fronts)) { if (out.length >= limit) break; push(lineForFront(row)); }
  for (const row of visible(input, input.changes)) { if (out.length >= limit) break; push(lineForChange(row)); }
  return out.slice(0, limit);
}

/**
 * 生成摘要。同步部分永远是程序模板；给定 model 时尝试一次模型摘要，
 * 失败 / 空 / 含技术串一律保留程序模板。
 */
export async function buildVisibleWorldSummary(input: WorldSummaryInput = {}): Promise<WorldSummaryResult> {
  const viewMode: WorldSummaryViewMode = input.viewMode === "author" ? "author" : "pov";
  const limit = Math.min(3, Math.max(1, Math.trunc(Number(input.maxLines ?? 3) || 3)));
  const turnId = input.turnId ?? null;
  const revision = Number.isInteger(input.revision) ? Number(input.revision) : null;
  const program = buildProgramLines({ ...input, viewMode }, limit);
  const visibleCount = visible(input, input.events).length + visible(input, input.tasks).length
    + visible(input, input.fronts).length + visible(input, input.changes).length;
  const base = {
    turnId, revision, viewMode, visibleCount,
    note: program.length ? null : (viewMode === "author" ? "这一轮没有可见变化，也没有后台变化。" : "这一轮没有主角可见的动向。"),
  };
  if (!program.length) return { ...base, lines: [], source: "empty", modelFailed: false };
  if (typeof input.model !== "function") return { ...base, lines: program, source: "program", modelFailed: false };
  try {
    const raw = await input.model({ turnId, revision, viewMode, lines: program });
    const lines = text(raw).split("\n").map((line) => line.trim()).filter((line) => line && !isTechnical(line)).slice(0, limit);
    if (lines.length) return { ...base, lines, source: "model", note: null, modelFailed: false };
  } catch {
    // 模型摘要失败：回退程序模板，不把异常抛给 UI
  }
  return { ...base, lines: program, source: "program", modelFailed: true };
}

/** 同步版（无模型）便于纯函数测试与 UI 首帧。 */
export function buildVisibleWorldSummarySync(input: WorldSummaryInput = {}): WorldSummaryResult {
  const viewMode: WorldSummaryViewMode = input.viewMode === "author" ? "author" : "pov";
  const limit = Math.min(3, Math.max(1, Math.trunc(Number(input.maxLines ?? 3) || 3)));
  const lines = buildProgramLines({ ...input, viewMode }, limit);
  const visibleCount = visible(input, input.events).length + visible(input, input.tasks).length
    + visible(input, input.fronts).length + visible(input, input.changes).length;
  return {
    turnId: input.turnId ?? null,
    revision: Number.isInteger(input.revision) ? Number(input.revision) : null,
    viewMode, lines, source: lines.length ? "program" : "empty",
    note: lines.length ? null : (viewMode === "author" ? "这一轮没有可见变化，也没有后台变化。" : "这一轮没有主角可见的动向。"),
    visibleCount, modelFailed: false,
  };
}
