/**
 * atlas-map-vehicles.test.mjs — H16 / H20 定向验收（载具显示 + 图例收进可折叠工具条）。
 *
 * 对照计划 §2.5 / H16：
 *  - `stopped` 且锚点落在本图某个已知地点上 → 在该地点标点挂载具徽标（它真的停在那儿）；
 *  - `en-route` / `unknown` → **一个点都不画**（在途没有确认坐标，画出来就是伪造），
 *    但必须由说明行如实列出，不能就此消失；
 *  - 未知锚点绝不落到 (0,0)。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function mountMapWithVehicles(anchors) {
  const dom = new JSDOM("<!doctype html><head></head><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;

  const style = document.createElement("style");
  style.textContent = readFileSync(join(root, "atlas-extension", "style.css"), "utf8");
  document.head.append(style);

  const source = readFileSync(join(root, "index.js"), "utf8");
  const { renderPanel } = await import(
    "data:text/javascript;base64," + Buffer.from(`${source}\nexport { renderPanel };`).toString("base64")
  );

  const mapMod = {
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-camera.ts")).href)),
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-interactions.ts")).href)),
    ...(await import(pathToFileURL(join(root, "src", "atlas-scale.ts")).href)),
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-grid.ts")).href)),
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-areas.ts")).href)),
    ATLAS_UI_PAGES: (await import(pathToFileURL(join(root, "src", "atlas-ui-core.ts")).href)).ATLAS_UI_PAGES,
  };

  const geoTopology = {
    branchKey: "canon",
    edges: [], areas: [], vehicleAnchors: anchors,
    counts: { edges: 0, areas: 0, vehicles: anchors.length },
    truncated: { edges: 0, areas: 0, vehicles: 0 },
  };
  const state = {
    page: "map",
    panelOpen: true,
    serviceStatus: "online",
    chatId: "chat-veh",
    binding: { schemaVersion: 1, enabled: true, chatId: "chat-veh", worldId: "w-veh", branchId: null, currentLocationId: "1", worldTimeCursor: 3 },
    receipts: [], pendingTurn: null, retryableCommit: null, lastError: null,
    simulationView: null, simulationVisibility: "known",
    modeHint: null, lorebookHint: null, worldNotice: null,
    stateData: {
      chatId: "chat-veh", worldId: "w-veh", worldName: "载具世界", currentTime: 3, currentLocationId: "1",
      map: {
        points: [
          { id: "1", name: "钟楼", x: 10, y: 10, regionId: null },
          { id: "2", name: "驿站", x: 30, y: 30, regionId: null },
        ],
        pointCount: 2, pointParents: {}, submaps: {}, submapCount: 0,
        calibrations: {}, pointMeta: {}, mapImagePresent: false, mapImageRevision: 0,
        geoTopology,
      },
      npcDirectory: [], objectDirectory: [], nearbyPointIds: [], relevantNpcIds: [], npcReasons: {}, triggerIds: [], regions: [],
      tableMap: {
        branchKey: "canon",
        world: { mapId: "world", points: [
          { id: "1", name: "钟楼", x: 10, y: 10, regionId: null, kind: "location", rowId: "loc:1" },
          { id: "2", name: "驿站", x: 30, y: 30, regionId: null, kind: "location", rowId: "loc:2" },
        ], total: 2, truncated: 0 },
        submaps: {}, nearby: { entries: [], total: 0, truncated: 0 }, objects: { entries: [], total: 0, truncated: 0 },
        unknownPosition: [], current: { locationId: "loc:1", chain: [] }, totals: { locations: 2, characters: 0, items: 0, submaps: 0 },
        dropped: { locations: 0 }, nearReasonCode: null,
        locationOccupants: {
          total: 2, truncated: 0,
          entries: [
            { locationId: "loc:2", locationName: "驿站", locationPointId: "2", mapId: "world", gridX: 30, gridY: 30, characterCount: 2, itemCount: 0, characters: [], items: [] },
            { locationId: "loc:1", locationName: "钟楼", locationPointId: "1", mapId: "world", gridX: 10, gridY: 10, characterCount: 0, itemCount: 0, characters: [], items: [] },
          ],
        },
      },
    },
  };
  const core = { getState: () => state, setPage: () => {}, setPanelOpen: () => {}, refresh: async () => {} };
  const api = { request: async () => ({ status: 200, body: { ok: true, data: {} } }) };
  const container = document.createElement("div");
  document.body.append(container);
  renderPanel(core, container, api, { read: async () => null }, mapMod);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { dom, container };
}

test("H16 停靠载具挂真实停靠点徽标；在途载具不画点但如实列出", async () => {
  const { dom, container } = await mountMapWithVehicles([
    // 真的停在驿站（loc:2 → 点 2）
    { id: "loc:9", locationId: "loc:9", atLocationId: "loc:2", routeEdgeId: null, status: "stopped", evidence: "manual" },
    // 在途：没有确认坐标
    { id: "loc:8", locationId: "loc:8", atLocationId: null, routeEdgeId: "edge:1", status: "en-route", evidence: "story" },
  ]);

  const station = [...container.querySelectorAll(".aw-point")].find((node) => node.dataset.pointId === "2");
  assert.ok(station, "驿站标点存在");
  const badge = station.querySelector(".aw-point__vehicle");
  assert.ok(badge, "停靠载具必须在真实停靠点上出徽标");
  assert.ok(station.classList.contains("has-vehicle"), "停靠点带可识别样式");

  // 另一处没有载具 → 不出徽标（不虚报）
  const tower = [...container.querySelectorAll(".aw-point")].find((node) => node.dataset.pointId === "1");
  assert.equal(tower.querySelector(".aw-point__vehicle"), null, "没停载具的地点不出徽标");

  // 在途载具：不画点，但说明行必须如实列出
  const note = container.querySelector(".aw-mapvehicle-note");
  assert.ok(note, "在途载具说明行存在");
  assert.match(note.textContent ?? "", /在途/, `说明行要写在途：实际 "${note.textContent}"`);
  assert.equal(container.querySelectorAll(".aw-point__vehicle").length, 1,
    "在途载具不得额外画点（那等于伪造位置）");

  // 未知锚点绝不落到 (0,0)
  const atOrigin = [...container.querySelectorAll(".aw-point")].filter(
    (node) => node.style.left === "0px" && node.style.top === "0px");
  assert.equal(atOrigin.length, 0, "没有任何标点落在网格原点");
  dom.window.close();
});

test("H16 没有载具时整段不出现（旧会话行为不变）", async () => {
  const { dom, container } = await mountMapWithVehicles([]);
  assert.equal(container.querySelectorAll(".aw-point__vehicle").length, 0, "没有载具就没有徽标");
  const note = container.querySelector(".aw-mapvehicle-note");
  assert.ok(!note || note.style.display === "none" || (note.textContent ?? "") === "",
    "没有在途载具时说明行保持隐藏/空");
  dom.window.close();
});

test("H20 图例收进右上可折叠工具条：默认收起，aria-expanded 如实反映", async () => {
  const { dom, container } = await mountMapWithVehicles([]);
  const toggle = container.querySelector(".aw-maptools__toggle");
  assert.ok(toggle, "工具条里有图例开关");
  assert.equal(toggle.getAttribute("aria-expanded"), "false", "默认收起");

  const panel = container.querySelector(".aw-maptools__more");
  assert.ok(panel, "折叠面板存在");
  assert.equal(panel.style.display, "none", "默认不显示");

  const legend = panel.querySelector(".aw-maplegend");
  assert.ok(legend, "图例在折叠面板里，不再常驻地图左下角");

  toggle.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(toggle.getAttribute("aria-expanded"), "true", "点击后展开");
  assert.equal(panel.style.display, "", "展开后可见");

  toggle.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(toggle.getAttribute("aria-expanded"), "false", "再点收起");
  assert.equal(panel.style.display, "none", "收起后重新隐藏");
  dom.window.close();
});
