/**
 * atlas-packed-replay.test.mjs — G03 离线重放验收。
 *
 * 计划 §3-G03：**pack 之后**用**打包产物**重复关键路径，证明「发布包 = 实际跑的代码」，
 * 而不是只有源码树里的测试绿：
 *   ① 绑定 → ② 提交（行增量）→ ③ 协议不符（v2 封套必须具名拒绝且零写入）
 *   → ④ 回退 → ⑤ 任务推进（推演模块跟着走）→ ⑥ 地图
 *
 * 与其它端到端测试的区别：这里**不 import src/**，只 import `release/` 里的
 * `atlas-server-plugin/index.mjs`（它自己加载组件内的 `./dist/atlas-server.mjs`）。
 * 所以源码绿而产物坏（例如 dist 没重建、镜像没同步、版本没对齐）会被这一条抓住。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildWorldFromTemplate, getDemoTemplate } from "../lib/demo-events.ts";
import { parseWorld } from "../lib/world-schema.ts";
import { createSessionCarrier, carrierAsCore } from "./atlas-session-helper.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releasePlugin = join(root, "release", "atlas-server-plugin", "index.mjs");
const releaseUi = join(root, "release", "atlas-ui-extension");
const SECRET = "sk-packed-replay-0001";
const CURRENT_TIME = 418.07;
const CANON = "chronicle-canon";
const BRANCH_KEY = "canon";

function jsonResponse(status, payload) {
  const raw = JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(raw), text: async () => raw };
}
const textResponse = (status, content) => jsonResponse(status, { choices: [{ message: { content } }] });

function buildWorld() {
  const base = buildWorldFromTemplate(getDemoTemplate("chronicle"), { id: "atlas-packed-fixture", now: 1000 });
  const regionId = String((base.regions ?? [])[0]?.id ?? "");
  const parsed = parseWorld(JSON.parse(JSON.stringify({
    ...base,
    currentRegionId: regionId,
    currentYear: 812,
    points: [...(base.points ?? []), { id: 9001, name: "钟楼", x: 10, y: 10, regionId }],
  })));
  assert.ok(parsed, "夹具世界必须能过 parseWorld");
  return parsed;
}

const bindingFor = (world) => ({
  schemaVersion: 1, enabled: true, chatId: "chat-a",
  // 本夹具的主角行没有位置（demo 模板的 chronicle-* 都是 locationRef=null），
  // 所以这里不指定角色：位置游标由夹具显式给出，避免「绑定位置与角色行不一致」
  // 被当成一次跨地点旅行，凭空推进时间。
  characterId: null,
  worldId: world.id, branchId: CANON,
  currentLocationId: "9001", worldTimeCursor: CURRENT_TIME,
  lastCommittedMessageId: null, lastCheckpointId: null,
});

/** 一行「想法」增量：只写行动倾向、**不带目标地点** → 不移动、时间不动。 */
function intentBlock() {
  return ["<atlasEdit>", JSON.stringify({
    table: "character", op: "set", ref: "npc:chronicle-c1",
    patch: { actionTendency: "赶往钟楼" },
    basis: "observed", quote: "他决定赶往钟楼",
  }), "</atlasEdit>"].join("\n");
}

const V2_ENVELOPE = JSON.stringify({ schemaVersion: 2, narrativeSummary: "旧协议封套", mapScaleHints: [] });

function commitBody(overrides = {}) {
  return {
    turnId: "turn-x", chatId: "chat-a", userMessageId: "msg-10", assistantMessageId: "msg-11",
    swipeId: null, userText: "我跟着他。", assistantText: "他决定赶往钟楼，随后消失在街角。",
    ...overrides,
  };
}

test("G03 离线重放：打包产物跑通 绑定 → 提交 → 协议不符 → 回退 → 任务推进 → 地图", async () => {
  assert.ok(existsSync(releasePlugin), "先跑 npm run pack（release/atlas-server-plugin/index.mjs 不存在）");

  // 产物自证版本：三处发布物必须是同一个 0.9.59
  const pluginMod = await import(`file://${releasePlugin.replace(/\\/g, "/")}`);
  const packedManifest = JSON.parse(readFileSync(join(releaseUi, "manifest.json"), "utf8"));
  const packedServerPkg = JSON.parse(readFileSync(join(root, "release", "atlas-server-plugin", "package.json"), "utf8"));
  assert.equal(packedManifest.version, pluginMod.ATLAS_PLUGIN_VERSION, "UI manifest 与插件常量版本一致");
  assert.equal(packedServerPkg.version, pluginMod.ATLAS_PLUGIN_VERSION, "Server package 与插件常量版本一致");
  assert.equal(pluginMod.ATLAS_PLUGIN_VERSION, "0.9.59", "打包产物版本号");

  const dir = mkdtempSync(join(tmpdir(), "atlas-packed-replay-"));
  const scripts = [
    () => textResponse(200, intentBlock()),
    () => textResponse(200, V2_ENVELOPE),
    () => textResponse(200, intentBlock()),
  ];
  let call = 0;
  const fetchFn = async () => {
    const script = scripts[Math.min(call, scripts.length - 1)];
    call += 1;
    return script();
  };

  try {
    // 走**产物自己的** init（它会加载组件内的 ./dist/atlas-server.mjs）
    const { core: packedCore } = await pluginMod.init(
      { get() {}, post() {}, put() {} },
      { dataDir: dir, fetchFn },
    );
    const carrier = createSessionCarrier(packedCore, {});
    const core = carrierAsCore(carrier);

    // ① 绑定
    const world = buildWorld();
    assert.equal((await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true })).status, 200);
    assert.equal((await core.handle("POST", "/bindings", { action: "bind", binding: bindingFor(world) }, { local: true })).status, 200);
    await core.handle("PUT", "/settings", {
      worldTurn: { name: "重放推演", endpoint: "https://mock.example.invalid/v1", model: "atlas-mock", apiKey: SECRET, timeoutMs: 5000 },
    }, { local: true });
    await core.handle("PUT", "/settings", { action: "runtime.update", worldTurnProtocol: "table-delta-v1" }, { local: true });

    // ② 提交：行增量块落账 + 推演任务排上
    const first = await core.handle("POST", "/turns/commit", commitBody());
    assert.equal(first.status, 200, `提交应成功：${JSON.stringify(first.body.error ?? {})}`);
    assert.equal(first.body.data.receipt.status, "committed");
    const tasks = carrier.session.simulation?.branches?.[BRANCH_KEY]?.tasks ?? [];
    assert.ok(tasks.length >= 1, "③ 任务推进：意图行产出了推演任务");
    assert.equal(Number(carrier.session.binding.worldTimeCursor), CURRENT_TIME, "只写意图、没跨地点 → 时间不动");

    // ③ 协议不符：v2 封套必须具名拒绝，且**零写入**
    const beforeV2 = JSON.stringify(carrier.session);
    const v2 = await core.handle("POST", "/turns/commit", commitBody({
      turnId: "turn-v2", userMessageId: "msg-20", assistantMessageId: "msg-21",
      assistantText: "他决定赶往钟楼。",
    }));
    assert.equal(v2.status, 409, `v2 封套应 409：实际 ${v2.status}`);
    assert.equal(v2.body.error?.code, "PROTOCOL_MISMATCH", "错误码具名");
    assert.equal(JSON.stringify(carrier.session), beforeV2, "协议不符不得改动会话");

    // ④ 地图：三表与投影都在
    const state = await core.handle("POST", "/state", { chatId: "chat-a" });
    assert.equal(state.status, 200, `state 应成功：${JSON.stringify(state.body.error ?? {})}`);
    assert.ok(Array.isArray(state.body.data.map?.points) && state.body.data.map.points.length > 0, "地图有点位");
    assert.equal(String(state.body.data.currentLocationId), "9001", "当前位置可读");

    // ⑤ 回退：先让时间真的走一格（用户显式时间词），再退回原值。
    // 锁的是「回退必须精确还原游标」，而不是某个具体的旅行耗时公式。
    const beforeMoveTime = Number(carrier.session.binding.worldTimeCursor);
    const advanced = await core.handle("POST", "/turns/commit", commitBody({
      turnId: "turn-advance", userMessageId: "msg-30", assistantMessageId: "msg-31",
      userText: "接下来一整天我们都在赶路。",
      assistantText: "他决定赶往钟楼，随后消失在街角。",
    }));
    assert.equal(advanced.status, 200, `推进回合应成功：${JSON.stringify(advanced.body.error ?? {})}`);
    assert.equal(Number(carrier.session.binding.worldTimeCursor), beforeMoveTime + 4,
      `用户说「一整天」= 4 时段：实际 ${carrier.session.binding.worldTimeCursor}`);

    const rollback = await core.handle("POST", "/turns/rollback", { chatId: "chat-a", assistantMessageId: "msg-31" });
    assert.equal(rollback.status, 200, `回退应成功：${JSON.stringify(rollback.body.error ?? {})}`);
    assert.equal(Number(carrier.session.binding.worldTimeCursor), beforeMoveTime, "时间精确回到推进前");
  } finally {
    try { rmdirSync(dir, { recursive: true }); } catch { /* 临时目录，清不掉不影响验收 */ }
  }
});
