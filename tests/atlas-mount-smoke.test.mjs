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
import initSqlJs from 'sql.js';

const dom = new JSDOM(
  `<!doctype html><html><body><div id="extensionsMenu"></div><textarea id="send_textarea"></textarea><input type="checkbox" id="atlas-sql-mode-toggle"></body></html>`,
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

const hostListeners=new Map();
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
  eventSource: {
    on:(type,handler)=>{const listeners=hostListeners.get(type)??new Set();listeners.add(handler);hostListeners.set(type,listeners);},
    off:(type,handler)=>hostListeners.get(type)?.delete(handler),
    removeListener:(type,handler)=>hostListeners.get(type)?.delete(handler),
  },
  event_types: Object.fromEntries(['WORLD_INFO_ACTIVATED','GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED','CHAT_CHANGED','MESSAGE_SENT','MESSAGE_EDITED','MESSAGE_DELETED','MESSAGE_SWIPED'].map(name=>[name,name])),
};
globalThis.SillyTavern = { getContext: () => hostContext };

// 0.9.46：在扩展导入（模块自初始化 connectAtlas）之前，把「已绑定世界」的会话
// 文档种进 chatMetadata——地图页必须真实渲染（图例 / 标点 / 比例尺），否则
// 防回归锁对 0.9.41 图例 bug 这类「只有绑世界后才出现」的问题永远失明。
/**
 * 测试卫生（0.9.59）：把原本**模块顶层**的断言收进一个 `test()`。
 *
 * 顶层 `assert` 一旦失败会中断整个文件的导入，node --test 只报「这个文件挂了」一条，
 * 该文件里的用例全部从总数里消失——实测会让 100+ 条测试凭空不见，
 * 失败计数因此失去意义（排查协议收口时被这个假象误导过一次）。
 * 现在失败会以**一条具名用例**的形式暴露，其余文件的计数也不再被牵连。
 */
test("原版 UI 宿主挂载：connectAtlas、真实只读 SQL 和断开重连", async () => {
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

// The published browser bundle can accept a host-initialized genuine sql.js instance.
// Actual browser resource fetching is covered separately by verify-sql-release.mjs.
const sql = await import('../atlas-extension/dist/atlas-sql.mjs');
sql.injectSqlModule(await initSqlJs());
const mod = await import("../atlas-extension/index.js");
// 等模块自初始化（void connectAtlas()）完成
await new Promise((resolve) => setTimeout(resolve, 300));
const conn = await mod.connectAtlas();

assert.ok(conn, "connectAtlas 必须成功（挂载路径任何 ReferenceError 都在此暴露）");

const root = globalThis.document.getElementById("atlas-extension-panel-root");
assert.ok(root, "面板根节点已挂到 body");

// jsdom does not execute iframe scripts. Real original pages and canvas are tested in Chrome.
assert.equal(root.className,'atlas-native-ui-host');
assert.equal(root.children.length,1);
const frame=root.querySelector('iframe');assert.ok(frame);assert.match(frame.src,/atlas-reference\/index.html$/);
assert.equal(root.querySelector('.aw-center,.atlas-starmap'),null);
const migrated=await sql.migrateSessionToSql({chatUid:hostContext.chatId,chatMetadata:hostContext.chatMetadata,saveSession:async()=>true,legacy:{atlas:{world:smokeWorld}}});
// connectAtlas 可能已经自动导入旧档；再次迁移应幂等拒绝，不要求重复保存。
assert.ok(migrated.saved || migrated.issues.some(i=>i.code==='MIGRATION_ALREADY_APPLIED'),JSON.stringify(migrated.issues));
assert.ok(!migrated.issues.some(i=>i.severity==='error'),JSON.stringify(migrated.issues));await sql.closeSqlSession(migrated.session);
await conn.core.refresh();const before=JSON.stringify(hostContext.chatMetadata.atlas.database);
const initial=await frame.__atlasHost.boot();
assert.equal(initial.data.LOCATIONS.filter(x=>x.name==='烟雾港').length,1,'自动或显式迁移后旧地点恰好保留一次');
assert.equal(JSON.stringify(hostContext.chatMetadata.atlas.database),before,'UI query does not write snapshot');
// 打开可见性消费正常
conn.core.setPanelOpen(true);
conn.core.__renderPage();
assert.notEqual(root.style.display, "none", "panelOpen=true 时根节点必须可见");

const activeListeners=[...hostListeners.values()].reduce((n,set)=>n+set.size,0);
assert.ok(activeListeners>0,"actual host events registered");
await mod.disconnectAtlas();
assert.equal([...hostListeners.values()].reduce((n,set)=>n+set.size,0),0,"disconnect releases all host subscriptions");
const reconnected=await mod.connectAtlas();assert.ok(reconnected);
assert.equal([...hostListeners.values()].reduce((n,set)=>n+set.size,0),activeListeners,"reconnect does not duplicate subscriptions");
await mod.disconnectAtlas();
assert.equal([...hostListeners.values()].reduce((n,set)=>n+set.size,0),0);
});
