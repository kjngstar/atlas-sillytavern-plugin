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
