import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const {
  sanitizeDiagnostic, createAtlasDiagnosticsSink, atlasRefFingerprint,
  isAtlasRefFingerprint, chatFingerprintFromRef, namedDiagnosticSpec,
  namedDiagnosticInput, ATLAS_NAMED_DIAGNOSTICS,
} = await import(pathToFileURL(resolve(root, "src/atlas-diagnostics.ts")).href);

const base = {
  level: "error", source: "model", code: "MODEL_REQUEST_FAILED",
  operation: "generation", phase: "response", outcome: "failed",
  traceId: "turn-abc-1", attemptId: "attempt-2", chatRef: "chat-ab12cd34",
  httpStatus: 401, details: { route: "model-proxy", mode: "custom" },
};

test("diagnostic sanitizer rejects all unlisted text and original identifiers", () => {
  const secret = "sk-secret-private";
  const raw = {
    ...base,
    traceId: "chat-real-id",
    chatRef: "real-chat-id",
    request: { headers: { Authorization: "Bearer " + secret } },
    response: secret,
    url: "https://example.invalid/path?token=" + secret,
    error: new Error(secret),
    details: {
      ...base.details,
      prompt: secret,
      response: secret,
      route: "/private/" + secret,
      mode: "custom",
      schemaPath: secret,
      responseChars: 12,
    },
  };
  const entry = sanitizeDiagnostic(raw, () => 1000);
  assert.ok(entry);
  const exported = JSON.stringify(entry);
  assert.equal(exported.includes(secret), false);
  assert.equal(exported.includes("real-chat-id"), false);
  assert.equal(exported.includes("Bearer"), false);
  assert.equal(entry.details.route, undefined);
  assert.equal(entry.details.mode, "custom");
  assert.equal(entry.details.responseChars, 12);
});

test("diagnostics ring keeps recent errors under info pressure and merges repeats", () => {
  let clock = 1000;
  const sink = createAtlasDiagnosticsSink({ now: () => clock, capacity: 100 });
  sink.emit(base);
  for (let i = 0; i < 120; i++) {
    clock += 3000;
    sink.emit({ ...base, level: "info", code: "MODEL_HTTP_COMPLETE", phase: "request",
      traceId: "turn-x-" + i, outcome: "success" });
  }
  assert.equal(sink.getSnapshot().length, 100);
  assert.ok(sink.getSnapshot().some((entry) => entry.code === "MODEL_REQUEST_FAILED"));
  clock += 3000;
  sink.emit(base);
  clock += 100;
  sink.emit(base);
  const last = sink.getSnapshot().at(-1);
  assert.equal(last.count, 2);
  assert.equal(sink.exportSafe("chat-other"), "");
});

test("distinct rejected row diagnostics keep their line and path instead of merging", () => {
  const sink = createAtlasDiagnosticsSink({ now: () => 1000 });
  for (const [rowLine, reasonCode, schemaPath] of [
    [1, "QUOTE_REQUIRED", "$.quote"],
    [2, "DEPENDENCY_FAILED", "$.locationRef"],
    [3, "DEPENDENCY_FAILED", "$.patch.locationRef"],
  ]) {
    sink.emit({ ...base, source: "engine", code: "WORLD_TURN_DELTA_ROW_REJECTED",
      details: { rowLine, reasonCode, schemaPath, quote: "故事里的秘密" } });
  }
  const entries = sink.getSnapshot();
  assert.deepEqual(entries.map((entry) => entry.details.rowLine), [1, 2, 3]);
  assert.deepEqual(entries.map((entry) => entry.details.reasonCode),
    ["QUOTE_REQUIRED", "DEPENDENCY_FAILED", "DEPENDENCY_FAILED"]);
  assert.equal(JSON.stringify(entries).includes("故事里的秘密"), false);
  assert.equal(sanitizeDiagnostic({ ...base, details: { rowLine: -1 } }).details, undefined);
});

test("session storage restores only safe warning and error metadata", () => {
  const data = new Map();
  const persist = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
  const sink = createAtlasDiagnosticsSink({ persist, now: () => 1000 });
  sink.emit(base);
  sink.emit({ ...base, level: "info", code: "MODEL_HTTP_COMPLETE", outcome: "success" });
  const restored = createAtlasDiagnosticsSink({ persist, now: () => 2000 });
  assert.deepEqual(restored.getSnapshot().map((entry) => entry.code), ["MODEL_REQUEST_FAILED"]);
  restored.clear();
  assert.equal(data.size, 0);
});

test("storage quota failure only affects diagnostics", () => {
  const persist = {
    getItem: () => null,
    setItem: () => { throw new Error("quota"); },
    removeItem: () => {},
  };
  const sink = createAtlasDiagnosticsSink({ persist, now: () => 1000, capacity: 100 });
  assert.doesNotThrow(() => sink.emit(base));
  assert.deepEqual(sink.getSnapshot().map((entry) => entry.code),
    ["MODEL_REQUEST_FAILED", "DIAGNOSTICS_STORAGE_UNAVAILABLE"]);
});

test("persistent archive is opt in, expires, and clears on disable", () => {
  const data = new Map();
  const archive = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
  let clock = 10_000;
  const sink = createAtlasDiagnosticsSink({ archive, now: () => clock });
  sink.emit(base);
  assert.equal(data.size, 0);
  sink.setArchiveEnabled(true);
  assert.equal(data.size, 1);
  sink.emit({ ...base, level: "info", code: "MODEL_HTTP_COMPLETE", outcome: "success" });
  const restored = createAtlasDiagnosticsSink({ archive, archiveEnabled: true, now: () => clock + 1000 });
  assert.deepEqual(restored.getSnapshot().map((entry) => entry.code), ["MODEL_REQUEST_FAILED"]);
  restored.setArchiveEnabled(false);
  assert.equal(data.size, 0);
  sink.setArchiveEnabled(true);
  clock += 8 * 86_400_000;
  const expired = createAtlasDiagnosticsSink({ archive, archiveEnabled: true, now: () => clock });
  assert.equal(expired.getSnapshot().length, 0);
});

test("archive write failure is recorded without blocking gameplay", () => {
  const archive = {
    getItem: () => null,
    setItem: () => { throw new Error("quota"); },
    removeItem: () => {},
  };
  const sink = createAtlasDiagnosticsSink({ archive, archiveEnabled: true, now: () => 1000 });
  assert.doesNotThrow(() => sink.emit(base));
  assert.deepEqual(sink.getSnapshot().map((entry) => entry.code),
    ["MODEL_REQUEST_FAILED", "DIAGNOSTICS_STORAGE_UNAVAILABLE"]);
});

// ---------------------------------------------------------------------------
// A11（0.9.52）：0.9.54 新增的安全诊断字段必须保留，且不得成为新的泄露口
// ---------------------------------------------------------------------------

test("A11 保留 schemaPath / reasonCode / responseChars / coreCommitted", () => {
  const entry = sanitizeDiagnostic({
    ...base,
    code: "WORLD_TURN_V2_REJECTED",
    errorCode: "RESPONSE_MALFORMED",
    count: 3,
    details: {
      schemaPath: "$.relationUpdates[0].value",
      reasonCode: "LEDGER_VALIDATION_FAILED",
      responseChars: 3000,
      coreCommitted: false,
    },
  }, () => 1000);
  assert.ok(entry, "诊断应被保留");
  assert.equal(entry.details.schemaPath, "$.relationUpdates[0].value", "JSON 路径可保留（排障必需）");
  assert.equal(entry.details.reasonCode, "LEDGER_VALIDATION_FAILED", "安全失败代码可保留");
  assert.equal(entry.details.responseChars, 3000, "真实响应字符数可保留");
  assert.equal(entry.details.coreCommitted, false, "核心是否落账可保留");
  assert.equal(entry.count, 3, "校验失败条数是顶层计数字段");
});

test("A11 未列名字段一律丢弃（引文 / 姓名 / endpoint / 密钥不得进入诊断）", () => {
  const quote = "废墟深处";
  const name = "薇尔·星环";
  const endpoint = "https://api.example.invalid/v1/chat/completions";
  const key = "sk-live-abcdefghijklmnop";
  const entry = sanitizeDiagnostic({
    ...base,
    code: "WORLD_TURN_V2_REJECTED",
    details: {
      schemaPath: "$.relationUpdates[0].value",
      // 有效字段，确保 details 非空（空 details 会被整体省略）
      responseChars: 3000,
      // 以下均为未列入 DETAIL_KEYS 的字段名 → 必须整体丢弃
      excerpt: `模型原文：${quote}`,
      quote,
      characterName: name,
      endpoint,
      apiKey: key,
      prompt: key,
      summary: `${name} 与玩家关系变为依赖`,
    },
  }, () => 1000);
  assert.ok(entry);
  assert.ok(entry.details, "诊断应带有 details（含合法字段）");
  const exported = JSON.stringify(entry);
  for (const [label, secret] of [["引文", quote], ["姓名", name], ["endpoint", endpoint], ["密钥", key]]) {
    assert.equal(exported.includes(secret), false, `${label} 不得出现在诊断导出中`);
  }
  assert.equal(entry.details.excerpt, undefined, "excerpt 字段名未列入白名单");
  assert.equal(entry.details.summary, undefined, "summary 字段名未列入白名单");
  assert.equal(entry.details.quote, undefined, "quote 字段名未列入白名单");
  assert.equal(entry.details.apiKey, undefined, "apiKey 字段名未列入白名单");
  assert.equal(entry.details.schemaPath, "$.relationUpdates[0].value", "同批次合法字段仍保留");
  assert.equal(entry.details.responseChars, 3000, "同批次合法字段仍保留");
});

test("A11 非法 schemaPath（带引文 / URL）被丢弃，不因新字段放宽形状校验", () => {
  for (const [label, bad] of [
    ["带引文", '$.relationUpdates[0].value"废墟深处"'],
    ["带 URL", "$.https://api.example.invalid/v1"],
    ["带空格中文", "$.关系 值"],
    ["超长", "$." + "a".repeat(120)],
  ]) {
    const entry = sanitizeDiagnostic({
      ...base,
      code: "WORLD_TURN_V2_REJECTED",
      details: { schemaPath: bad, responseChars: 10 },
    }, () => 1000);
    assert.ok(entry, `${label}：诊断本身仍应产出`);
    assert.equal(entry.details.schemaPath, undefined, `${label}：非法 schemaPath 必须丢弃`);
    assert.equal(entry.details.responseChars, 10, `${label}：其它合法字段不受牵连`);
  }
});

test("v2 JSON 顶层解析错误保留根路径 $，不吞掉唯一诊断线索", () => {
  const entry = sanitizeDiagnostic({
    ...base,
    code: "WORLD_TURN_V2_REJECTED",
    details: { schemaPath: "$", responseChars: 41232, count: 1 },
  }, () => 1000);
  assert.ok(entry);
  assert.equal(entry.details.schemaPath, "$", "JSON 解析错误的真实路径必须出现在安全诊断中");
  assert.equal(entry.details.responseChars, 41232);
});

test("A11 单条诊断体积上限：即便字段全拉满也远低于 2048 字节安全阀", () => {
  // 实测各键上限后确认：字符串型 details 键中，只有 stage 接受任意串（≤64），
  // route/mode/capability/event/protocolVersion/reasonCode 都是精确白名单/定点形状，
  // schemaPath 为 JSONPath；再叠加数值与布尔键，单条理论最大约 788 字节。
  // 即：2048 安全阀在当前输入约束下不可达。本用例把这条不变量钉住——
  // 将来若有人放宽任一字段上限，这里会先失败。
  const A = (n) => "a".repeat(n);
  const maximal = sanitizeDiagnostic({
    level: "error", source: "engine", code: "WORLD_TURN_V2_REJECTED",
    operation: A(119), phase: A(119), outcome: "failed",
    errorCode: "RESPONSE_MALFORMED", httpStatus: 599, retryable: true,
    durationMs: 86_400_000, count: 1_000_000,
    traceId: "turn-abc-99999999", attemptId: "attempt-999999", chatRef: "chat-abcdefgh",
    details: {
      route: "model-proxy", mode: "custom", capability: "world-turn",
      protocolVersion: "v2", event: "WORLD_TURN_V2_REJECTED",
      reasonCode: "LEDGER_VALIDATION_FAILED",
      schemaPath: "$." + A(100),
      stage: A(64),
      responseChars: 999_999_999, coreCommitted: true,
      scanned: 999_999, cleaned: 999_999, kept: 999_999, malformed: 999_999,
      count: 1_000_000, attempt: 999_999, build: A(64),
    },
  }, () => 1000);

  assert.ok(maximal, "满字段诊断应被保留");
  const size = new TextEncoder().encode(JSON.stringify(maximal)).length;
  assert.ok(size < 2048, `满字段单条应低于 2048 字节，实际 ${size}`);
  assert.equal(maximal.truncated, undefined, "未触发体积安全阀");
  assert.ok(maximal.details, "details 未被剥离");
});

test("A11 体积安全阀行为：超限时剥离 details 并标 truncated，保留安全代码（不丢弃整条）", () => {
  // 该分支在真实输入约束下不可达，因此用受控的 TextEncoder 报告超大字节数来确定性
  // 触发它。锁定的语义是：宁可牺牲「细节」也要保住「安全代码 / 错误码 / 等级」——
  // 丢弃整条会让最需要排障的那条日志直接消失。
  const original = globalThis.TextEncoder;
  class HugeEncoder {
    encode() { return { length: 4096 }; }
  }
  globalThis.TextEncoder = HugeEncoder;
  try {
    const entry = sanitizeDiagnostic({
      level: "error", source: "engine", code: "WORLD_TURN_V2_REJECTED",
      operation: "engine", phase: "world-turn-v2-rejected", outcome: "failed",
      errorCode: "RESPONSE_MALFORMED",
      details: { schemaPath: "$.relationUpdates[0].value", responseChars: 3000 },
    }, () => 1000);

    assert.ok(entry, "超限诊断本身仍须保留（不得整条丢弃）");
    assert.equal(entry.truncated, true, "标记 truncated");
    assert.equal(entry.details, undefined, "剥离 details（细节是体积来源）");
    assert.equal(entry.code, "WORLD_TURN_V2_REJECTED", "安全代码保留，排障仍可用");
    assert.equal(entry.errorCode, "RESPONSE_MALFORMED", "错误码保留");
    assert.equal(entry.level, "error", "等级保留");
    assert.equal(entry.phase, "world-turn-v2-rejected", "阶段保留（定位仍可行）");
  } finally {
    globalThis.TextEncoder = original;
  }
});

// ---------------------------------------------------------------------------
// A04：具名诊断的安全定位字段（chat / branch / turn 的脱敏指纹）
// ---------------------------------------------------------------------------

// atlasRefFingerprint 内部用 TextEncoder。Node 的 TextEncoder.encode 会复用上一次的
// encoding 结果，而本文件前面的 A11 体积安全阀用例会临时把 globalThis.TextEncoder 换成
// 返回 {length} 的假实现（并在 finally 里还原）。这里在模块加载期捕获真实现并独占使用，
// 让 A04 断言不受任何全局替换影响；同时先确认前置用例确实还原过全局。
const RealTextEncoder = globalThis.TextEncoder;
test("A04 前置：全局 TextEncoder 未被前置用例留成假实现", () => {
  assert.equal(typeof globalThis.TextEncoder, "function");
  const probe = new globalThis.TextEncoder().encode("ab");
  assert.ok(probe instanceof Uint8Array, "前置用例必须还原真正的 TextEncoder");
  assert.equal(probe.length, 2);
});

const A04_CODES = [
  "SESSION_IDENTITY_MISMATCH",
  "SIMULATION_CORRUPT",
  "SIMULATION_TRUNCATED",
  "LOREBOOK_STALE_CHAT_DROPPED",
  "BACKGROUND_BLOCKED",
];

// A04 的五个具名诊断各自允许的 details（键名与注册表一致，另会逐条核对注册表）。
// chatFingerprint 不在 details 里：它是顶层字段，注册表把「chatFingerprint」列为可传键后，
// namedDiagnosticInput 会把它镜像到顶层，避免同一条日志出现两个含义相同的键。
const A04_DETAIL_KEYS = {
  SESSION_IDENTITY_MISMATCH: ["branchRef", "reasonCode", "stage"],
  SIMULATION_CORRUPT: ["branchRef", "schemaPath", "reasonCode"],
  SIMULATION_TRUNCATED: ["branchRef", "collection", "droppedCount", "keptCount", "limitCount", "reasonCode"],
  LOREBOOK_STALE_CHAT_DROPPED: ["branchRef", "reasonCode", "stage"],
  BACKGROUND_BLOCKED: ["branchRef", "turnRef", "taskRef", "actorRef", "locationRef", "reasonCode"],
};
// 注册表里额外允许的顶层定位键（不落 details）。
const A04_REGISTRY_EXTRA_KEYS = ["chatFingerprint"];

const A04_CHAT_ID = "chat-9f2c41ab77de";
const A04_CHINESE_BODY = "助手正文：使者带着宣战文书离开了学校，城门守军随即关闭了南门。";
const A04_RAW_CHAT_ID = "9f2c41ab77de";

// 测试侧独立实现的同款哈希（UTF-8 字节 → 64 位 FNV-1a → 雪崩收尾）。它只依赖 load 期
// 捕获的 RealTextEncoder，既不读 atlasRefFingerprint 的常量、也不看全局 TextEncoder，
// 因此既能交叉验证导出实现，又不会被本文件的 TextEncoder 假实现污染。
function expectedFingerprint(raw) {
  const bytes = new RealTextEncoder().encode(raw);
  const MASK = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash = (hash ^ BigInt(byte)) & MASK;
    hash = (hash * 0x100000001b3n) & MASK;
  }
  hash = (hash ^ (hash >> 30n)) & MASK;
  hash = (hash * 0xbf58476d1ce4e5b9n) & MASK;
  hash = (hash ^ (hash >> 27n)) & MASK;
  hash = (hash * 0x94d049bb133111ebn) & MASK;
  hash = (hash ^ (hash >> 31n)) & MASK;
  return "ref-" + hash.toString(16).padStart(16, "0");
}

/** 在真正可用的 TextEncoder 下跑 A04 诊断（前置用例的假实现已还原，这里再兜一层底）。 */
function withRealTextEncoder(body) {
  const restore = globalThis.TextEncoder;
  globalThis.TextEncoder = RealTextEncoder;
  try {
    return body();
  } finally {
    globalThis.TextEncoder = restore;
  }
}

const A04_CHAT_FP = expectedFingerprint(A04_CHAT_ID);
const A04_BRANCH_FP = expectedFingerprint("if-branch-圣罗兰线");
const A04_TURN_FP = expectedFingerprint("turn-1727000000000-7");
const A04_WORLD_FP = expectedFingerprint("world-auto-0f1e2d3c4b5a6978");
const A04_ACTOR_FP = expectedFingerprint("npc:薇尔·星环");
const A04_LOCATION_FP = expectedFingerprint("loc:三年二班");
const A04_TASK_FP = expectedFingerprint("sim-task-0000000000000042");
const A04_SIGNAL_FP = expectedFingerprint("sim-signal-0000000000000007");

test("A04 指纹工具：形态固定、确定性、且不含原始字符串片段", () => {
  withRealTextEncoder(() => {
    for (const raw of [A04_CHAT_ID, "branch:canon", "turn-1727000000000-7", A04_CHINESE_BODY]) {
      const first = atlasRefFingerprint(raw);
      for (let i = 0; i < 3; i += 1) {
        assert.equal(atlasRefFingerprint(raw), first, "同一输入永远得到同一指纹（不随调用次数变化）");
      }
      assert.match(first, /^ref-[a-f0-9]{16}$/, "固定形态：ref- + 16 位小写十六进制");
      assert.ok(isAtlasRefFingerprint(first), "产出的指纹必须通过形状校验");
      // 指纹只由十六进制数字与固定前缀构成：原文的任何片段（首 4 / 末 4 字符、整串）都不得出现。
      for (const fragment of [raw.slice(0, 4), raw.slice(-4), raw]) {
        assert.equal(first.includes(fragment), false, `指纹不得包含原始片段 ${JSON.stringify(fragment)}`);
      }
      assert.equal(first, expectedFingerprint(raw), "与测试侧独立实现一致（锁定哈希算法）");
    }
    // 非字符串输入按空串处理：不抛异常，结果稳定（NaN 也照此处理）。
    assert.equal(atlasRefFingerprint(null), atlasRefFingerprint(""));
    assert.equal(atlasRefFingerprint(undefined), atlasRefFingerprint(""));
    assert.equal(atlasRefFingerprint(Number.NaN), atlasRefFingerprint(""));
    // 顶层 chatRef（chat-<hex>）与裸 chatId 必须归一到同一指纹：服务端只有 ref、前端只有 id，
    // 两边记的同一条日志要能对上；非法输入返回 null 而不是原文。
    assert.equal(chatFingerprintFromRef(A04_CHAT_ID), atlasRefFingerprint("9f2c41ab77de"));
    assert.equal(chatFingerprintFromRef("9f2c41ab77de"), atlasRefFingerprint("9f2c41ab77de"));
    assert.equal(chatFingerprintFromRef("real chat id with spaces"), null);
    assert.equal(chatFingerprintFromRef(42), null);
  });
  // 定点值：锁定「64 位 FNV-1a + 雪崩收尾」，防止有人换成随进程变化的哈希。
  assert.equal(A04_CHAT_FP, "ref-2d303455c771da49");
  assert.equal(expectedFingerprint(""), "ref-f52a15e9a9b5e89b");
});

test("A04 指纹确定性：不同输入不碰撞（含 200 个相邻 chatId 抽样）", () => {
  withRealTextEncoder(() => {
    assert.notEqual(atlasRefFingerprint(A04_CHAT_ID), atlasRefFingerprint("chat-9f2c41ab77df"),
      "只差一个字符的 chatId 不应碰撞");
    assert.notEqual(atlasRefFingerprint(A04_CHAT_ID), atlasRefFingerprint("if-branch-圣罗兰线"),
      "不同语义的输入不应碰撞");
    assert.notEqual(atlasRefFingerprint(A04_CHAT_ID), atlasRefFingerprint("npc:薇尔·星环"),
      "不同命名空间的输入不应碰撞");
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      const raw = `chat-9f2c41ab77de-${i}`;
      const value = atlasRefFingerprint(raw);
      assert.equal(value, expectedFingerprint(raw), `${raw}：与独立实现一致`);
      seen.add(value);
    }
    assert.equal(seen.size, 200, "相邻输入不应碰撞");
    // 指纹常量本身也必须等于导出实现的结果（防止常量与实现漂移）。
    assert.equal(atlasRefFingerprint("if-branch-圣罗兰线"), A04_BRANCH_FP);
    assert.equal(atlasRefFingerprint("turn-1727000000000-7"), A04_TURN_FP);
    assert.equal(atlasRefFingerprint("world-auto-0f1e2d3c4b5a6978"), A04_WORLD_FP);
    assert.equal(atlasRefFingerprint("npc:薇尔·星环"), A04_ACTOR_FP);
    assert.equal(atlasRefFingerprint("loc:三年二班"), A04_LOCATION_FP);
    assert.equal(atlasRefFingerprint("sim-task-0000000000000042"), A04_TASK_FP);
    assert.equal(atlasRefFingerprint("sim-signal-0000000000000007"), A04_SIGNAL_FP);
  });
});

test("A04 定位闭环：同聊天按 chatRef 与裸 chatId 得到同一指纹，异聊不混", () => {
  withRealTextEncoder(() => {
    // 服务端只有 binding.chatId（裸 id），前端有 chatRef（chat-<hex>）：两条日志必须能对上。
    const fromRef = sanitizeDiagnostic({
      ...base, code: "SESSION_IDENTITY_MISMATCH",
      chatFingerprint: chatFingerprintFromRef(A04_CHAT_ID),
      details: { branchRef: A04_BRANCH_FP, reasonCode: "STALE_MIGRATION_DROPPED" },
    }, () => 1000);
    const fromRaw = sanitizeDiagnostic({
      ...base, code: "SESSION_IDENTITY_MISMATCH",
      chatFingerprint: atlasRefFingerprint("9f2c41ab77de"),
      details: { branchRef: A04_BRANCH_FP, reasonCode: "STALE_MIGRATION_DROPPED" },
    }, () => 1000);
    assert.ok(fromRef.chatFingerprint && fromRaw.chatFingerprint);
    assert.equal(fromRef.chatFingerprint, fromRaw.chatFingerprint, "同聊天必须得到同一指纹（可跨会话比对）");
    // 另一个聊天：指纹不同，且原始 id 一个都不出现。
    const other = sanitizeDiagnostic({
      ...base, code: "SESSION_IDENTITY_MISMATCH",
      chatFingerprint: atlasRefFingerprint("chat-0000deadbeef"),
      details: { branchRef: A04_BRANCH_FP, reasonCode: "STALE_MIGRATION_DROPPED" },
    }, () => 1000);
    assert.notEqual(other.chatFingerprint, fromRef.chatFingerprint, "不同聊天不得混为同一指纹");
    const exported = JSON.stringify([fromRef, fromRaw, other]);
    for (const secret of ["9f2c41ab77de", "0000deadbeef", "if-branch-圣罗兰线"]) {
      assert.equal(exported.includes(secret), false, `导出不得含原始标识：${secret}`);
    }
  });
});

test("A04 五个具名诊断各自都能生成合法诊断", () => {
  const detailValues = {
    chatFingerprint: A04_CHAT_FP,
    branchRef: A04_BRANCH_FP,
    turnRef: A04_TURN_FP,
    worldRef: A04_WORLD_FP,
    actorRef: A04_ACTOR_FP,
    locationRef: A04_LOCATION_FP,
    taskRef: A04_TASK_FP,
    signalRef: A04_SIGNAL_FP,
    collection: "tasks",
    droppedCount: 48,
    keptCount: 16,
    limitCount: 64,
    truncatedCount: 3,
    scannedCount: 20,
    reasonCode: "NO_PATH",
    schemaPath: "$.simulation.branches.canon.tasks[0].id",
    stage: "rebuild",
  };
  for (const code of A04_CODES) {
    const input = namedDiagnosticInput({
      code,
      operation: "atlas-session",
      phase: "a04-named",
      outcome: "failed",
      chatRef: A04_CHAT_ID,
      chatFingerprint: A04_CHAT_FP,
      ...(code === "SIMULATION_CORRUPT" ? { errorCode: "SIMULATION_CORRUPT" } : {}),
      details: Object.fromEntries(A04_DETAIL_KEYS[code].map((key) => [key, detailValues[key]])),
    });
    assert.ok(input, `${code}：注册表应能组装诊断输入`);
    const entry = sanitizeDiagnostic(input, () => 1000);
    assert.ok(entry, `${code}：应产出合法诊断`);
    assert.equal(entry.code, code);
    assert.equal(entry.chatFingerprint, A04_CHAT_FP, `${code}：聊天指纹（顶层）可定位`);
    assert.deepEqual(Object.keys(entry.details).sort(), [...A04_DETAIL_KEYS[code]].sort(),
      `${code}：契约内的键全部保留，契约外的键不出现`);
    assert.equal(entry.details.branchRef, A04_BRANCH_FP, `${code}：分支指纹可定位`);
    assert.equal(entry.chatRef, "chat-9f2c41ab77de", `${code}：旧 chatRef 契约未被改动`);
    const exported = JSON.stringify(entry);
    // details 与指纹字段里不得出现任何原始标识或正文。chatRef 是 0.9.52 起就存在的顶层字段
    // （旧契约固定 chat-<hex> 形态），A04 不改变它的含义，故这里单独排除后审计其余部分。
    const scan = JSON.stringify({ chatFingerprint: entry.chatFingerprint, details: entry.details });
    for (const secret of ["if-branch-圣罗兰线", "turn-1727000000000-7", "9f2c41ab77de", A04_CHINESE_BODY]) {
      assert.equal(scan.includes(secret), false, `${code}：不得含原始标识或正文：${secret}`);
    }
    // 审计用：details 里的定位键只能是 ref- 指纹形态（顶层 chatRef 是旧契约，不计入）。
    for (const ref of JSON.stringify(entry.details).match(/"(?:branch|turn|world|actor|location|signal|task)Ref":"[^"]*"/g) ?? []) {
      assert.match(ref, /Ref":"ref-[a-f0-9]{16}"$/, `${code}：定位键的值必须是指纹形态`);
    }
  }
});

test("A04 未注册的 code 组装为 null，不会用自由字符串写出诊断", () => {
  assert.equal(namedDiagnosticInput({
    code: "FREE_FORM_EVENT", operation: "atlas", phase: "whatever", outcome: "failed",
  }), null);
  assert.equal(namedDiagnosticSpec("FREE_FORM_EVENT"), null);
});

test("A04 各 *Ref 字段只接受指纹形态：原始 chatId / turnKey / 分支名 / 正文一律丢弃", () => {
  const entry = sanitizeDiagnostic({
    ...base,
    code: "SESSION_IDENTITY_MISMATCH",
    chatFingerprint: A04_CHAT_ID, // 原始 chatId 冒充指纹 → 必须丢弃
    details: {
      branchRef: "if-branch-圣罗兰线",
      turnRef: "turn-1727000000000-7",
      worldRef: A04_WORLD_FP,     // 唯一合法项：仍须保留
      actorRef: A04_CHAT_ID,
      locationRef: A04_CHAT_ID,
      taskRef: A04_CHAT_ID,
      signalRef: A04_CHAT_ID,
      droppedCount: 3,
    },
  }, () => 1000);
  assert.ok(entry);
  assert.equal(entry.chatFingerprint, undefined, "原始 chatId 不得冒充顶层聊天指纹");
  assert.equal(entry.details.branchRef, undefined, "原始分支名必须丢弃");
  assert.equal(entry.details.turnRef, undefined, "原始 turnKey 必须丢弃");
  assert.equal(entry.details.actorRef, undefined, "原始 chatId 冒充 actorRef 必须丢弃");
  assert.equal(entry.details.locationRef, undefined);
  assert.equal(entry.details.taskRef, undefined);
  assert.equal(entry.details.signalRef, undefined);
  assert.equal(entry.details.worldRef, A04_WORLD_FP, "合法指纹仍保留，其它字段不被牵连");
  assert.equal(entry.details.droppedCount, 3);
  const exported = JSON.stringify(entry);
  for (const secret of [A04_CHAT_ID, "if-branch-圣罗兰线", "turn-1727000000000-7", "9f2c41ab77de"]) {
    assert.equal(exported.includes(secret), false, `导出不得含 ${secret}`);
  }
  // 指纹形状的边界：8–16 位小写十六进制以外（大写 / 过短 / 过长 / 前缀不符）全部丢弃。
  for (const bad of ["ref-ABCDEF12", "ref-abc", "ref-0123456789abcdef0", "ref-", "fingerprint-0123abcd",
    "ref-0123456789abcdeZ", A04_CHINESE_BODY, "ref-0123abcd" + A04_CHINESE_BODY]) {
    const probe = sanitizeDiagnostic({
      ...base, code: "SIMULATION_TRUNCATED", details: { branchRef: bad, keptCount: 1 },
    }, () => 1000);
    assert.equal(probe.details.branchRef, undefined, `非法指纹形态必须丢弃：${bad.slice(0, 24)}`);
    assert.equal(probe.details.keptCount, 1, "同批次合法字段不受牵连");
  }
  // 8 位下界的合法指纹仍接受（旧调用方可能只取 8 位）。
  const short = sanitizeDiagnostic({
    ...base, code: "SIMULATION_TRUNCATED", details: { branchRef: "ref-0123abcd", keptCount: 1 },
  }, () => 1000);
  assert.equal(short.details.branchRef, "ref-0123abcd");
});

test("A04 原始 ID 与长段正文冒充 schemaPath / 任意 details 键时必须被丢弃", () => {
  const entry = sanitizeDiagnostic({
    ...base,
    code: "SIMULATION_CORRUPT",
    details: {
      chatFingerprint: A04_CHAT_FP,
      branchRef: A04_BRANCH_FP,
      schemaPath: "$.simulation.branches.canon.tasks[0].id",
      reasonCode: "SIMULATION_CORRUPT",
      // 以下均为未列入 DETAIL_KEYS 的键名 → 整个键丢弃（值再合法也进不去）
      chatId: A04_CHAT_ID,
      turnKey: "turn-1727000000000-7",
      branchName: "if-branch-圣罗兰线",
      quote: A04_CHINESE_BODY,
      excerpt: A04_CHINESE_BODY,
      prompt: A04_CHINESE_BODY,
      response: A04_CHINESE_BODY,
      summary: A04_CHINESE_BODY,
      url: "https://api.example.invalid/v1/chat/completions",
    },
  }, () => 1000);
  assert.ok(entry);
  assert.equal(entry.details.schemaPath, "$.simulation.branches.canon.tasks[0].id", "合法 JSON 路径保留");
  for (const key of ["chatId", "turnKey", "branchName", "quote", "excerpt", "prompt", "response", "summary", "url"]) {
    assert.equal(entry.details[key], undefined, `${key} 未列入白名单，必须整体丢弃`);
  }
  // 同批次里用合法键夹带原始文本：schemaPath 形状校验兜住，长中文正文进不去。
  const smuggled = sanitizeDiagnostic({
    ...base,
    code: "SIMULATION_CORRUPT",
    details: {
      schemaPath: "$.simulation." + A04_CHINESE_BODY,
      branchRef: A04_BRANCH_FP,
      reasonCode: A04_CHINESE_BODY,
    },
  }, () => 1000);
  assert.equal(smuggled.details.schemaPath, undefined, "夹带正文的 schemaPath 丢弃");
  assert.equal(smuggled.details.reasonCode, undefined, "夹带正文的 reasonCode 丢弃");
  assert.equal(smuggled.details.branchRef, A04_BRANCH_FP, "合法定位指纹不受牵连");
  const exported = JSON.stringify(entry) + JSON.stringify(smuggled);
  for (const secret of [A04_CHAT_ID, "turn-1727000000000-7", "if-branch-圣罗兰线", A04_CHINESE_BODY,
    "https://api.example.invalid/v1/chat/completions"]) {
    assert.equal(exported.includes(secret), false, `导出不得含 ${secret}`);
  }
});

test("A04 collection 只接受三表/拓扑数组名，其余取值丢弃", () => {
  for (const collection of ["tasks", "signals", "deliveries", "edges", "areas", "vehicles"]) {
    const entry = sanitizeDiagnostic({
      ...base, code: "SIMULATION_TRUNCATED",
      details: { collection, droppedCount: 1, limitCount: 128 },
    }, () => 1000);
    assert.equal(entry.details.collection, collection, `${collection} 是合法集合名`);
  }
  for (const bad of ["characters", "locations", "items", "TASKS", "task", "", "tasks; DROP TABLE",
    "simulation.branches", A04_CHINESE_BODY]) {
    const entry = sanitizeDiagnostic({
      ...base, code: "SIMULATION_TRUNCATED",
      details: { collection: bad, keptCount: 2 },
    }, () => 1000);
    assert.equal(entry.details.collection, undefined, `非法集合名必须丢弃：${bad.slice(0, 20)}`);
    assert.equal(entry.details.keptCount, 2, "同批次合法字段不受牵连");
  }
});

test("A04 计数字段只接受有限非负整数并做上界钳制", () => {
  const entry = sanitizeDiagnostic({
    ...base, code: "SIMULATION_TRUNCATED",
    details: {
      droppedCount: 9_999_999, limitCount: 64, keptCount: 0,
      truncatedCount: 7.5, scannedCount: -3,
    },
  }, () => 1000);
  assert.equal(entry.details.droppedCount, 1_000_000, "上界钳制（不因越界丢整条）");
  assert.equal(entry.details.limitCount, 64);
  assert.equal(entry.details.keptCount, 0, "0 是合法计数（与顶层 count>1 的旧语义不同）");
  assert.equal(entry.details.truncatedCount, undefined, "小数不是整数计数");
  assert.equal(entry.details.scannedCount, undefined, "负数被拒绝");
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "12", true, null, { value: 1 }]) {
    const probe = sanitizeDiagnostic({
      ...base, code: "SIMULATION_TRUNCATED", details: { droppedCount: bad, keptCount: 1 },
    }, () => 1000);
    assert.equal(probe.details.droppedCount, undefined, `非有限非负整数必须丢弃：${String(bad)}`);
  }
});

test("A04 伪造的 API Key 形态字符串不能进诊断", () => {
  const key = "sk-live-abcdefghijklmnop0123456789";
  const url = "https://api.example.invalid/v1/chat/completions?key=" + key;
  const entry = sanitizeDiagnostic({
    ...base,
    code: "BACKGROUND_BLOCKED",
    chatFingerprint: key,
    details: {
      branchRef: key,
      turnRef: url,
      actorRef: "sk-" + A04_CHAT_ID,
      locationRef: "key=" + key,
      taskRef: url,
      reasonCode: key,
      stage: url,
      schemaPath: url,
      scannedCount: 12,
    },
  }, () => 1000);
  assert.ok(entry, "诊断本身仍应产出（记录被阻塞这件事本身不能丢）");
  const exported = JSON.stringify(entry);
  assert.equal(exported.includes(key), false, "API Key 不得进入诊断");
  assert.equal(exported.includes("://"), false, "URL 不得进入诊断（SAFE_ATOM 不放松）");
  assert.equal(exported.includes("sk-"), false, "密钥前缀不得进入诊断");
  assert.equal(entry.chatFingerprint, undefined);
  for (const key2 of ["branchRef", "turnRef", "actorRef", "locationRef", "taskRef", "reasonCode", "stage", "schemaPath"]) {
    assert.equal(entry.details[key2], undefined, `${key2} 不得承载密钥/URL`);
  }
  assert.equal(entry.details.scannedCount, 12, "同批次合法计数保留");
  assert.equal(entry.chatRef, "chat-ab12cd34", "旧 chatRef 字段不受影响");
});

test("A04 登录诊断源：顶层 chatFingerprint 只接受指纹，且导出仍可按 chatRef 过滤", () => {
  // 用会抛错的 persist 触碰真实的 sink 路径，确认新增字段在 emit/exportSafe 中同样生效。
  const persist = {
    getItem: () => null,
    setItem: () => { throw new Error("quota"); },
    removeItem: () => {},
  };
  const sink = createAtlasDiagnosticsSink({ persist, now: () => 1000, capacity: 100 });
  sink.emit({
    ...base,
    code: "LOREBOOK_STALE_CHAT_DROPPED",
    chatFingerprint: A04_CHAT_FP,
    source: "lorebook",
    details: { branchRef: A04_BRANCH_FP, reasonCode: "STALE_MIGRATION_DROPPED", stage: "chat-switch" },
  });
  const stored = sink.getSnapshot().find((item) => item.code === "LOREBOOK_STALE_CHAT_DROPPED");
  assert.ok(stored, "具名诊断应进入环形缓冲");
  assert.equal(stored.chatFingerprint, A04_CHAT_FP);
  assert.equal(stored.chatRef, "chat-ab12cd34", "旧字段仍在，exportSafe 过滤不受影响");
  assert.equal(sink.exportSafe("chat-other"), "");
  assert.ok(sink.exportSafe("chat-ab12cd34").includes(A04_CHAT_FP), "导出里带指纹便于定位");
  assert.equal(sink.exportSafe("chat-ab12cd34").includes(A04_CHAT_ID), false, "导出里不含原始 chatId");
});

test("A04 超长 details 仍触发 truncated 且不超 2048 字节", () => {
  const original = globalThis.TextEncoder;
  class HugeEncoder {
    encode() { return { length: 4096 }; }
  }
  globalThis.TextEncoder = HugeEncoder;
  try {
    const entry = sanitizeDiagnostic({
      ...base,
      code: "SIMULATION_TRUNCATED",
      chatFingerprint: A04_CHAT_FP,
      details: {
        branchRef: A04_BRANCH_FP,
        collection: "deliveries",
        droppedCount: 1_000_000,
        keptCount: 255,
        limitCount: 256,
        reasonCode: "LIMIT_REACHED",
      },
    }, () => 1000);
    assert.ok(entry, "超限诊断本身仍须保留（不得整条丢弃）");
    assert.equal(entry.truncated, true, "标记 truncated");
    assert.equal(entry.details, undefined, "剥离 details");
    assert.equal(entry.code, "SIMULATION_TRUNCATED", "安全代码保留");
    assert.equal(entry.chatFingerprint, A04_CHAT_FP, "定位指纹在顶层，体积超限后仍可定位");
  } finally {
    globalThis.TextEncoder = original;
  }
  // 用合法输入把新键全部拉满，实测仍在 2048 字节以内（正常路径不会触发截断）。
  const A = (n) => "a".repeat(n);
  const maximal = sanitizeDiagnostic({
    ...base,
    code: "SIMULATION_TRUNCATED",
    chatFingerprint: A04_CHAT_FP,
    operation: A(119),
    details: {
      chatFingerprint: A04_CHAT_FP,
      branchRef: A04_BRANCH_FP,
      turnRef: A04_TURN_FP,
      worldRef: A04_WORLD_FP,
      actorRef: A04_ACTOR_FP,
      locationRef: A04_LOCATION_FP,
      signalRef: A04_SIGNAL_FP,
      taskRef: A04_TASK_FP,
      collection: "vehicles",
      droppedCount: 1_000_000,
      limitCount: 1_000_000,
      keptCount: 1_000_000,
      truncatedCount: 1_000_000,
      scannedCount: 1_000_000,
      reasonCode: "LIMIT_REACHED",
      stage: A(64),
      schemaPath: "$." + A(100),
      responseChars: 999_999_999,
      coreCommitted: true,
    },
  }, () => 1000);
  assert.ok(maximal);
  const size = new TextEncoder().encode(JSON.stringify(maximal)).length;
  assert.ok(size < 2048, `满字段单条应低于 2048 字节，实际 ${size}`);
  assert.equal(maximal.truncated, undefined, "未触发体积安全阀");
});

test("A04 注册表契约：五个具名诊断的允许键固定，且不含正文/密钥/URL 型键", () => {
  assert.deepEqual(Object.keys(ATLAS_NAMED_DIAGNOSTICS).sort(), [...A04_CODES].sort(),
    "注册表恰好包含 A04 的五个具名诊断");
  assert.deepEqual([...namedDiagnosticSpec("BACKGROUND_BLOCKED").details].sort(),
    [...A04_DETAIL_KEYS.BACKGROUND_BLOCKED, ...A04_REGISTRY_EXTRA_KEYS].sort(),
    "BACKGROUND_BLOCKED 允许 taskRef / actorRef / locationRef 等安全定位键");
  const forbidden = ["prompt", "response", "quote", "excerpt", "summary", "text", "body",
    "apiKey", "key", "token", "secret", "authorization", "url", "endpoint", "chatId", "turnKey"];
  for (const [code, spec] of Object.entries(ATLAS_NAMED_DIAGNOSTICS)) {
    assert.ok(spec.details.length > 0, `${code}：必须登记允许的 details 键`);
    // 注册表的 details 契约 = 可落 details 的键 + 顶层 chatFingerprint（镜像，不落 details）。
    assert.deepEqual([...spec.details].sort(),
      [...A04_DETAIL_KEYS[code], ...A04_REGISTRY_EXTRA_KEYS].sort(),
      `${code}：允许键与文档契约一致`);
    for (const key of [...spec.details]) {
      assert.equal(forbidden.includes(key), false, `${code}：注册表不得出现 ${key}`);
      assert.equal(/^(prompt|response|quote|excerpt|summary|body|text|url|endpoint)/i.test(key), false,
        `${code}：${key} 不是安全字段名`);
    }
    assert.ok(["debug", "info", "warn", "error"].includes(spec.level), `${code}：默认等级必须合法`);
    assert.ok(["host", "ui", "engine", "model", "storage", "lorebook", "map"].includes(spec.source),
      `${code}：默认来源必须合法`);
    assert.equal(spec.code, code);
  }
  assert.equal(namedDiagnosticSpec("SIMULATION_CORRUPT").level, "error");
  assert.equal(namedDiagnosticSpec("SIMULATION_CORRUPT").source, "storage");
  assert.equal(namedDiagnosticSpec("BACKGROUND_BLOCKED").level, "info");
  assert.equal(namedDiagnosticSpec("BACKGROUND_BLOCKED").source, "engine");
});

test("A04 注册表过滤：契约外的 details 键在组装期就被剔除", () => {
  const input = namedDiagnosticInput({
    code: "BACKGROUND_BLOCKED",
    operation: "background",
    phase: "plan-moves",
    outcome: "skipped",
    chatFingerprint: A04_CHAT_FP,
    details: {
      taskRef: A04_TASK_FP,
      actorRef: A04_ACTOR_FP,
      locationRef: A04_LOCATION_FP,
      reasonCode: "NO_PATH",
      // 以下键不在 BACKGROUND_BLOCKED 契约内 → 组装期剔除
      schemaPath: "$.simulation.branches.canon.tasks[0]",
      droppedCount: 5,
      collection: "tasks",
      prompt: A04_CHINESE_BODY,
      quote: A04_CHINESE_BODY,
      url: "https://api.example.invalid/v1",
      // 未注册键名（不在 DETAIL_KEYS 里，即便传到 sanitize 也进不去）
      chatId: A04_CHAT_ID,
    },
  });
  assert.ok(input);
  // 注册表允许的 details 键保留；chatFingerprint 虽在契约内，但被镜像到顶层，不落 details。
  assert.deepEqual(Object.keys(input.details).sort(),
    ["actorRef", "locationRef", "reasonCode", "taskRef"]);
  assert.equal(input.details.chatFingerprint, undefined, "聊天指纹只走顶层");
  assert.equal(input.chatFingerprint, A04_CHAT_FP, "契约内的 chatFingerprint 镜像到顶层");
  assert.equal(input.level, "info", "默认等级来自注册表");
  assert.equal(input.source, "engine", "默认来源来自注册表");
  const entry = sanitizeDiagnostic(input, () => 1000);
  assert.equal(entry.details.taskRef, A04_TASK_FP);
  assert.equal(entry.details.schemaPath, undefined);
  assert.equal(entry.chatFingerprint, A04_CHAT_FP);
  assert.equal(JSON.stringify(entry).includes(A04_CHINESE_BODY), false);
});

test("A04 五个具名诊断走 sanitizeDiagnostic 时同样受白名单约束（共享路径）", () => {
  // 直接用注册表里的 details 键 + 一组注入键，逐 code 确认「契约内保留、契约外丢弃」。
  const injected = {
    prompt: "sk-live-abcdefghijklmnop",
    response: A04_CHINESE_BODY,
    url: "https://api.example.invalid/v1",
    chatId: A04_CHAT_ID,
    turnKey: "turn-1727000000000-7",
  };
  for (const spec of Object.values(ATLAS_NAMED_DIAGNOSTICS)) {
    const values = {
      chatFingerprint: A04_CHAT_FP,
      branchRef: A04_BRANCH_FP,
      turnRef: A04_TURN_FP,
      worldRef: A04_WORLD_FP,
      actorRef: A04_ACTOR_FP,
      locationRef: A04_LOCATION_FP,
      signalRef: A04_SIGNAL_FP,
      taskRef: A04_TASK_FP,
      collection: "signals",
      droppedCount: 4,
      keptCount: 12,
      limitCount: 64,
      truncatedCount: 2,
      scannedCount: 20,
      reasonCode: "LIMIT_REACHED",
      schemaPath: "$.simulation.branches.canon.signals",
      stage: "rebuild",
    };
    const entry = sanitizeDiagnostic({
      level: spec.level,
      source: spec.source,
      code: spec.code,
      operation: "atlas",
      phase: "named",
      outcome: "failed",
      chatFingerprint: A04_CHAT_FP,
      details: { ...injected, ...Object.fromEntries(spec.details.map((key) => [key, values[key]])) },
    }, () => 1000);
    assert.ok(entry, `${spec.code}：应产出诊断`);
    // 注册表允许的 details 键留下（chatFingerprint 只走顶层，不在 details 重复）。
    const expected = spec.details.filter((key) => key !== "chatFingerprint").sort();
    assert.deepEqual(Object.keys(entry.details).sort(), expected,
      `${spec.code}：只有注册表允许的键能留下`);
    assert.equal(entry.chatFingerprint, A04_CHAT_FP, `${spec.code}：聊天指纹在顶层可定位`);
    for (const key of Object.keys(injected)) {
      assert.equal(entry.details[key], undefined, `${spec.code}：注入键 ${key} 必须丢弃`);
    }
  }
});

test("A04 伪装的 details 对象（数组 / 原始字符串 / __proto__）不会绕过白名单", () => {
  const asArray = sanitizeDiagnostic({
    ...base, code: "SIMULATION_TRUNCATED",
    details: ["tasks", A04_CHAT_FP, A04_CHINESE_BODY],
  }, () => 1000);
  assert.equal(asArray.details, undefined, "数组型 details 整体丢弃");
  const asString = sanitizeDiagnostic({
    ...base, code: "SIMULATION_TRUNCATED", details: A04_CHINESE_BODY,
  }, () => 1000);
  assert.equal(asString.details, undefined, "字符串型 details 整体丢弃");
  assert.equal(JSON.stringify(asString).includes(A04_CHINESE_BODY), false);
  const withProto = sanitizeDiagnostic({
    ...base, code: "SIMULATION_TRUNCATED",
    details: JSON.parse(`{"__proto__":{"polluted":true},"collection":"tasks","keptCount":1}`),
  }, () => 1000);
  assert.equal(withProto.details.collection, "tasks");
  assert.equal({}.polluted, undefined, "不得污染 Object.prototype");
});
