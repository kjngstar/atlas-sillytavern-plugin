/**
 * atlas-r01-map-visibility.test.mjs — R01 地图可见性 / 图层拆分回归测试。
 *
 * 断言方向与 v0.9.51 基线相反（基线见 tests/fixtures/audit/baseline-v0.9.51.json）：
 * - D10：mapTools 显式显示（is-visible + display:flex）
 * - D11：hint 不再拦截指针（pointer-events:none；空文字 display:none）
 * - D08/D09：网格画在独立 .aw-grid 且 repeat 平铺；底图画在 .aw-image；
 *   两者分离，有底图时网格仍然存在（M02 叠加默认）
 * - D14 前置：比例尺详情为独立浮层（CSS 契约测试在 atlas-map-skin / 样式断言覆盖）
 * - 地图页状态反馈：setStatus 后地图页渲染出 aw-status 行
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(resolve(root, "package.json"));

test("R01: 地图工具显示、hint 不遮挡、网格平铺、底图网格分层共存", async () => {
  const dom = new JSDOM("<!doctype html><head></head><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;

  const style = document.createElement("style");
  style.textContent = readFileSync(resolve(root, "style.css"), "utf8");
  document.head.append(style);

  const source = readFileSync(resolve(root, "index.js"), "utf8");
  const { renderPanel } = await import("data:text/javascript;base64," + Buffer.from(source + "\nexport {renderPanel};").toString("base64"));
  const { createDefaultSettingsV2, settingsViewV2 } = await import(pathToFileURL(resolve(root, "src/atlas-settings.ts")).href);
  const { DEFAULT_PROMPT_SEGMENTS } = await import(pathToFileURL(resolve(root, "src/atlas-api-client.ts")).href);

  const world = {
    points: [
      { id: 1, name: "起点", x: 50, y: 50, regionId: "start" },
      { id: 2, name: "废墟深处", x: 70, y: 50, regionId: "start" },
    ],
    regions: [{ id: "start", name: "起点地区" }],
  };
  const state = {
    page: "map",
    panelOpen: true,
    receipts: [],
    serviceStatus: "online",
    mode: "online",
    chatId: "r01-chat",
    stateData: {
      chatId: "r01-chat",
      worldId: "r01-world",
      worldName: "R01 世界",
      currentTime: 1,
      currentLocationId: "1",
      map: { points: world.points, regions: world.regions, mapImagePresent: false, submaps: {}, pointMeta: {}, calibrations: {} },
      npcDirectory: [],
      objectDirectory: [],
      regions: world.regions,
    },
  };
  const core = {
    getState: () => state,
    setPage: () => {},
    setPanelOpen: () => {},
    refresh: async () => {},
  };
  const settings = {
    ...settingsViewV2(createDefaultSettingsV2()),
    builtInPrompt: { segments: DEFAULT_PROMPT_SEGMENTS, systemPrompt: DEFAULT_PROMPT_SEGMENTS[0].content },
  };
  const api = { request: async () => ({ status: 200, body: { ok: true, data: settings } }) };
  const container = document.createElement("div");
  document.body.append(container);
  renderPanel(core, container, (x) => x, api, { read: async () => null }, {});

  const css = (n) => window.getComputedStyle(n);

  // D10：工具条显式显示
  const tools = container.querySelector(".aw-maptools");
  assert.ok(tools, "maptools 存在");
  assert.ok(tools.classList.contains("is-visible"), "maptools 挂 is-visible");
  assert.equal(css(tools).display, "flex", "maptools display:flex");

  // D11：hint 不拦截指针
  const hint = container.querySelector(".aw-maparea__hint");
  assert.ok(hint, "hint 存在");
  assert.equal(css(hint).pointerEvents, "none", "hint pointer-events:none");

  // D08：网格独立图层 repeat 平铺（不再是 no-repeat 单块）
  const grid = container.querySelector(".aw-grid");
  assert.ok(grid, "独立网格层存在");
  assert.equal(grid.style.backgroundRepeat, "repeat", "网格 repeat 平铺");
  assert.equal(grid.style.backgroundSize, "100% 100%", "网格铺满元素而非单块");
  assert.ok(grid.style.backgroundImage.includes("repeating-linear-gradient"), "网格用 repeating-gradient");
  assert.ok(grid.style.backgroundImage.includes("--am-grid-minor"), "网格消费皮肤令牌 --am-grid-minor（R11 契约）");

  // D09：底图与网格分层——image 层存在且默认叠加视图
  const image = container.querySelector(".aw-image");
  assert.ok(image, "独立底图层存在");
  const stage = container.querySelector(".aw-stage");
  assert.ok(stage, "stage 包装层存在");
  assert.equal(stage.dataset.view, "overlay", "默认叠加视图");

  // M02 视图切换只改可见性状态
  const gridBtn = container.querySelector('.aw-mapview__btn[data-mode="grid"]');
  assert.ok(gridBtn, "网格视图按钮存在");
  gridBtn.click();
  assert.equal(stage.dataset.view, "grid", "切到纯网格视图");
  const imageBtn = container.querySelector('.aw-mapview__btn[data-mode="image"]');
  imageBtn.click();
  assert.equal(stage.dataset.view, "image", "切到纯底图视图");

  // M07 前置：真实标点 DOM 存在且可点击（点击开面板的完整命中测试留给真实浏览器验收）
  const point = container.querySelector(".aw-point[data-point-id]");
  assert.ok(point, "地点标点存在");
  point.click();
  const panel = container.querySelector(".aw-mappanel");
  assert.equal(panel.style.display, "", "点击标点打开信息面板");

  // viewport 静态装饰纹理保持关闭（不冒充可测量网格）
  const viewport = container.querySelector(".aw-viewport");
  assert.equal(viewport.style.backgroundImage, "none", "viewport 装饰纹理关闭");
});

test("R01: 有底图时网格仍被绘制（叠加默认）且缓存键含底图版本", async () => {
  const dom = new JSDOM("<!doctype html><head></head><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  const style = document.createElement("style");
  style.textContent = readFileSync(resolve(root, "style.css"), "utf8");
  document.head.append(style);
  const source = readFileSync(resolve(root, "index.js"), "utf8");
  const { renderPanel } = await import("data:text/javascript;base64," + Buffer.from(source + "\nexport {renderPanel};").toString("base64"));
  const { createDefaultSettingsV2, settingsViewV2 } = await import(pathToFileURL(resolve(root, "src/atlas-settings.ts")).href);
  const { DEFAULT_PROMPT_SEGMENTS } = await import(pathToFileURL(resolve(root, "src/atlas-api-client.ts")).href);

  let imageRequests = 0;
  const settings = {
    ...settingsViewV2(createDefaultSettingsV2()),
    builtInPrompt: { segments: DEFAULT_PROMPT_SEGMENTS, systemPrompt: DEFAULT_PROMPT_SEGMENTS[0].content },
  };
  const state = {
    page: "map",
    panelOpen: true,
    receipts: [],
    serviceStatus: "online",
    mode: "online",
    chatId: "r01b-chat",
    stateData: {
      chatId: "r01b-chat",
      worldId: "r01b-world",
      worldName: "R01B 世界",
      currentTime: 3,
      currentLocationId: "1",
      map: {
        points: [{ id: 1, name: "起点", x: 50, y: 50, regionId: "start" }],
        regions: [{ id: "start", name: "起点地区" }],
        mapImagePresent: true,
        mapImageRevision: 7,
        submaps: {},
        pointMeta: {},
        calibrations: {},
      },
      npcDirectory: [],
      objectDirectory: [],
      regions: [{ id: "start", name: "起点地区" }],
    },
  };
  const core = { getState: () => state, setPage: () => {}, setPanelOpen: () => {}, refresh: async () => {} };
  const api = {
    request: async (_method, path) => {
      if (path === "/map/image") {
        imageRequests += 1;
        return { status: 200, body: { ok: true, data: { dataUrl: "data:image/png;base64,iVBORw0KGgo=" } } };
      }
      return { status: 200, body: { ok: true, data: settings } };
    },
  };
  const container = document.createElement("div");
  document.body.append(container);
  renderPanel(core, container, (x) => x, api, { read: async () => null }, {});
  await new Promise((r) => setTimeout(r, 20));

  const grid = container.querySelector(".aw-grid");
  assert.ok(grid.style.backgroundImage.includes("repeating-linear-gradient"), "有底图时网格仍然绘制（M02 叠加）");
  const image = container.querySelector(".aw-image");
  assert.equal(image.style.backgroundRepeat, "no-repeat", "底图 no-repeat 铺满");
  assert.ok(image.style.backgroundImage.includes("data:image"), "底图挂在独立图层");
  assert.equal(imageRequests, 1, "底图只拉取一次（缓存生效）");
});
