/**
 * atlas-mount-smoke.test.mjs — ATLAS-18 回归修复（0.9.3）的永久门禁。
 *
 * 背景：ATLAS-18 六栏重写把 `loadPresetIntoForm` 删了却漏删调用点 → 挂载即
 * ReferenceError，被 connectOnce 的 catch 吞掉 → 面板只剩静态骨架、零功能
 * （0.9.2 全量必现，真实酒馆才暴露）。既有 harness 只做静态字符串断言 +
 * 纯核心逻辑，**renderPanel 从未在测试里真正执行过**——本测试用 jsdom 补上
 * 这条盲区：真实跑 connectAtlas 全流程，断言挂载成功、六页全部可渲染。
 *
 * 0.9.46 补强：0.9.43 的防回归锁只查 .aw-center 且在无世界状态下跑——
 * 图例在地图 viewport 里、且要绑世界后才渲染，锁了个真空。现在种子一个
 * 绑定 + starter 世界（经 chatMetadata.atlas 会话文档），地图必须真实渲染，
 * 图例三型标签（地点/人物/物品）必须出现且不得是 "[object HTMLElement]"。
 *
 * 注意：node --test 每个测试文件独立进程运行，jsdom 全局不会泄漏到其他文件。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM(
  `<!doctype html><html><body><div id="extensionsMenu"></div><textarea id="send_textarea"></textarea></body></html>`,
  { url: "http://localhost/", pretendToBeVisual: true },
);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Event = dom.window.Event;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame?.bind(dom.window);
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

const hostContext = {
  extensionSettings: {},
  chatMetadata: {},
  saveMetadata: async () => {},
  saveSettingsDebounced: () => {},
  chatId: "chat-smoke-1",
  characters: [{ name: "Aria", description: "mount smoke" }],
  characterId: 0,
  name2: "Aria",
  getRequestHeaders: () => ({ "x-csrf": "stub" }),
  eventSource: { on: () => {}, makeLast: () => {}, addEventListener: () => {} },
  event_types: {},
};
globalThis.SillyTavern = { getContext: () => hostContext };

// 0.9.46：在扩展导入（模块自初始化 connectAtlas）之前，把「已绑定世界」的会话
// 文档种进 chatMetadata——地图页必须真实渲染（图例 / 标点 / 比例尺），否则
// 防回归锁对 0.9.41 图例 bug 这类「只有绑世界后才出现」的问题永远失明。
const { buildStarterWorld } = await import("../src/atlas-starter-world.ts");
const smokeWorld = buildStarterWorld({
  id: "w-smoke",
  now: 1758500000000,
  name: "Aria",
  description: "mount smoke world",
});
// R06：新世界是空地理（0 地点）；本冒烟锁的是「有地点时地图真的渲染出标点 / 图例」，
// 因此补一个真实地点（不是「起点」占位）当作已绑世界的当前位置。
smokeWorld.points.push({ id: 1, name: "烟雾港", x: 50, y: 50, regionId: null });
hostContext.chatMetadata.atlas = {
  schemaVersion: 1,
  rev: 1,
  binding: {
    schemaVersion: 1,
    enabled: true,
    chatId: "chat-smoke-1",
    characterId: null,
    worldId: "w-smoke",
    branchId: null,
    currentLocationId: String(smokeWorld.points[0].id),
    worldTimeCursor: 3,
    lastCommittedMessageId: null,
    lastCheckpointId: null,
  },
  world: smokeWorld,
  maps: null,
  turns: {},
  geoAuto: {},
};

const mod = await import("../atlas-extension/index.js");
// 等模块自初始化（void connectAtlas()）完成
await new Promise((resolve) => setTimeout(resolve, 300));
const conn = await mod.connectAtlas();

assert.ok(conn, "connectAtlas 必须成功（挂载路径任何 ReferenceError 都在此暴露）");

const root = globalThis.document.getElementById("atlas-extension-panel-root");
assert.ok(root, "面板根节点已挂到 body");

// 骨架完整性：右栏内容区必须真的挂进 DOM（sideFoot 曾是 v0.7.0 起的孤儿节点）
assert.ok(root.querySelector(".aw-side__changes"), "右栏 .aw-side__changes 必须在 DOM 里");
assert.ok(root.querySelector(".aw-moves__list"), "左栏动向列表必须在 DOM 里");

// 六页全部走一遍：每页中区都必须有内容（renderPage 任一分支抛错都会在这里暴露）
for (const page of ["overview", "map", "nearby", "changes", "progression", "api", "skin"]) {
  conn.core.setPage(page);
  conn.core.__renderPage();
  const center = root.querySelector(".aw-center");
  assert.ok(center.children.length > 0, `页面 ${page} 的中区必须渲染出内容`);
  // 0.9.43 回归锁：el() 只接受文本，DOM 节点被当文字传进去会渲染成 "[object HTMLElement]"
  // （0.9.41 图例真实翻车：三个图例项全部变成 [object HTMLElement]）
  assert.ok(
    !center.textContent.includes("[object HTMLElement"),
    `页面 ${page} 不得出现 "[object HTMLElement]"（有 DOM 节点被当字符串塞进 el()）`,
  );
}

// 0.9.46 真锁：绑世界后的地图页必须渲染出图例，且三型标签是文字不是 "[object …]"
// （0.9.43 的修复从未真正进过提交——commit 只有版本号，锁又只查中区，双重失明）
let legend = null;
for (let i = 0; i < 60; i += 1) {
  conn.core.setPage("map");
  conn.core.__renderPage();
  legend = root.querySelector(".aw-maplegend");
  if (legend) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
}
assert.ok(legend, "绑定世界后地图页必须渲染出图例（.aw-maplegend）");
const legendText = legend.textContent ?? "";
assert.ok(legendText.includes("地点"), "图例必须渲染出「地点」标签");
assert.ok(legendText.includes("人物"), "图例必须渲染出「人物」标签");
assert.ok(legendText.includes("物品"), "图例必须渲染出「物品」标签");
assert.ok(
  !root.textContent.includes("[object HTMLElement"),
  "全面板任何位置不得出现 \"[object HTMLElement]\"（0.9.46 起查整棵面板树，不再只查中区）",
);
assert.ok(root.querySelector(".aw-point"), "地图必须渲染出地点标点（绑定世界生效的证据）");

// 打开可见性消费正常
conn.core.setPanelOpen(true);
conn.core.__renderPage();
assert.notEqual(root.style.display, "none", "panelOpen=true 时根节点必须可见");

conn.core.dispose();
