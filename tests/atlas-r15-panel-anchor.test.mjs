/**
 * atlas-r15-panel-anchor.test.mjs — R15 补：信息面板锚点续锚 / 失效关闭（R08 残留收口）。
 *
 * 背景（R08 残留原文）：「弹窗随 pan / zoom / resize 重新定位（anchorPanelToMarker 仅开
 * 面板时计算）→ R09 selectedEntityId 弹窗刷新一起收口」；R09 做的是 SubMap frame，未接。
 * 本锁固化三条语义：
 *  1. 开面板后重新渲染（同一世界 → 不关门）：面板保持打开，且高亮跟到**新**标记元素上；
 *  2. 该对象真的从数据里消失：面板关闭，不留孤儿浮层（VERIFICATION §2「对象消失则关闭」）；
 *  3. 关闭路径清掉锚点身份——再次渲染不得凭旧身份复活面板。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function mountPanel() {
  const dom = new JSDOM("<!doctype html><head></head><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;

  const style = document.createElement("style");
  style.textContent = readFileSync(resolve(root, "style.css"), "utf8");
  document.head.append(style);

  const source = readFileSync(resolve(root, "index.js"), "utf8");
  const { renderPanel } = await import(
    "data:text/javascript;base64," + Buffer.from(source + "\nexport {renderPanel};").toString("base64")
  );
  const { createDefaultSettingsV2, settingsViewV2 } = await import(
    pathToFileURL(resolve(root, "src/atlas-settings.ts")).href
  );
  const { DEFAULT_PROMPT_SEGMENTS } = await import(
    pathToFileURL(resolve(root, "src/atlas-api-client.ts")).href
  );
  const cameraMod = await import(pathToFileURL(resolve(root, "src/atlas-map-camera.ts")).href);
  const interactionMod = await import(pathToFileURL(resolve(root, "src/atlas-map-interactions.ts")).href);
  const mapMod = { ...cameraMod, ...interactionMod };

  const points = [
    { id: 1, name: "起点", x: 50, y: 50, regionId: "start" },
    { id: 2, name: "废墟深处", x: 70, y: 50, regionId: "start" },
  ];
  const state = {
    page: "map",
    panelOpen: true,
    receipts: [],
    serviceStatus: "online",
    mode: "online",
    chatId: "r15-chat",
    stateData: {
      chatId: "r15-chat",
      worldId: "r15-world",
      worldName: "R15 世界",
      currentTime: 1,
      currentLocationId: "1",
      map: { points, regions: [{ id: "start", name: "起点地区" }], mapImagePresent: false, submaps: {}, pointMeta: {}, calibrations: {} },
      npcDirectory: [],
      objectDirectory: [],
      regions: [{ id: "start", name: "起点地区" }],
    },
  };
  const core = { getState: () => state, setPage: () => {}, setPanelOpen: () => {}, refresh: async () => {} };
  const settings = {
    ...settingsViewV2(createDefaultSettingsV2()),
    builtInPrompt: { segments: DEFAULT_PROMPT_SEGMENTS, systemPrompt: DEFAULT_PROMPT_SEGMENTS[0].content },
  };
  const api = { request: async () => ({ status: 200, body: { ok: true, data: settings } }) };
  const container = document.createElement("div");
  document.body.append(container);
  const rerender = renderPanel(core, container, (x) => x, api, { read: async () => null }, mapMod);
  return { container, rerender, state };
}

test("R15-PA1: 重新渲染后高亮跟到新标记元素（同一面板不关门）", async () => {
  const { container, rerender } = await mountPanel();
  const first = container.querySelector('.aw-point[data-point-id="2"]');
  assert.ok(first, "目标标点存在");
  first.click();
  const panel = container.querySelector(".aw-mappanel");
  assert.equal(panel.style.display, "", "点击后面板打开");
  assert.ok(first.classList.contains("is-active-marker"), "原标记被高亮");
  assert.equal(container.querySelectorAll(".aw-point.is-active-marker").length, 1, "高亮唯一");

  // 同一世界重新渲染（模拟提交后刷新）：标记元素被整体重建
  const second = (await rerender(), container.querySelector('.aw-point[data-point-id="2"]'));
  assert.ok(second, "重渲染后标记仍存在");
  assert.notEqual(second, first, "标记元素确实被重建（旧元素已脱离 DOM）");
  const panelAfter = container.querySelector(".aw-mappanel");
  assert.equal(panelAfter.style.display, "", "面板不因重新渲染而关闭");
  const active = container.querySelectorAll(".aw-point.is-active-marker");
  assert.equal(active.length, 1, "高亮仍唯一");
  assert.equal(active[0].dataset.pointId, "2", "高亮跟到新标记元素（按身份续锚）");
});

test("R15-PA2: 对象从数据消失 → 面板关闭且不复活", async () => {
  const { container, rerender, state } = await mountPanel();
  container.querySelector('.aw-point[data-point-id="2"]').click();
  assert.equal(container.querySelector(".aw-mappanel").style.display, "", "面板已打开");

  // 数据里删掉该地点（如账本变更后地点不再下发）
  state.stateData.map.points = state.stateData.map.points.filter((point) => String(point.id) !== "2");
  await rerender();
  const panel = container.querySelector(".aw-mappanel");
  assert.equal(panel.style.display, "none", "对象消失后面板关闭，不留孤儿浮层");
  assert.equal(container.querySelectorAll(".aw-point.is-active-marker").length, 0, "高亮清空");

  // 把地点加回来但**不再点击**：关闭态已清身份，不得凭旧身份自动复活面板
  state.stateData.map.points = [
    { id: 1, name: "起点", x: 50, y: 50, regionId: "start" },
    { id: 2, name: "废墟深处", x: 70, y: 50, regionId: "start" },
  ];
  await rerender();
  assert.equal(container.querySelector(".aw-mappanel").style.display, "none", "关闭后不自动复活（需用户再次点击）");
  assert.equal(container.querySelectorAll(".aw-point.is-active-marker").length, 0, "无残留高亮");
});
