import {launchAtlasBrowser} from '../atlas-browser.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'artifacts/map-lab');
const browser=await launchAtlasBrowser();
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

  // The retired .aw-* panel cannot validate today's native iframe. Run its current gate.
  await page.close();await browser.close();
  const nativeDir=join(output,'native-reference');const result=await promisify(execFile)(process.execPath,['tools/verify-reference-browser.mjs'],{cwd:root,env:{...process.env,ATLAS_VERIFY_SKINS:'0',ATLAS_VERIFY_PORT:'4299',ATLAS_EVIDENCE_DIR:nativeDir},maxBuffer:8*1024*1024});
  console.log(result.stdout);const evidence=JSON.parse(readFileSync(join(nativeDir,'evidence.json'),'utf8'));assert.deepEqual(evidence.failed,[]);assert.deepEqual(evidence.errors,[]);check('current-packaged-ui',{checks:Object.keys(evidence.checks).length,errors:evidence.errors.length,evidence:nativeDir});
  assert.deepEqual(report.browserErrors, []);
  writeFileSync(join(output, 'verification.json'), JSON.stringify(report, null, 2));
  console.log('All map browser checks passed; no SillyTavern writes or model API calls.');
} finally { await browser.close(); }
