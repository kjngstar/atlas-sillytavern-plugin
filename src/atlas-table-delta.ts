/**
 * atlas-table-delta.ts — B05/B06：`table-delta-v1` 输出的解析与应用（纯函数，零 IO）。
 *
 * 协议（计划 §2）：
 * - 只识别**最后一个完整** `<atlasEdit>…</atlasEdit>`；剥掉完整的前置推理段，块外文字一律忽略；
 *   块缺失 / 空块 / 未闭合思考段里藏块 → 明确失败，绝不抢救半截 JSON。
 * - 块 ≤ 16 KiB、≤ 64 行、单行 ≤ 2 KiB；逐行独立 `JSON.parse`。
 * - 每行先过语法，再过**字段白名单**（`table` / `op` 与各表允许的键），最后过**引文**：
 *   `basis="observed"` 的位置与归属改动必须带 `quote`，且必须是正文里的连续原文；
 *   `basis="inferred"` 只允许改推测性字段（想法 / 行动倾向 / 目标地点 / 描述类）。
 * - `add` 用本块局部 `new:loc:* / new:npc:* / new:item:*` 引用；已有行用服务端给的正式 ID。
 *   程序自己决定 `sourceId`，模型不需要（也不能）编证据 ID。
 *
 * 应用（B06）：依源顺序把已接受的行应用到**候选副本**，逐行回执；声明失败的临时引用会让
 * 依赖它的后续行记为 `DEPENDENCY_FAILED`；最后 `validateAtlasTables` 复核整份候选，
 * 不通过则整轮回退（返回未改动的输入）。
 */

import {
  applyCharacterEdit,
  applyItemEdit,
  applyLocationEdit,
  cloneAtlasTables,
  createAtlasRefScope,
  validateAtlasTables,
  type AtlasCharacterEdit,
  type AtlasEditBasis,
  type AtlasItemEdit,
  type AtlasLocationEdit,
  type AtlasTableEdit,
  type AtlasTableEditOptions,
  type AtlasTableRefScope,
  type AtlasThreeTablesV1,
} from "./atlas-tables.ts";

/** 块级上限（§2）：总块 16 KiB、最多 64 行、单行 2 KiB。 */
export const ATLAS_EDIT_BLOCK_LIMITS = {
  blockChars: 16 * 1024,
  lines: 64,
  lineChars: 2 * 1024,
} as const;

/** 正文来源：`msg:u` = 本轮用户行动，`msg:a` = 本轮助手回复（与 v2 同一套 sourceId）。 */
export interface AtlasEditSources {
  "msg:u"?: string;
  "msg:a"?: string;
}

export type AtlasEditParseCode =
  | "BLOCK_MISSING"
  | "BLOCK_EMPTY"
  | "BLOCK_TOO_LARGE"
  | "TOO_MANY_LINES"
  | "LINE_TOO_LONG"
  | "JSON_SYNTAX"
  | "LINE_NOT_OBJECT"
  | "TABLE_INVALID"
  | "OP_INVALID"
  | "FIELD_NOT_ALLOWED"
  | "FIELD_TYPE"
  | "NAME_REQUIRED"
  | "REF_INVALID"
  | "QUOTE_REQUIRED"
  | "QUOTE_NOT_FOUND"
  | "BASIS_INVALID"
  | "INFERRED_FIELD_NOT_ALLOWED"
  | "DEPENDENCY_FAILED"
  | "NO_VALID_EDIT_LINES"
  | "TABLE_VALIDATION_FAILED";

export interface AtlasEditRowRejection {
  /** 块内非空行号（1 起）；块级错误为 0。 */
  line: number;
  code: AtlasEditParseCode;
  path: string;
  ref?: string;
}

export interface AtlasEditBlockResult {
  /** edits = 至少一行可用；noop = 显式无变化；rejected = 一行可用都没有（整轮失败）。 */
  status: "edits" | "noop" | "rejected";
  /** 通过语法 + 白名单 + 引文校验的行，保持源顺序；`line` / `sourceId` 已填好。 */
  edits: AtlasTableEdit[];
  rejected: AtlasEditRowRejection[];
  noop: boolean;
  /** 块级失败的具名错误（status === "rejected" 时非 null）。 */
  error: AtlasEditRowRejection | null;
}

const OPEN_TAG = "<atlasEdit>";
const CLOSE_TAG = "</atlasEdit>";

/** 每表允许的顶层键（`patch` 里的键另有一份白名单）。 */
const TABLE_FIELDS: Record<string, Set<string>> = {
  location: new Set(["table", "op", "ref", "name", "description", "parentRef", "rumors", "factions", "patch", "quote", "basis", "kind"]),
  character: new Set(["table", "op", "ref", "name", "locationRef", "thought", "actionTendency", "currentAction", "targetLocationRef", "presence", "patch", "quote", "basis", "kind"]),
  item: new Set(["table", "op", "ref", "name", "description", "status", "locationRef", "holderRef", "patch", "quote", "basis", "kind"]),
};

const PATCH_FIELDS: Record<string, Set<string>> = {
  location: new Set(["name", "description", "parentRef", "rumors", "factions"]),
  character: new Set(["name", "locationRef", "thought", "actionTendency", "currentAction", "targetLocationRef", "presence"]),
  item: new Set(["name", "description", "status", "locationRef", "holderRef"]),
};

/** 各表的局部引用前缀（§2：`new:loc:*` / `new:npc:*` / `new:item:*`）。 */
const TEMP_REF_PREFIX: Record<string, string> = {
  location: "new:loc:",
  character: "new:npc:",
  item: "new:item:",
};

/** 位置 / 归属字段：这些字段一改就必须有 observed 引文。 */
const POSITION_FIELDS = new Set(["parentRef", "locationRef", "holderRef"]);

/** `basis="inferred"` 允许触碰的字段（其余一律拒绝）。 */
const INFERRED_ALLOWED: Record<string, Set<string>> = {
  location: new Set(["description", "rumors", "factions"]),
  character: new Set(["thought", "actionTendency", "targetLocationRef"]),
  item: new Set(["description"]),
};

const NOOP_LINE = "noop";

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 去掉**完整**的前置推理段（`<think>` / `<thinking>` / `<thought>`，可连续多段）。
 * 返回 `insideReasoning`：正文以未闭合的推理段开头 —— 后面就算有块也在推理里，绝不抢救。
 */
function stripLeadingReasoning(text: string): { text: string; insideReasoning: boolean } {
  let value = text.trim();
  for (let section = 0; section < 4; section += 1) {
    const leading = /^<(think|thinking|thought)(?:\s[^>]*)?>/i.exec(value);
    if (!leading) break;
    const tag = leading[1]!.toLowerCase();
    const boundary = new RegExp(`<\\/?${tag}(?:\\s[^>]*)?>`, "gi");
    let depth = 0;
    let end = -1;
    for (const match of value.matchAll(boundary)) {
      if (match.index === 0 || depth > 0) {
        depth += match[0].startsWith("</") ? -1 : 1;
        if (depth === 0) {
          end = match.index + match[0].length;
          break;
        }
      }
    }
    if (end < 0) return { text: value, insideReasoning: true };
    value = value.slice(end).trim();
  }
  return { text: value, insideReasoning: false };
}

/** 最后一个**完整闭合**的块（开标签必须在闭标签之前）。 */
function lastCompleteBlock(text: string): { body: string; start: number } | null {
  let searchFrom = text.length;
  while (searchFrom > 0) {
    const closeAt = text.lastIndexOf(CLOSE_TAG, searchFrom - 1);
    if (closeAt < 0) return null;
    const openAt = text.lastIndexOf(OPEN_TAG, closeAt - 1);
    if (openAt >= 0) return { body: text.slice(openAt + OPEN_TAG.length, closeAt), start: openAt };
    searchFrom = closeAt;
  }
  return null;
}

function quoteSource(quote: string, sources: AtlasEditSources): string | null {
  // 助手正文优先（推演主要依据本轮回复）；两处都命中时记 msg:a
  if (typeof sources["msg:a"] === "string" && sources["msg:a"].includes(quote)) return "msg:a";
  if (typeof sources["msg:u"] === "string" && sources["msg:u"].includes(quote)) return "msg:u";
  return null;
}

/** 该行是否改动了位置 / 归属（改了就必须要引文）。 */
function touchesPosition(table: string, op: string, record: Record<string, unknown>): boolean {
  if (op === "remove") return true;
  if (op === "add") {
    if (table === "location") return true; // 新地点必须能核验父位置（§2）
    if (table === "character") return record.locationRef !== undefined && record.locationRef !== null;
    return (record.locationRef !== undefined && record.locationRef !== null)
      || (record.holderRef !== undefined && record.holderRef !== null);
  }
  const patch = isObj(record.patch) ? record.patch : {};
  for (const key of Object.keys(patch)) {
    if (POSITION_FIELDS.has(key)) return true;
  }
  return false;
}

/** 该行所有引用槽位（含 patch 内），用于本块依赖检查。 */
function refSlots(record: Record<string, unknown>): Array<{ path: string; value: string }> {
  const patch = isObj(record.patch) ? record.patch : {};
  const candidates: Array<[string, unknown]> = [
    ["$.parentRef", record.parentRef],
    ["$.locationRef", record.locationRef],
    ["$.holderRef", record.holderRef],
    ["$.targetLocationRef", record.targetLocationRef],
    ["$.patch.parentRef", patch.parentRef],
    ["$.patch.locationRef", patch.locationRef],
    ["$.patch.holderRef", patch.holderRef],
    ["$.patch.targetLocationRef", patch.targetLocationRef],
  ];
  return candidates
    .filter(([, value]) => typeof value === "string" && (value as string).startsWith("new:"))
    .map(([path, value]) => ({ path, value: value as string }));
}

/** `basis="inferred"` 时，行里出现的每个字段都必须落在允许集合内。 */
function inferredViolation(table: string, op: string, record: Record<string, unknown>): string | null {
  if (op !== "set") return op === "add" ? "$" : "$.op";
  const patch = isObj(record.patch) ? record.patch : {};
  for (const key of Object.keys(patch)) {
    if (!INFERRED_ALLOWED[table]?.has(key)) return `$.patch.${key}`;
  }
  return null;
}

/**
 * B05：解析最后一个完整 `<atlasEdit>` 块（纯函数，不做任何写入）。
 *
 * 说明：规格里写的签名是 `parseAtlasEditBlock(text, sourceText)`；为了让程序能自己判定
 * `sourceId`（§2 原话「quote 只需要直接包含在助手正文或用户正文之一，程序决定 sourceId」），
 * 第二个参数取 `{ "msg:u", "msg:a" }` 而不是单个字符串。
 */
export function parseAtlasEditBlock(text: unknown, sources: AtlasEditSources = {}): AtlasEditBlockResult {
  const rejected: AtlasEditRowRejection[] = [];
  const fail = (code: AtlasEditParseCode, path: string, ref?: string): AtlasEditBlockResult => {
    const error: AtlasEditRowRejection = { line: 0, code, path, ...(ref === undefined ? {} : { ref }) };
    return { status: "rejected", edits: [], rejected: [...rejected, error], noop: false, error };
  };
  const raw = typeof text === "string" ? text : "";
  const prepared = stripLeadingReasoning(raw);
  if (prepared.insideReasoning) return fail("BLOCK_MISSING", "$.block");

  const block = lastCompleteBlock(prepared.text);
  if (!block) return fail("BLOCK_MISSING", "$.block");
  if (block.body.length > ATLAS_EDIT_BLOCK_LIMITS.blockChars) return fail("BLOCK_TOO_LARGE", "$.block");

  const lines = block.body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length > ATLAS_EDIT_BLOCK_LIMITS.lines) return fail("TOO_MANY_LINES", "$.block");
  if (lines.length === 0) return fail("BLOCK_EMPTY", "$.block");

  const edits: AtlasTableEdit[] = [];
  const acceptedTempRefs = new Set<string>();
  let sawNoop = false;

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const reject = (code: AtlasEditParseCode, path: string, ref?: string): void => {
      rejected.push({ line: lineNo, code, path, ...(ref === undefined ? {} : { ref }) });
    };
    if (line.length > ATLAS_EDIT_BLOCK_LIMITS.lineChars) {
      reject("LINE_TOO_LONG", "$");
      return;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      reject("JSON_SYNTAX", "$");
      return;
    }
    if (!isObj(record)) {
      reject("LINE_NOT_OBJECT", "$");
      return;
    }
    if (record.kind === NOOP_LINE) {
      sawNoop = true;
      return;
    }
    const table = typeof record.table === "string" ? record.table : "";
    if (!(table in TABLE_FIELDS)) {
      reject("TABLE_INVALID", "$.table");
      return;
    }
    const op = typeof record.op === "string" ? record.op : "";
    if (op !== "add" && op !== "set" && op !== "remove") {
      reject("OP_INVALID", "$.op");
      return;
    }
    // 字段白名单：任何 id / 坐标 / 时间 / 比例尺字段都不允许由模型直接写
    for (const key of Object.keys(record)) {
      if (!TABLE_FIELDS[table]!.has(key)) {
        reject("FIELD_NOT_ALLOWED", `$.${key}`);
        return;
      }
    }
    if (record.patch !== undefined) {
      if (!isObj(record.patch)) {
        reject("FIELD_TYPE", "$.patch");
        return;
      }
      for (const key of Object.keys(record.patch)) {
        if (!PATCH_FIELDS[table]!.has(key)) {
          reject("FIELD_NOT_ALLOWED", `$.patch.${key}`);
          return;
        }
      }
    }
    if (record.basis !== undefined && record.basis !== "observed" && record.basis !== "inferred") {
      reject("BASIS_INVALID", "$.basis");
      return;
    }
    const basis: AtlasEditBasis = record.basis === "inferred" ? "inferred" : "observed";
    if (typeof record.ref !== "string" || record.ref.length === 0) {
      reject("REF_INVALID", "$.ref");
      return;
    }
    const isTempRef = record.ref.startsWith("new:");
    if (op === "add") {
      // 新增必须用本块局部引用，且类型必须与本表匹配
      if (!isTempRef || !record.ref.startsWith(TEMP_REF_PREFIX[table]!)) {
        reject("REF_INVALID", "$.ref", record.ref);
        return;
      }
      if (acceptedTempRefs.has(record.ref)) {
        reject("REF_INVALID", "$.ref", record.ref);
        return;
      }
    } else if (isTempRef && !acceptedTempRefs.has(record.ref)) {
      // 引用本块前面声明失败（或根本不存在）的新增行 → 依赖失败，不整轮报错
      reject("DEPENDENCY_FAILED", "$.ref", record.ref);
      return;
    }
    if (op === "add" && (typeof record.name !== "string" || record.name.trim().length === 0)) {
      reject("NAME_REQUIRED", "$.name");
      return;
    }
    // 本块依赖检查：行内任何指向 `new:*` 的引用都必须是**本块前面已接受**的新增行
    for (const slot of refSlots(record)) {
      if (!acceptedTempRefs.has(slot.value)) {
        reject("DEPENDENCY_FAILED", slot.path, slot.value);
        return;
      }
    }
    // 根因优先：inferred 本来就无权改这些字段，先按「依据类型错」报，再谈引文
    if (basis === "inferred") {
      const violated = inferredViolation(table, op, record);
      if (violated !== null) {
        reject("INFERRED_FIELD_NOT_ALLOWED", violated);
        return;
      }
    }
    // 引文：位置 / 归属改动必须命中正文连续原文
    let sourceId: string | null = null;
    const quote = typeof record.quote === "string" ? record.quote : "";
    if (quote.length > 0) {
      sourceId = quoteSource(quote, sources);
      if (sourceId === null) {
        reject("QUOTE_NOT_FOUND", "$.quote");
        return;
      }
    }
    if (touchesPosition(table, op, record) && quote.length === 0) {
      reject("QUOTE_REQUIRED", "$.quote");
      return;
    }
    // 通过：保留原始行内容，补上程序决定的 line / sourceId
    const edit = { ...record, line: lineNo, ...(sourceId === null ? {} : { sourceId }) } as unknown as AtlasTableEdit;
    edits.push(edit);
    if (op === "add") acceptedTempRefs.add(record.ref);
  });

  if (edits.length === 0) {
    if (sawNoop) return { status: "noop", edits: [], rejected, noop: true, error: null };
    // 块级错误必须指出**第一条**真实原因（例如某行超长 / 引文不匹配），
    // 而不是笼统的「没有有效行」——否则回执会掩盖具体字段路径。
    const first = rejected[0] ?? { line: 0, code: "NO_VALID_EDIT_LINES" as AtlasEditParseCode, path: "$.block" };
    const rows = rejected.length > 0
      ? rejected
      : [{ line: 0, code: "NO_VALID_EDIT_LINES" as AtlasEditParseCode, path: "$.block" }];
    return { status: "rejected", edits: [], rejected: rows, noop: false, error: first };
  }
  return { status: "edits", edits, rejected, noop: false, error: null };
}

/* ------------------------------------------------------------------ *
 * B06：把已接受的行应用到候选三表
 * ------------------------------------------------------------------ */

export interface AtlasDeltaRowReceipt {
  line: number;
  ok: boolean;
  op?: string;
  id?: string;
  code?: AtlasEditParseCode;
  path?: string;
  ref?: string;
}

export interface AtlasDeltaOutcome {
  ok: boolean;
  /** 通过 A01 校验的新候选；ok=false 时是**未改动的输入**（整轮回退）。 */
  tables: AtlasThreeTablesV1;
  applied: AtlasDeltaRowReceipt[];
  rejected: AtlasDeltaRowReceipt[];
  /** 整轮错误（候选校验失败等）；具名代码见 `AtlasEditParseCode`。 */
  error: { code: AtlasEditParseCode; path: string } | null;
}

/** 取出一行编辑里所有「引用槽位」，用于依赖失败传播。 */
function refsOfEdit(edit: AtlasTableEdit): string[] {
  const refs: Array<string | null | undefined> = [edit.ref];
  if (edit.table === "location") {
    const item = edit as AtlasLocationEdit;
    refs.push(item.parentRef, item.patch?.parentRef);
  } else if (edit.table === "character") {
    const item = edit as AtlasCharacterEdit;
    refs.push(item.locationRef, item.targetLocationRef, item.patch?.locationRef, item.patch?.targetLocationRef);
  } else {
    const item = edit as AtlasItemEdit;
    refs.push(item.locationRef, item.holderRef, item.patch?.locationRef, item.patch?.holderRef);
  }
  return refs.filter((value): value is string => typeof value === "string" && value.length > 0);
}

/**
 * B06：依源顺序应用（在**候选副本**上；输入永不被修改）。
 * - 声明失败的新增行会把它的临时引用记入失败集合，依赖它的后续行直接记 `DEPENDENCY_FAILED`。
 * - 全部应用完毕后用 `validateAtlasTables` 复核；不通过则整轮回退（返回输入 + 具名错误）。
 */
export function applyAtlasTableDelta(
  base: AtlasThreeTablesV1,
  edits: readonly AtlasTableEdit[],
  options: AtlasTableEditOptions = {},
): AtlasDeltaOutcome {
  const candidate = cloneAtlasTables(base);
  const scope: AtlasTableRefScope = createAtlasRefScope();
  const failedRefs = new Set<string>();
  const applied: AtlasDeltaRowReceipt[] = [];
  const rejected: AtlasDeltaRowReceipt[] = [];

  for (const edit of edits) {
    const line = typeof edit.line === "number" ? edit.line : 0;
    const broken = refsOfEdit(edit).find((ref) => failedRefs.has(ref));
    if (broken !== undefined) {
      rejected.push({ line, ok: false, code: "DEPENDENCY_FAILED", ref: broken, op: edit.op });
      continue;
    }
    const result = edit.table === "location"
      ? applyLocationEdit(candidate, edit as AtlasLocationEdit, scope, options)
      : edit.table === "character"
        ? applyCharacterEdit(candidate, edit as AtlasCharacterEdit, scope, options)
        : applyItemEdit(candidate, edit as AtlasItemEdit, scope);
    if (result.ok) {
      applied.push({ line, ok: true, id: result.id, op: result.op });
      continue;
    }
    rejected.push({ line, ok: false, code: result.error.code as AtlasEditParseCode, path: result.error.path, ref: result.error.ref, op: edit.op });
    if (edit.op === "add") failedRefs.add(edit.ref);
  }

  const validation = validateAtlasTables(candidate);
  if (!validation.ok) {
    const first = validation.errors[0]!;
    return {
      ok: false,
      tables: base,
      applied,
      rejected,
      error: { code: "TABLE_VALIDATION_FAILED", path: first.path },
    };
  }
  return { ok: true, tables: candidate, applied, rejected, error: null };
}

/** B06 的便利封装：解析 + 应用一次做完（C04 用；解析失败时不改任何数据）。 */
export function applyAtlasEditText(
  base: AtlasThreeTablesV1,
  text: unknown,
  sources: AtlasEditSources,
  options: AtlasTableEditOptions = {},
): { parse: AtlasEditBlockResult; delta: AtlasDeltaOutcome | null } {
  const parse = parseAtlasEditBlock(text, sources);
  if (parse.status === "rejected") return { parse, delta: null };
  if (parse.status === "noop") {
    return { parse, delta: { ok: true, tables: base, applied: [], rejected: [], error: null } };
  }
  return { parse, delta: applyAtlasTableDelta(base, parse.edits, options) };
}
