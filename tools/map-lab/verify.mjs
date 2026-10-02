import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMapLabFixture } from './fixtures.mjs';
import { createDefaultSettingsV2, settingsViewV2 } from '../../src/atlas-settings.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'artifacts/map-lab');
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.ATLAS_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const report = { checks: [], networkRequests: [], browserErrors: [] };
const check = (name, data) => { report.checks.push({ name, data }); console.log(name, JSON.stringify(data)); };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.on('pageerror', error => report.browserErrors.push(String(error)));
  page.on('request', request => { if (/^https?:/.test(request.url())) report.networkRequests.push(request.url()); });
  await page.goto(pathToFileURL(join(output, 'index.html')).href);
  await page.waitForFunction(() => Boolean(window.atlasMapLab));
  let state = await page.evaluate(() => window.atlasMapLab.inspect());
  assert.deepEqual(state.scene.frame, { cols: 12, rows: 8 });
  assert.equal(state.scene.markers.length, 6);
  assert.ok(state.scene.markers.every(point => point.x > 0 && point.x < 12 && point.y > 0 && point.y < 8));
  assert.ok(state.sourcesUnchanged);
  check('small-room', { frame: state.scene.frame, characters: state.scene.markers.length });
  await page.evaluate(() => {
    const lab = window.atlasMapLab;
    lab.map.setView(lab.coordinates.atlasToSimple({ x: 6.5, y: 4.5 }), 4, { animate: false });
    lab.openScene('world'); lab.openScene('6');
  });
  state = await page.evaluate(() => window.atlasMapLab.inspect());
  assert.equal(state.camera.x, 6.5); assert.equal(state.camera.y, 4.5); assert.equal(state.camera.zoom, 4);
  assert.equal(await page.locator('#crumbs button').count(), 7);
  check('hierarchy-and-camera', { crumbCount: 7, camera: state.camera });
  const gridScales = await page.evaluate(() => {
    const lab = window.atlasMapLab, states = [];
    for (const zoom of [-2, 3, 6]) {
      lab.map.setZoom(zoom, { animate: false }); const g = lab.inspect().grid;
      states.push({ zoom, majorStep: g.majorStep, minorHidden: g.minorHidden, subdivision: g.subdivision });
    }
    return states;
  });
  assert.ok(gridScales[0].minorHidden); assert.equal(gridScales[2].subdivision, 5);
  check('adaptive-grid', gridScales);
  await page.selectOption('#scenario', 'crowd');
  await page.waitForTimeout(100);
  const cluster = page.locator('.lab-cluster').first(); await cluster.click();
  assert.equal(await page.locator('[data-member-id]').count(), 50);
  await page.locator('[data-member-id="npc:student-49"]').click();
  assert.match(await page.locator('.leaflet-popup-content').innerText(), /同学50/);
  await page.evaluate(() => window.atlasMapLab.map.closePopup());
  await cluster.click(); await page.locator('[data-spread]').click();
  assert.equal(await page.locator('.lab-pin--character').count(), 50);
  await page.evaluate(() => window.atlasMapLab.openScene('world'));
  assert.equal(await page.locator('.lab-pin--character').count(), 0);
  await page.evaluate(() => window.atlasMapLab.openScene('6'));
  state = await page.evaluate(() => window.atlasMapLab.inspect());
  assert.equal(state.markers.length, 50);
  assert.ok(state.markers.every(pin => pin.latlng.lat === pin.original[0] && pin.latlng.lng === pin.original[1]));
  assert.ok(state.sourcesUnchanged);
  check('crowd-access-and-position', { members: 50, finalMemberAccessible: true, spiderfied: 50, sourcesUnchanged: true });
  await page.selectOption('#scenario', 'building');
  assert.equal((await page.evaluate(() => window.atlasMapLab.inspect())).scene.floorplan.regions.filter(area => area.childId).length, 6);
  for (const width of [1280, 540]) {
    await page.setViewportSize({ width, height: 820 }); await page.waitForTimeout(100);
    const layout = await page.evaluate(() => {
      const nav = document.querySelector('nav').getBoundingClientRect(), map = document.querySelector('#map').getBoundingClientRect();
      return { overlap: nav.bottom > map.top + 1, scrollWidth: document.documentElement.scrollWidth, width: innerWidth };
    });
    assert.equal(layout.overlap, false); assert.ok(layout.scrollWidth <= layout.width);
    await page.screenshot({ path: join(output, `building-${width}.png`) });
    check(`leaflet-layout-${width}`, layout);
  }
  await page.setViewportSize({ width: 1280, height: 820 }); await page.selectOption('#scenario', 'school');
  await page.screenshot({ path: join(output, 'classroom-1280.png') });
  assert.deepEqual(report.networkRequests, []);

  // Exercise the actual Atlas panel, with fixture-only requests intercepted in this browser.
  const panel = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  panel.on('pageerror', error => report.browserErrors.push(String(error)));
  const prefix = '/scripts/extensions/third-party/atlas-sillytavern-plugin/';
  const files = new Map(['index.js', 'style.css', 'dist/atlas-ui-core.mjs'].map(path => [path, readFileSync(join(root, path), 'utf8')]));
  await panel.route('**/*', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body style="margin:0"></body></html>' });
    const key = pathname.slice(prefix.length);
    if (!pathname.startsWith(prefix) || !files.has(key)) return route.abort();
    return route.fulfill({ contentType: key.endsWith('.css') ? 'text/css' : 'text/javascript', body: files.get(key) });
  });
  await panel.goto('http://atlas-map-validation.invalid/fixture');
  const fixture = createMapLabFixture();
  await panel.evaluate(async ({ view, settings, prefix }) => {
    const source = await (await fetch(prefix + 'index.js')).text();
    const module = await import(URL.createObjectURL(new Blob([source + '\nexport { renderPanel };'], { type: 'text/javascript' })));
    const mod = await import(prefix + 'dist/atlas-ui-core.mjs');
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = prefix + 'style.css'; document.head.append(css);
    await new Promise(resolve => css.onload = resolve);
    const state = { page: 'map', panelOpen: true, receipts: [], serviceStatus: 'online', mode: 'online', chatId: 'map-lab-fixture',
      stateData: { chatId: 'map-lab-fixture', worldId: 'map-lab-fixture', worldName: '地图交互验收', currentTime: 1,
        currentLocationId: '6', tableMap: view, map: { points: [], regions: [], submaps: {}, pointMeta: {}, calibrations: {} }, npcDirectory: [], objectDirectory: [], regions: [] } };
    const core = { getState: () => state, setPage: () => {}, setPanelOpen: () => {}, refresh: async () => {} };
    const root = document.createElement('div'); document.body.append(root);
    module.renderPanel(core, root, { request: async () => ({ status: 200, body: { ok: true, data: settings } }) }, { read: async () => null }, mod);
  }, { view: fixture.view, settings: settingsViewV2(createDefaultSettingsV2()), prefix });
  for (let id = 1; id <= 5; id++) {
    await panel.locator(`.aw-point[data-point-id="${id}"]`).click();
    await panel.locator('.aw-mappanel button').filter({ hasText: '进入内部地图' }).click();
  }
  for (const width of [1280, 540]) {
    await panel.setViewportSize({ width, height: 820 }); await panel.waitForTimeout(100);
    const room = panel.locator('.aw-floorplan-room[data-child-id="6"]');
    await room.click({ position: { x: 5, y: 5 } });
    assert.match(await panel.locator('.aw-mappanel').innerText(), /二年三班教室/);
    await panel.evaluate(() => document.querySelector('.aw-viewport').dispatchEvent(new MouseEvent('click')));
    const result = await panel.evaluate(() => {
      const area = document.querySelector('.aw-floorplan-room[data-child-id="6"]'),
        stage = document.querySelector('.aw-stage'), view = document.querySelector('.aw-viewport').getBoundingClientRect(),
        tools = document.querySelector('.aw-maptools').getBoundingClientRect(), crumbs = document.querySelector('.aw-mapcrumb').getBoundingClientRect();
      const scale = new DOMMatrix(getComputedStyle(stage).transform).a;
      return { rooms: document.querySelectorAll('.aw-floorplan-room[data-child-id]').length,
        overlap: tools.bottom > crumbs.top + 1 || crumbs.bottom > view.top + 1,
        screenBorderWidth: parseFloat(getComputedStyle(area).boxShadow.match(/[-\d.]+px/g).at(-1)) * scale };
    });
    assert.equal(result.rooms, 6); assert.equal(result.overlap, false);
    assert.ok(Math.abs(result.screenBorderWidth - 1.5) < .05);
    await panel.screenshot({ path: join(output, `atlas-building-${width}.png`) });
    check(`atlas-region-interaction-${width}`, result);
  }
  assert.deepEqual(report.browserErrors, []);
  writeFileSync(join(output, 'verification.json'), JSON.stringify(report, null, 2));
  console.log('All map browser checks passed; no SillyTavern writes or model API calls.');
} finally { await browser.close(); }
