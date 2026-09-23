import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { sanitizeDiagnostic, createAtlasDiagnosticsSink } =
  await import(pathToFileURL(resolve(root, "src/atlas-diagnostics.ts")).href);

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
// A11（0.9.52）：0.9.52 新增的安全诊断字段必须保留，且不得成为新的泄露口
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
