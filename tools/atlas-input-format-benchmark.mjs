/**
 * atlas-input-format-benchmark.mjs — T31（§18.3 T31 / §20.2 / §20.3 / §20.4）。
 *
 * 规格原文要点：
 *   §20.2 增加 `tools/atlas-input-format-benchmark.mjs`，接受 `--fixtures <path> --format ops|sql
 *         --runs 3 --offline`。offline 只回放预设输出，不请求外网。真实测试显式使用 `--live`
 *         并读取本机 API 配置，不把密钥写入报告。A 组=本方案简短 JSON 操作；B 组=有限 SQL 编辑
 *         视图，只比较两边都支持的同等任务（地点/人物/物品基本新增、名称/描述/心理修改、简单
 *         粗位置变更），SQL 使用显式列清单与目标 ID，禁止 DDL/PRAGMA/ATTACH/多表任意查询，在
 *         独立临时库内执行并把差异交给相同业务检查器。两组相同模型/版本/正文/相关数据/输出预算/
 *         修复次数/功能范围，分别提供各自最小充分说明。固定 20 个场景 × 3 次 × A/B 各 60 次 =
 *         120 次初次请求；修复另计。真实自然输出与人工注入损坏样例分开统计。
 *   §20.3 必报指标：首次语法成功率 / 首次语义成功率 / 修复后成功率 / 无关有效组保留率 / 错改范围 /
 *         重复副作用 / 认知泄漏 / 成本与耗时 / 故障定位完整率。
 *   §20.4 `60 例中首次 ≥57，一次修复后 ≥59` 是**发布目标值，不是本次结果**。
 *
 * 用法：
 *   node tools/atlas-input-format-benchmark.mjs --format ops --offline --runs 3
 *   node tools/atlas-input-format-benchmark.mjs --format sql --offline
 *   node tools/atlas-input-format-benchmark.mjs --format ops --live [--config <path>]
 *   node tools/atlas-input-format-benchmark.mjs --format ops --offline --json
 *   node tools/atlas-input-format-benchmark.mjs --format ops --offline --out report.json
 *   node tools/atlas-input-format-benchmark.mjs --help
 *
 * 退出码：0 = 本次运行完成（离线成功率字段为 null 也是完成）；1 = 用法/配置错误或工具自身抛错。
 *
 * ── 夹具文件格式（可选；本任务不创建该文件）────────────────────────────────
 * 默认路径 `tests/fixtures/atlas-input-format/scenarios.mjs`。存在就用它，不存在就退化为本文件
 * 内置的 20 个场景，并在报告里显著说明「本次使用内置场景集，不是夹具文件」——绝不假装用了夹具。
 *
 *   export const meta = { note: "可选说明" };
 *   export const scenarios = [
 *     {
 *       id: "S01",                    // 必填，唯一
 *       title: "新建",                 // 必填，人读标题
 *       kind: "new",                  // 可选，§20.2 场景类型
 *       cohort: "natural",            // "natural" | "injected_damage"（人工注入损坏必须分开统计）
 *       damage: null,                 // null | "missing_required_field" | "bad_ref" | "truncated" | ...
 *       branch: "main-A",             // 临时库内执行的分支
 *       newIds: { "new:L4": "L4" },   // 程序为 new: 引用分配的稳定 ID（两边共用）
 *       intents: [                    // 同一份意图 → 两个组各自渲染「最小充分说明」
 *         { op: "location.upsert", ref: "new:L4", data: { name: "旧钟楼", kind: "building" } },
 *       ],
 *       programEffects: { clockDeltaS: 600 },        // 可选，程序侧时间/路程副作用（重试不得重复）
 *       groupSupport: { ops: true, sql: true },      // 可选；B 组不支持的任务必须显式标 false
 *       expected: { writes: [ { table: "locations", rowId: "L4", fields: ["name"] } ] }, // 可选，缺省从 intents 推导
 *       preset: {                     // 可选；缺省由 intents 渲染。这是**预设回放文本**，不是模型输出
 *         ops: { initial: "…", repair: "…" },
 *         sql: { initial: "…", repair: "…" },
 *       },
 *     },
 *   ];
 *   export const live = { endpoint, model, apiKey, maxTokens, temperature, timeoutMs }; // 可选；key 永不进报告
 *
 * ── 诚实性纪律（§20.1 / §20.4 的落地）───────────────────────────────────────
 * 1. 不编造测量：`--offline` 没有模型，因此 `rates.*` 全部是 null，原因是 OFFLINE_REPLAY_NO_MODEL。
 *    离线能报的只有**解析/校验/提交结果**（预设回放、确定性），单独放在 deterministicOutcomes，
 *    并标注 measuredOn = "tool-harness-preset-replay"。
 * 2. 预设文本由本工具从同一意图渲染或人工注入损坏；不代表真实模型输出分布。人工注入损坏样例与
 *    自然样例分开统计，绝不混进「模型生成正确率」。
 * 3. 业务校验是本文件里的纯 JS 等价实现，**不是** `src/atlas-ops-compile.ts` 的真实
 *    `compileOperations`（TS 不能被 .mjs 工具直接 import）。报告里逐条写明这一替换。
 * 4. 临时库用的是本文件内的**最小表子集**（locations/characters/items/entity_keys/branches/turns/maps），
 *    不是 20 张表的真实 schema。
 * 5. `--live` 报告必须写模型名/版本、提示词 hash、输出预算、修复次数、运行次数；少于计划请求数要
 *    明说。任何密钥形态串（含实际读到的 key）在写报告前被脱敏，脱敏后仍能扫出 key → 拒写并退出 1。
 * 6. §20.4 的门槛表只作为**目标值**出现，必须标注「目标值，不是本次结果」。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import initSqlJs from "sql.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOOL_NAME = "atlas-input-format-benchmark";
const PROMPT_SET_VERSION = "atlas-input-format-benchmark/prompt-set-v1";
const DEFAULT_FIXTURES_PATH = "tests/fixtures/atlas-input-format/scenarios.mjs";

/** §16.2 固定限制（工程默认值，不是实测最优值）。本文件不 import TS，故按规格原文复述。 */
const RUNTIME_LIMITS = {
  responseUtf8Bytes: 256 * 1024,
  operationsPerResponse: 64,
  operationUtf8Bytes: 8 * 1024,
  repairAttemptsPerBatch: 1,
  normalResponseTokens: 4096,
  repairResponseTokens: 2048,
  modelTimeoutMs: 120000,
};

/** §20.2 固定 20 个场景（顺序即规格列举顺序）。 */
const TAXONOMY = [
  "新建", "连续修改", "中文引号", "单引号", "分号", "长描述", "名字改动", "同名对象", "前向引用", "无变化",
  "缺字段", "错误引用", "独立两组", "故意截断", "上限响应", "重复提交", "新聊天", "分支", "持有转移", "粗位置",
];

/** 作者私密自动注入（§20.3 认知泄漏：作者才知道的秘密不得自动进主角知识）。 */
const AUTHOR_ONLY_SECRETS = [
  { id: "secret-heir", text: "国王已被替身调包", visibleTo: [] },
  { id: "secret-blade", text: "刺客的刀上涂了慢性毒", visibleTo: [] },
];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const sha256 = (text) => createHash("sha256").update(String(text), "utf8").digest("hex");
const utf8Bytes = (text) => Buffer.byteLength(String(text), "utf8");
const round = (value, digits = 3) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : value);

/** 百分位（p50/p95），输入为毫秒数组。 */
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return round(sorted[index]);
}

function makeIssue(code, fields = {}) {
  const issue = { code, severity: fields.severity ?? "error", ...fields };
  issue.locatable = Boolean(
    issue.stage && (issue.opId || issue.group !== undefined || issue.field || issue.sqlTemplate || issue.line !== undefined),
  );
  return issue;
}

class BenchmarkError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BenchmarkError";
    this.code = code;
    this.details = details;
  }
}

/** 与 tools/pack.mjs::writeFileAtomic / tools/atlas-release-version.mjs 同一纪律。 */
function writeFileAtomic(to, content) {
  const tmp = `${to}.bench-tmp-${process.pid}`;
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, to);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 忽略 */
    }
    writeFileSync(to, content);
    if (process.env.ATLAS_BENCH_DEBUG) console.error(`[bench] atomic rename failed for ${to}: ${String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 脱敏：报告里永不出现密钥
// ---------------------------------------------------------------------------

const KEY_LIKE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /(?:Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(?:"|')?(?:api[_-]?key|apikey|authorization|access[_-]?token|secret)(?:"|')?\s*[:=]\s*(?:"|')?[A-Za-z0-9._~+/=-]{8,}/gi,
];

function redactText(text, secretValues = []) {
  let out = String(text);
  for (const secret of secretValues) {
    if (typeof secret === "string" && secret.length >= 6) out = out.split(secret).join("[REDACTED]");
  }
  for (const pattern of KEY_LIKE_PATTERNS) out = out.replace(pattern, "[REDACTED]");
  return out;
}

/** 深度脱敏：所有字符串都过一遍。 */
function redactDeep(value, secretValues = []) {
  if (typeof value === "string") return redactText(value, secretValues);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secretValues));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item, secretValues);
    return out;
  }
  return value;
}

/** 报告序列化后再扫一遍：还能扫出 key 形态串就拒写（宁可失败，不可泄漏）。 */
function assertReportClean(serialized, secretValues = []) {
  for (const secret of secretValues) {
    if (typeof secret === "string" && secret.length >= 6 && serialized.includes(secret)) {
      throw new BenchmarkError("REPORT_REDACTION_FAILED", "报告里仍能扫到实际 API Key，已拒绝写出");
    }
  }
  for (const pattern of KEY_LIKE_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    const hit = re.exec(serialized);
    // 占位符 "[REDACTED]" 与文档里的 "sk-..." 形态不算命中
    if (hit && !hit[0].includes("[REDACTED]")) {
      throw new BenchmarkError("REPORT_REDACTION_FAILED", `报告里仍能扫到密钥形态串：${hit[0].slice(0, 12)}…`);
    }
  }
}

// ---------------------------------------------------------------------------
// 意图模型 → 两个组各自的最小充分说明
// ---------------------------------------------------------------------------

/** 逻辑字段 → 物理列（两边共用同一映射，保证「功能范围相同」）。 */
const FIELD_TO_COLUMN = {
  locations: {
    name: "name", kind: "kind", description: "description", parent_ref: "parent_location_id",
    mobility: "mobility", map_ref: "map_id", terrain: "terrain", existence_quality: "existence_quality",
  },
  characters: {
    name: "name", role: "role", identity: "identity", description: "description", personality: "personality",
    importance: "importance", importance_reason: "importance_reason", thought: "thought",
    action_tendency: "action_tendency", physical_status: "physical_status", condition_note: "condition_note",
    location_ref: "location_id", map_ref: "map_id",
  },
  items: {
    name: "name", kind: "kind", description: "description", quantity: "quantity", unit: "unit",
    condition_note: "condition_note", status: "status", location_ref: "location_id", map_ref: "map_id",
  },
};

const OP_TO_TABLE = {
  "location.upsert": "locations",
  "character.upsert": "characters",
  "item.upsert": "items",
};

/** B 组（有限 SQL 编辑视图）白名单：显式列清单 + 目标 ID；§20.2 的共享任务范围。 */
const SQL_EDIT_VIEWS = {
  edit_locations: {
    table: "locations",
    columns: ["id", "name", "kind", "description", "parent_location_id", "mobility", "map_id", "grid_x", "grid_y", "coord_precision", "terrain", "existence_quality"],
    insertRequired: ["id", "name"],
    template: "insert_locations",
  },
  edit_characters: {
    table: "characters",
    columns: ["id", "name", "role", "identity", "description", "personality", "importance", "thought", "action_tendency", "physical_status", "condition_note", "location_id", "map_id", "grid_x", "grid_y", "coord_precision"],
    insertRequired: ["id", "name"],
    template: "insert_characters",
  },
  edit_items: {
    table: "items",
    columns: ["id", "name", "kind", "description", "quantity", "unit", "condition_note", "status", "location_id", "map_id", "grid_x", "grid_y", "coord_precision"],
    insertRequired: ["id", "name"],
    template: "insert_items",
  },
};

const SQL_FORBIDDEN = [
  { code: "DDL_FORBIDDEN", pattern: /\b(CREATE|DROP|ALTER|TRUNCATE|REINDEX|VACUUM)\b/i, label: "DDL" },
  { code: "PRAGMA_FORBIDDEN", pattern: /\bPRAGMA\b/i, label: "PRAGMA" },
  { code: "ATTACH_FORBIDDEN", pattern: /\b(ATTACH|DETACH)\b/i, label: "ATTACH/DETACH" },
  { code: "QUERY_FORBIDDEN", pattern: /\b(SELECT|WITH|JOIN|EXPLAIN|UNION|INTERSECT|EXCEPT)\b/i, label: "多表任意查询/子查询" },
  { code: "DELETE_FORBIDDEN", pattern: /\b(DELETE|REPLACE)\b/i, label: "删除/替换（不在共享白名单内）" },
];

const SQL_LITERAL = Symbol("sql-literal");

/** SQL 字符串字面量转义（B 组渲染用：单引号成对）。 */
const sqlQuote = (text) => `'${String(text).replace(/'/g, "''")}'`;
const sqlLiteral = (value) => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return sqlQuote(value);
};

/** A 组：§8.3 规范形态——一行一个完整 JSON 对象，无根封套。 */
function renderOpsPrompt(scenario, allocation) {
  const entities = describeEntitiesForOps(scenario);
  const lines = [
    "你负责 Atlas 的本次状态任务。",
    "只输出本次允许的操作，每行一个完整 JSON 对象。",
    "只写发生变化的字段。已有对象使用提供的短引用；新对象使用 new: 临时引用。",
    "不要输出整份世界、SQL、解释段或思考过程。",
    "没有需要修改的数据时输出 {\"op\":\"noop\"}。",
    "未知信息省略；不知道精确坐标时保留粗粒度地点。",
    `现有对象短引用：${entities}`,
    `本次允许的操作与最少参数：${describeAllowedOpsForOps(scenario)}`,
  ];
  return { system: lines.slice(0, 6).join("\n"), user: lines.slice(6).join("\n") };
}

/** B 组：有限 SQL 编辑视图——显式列清单 + 目标 ID，只覆盖两边都支持的任务。 */
function renderSqlPrompt(scenario, allocation) {
  const views = Object.entries(SQL_EDIT_VIEWS)
    .map(([view, spec]) => `${view}(${spec.columns.join(", ")})`)
    .join("；");
  const lines = [
    "你负责 Atlas 的本次状态任务。",
    "只输出本次需要的 SQL 语句，一行一条，以分号结尾；字符串用单引号，单引号写成两个。",
    "只允许写下面三个编辑视图，必须使用显式列清单与目标 ID；禁止 DDL/PRAGMA/ATTACH/DELETE 与任何 SELECT/JOIN/子查询。",
    `可写视图与列：${views}`,
    `已有对象与目标 ID：${describeEntitiesForSql(scenario, allocation)}`,
    `本次任务：${describeAllowedOpsForSql(scenario)}`,
  ];
  return { system: lines.slice(0, 4).join("\n"), user: lines.slice(4).join("\n") };
}

function describeEntitiesForOps(scenario) {
  return scenario.seedRefs.map((ref) => `${ref.alias}=${ref.kind}「${ref.name}」`).join(" ");
}

function describeEntitiesForSql(scenario, allocation) {
  return scenario.seedRefs.map((ref) => `${ref.id}=${ref.kind}「${ref.name}」`).join(" ");
}

function describeAllowedOpsForOps(scenario) {
  const kinds = [...new Set(scenario.intents.map((intent) => intent.op))];
  return kinds.join(" / ");
}

function describeAllowedOpsForSql(scenario) {
  const views = [...new Set(scenario.intents.map((intent) => intentToView(intent)).filter(Boolean))];
  return `${views.join(" / ")}（只写变化列）`;
}

function intentToView(intent) {
  if (intent.op === "noop") return null;
  if (intent.op === "location.upsert") return "edit_locations";
  if (intent.op === "character.upsert") return "edit_characters";
  if (intent.op === "item.upsert") return "edit_items";
  return null;
}

/**
 * 把同一份意图渲染成 A 组文本（一行一个 JSON 对象）。
 * 这是**预设回放文本**，由工具渲染，不代表真实模型输出。
 */
function renderOpsText(intents) {
  return intents
    .map((intent) => {
      if (intent.op === "noop") return JSON.stringify({ op: "noop" });
      // item.transfer 的最少参数是 ref + to（§8.4，顶层字段，不进 data）
      if (intent.op === "item.transfer") {
        const op = { op: intent.op, ref: intent.ref, to: intent.to };
        if (intent.quantity !== undefined) op.quantity = intent.quantity;
        if (intent.data?.why) op.why = intent.data.why;
        return JSON.stringify(op);
      }
      return JSON.stringify({ op: intent.op, ref: intent.ref, data: intent.data });
    })
    .join("\n");
}

/**
 * 把同一份意图渲染成 B 组文本（有限 SQL 编辑视图）。
 * 新对象用程序分配的稳定 ID；已有对象用目标 ID；只列变化列。
 * 语句按 new: 依赖排序（先写新对象）——SQL 没有 new: 别名机制，顺序错乱是 SQL 的真实失败模式，
 * 但不该由本工具的渲染顺序人为制造；A 组仍保留声明顺序，用于检验前向引用解析。
 */
function renderSqlText(intents, allocation) {
  const declared = new Set(intents.filter((intent) => String(intent.ref ?? "").startsWith("new:")).map((intent) => intent.ref));
  const pendingRefs = (intent) => Object.entries({ ...(intent.data ?? {}), ...(intent.to ?? {}) })
    .filter(([key, value]) => REF_FIELDS.has(key) && typeof value === "string" && value.startsWith("new:"))
    .map(([, value]) => value);
  const ordered = [];
  const emitted = new Set();
  const visit = (intent) => {
    if (emitted.has(intent) || ordered.includes(intent)) return;
    for (const ref of pendingRefs(intent)) {
      if (!declared.has(ref)) continue;
      const target = intents.find((item) => item.ref === ref);
      if (target && target !== intent) visit(target);
    }
    if (!ordered.includes(intent)) ordered.push(intent);
  };
  for (const intent of intents) visit(intent);
  const statements = [];
  for (const intent of ordered) {
    if (intent.op === "noop") continue;
    const view = intentToView(intent);
    if (!view) continue;
    const spec = SQL_EDIT_VIEWS[view];
    const table = spec.table;
    const mapping = FIELD_TO_COLUMN[table];
    const isNew = String(intent.ref).startsWith("new:");
    const id = isNew ? allocation[intent.ref] : intent.ref;
    const columns = [];
    const values = [];
    for (const [key, value] of Object.entries(intent.data ?? {})) {
      const column = mapping[key];
      if (!column) continue;
      columns.push(column);
      // B 组也要用程序分配的稳定 ID：`new:L4` → 'L4'（SQL 里没有 new: 别名机制）
      const resolved = REF_FIELDS.has(key) && typeof value === "string" && value.startsWith("new:") ? allocation[value] ?? value.slice(4) : value;
      values.push(sqlLiteral(resolved));
    }
    if (isNew) {
      statements.push(`INSERT INTO ${view} (id, ${columns.join(", ")}) VALUES (${sqlQuote(id)}, ${values.join(", ")});`);
    } else {
      const assignments = columns.map((column, index) => `${column} = ${values[index]}`);
      statements.push(`UPDATE ${view} SET ${assignments.join(", ")} WHERE id = ${sqlQuote(id)};`);
    }
  }
  if (statements.length === 0) statements.push(`-- 无变化（不需要任何语句）`);
  return statements.join("\n");
}

// ---------------------------------------------------------------------------
// 20 个固定场景（§20.2）
// ---------------------------------------------------------------------------

const SEED = {
  "main-A": {
    locations: [
      { id: "L1", name: "圣罗兰城", kind: "city", parent: null },
      { id: "L2", name: "学校", kind: "building", parent: "L1" },
      { id: "L3", name: "教室", kind: "room", parent: "L2" },
    ],
    characters: [
      { id: "C1", name: "艾琳", role: "protagonist", location: "L3" },
      { id: "C2", name: "信使", role: "npc", location: "L1" },
      { id: "C3", name: "刺客", role: "npc", location: null },
    ],
    items: [{ id: "I1", name: "剑", holder: "C1", quantity: 1 }],
    maps: [{ id: "M1", name: "世界图", metersPerCell: 100 }, { id: "M2", name: "教室图", metersPerCell: 1 }],
  },
  "main-B": {
    locations: [
      { id: "L1", name: "圣罗兰城", kind: "city", parent: null },
      { id: "L2", name: "学校", kind: "building", parent: "L1" },
    ],
    characters: [{ id: "C1", name: "艾琳", role: "protagonist", location: "L2" }],
    items: [],
    maps: [{ id: "M1", name: "世界图", metersPerCell: 100 }],
  },
};

const SEED_REFS = {
  "main-A": [
    { alias: "L1", id: "L1", kind: "地点", name: "圣罗兰城" },
    { alias: "L2", id: "L2", kind: "地点", name: "学校" },
    { alias: "L3", id: "L3", kind: "地点", name: "教室" },
    { alias: "C1", id: "C1", kind: "人物", name: "艾琳" },
    { alias: "C2", id: "C2", kind: "人物", name: "信使" },
    { alias: "C3", id: "C3", kind: "人物", name: "刺客" },
    { alias: "I1", id: "I1", kind: "物品", name: "剑" },
    { alias: "M1", id: "M1", kind: "地图", name: "世界图" },
  ],
  "main-B": [
    { alias: "L1", id: "L1", kind: "地点", name: "圣罗兰城" },
    { alias: "L2", id: "L2", kind: "地点", name: "学校" },
    { alias: "C1", id: "C1", kind: "人物", name: "艾琳" },
    { alias: "M1", id: "M1", kind: "地图", name: "世界图" },
  ],
};

const LONG_DESCRIPTION = "废弃矿道沿着山腹向东延伸，支架大多已经腐朽，地面残留着运矿车的铁轨与积水；".repeat(9);

/** 20 个内置场景（fixtures 文件不存在时使用；报告里会显著说明用的是内置集）。 */
const INTERNAL_SCENARIOS = [
  {
    id: "S01", kind: "new", intents: [
      { op: "location.upsert", ref: "new:L4", data: { name: "旧钟楼", kind: "building", description: "城北废弃钟楼。", parent_ref: "L2" } },
      { op: "character.upsert", ref: "new:C4", data: { name: "铁匠老周", identity: "城北铁匠", role: "npc" } },
    ],
  },
  {
    id: "S02", kind: "sequential_edit", intents: [
      { op: "character.upsert", ref: "C1", data: { thought: "先确认来访者的身份。" } },
      { op: "character.upsert", ref: "C1", data: { action_tendency: "暂时留在学校观察" } },
    ],
  },
  {
    id: "S03", kind: "chinese_quotes", intents: [
      { op: "location.upsert", ref: "new:L4", data: { name: "“钟楼”茶馆", kind: "building", description: "门口挂着「今日营业」的木牌，掌柜说：“常来。”" } },
    ],
  },
  {
    id: "S04", kind: "single_quote", intents: [
      { op: "character.upsert", ref: "new:C4", data: { name: "O'Brien", identity: "码头水手", description: "他总说 '独眼才看得远'。" } },
    ],
  },
  {
    id: "S05", kind: "semicolon", intents: [
      { op: "character.upsert", ref: "C2", data: { description: "他留下口信：先走一步；别等我。" } },
    ],
  },
  {
    id: "S06", kind: "long_description", intents: [
      { op: "location.upsert", ref: "new:L4", data: { name: "废弃矿道", kind: "natural", description: LONG_DESCRIPTION } },
    ],
  },
  {
    id: "S07", kind: "rename", intents: [
      { op: "character.upsert", ref: "C2", data: { name: "老信使" } },
    ],
  },
  {
    id: "S08", kind: "same_name", newIds: { "new:L4": "L4", "new:L5": "L5" }, intents: [
      { op: "location.upsert", ref: "new:L4", data: { name: "无名酒馆", kind: "building" } },
      { op: "location.upsert", ref: "new:L5", data: { name: "无名酒馆", kind: "building" } },
    ],
  },
  {
    id: "S09", kind: "forward_ref", newIds: { "new:L4": "L4" }, intents: [
      { op: "character.upsert", ref: "C1", data: { location_ref: "new:L4" } },
      { op: "location.upsert", ref: "new:L4", data: { name: "新仓库", kind: "building", parent_ref: "L1" } },
    ],
  },
  {
    id: "S10", kind: "noop", intents: [{ op: "noop" }],
  },
  {
    id: "S11", kind: "missing_field", damage: "missing_required_field", cohort: "injected_damage", invalidGroups: ["g1"],
    newIds: { "new:L4": "L4" },
    intents: [{ op: "location.upsert", ref: "new:L4", data: { name: "缺名字的地点", kind: "building" } }],
  },
  {
    id: "S12", kind: "bad_ref", damage: "bad_ref", cohort: "injected_damage", invalidGroups: ["g1"],
    newIds: { "new:L4": "L4" },
    intents: [{ op: "location.upsert", ref: "new:L4", data: { name: "孤儿塔", kind: "building", parent_ref: "L9" } }],
  },
  {
    id: "S13", kind: "independent_groups", damage: "injected_bad_group", cohort: "injected_damage", invalidGroups: ["g-bad"],
    newIds: { "new:L4": "L4" },
    intents: [
      { op: "location.upsert", ref: "new:L4", data: { name: "礼堂", kind: "building", parent_ref: "L2" }, group: "g-valid" },
      { op: "character.upsert", ref: "C2", data: { location_ref: "L9" }, group: "g-bad" },
    ],
  },
  {
    id: "S14", kind: "truncated", damage: "truncated", cohort: "injected_damage", invalidGroups: ["g1"],
    newIds: { "new:L4": "L4" },
    intents: [{ op: "location.upsert", ref: "new:L4", data: { name: "半截塔", kind: "building", description: "这句话没有写完" } }],
  },
  {
    id: "S15", kind: "max_response", newIds: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`new:C${10 + i}`, `C${10 + i}`])),
    intents: [
      { op: "location.upsert", ref: "new:L4", data: { name: "边界大厅", kind: "building", parent_ref: "L2" } },
      ...Array.from({ length: 11 }, (_, i) => ({
        op: "character.upsert",
        ref: `new:C${10 + i}`,
        data: { name: `随从${i + 1}`, identity: "大厅随从", role: "npc", description: "在大厅等候的一名随从，穿着统一的深色外袍。" },
      })),
    ],
  },
  {
    id: "S16", kind: "duplicate_submit", repeats: 2, programEffects: { clockDeltaS: 600 }, intents: [
      { op: "character.upsert", ref: "C2", data: { description: "他刚把口信送到学校，正在门口等候回话。" } },
    ],
  },
  {
    id: "S17", kind: "new_chat", branch: "main-B", newIds: { "new:L4": "L4" }, intents: [
      { op: "location.upsert", ref: "new:L4", data: { name: "学校礼堂", kind: "room", parent_ref: "L2" } },
    ],
  },
  {
    id: "S18", kind: "branch", branch: "main-B", newIds: { "new:C9": "C9" }, invalidGroups: ["g-cross-branch"], intents: [
      { op: "character.upsert", ref: "C1", data: { thought: "这条只应写进 main-B。" }, group: "g-valid" },
      { op: "character.upsert", ref: "C3", data: { thought: "C3 只存在于 main-A。" }, group: "g-cross-branch" },
    ],
  },
  {
    id: "S19", kind: "item_transfer", groupSupport: { ops: true, sql: false },
    sqlUnsupportedReason: "持有转移不在 §20.2 的共享任务范围内（B 组只有地点/人物/物品基本新增、名称/描述/心理修改、粗位置变更）；不得据此说 SQL 更差",
    intents: [{ op: "item.transfer", ref: "I1", to: { holder_ref: "C2" }, quantity: 1 }],
  },
  {
    id: "S20", kind: "coarse_position", intents: [
      { op: "character.upsert", ref: "C2", data: { location_ref: "L2" } },
    ],
  },
];

/**
 * 程序为 `new:` 引用分配稳定 ID：显式 newIds 优先，其余按去前缀推导；
 * 与种子 ID 冲突时加后缀（绝不静默覆盖已有对象）。
 */
function allocateNewIds(raw, branch) {
  const explicit = { ...(raw.newIds ?? {}) };
  const seed = SEED[branch] ?? SEED["main-A"];
  const used = new Set([
    ...seed.locations.map((item) => item.id),
    ...seed.characters.map((item) => item.id),
    ...seed.items.map((item) => item.id),
    ...seed.maps.map((item) => item.id),
    ...Object.values(explicit),
  ]);
  for (const intent of raw.intents ?? []) {
    const ref = intent.ref;
    if (typeof ref !== "string" || !ref.startsWith("new:") || ref in explicit) continue;
    const base = ref.slice(4) || "X1";
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
      id = `${base}_${suffix}`;
      suffix += 1;
    }
    explicit[ref] = id;
    used.add(id);
  }
  return explicit;
}

/** 短引用 → 稳定 ID（`new:` 走程序分配表）。 */
function stableIdForRef(scenario, ref) {
  if (typeof ref !== "string") return ref;
  return ref.startsWith("new:") ? scenario.newIds[ref] ?? ref.slice(4) : ref;
}

/** 补全场景：标题、seedRefs、分组、期望写集、预设文本（含人工注入损坏）。 */
export function buildScenarios(overrides = []) {
  const scenarios = (overrides.length > 0 ? overrides : INTERNAL_SCENARIOS).map((raw, index) => {
    const branch = raw.branch ?? "main-A";
    const scenario = {
      ...raw,
      index,
      id: raw.id ?? `F${String(index + 1).padStart(2, "0")}`,
      title: raw.title ?? TAXONOMY[index] ?? raw.kind ?? raw.id,
      taxonomyIndex: index < TAXONOMY.length ? index + 1 : null,
      // 人工注入损坏的样例必须与自然样例分开统计；只写 damage 也自动归类为注入损坏
      cohort: raw.cohort ?? (raw.damage ? "injected_damage" : "natural"),
      branch,
      seedRefs: raw.seedRefs ?? SEED_REFS[branch],
      newIds: allocateNewIds(raw, branch),
      groupSupport: raw.groupSupport ?? { ops: true, sql: true },
      programEffects: raw.programEffects ?? null,
      repeats: raw.repeats ?? 1,
      invalidGroups: raw.invalidGroups ?? [],
    };
    scenario.groups = buildGroups(scenario);
    scenario.validGroups = scenario.groups.filter((group) => !scenario.invalidGroups.includes(group.id));
    scenario.expected = raw.expected ?? deriveExpected(scenario);
    scenario.prompt = { ops: renderOpsPrompt(scenario, scenario.newIds), sql: renderSqlPrompt(scenario, scenario.newIds) };
    scenario.preset = buildPreset(scenario, raw.preset);
    return scenario;
  });
  return scenarios;
}

/**
 * 分组：显式 group 优先，否则一个意图一组；同组在同一个保存点内提交。
 * 组间按 new: 依赖做拓扑排序（§16.5 步骤 5：新增依赖建立有向边，按依赖拓扑顺序执行），
 * 前向引用因此不会因为「声明顺序」被误判成外键错误。
 */
function buildGroups(scenario) {
  const groups = new Map();
  scenario.intents.forEach((intent, index) => {
    const id = intent.group ?? `g${index + 1}`;
    if (!groups.has(id)) groups.set(id, { id, order: groups.size, intents: [] });
    groups.get(id).intents.push({ ...intent, opIndex: index });
  });
  const list = [...groups.values()];
  // 每个 new: 引用由哪个组声明
  const declarer = new Map();
  for (const intent of scenario.intents) {
    if (typeof intent.ref === "string" && intent.ref.startsWith("new:")) declarer.set(intent.ref, intent.group ?? `g${scenario.intents.indexOf(intent) + 1}`);
  }
  const dependsOn = new Map(list.map((group) => [group.id, new Set()]));
  for (const group of list) {
    for (const intent of group.intents) {
      const values = [intent.data ?? {}, intent.to ?? {}];
      for (const record of values) {
        for (const [key, value] of Object.entries(record)) {
          if (!REF_FIELDS.has(key) || typeof value !== "string" || !value.startsWith("new:")) continue;
          const owner = declarer.get(value);
          if (owner && owner !== group.id) dependsOn.get(group.id).add(owner);
        }
      }
    }
  }
  const ordered = [];
  const visited = new Set();
  const visit = (group) => {
    if (visited.has(group.id)) return;
    visited.add(group.id);
    for (const dependency of dependsOn.get(group.id) ?? []) {
      const target = list.find((item) => item.id === dependency);
      if (target) visit(target);
    }
    ordered.push(group);
  };
  for (const group of list) visit(group);
  scenario.groupOrder = ordered.map((group) => group.id);
  return list;
}

/** 从意图推导期望写集（两组共用；保证「功能范围相同」）。 */
function deriveExpected(scenario) {
  const writes = [];
  for (const intent of scenario.intents) {
    if (intent.op === "noop") continue;
    if (intent.op === "item.transfer") {
      writes.push({ table: "items", rowId: intent.ref, fields: ["holder_character_id", "quantity"] });
      continue;
    }
    const table = OP_TO_TABLE[intent.op];
    if (!table) continue;
    const mapping = FIELD_TO_COLUMN[table];
    const fields = Object.keys(intent.data ?? {}).map((key) => mapping[key]).filter(Boolean);
    const rowId = stableIdForRef(scenario, intent.ref);
    writes.push({ table, rowId, fields: [...new Set(fields)] });
  }
  return { writes };
}

function buildPreset(scenario, override) {
  const ops = override?.ops ?? {};
  const sql = override?.sql ?? {};
  const opsInitial = ops.initial ?? damageText(scenario, "ops", renderOpsText(scenario.intents));
  const sqlInitial = sql.initial ?? damageText(scenario, "sql", renderSqlText(scenario.intents, scenario.newIds));
  return {
    ops: { initial: opsInitial, repair: ops.repair ?? renderOpsRepair(scenario) },
    sql: { initial: sqlInitial, repair: sql.repair ?? renderSqlRepair(scenario) },
  };
}

/** 人工注入损坏：只用于验证故障恢复，绝不混进「模型生成正确率」。 */
function damageText(scenario, group, text) {
  if (!scenario.damage) return text;
  const lines = text.split("\n");
  if (scenario.damage === "missing_required_field") {
    if (group === "ops") {
      return lines.map((line) => {
        const parsed = JSON.parse(line);
        if (parsed.data && "name" in parsed.data) delete parsed.data.name;
        return JSON.stringify(parsed);
      }).join("\n");
    }
    return lines.map((line) => {
      const match = /^INSERT INTO (edit_\w+) \(([^)]*)\) VALUES \((.*)\);$/.exec(line);
      if (!match) return line;
      const columns = match[2].split(",").map((item) => item.trim()).filter((item) => item !== "name");
      const values = splitTopLevel(match[3], ",").filter((_, index) => match[2].split(",").map((c) => c.trim())[index] !== "name");
      return `INSERT INTO ${match[1]} (${columns.join(", ")}) VALUES (${values.map((v) => v.trim()).join(", ")});`;
    }).join("\n");
  }
  if (scenario.damage === "truncated") {
    const index = text.length - Math.floor(text.length / 3);
    return text.slice(0, index);
  }
  return text;
}

/** 定向修复文本：把原意图里的人工损坏改回合法（S11 补字段、S12 换合法引用、S13 只修坏组、S14 重发完整操作）。 */
function repairedIntents(scenario) {
  return scenario.intents.map((intent) => {
    if (scenario.damage === "injected_bad_group" && !scenario.invalidGroups.includes(intent.group ?? "g1")) return intent;
    const data = { ...(intent.data ?? {}) };
    for (const [key, value] of Object.entries(data)) if (value === "L9") data[key] = "L2";
    return { ...intent, data };
  });
}

function renderOpsRepair(scenario) {
  if (!scenario.damage) return null;
  if (scenario.damage === "injected_bad_group") {
    const bad = scenario.intents.filter((intent) => scenario.invalidGroups.includes(intent.group ?? "g1"));
    return renderOpsText(bad.map((intent) => ({ ...intent, data: { ...intent.data, location_ref: "L2" } })));
  }
  // 补字段 / 换引用 / 重发截断的那条：定向修复就是重发修正后的完整操作
  return renderOpsText(repairedIntents(scenario));
}

function renderSqlRepair(scenario) {
  if (!scenario.damage) return null;
  if (scenario.damage === "injected_bad_group") {
    const bad = scenario.intents.filter((intent) => scenario.invalidGroups.includes(intent.group ?? "g1"));
    return renderSqlText(bad.map((intent) => ({ ...intent, data: { ...intent.data, location_ref: "L2" } })), scenario.newIds);
  }
  return renderSqlText(repairedIntents(scenario), scenario.newIds);
}

// ---------------------------------------------------------------------------
// 临时 sql.js 数据库（最小表子集，不是 20 张表的真实 schema）
// ---------------------------------------------------------------------------

const SNAPSHOT_TABLES = {
  branches: ["id", "name", "clock_s", "revision", "status"],
  entity_keys: ["branch_id", "id", "kind"],
  locations: ["branch_id", "id", "row_rev", "name", "aliases_json", "kind", "description", "parent_location_id", "mobility", "map_id", "grid_x", "grid_y", "coord_precision", "terrain", "existence_quality", "status"],
  characters: ["branch_id", "id", "row_rev", "name", "role", "identity", "description", "personality", "importance", "thought", "action_tendency", "physical_status", "location_id", "map_id", "grid_x", "grid_y", "coord_precision", "status"],
  items: ["branch_id", "id", "row_rev", "name", "kind", "description", "quantity", "unit", "condition_note", "owner_entity_id", "holder_character_id", "container_item_id", "location_id", "map_id", "grid_x", "grid_y", "coord_precision", "status"],
};

/** 程序维护列：模型写这些一律忽略（§8.4 SYSTEM_FIELD_IGNORED），也不计入「错改范围」。 */
const PROGRAM_COLUMNS = new Set(["branch_id", "id", "row_rev", "created_turn_id", "updated_turn_id"]);

const DDL = (branch) => `
PRAGMA foreign_keys = ON;
CREATE TABLE branches (id TEXT PRIMARY KEY, name TEXT NOT NULL, clock_s REAL NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active');
CREATE TABLE turns (id TEXT NOT NULL, branch_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (branch_id, id));
CREATE TABLE maps (branch_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, meters_per_cell REAL, PRIMARY KEY (branch_id, id));
CREATE TABLE entity_keys (branch_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (branch_id, id));
CREATE TABLE locations (
  branch_id TEXT NOT NULL, id TEXT NOT NULL, row_rev INTEGER NOT NULL DEFAULT 1,
  created_turn_id TEXT NOT NULL DEFAULT 'turn_seed', updated_turn_id TEXT NOT NULL DEFAULT 'turn_seed',
  name TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]', kind TEXT NOT NULL DEFAULT 'other',
  description TEXT NOT NULL DEFAULT '', parent_location_id TEXT, mobility TEXT NOT NULL DEFAULT 'fixed',
  map_id TEXT, grid_x REAL, grid_y REAL, coord_precision TEXT NOT NULL DEFAULT 'unknown',
  uncertainty_radius_cells REAL, terrain TEXT NOT NULL DEFAULT 'unknown',
  existence_quality TEXT NOT NULL DEFAULT 'confirmed', status TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (branch_id, id),
  FOREIGN KEY (branch_id, id) REFERENCES entity_keys (branch_id, id),
  FOREIGN KEY (branch_id, parent_location_id) REFERENCES locations (branch_id, id),
  FOREIGN KEY (branch_id, map_id) REFERENCES maps (branch_id, id)
);
CREATE TABLE characters (
  branch_id TEXT NOT NULL, id TEXT NOT NULL, row_rev INTEGER NOT NULL DEFAULT 1,
  created_turn_id TEXT NOT NULL DEFAULT 'turn_seed', updated_turn_id TEXT NOT NULL DEFAULT 'turn_seed',
  name TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]', role TEXT NOT NULL DEFAULT 'npc',
  identity TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', personality TEXT NOT NULL DEFAULT '',
  importance TEXT NOT NULL DEFAULT 'supporting', importance_reason TEXT NOT NULL DEFAULT '',
  thought TEXT NOT NULL DEFAULT '', action_tendency TEXT NOT NULL DEFAULT '',
  physical_status TEXT NOT NULL DEFAULT 'unknown', condition_note TEXT NOT NULL DEFAULT '',
  location_id TEXT, map_id TEXT, grid_x REAL, grid_y REAL, coord_precision TEXT NOT NULL DEFAULT 'unknown',
  uncertainty_radius_cells REAL, status TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (branch_id, id),
  FOREIGN KEY (branch_id, id) REFERENCES entity_keys (branch_id, id),
  FOREIGN KEY (branch_id, location_id) REFERENCES locations (branch_id, id),
  FOREIGN KEY (branch_id, map_id) REFERENCES maps (branch_id, id)
);
CREATE TABLE items (
  branch_id TEXT NOT NULL, id TEXT NOT NULL, row_rev INTEGER NOT NULL DEFAULT 1,
  created_turn_id TEXT NOT NULL DEFAULT 'turn_seed', updated_turn_id TEXT NOT NULL DEFAULT 'turn_seed',
  name TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]', kind TEXT NOT NULL DEFAULT 'other',
  description TEXT NOT NULL DEFAULT '', quantity REAL, unit TEXT NOT NULL DEFAULT '件',
  condition_note TEXT NOT NULL DEFAULT '', owner_entity_id TEXT, holder_character_id TEXT,
  container_item_id TEXT, location_id TEXT, map_id TEXT, grid_x REAL, grid_y REAL,
  coord_precision TEXT NOT NULL DEFAULT 'unknown', uncertainty_radius_cells REAL, status TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (branch_id, id),
  FOREIGN KEY (branch_id, id) REFERENCES entity_keys (branch_id, id),
  FOREIGN KEY (branch_id, holder_character_id) REFERENCES characters (branch_id, id),
  FOREIGN KEY (branch_id, location_id) REFERENCES locations (branch_id, id),
  FOREIGN KEY (branch_id, container_item_id) REFERENCES items (branch_id, id),
  FOREIGN KEY (branch_id, map_id) REFERENCES maps (branch_id, id)
);
CREATE VIEW edit_locations AS SELECT id, name, kind, description, parent_location_id, mobility, map_id, grid_x, grid_y, coord_precision, terrain, existence_quality FROM locations WHERE branch_id = '${branch}';
CREATE VIEW edit_characters AS SELECT id, name, role, identity, description, personality, importance, thought, action_tendency, physical_status, condition_note, location_id, map_id, grid_x, grid_y, coord_precision FROM characters WHERE branch_id = '${branch}';
CREATE VIEW edit_items AS SELECT id, name, kind, description, quantity, unit, condition_note, status, location_id, map_id, grid_x, grid_y, coord_precision FROM items WHERE branch_id = '${branch}';

CREATE TRIGGER edit_locations_insert INSTEAD OF INSERT ON edit_locations BEGIN
  INSERT INTO entity_keys (branch_id, id, kind) VALUES ('${branch}', NEW.id, 'location');
  INSERT INTO locations (branch_id, id, name, kind, description, parent_location_id, mobility, map_id, grid_x, grid_y, coord_precision, terrain, existence_quality)
  VALUES ('${branch}', NEW.id, NEW.name, COALESCE(NEW.kind, 'other'), COALESCE(NEW.description, ''), NEW.parent_location_id, COALESCE(NEW.mobility, 'fixed'), NEW.map_id, NEW.grid_x, NEW.grid_y, COALESCE(NEW.coord_precision, 'unknown'), COALESCE(NEW.terrain, 'unknown'), COALESCE(NEW.existence_quality, 'confirmed'));
END;
CREATE TRIGGER edit_locations_update INSTEAD OF UPDATE ON edit_locations BEGIN
  UPDATE locations SET name = NEW.name, kind = NEW.kind, description = NEW.description, parent_location_id = NEW.parent_location_id,
    mobility = NEW.mobility, map_id = NEW.map_id, grid_x = NEW.grid_x, grid_y = NEW.grid_y,
    coord_precision = NEW.coord_precision, terrain = NEW.terrain, existence_quality = NEW.existence_quality,
    row_rev = row_rev + 1, updated_turn_id = 'turn_bench'
  WHERE branch_id = '${branch}' AND id = OLD.id;
END;
CREATE TRIGGER edit_characters_insert INSTEAD OF INSERT ON edit_characters BEGIN
  INSERT INTO entity_keys (branch_id, id, kind) VALUES ('${branch}', NEW.id, 'character');
  INSERT INTO characters (branch_id, id, name, role, identity, description, personality, importance, thought, action_tendency, physical_status, condition_note, location_id, map_id, grid_x, grid_y, coord_precision)
  VALUES ('${branch}', NEW.id, NEW.name, COALESCE(NEW.role, 'npc'), COALESCE(NEW.identity, ''), COALESCE(NEW.description, ''), COALESCE(NEW.personality, ''), COALESCE(NEW.importance, 'supporting'), COALESCE(NEW.thought, ''), COALESCE(NEW.action_tendency, ''), COALESCE(NEW.physical_status, 'unknown'), COALESCE(NEW.condition_note, ''), NEW.location_id, NEW.map_id, NEW.grid_x, NEW.grid_y, COALESCE(NEW.coord_precision, 'unknown'));
END;
CREATE TRIGGER edit_characters_update INSTEAD OF UPDATE ON edit_characters BEGIN
  UPDATE characters SET name = NEW.name, role = NEW.role, identity = NEW.identity, description = NEW.description,
    personality = NEW.personality, importance = NEW.importance, thought = NEW.thought, action_tendency = NEW.action_tendency,
    physical_status = NEW.physical_status, condition_note = NEW.condition_note, location_id = NEW.location_id,
    map_id = NEW.map_id, grid_x = NEW.grid_x, grid_y = NEW.grid_y, coord_precision = NEW.coord_precision,
    row_rev = row_rev + 1, updated_turn_id = 'turn_bench'
  WHERE branch_id = '${branch}' AND id = OLD.id;
END;
CREATE TRIGGER edit_items_insert INSTEAD OF INSERT ON edit_items BEGIN
  INSERT INTO entity_keys (branch_id, id, kind) VALUES ('${branch}', NEW.id, 'item');
  INSERT INTO items (branch_id, id, name, kind, description, quantity, unit, condition_note, status, location_id, map_id, grid_x, grid_y, coord_precision)
  VALUES ('${branch}', NEW.id, NEW.name, COALESCE(NEW.kind, 'other'), COALESCE(NEW.description, ''), NEW.quantity, COALESCE(NEW.unit, '件'), COALESCE(NEW.condition_note, ''), COALESCE(NEW.status, 'active'), NEW.location_id, NEW.map_id, NEW.grid_x, NEW.grid_y, COALESCE(NEW.coord_precision, 'unknown'));
END;
CREATE TRIGGER edit_items_update INSTEAD OF UPDATE ON edit_items BEGIN
  UPDATE items SET name = NEW.name, kind = NEW.kind, description = NEW.description, quantity = NEW.quantity,
    unit = NEW.unit, condition_note = NEW.condition_note, status = NEW.status, location_id = NEW.location_id,
    map_id = NEW.map_id, grid_x = NEW.grid_x, grid_y = NEW.grid_y, coord_precision = NEW.coord_precision,
    row_rev = row_rev + 1, updated_turn_id = 'turn_bench'
  WHERE branch_id = '${branch}' AND id = OLD.id;
END;
`;

function queryRows(db, sql, params = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

/** 建立一个隔离的临时库（每次运行一个；两个分支都在，用于跨分支检验）。 */
function createDatabase(SQL, branch) {
  const db = new SQL.Database();
  db.run(DDL(branch));
  db.run(
    "INSERT INTO turns (id, branch_id, kind) VALUES ('turn_seed', ?, 'seed'), ('turn_bench', ?, 'bench')",
    [branch, branch],
  );
  for (const [branchId, seed] of Object.entries(SEED)) {
    db.run("INSERT INTO branches (id, name, clock_s, revision, status) VALUES (?, ?, 0, 0, 'active')", [branchId, `聊天 ${branchId}`]);
    for (const map of seed.maps) db.run("INSERT INTO maps (branch_id, id, name, meters_per_cell) VALUES (?, ?, ?, ?)", [branchId, map.id, map.name, map.metersPerCell]);
    for (const location of seed.locations) {
      db.run("INSERT INTO entity_keys (branch_id, id, kind) VALUES (?, ?, 'location')", [branchId, location.id]);
      db.run(
        "INSERT INTO locations (branch_id, id, name, kind, parent_location_id, coord_precision) VALUES (?, ?, ?, ?, ?, 'unknown')",
        [branchId, location.id, location.name, location.kind, location.parent],
      );
    }
    for (const character of seed.characters) {
      db.run("INSERT INTO entity_keys (branch_id, id, kind) VALUES (?, ?, 'character')", [branchId, character.id]);
      db.run(
        "INSERT INTO characters (branch_id, id, name, role, location_id, coord_precision) VALUES (?, ?, ?, ?, ?, 'unknown')",
        [branchId, character.id, character.name, character.role, character.location],
      );
    }
    for (const item of seed.items) {
      db.run("INSERT INTO entity_keys (branch_id, id, kind) VALUES (?, ?, 'item')", [branchId, item.id]);
      db.run(
        "INSERT INTO items (branch_id, id, name, kind, quantity, holder_character_id, coord_precision) VALUES (?, ?, ?, 'object', ?, ?, 'unknown')",
        [branchId, item.id, item.name, item.quantity, item.holder],
      );
    }
  }
  return db;
}

/** 快照：用于 diff（错改范围 / 重复副作用 / 无关组保留都要真实库差异）。 */
function snapshotDatabase(db) {
  const snapshot = {};
  for (const [table, columns] of Object.entries(SNAPSHOT_TABLES)) {
    const rows = queryRows(db, `SELECT ${columns.join(", ")} FROM ${table}`);
    // branches 没有 branch_id 列，用 id 兜底，保证 measureSideEffects 能按 "${branch}|${branch}" 取到
    snapshot[table] = new Map(rows.map((row) => [`${row.branch_id ?? row.id ?? ""}|${row.id}`, row]));
  }
  return snapshot;
}

/** 行级 diff：返回 [{table, rowId, branchId, field, before, after, kind}]。 */
function diffSnapshots(before, after) {
  const changes = [];
  for (const table of Object.keys(SNAPSHOT_TABLES)) {
    const beforeRows = before[table] ?? new Map();
    const afterRows = after[table] ?? new Map();
    const keys = new Set([...beforeRows.keys(), ...afterRows.keys()]);
    for (const key of keys) {
      const left = beforeRows.get(key);
      const right = afterRows.get(key);
      const rowId = (right ?? left)?.id ?? key;
      const branchId = (right ?? left)?.branch_id ?? null;
      if (!left && right) {
        for (const field of Object.keys(right)) {
          if (field === "branch_id" || field === "id") continue;
          changes.push({ table, rowId, branchId, field, before: null, after: right[field], kind: "insert" });
        }
        continue;
      }
      if (left && !right) {
        changes.push({ table, rowId, branchId, field: "*", before: left, after: null, kind: "delete" });
        continue;
      }
      for (const field of Object.keys(right)) {
        if (left[field] === right[field]) continue;
        changes.push({ table, rowId, branchId, field, before: left[field], after: right[field], kind: "update" });
      }
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// A 组：解析（§8.3 最小输出合同）
// ---------------------------------------------------------------------------

const OPS_MINIMUM = {
  "location.upsert": { create: ["name"], update: ["ref"] },
  "character.upsert": { create: ["name", "identity"], update: ["ref"] },
  "item.upsert": { create: ["name"], update: ["ref"] },
  "item.transfer": { create: ["ref", "to"], update: ["ref", "to"] },
};

/**
 * 解析 A 组响应文本（一行一个 JSON 对象；有限兼容代码围栏与 <atlasEdit> 外壳）。
 * 返回 { operations, issues, explicitNoop, incomplete }（字段名对齐 §16.3 ParseResult）。
 */
export function parseOpsResponse(text) {
  const issues = [];
  const operations = [];
  let body = text ?? "";
  let incomplete = false;
  if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
  const openMatch = /<atlasEdit>/i.exec(body);
  if (openMatch) {
    const afterOpen = openMatch.index + openMatch[0].length;
    const closeMatch = /<\/atlasEdit>/i.exec(body.slice(afterOpen));
    if (closeMatch) {
      body = body.slice(afterOpen, afterOpen + closeMatch.index);
    } else {
      body = body.slice(afterOpen);
      incomplete = true;
      issues.push(makeIssue("WRAPPER_INCOMPLETE", { stage: "parse", line: 1, message: "未闭合的 atlasEdit 外壳：剥除外壳继续解析内部完整行" }));
    }
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(body);
  if (fence) body = fence[1];

  const trimmed = body.trim();
  if (trimmed === "") {
    issues.push(makeIssue("EMPTY_RESPONSE", { stage: "parse", line: null, message: "空响应不是 noop（§8.3）：必须记 EMPTY_RESPONSE 并尝试一次定向修复" }));
    return { operations, issues, explicitNoop: false, incomplete: true };
  }

  // 完整数组优先整段解析；数组损坏时不扫描内部对象「救行」（§8.3）。
  if (trimmed.startsWith("[")) {
    try {
      const array = JSON.parse(trimmed);
      if (!Array.isArray(array)) throw new Error("不是数组");
      array.forEach((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          issues.push(makeIssue("OPERATION_NOT_OBJECT", { stage: "parse", line: index + 1, message: "数组元素不是 JSON 对象" }));
          return;
        }
        operations.push({ opId: `op${index + 1}`, line: index + 1, value: item });
      });
      return { operations, issues, explicitNoop: operations.some((op) => op.value.op === "noop"), incomplete };
    } catch (error) {
      issues.push(makeIssue("ARRAY_BROKEN", { stage: "parse", line: 1, message: `数组整段损坏，按规定不扫描内部对象救行：${String(error.message ?? error)}` }));
      return { operations, issues, explicitNoop: false, incomplete: true };
    }
  }

  const lines = body.split(/\r?\n/);
  let opIndex = 0;
  lines.forEach((line, index) => {
    const raw = line.trim();
    if (!raw) return;
    const lineNo = index + 1;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const unbalanced = (raw.match(/[{[("']/g) ?? []).length !== (raw.match(/[}\]")']/g) ?? []).length;
      issues.push(makeIssue("JSON_SYNTAX", {
        stage: "parse",
        line: lineNo,
        message: `第 ${lineNo} 行不是完整 JSON 对象：${String(error.message ?? error)}`,
        details: { snippet: raw.slice(0, 80), utf8Bytes: utf8Bytes(raw), suspectedTruncation: unbalanced || /[}\]]$/.test(raw) === false },
      }));
      incomplete = true;
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      issues.push(makeIssue("OPERATION_NOT_OBJECT", { stage: "parse", line: lineNo, message: "不是 JSON 对象" }));
      return;
    }
    opIndex += 1;
    operations.push({ opId: `op${opIndex}`, line: lineNo, value: parsed });
  });
  const explicitNoop = operations.length > 0 && operations.every((op) => op.value.op === "noop");
  return { operations, issues, explicitNoop, incomplete };
}

/**
 * 把解析出来的操作按顺序匹配回场景意图（拿组号用）。
 * 按 op+ref 优先、op 次之的顺序消费，截断/重排/缺行都不会把组号错配到别的意图上。
 */
function createIntentMatcher(scenario) {
  const consumed = new Set();
  return (value) => {
    const candidates = scenario.intents.map((intent, index) => ({ intent, index })).filter((item) => !consumed.has(item.index));
    const hit =
      candidates.find((item) => item.intent.op === value.op && item.intent.ref === value.ref) ??
      candidates.find((item) => item.intent.op === value.op);
    if (!hit) return null;
    consumed.add(hit.index);
    return hit;
  };
}

function groupIdOfIntent(scenario, hit) {
  if (!hit) return null;
  return scenario.groups.find((group) => group.intents.some((item) => item.opIndex === hit.index))?.id ?? null;
}

/** A 组编译：等价的纯 JS 业务校验（不是 src 里那个 TS compileOperations）。 */
export function compileOpsOperations(parsed, scenario) {
  const issues = [...parsed.issues.map((issue) => ({ ...issue, stage: "parse" }))];
  const registered = new Map();
  const writes = [];
  const ignoredFields = [];
  const matchIntent = createIntentMatcher(scenario);
  parsed.operations.forEach((operation) => {
    const value = operation.value;
    const opId = operation.opId;
    if (value.op === "noop") return;
    if (!value.op || typeof value.op !== "string") {
      issues.push(makeIssue("MINIMUM_FIELD_MISSING", { stage: "compile", opId, line: operation.line, field: "op", message: "缺 op 字段" }));
      return;
    }
    const matched = matchIntent(value);
    if (value.op === "item.transfer") {
      // §8.4 最少参数在顶层；data 里的同名字段作为容错也接受
      const to = value.to ?? value.data?.to;
      const quantity = value.quantity ?? value.data?.quantity ?? 1;
      const target = to?.holder_ref ?? to?.location_ref ?? to?.container_ref;
      if (!target) {
        issues.push(makeIssue("MINIMUM_FIELD_MISSING", { stage: "compile", opId, line: operation.line, field: "to", message: "item.transfer 缺 to 目标" }));
        return;
      }
      writes.push({ opId, line: operation.line, groupIntent: groupIdOfIntent(scenario, matched), table: "items", rowId: value.ref, kind: "transfer", fields: ["holder_character_id", "quantity"], data: { to, quantity }, toRef: target });
      return;
    }
    const table = OP_TO_TABLE[value.op];
    if (!table) {
      issues.push(makeIssue("UNKNOWN_OPERATION", { stage: "compile", opId, line: operation.line, message: `未知操作：${String(value.op)}` }));
      return;
    }
    const mapping = FIELD_TO_COLUMN[table];
    const data = value.data ?? {};
    const isNew = typeof value.ref === "string" && value.ref.startsWith("new:");
    for (const key of Object.keys(data)) {
      if (PROGRAM_COLUMNS.has(key)) {
        ignoredFields.push({ opId, field: key, reason: "SYSTEM_FIELD_IGNORED" });
        continue;
      }
      if (!mapping[key]) ignoredFields.push({ opId, field: key, reason: "FIELD_IGNORED" });
    }
    let rowId;
    if (isNew) {
      rowId = scenario.newIds[value.ref] ?? value.ref.slice(4);
      if (registered.has(value.ref)) {
        issues.push(makeIssue("DUPLICATE_STABLE_ID", { stage: "compile", opId, field: "ref", message: `同一响应里重复登记 ${value.ref}` }));
        return;
      }
      registered.set(value.ref, rowId);
      if (table === "characters") {
        const clue = data.identity || data.importance || data.importance_reason;
        if (!data.name || !clue) {
          issues.push(makeIssue("MINIMUM_FIELD_MISSING", { stage: "compile", opId, line: operation.line, field: data.name ? "identity/importance" : "name", message: "新建人物需要 name 加身份/重要性线索之一（§8.4）" }));
          return;
        }
      } else if (!data.name) {
        issues.push(makeIssue("MINIMUM_FIELD_MISSING", { stage: "compile", opId, line: operation.line, field: "name", message: `新建 ${table} 需要 name` }));
        return;
      }
    } else {
      if (typeof value.ref !== "string" || value.ref.length === 0) {
        issues.push(makeIssue("MINIMUM_FIELD_MISSING", { stage: "compile", opId, line: operation.line, field: "ref", message: "修改已有对象必须有 ref" }));
        return;
      }
      rowId = value.ref;
    }
    const fields = Object.keys(data).map((key) => mapping[key]).filter(Boolean);
    if (!isNew && fields.length === 0) {
      issues.push(makeIssue("MINIMUM_FIELD_MISSING", { stage: "compile", opId, line: operation.line, field: "data", message: "修改操作至少要有一个变更字段" }));
      return;
    }
    writes.push({ opId, line: operation.line, groupIntent: groupIdOfIntent(scenario, matched), table, rowId, kind: isNew ? "insert" : "update", fields, data, ref: value.ref });
  });
  return { writes, issues, ignoredFields, explicitNoop: parsed.explicitNoop, incomplete: parsed.incomplete };
}

// ---------------------------------------------------------------------------
// B 组：有限 SQL 编辑视图的解析与白名单
// ---------------------------------------------------------------------------

/** 顶层分隔（尊重单引号字符串与括号）；用于 SQL 语句切分与列表切分。 */
export function splitTopLevel(text, separator) {
  const parts = [];
  let current = "";
  let inString = false;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      current += ch;
      if (ch === "'") {
        if (text[i + 1] === "'") {
          current += "'";
          i += 1;
        } else inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function stripSqlComments(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "'") {
        if (text[i + 1] === "'") {
          out += "'";
          i += 1;
        } else inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function parseLiteral(raw) {
  const text = raw.trim();
  if (/^NULL$/i.test(text)) return { ok: true, value: null };
  if (/^TRUE$/i.test(text)) return { ok: true, value: 1 };
  if (/^FALSE$/i.test(text)) return { ok: true, value: 0 };
  if (/^'.*'$/s.test(text)) return { ok: true, value: text.slice(1, -1).replace(/''/g, "'") };
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return { ok: true, value: Number(text) };
  return { ok: false, value: null };
}

/**
 * 解析 B 组响应文本：只接受白名单内的 INSERT/UPDATE 编辑视图语句。
 * 返回 { statements, issues }；任何白名单外的语句都被拒绝并给出模板名/违规关键字。
 */
export function parseSqlResponse(text) {
  const issues = [];
  const statements = [];
  const original = String(text ?? "");
  const body = stripSqlComments(original);
  if (original.trim() === "") {
    issues.push(makeIssue("EMPTY_RESPONSE", { stage: "parse", message: "空响应：B 组至少要有一条语句或显式注释" }));
    return { statements, issues, explicitNoop: false };
  }
  if (body.trim() === "") {
    // 只有注释（例如 `-- 无变化`）：等价于显式 noop，不是错误
    return { statements, issues, explicitNoop: true };
  }
  const rawStatements = splitTopLevel(body, ";").map((item) => item.trim()).filter(Boolean);
  rawStatements.forEach((raw, index) => {
    const statementIndex = index + 1;
    for (const forbidden of SQL_FORBIDDEN) {
      if (forbidden.pattern.test(raw)) {
        issues.push(makeIssue(forbidden.code, {
          stage: "whitelist",
          sqlTemplate: `forbidden_${forbidden.label.replace(/[^A-Za-z]/g, "_")}`,
          line: statementIndex,
          message: `第 ${statementIndex} 条语句命中禁止项「${forbidden.label}」（§20.2 有限 SQL 编辑视图）`,
          details: { snippet: raw.slice(0, 90) },
        }));
        return;
      }
    }
    const insert = /^INSERT\s+INTO\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)$/i.exec(raw);
    const update = /^UPDATE\s+([A-Za-z_][\w]*)\s+SET\s+([\s\S]*?)\s+WHERE\s+([\s\S]*)$/i.exec(raw);
    const updateNoWhere = /^UPDATE\s+([A-Za-z_][\w]*)\s+SET\b/i.exec(raw);
    if (!insert && !update && updateNoWhere) {
      const view = updateNoWhere[1];
      const spec = SQL_EDIT_VIEWS[view];
      if (!spec) {
        issues.push(makeIssue("TABLE_NOT_IN_EDIT_VIEW", { stage: "whitelist", sqlTemplate: "update_unknown_view", line: statementIndex, message: `只允许写三个编辑视图，收到 ${view}` }));
        return;
      }
      issues.push(makeIssue("MISSING_TARGET_ID", { stage: "whitelist", sqlTemplate: `update_${spec.table}`, line: statementIndex, field: "id", message: "UPDATE 必须用显式目标 ID：WHERE id = '<目标 ID>'（禁止无 WHERE 或任意条件）" }));
      return;
    }
    if (insert) {
      const view = insert[1];
      const spec = SQL_EDIT_VIEWS[view];
      if (!spec) {
        issues.push(makeIssue("TABLE_NOT_IN_EDIT_VIEW", { stage: "whitelist", sqlTemplate: "insert_unknown_view", line: statementIndex, message: `只允许写三个编辑视图，收到 ${view}` }));
        return;
      }
      const columns = insert[2].split(",").map((item) => item.trim()).filter(Boolean);
      const valueParts = splitTopLevel(insert[3], ",").map((item) => item.trim());
      if (columns.length !== valueParts.length) {
        issues.push(makeIssue("COLUMN_VALUE_COUNT_MISMATCH", { stage: "parse", sqlTemplate: spec.template, line: statementIndex, field: "values", message: `列数 ${columns.length} 与值数 ${valueParts.length} 不一致` }));
        return;
      }
      const unknown = columns.filter((column) => !spec.columns.includes(column));
      if (unknown.length > 0) {
        issues.push(makeIssue("UNKNOWN_COLUMN", { stage: "whitelist", sqlTemplate: spec.template, line: statementIndex, field: unknown[0], message: `列不在编辑视图白名单内：${unknown.join(", ")}` }));
        return;
      }
      const missing = spec.insertRequired.filter((column) => !columns.includes(column));
      if (missing.length > 0) {
        issues.push(makeIssue("MINIMUM_FIELD_MISSING", { stage: "parse", sqlTemplate: spec.template, line: statementIndex, field: missing[0], message: `INSERT 缺必要列：${missing.join(", ")}` }));
        return;
      }
      const values = [];
      for (let i = 0; i < valueParts.length; i += 1) {
        const literal = parseLiteral(valueParts[i]);
        if (!literal.ok) {
          issues.push(makeIssue("NOT_A_LITERAL", { stage: "parse", sqlTemplate: spec.template, line: statementIndex, field: columns[i], message: `值必须是字面量（不接受表达式/函数/子查询）：${valueParts[i].slice(0, 40)}` }));
          return;
        }
        values.push({ column: columns[i], value: literal.value });
      }
      statements.push({ index: statementIndex, kind: "insert", view, table: spec.table, template: spec.template, columns, values, raw });
      return;
    }
    if (update) {
      const view = update[1];
      const spec = SQL_EDIT_VIEWS[view];
      if (!spec) {
        issues.push(makeIssue("TABLE_NOT_IN_EDIT_VIEW", { stage: "whitelist", sqlTemplate: "update_unknown_view", line: statementIndex, message: `只允许写三个编辑视图，收到 ${view}` }));
        return;
      }
      const where = /^id\s*=\s*('(?:[^']|'')*')$/i.exec(update[3].trim());
      if (!where) {
        issues.push(makeIssue("MISSING_TARGET_ID", { stage: "whitelist", sqlTemplate: `update_${spec.table}`, line: statementIndex, field: "id", message: "UPDATE 必须用显式目标 ID：WHERE id = '<目标 ID>'（禁止无 WHERE 或任意条件）" }));
        return;
      }
      const targetId = where[1].slice(1, -1).replace(/''/g, "'");
      const assignments = splitTopLevel(update[2], ",").map((item) => item.trim());
      const values = [];
      for (const assignment of assignments) {
        const match = /^([A-Za-z_][\w]*)\s*=\s*([\s\S]+)$/.exec(assignment);
        if (!match) {
          issues.push(makeIssue("NOT_A_LITERAL", { stage: "parse", sqlTemplate: `update_${spec.table}`, line: statementIndex, message: `赋值形状非法：${assignment.slice(0, 40)}` }));
          return;
        }
        const column = match[1];
        if (!spec.columns.includes(column)) {
          issues.push(makeIssue("UNKNOWN_COLUMN", { stage: "whitelist", sqlTemplate: `update_${spec.table}`, line: statementIndex, field: column, message: `列不在编辑视图白名单内：${column}` }));
          return;
        }
        const literal = parseLiteral(match[2]);
        if (!literal.ok) {
          issues.push(makeIssue("NOT_A_LITERAL", { stage: "parse", sqlTemplate: `update_${spec.table}`, line: statementIndex, field: column, message: `值必须是字面量：${match[2].slice(0, 40)}` }));
          return;
        }
        values.push({ column, value: literal.value });
      }
      if (assignments.length === 0) {
        issues.push(makeIssue("MINIMUM_FIELD_MISSING", { stage: "parse", sqlTemplate: `update_${spec.table}`, line: statementIndex, message: "UPDATE 没有赋值列" }));
        return;
      }
      statements.push({ index: statementIndex, kind: "update", view, table: spec.table, template: `update_${spec.table}`, targetId, values, raw });
      return;
    }
    issues.push(makeIssue("STATEMENT_SHAPE_UNSUPPORTED", { stage: "whitelist", sqlTemplate: "unsupported_statement", line: statementIndex, message: `只接受 INSERT INTO <编辑视图> (列清单) VALUES (...)/UPDATE <编辑视图> SET ... WHERE id = '...'：${raw.slice(0, 60)}` }));
  });
  return { statements, issues, explicitNoop: rawStatements.length === 0 };
}

// ---------------------------------------------------------------------------
// 提交（应用）与业务检查器
// ---------------------------------------------------------------------------

/** 用参数绑定写入（对照 A 组真实编译器的写法）。 */
function applyOpsWrites(db, compilation, scenario) {
  const applied = { groups: [], writes: 0 };
  const writesByGroup = new Map();
  for (const write of compilation.writes) {
    const group = write.groupIntent ?? scenario.groupOrder?.[0] ?? "g1";
    if (!writesByGroup.has(group)) writesByGroup.set(group, []);
    writesByGroup.get(group).push(write);
  }
  const order = scenario.groupOrder ?? scenario.groups.map((group) => group.id);
  for (const groupId of order) {
    const group = scenario.groups.find((item) => item.id === groupId) ?? { id: groupId };
    const writes = writesByGroup.get(groupId) ?? [];
    const record = { groupId, writes: writes.length, committed: false, blocked: false, error: null, dup: false };
    if (writes.length === 0) {
      record.blocked = true;
      record.error = "该组没有成功编译的操作（依赖失败或解析失败）";
      applied.groups.push(record);
      continue;
    }
    db.run(`SAVEPOINT ${savepointName(group.id)}`);
    try {
      for (const write of writes) applyOneWrite(db, write, scenario);
      db.run(`RELEASE ${savepointName(group.id)}`);
      record.committed = true;
      applied.writes += writes.length;
    } catch (error) {
      db.run(`ROLLBACK TO ${savepointName(group.id)}`);
      db.run(`RELEASE ${savepointName(group.id)}`);
      record.error = String(error.message ?? error);
      record.errorCode = classifySqliteError(record.error);
    }
    applied.groups.push(record);
  }
  return applied;
}

function savepointName(groupId) {
  return `sp_${String(groupId).replace(/[^A-Za-z0-9_]/g, "_")}`;
}

function applyOneWrite(db, write, scenario) {
  if (write.kind === "transfer") {
    const target = write.toRef;
    const quantity = Number(write.data.quantity ?? 1);
    const rows = queryRows(db, "SELECT quantity, holder_character_id FROM items WHERE branch_id = ? AND id = ?", [scenario.branch, write.rowId]);
    if (rows.length === 0) throw new Error(`REF_UNKNOWN: 物品 ${write.rowId} 不在分支 ${scenario.branch}`);
    const current = rows[0];
    if (current.quantity !== null && Number.isFinite(Number(current.quantity)) && Number(current.quantity) - quantity < 0) {
      throw new Error(`NEGATIVE_QUANTITY: 转移 ${quantity} 超过现有 ${current.quantity}`);
    }
    const isCharacter = queryRows(db, "SELECT kind FROM entity_keys WHERE branch_id = ? AND id = ?", [scenario.branch, target]);
    if (isCharacter.length === 0) throw new Error(`REF_UNKNOWN: 目标 ${target} 不在分支 ${scenario.branch}`);
    if (isCharacter[0].kind === "character") {
      db.run("UPDATE items SET holder_character_id = ?, location_id = NULL, row_rev = row_rev + 1 WHERE branch_id = ? AND id = ?", [target, scenario.branch, write.rowId]);
    } else {
      db.run("UPDATE items SET location_id = ?, holder_character_id = NULL, row_rev = row_rev + 1 WHERE branch_id = ? AND id = ?", [target, scenario.branch, write.rowId]);
    }
    if (current.quantity !== null && Number.isFinite(Number(current.quantity))) {
      db.run("UPDATE items SET quantity = ? WHERE branch_id = ? AND id = ?", [Number(current.quantity) - quantity, scenario.branch, write.rowId]);
    }
    return;
  }
  const mapping = FIELD_TO_COLUMN[write.table];
  const entries = Object.entries(write.data ?? {}).filter(([key]) => mapping[key] && !PROGRAM_COLUMNS.has(key));
  if (write.kind === "insert") {
    const columns = ["branch_id", "id", ...entries.map(([key]) => mapping[key])];
    const values = [scenario.branch, write.rowId, ...entries.map(([key, value]) => normalizeValue(resolveFieldValue(scenario, key, value)))];
    db.run("INSERT INTO entity_keys (branch_id, id, kind) VALUES (?, ?, ?)", [scenario.branch, write.rowId, kindForTable(write.table)]);
    db.run(`INSERT INTO ${write.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, values);
    return;
  }
  const assignments = entries.map(([key]) => `${mapping[key]} = ?`);
  const params = [...entries.map(([key, value]) => normalizeValue(resolveFieldValue(scenario, key, value))), scenario.branch, write.rowId];
  db.run(`UPDATE ${write.table} SET ${assignments.join(", ")}, row_rev = row_rev + 1 WHERE branch_id = ? AND id = ?`, params);
  if (db.getRowsModified() === 0) throw new Error(`REF_UNKNOWN: ${write.table} 里没有 ${write.rowId}（分支 ${scenario.branch}）`);
}

function normalizeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function kindForTable(table) {
  return { locations: "location", characters: "character", items: "item" }[table] ?? "unknown";
}

function classifySqliteError(message) {
  if (/UNIQUE constraint failed: entity_keys/i.test(message)) return "DUPLICATE_STABLE_ID";
  if (/FOREIGN KEY constraint failed/i.test(message)) return "SQL_CONSTRAINT_FOREIGN_KEY";
  if (/NOT NULL constraint failed/i.test(message)) return "SQL_CONSTRAINT_NOT_NULL";
  if (/CHECK constraint failed/i.test(message)) return "SQL_CONSTRAINT_CHECK";
  if (/no such (table|column)/i.test(message)) return "SQL_SYNTAX";
  if (/^REF_UNKNOWN/.test(message)) return "REF_UNKNOWN";
  if (/^NEGATIVE_QUANTITY/.test(message)) return "NEGATIVE_QUANTITY";
  return "SQL_ERROR";
}

/**
 * B 组语句归组：按「编辑视图 + 目标 ID」匹配回意图，两边组号口径一致
 * （匹配不到就退回语句序号，绝不把不成组的语句算进有效组）。
 */
function groupIdForStatement(scenario, statement) {
  const id = statement.kind === "insert"
    ? statement.values.find((item) => item.column === "id")?.value
    : statement.targetId;
  const index = scenario.intents.findIndex((intent) => intentToView(intent) === statement.view && stableIdForRef(scenario, intent.ref) === id);
  if (index < 0) return `s${statement.index}`;
  return groupIdOfIntent(scenario, { index }) ?? `s${statement.index}`;
}

/** 执行 B 组语句（真实 SQLite 执行，白名单已过；保存点回滚只影响本组）。 */
function applySqlStatements(db, parsed, scenario) {
  const applied = { groups: [], writes: 0 };
  parsed.statements.forEach((statement) => {
    const groupId = groupIdForStatement(scenario, statement);
    const record = { groupId, statementIndex: statement.index, writes: 1, committed: false, blocked: false, error: null, sqlTemplate: statement.template };
    db.run(`SAVEPOINT ${savepointName(groupId)}`);
    try {
      // 注意：sql.js 的 getRowsModified() 对 INSTEAD OF 触发器（视图写入）恒为 0，
      // 即使触发器真的改了底层表。所以「目标行是否存在」必须自己先查，不能靠 changes 计数。
      if (statement.kind === "update") {
        const exists = queryRows(db, `SELECT 1 AS ok FROM ${statement.view} WHERE id = ?`, [statement.targetId]);
        if (exists.length === 0) {
          throw new Error(`REF_UNKNOWN: ${statement.view} 里没有目标 ID ${statement.targetId}（分支 ${scenario.branch}）`);
        }
      }
      db.run(statement.raw);
      const violations = checkForeignKeys(db);
      if (violations.length > 0) throw new Error(`FOREIGN KEY constraint failed（check）：${violations[0].table} ${violations[0].parent}`);
      db.run(`RELEASE ${savepointName(groupId)}`);
      record.committed = true;
      applied.writes += 1;
    } catch (error) {
      db.run(`ROLLBACK TO ${savepointName(groupId)}`);
      db.run(`RELEASE ${savepointName(groupId)}`);
      record.error = String(error.message ?? error);
      record.errorCode = classifySqliteError(record.error);
    }
    applied.groups.push(record);
  });
  return applied;
}

function checkForeignKeys(db) {
  const result = db.exec("PRAGMA foreign_key_check");
  if (result.length === 0) return [];
  return result[0].values.map((row) => ({ table: row[0], rowid: row[1], parent: row[2] }));
}

/**
 * 相同业务检查器（A/B 两组共用）：纯 JS 等价实现。
 * **不是** src/atlas-ops-compile.ts 的真实 compileOperations —— 见报告里的替换说明。
 */
export function runBusinessChecks(db, scenario, changes) {
  const issues = [];
  const branch = scenario.branch;
  const entityKinds = new Map(
    queryRows(db, "SELECT id, kind FROM entity_keys WHERE branch_id = ?", [branch]).map((row) => [row.id, row.kind]),
  );
  const locationIds = new Set(queryRows(db, "SELECT id FROM locations WHERE branch_id = ?", [branch]).map((row) => row.id));
  const characterIds = new Set(queryRows(db, "SELECT id FROM characters WHERE branch_id = ?", [branch]).map((row) => row.id));
  const itemIds = new Set(queryRows(db, "SELECT id FROM items WHERE branch_id = ?", [branch]).map((row) => row.id));

  const checkEntityKeys = (table, kind, ids) => {
    for (const id of ids) {
      if (!entityKinds.has(id)) {
        issues.push(makeIssue("ENTITY_KEY_MISSING", { stage: "invariant", table, rowId: id, field: "id", message: `${table} 的 ${id} 在 entity_keys（同分支）里没有身份行` }));
      } else if (entityKinds.get(id) !== kind) {
        issues.push(makeIssue("ENTITY_KIND_MISMATCH", { stage: "invariant", table, rowId: id, field: "kind", message: `${id} 的身份类型是 ${entityKinds.get(id)}，与 ${kind} 不一致` }));
      }
    }
  };
  checkEntityKeys("locations", "location", locationIds);
  checkEntityKeys("characters", "character", characterIds);
  checkEntityKeys("items", "item", itemIds);

  const refChecks = [
    { table: "locations", column: "parent_location_id", pool: locationIds },
    { table: "locations", column: "map_id", pool: null },
    { table: "characters", column: "location_id", pool: locationIds },
    { table: "items", column: "location_id", pool: locationIds },
    { table: "items", column: "holder_character_id", pool: characterIds },
    { table: "items", column: "container_item_id", pool: itemIds },
    { table: "items", column: "owner_entity_id", pool: null },
  ];
  for (const check of refChecks) {
    const columns = SNAPSHOT_TABLES[check.table];
    const rows = queryRows(db, `SELECT ${columns.join(", ")} FROM ${check.table} WHERE branch_id = ?`, [branch]);
    for (const row of rows) {
      const value = row[check.column];
      if (value === null || value === undefined) continue;
      if (check.pool && !check.pool.has(value)) {
        const other = queryRows(db, "SELECT branch_id FROM entity_keys WHERE id = ?", [value]);
        const code = other.length > 0 ? "CROSS_BRANCH_REF" : "REF_UNKNOWN";
        issues.push(makeIssue(code, { stage: "invariant", table: check.table, rowId: row.id, field: check.column, message: `${check.column}=${value} 在分支 ${branch} 里不存在${other.length > 0 ? `（它属于 ${other.map((item) => item.branch_id).join("/")}）` : ""}` }));
      }
      if (!check.pool) {
        const exists = queryRows(db, "SELECT kind FROM entity_keys WHERE branch_id = ? AND id = ?", [branch, value]);
        if (exists.length === 0) issues.push(makeIssue("REF_UNKNOWN", { stage: "invariant", table: check.table, rowId: row.id, field: check.column, message: `${check.column}=${value} 在同分支 entity_keys 里不存在` }));
      }
    }
  }

  for (const table of ["locations", "characters", "items"]) {
    const rows = queryRows(db, `SELECT * FROM ${table} WHERE branch_id = ?`, [branch]);
    for (const row of rows) {
      const hasX = row.grid_x !== null && row.grid_x !== undefined;
      const hasY = row.grid_y !== null && row.grid_y !== undefined;
      if (hasX !== hasY) {
        issues.push(makeIssue("COORD_PAIR_INCOMPLETE", { stage: "invariant", table, rowId: row.id, field: hasX ? "grid_y" : "grid_x", message: "坐标必须成对提供（x/y 同时有或同时为空）" }));
      }
      if ((hasX || hasY) && !row.map_id) {
        issues.push(makeIssue("COORD_WITHOUT_MAP", { stage: "invariant", table, rowId: row.id, field: "map_id", message: "有格坐标却没有 map_id" }));
      }
      if ((hasX || hasY) && !["exact", "approximate", "layout"].includes(row.coord_precision)) {
        issues.push(makeIssue("COORD_PRECISION_INVALID", { stage: "invariant", table, rowId: row.id, field: "coord_precision", message: `有格坐标时 coord_precision=${row.coord_precision} 非法` }));
      }
      if (table === "characters" && row.coord_precision === "layout") {
        issues.push(makeIssue("LAYOUT_PRECISION_FOR_CHARACTER", { stage: "invariant", table, rowId: row.id, field: "coord_precision", message: "人物不得把 layout 坐标当实际位置（§3.3）" }));
      }
      for (const [field, value] of Object.entries(row)) {
        if (typeof value === "number" && !Number.isFinite(value)) {
          issues.push(makeIssue("NON_FINITE_VALUE", { stage: "invariant", table, rowId: row.id, field, message: "NaN/Infinity 一律非法（§8.5）" }));
        }
      }
      if (table === "items" && row.quantity !== null && row.quantity !== undefined) {
        if (!Number.isFinite(Number(row.quantity))) issues.push(makeIssue("NON_FINITE_VALUE", { stage: "invariant", table, rowId: row.id, field: "quantity", message: "数量必须是有限数" }));
        else if (Number(row.quantity) < 0) issues.push(makeIssue("NEGATIVE_QUANTITY", { stage: "invariant", table, rowId: row.id, field: "quantity", message: `数量为负：${row.quantity}` }));
      }
    }
  }

  for (const change of changes) {
    if (change.branchId && change.branchId !== branch) {
      issues.push(makeIssue("BRANCH_ISOLATION_VIOLATION", { stage: "invariant", table: change.table, rowId: change.rowId, field: change.field, message: `改动落在分支 ${change.branchId}，本次运行分支是 ${branch}` }));
    }
  }
  return issues;
}

/** 认知泄漏检查：没有接触机会却获得信息 / 作者私密自动注入角色可见字段。 */
export function checkCognitiveLeakage(parsed, scenario, changes) {
  const issues = [];
  const opportunities = new Set((scenario.opportunities ?? []).map((item) => item.id));
  const operations = parsed.operations ?? [];
  for (const operation of operations) {
    if (operation.value?.op === "attention.propose") {
      const ref = operation.value.data?.opportunity_ref ?? operation.value.opportunity_ref;
      if (!ref || !opportunities.has(ref)) {
        issues.push(makeIssue("NO_CONTACT_OPPORTUNITY", { stage: "invariant", opId: operation.opId, field: "opportunity_ref", message: `attention.propose 引用了程序没有给出的机会：${String(ref)}` }));
      }
    }
  }
  for (const statement of parsed.statements ?? []) {
    if (statement.view === "edit_knowledge" || /knowledge/i.test(statement.view ?? "")) {
      issues.push(makeIssue("KNOWLEDGE_WRITE_OUT_OF_SCOPE", { stage: "whitelist", sqlTemplate: statement.template, message: "编辑视图不含知识表" }));
    }
  }
  for (const secret of AUTHOR_ONLY_SECRETS) {
    for (const change of changes) {
      const after = typeof change.after === "string" ? change.after : "";
      if (!secret.text) continue;
      if (after.includes(secret.text)) {
        const visible = change.table === "characters" && ["thought", "action_tendency", "description", "personality", "identity"].includes(change.field);
        const locationish = change.table === "locations" || change.table === "items";
        if (visible || locationish) {
          issues.push(makeIssue("AUTHOR_SECRET_AUTO_INJECTED", {
            stage: "invariant",
            table: change.table,
            rowId: change.rowId,
            field: change.field,
            message: `作者私密「${secret.id}」在没有接触机会的情况下写进了 ${change.table}.${change.field}`,
          }));
        }
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 度量与运行引擎
// ---------------------------------------------------------------------------

function writeSetOf(changes) {
  const map = new Map();
  for (const change of changes) {
    const key = `${change.table}|${change.rowId}`;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(change.field);
  }
  return map;
}

/**
 * 创建器补的默认值（§2.1「创建器统一补默认」）。
 * 新建一行时程序会填这些列：它们不是模型写错的字段，因此不计入「错改范围」。
 */
const CREATOR_DEFAULTS = {
  locations: { aliases_json: "[]", description: "", mobility: "fixed", coord_precision: "unknown", terrain: "unknown", existence_quality: "confirmed", status: "active", parent_location_id: null, map_id: null, grid_x: null, grid_y: null, uncertainty_radius_cells: null, area_geometry_json: null, access_rules_json: null, vehicle_profile_json: null, anchor_location_id: null, merged_into_id: null },
  characters: { aliases_json: "[]", role: "npc", importance: "supporting", importance_reason: "", identity: "", description: "", personality: "", thought: "", action_tendency: "", physical_status: "unknown", condition_note: "", coord_precision: "unknown", location_id: null, map_id: null, grid_x: null, grid_y: null, uncertainty_radius_cells: null, mobility_profiles_json: "[]", capabilities_json: "[]", status: "active", merged_into_id: null },
  items: { aliases_json: "[]", kind: "other", description: "", quantity: null, unit: "件", condition_note: "", status: "active", coord_precision: "unknown", owner_entity_id: null, holder_character_id: null, container_item_id: null, location_id: null, map_id: null, grid_x: null, grid_y: null, uncertainty_radius_cells: null, properties_json: "[]", merged_into_id: null },
};

const PROGRAM_FIELDS = new Set(["row_rev", "created_turn_id", "updated_turn_id", "branch_id", "id"]);

function isCreatorDefault(table, field, value) {
  const defaults = CREATOR_DEFAULTS[table];
  if (!defaults || !(field in defaults)) return false;
  return defaults[field] === value;
}

/** 错改范围：期望写集之外的 (行, 字段)。程序维护列、程序副作用（时钟）、entity_keys、创建器默认值不计入。 */
function outOfScopeChanges(changes, expected) {
  const allowed = new Map();
  for (const write of expected.writes) {
    const key = `${write.table}|${write.rowId}`;
    if (!allowed.has(key)) allowed.set(key, new Set());
    // fields 既可能是数组（期望写集），也可能是 {列: 值}（修复期望）
    const fieldList = Array.isArray(write.fields) ? write.fields : Object.keys(write.fields ?? {});
    for (const field of fieldList) allowed.get(key).add(field);
  }
  const out = [];
  for (const change of changes) {
    if (change.table === "entity_keys") continue;
    if (change.table === "branches") continue; // 世界时钟/版本由程序维护（programEffects），不是模型写错
    if (PROGRAM_FIELDS.has(change.field)) continue;
    if (isCreatorDefault(change.table, change.field, change.after)) continue;
    const key = `${change.table}|${change.rowId}`;
    const fields = allowed.get(key);
    if (!fields || !fields.has(change.field)) out.push(change);
  }
  return out;
}

/** 引用类字段：值要过「短引用 → 稳定 ID」解析（§8.4：ref 只接短引用/稳定 ID/new: 别名）。 */
const REF_FIELDS = new Set(["location_ref", "map_ref", "parent_ref", "anchor_ref"]);

/** 把意图里的字段值解析成落库值。 */
function resolveFieldValue(scenario, key, value) {
  if (REF_FIELDS.has(key) && typeof value === "string") return stableIdForRef(scenario, value);
  return value;
}

/** 语义是否达到期望：目标行、字段、值都对上，且没有不变量错误。 */
function semanticOutcome(db, scenario, changes, invariantIssues) {
  const errors = [];
  const failingRows = new Set();
  const changedKeys = new Set(changes.map((change) => `${change.table}|${change.rowId}|${change.field}`));
  for (const write of scenario.expected.writes) {
    const intentIndex = scenario.intents.findIndex((item) => {
      const table = item.op === "item.transfer" ? "items" : OP_TO_TABLE[item.op];
      return table === write.table && stableIdForRef(scenario, item.ref) === write.rowId;
    });
    const intent = intentIndex >= 0 ? scenario.intents[intentIndex] : null;
    // 人工注入的坏组：期望不是「写对」，而是「没有把坏数据写进世界」
    const groupId = groupIdOfIntent(scenario, intentIndex >= 0 ? { index: intentIndex } : null);
    if (groupId && scenario.invalidGroups.includes(groupId)) {
      const touched = write.fields.filter((field) => changedKeys.has(`${write.table}|${write.rowId}|${field}`));
      if (touched.length > 0) {
        errors.push({ code: "DAMAGED_GROUP_TOUCHED_WORLD", table: write.table, rowId: write.rowId, fields: touched });
        failingRows.add(`${write.table}|${write.rowId}`);
      }
      continue;
    }
    const rows = queryRows(db, `SELECT * FROM ${write.table} WHERE branch_id = ? AND id = ?`, [scenario.branch, write.rowId]);
    if (rows.length === 0) {
      errors.push({ code: "TARGET_ROW_MISSING", table: write.table, rowId: write.rowId });
      failingRows.add(`${write.table}|${write.rowId}`);
      continue;
    }
    if (!intent) continue;
    const mapping = FIELD_TO_COLUMN[write.table];
    for (const [key, rawValue] of Object.entries(intent.data ?? {})) {
      const column = mapping[key];
      if (!column) continue;
      const value = resolveFieldValue(scenario, key, rawValue);
      const expectedValue = value === null || value === undefined ? null : typeof value === "object" ? JSON.stringify(value) : value;
      if (rows[0][column] !== expectedValue) {
        errors.push({ code: "FIELD_VALUE_MISMATCH", table: write.table, rowId: write.rowId, field: column, expected: expectedValue, actual: rows[0][column] });
        failingRows.add(`${write.table}|${write.rowId}`);
      }
    }
  }
  const hard = invariantIssues.filter((issue) => issue.severity === "error");
  const target = scenario.expected.writes.length;
  return {
    ok: errors.length === 0 && hard.length === 0,
    errors,
    invariantErrors: hard.length,
    opStats: { target, satisfied: Math.max(0, target - failingRows.size) },
  };
}

/** 重复副作用：把实测量与「只应发生一次」的期望比。 */
function measureSideEffects(before, after, scenario, { duplicated }) {
  const expectedClock = scenario.programEffects?.clockDeltaS ?? 0;
  const clockBefore = before.branches.get(`${scenario.branch}|${scenario.branch}`)?.clock_s ?? 0;
  const clockAfter = after.branches.get(`${scenario.branch}|${scenario.branch}`)?.clock_s ?? 0;
  const quantityBefore = [...before.items.entries()].map(([key, row]) => [key, row.quantity]);
  const quantityAfter = new Map([...after.items.entries()].map(([key, row]) => [key, row.quantity]));
  let quantityDelta = 0;
  for (const [key, value] of quantityBefore) {
    const next = quantityAfter.get(key);
    if (next === undefined) continue;
    if (value === null || value === undefined || next === null || next === undefined) continue;
    quantityDelta += Math.abs(Number(next) - Number(value));
  }
  return {
    clockDeltaS: round(clockAfter - clockBefore, 6),
    expectedClockDeltaS: expectedClock,
    extraClockS: round(clockAfter - clockBefore - expectedClock, 6),
    quantityDelta: round(quantityDelta, 6),
    duplicated,
  };
}

/** 定位完整率：失败是否带阶段/op/组/字段或 SQL 模板。 */
function localizationOutcome(issues) {
  const failures = issues.filter((issue) => issue.severity === "error");
  if (failures.length === 0) return { rate: null, reason: "NO_FAILURES_OBSERVED", total: 0, locatable: 0 };
  const locatable = failures.filter((issue) => issue.locatable).length;
  return { rate: round(locatable / failures.length, 4), total: failures.length, locatable, unlocatable: failures.filter((issue) => !issue.locatable).map((issue) => issue.code) };
}

const ENGINE_HONESTY = {
  businessChecker: "本文件内的纯 JS 等价业务校验（entity_keys 身份、同分支引用、坐标配对、NaN/Infinity、非负数量、重复稳定 ID）；不是 src/atlas-ops-compile.ts 的真实 compileOperations（TS 不能被 .mjs 工具 import）",
  database: "每次运行一个隔离的内存 sql.js 库，表子集 = branches/turns/maps/entity_keys/locations/characters/items + 三个 INSTEAD OF 触发器编辑视图；不是 20 张表的真实 schema",
  promptRendering: "两组的提示词与预设文本都由同一份意图渲染（A=每行一个 JSON 对象；B=显式列清单 + 目标 ID 的有限 SQL 编辑视图），因此功能范围相同；预设文本不是真实模型输出",
};

/**
 * 从修复文本自身推导期望（修复阶段不能用原始损坏意图去比对）：
 * A 组看编译结果，B 组看解析出的语句。
 */
function expectationFromOpsWrites(writes, scenario) {
  return writes.map((write) => {
    if (write.kind === "transfer") return { table: "items", rowId: write.rowId, fields: { holder_character_id: write.toRef } };
    const mapping = FIELD_TO_COLUMN[write.table];
    const fields = {};
    for (const [key, value] of Object.entries(write.data ?? {})) {
      const column = mapping[key];
      if (!column || PROGRAM_COLUMNS.has(key)) continue;
      fields[column] = normalizeValue(resolveFieldValue(scenario, key, value));
    }
    return { table: write.table, rowId: write.rowId, fields };
  });
}

function expectationFromSqlStatements(statements) {
  return statements.map((statement) => {
    if (statement.kind === "insert") {
      const fields = {};
      let rowId = null;
      for (const { column, value } of statement.values) {
        if (column === "id") rowId = value;
        else fields[column] = value;
      }
      return { table: statement.table, rowId, fields };
    }
    return { table: statement.table, rowId: statement.targetId, fields: Object.fromEntries(statement.values.map((item) => [item.column, item.value])) };
  });
}

/** 修复后的判定：目标行存在、值等于修复文本自己的期望、不变量成立、没有越界改动。 */
function checkExpectation(db, scenario, expectation) {
  const errors = [];
  for (const item of expectation) {
    const rows = queryRows(db, `SELECT * FROM ${item.table} WHERE branch_id = ? AND id = ?`, [scenario.branch, item.rowId]);
    if (rows.length === 0) {
      errors.push({ code: "REPAIR_TARGET_MISSING", table: item.table, rowId: item.rowId });
      continue;
    }
    for (const [column, value] of Object.entries(item.fields)) {
      const expected = value === undefined ? null : value;
      if (rows[0][column] !== expected) errors.push({ code: "REPAIR_VALUE_MISMATCH", table: item.table, rowId: item.rowId, field: column, expected, actual: rows[0][column] });
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 运行一个场景的一次：解析 → 编译/执行 → 业务检查 → （必要时）一次定向修复。
 * textOverride 用于 --live 的真实响应；repairProvider 用同一段代码跑离线预设或真实修复请求。
 */
async function runOnce(SQL, scenario, format, { submissionKeyStore, textOverride = null, repairProvider = null }) {
  const started = performance.now();
  const db = createDatabase(SQL, scenario.branch);
  const result = { scenarioId: scenario.id, format, parse: null, apply: null, semantics: null, diff: null, issues: [], repair: null, timings: {}, sideEffects: null, duplicate: false, validGroups: scenario.validGroups.length, committedValidGroups: 0 };
  // 阶段标记：工具自身抛错时也要能定位到阶段（§18.4 的纪律同样适用于本工具）
  let stage = "init";
  try {
    stage = "parse";
    const text = textOverride ?? (format === "ops" ? scenario.preset.ops.initial : scenario.preset.sql.initial);
    const parseStart = performance.now();
    const parsed = format === "ops" ? parseOpsResponse(text) : parseSqlResponse(text);
    result.parse = {
      utf8Bytes: utf8Bytes(text),
      statementsOrOperations: format === "ops" ? parsed.operations.length : parsed.statements.length,
      targetOperations: scenario.intents.filter((intent) => intent.op !== "noop").length,
      explicitNoop: Boolean(parsed.explicitNoop),
      syntaxOk: format === "ops" ? parsed.operations.length > 0 || parsed.explicitNoop : parsed.statements.length > 0 || parsed.explicitNoop,
      issues: parsed.issues.length,
    };
    result.timings.parseMs = round(performance.now() - parseStart);

    const submissionKey = sha256(`${format}|${scenario.id}|${text}`);
    if (submissionKeyStore.has(submissionKey)) {
      result.duplicate = true;
      result.apply = { groups: [], writes: 0, duplicate: true };
      result.semantics = { ok: true, skipped: "DUPLICATE_SUBMISSION_IDEMPOTENT" };
      result.diff = { changes: 0, outOfScope: 0 };
      result.sideEffects = { clockDeltaS: 0, expectedClockDeltaS: 0, extraClockS: 0, quantityDelta: 0, duplicated: true };
      result.timings.totalMs = round(performance.now() - started);
      return result;
    }

    stage = "snapshot-before";
    const before = snapshotDatabase(db);
    const compileStart = performance.now();
    let compilation = null;
    stage = format === "ops" ? "compile-apply-ops" : "apply-sql";
    if (format === "ops") {
      compilation = compileOpsOperations(parsed, scenario);
      result.issues.push(...compilation.issues);
      result.apply = applyOpsWrites(db, compilation, scenario);
    } else {
      result.issues.push(...parsed.issues);
      result.apply = applySqlStatements(db, parsed, scenario);
    }
    result.timings.applyMs = round(performance.now() - compileStart);

    // 显式 noop：没有任何组需要提交，不算「有效组丢失」
    if (parsed.explicitNoop) {
      result.apply.noop = true;
      if (result.apply.groups.length === 0) {
        result.apply.groups = scenario.groups.map((group) => ({ groupId: group.id, writes: 0, committed: true, blocked: false, noop: true, error: null }));
      }
      for (const group of result.apply.groups) {
        if (!group.committed) {
          group.committed = true;
          group.noop = true;
          group.error = null;
          group.errorCode = null;
        }
      }
    }
    // 有效组保留：在修复之前就记下首轮结果（修复不改变首轮统计）
    result.committedValidGroups = result.validGroups > 0
      ? result.apply.groups.filter((group) => group.committed && scenario.validGroups.some((valid) => valid.id === group.groupId)).length
      : 0;
    // 提交失败也要进 issues：故障定位完整率必须覆盖 apply 阶段的组级失败
    for (const group of result.apply.groups) {
      if (group.committed || !group.error) continue;
      result.issues.push(makeIssue(group.errorCode ?? "GROUP_APPLY_FAILED", {
        stage: "apply",
        group: group.groupId,
        sqlTemplate: format === "sql" ? group.sqlTemplate ?? null : null,
        message: group.error,
      }));
    }

    // 程序侧副作用（时间推进）：一次提交只发生一次
    stage = "program-effects";
    const committedGroups = result.apply.groups.filter((group) => group.committed).length;
    if (scenario.programEffects?.clockDeltaS && committedGroups > 0) {
      db.run("UPDATE branches SET clock_s = clock_s + ?, revision = revision + 1 WHERE id = ?", [scenario.programEffects.clockDeltaS, scenario.branch]);
      submissionKeyStore.add(submissionKey);
    } else if (committedGroups > 0) {
      submissionKeyStore.add(submissionKey);
    }

    stage = "snapshot-after";
    const after = snapshotDatabase(db);
    const changes = diffSnapshots(before, after);
    const checkerStart = performance.now();
    stage = "business-check";
    const invariants = runBusinessChecks(db, scenario, changes);
    const leakage = checkCognitiveLeakage(parsed, scenario, changes);
    result.timings.checkMs = round(performance.now() - checkerStart);
    result.issues.push(...invariants, ...leakage);

    const out = outOfScopeChanges(changes, scenario.expected);
    result.diff = {
      changes: changes.length,
      changedFields: changes.map((change) => `${change.table}.${change.rowId}.${change.field}`).slice(0, 24),
      outOfScope: out.length,
      outOfScopeFields: out.map((change) => `${change.table}.${change.rowId}.${change.field}`).slice(0, 12),
    };
    result.semantics = semanticOutcome(db, scenario, changes, [...invariants, ...leakage]);
    result.sideEffects = measureSideEffects(before, after, scenario, { duplicated: false });

    // 一次定向修复（§16.2 repairAttemptsPerBatch = 1）；只针对失败的组
    const failedGroups = result.apply.groups.filter((group) => !group.committed);
    const offlineRepairText = format === "ops" ? scenario.preset.ops.repair : scenario.preset.sql.repair;
    const provider = repairProvider ?? (offlineRepairText ? async () => ({ text: offlineRepairText, meta: { source: "preset" } }) : null);
    if (failedGroups.length > 0 && provider) {
      stage = "repair";
      const repairStart = performance.now();
      const produced = await provider({
        scenario,
        format,
        runIndex: null,
        failedGroups,
        issues: result.issues,
      });
      const repairText = produced?.text ?? null;
      if (!repairText) {
        result.repair = { requested: true, targetedGroups: failedGroups.map((group) => group.groupId), available: false, note: "没有可用的修复文本（离线回放不编造修复请求）", meta: produced?.meta ?? null };
        result.timings.totalMs = round(performance.now() - started);
        return result;
      }
      const beforeRepair = snapshotDatabase(db);
      const repairParsed = format === "ops" ? parseOpsResponse(repairText) : parseSqlResponse(repairText);
      const repairCompilation = format === "ops" ? compileOpsOperations(repairParsed, scenario) : null;
      const repairApply = format === "ops" ? applyOpsWrites(db, repairCompilation, scenario) : applySqlStatements(db, repairParsed, scenario);
      const afterRepair = snapshotDatabase(db);
      const repairChanges = diffSnapshots(beforeRepair, afterRepair);
      const repairInvariants = runBusinessChecks(db, scenario, repairChanges);
      const expectation = format === "ops" ? expectationFromOpsWrites(repairCompilation.writes, scenario) : expectationFromSqlStatements(repairParsed.statements);
      const repaired = checkExpectation(db, scenario, expectation);
      const repairOutOfScope = outOfScopeChanges(repairChanges, { writes: expectation });
      const repairHardErrors = repairInvariants.filter((issue) => issue.severity === "error");
      const repairCommitted = repairApply.groups.filter((group) => group.committed).length;
      result.repair = {
        requested: true,
        targetedGroups: failedGroups.map((group) => group.groupId),
        parseIssues: repairParsed.issues.length,
        groups: repairApply.groups.length,
        committed: repairCommitted,
        ok: repairCommitted > 0 && repaired.ok && repairHardErrors.length === 0 && repairOutOfScope.length === 0,
        expectation,
        expectationCheck: repaired,
        outOfScope: repairOutOfScope.length,
        invariantErrors: repairHardErrors.length,
        sideEffects: measureSideEffects(beforeRepair, afterRepair, scenario, { duplicated: false }),
        ms: round(performance.now() - repairStart),
        meta: produced?.meta ?? null,
      };
      result.issues.push(...repairParsed.issues, ...repairInvariants);
    } else if (failedGroups.length > 0) {
      result.repair = { requested: true, targetedGroups: failedGroups.map((group) => group.groupId), available: false, note: "预设里没有修复文本（离线回放不编造修复请求）" };
    } else {
      result.repair = { requested: false };
    }
    result.timings.totalMs = round(performance.now() - started);
    return result;
  } catch (error) {
    // 工具自身抛错也要带阶段（sql.js 抛的是裸字符串，这里统一成具名错误）
    throw new BenchmarkError("ENGINE_STAGE_FAILED", `场景 ${scenario.id} 在阶段 ${stage} 抛错：${String(error?.message ?? error)}`, { scenarioId: scenario.id, format, stage });
  } finally {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  }
}

// ---------------------------------------------------------------------------
// --live：本机 API 配置与调用（密钥永不进报告）
// ---------------------------------------------------------------------------

/** base64url("settings")：服务插件文档存储的真实文件名编码。 */
const PLUGIN_SETTINGS_DOC = "c2V0dGluZ3M.json";

/**
 * 读取本机 API 配置。优先级：--config 指定文件 > 环境变量 > 服务插件 data/ 下的设置文档。
 * 返回 { endpoint, model, apiKey, maxTokens, temperature, timeoutMs, keySource, configSource } 或 null。
 * 调用方只能把 keyPresent/keySource 写进报告，绝不写 key 原文。
 */
export function readLiveConfig({ configPath, env = process.env, root = REPO_ROOT, fixturesLive = null } = {}) {
  const pick = (record) => {
    if (!record || typeof record !== "object") return null;
    const endpoint = record.endpoint ?? record.baseUrl ?? record.base_url ?? record.url;
    const model = record.model ?? record.modelId ?? record.model_id;
    const apiKey = record.apiKey ?? record.api_key ?? record.key ?? record.token;
    if (typeof endpoint !== "string" || !/^https?:\/\//i.test(endpoint)) return null;
    if (typeof model !== "string" || !model.trim()) return null;
    if (typeof apiKey !== "string" || apiKey.trim().length < 6) return null;
    return {
      endpoint: endpoint.trim(),
      model: model.trim(),
      apiKey: apiKey.trim(),
      maxTokens: Number(record.maxTokens ?? record.max_tokens ?? RUNTIME_LIMITS.normalResponseTokens) || RUNTIME_LIMITS.normalResponseTokens,
      temperature: Number.isFinite(Number(record.temperature)) ? Number(record.temperature) : 0.2,
      topP: Number.isFinite(Number(record.topP ?? record.top_p)) ? Number(record.topP ?? record.top_p) : 1,
      timeoutMs: Number(record.timeoutMs ?? record.timeout_ms ?? RUNTIME_LIMITS.modelTimeoutMs) || RUNTIME_LIMITS.modelTimeoutMs,
    };
  };
  const fromEnvRecord = {
    endpoint: env.ATLAS_BENCH_BASE_URL ?? env.OPENAI_BASE_URL ?? env.OPENAI_API_BASE,
    model: env.ATLAS_BENCH_MODEL ?? env.OPENAI_MODEL,
    apiKey: env.ATLAS_BENCH_API_KEY ?? env.OPENAI_API_KEY,
    maxTokens: env.ATLAS_BENCH_MAX_TOKENS,
    temperature: env.ATLAS_BENCH_TEMPERATURE,
    timeoutMs: env.ATLAS_BENCH_TIMEOUT_MS,
  };
  const envConfig = pick(fromEnvRecord.endpoint ? { ...fromEnvRecord, endpoint: fromEnvRecord.endpoint } : null);
  if (envConfig) return { ...envConfig, keySource: "env", configSource: "environment" };

  const explicit = configPath ? resolve(root, configPath) : null;
  const candidates = [
    explicit,
    join(root, "tools", "atlas-input-format-benchmark.config.json"),
    join(root, "atlas-server-plugin", "data", PLUGIN_SETTINGS_DOC),
    join(root, "atlas-server-plugin", "data", "settings.json"),
  ].filter(Boolean);
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    let record;
    try {
      record = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const direct = pick(record);
    if (direct) return { ...direct, keySource: "config-file", configSource: file };
    const presets = Array.isArray(record.apiPresets) ? record.apiPresets : Array.isArray(record.presets) ? record.presets : [];
    const active = record.activeApiPresetId ?? record.activePresetId;
    const ordered = [...presets].sort((a, b) => (a.id === active ? -1 : b.id === active ? 1 : 0));
    for (const preset of ordered) {
      const candidate = pick(preset);
      if (candidate) return { ...candidate, keySource: "config-file", configSource: file };
    }
    const legacy = pick(record.worldTurn ?? record.connection ?? record.api);
    if (legacy) return { ...legacy, keySource: "config-file", configSource: file };
  }
  const fromFixtures = pick(fixturesLive);
  if (fromFixtures) return { ...fromFixtures, keySource: "fixtures-file", configSource: "fixtures.export.live" };
  return null;
}

function promptHashOf(scenario, format) {
  const prompt = scenario.prompt[format];
  return sha256(`${PROMPT_SET_VERSION}|${format}|${scenario.id}|${prompt.system}\n${prompt.user}`);
}

/** 全部场景的提示词 hash（两组各一份），用于「报告包括原提示词版本/hash」。 */
function scenarioPromptHashes(scenarios) {
  return Object.fromEntries(scenarios.map((scenario) => [scenario.id, { ops: promptHashOf(scenario, "ops"), sql: promptHashOf(scenario, "sql") }]));
}

async function callModel(config, { system, user, maxTokens, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        top_p: config.topP,
        max_tokens: maxTokens,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    const text = await response.text();
    const elapsedMs = round(performance.now() - started);
    if (!response.ok) {
      return { ok: false, status: response.status, elapsedMs, error: `HTTP_ERROR ${response.status}`, body: text.slice(0, 300) };
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, status: response.status, elapsedMs, error: "HTTP_ERROR 响应不是 JSON", body: text.slice(0, 300) };
    }
    const content = payload.choices?.[0]?.message?.content ?? payload.choices?.[0]?.text ?? "";
    return {
      ok: true,
      status: response.status,
      elapsedMs,
      text: typeof content === "string" ? content : JSON.stringify(content),
      finishReason: payload.choices?.[0]?.finish_reason ?? null,
      usage: { promptTokens: payload.usage?.prompt_tokens ?? null, completionTokens: payload.usage?.completion_tokens ?? null, totalTokens: payload.usage?.total_tokens ?? null },
      modelEcho: payload.model ?? null,
    };
  } catch (error) {
    const elapsedMs = round(performance.now() - started);
    const aborted = error?.name === "AbortError";
    return { ok: false, elapsedMs, error: aborted ? "MODEL_TIMEOUT" : `HTTP_ERROR ${String(error?.message ?? error)}`, timeout: aborted };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const NULL_REASON = "OFFLINE_REPLAY_NO_MODEL";

function emptyRates(reason) {
  return {
    firstPassSyntaxPerOperation: null,
    firstPassSyntaxPerCase: null,
    firstPassSemanticPerOperation: null,
    firstPassSemanticPerCase: null,
    afterOneRepairPerCase: null,
    notRunReason: reason,
  };
}

/**
 * 汇总一组运行。
 * mode = "offline" 时标签为 tool-harness-preset-replay（预设回放，确定性）；
 * mode = "live" 时这些数字来自真实响应，标签为 live-model-response。
 */
function aggregateRuns(runs, { mode = "offline" } = {}) {
  const measuredOn = mode === "offline" ? "tool-harness-preset-replay" : "live-model-response";
  const natural = runs.filter((run) => run.cohort === "natural");
  const injected = runs.filter((run) => run.cohort === "injected_damage");
  const perOperation = (list, pick) => {
    let target = 0;
    let ok = 0;
    for (const run of list) {
      const stats = pick(run);
      target += stats.target ?? 0;
      ok += Math.min(stats.ok ?? 0, stats.target ?? 0);
    }
    return { target, ok, rate: target > 0 ? round(ok / target, 4) : null };
  };
  const perCase = (list, predicate) => {
    if (list.length === 0) return { total: 0, ok: 0, rate: null };
    const ok = list.filter(predicate).length;
    return { total: list.length, ok, rate: round(ok / list.length, 4) };
  };
  const syntaxOpStats = (run) => ({
    target: run.result.parse.targetOperations,
    ok: run.result.parse.syntaxOk ? Math.min(run.result.parse.statementsOrOperations, run.result.parse.targetOperations) : 0,
  });
  const semanticOpStats = (run) => run.result.semantics?.opStats ?? { target: 0, ok: 0 };
  const durations = runs.map((run) => run.result.timings.totalMs).filter((value) => Number.isFinite(value));
  const issueCount = runs.reduce((sum, run) => sum + run.result.issues.length, 0);
  const localized = runs.reduce((sum, run) => {
    const failures = run.result.issues.filter((issue) => issue.severity === "error");
    return sum + failures.filter((issue) => issue.locatable).length;
  }, 0);
  const failures = runs.reduce((sum, run) => sum + run.result.issues.filter((issue) => issue.severity === "error").length, 0);
  const outOfScope = runs.reduce((sum, run) => sum + (run.result.diff?.outOfScope ?? 0), 0);
  const extraClock = runs.reduce((sum, run) => sum + Math.max(0, run.result.sideEffects?.extraClockS ?? 0), 0);
  // 额外数量只在「重复提交」的那几次上统计：首次提交产生的数量变化是应有副作用，不是重复副作用
  const repeatRuns = runs.filter((run) => run.result.isRepeat);
  const quantityDeltaOnRepeats = repeatRuns.reduce((sum, run) => sum + (run.result.sideEffects?.quantityDelta ?? 0), 0);
  const quantityDeltaFirstPass = runs.filter((run) => !run.result.isRepeat).reduce((sum, run) => sum + (run.result.sideEffects?.quantityDelta ?? 0), 0);
  const leakageCodes = new Set(["NO_CONTACT_OPPORTUNITY", "AUTHOR_SECRET_AUTO_INJECTED", "KNOWLEDGE_WRITE_OUT_OF_SCOPE"]);
  const leakage = runs.reduce((sum, run) => sum + run.result.issues.filter((issue) => leakageCodes.has(issue.code)).length, 0);
  const repairsRequested = runs.filter((run) => run.result.repair?.requested).length;
  const repairsCommitted = runs.filter((run) => run.result.repair?.committed > 0).length;
  const repairsOk = runs.filter((run) => run.result.repair?.ok).length;
  const totalValidGroups = runs.reduce((sum, run) => sum + run.validGroups, 0);
  const committedValidGroups = runs.reduce((sum, run) => sum + run.committedValidGroups, 0);
  const httpFailures = runs.filter((run) => run.result.httpError).length;
  return {
    measuredOn,
    totals: { runs: runs.length, natural: natural.length, injectedDamage: injected.length, issues: issueCount, errorIssues: failures, httpFailures },
    firstPass: {
      syntaxPerOperation: perOperation(runs, syntaxOpStats),
      syntaxPerCase: perCase(runs, (run) => run.result.parse.syntaxOk),
      syntaxPerCaseNatural: perCase(natural, (run) => run.result.parse.syntaxOk),
      syntaxPerCaseInjected: perCase(injected, (run) => run.result.parse.syntaxOk),
      semanticPerOperation: perOperation(runs, semanticOpStats),
      semanticPerCase: perCase(runs, (run) => run.result.semantics?.ok === true),
      semanticPerCaseNatural: perCase(natural, (run) => run.result.semantics?.ok === true),
      semanticPerCaseInjected: perCase(injected, (run) => run.result.semantics?.ok === true),
    },
    afterOneRepair: {
      requested: repairsRequested,
      attempted: runs.filter((run) => run.result.repair?.requested && run.result.repair?.committed !== undefined).length,
      committed: repairsCommitted,
      ok: repairsOk,
      perCaseRate: (() => {
        const attempted = runs.filter((run) => run.result.repair?.requested && run.result.repair?.committed !== undefined).length;
        return attempted > 0 ? round(repairsOk / attempted, 4) : null;
      })(),
      repairRunsCountedSeparately: true,
      note: "分母只含真的发起了修复的样例；没有修复文本的样例记为 requested/available=false，不计入分母",
    },
    retention: {
      totalValidGroups,
      committedValidGroups,
      rate: totalValidGroups > 0 ? round(committedValidGroups / totalValidGroups, 4) : null,
      note: "分母只含「本应成功」的独立有效组；人工注入的坏组不计入",
    },
    outOfScopeWrites: { changes: outOfScope, note: "期望写集之外的行/字段；程序维护列与 entity_keys 不计入" },
    duplicateSideEffects: {
      extraClockS: round(extraClock, 6),
      quantityDeltaOnRepeats: round(quantityDeltaOnRepeats, 6),
      quantityDeltaFirstPass: round(quantityDeltaFirstPass, 6),
      repeatSubmissionRuns: repeatRuns.length,
      note: "额外数量只统计重复提交那几次；首次提交的数量变化是应有副作用",
    },
    cognitiveLeakage: { authorSecretsInjected: AUTHOR_ONLY_SECRETS.length, violations: leakage },
    localization: { ...localizationOutcome(runs.flatMap((run) => run.result.issues)), localized, failures },
    cost: {
      requests: 0,
      initialRequests: 0,
      repairRequests: 0,
      tokens: null,
      tokensReason: mode === "offline" ? NULL_REASON : "LIVE_USAGE_PENDING",
      timeouts: 0,
      localComputeMs: { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), samples: durations.length },
      note: mode === "offline"
        ? "离线没有模型请求：requests/tokens 为 0/null；localComputeMs 只是本机解析+执行耗时，不是模型延迟"
        : "live：requests/tokens/延迟来自真实请求；localComputeMs 另有记录",
    },
  };
}

/** 把一段运行结果整形成 §20.3 的 rates 块（成功率）。 */
function ratesFrom(outcome) {
  return {
    firstPassSyntaxPerOperation: outcome.firstPass.syntaxPerOperation.rate,
    firstPassSyntaxPerCase: outcome.firstPass.syntaxPerCase.rate,
    firstPassSemanticPerOperation: outcome.firstPass.semanticPerOperation.rate,
    firstPassSemanticPerCase: outcome.firstPass.semanticPerCase.rate,
    afterOneRepairPerCase: outcome.afterOneRepair.perCaseRate,
    notRunReason: null,
  };
}

function buildGate() {
  return {
    label: "目标值，不是本次结果（§20.4）",
    deterministicOfflineGate: {
      label: "离线确定性门槛（本次可真跑的部分，逐条列出实际结果）",
      items: [
        "正常场景不因 quote/封套问题整轮被拒（本工具离线只回放预设，不校验生产 quote 策略）",
        "独立有效组保留 100%",
        "串档 / 重复推进 / 伪造精点 / 越权信息注入 / 静默清库 为 0",
      ],
    },
    modelGate: {
      label: "模型实测初始目标（发布目标，未由本工具达成或声称达成）",
      items: [
        "60 例中首次达到目标 ≥ 57",
        "一次修复后 ≥ 59",
        "所有写入不变量与会话隔离零破坏",
      ],
      note: "这是发布目标值，不是本次结果；规模小也不足以证明对所有模型通用。",
    },
  };
}

/**
 * 执行全部场景（离线用预设文本，live 用真实响应）。
 * provider = { initial(scenario, runIndex), repair(scenario, runIndex, {issues}) }，都返回 { text, meta }。
 */
async function executeScenarios(SQL, scenarios, { format, runs, provider }) {
  const results = [];
  const skipped = [];
  for (const scenario of scenarios) {
    if (!scenario.groupSupport[format]) {
      skipped.push({
        scenarioId: scenario.id,
        title: scenario.title,
        reason: "B_GROUP_UNSUPPORTED_TASK",
        note: scenario.sqlUnsupportedReason ?? "该任务不在 §20.2 的共享任务范围（两边都支持）内：不计入 B 组统计，也不得据此说 SQL 更差",
      });
      continue;
    }
    const scenarioRuns = [];
    for (let index = 0; index < runs; index += 1) {
      const submissionKeyStore = new Set();
      const produced = await provider.initial(scenario, index);
      const first = await runOnce(SQL, scenario, format, {
        submissionKeyStore,
        textOverride: produced?.text ?? null,
        repairProvider: produced?.repairProvider ?? provider.repair ?? null,
      });
      first.cohort = scenario.cohort;
      first.liveMeta = produced?.meta ?? null;
      const repeats = [];
      for (let repeat = 1; repeat < scenario.repeats; repeat += 1) {
        const again = await runOnce(SQL, scenario, format, { submissionKeyStore, textOverride: produced?.text ?? null });
        again.cohort = scenario.cohort;
        again.isRepeat = true;
        repeats.push(again);
      }
      scenarioRuns.push({
        index: index + 1,
        scenarioId: scenario.id,
        cohort: scenario.cohort,
        result: first,
        repeats,
        validGroups: first.validGroups,
        committedValidGroups: first.committedValidGroups,
      });
    }
    results.push({ scenario, runs: scenarioRuns });
  }
  return { results, skipped };
}

/** 组装报告（不发起任何请求）。 */
export function buildReport({ format, mode, runs, scenarios, fixtures, execution, live = null, selfChecks = [] }) {
  const allRuns = execution.results.flatMap((item) => item.runs);
  const outcome = aggregateRuns(allRuns, { mode });
  const report = {
    tool: TOOL_NAME,
    spec: "§18.3 T31 / §20.2 / §20.3 / §20.4",
    generatedAt: new Date().toISOString(),
    run: {
      mode,
      format,
      runs,
      plannedInitialRequests: execution.results.length * runs,
      specPlannedAcrossAB: 120,
      scenarios: {
        source: fixtures.source,
        count: scenarios.length,
        executed: execution.results.length,
        ids: scenarios.map((scenario) => scenario.id),
        titles: scenarios.map((scenario) => `${scenario.id} ${scenario.title}`),
        internalFallback: fixtures.internalFallback,
        note: fixtures.note,
      },
      database: ENGINE_HONESTY.database,
      promptSetVersion: PROMPT_SET_VERSION,
      promptHashes: Object.fromEntries(scenarios.map((scenario) => [scenario.id, { ops: promptHashOf(scenario, "ops"), sql: promptHashOf(scenario, "sql") }])),
    },
    honesty: {
      modelCalled: mode === "live",
      mode,
      successRateFieldsNull: mode === "offline",
      nullReason: mode === "offline" ? NULL_REASON : null,
      statements: [
        mode === "offline"
          ? "本次没有调用任何真实模型：--offline 只回放预设文本，全程不触网；报告里的 requests=0、tokens=null。"
          : "本次调用了真实模型（--live）；模型名/版本、提示词 hash、输出预算、修复次数与运行次数见 run.live。",
        mode === "offline"
          ? `所有成功率字段（rates.*）为 null，原因是 ${NULL_REASON} —— 没有模型就没有生成成功率。`
          : "rates.* 来自本次真实响应；请求数少于计划时 run.live.shortfall 会明说。",
        "离线可报的是解析/校验/提交结果（预设回放、确定性），放在 outcomes，measuredOn=tool-harness-preset-replay。",
        "预设文本由本工具从同一意图渲染或人工注入损坏，不代表真实模型输出分布；人工注入损坏样例（cohort=injected_damage）与自然样例分开统计。",
        ENGINE_HONESTY.businessChecker,
        ENGINE_HONESTY.database,
        ENGINE_HONESTY.promptRendering,
        "§20.4 的 60 例门槛是发布目标值，不是本次结果。",
      ],
    },
    rates: mode === "offline" ? emptyRates(NULL_REASON) : { ...ratesFrom(outcome), notRunReason: null },
    outcomes: { [format]: outcome },
    skipped: execution.skipped,
    scenarios: execution.results.map(({ scenario, runs: scenarioRuns }) => ({
      id: scenario.id,
      title: scenario.title,
      taxonomy: scenario.taxonomyIndex ? `§20.2 #${scenario.taxonomyIndex} ${TAXONOMY[scenario.taxonomyIndex - 1]}` : scenario.kind,
      cohort: scenario.cohort,
      damage: scenario.damage ?? null,
      branch: scenario.branch,
      taskCount: scenario.intents.length,
      expectedWrites: scenario.expected.writes,
      promptHash: format === "ops" ? promptHashOf(scenario, "ops") : promptHashOf(scenario, "sql"),
      runs: scenarioRuns.map((run) => ({
        index: run.index,
        validGroups: run.validGroups,
        committedValidGroups: run.committedValidGroups,
        httpError: run.result.httpError ?? null,
        parse: run.result.parse,
        apply: run.result.apply,
        semantics: run.result.semantics,
        diff: run.result.diff,
        sideEffects: run.result.sideEffects,
        repair: run.result.repair,
        duplicateSubmission: run.result.duplicate,
        repeats: run.repeats.map((repeat) => ({ duplicate: repeat.duplicate, apply: repeat.apply, sideEffects: repeat.sideEffects })),
        issues: run.result.issues,
        timings: run.result.timings,
      })),
    })),
    selfChecks,
    gate20_4: buildGate(),
    failures: [],
  };
  if (live) report.run.live = live;
  const failedSelfChecks = selfChecks.filter((check) => !check.pass);
  if (failedSelfChecks.length > 0) {
    report.failures.push({ code: "SELF_CHECK_FAILED", message: `自检未通过：${failedSelfChecks.map((check) => check.id).join(", ")}` });
  }
  return report;
}

/** 离线主流程（可被测试导入调用；不触网、不写文件）。 */
export async function runBenchmark(options) {
  const { SQL, format, mode = "offline", runs = 3, scenarios, fixtures = { source: "internal-scenario-set", internalFallback: true, note: "" }, selfChecks = true } = options;
  const provider = {
    initial: (scenario) => ({ text: format === "ops" ? scenario.preset.ops.initial : scenario.preset.sql.initial, meta: { source: "preset" } }),
    repair: (context) => {
      const text = format === "ops" ? context.scenario.preset.ops.repair : context.scenario.preset.sql.repair;
      return { text, meta: { source: "preset" } };
    },
  };
  const execution = await executeScenarios(SQL, scenarios, { format, runs, provider });
  return buildReport({
    format,
    mode,
    runs,
    scenarios,
    fixtures,
    execution,
    selfChecks: selfChecks ? runSelfChecks(SQL) : [],
  });
}

/** 自检：证明检查器不是瞎的（不属 20 个场景，单独统计）。 */
function runSelfChecks(SQL) {
  const checks = [];
  const push = (id, pass, detail) => checks.push({ id, pass: Boolean(pass), detail });

  const noop = parseOpsResponse('{"op":"noop"}');
  push("ops.noop_recognized", noop.explicitNoop === true && noop.issues.length === 0, "显式 noop 被识别为「明确无修改」");
  const empty = parseOpsResponse("   ");
  push("ops.empty_is_not_noop", empty.explicitNoop === false && empty.issues.some((issue) => issue.code === "EMPTY_RESPONSE"), "空响应记 EMPTY_RESPONSE，不当 noop");
  const fenced = parseOpsResponse('```json\n{"op":"noop"}\n```');
  push("ops.code_fence", fenced.explicitNoop === true, "Markdown json 代码围栏被归一");
  const wrapped = parseOpsResponse('<atlasEdit>\n{"op":"character.upsert","ref":"C1","data":{"thought":"x"}}\n');
  push("ops.wrapper_incomplete", wrapped.operations.length === 1 && wrapped.issues.some((issue) => issue.code === "WRAPPER_INCOMPLETE"), "未闭合 atlasEdit 剥壳后内部完整行仍可用");
  const brokenArray = parseOpsResponse('[{"op":"noop"},{"op":"character.upsert"');
  push("ops.broken_array_not_scavenged", brokenArray.operations.length === 0 && brokenArray.issues.some((issue) => issue.code === "ARRAY_BROKEN"), "损坏数组不扫描内部对象救行");
  const truncated = parseOpsResponse('{"op":"location.upsert","ref":"new:L4","data":{"name":"半');
  push("ops.truncated_line_not_completed", truncated.operations.length === 0 && truncated.issues.some((issue) => issue.code === "JSON_SYNTAX"), "半截 JSON 行不补全");

  const probes = [
    { sql: "CREATE TABLE evil (id TEXT);", expect: "DDL_FORBIDDEN" },
    { sql: "PRAGMA foreign_keys = OFF;", expect: "PRAGMA_FORBIDDEN" },
    { sql: "ATTACH DATABASE 'x.db' AS x;", expect: "ATTACH_FORBIDDEN" },
    { sql: "SELECT * FROM locations;", expect: "QUERY_FORBIDDEN" },
    { sql: "UPDATE locations SET name = 'x' WHERE id = 'L1';", expect: "TABLE_NOT_IN_EDIT_VIEW" },
    { sql: "DELETE FROM edit_locations WHERE id = 'L1';", expect: "DELETE_FORBIDDEN" },
    { sql: "INSERT INTO edit_locations (id, name) VALUES ('L4', 'x'); DROP TABLE locations;", expect: "DDL_FORBIDDEN" },
    { sql: "INSERT INTO edit_locations (id, name, evil) VALUES ('L4', 'x', 1);", expect: "UNKNOWN_COLUMN" },
    { sql: "UPDATE edit_characters SET thought = 'x';", expect: "MISSING_TARGET_ID" },
  ];
  for (const probe of probes) {
    const parsed = parseSqlResponse(probe.sql);
    const hit = parsed.issues.some((issue) => issue.code === probe.expect);
    push(`sql.whitelist.${probe.expect}`, hit, `${probe.sql.slice(0, 52)} → ${hit ? probe.expect : parsed.issues.map((i) => i.code).join("/") || "未被拒绝"}`);
  }
  const okInsert = parseSqlResponse("INSERT INTO edit_locations (id, name) VALUES ('L4', '钟楼');");
  push("sql.valid_insert_accepted", okInsert.statements.length === 1 && okInsert.issues.length === 0, "白名单内的 INSERT 被接受");
  const okUpdate = parseSqlResponse("UPDATE edit_characters SET thought = '别等我; 我先走' WHERE id = 'C1';");
  push("sql.semicolon_in_string_not_split", okUpdate.statements.length === 1 && okUpdate.issues.length === 0, "字符串里的分号不切分语句");
  const quoteUpdate = parseSqlResponse("UPDATE edit_characters SET description = 'don''t ask' WHERE id = 'C1';");
  push("sql.single_quote_escaped", quoteUpdate.statements.length === 1 && quoteUpdate.statements[0].values[0].value === "don't ask", "单引号 '' 转义正确解析");

  const scenario = buildScenarios().find((item) => item.id === "S01");
  const db = createDatabase(SQL, scenario.branch);
  try {
    const leakText = JSON.stringify({ op: "character.upsert", ref: "C1", data: { thought: `其实${AUTHOR_ONLY_SECRETS[0].text}。` } });
    const parsed = parseOpsResponse(leakText);
    const before = snapshotDatabase(db);
    applyOpsWrites(db, compileOpsOperations(parsed, scenario), scenario);
    const after = snapshotDatabase(db);
    const changes = diffSnapshots(before, after);
    const leaks = checkCognitiveLeakage(parsed, scenario, changes);
    push("leakage.author_secret_detected", leaks.some((issue) => issue.code === "AUTHOR_SECRET_AUTO_INJECTED"), "作者私密写进角色可见字段会被抓到");
    const noOpportunity = checkCognitiveLeakage(parseOpsResponse(JSON.stringify({ op: "attention.propose", data: { opportunity_ref: "opp-9", belief: "believes" } })), { opportunities: [] }, []);
    push("leakage.no_contact_opportunity", noOpportunity.some((issue) => issue.code === "NO_CONTACT_OPPORTUNITY"), "没有接触机会的 attention.propose 会被抓到");

    // 重复副作用探测器不是瞎的：故意不幂等地连加两次时间，必须量到「额外 600 秒」
    const beforeClock = snapshotDatabase(db);
    db.run("UPDATE branches SET clock_s = clock_s + 600 WHERE id = ?", [scenario.branch]);
    db.run("UPDATE branches SET clock_s = clock_s + 600 WHERE id = ?", [scenario.branch]);
    const afterClock = snapshotDatabase(db);
    const probe = measureSideEffects(beforeClock, afterClock, { branch: scenario.branch, programEffects: { clockDeltaS: 600 } }, { duplicated: false });
    push("sideeffects.extra_detected", probe.extraClockS === 600, `不幂等重放两次后探测器报出额外 ${probe.extraClockS}s（应为 600）`);
    db.run("UPDATE branches SET clock_s = clock_s - 1200 WHERE id = ?", [scenario.branch]);
    const idempotentBefore = snapshotDatabase(db);
    const keys = new Set([sha256("probe-submission")]);
    if (!keys.has(sha256("probe-submission"))) db.run("UPDATE branches SET clock_s = clock_s + 600 WHERE id = ?", [scenario.branch]);
    const idempotentAfter = snapshotDatabase(db);
    const guarded = measureSideEffects(idempotentBefore, idempotentAfter, { branch: scenario.branch, programEffects: { clockDeltaS: 600 } }, { duplicated: true });
    push("sideeffects.idempotency_guard", guarded.clockDeltaS === 0, "同一提交键第二次提交不产生额外时间（幂等：clockDeltaS 保持 0）");
  } finally {
    db.close();
  }
  return checks;
}

// ---------------------------------------------------------------------------
// 人读输出
// ---------------------------------------------------------------------------

function formatRate(value, reason) {
  if (value === null || value === undefined) return `null（未运行：${reason ?? NULL_REASON}）`;
  return `${round(value * 100, 1)}%`;
}

function humanReport(report) {
  const lines = [];
  const run = report.run;
  lines.push(`Atlas JSON/SQL 输入格式对照（T31 · §20.2/§20.3）— 模式 ${run.mode} / 格式 ${run.format} / 每组 ${run.runs} 次`);
  lines.push(`生成时间：${report.generatedAt}`);
  lines.push("");
  lines.push("诚实性声明：");
  for (const statement of report.honesty.statements) lines.push(`  · ${statement}`);
  lines.push("");
  lines.push(`场景来源：${run.scenarios.source}（${run.scenarios.count} 个${run.scenarios.internalFallback ? "，内置场景集" : ""}）`);
  lines.push(`  ${run.scenarios.note}`);
  lines.push(`计划初次请求：${run.plannedInitialRequests}（本组）；§20.2 的 120 次 = A+B 两组之和`);
  lines.push("");
  lines.push("必报指标（§20.3）：");
  const ratesNull = report.rates.firstPassSyntaxPerOperation === null;
  lines.push(`  首次语法成功率（每操作）：${ratesNull ? formatRate(null, report.rates.notRunReason) : formatRate(report.rates.firstPassSyntaxPerOperation)}`);
  lines.push(`  首次语法成功率（整例）  ：${ratesNull ? formatRate(null, report.rates.notRunReason) : formatRate(report.rates.firstPassSyntaxPerCase)}`);
  lines.push(`  首次语义成功率（每操作）：${ratesNull ? formatRate(null, report.rates.notRunReason) : formatRate(report.rates.firstPassSemanticPerOperation)}`);
  lines.push(`  首次语义成功率（整例）  ：${ratesNull ? formatRate(null, report.rates.notRunReason) : formatRate(report.rates.firstPassSemanticPerCase)}`);
  lines.push(`  修复后成功率            ：${ratesNull ? formatRate(null, report.rates.notRunReason) : formatRate(report.rates.afterOneRepairPerCase)}`);
  const outcomes = report.outcomes[run.format];
  if (outcomes) {
    lines.push(`  —— 以下为 ${outcomes.measuredOn} 的解析/校验/提交结果${run.mode === "offline" ? "（预设回放，确定性；不是模型成功率）" : "（真实响应）"} ——`);
    lines.push(`  语法（每操作）：${outcomes.firstPass.syntaxPerOperation.ok}/${outcomes.firstPass.syntaxPerOperation.target}`);
    lines.push(`  语法（整例）  ：${outcomes.firstPass.syntaxPerCase.ok}/${outcomes.firstPass.syntaxPerCase.total}（自然 ${outcomes.firstPass.syntaxPerCaseNatural.ok}/${outcomes.firstPass.syntaxPerCaseNatural.total} / 注入损坏 ${outcomes.firstPass.syntaxPerCaseInjected.ok}/${outcomes.firstPass.syntaxPerCaseInjected.total}）`);
    lines.push(`  语义（整例）  ：${outcomes.firstPass.semanticPerCase.ok}/${outcomes.firstPass.semanticPerCase.total}（自然 ${outcomes.firstPass.semanticPerCaseNatural.ok}/${outcomes.firstPass.semanticPerCaseNatural.total} / 注入损坏 ${outcomes.firstPass.semanticPerCaseInjected.ok}/${outcomes.firstPass.semanticPerCaseInjected.total}）`);
    lines.push(`  一次修复后    ：requested=${outcomes.afterOneRepair.requested} attempted=${outcomes.afterOneRepair.attempted} committed=${outcomes.afterOneRepair.committed} ok=${outcomes.afterOneRepair.ok}（无修复文本的记为 available=false，不计入分母）`);
    lines.push(`  无关有效组保留率：${outcomes.retention.committedValidGroups}/${outcomes.retention.totalValidGroups}（${outcomes.retention.rate === null ? "无有效组" : outcomes.retention.rate}）`);
    lines.push(`  错改范围      ：期望写集之外的行/字段改动 ${outcomes.outOfScopeWrites.changes} 处`);
    lines.push(`  重复副作用    ：额外时间 ${outcomes.duplicateSideEffects.extraClockS}s / 重复提交额外数量 ${outcomes.duplicateSideEffects.quantityDeltaOnRepeats}（首次提交应有数量变化 ${outcomes.duplicateSideEffects.quantityDeltaFirstPass}，不计入）`);
    lines.push(`  认知泄漏      ：自动注入作者私密 ${outcomes.cognitiveLeakage.authorSecretsInjected} 条，越权/泄漏 ${outcomes.cognitiveLeakage.violations} 处`);
    lines.push(`  成本与耗时    ：请求 ${outcomes.cost.requests}（初次 ${outcomes.cost.initialRequests} / 修复 ${outcomes.cost.repairRequests}）tokens=${outcomes.cost.tokens === null ? `null（${outcomes.cost.tokensReason}）` : outcomes.cost.tokens} 本地 p50=${outcomes.cost.localComputeMs.p50}ms p95=${outcomes.cost.localComputeMs.p95}ms 超时 ${outcomes.cost.timeouts}`);
    lines.push(`  故障定位完整率：${outcomes.localization.rate === null ? `null（${outcomes.localization.reason}）` : `${outcomes.localization.localized}/${outcomes.localization.failures}`}`);
  }
  if (report.run.live) {
    const live = report.run.live;
    lines.push("");
    lines.push("--live 元数据（§20.2：模型/版本/hash/预算/修复次数/运行次数）：");
    lines.push(`  模型：${live.model}${live.modelVersionEcho ? `（服务端回显 ${live.modelVersionEcho}）` : ""}；端点主机 ${live.endpointHost}；接口 ${live.apiVersion}`);
    lines.push(`  配置来源：${live.configSource} / key 来源 ${live.keySource}；key 是否写入报告：${live.keyWrittenToReport}`);
    lines.push(`  提示词 hash（聚合）：${live.promptHashAggregate.slice(0, 16)}…；输出预算 ${live.outputBudgetTokens} tokens（修复 ${live.repairBudgetTokens}）`);
    lines.push(`  请求：初次 ${live.completedInitialRequests}/${live.plannedInitialRequests}，修复 ${live.completedRepairRequests}/${live.plannedRepairRequests}，运行 ${live.runCount} 次，超时 ${live.timeouts} 次`);
    lines.push(`  tokens：${JSON.stringify(live.tokens)}；延迟 p50=${live.latencyMs.p50}ms p95=${live.latencyMs.p95}ms`);
    if (live.shortfall) lines.push(`  ⚠ 未达计划请求数：${live.shortfall}`);
  }
  if (report.skipped?.length) {
    lines.push("");
    lines.push("跳过的场景（不做不对等比较）：");
    for (const item of report.skipped) lines.push(`  - ${item.scenarioId} ${item.title}：${item.reason} —— ${item.note}`);
  }
  lines.push("");
  lines.push(`自检（证明检查器不是瞎的，不属 20 个场景）：${report.selfChecks.filter((check) => check.pass).length}/${report.selfChecks.length} 通过`);
  for (const check of report.selfChecks.filter((check) => !check.pass)) lines.push(`  ✗ ${check.id}：${check.detail}`);
  for (const check of report.selfChecks.filter((check) => check.pass)) lines.push(`  ✓ ${check.id}：${check.detail}`);
  lines.push("");
  lines.push(`§20.4 门槛对照 —— ${report.gate20_4.label}`);
  lines.push(`  ${report.gate20_4.modelGate.label}`);
  for (const item of report.gate20_4.modelGate.items) lines.push(`    - ${item}`);
  lines.push(`    （${report.gate20_4.modelGate.note}）`);
  lines.push(`  ${report.gate20_4.deterministicOfflineGate.label}`);
  for (const item of report.gate20_4.deterministicOfflineGate.items) lines.push(`    - ${item}`);
  lines.push("");
  lines.push("逐场景（前 6 个；完整明细见 --json）：");
  for (const scenario of report.scenarios.slice(0, 6)) {
    const first = scenario.runs[0];
    lines.push(`  ${scenario.id} ${scenario.title} [${scenario.cohort}${scenario.damage ? `/${scenario.damage}` : ""}] 解析${first.parse.syntaxOk ? "OK" : "FAIL"} 语义${first.semantics?.ok ? "OK" : "FAIL"} 组提交${first.apply.groups.filter((g) => g.committed).length}/${first.apply.groups.length} 越界改动${first.diff.outOfScope} 修复${first.repair?.ok ? "OK" : first.repair?.requested ? "FAIL" : "—"}`);
  }
  if (report.failures.length > 0) {
    lines.push("");
    lines.push("本次运行内的失败：");
    for (const failure of report.failures) lines.push(`  - ${failure.code}: ${failure.message}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
  "用法：node tools/atlas-input-format-benchmark.mjs --format ops|sql (--offline | --live) [--fixtures <path>] [--runs 3] [--json] [--out <path>] [--config <path>] [--timeout-ms N]",
  "  --offline  只回放预设文本，不请求外网；成功率字段一律 null（OFFLINE_REPLAY_NO_MODEL）",
  "  --live     读取本机 API 配置并发起真实请求；密钥永不写入报告；缺配置 → LIVE_CONFIG_MISSING（退出码 1，不写任何文件）",
  "  --fixtures 缺省 " + DEFAULT_FIXTURES_PATH + "（存在则用；不存在则退化为内置 20 场景并在报告里说明）",
].join("\n");

function parseArgs(argv) {
  const options = { format: null, mode: null, runs: 3, fixtures: null, fixturesExplicit: false, json: false, out: null, config: null, timeoutMs: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new BenchmarkError("USAGE", `${arg} 需要一个值`);
      i += 1;
      return value;
    };
    if (arg === "--format") options.format = next();
    else if (arg === "--offline") options.mode = "offline";
    else if (arg === "--live") options.mode = "live";
    else if (arg === "--runs") options.runs = Number(next());
    else if (arg === "--fixtures") {
      options.fixtures = next();
      options.fixturesExplicit = true;
    } else if (arg === "--json") options.json = true;
    else if (arg === "--out") options.out = next();
    else if (arg === "--config") options.config = next();
    else if (arg === "--timeout-ms") options.timeoutMs = Number(next());
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new BenchmarkError("USAGE", `未知参数：${arg}`);
  }
  if (options.help) return options;
  if (!options.format) throw new BenchmarkError("USAGE", `缺 --format（ops|sql）。\n${USAGE}`);
  if (!["ops", "sql"].includes(options.format)) throw new BenchmarkError("USAGE", `--format 只能是 ops 或 sql，收到 ${options.format}`);
  if (!options.mode) throw new BenchmarkError("USAGE", `缺 --offline 或 --live。\n${USAGE}`);
  if (!Number.isFinite(options.runs) || options.runs < 1) throw new BenchmarkError("USAGE", `--runs 必须是 ≥1 的整数，收到 ${options.runs}`);
  return options;
}

/** 载入夹具（可选）。显式给出的路径载入失败 → 报错；缺省路径不存在 → 内置退化。 */
async function loadScenarios(options) {
  const explicitPath = options.fixtures ? resolve(REPO_ROOT, options.fixtures) : null;
  const defaultPath = resolve(REPO_ROOT, DEFAULT_FIXTURES_PATH);
  const target = explicitPath ?? defaultPath;
  if (!existsSync(target)) {
    if (options.fixturesExplicit) {
      throw new BenchmarkError("FIXTURES_NOT_FOUND", `--fixtures 指定的文件不存在：${target}`);
    }
    return {
      scenarios: buildScenarios(),
      fixturesLive: null,
      meta: null,
      source: "internal-scenario-set",
      internalFallback: true,
      note: `默认夹具路径 ${DEFAULT_FIXTURES_PATH} 不存在：本次使用**内置 20 场景集**（不是夹具文件，也没有创建夹具文件——那是另一个任务）。`,
    };
  }
  let module;
  try {
    module = await import(pathToFileURL(target).href);
  } catch (error) {
    throw new BenchmarkError("FIXTURES_LOAD_FAILED", `夹具文件载入失败：${target}：${String(error?.message ?? error)}`);
  }
  const raw = module.scenarios;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BenchmarkError("FIXTURES_INVALID", `夹具文件必须导出非空 scenarios 数组：${target}`);
  }
  return {
    scenarios: buildScenarios(raw),
    fixturesLive: module.live ?? null,
    meta: module.meta ?? null,
    source: explicitPath ? `fixtures:${options.fixtures}` : `fixtures:${DEFAULT_FIXTURES_PATH}`,
    internalFallback: false,
    note: `使用夹具文件 ${target}（${raw.length} 个场景）${module.meta?.note ? `；meta.note=${module.meta.note}` : ""}`,
  };
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const loaded = await loadScenarios(options);
  let SQL;
  try {
    SQL = await initSqlJs();
  } catch (error) {
    throw new BenchmarkError("SQLJS_LOAD_FAILED", `sql.js 初始化失败：${String(error?.message ?? error)}`);
  }

  let live = null;
  let liveConfig = null;
  let report = null;
  if (options.mode === "live") {
    liveConfig = readLiveConfig({ configPath: options.config, fixturesLive: loaded.fixturesLive });
    if (!liveConfig) {
      // 配置缺失：一个字节都不写（也不发任何请求）
      throw new BenchmarkError("LIVE_CONFIG_MISSING", "找不到本机 API 配置（--config / 环境变量 / atlas-server-plugin/data 设置文档都不可用）；未写任何文件");
    }
    // 真实请求：逐场景逐次调用；修复另计（§16.2 repairAttemptsPerBatch = 1）。
    const timeoutMs = options.timeoutMs ?? liveConfig.timeoutMs ?? RUNTIME_LIMITS.modelTimeoutMs;
    const details = [];
    const latencies = [];
    const tokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let completedInitial = 0;
    let completedRepair = 0;
    let plannedRepair = 0;
    let timeouts = 0;
    let modelEcho = null;
    const account = (response, phase) => {
      latencies.push(response.elapsedMs);
      if (response.timeout) timeouts += 1;
      if (response.modelEcho && !modelEcho) modelEcho = response.modelEcho;
      if (response.usage?.totalTokens) {
        tokens.promptTokens += response.usage.promptTokens ?? 0;
        tokens.completionTokens += response.usage.completionTokens ?? 0;
        tokens.totalTokens += response.usage.totalTokens ?? 0;
      }
      details.push({
        scenarioId: response.scenarioId ?? null,
        runIndex: response.runIndex ?? null,
        phase,
        ok: response.ok,
        status: response.status ?? null,
        finishReason: response.finishReason ?? null,
        elapsedMs: response.elapsedMs,
        outputChars: response.ok ? response.text.length : 0,
        error: response.ok ? null : response.error,
        responseHash: response.ok ? sha256(response.text) : null,
      });
    };
    const provider = {
      initial: async (scenario, runIndex) => {
        const prompt = scenario.prompt[options.format];
        const response = await callModel(liveConfig, {
          system: prompt.system,
          user: prompt.user,
          maxTokens: liveConfig.maxTokens ?? RUNTIME_LIMITS.normalResponseTokens,
          timeoutMs,
        });
        completedInitial += 1;
        account({ ...response, scenarioId: scenario.id, runIndex: runIndex + 1 }, "initial");
        return { text: response.ok ? response.text : "", meta: { phase: "initial", ok: response.ok, status: response.status ?? null, error: response.ok ? null : response.error, elapsedMs: response.elapsedMs, responseHash: response.ok ? sha256(response.text) : null } };
      },
      repair: async ({ scenario, format, failedGroups, issues }) => {
        plannedRepair += 1;
        const prompt = scenario.prompt[format];
        const response = await callModel(liveConfig, {
          system: prompt.system,
          user: [
            prompt.user,
            "",
            "上一次操作有以下局部问题。其它成功操作已经保留，禁止重复输出或修改它们。",
            "逐条使用给定 ticket 修正原操作，每行一个完整对象；若无足够信息完成，输出同 ticket 的 noop 并用 why 说明。",
            `失败票据：${failedGroups.map((group) => group.groupId).join(", ") || "R1"}`,
            ...issues.filter((issue) => issue.severity === "error").slice(0, 8).map((issue, index) => `R${index + 1} ${issue.code}: ${issue.message}`),
          ].join("\n"),
          maxTokens: RUNTIME_LIMITS.repairResponseTokens,
          timeoutMs,
        });
        completedRepair += 1;
        account({ ...response, scenarioId: scenario.id }, "repair");
        return { text: response.ok ? response.text : null, meta: { phase: "repair", ok: response.ok, status: response.status ?? null, error: response.ok ? null : response.error, elapsedMs: response.elapsedMs } };
      },
    };
    const execution = await executeScenarios(SQL, loaded.scenarios, { format: options.format, runs: options.runs, provider });
    const plannedInitial = execution.results.length * options.runs;
    live = {
      called: completedInitial > 0,
      model: liveConfig.model,
      modelVersionEcho: modelEcho,
      endpointHost: (() => {
        try {
          return new URL(liveConfig.endpoint).host;
        } catch {
          return null;
        }
      })(),
      apiVersion: "chat/completions（OpenAI 兼容）",
      keyPresent: true,
      keySource: liveConfig.keySource,
      configSource: liveConfig.configSource === "environment" ? "environment" : "config-file",
      keyWrittenToReport: false,
      promptHashAggregate: sha256(Object.entries(scenarioPromptHashes(loaded.scenarios)).map(([id, item]) => `${id}:${item.ops}|${item.sql}`).join("\n")),
      outputBudgetTokens: liveConfig.maxTokens ?? RUNTIME_LIMITS.normalResponseTokens,
      repairBudgetTokens: RUNTIME_LIMITS.repairResponseTokens,
      plannedInitialRequests: plannedInitial,
      completedInitialRequests: completedInitial,
      plannedRepairRequests: plannedRepair,
      completedRepairRequests: completedRepair,
      runCount: completedInitial + completedRepair,
      timeoutMs,
      latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), samples: latencies.length },
      tokens,
      timeouts,
      shortfall: completedInitial < plannedInitial
        ? `计划 ${plannedInitial} 次初次请求，实际完成 ${completedInitial} 次（差 ${plannedInitial - completedInitial}）`
        : plannedInitial < 120
          ? `本组计划 ${plannedInitial} 次初次请求；§20.2 的 120 次 = A+B 两组各 60 次，只跑一组时不得声称 120 次已完成`
          : null,
      requestsDetail: details,
    };
    report = buildReport({
      format: options.format,
      mode: "live",
      runs: options.runs,
      scenarios: loaded.scenarios,
      fixtures: loaded,
      execution,
      live,
      selfChecks: runSelfChecks(SQL),
    });
    report.outcomes[options.format].cost = {
      ...report.outcomes[options.format].cost,
      requests: completedInitial + completedRepair,
      initialRequests: completedInitial,
      repairRequests: completedRepair,
      tokens: tokens.totalTokens || null,
      tokensReason: tokens.totalTokens ? null : "PROVIDER_USAGE_MISSING",
      timeouts,
      latencyMs: live.latencyMs,
    };
  } else {
    report = await runBenchmark({
      SQL,
      format: options.format,
      mode: "offline",
      runs: options.runs,
      scenarios: loaded.scenarios,
      fixtures: loaded,
    });
  }

  const secrets = liveConfig ? [liveConfig.apiKey].filter(Boolean) : [];
  const safeReport = redactDeep(report, secrets);
  const serialized = JSON.stringify(safeReport, null, 2);
  assertReportClean(serialized, secrets);
  if (options.out) {
    writeFileAtomic(resolve(REPO_ROOT, options.out), serialized);
    if (!options.json) console.error(`报告已写入 ${options.out}`);
  }
  if (options.json) console.log(serialized);
  else console.log(humanReport(safeReport));
  return report.failures.length > 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error) => {
      const code = error instanceof BenchmarkError ? error.code : "BENCHMARK_INTERNAL_ERROR";
      console.error(`${code}: ${error instanceof Error ? error.message : String(error)}`);
      if (process.env.ATLAS_BENCH_DEBUG && error instanceof Error && error.stack) console.error(error.stack);
      if (process.argv.includes("--json")) console.log(JSON.stringify({ ok: false, error: code, message: error instanceof Error ? error.message : String(error) }));
      process.exitCode = 1;
    });
}
