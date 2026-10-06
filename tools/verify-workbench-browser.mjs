/**
 * verify-workbench-browser.mjs — 真实 Chrome 下的工作台接线验收（M5 返工后的永久门禁）。
 *
 * 为什么需要它：jsdom 里拿不到 canvas 2D，也跑不出真实样式表与真实手势，于是
 * 「源文件已存在」很容易被当成「接线完成」——进度验收报告里的故障（正式地图没挂
 * 渲染器 / 目录被滤空 / 双树并存 / workbench CSS 从未加载）全部是 jsdom 看不见的。
 * 本脚本用真实 Chrome 打开 dev-preview 的 SQL-backed 宿主页，逐项断言这些接线，
 * 任何一项不过就以非零退出码失败。
 *
 * 用法：
 *   node tools/verify-workbench-browser.mjs                 # 自动起预览服务（随机端口）
 *   ATLAS_REVIEW_BASE=http://127.0.0.1:4187 node tools/...  # 复用已起的服务
 * 产出：.tmp/workbench-browser/evidence-<YYYYMMDD>.json 和截图；ATLAS_EVIDENCE_DIR 可指定目录。
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { generateFloor, generateCity } from '../vendor/atlas-spatial/index.mjs';

const CHROME = process.env.ATLAS_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.ATLAS_VERIFY_PORT ?? 4291);
const failed = [];
const report = { startedAt: new Date().toISOString(), checks: {}, failed };
const evidenceDir = process.env.ATLAS_EVIDENCE_DIR ?? '.tmp/workbench-browser';
mkdirSync(evidenceDir, { recursive: true });
function check(name, ok, detail) {
  report.checks[name] = { ok: Boolean(ok), detail };
  if (!ok) failed.push(`${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

let server = null;
let base = process.env.ATLAS_REVIEW_BASE ?? "";
if (!base) {
  server = spawn(process.execPath, ["dev-preview/serve.mjs"], {
    env: { ...process.env, ATLAS_PREVIEW_PORT: String(PORT), ATLAS_PREVIEW_NO_OPEN: "1" },
    stdio: "ignore",
  });
  // serve.mjs 端口被占用时会自增，所以真端口从 stdout 拿不到（stdio 忽略）——改为探测。
  for (let i = 0; i < 40; i += 1) {
    try {
      const info = await fetch(`http://127.0.0.1:${PORT}/dev-preview/index.html`);
      if (info.ok) break;
    } catch { /* 还没起来 */ }
    await delay(250);
  }
  base = `http://127.0.0.1:${PORT}`;
}

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const pageErrors = [];
const badResponses = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("response", (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`); });
// Expose the actual controller for assertions; business functions remain unchanged.
async function exposeController(target) { await target.route('**/atlas-extension/index.js', async route => {
  const response = await route.fetch();
  const source = await response.text();
  const marker = 'spatialMapController = createWorkbenchMapController({';
  if (!source.includes(marker)) throw new Error('正式地图控制器接线不存在');
  await route.fulfill({ response, body: source.replace(marker, 'spatialMapController = globalThis.__atlasBrowserReview = createWorkbenchMapController({') });
}); }
await exposeController(page);
const camera = () => page.evaluate(() => ({
  zoom: __atlasBrowserReview.renderer.state.zoom,
  cam: __atlasBrowserReview.renderer.state.cam,
  mapId: __atlasBrowserReview.renderer.state.document?.mapId,
  label: document.querySelector('.aw-zoom__label')?.textContent,
}));

try {
  await page.goto(`${base}/dev-preview/index.html`);
  await page.waitForFunction(
    () => globalThis.atlasPreviewConnection?.core.getState().stateData?.sqlMode === true,
    {}, { timeout: 30000 },
  );
  await page.waitForFunction(
    () => Boolean(document.querySelector(".awb-tree-label") || document.querySelector(".as-tree-entry")),
    {}, { timeout: 15000 },
  );
  await page.waitForTimeout(1200);

  // --- 正式地图 = 新空间渲染器（canvas），旧绘制停用 -------------------------------
  const map = await page.evaluate(() => {
    const root = document.querySelector(".atlas-starmap");
    const canvas = document.querySelector(".aw-spatial-canvas");
    const stage = root.querySelector(".aw-stage");
    let paint = null;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      const { width: w, height: h } = canvas;
      const data = ctx.getImageData(0, 0, w, h).data;
      const colors = new Set();
      let opaque = 0;
      for (let i = 0; i < data.length; i += 4 * 13) {
        if (data[i + 3] > 0) opaque += 1;
        colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      }
      paint = { w, h, opaqueSamples: opaque, colorCount: colors.size };
    }
    return {
      canvasCount: root.querySelectorAll("canvas").length,
      canvasMounted: Boolean(canvas),
      canvasDisplayed: Boolean(canvas && canvas.style.display !== "none" && canvas.offsetParent !== null),
      canvasBox: canvas ? { w: canvas.clientWidth, h: canvas.clientHeight } : null,
      paint,
      oldMarkers: root.querySelectorAll(".aw-point").length,
      oldStageHidden: stage ? stage.style.display === "none" : null,
      newTreeNodes: root.querySelectorAll(".awb-tree-label").length,
      oldTreeNodes: root.querySelectorAll(".as-tree-entry").length,
      workbenchCssLoaded: [...document.styleSheets].some((s) => s.href?.includes("atlas-workbench.css")),
      summary: (root.querySelector(".awb-slot--summary")?.textContent ?? "").trim().slice(0, 200),
      timeline: (root.querySelector(".awb-slot--timeline")?.textContent ?? "").trim().slice(0, 200),
      viewMode: globalThis.atlasPreviewConnection.core.getViewMode?.() ?? null,
    };
  });
  check("U04/U15 canvas 已挂进正式地图视口", map.canvasCount >= 1 && map.canvasMounted && map.canvasDisplayed, map.canvasBox);
  check("U04/U15 canvas 真的画了东西（多色、非空）", Boolean(map.paint && map.paint.colorCount > 3 && map.paint.opaqueSamples > 0), map.paint);
  check("U04/U15 旧标点绘制已停用（同一时刻只有一个绘制 owner）", map.oldMarkers === 0 && map.oldStageHidden === true, { oldMarkers: map.oldMarkers, oldStageHidden: map.oldStageHidden });
  check("U05 只有一棵权威地图树（新树有节点、旧树不再绘制）", map.newTreeNodes >= 1 && map.oldTreeNodes === 0, { newTreeNodes: map.newTreeNodes, oldTreeNodes: map.oldTreeNodes });
  check("U03 atlas-workbench.css 是真的样式表（document.styleSheets）", map.workbenchCssLoaded === true, map.workbenchCssLoaded);

  await page.getByRole('button', { name: '放大地图', exact: true }).click();
  await page.waitForTimeout(150);
  const enlarged = await camera();
  check('放大按钮控制新相机且百分比同步', enlarged.zoom > 1 && enlarged.label !== '100%', enlarged);
  await page.getByRole('button', { name: '缩小地图', exact: true }).click();
  await page.waitForTimeout(150);
  check('缩小按钮控制新相机', (await camera()).zoom < enlarged.zoom, await camera());
  await page.getByRole('button', { name: '放大地图', exact: true }).click();
  await page.getByRole('button', { name: '全图适配（重置缩放与平移）', exact: true }).click();
  await page.waitForTimeout(150);
  check('全图适配复位新相机', (await camera()).zoom === 1, await camera());

  // --- 目录：视图类型 / 实体种类不得撞车（U08），且 UI 与后端同口径 -----------------
  const backend = await page.evaluate(async () => {
    const runtime = await import("/atlas-extension/dist/atlas-sql.mjs");
    const c = SillyTavern.getContext();
    const opened = await runtime.openSqlSession({
      chatUid: String(c.chatId), branchId: "main",
      chatMetadata: JSON.parse(JSON.stringify(c.chatMetadata)),
      saveSession: async () => { throw new Error("verify never saves"); },
      confirmSave: false, persist: false, modelPort: null,
    });
    if (!opened.repo) throw new Error("verify SQL open failed");
    try {
      const mode = globalThis.atlasPreviewConnection.core.getViewMode?.() ?? "author";
      const catalog = await opened.repo.queryView({ kind: "catalog", entityKind: "character", viewMode: mode });
      const maps = await opened.repo.queryView({ kind: "map", viewMode: mode });
      // Q03 scene 视图：地图 DTO 的 sceneStatus 与 scene 载荷在这里（渲染器据此决定画场景还是概览）
      let scenes = null;
      try { scenes = await opened.repo.queryView({ kind: "scene", viewMode: mode }); } catch (e) { scenes = { error: String(e?.message ?? e) }; }
      const wrongKind = await opened.repo.queryView({ kind: "character", entityKind: "character", viewMode: mode });
      return {
        viewMode: mode,
        names: catalog.items.map((x) => x.name),
        mapIds: (maps.items ?? []).map((x) => x.mapId),
        childMaps: (maps.items ?? []).filter(x => x.containerLocationId).map(x => ({ mapId: x.mapId, name: x.name, containerLocationId: x.containerLocationId })),
        rootLocations: (maps.items ?? []).find(x => !x.containerLocationId)?.points.filter(x => x.kind === 'location').map(x => ({ id: x.entityId, name: x.name })) ?? [],
        sceneItems: Array.isArray(scenes?.items) ? scenes.items.map((x) => ({ mapId: x.mapId, sceneStatus: x.sceneStatus ?? null, hasScene: Boolean(x.scene) })) : scenes,
        // kind 传成实体种类时必须查不到东西——这是 U08 的负向锁
        wrongKindCount: wrongKind.items.length,
      };
    } finally { await runtime.closeSqlSession(opened); }
  });
  check("U08 kind 是视图类型、entityKind 是实体种类（负向锁：kind=实体种类必须查空）", backend.wrongKindCount === 0, backend.wrongKindCount);

  await page.locator('.aw-nav__btn[data-page="characters"]').click();
  await page.waitForTimeout(700);
  const catalogUi = await page.evaluate(() => {
    const center = document.querySelector(".aw-center");
    const rows = [...(center?.querySelectorAll(".awb-catalog-entry") ?? [])];
    return { names: rows.map((r) => r.querySelector("strong")?.textContent ?? ""), ids: rows.map(r => r.dataset.entityId), text: (center?.innerText ?? "").slice(0, 300) };
  });
  check("U08 目录页与后端同口径（UI 名单 = 后端查询结果）",
    catalogUi.names.length === backend.names.length && catalogUi.names.every((n, i) => n === backend.names[i]),
    { ui: catalogUi.names, backend: backend.names, viewMode: backend.viewMode });

  await page.locator('.awb-catalog-entry').first().click();
  await page.waitForFunction(() => document.querySelector('.awb-card--person'));
  const person = await page.locator('.awb-slot--detail').innerText();
  check('目录选择打开正式人物详情，无 undefined', person.includes(backend.names[0]) && !person.includes('undefined'), person);
  await page.getByRole('button', { name: `定位到 ${backend.names[0]}`, exact: true }).click();
  await page.waitForTimeout(500);
  const located = await page.evaluate(() => ({ page: document.querySelector('.atlas-starmap').dataset.page,
    selectedId: __atlasBrowserReview.renderer.state.selected?.id }));
  check('目录定位回到地图并选中对应实体', located.page === 'map' && located.selectedId === catalogUi.ids[0], located);

  // --- 日志页（U12）：真实记录，不是空壳 -----------------------------------------
  await page.locator('.aw-nav__btn[data-page="logs"]').click();
  await page.waitForTimeout(500);
  const logsUi = await page.evaluate(() => (document.querySelector(".aw-center")?.innerText ?? "").slice(0, 400));
  check("U12 运行日志页有真实记录", logsUi.includes("运行日志") && /记录 \d+ 条/.test(logsUi), logsUi.slice(0, 120));

  // --- 详情卡（U06）：点画布标点必须出实体卡 --------------------------------------
  await page.locator('.aw-nav__btn[data-page="map"]').click();
  await page.waitForTimeout(600);
  const clusters = await page.evaluate(() => {
    const canvas = document.querySelector(".aw-spatial-canvas");
    const ctx = canvas.getContext("2d");
    const { width: w, height: h } = canvas;
    const img = ctx.getImageData(0, 0, w, h).data;
    const counts = new Map();
    const key = (i) => `${img[i]},${img[i + 1]},${img[i + 2]}`;
    for (let i = 0; i < img.length; i += 4 * 7) counts.set(key(i), (counts.get(key(i)) ?? 0) + 1);
    const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
    const CELL = 24; const cells = new Map();
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      if (Math.abs(img[i] - bg[0]) + Math.abs(img[i + 1] - bg[1]) + Math.abs(img[i + 2] - bg[2]) < 60) continue;
      const k = `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;
      const cell = cells.get(k) ?? { n: 0, sx: 0, sy: 0 };
      cell.n += 1; cell.sx += x; cell.sy += y; cells.set(k, cell);
    }
    return [...cells.values()].filter((v) => v.n >= 25)
      .map((v) => ({ x: Math.round(v.sx / v.n), y: Math.round(v.sy / v.n) })).slice(0, 24);
  });
  const box = await page.locator(".aw-spatial-canvas").boundingBox();
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
  let hit = null;
  for (const c of clusters) {
    await page.mouse.click(box.x + c.x / dpr, box.y + c.y / dpr);
    await page.waitForTimeout(200);
    hit = await page.evaluate(() => {
      const card = document.querySelector(".awb-slot--detail")?.querySelector(".awb-card");
      return card ? { entityId: card.dataset.entityId ?? null, text: (card.textContent ?? "").trim().slice(0, 160) } : null;
    });
    if (hit) break;
  }
  check("U06 画布选中实体 → 新详情卡拿到实体数据", Boolean(hit && hit.entityId), hit ?? "扫遍画布标点都没有命中");
  await page.screenshot({ path: `${evidenceDir}/map.png` });

  // A location with a child map must support button, keyboard and pointer navigation.
  const child = backend.childMaps[0];
  await page.locator('.awb-tree-label').first().click();
  await page.waitForTimeout(300);
  await page.evaluate(id => __atlasBrowserReview.renderer.selectById(id), child.containerLocationId);
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('.awb-slot--detail button')].find(x => x.textContent === '进入子地图');
    return button && !button.disabled;
  });
  await page.locator('.awb-slot--detail').getByRole('button', { name: '进入子地图', exact: true }).click();
  await page.waitForTimeout(350);
  check('地点卡进入子地图', (await camera()).mapId === child.mapId, await camera());
  await page.locator('.awb-tree-label').first().click();
  await page.waitForTimeout(300);
  await page.locator('.awb-tree-label').filter({ hasText: child.name }).click();
  await page.waitForTimeout(350);
  check('地图树实际切换当前 mapId', (await camera()).mapId === child.mapId, await camera());
  await page.locator('.awb-tree-label').first().click();
  await page.waitForTimeout(300);
  await page.evaluate(id => __atlasBrowserReview.renderer.selectById(id), child.containerLocationId);
  await page.locator('.aw-spatial-canvas').press('Enter');
  await page.waitForTimeout(350);
  check('Enter 进入选中地点的子地图', (await camera()).mapId === child.mapId, await camera());

  await page.locator('.awb-tree-label').first().click();
  await page.waitForTimeout(300);
  const clickAt = await page.evaluate(id => {
    const r = __atlasBrowserReview.renderer, e = r.entities().find(x => x.id === id), c = r.state.cam;
    const box = document.querySelector('.aw-spatial-canvas').getBoundingClientRect();
    return { x: box.x + e.x * c.s + c.x, y: box.y + e.y * c.s + c.y };
  }, child.containerLocationId);
  await page.mouse.dblclick(clickAt.x, clickAt.y);
  await page.waitForTimeout(350);
  check('真实鼠标双击进入地点子地图', (await camera()).mapId === child.mapId, await camera());

  await page.locator('.awb-tree-label').first().click();
  await page.waitForTimeout(300);
  await page.evaluate(id => __atlasBrowserReview.renderer.selectById(id), child.containerLocationId);
  await page.waitForTimeout(250);
  await page.locator('#atlas-sql-viewmode-toggle').evaluate(el => el.click());
  await page.waitForTimeout(500);
  const pov = await page.evaluate(() => ({
    card: document.querySelector('.awb-slot--detail .awb-card')?.textContent ?? null,
    names: [...document.querySelectorAll('.awb-tree-label')].map(x => x.textContent),
    selected: __atlasBrowserReview.renderer.state.selected,
  }));
  check('作者→POV 清空旧详情和未知子地图', !pov.card && !pov.selected && !pov.names.includes(child.name), pov);
  await page.screenshot({ path: `${evidenceDir}/pov.png` });
  await page.locator('#atlas-sql-viewmode-toggle').evaluate(el => el.click());
  await page.waitForTimeout(350);
  check('POV→作者恢复当前可见地图树', await page.locator('.awb-tree-label').count() >= backend.mapIds.length, await page.locator('.awb-tree-label').allTextContents());

  // --- 320px 不横向溢出 ----------------------------------------------------------
  await page.setViewportSize({ width: 320, height: 850 });
  await page.waitForTimeout(400);
  const mobile = await page.evaluate(() => {
    const root = document.querySelector(".atlas-starmap");
    const canvas = document.querySelector(".aw-spatial-canvas");
    return {
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      rootOverflow: root ? root.scrollWidth > root.clientWidth : null,
      canvasBox: canvas ? { w: canvas.clientWidth, h: canvas.clientHeight } : null,
    };
  });
  check("320px 无横向溢出且 canvas 仍有尺寸",
    mobile.pageOverflow === false && mobile.rootOverflow === false && Boolean(mobile.canvasBox?.w),
    mobile);
  await page.screenshot({ path: `${evidenceDir}/mobile.png` });

  // Saved geometry must flow through the real SQL reader into the production canvas.
  // Only the ephemeral dev-preview database is seeded; no user chat is touched.
  const locations = backend.rootLocations.slice(0, 6);
  const scope = { chatId: 'browser-review', branchId: 'main', revision: 0, viewMode: 'author' };
  const context = { scope, map: { id: 'world', name: '空间验收', metersPerCell: 2, frame: { cols: 15, rows: 12 } },
    entities: { locations: locations.map(x => x.id), characters: [], items: [] } };
  const floor = generateFloor({ id: 'world', width: 30, height: 24, corridorWidth: 3,
    rooms: locations.map((x, i) => ({ ...x, side: i < 3 ? 'north' : 'south', w: 8, h: 7 })),
    contents: [{ id: 'review-shelf', name: '书架', roomId: locations[0].id, type: 'shelf', w: 3, h: 1 }], actors: [], items: [] }, context);
  const city = generateCity({ id: 'world', width: 1200, height: 900, riverWidth: 36, blocksPerDistrict: 3,
    districts: locations.slice(0, 4).map((x, i) => ({ ...x, bank: i % 2 ? 'east' : 'west', order: Math.floor(i / 2) })),
    buildings: [] }, { ...context, map: { ...context.map, metersPerCell: 30, frame: { cols: 40, rows: 30 } } });
  for (const [kind, generated] of [['floor', floor], ['city', city]]) {
    if (!generated.ok) throw new Error(JSON.stringify(generated.issues));
    const proof = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    proof.on('pageerror', e => pageErrors.push(e.message));
    proof.on('response', r => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`); });
    await exposeController(proof);
    await proof.addInitScript(scene => { globalThis.__reviewSeedScene = scene; }, generated.scene);
    await proof.route('**/dev-preview/index.html', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const marker = 'await sqlRuntime.closeSqlSession(migrated.session);';
      if (!source.includes(marker)) throw new Error('预览隔离数据库入口已变化');
      await route.fulfill({ response, body: source.replace(marker, `
        const db = migrated.session.repo.db;
        const frame = JSON.parse(db.exec("SELECT frame_json FROM maps WHERE id='world' AND branch_id='main'")[0].values[0][0]);
        frame.atlasScene = globalThis.__reviewSeedScene;
        db.run("UPDATE maps SET frame_json=? WHERE id='world' AND branch_id='main'", [JSON.stringify(frame)]);
        const saved = await sqlRuntime.persistSqlSession(migrated.session);
        if (!saved.saved) throw Error(JSON.stringify(saved.issues));
        ${marker}`) });
    });
    await proof.goto(`${base}/dev-preview/index.html`);
    await proof.waitForFunction(expected => globalThis.__atlasBrowserReview?.renderer?.state.kind === expected, kind, { timeout: 15000 });
    await proof.waitForTimeout(150);
    const actual = await proof.evaluate(() => {
      const r = __atlasBrowserReview.renderer, canvas = document.querySelector('.aw-spatial-canvas');
      return { kind: r.state.kind, mapId: r.state.document.mapId, rooms: r.state.scene.rooms?.length ?? 0,
        districts: r.state.scene.districts?.length ?? 0, entities: r.entities().length, width: canvas.width, height: canvas.height };
    });
    check(`已保存 ${kind} 场景经 SQL 进入实际 Canvas`, actual.kind === kind && actual.width > 0 && actual.entities > 0, actual);
    await proof.screenshot({ path: `${evidenceDir}/${kind}.png` });
    await proof.close();
  }

  check("无未捕获 pageerror", pageErrors.length === 0, pageErrors.slice(0, 5));
  check("无 4xx/5xx 资源请求", badResponses.length === 0, badResponses.slice(0, 5));

  report.finishedAt = new Date().toISOString();
  report.pageErrors = pageErrors;
  report.badResponses = badResponses;
  report.sceneStatuses = backend.sceneItems;
  report.mapIds = backend.mapIds;
  report.summary = map.summary;
  report.timeline = map.timeline;
  mkdirSync("docs", { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  writeFileSync(`${evidenceDir}/evidence-${stamp}.json`, JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  if (server) server.kill();
}

console.log(JSON.stringify(report, null, 2));
if (failed.length > 0) {
  console.error(`\n浏览器验收未通过（${failed.length} 项）：`);
  for (const line of failed) console.error(" - " + line);
  process.exitCode = 1;
} else {
  console.log("\n浏览器验收全部通过。");
}
