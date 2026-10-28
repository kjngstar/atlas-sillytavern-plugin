import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { parseOperations } from '../src/atlas-ops-parser.ts';
import { normalizeOperation, normalizeSpaceStateUpdates, validateMinimum } from '../src/atlas-ops-normalize.ts';
import { createDefaultSettingsV2, applySettingsCommand, sanitizeSettingsV2 } from '../src/atlas-settings.ts';
import { normalizeCompletionPolicy, normalizeConstructionOps } from '../src/atlas-sql-world-completion.ts';
import { constructionBudget, selectWithinBudget } from '../src/atlas-construction-budget.ts';
import { buildAtlasPromptPack, parseAtlasPromptImport } from '../index.js';
import * as Kit from '../vendor/atlas-spatial/index.mjs';

const scope = { chatId: 'capacity-test', branchId: 'b1', revision: 1, viewMode: 'author' };
function context(rooms) {
  const row = (id, kind, parent) => ({ branch_id: 'b1', id, name: id, status: 'active', kind,
    parent_location_id: parent, map_id: parent ? 'M1' : null, grid_x: null, grid_y: null,
    coord_precision: 'unknown', area_geometry_json: null });
  const built = Kit.buildLayoutContext({ scope,
    mapRow: { branch_id: 'b1', id: 'M1', name: 'Floor', container_location_id: 'B1',
      frame_json: { cols: 75, rows: 80 }, meters_per_cell: 1, scale_quality: 'exact', scale_locked: 0, row_rev: 1 },
    locations: [row('B1', 'building', null), ...rooms.map(room => row(room.id, 'room', 'B1'))],
    characters: [], items: [], routes: [] });
  assert.equal(built.ok, true);
  return built.context;
}

test('a valid layout above 8 KiB passes parsing, normalization and the real generator', () => {
  const rooms = [{ id: 'R1', name: 'Hall', side: 'north', w: 30, h: 30 }];
  const spec = { rooms, contents: Array.from({ length: 110 }, (_, i) =>
    ({ id: `F${i}`, name: `Chair ${i}`, roomId: 'R1', type: 'chair', w: 0.5, h: 0.5 })) };
  const operation = { op: 'map.layout.request', ref: 'M1', data: { kind: 'floor', spec } };
  assert.ok(Buffer.byteLength(JSON.stringify(operation)) > 8192);
  const parsed = parseOperations(JSON.stringify(operation), { phase: 'geography' });
  assert.equal(parsed.incomplete, false);
  assert.equal(parsed.operations.length, 1);
  const normalized = normalizeOperation(parsed.operations[0].value, 'geography');
  assert.ok(normalized.op, JSON.stringify(normalized.issues));
  assert.equal(validateMinimum(normalized.op, 'geography').ok, true);
  const result = Kit.generateFloor(normalized.op.data.spec, context(rooms));
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.scene.layout.groups.length, 110);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(Kit.checkSceneDocument(result.scene), []);
});

test('more than 64 completed operations retain their order and contents', () => {
  const operations = Array.from({ length: 100 }, (_, i) => ({ op: 'location.upsert', ref: `L${i}`, data: { name: `地点${i}` } }));
  const result = parseOperations(operations.map(op => JSON.stringify(op)).join('\n'), { phase: 'geography' });
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.operations.map(entry => entry.value), operations);
});

test('construction keeps both location and route work without an implicit total cap', () => {
  const known = new Set(['L1', 'L2']);
  const operations = [
    ...Array.from({ length: 80 }, (_, i) => ({ op: 'location.upsert', ref: `new:L${i}`, data: { name: `地点${i}`, parent_ref: 'L1' } })),
    ...Array.from({ length: 80 }, (_, i) => ({ op: 'route.propose', ref: `new:R${i}`, data: { from_ref: 'L1', to_ref: 'L2' } })),
  ];
  const policy = normalizeCompletionPolicy({ budgetMode: 'workload', maxNewLocations: 80, maxNewRoutes: 80 });
  assert.equal(policy.maxNewLocations, 80);
  const normalized = normalizeConstructionOps({ operations, knownIds: [...known], policy });
  assert.equal(normalized.operations.length, 160, JSON.stringify(normalized.issues));
  const budget = constructionBudget({ maxNewLocations: 80, maxNewRoutes: 80 });
  assert.equal(budget.totalOperations, null);
  assert.equal(selectWithinBudget(operations, { budget, knownIds: known }).accepted.length, 160);
  const explicit = selectWithinBudget(operations, { budget: { ...budget, totalOperations: 10 }, knownIds: known });
  assert.equal(explicit.accepted.length, 10);
  assert.equal(explicit.deferred.length, 150);
});

test('long configuration fields and more than 20 presets survive save and reload', () => {
  let settings = createDefaultSettingsV2();
  const systemPrompt = '长提示词🙂'.repeat(2000) + 'TAIL';
  const segments = Array.from({ length: 40 }, (_, i) => ({ role: 'user', name: `段${i}`, content: systemPrompt + i }));
  for (let i = 0; i < 25; i += 1) {
    const result = applySettingsCommand(settings, { action: 'prompt.save', preset: { name: `预设${i}`, systemPrompt, segments } });
    assert.equal(result.ok, true);
    settings = result.settings;
  }
  const bodyParams = JSON.stringify({ extra: 'x'.repeat(5000) });
  const requestHeaders = 'X-Extra: ' + 'x'.repeat(3000);
  const excludeBodyParams = 'x'.repeat(3000);
  const key = 'k'.repeat(5000);
  for (let i = 0; i < 25; i += 1) {
    const result = applySettingsCommand(settings, { action: 'api.save', apiKeyMode: 'replace', apiKey: key,
      preset: { name: '长连接名称'.repeat(20) + i, endpoint: 'https://example.test/v1', model: 'm'.repeat(150),
        maxTokens: 0, temperature: 0.7, topP: 0.95, timeoutMs: 60000, systemPrompt, bodyParams, requestHeaders, excludeBodyParams } });
    assert.equal(result.ok, true);
    settings = result.settings;
  }
  const reloaded = sanitizeSettingsV2(JSON.parse(JSON.stringify(settings))).settings;
  assert.equal(reloaded.promptPresets.length, 25);
  assert.equal(reloaded.apiPresets.length, 25);
  assert.deepEqual(reloaded.promptPresets[24].segments, segments);
  assert.equal(reloaded.apiPresets[24].systemPrompt, systemPrompt);
  assert.equal(reloaded.apiPresets[24].bodyParams, bodyParams);
  assert.equal(reloaded.apiPresets[24].requestHeaders, requestHeaders);
  assert.equal(reloaded.apiPresets[24].excludeBodyParams, excludeBodyParams);
  assert.equal(reloaded.apiPresets[24].apiKey, key);
  assert.equal(reloaded.apiPresets[24].name, '长连接名称'.repeat(20) + 24);
});

test('prompt export/import preserves every segment beyond the former file and text caps', () => {
  const segments = Array.from({ length: 70 }, (_, i) => ({ role: 'system', content: '中文🙂'.repeat(3000) + `END_${i}` }));
  const source = { name: '长名称'.repeat(40), segments };
  const pack = buildAtlasPromptPack(source);
  assert.ok(Buffer.byteLength(pack) > 512 * 1024);
  const imported = parseAtlasPromptImport(pack);
  assert.equal(imported.ok, true, imported.error);
  assert.equal(imported.presets[0].name, source.name);
  assert.deepEqual(imported.presets[0].segments, segments);
});

test('the actual preset editor store saves and reloads more than 64 long segments', async () => {
  const dom = new JSDOM('', { url: 'https://example.test/', runScripts: 'outside-only' });
  try {
    dom.window.eval(readFileSync(new URL('../ui/atlas-reference/js/presets.js', import.meta.url), 'utf8'));
    const seed = [{ id: 'seed', name: 'seed', role: 'system', enabled: true, content: 'seed' }];
    const store = dom.window.AtlasPresetStore.create(seed);
    const segments = Array.from({ length: 70 }, (_, i) => ({ id: `long-${i}`, name: `段${i}`, role: 'user', enabled: true, content: 'x'.repeat(9000) + i }));
    store.draft('prompt').segments = segments;
    assert.equal(await store.save('prompt'), true);
    const reloaded = dom.window.AtlasPresetStore.create(seed);
    assert.deepEqual(JSON.parse(JSON.stringify(reloaded.draft('prompt').segments)), segments);
  } finally { dom.window.close(); }
});

test('a floor can contain more than 24 registered rooms when its geometry fits', () => {
  const rooms = Array.from({ length: 30 }, (_, i) => ({ id: `R${i}`, side: i % 2 ? 'north' : 'south', w: 2, h: 2 }));
  const result = Kit.generateFloor({ rooms }, context(rooms));
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.scene.layout.rooms.length, 30);
  assert.deepEqual(Kit.checkSceneDocument(result.scene), []);
});

test('the furnishing ledger preserves more than 128 old entries during a scene update', () => {
  const furnishing = Array.from({ length: 150 }, (_, i) => ({ localId: Kit.spaceLocalId('R1', `F${i}`), type: 'chair', name: `Chair ${i}`, itemId: null, widthM: 1, heightM: 1, quality: 'layout' }));
  const next = Kit.canonicalForScene({ units: 'meters', layout: { bounds: { w: 10, h: 10 }, groups: [], items: [] } },
    { version: 1, locationId: 'R1', revision: 1, size: null, furnishing }, 'R1', null);
  assert.deepEqual(next.furnishing, furnishing);
});

test('state patches accept more than 32 objects while still rejecting invalid boolean fields', () => {
  const updates = Array.from({ length: 50 }, (_, i) => ({ objectRef: `F${i}`, openingState: 'closed' }));
  assert.equal(normalizeSpaceStateUpdates({ updates }).ok, true);
  assert.equal(normalizeSpaceStateUpdates({ updates: [{ objectRef: 'F1', locked: 'yes' }] }).ok, false);
});
