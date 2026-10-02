/** Actual 8000 host test. No intercepted requests, fixture injection or model requests. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const output = resolve('.tmp/map-live-20261003'); mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.ATLAS_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const report = { origin: 'http://127.0.0.1:8000', mockedRequests: false, generatedRequests: 0, errors: [], checks: [] };
const record = (name, details) => { report.checks.push({ name, details }); console.log(name, JSON.stringify(details)); };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message.slice(0, 250)));
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/backends/chat-completions/generate') report.generatedRequests++;
  });
  await page.goto(report.origin, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.SillyTavern?.getContext?.()?.characters?.length > 0);
  const before = await page.evaluate(async () => {
    const st = await import('/script.js');
    const index = SillyTavern.getContext().characters.findIndex(row => row.name === 'Atlas 自动化验收 20260930');
    if (index < 0) throw Error('Dedicated test character missing');
    await st.selectCharacterById(index);
    await st.openCharacterChat('Atlas 自动化验收 20260930 - 2026-09-30@02h16m18s601ms');
    const ext = await import('/scripts/extensions/third-party/atlas-sillytavern-plugin/index.js');
    const mounted = await ext.connectAtlas(); await mounted.core.refresh();
    if (mounted.core.getState().pendingTurn) throw Error('Test chat already has a pending turn');
    mounted.core.setPanelOpen(true); mounted.core.setPage('map'); mounted.rerender();
    window.liveMapBefore = { tableMap: JSON.stringify(mounted.core.getState().stateData.tableMap),
      metadata: JSON.stringify(SillyTavern.getContext().chatMetadata), chat: JSON.stringify(SillyTavern.getContext().chat) };
    const source = await (await fetch('/scripts/extensions/third-party/atlas-sillytavern-plugin/index.js')).text();
    return { version: ext.ATLAS_EXTENSION_VERSION, newRoomButtons: source.includes('el(area.childId ? "button" : "div", className)'),
      messages: SillyTavern.getContext().chat.length, totals: mounted.core.getState().stateData.tableMap.totals };
  });
  assert.ok(before.newRoomButtons); record('real-host-and-revision', before);
  const tutorialClose = page.locator('.acu-tutorial-overlay button[title="关闭教程"]');
  await tutorialClose.waitFor({ state: 'visible', timeout: 6000 }).catch(error => {
    if (error.name !== 'TimeoutError') throw error;
  });
  if (await tutorialClose.isVisible()) {
    await tutorialClose.click();
    await page.locator('.acu-tutorial-overlay').waitFor({ state: 'hidden' });
    record('other-plugin-tutorial-dismissed', { closedThroughButton: true });
  }
  const enter = async id => {
    await page.locator(`.aw-point[data-point-id="${id}"]`).click();
    await page.locator('.aw-mappanel button').filter({ hasText: '进入内部地图' }).click();
  };
  const close = async () => {
    const button = page.locator('.aw-mappanel__close'); if (await button.isVisible()) await button.click();
  };
  const geometry = () => page.evaluate(() => {
    const rooms = [...document.querySelectorAll('.aw-floorplan-room[data-child-id]')];
    const stage = document.querySelector('.aw-stage'), matrix = new DOMMatrix(getComputedStyle(stage).transform);
    const view = document.querySelector('.aw-viewport');
    return { rooms: rooms.length, transform: { k: matrix.a, x: matrix.e, y: matrix.f },
      camera: { k: matrix.a, cx: (view.clientWidth / 2 - matrix.e) / matrix.a,
        cy: (view.clientHeight / 2 - matrix.f) / matrix.a,
        zoomPercent: Number.parseInt(document.querySelector('.aw-zoom__label').textContent) },
      lines: rooms.map(room => parseFloat(getComputedStyle(room).boxShadow.match(/[-\d.]+px/g).at(-1)) * matrix.a) };
  });
  for (const id of ['7', '1', '4']) await enter(id);
  let building = await geometry(); assert.equal(building.rooms, 6);
  const roomIds = await page.locator('.aw-floorplan-room[data-child-id]').evaluateAll(nodes => nodes.map(node => node.dataset.childId));
  for (const id of roomIds) {
    const room = page.locator(`.aw-floorplan-room[data-child-id="${id}"]`);
    const label = await room.getAttribute('aria-label');
    await room.click({ position: { x: 5, y: 5 } });
    assert.ok((await page.locator('.aw-mappanel').innerText()).includes(label.split('，')[0]));
    await close();
  }
  record('six-real-room-regions', { clicked: roomIds.length });
  await page.getByRole('button', { name: '放大地图', exact: true }).click();
  await page.getByRole('button', { name: '放大地图', exact: true }).click();
  building = await geometry(); assert.ok(building.lines.every(width => Math.abs(width - 1.5) < .05));
  await page.locator('.aw-floorplan-room[data-child-id="9"]').click({ position: { x: 5, y: 5 } });
  await page.locator('.aw-mappanel button').filter({ hasText: '进入内部地图' }).click();
  const classroom = await page.evaluate(() => ({ player: document.querySelector('.aw-current-position')?.textContent,
    boundary: document.querySelector('.aw-scene-boundary__label')?.textContent,
    fixtures: document.querySelectorAll('.aw-room-fixture').length,
    rosterHidden: getComputedStyle(document.querySelector('.aw-interior-roster')).display === 'none',
    crumb: document.querySelector('.aw-mapcrumb')?.textContent }));
  assert.ok(classroom.player?.includes('你在这里')); assert.ok(classroom.boundary?.includes('教室'));
  assert.ok(classroom.fixtures >= 8); assert.ok(classroom.rosterHidden);
  await page.getByRole('button', { name: '定位当前位置', exact: true }).click();
  record('real-classroom-and-location', classroom);
  await page.screenshot({ path: resolve(output, 'classroom-desktop.png') });
  await page.locator('.aw-mapcrumb__back').click();
  const restored = await geometry();
  record('parent-camera-comparison', { before: building, after: restored });
  // A location status message can change viewport height; compare center and relative zoom.
  for (const key of ['zoomPercent', 'cx', 'cy']) assert.ok(Math.abs(restored.camera[key] - building.camera[key]) < .01);
  record('parent-camera-restored', { transform: restored.transform, screenLines: restored.lines });
  for (const width of [1280, 540]) {
    await page.setViewportSize({ width, height: 820 }); await page.waitForTimeout(250);
    const layout = await page.evaluate(() => {
      const tools = document.querySelector('.aw-maptools').getBoundingClientRect(),
        crumb = document.querySelector('.aw-mapcrumb').getBoundingClientRect(),
        view = document.querySelector('.aw-viewport').getBoundingClientRect();
      return { overlap: tools.bottom > crumb.top + 1 || crumb.bottom > view.top + 1,
        width: innerWidth, viewportWidth: view.width };
    });
    assert.equal(layout.overlap, false);
    await page.locator('.aw-floorplan-room[data-child-id="12"]').click({ position: { x: 5, y: 5 } });
    assert.match(await page.locator('.aw-mappanel').innerText(), /教务处/); await close();
    record(`real-layout-${width}`, layout);
    await page.screenshot({ path: resolve(output, `building-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 820 }); await page.waitForTimeout(200);
  await page.locator('.aw-mapcrumb__back').click();
  await enter('14');
  const street = await page.locator('.aw-object--npc').evaluateAll(nodes => nodes.map(node => ({
    id: node.dataset.npcId, name: node.querySelector('.aw-object__name')?.textContent,
    x: node.style.left, y: node.style.top,
  })));
  assert.equal(street.length, 2);
  for (const pin of street) {
    await page.locator(`.aw-object--npc[data-npc-id="${pin.id}"]`).click();
    assert.ok((await page.locator('.aw-mappanel').innerText()).includes(pin.name)); await close();
  }
  record('real-street-characters', { characters: street, clicked: street.length });
  await page.screenshot({ path: resolve(output, 'street-desktop.png') });
  const after = await page.evaluate(async () => {
    const ext = await import('/scripts/extensions/third-party/atlas-sillytavern-plugin/index.js');
    const mounted = await ext.connectAtlas(); await mounted.core.refresh();
    return { tableMapUnchanged: window.liveMapBefore.tableMap === JSON.stringify(mounted.core.getState().stateData.tableMap),
      metadataUnchanged: window.liveMapBefore.metadata === JSON.stringify(SillyTavern.getContext().chatMetadata),
      chatUnchanged: window.liveMapBefore.chat === JSON.stringify(SillyTavern.getContext().chat),
      messages: SillyTavern.getContext().chat.length, pending: !!mounted.core.getState().pendingTurn,
      hasError: !!mounted.core.getState().lastError };
  });
  assert.ok(after.tableMapUnchanged); assert.ok(after.metadataUnchanged); assert.ok(after.chatUnchanged);
  assert.equal(after.pending, false); assert.equal(after.hasError, false);
  assert.equal(after.messages, before.messages); assert.equal(report.generatedRequests, 0); assert.deepEqual(report.errors, []);
  record('real-data-unchanged', after);
  writeFileSync(resolve(output, 'verification.json'), JSON.stringify(report, null, 2));
  console.log('Real SillyTavern map checks passed.');
} catch (error) {
  writeFileSync(resolve(output, 'verification.failed.json'), JSON.stringify({ ...report, failure: error.message }, null, 2));
  throw error;
} finally { await browser.close(); }
