import { stableHexHash } from './atlas-hash.ts';
import { AtlasDbError, queryBound } from './atlas-db-runtime.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import { createTableReadPort, pageAllRows } from './atlas-db-readport.ts';
import { readProgressRows, progressId, progressRowMutation } from './atlas-construction-progress.ts';
import { readSourceLedger } from './atlas-construction-sources.ts';
import { selectWorldConstructionSources } from './atlas-sql-world-sources.ts';
import { normalizeFrame } from './atlas-spatial-frame.ts';
import { readSpaceCanonical } from './atlas-space-canonical.ts';
import { classifyBuildRequirement, computeSourceCoverage, decodeSettlementPlanPart, planNpcInitialPlacement, planSettlementFacilities, resolveLocationDetailTier, splitSettlementPlan } from './atlas-world-build-plan.ts';
import { buildWorldBuildCoverage, nextJobStatus, planWorldBuildMutation, readNpcPlacementRecords, readWorldBuildJobs, readWorldBuildTargets, worldBuildJobMutation, worldBuildJobRowId } from './atlas-world-build-state.ts';
import { emptyRunnerLedger, freezeWindowSettings, nextRunnerDecision, stopBuildRun } from './atlas-world-build-runner.ts';
import { assessMapQuality } from './atlas-map-quality.ts';
import { planNewRouteMapAssignments } from './atlas-route-ownership-reconcile.ts';
import type { BuildRouteIntentV1 } from './atlas-route-ownership-reconcile.ts';
import type { WorldBuildJobV1, WorldBuildTargetV1, WorldBuildWorkKind } from './atlas-world-build-contract.ts';
import type { AtomicGroup, Issue, ParsedOperation, RowMutation, TurnInput } from './atlas-ops-contract.ts';
import type { WorldBuildReceiptV1 } from './atlas-world-contract.ts';
import { planLoreDelta, planStaleHashReplacement } from './atlas-lore-delta.ts';
import { readConfirmedSceneEntries } from './atlas-scene-entry-sql.ts';
import { sceneEntryActivation } from './atlas-scene-entry.ts';
import { readSceneFrame } from '../vendor/atlas-spatial/index.mjs';
import { computeMapLayoutSignature, computeMapLayoutSignatures, LAYOUT_CONTEXT_FRAME_KEY } from './atlas-sql-layout-task.ts';
import { resolveSpatialProfile } from './atlas-spatial-profile.ts';
import { projectRouteGeometry } from './atlas-db-views.ts';
import { sceneExpansionLocationIds } from './atlas-scene-expansion.ts';

const POLICY = 'world-build-v2';
const DISCOVERY_PAGE = 64;
const str = (value: unknown): string => typeof value === 'string' ? value : '';
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export type WorldBuildExecutionContext = {
  db: SqlDatabase;
  input: TurnInput;
  turnId: string;
  makeId: (kind: string, opId: string, alias: string) => string;
};

export type WorldBuildWindow = {
  job: WorldBuildJobV1;
  targets: WorldBuildTargetV1[];
  selected: WorldBuildTargetV1[];
  input: TurnInput;
  groups: AtomicGroup[];
  operations: ParsedOperation[];
  records: RowMutation[];
  issues: Issue[];
  window: boolean;
  beforeProgress: string;
  pendingLocalTargets: Set<string>;
};

export function currentBuildJob(db: SqlDatabase, branchId: string): WorldBuildJobV1 | null {
  const decoded = readWorldBuildJobs(readProgressRows(createTableReadPort(db), branchId));
  if (decoded.rejectedRows) throw new AtlasDbError('WORLD_BUILD_STATE_INVALID', '建设任务记录损坏，不能当成空队列重建', { issues: decoded.issues });
  const positions = new Map(queryBound(db, 'SELECT id, rowid AS ordinal FROM turns WHERE branch_id=?', [branchId]).map(row => [str(row['id']), Number(row['ordinal'])]));
  const ordered = [...decoded.values].sort((left, right) => (positions.get(right.originFloorId) ?? 0) - (positions.get(left.originFloorId) ?? 0));
  return ordered.find(job => job.kind === 'initialize' && ['pending', 'running', 'paused'].includes(job.status))
    ?? ordered.find(job => ['pending', 'running', 'paused'].includes(job.status)) ?? ordered[0] ?? null;
}

export function buildSourceManifestHash(snapshot: readonly import('./atlas-ops-contract.ts').SourceSnapshotEntry[]): string {
  return stableHexHash(JSON.stringify(snapshot.filter(source => source.kind === 'lorebook').map(source => [source.key, source.hash]).sort()));
}

type FrozenSource = { sourceKey: string; contentHash: string; included: boolean };
export function pendingWorldBuildEntries(db: SqlDatabase, branchId: string) {
  const handled = new Set(readProgressRows(createTableReadPort(db), branchId).filter(row => row.payload['payloadKind'] === 'world-build-entry/v1').map(row => str(row.payload['dedupeKey'])));
  return readConfirmedSceneEntries(db, branchId).filter(entry => !handled.has(entry.dedupeKey));
}
function frozenManifest(ctx: WorldBuildExecutionContext, job: WorldBuildJobV1): FrozenSource[] {
  return readProgressRows(createTableReadPort(ctx.db), ctx.input.anchor.branchId).filter(row => row.scopeKey === `world-build:${job.id}` && row.payload['payloadKind'] === 'world-build-manifest/v1').flatMap(row => {
    const entries = row.payload['entries'];
    if (!row.payloadOk || row.payload['version'] !== 1 || !Array.isArray(entries)) throw new AtlasDbError('WORLD_BUILD_MANIFEST_INVALID', '冻结来源清单损坏', {});
    return entries.map(entry => {
      if (!record(entry) || typeof entry['sourceKey'] !== 'string' || typeof entry['contentHash'] !== 'string' || typeof entry['included'] !== 'boolean')
        throw new AtlasDbError('WORLD_BUILD_MANIFEST_INVALID', '冻结来源字段非法', {});
      return { sourceKey: entry['sourceKey'], contentHash: entry['contentHash'], included: entry['included'] };
    });
  });
}

export function buildProgressFingerprint(db: SqlDatabase, branchId: string): string {
  return stableHexHash(JSON.stringify(queryBound(db, 'SELECT id,input_signature,status,payload_json FROM construction_progress WHERE branch_id=? ORDER BY id', [branchId])
    .filter(row => !str(row['payload_json']).includes('world-build-job/v1'))));
}

function sourceCoverage(ctx: WorldBuildExecutionContext, job: WorldBuildJobV1) {
  const rows = readProgressRows(createTableReadPort(ctx.db), ctx.input.anchor.branchId);
  const ledger = readSourceLedger(rows, `world-build-sources:${job.id}`);
  const processed = [...ledger.chunks.values()].filter(chunk => chunk.status === 'processed').map(chunk => chunk.chunkKey);
  const selection = selectWorldConstructionSources({ snapshot: ctx.input.sourceSnapshot.filter(source => source.kind === 'lorebook'), mode: 'consume', skipChunkKeys: processed,
    chatId: ctx.input.anchor.chatUid, branchId: ctx.input.anchor.branchId });
  return { coverage: computeSourceCoverage({ known: selection.known, deferred: selection.deferred, processedChunkKeys: processed,
    knownChunkKeys: [...ledger.chunks.keys()] }), ledger, selection };
}

function context(ctx: WorldBuildExecutionContext) {
  return { branchId: ctx.input.anchor.branchId, turnId: ctx.turnId, opId: `world-build:${ctx.turnId}` };
}

function group(ctx: WorldBuildExecutionContext, suffix: string, mutations: RowMutation[]): AtomicGroup[] {
  return mutations.length ? [{ id: `world-build:${ctx.turnId}:${suffix}`, opIds: [], dependsOn: [], readSet: [],
    mutations: mutations.map(mutation => ({ ...mutation, sourceOpIds: [`world-build:${ctx.turnId}:${suffix}`] })), purpose: 'bookkeeping' }] : [];
}

function programOp(key: string, value: ParsedOperation['value']): ParsedOperation {
  return { opId: `wb_${stableHexHash(key).slice(0, 24)}`, line: 1, rawHash: stableHexHash(JSON.stringify(value)), value };
}

function target(job: WorldBuildJobV1, kind: WorldBuildWorkKind, subject: string, signature: string, depth = 0): WorldBuildTargetV1 {
  return { version: 1, id: `${kind}:${stableHexHash(subject).slice(0, 24)}`, jobId: job.id, subjectId: subject, workKind: kind,
    requirement: 'source-required', depth, dependencyIds: [], inputSignature: signature, status: 'pending', attempts: 0,
    failureFingerprint: null, lastErrorCode: null, originFloorId: job.originFloorId, eventId: null };
}

function elementIds(value: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 12) return out;
  if (Array.isArray(value)) for (const entry of value) elementIds(entry, out, depth + 1);
  else if (record(value)) {
    for (const key of ['id', 'entityId', 'locationId', 'routeId']) if (typeof value[key] === 'string') out.add(value[key]);
    if (typeof value['id'] === 'string' && typeof value['roomId'] === 'string') out.add(`space:${value['roomId']}:furn:${value['id']}`);
    for (const entry of Object.values(value)) if (typeof entry === 'object') elementIds(entry, out, depth + 1);
  }
  return out;
}

export function worldBuildMapQuality(db: SqlDatabase, branchId: string, mapId: string) {
  const map = queryBound(db, 'SELECT * FROM maps WHERE branch_id=? AND id=?', [branchId, mapId])[0];
  if (!map) return null;
  const frame = normalizeFrame(map['frame_json']);
  const scene = frame['atlasScene'];
  const layout = record(scene) && record(scene['layout']) ? scene['layout'] : null;
  const required = queryBound(db, "SELECT * FROM locations WHERE branch_id=? AND map_id=? AND status='active' AND kind<>'floor' AND mobility<>'mobile' AND id<>COALESCE(?, '')", [branchId, mapId, map['container_location_id']]);
  const present = elementIds(layout);
  // A city can show a registered open place as a saved point when no footprint
  // is known. Rooms/buildings and places with an area still require geometry.
  if(layout?.['kind']==='city')for(const row of required){
    let area:unknown=row['area_geometry_json'];
    if(typeof area==='string'){try{area=JSON.parse(area);}catch{continue;}}
    const x=row['grid_x'],y=row['grid_y'];
    if(row['kind']==='other'&&!area&&row['coord_precision']!=='unknown'&&typeof x==='number'&&Number.isFinite(x)&&typeof y==='number'&&Number.isFinite(y)&&x>=0&&y>=0&&x<=Number(frame['cols'])&&y<=Number(frame['rows']))present.add(str(row['id']));
  }
  const canonical = readSpaceCanonical(frame, str(map['container_location_id'])).canonical;
  const requiredIds = [...required.map(row => str(row['id'])), ...(canonical?.furnishing ?? []).filter(entry => !entry.itemId).map(entry => entry.localId)];
  const missing = requiredIds.filter(id => !present.has(id));
  const checkedScene = readSceneFrame(frame,{branchId,mapId});
  const sceneErrors = (checkedScene.issues??[]).filter(issue=>issue.severity==='error').length
    + (record(scene) && Array.isArray(scene['issues']) ? scene['issues'].filter(issue => record(issue) && issue['severity'] === 'error').length : 0)
    + (layout && Array.isArray(layout['issues']) ? layout['issues'].filter(issue => record(issue) && issue['severity'] !== 'warning').length : 0);
  const routes = queryBound(db, "SELECT * FROM routes WHERE branch_id=? AND map_id=? AND status<>'closed'", [branchId,mapId]);
  const missingRoutes = routes.filter(route=>!present.has(str(route['id']))&&!projectRouteGeometry(route,mapId).geometry).map(route=>str(route['id']));
  const container = map['container_location_id'] ? queryBound(db,'SELECT * FROM locations WHERE branch_id=? AND id=?',[branchId,str(map['container_location_id'])])[0] : null;
  const parentContainer=container?.['parent_location_id']?queryBound(db,'SELECT * FROM locations WHERE branch_id=? AND id=?',[branchId,str(container['parent_location_id'])])[0]:null;
  const profile = resolveSpatialProfile({map,maps:pageAllRows(createTableReadPort(db),'maps',branchId),container,parentContainer,members:required,routes});
  return assessMapQuality({ mapId, layoutKind: layout ? str(layout['kind']) : null, calibrated: typeof map['meters_per_cell'] === 'number' && map['meters_per_cell'] > 0,
    scaleQuality: map['scale_quality'] === 'confirmed' ? 'confirmed' : map['scale_quality'] === 'estimated' ? 'estimated' : 'uncalibrated',
    checked: layout ? ['coverage', 'geometry-locks', 'navigability', 'scale', 'plausibility'] : [], coverage: { requiredMembers: requiredIds.length, presentMembers: requiredIds.length - missing.length, missingIds: missing },
    geometry: { hardErrors: sceneErrors, lockViolations: 0 },
    navigability:{requiredRoutes:routes.length,drawnRoutes:routes.length-missingRoutes.length,undrawnRouteIds:missingRoutes},
    plausibility:{unsupportedStructures:profile.unsupported.length} });
}

/** A retained picture is not evidence that the current structure was laid out. */
export function worldBuildMapReady(db: SqlDatabase, branchId: string, mapId: string, signatures?: ReadonlyMap<string,string>): boolean {
  const map = queryBound(db, 'SELECT frame_json FROM maps WHERE branch_id=? AND id=?', [branchId, mapId])[0];
  if (!map) return false;
  const frame = normalizeFrame(map['frame_json']);
  const request = frame['atlasLayoutRequest'];
  if (record(request) && (request['status'] === 'pending' || request['status'] === 'failed')) return false;
  const saved = frame[LAYOUT_CONTEXT_FRAME_KEY];
  const signature = signatures ? signatures.get(mapId) : computeMapLayoutSignature(createTableReadPort(db), branchId, mapId);
  if (!signature || !record(saved) || saved['hash'] !== signature) return false;
  const quality = worldBuildMapQuality(db, branchId, mapId);
  // An uncalibrated overview keeps scale=unknown; this never claims a full quality pass.
  return quality?.dimensions.coverage === 'pass' && quality.dimensions['geometry-locks'] === 'pass'
    && quality.dimensions.navigability === 'pass' && quality.dimensions.plausibility === 'pass';
}

function mapIssues(issues: readonly Issue[], mapId: string): Issue[] {
  return issues.filter(issue => {
    const pathMap = /^\$\.maps\.([^.[\]]+)/.exec(issue.path)?.[1];
    const messageMap = /(?:^|[\s｜])mapId=([^\s｜]+)/.exec(issue.message)?.[1];
    return pathMap ? pathMap === mapId : messageMap ? messageMap === mapId : true;
  });
}

function discover(ctx: WorldBuildExecutionContext, job: WorldBuildJobV1, previous: WorldBuildTargetV1[]): WorldBuildTargetV1[] {
  if (job.kind === 'entry') return previous;
  const tables = createTableReadPort(ctx.db), branchId = ctx.input.anchor.branchId;
  const byId = new Map(previous.map(entry => [entry.id, entry]));
  let added = 0;
  const add = (entry: WorldBuildTargetV1, manifestEntry = false) => {
    const old = byId.get(entry.id);
    if (old) {
      if (entry.workKind !== 'source-scan' && old.inputSignature !== entry.inputSignature) byId.set(entry.id, { ...entry, attempts: old.attempts });
      return;
    }
    if (!manifestEntry && added >= DISCOVERY_PAGE) return;
    byId.set(entry.id, entry); added++;
  };
  for (const source of ctx.input.sourceSnapshot.filter(source => source.kind === 'lorebook')) add(target(job, 'source-scan', source.key, source.hash), true);
  const turns=queryBound(ctx.db,'SELECT id,rowid AS ordinal,decisions_json FROM turns WHERE branch_id=?',[branchId]);
  const originOrdinal=Number(turns.find(turn=>turn['id']===job.originFloorId)?.['ordinal']??0);
  const ownedTurns=new Set(turns.filter(turn=>{
    if(Number(turn['ordinal'])<=originOrdinal)return true;
    try{const value:unknown=JSON.parse(str(turn['decisions_json']));return record(value)&&record(value['world_build'])&&value['world_build']['jobId']===job.id;}catch{return false;}
  }).map(turn=>str(turn['id'])));
  ownedTurns.add(ctx.turnId);
  const locations = pageAllRows(tables, 'locations', branchId).filter(row => row['status'] === 'active' && (job.kind!=='initialize'||ownedTurns.has(str(row['created_turn_id']))));
  const characters = pageAllRows(tables, 'characters', branchId);
  const sourceTargets = [...byId.values()].filter(entry => entry.workKind === 'source-scan');
  if (sourceTargets.some(entry => entry.status === 'pending' || entry.status === 'running')) return [...byId.values()];
  const inferred = new Set(readProgressRows(tables, branchId).filter(row => row.payload['payloadKind'] === 'world-build-facility/v1').map(row => str(row.payload['locationId'])));
  for (const location of locations) {
    const id = str(location['id']);
    if (['city', 'town', 'village', 'settlement'].includes(str(location['kind'])) && !inferred.has(id)) add(target(job, 'settlement-plan', id, stableHexHash(id)));
  }
  if ([...byId.values()].some(entry => entry.workKind === 'settlement-plan' && entry.status === 'pending')) return [...byId.values()];
  const maps = pageAllRows(tables, 'maps', branchId).filter(row => row['status'] === 'active' && (job.kind!=='initialize'||ownedTurns.has(str(row['created_turn_id']))));
  const signatures=computeMapLayoutSignatures(tables,branchId);
  const expanded=sceneExpansionLocationIds({locations,characters});
  const historical=job.kind==='lore-incremental'?readWorldBuildJobs(readProgressRows(tables,branchId)).values.filter(old=>old.id!==job.id).flatMap(old=>readWorldBuildTargets(readProgressRows(tables,branchId),old.id).values):[];
  for (const map of maps) {
    const id = str(map['id']), containerId = str(map['container_location_id']);
    const location = locations.find(row => row['id'] === containerId);
    const policy = classifyBuildRequirement({ location: location ?? { id, kind: map['kind'] }, origin: inferred.has(containerId) ? 'inferred' : 'source', canEnter: true, facts: [] });
    let depth = 0, parent = location;
    const seen = new Set<string>();
    while (parent && str(parent['parent_location_id']) && !seen.has(str(parent['id']))) { seen.add(str(parent['id'])); depth++; parent = locations.find(row => row['id'] === parent?.['parent_location_id']); }
    const members = locations.filter(row => row['map_id'] === id).map(row => row['id']).sort();
    const detail = resolveLocationDetailTier({ location: location ?? { id }, facts: [], knownCharacters: characters, plotLinks: [] });
    const entry = target(job, 'map-layout', id, stableHexHash(JSON.stringify([id, members, detail.tier])), depth);
    if(job.kind==='lore-incremental'&&historical.some(old=>old.workKind==='map-layout'&&old.subjectId===id&&old.inputSignature===entry.inputSignature)
      &&worldBuildMapReady(ctx.db,branchId,id,signatures))continue;
    if (policy.interiorPolicy === 'on-confirmed-entry'&&!expanded.has(containerId)&&!normalizeFrame(map['frame_json']).atlasScene) { entry.requirement = 'deferred-interior'; entry.status = 'waiting-for-entry'; }
    add(entry);
  }
  add(target(job, 'route-reconcile', branchId, stableHexHash(job.id)));
  add(target(job, 'npc-initial-placement', branchId, stableHexHash(job.id)));
  return [...byId.values()];
}

function planLocalWork(ctx: WorldBuildExecutionContext, plan: WorldBuildWindow): void {
  const tables = createTableReadPort(ctx.db), branchId = ctx.input.anchor.branchId;
  const locations = pageAllRows(tables, 'locations', branchId).filter(row => row['status'] === 'active');
  const progress = readProgressRows(tables, branchId);
  const addRecord = (key: string, payload: Record<string, unknown>) => {
    const scopeKey = `world-build:${plan.job.id}`;
    const id = progressId('unit', scopeKey, key);
    plan.records.push(progressRowMutation(context(ctx), { id, scopeKey, kind: 'unit', subjectKey: key }, tables.selectOne('construction_progress', branchId, id),
      { status: 'processed', inputSignature: stableHexHash(JSON.stringify(payload)), payload }));
  };
  for (const selected of plan.selected) {
    if (selected.workKind === 'settlement-plan' && plan.operations.length >= 32) { plan.pendingLocalTargets.add(selected.id); continue; }
    if (selected.workKind === 'settlement-plan' && plan.operations.length < 32) {
      const settlement = locations.find(row => row['id'] === selected.subjectId);
      if (!settlement) continue;
      const childLocations = locations.filter(row => row['parent_location_id'] === selected.subjectId);
      const text = ctx.input.sourceSnapshot.filter(source => source.kind === 'lorebook').map(source => source.text).join('\n');
      const worldviewTags = /现代|都市|当代|汽车|电力/.test(text) ? ['modern'] : /中世纪|骑士|领主/.test(text) ? ['medieval'] : /魔法|奇幻|法师/.test(text) ? ['fantasy'] : [];
      const proposed = planSettlementFacilities({ settlementId: str(settlement['id']), worldviewTags, scaleClass: settlement['kind'] === 'city' ? 'large' : 'small',
        existingLocations: childLocations.map(row => ({ id: str(row['id']), name: str(row['name']), fromSource: row['existence_quality'] === 'confirmed' })) });
      plan.issues.push(...proposed.issues);
      const frozen=progress.filter(row=>row.payload['payloadKind']==='settlement-plan/v1'&&row.payload['settlementId']===selected.subjectId).map(row=>{
        const part=decodeSettlementPlanPart(row.payload);if(!part)throw new AtlasDbError('SETTLEMENT_PLAN_INVALID','已保存设施方案损坏，不能重新估计替换',{});return part;
      }).sort((a,b)=>a.part-b.part);
      if(frozen.length&&(frozen.length!==frozen[0].totalParts||frozen.some((part,index)=>part.part!==index+1||part.inputSignature!==frozen[0].inputSignature)))throw new AtlasDbError('SETTLEMENT_PLAN_INVALID','设施方案分片不完整',{});
      const facilities=frozen.length?frozen.flatMap(part=>part.facilities):proposed.plan.facilities;
      if(!frozen.length)for(const part of splitSettlementPlan(proposed.plan,12))addRecord(`settlement-plan:${selected.subjectId}:${part.part}`,{payloadKind:'settlement-plan/v1',...part});
      const labels: Record<string, string> = { inn: '旅馆', market: '市场', smithy: '铁匠铺', temple: '神殿', stable: '马厩', well: '水井', granary: '粮仓', 'guard-post': '卫兵哨所', grocery: '杂货店', clinic: '诊所', school: '学校', cafe: '咖啡馆', station: '车站', pharmacy: '药房', bank: '银行', park: '公园' };
      for (const facility of facilities) {
        if (!facility.newLocationRef) continue;
        if (plan.operations.length >= 60) { plan.pendingLocalTargets.add(selected.id); continue; }
        const key = `facility:${selected.subjectId}:${facility.slotKey}`;
        const op = programOp(key, { op: 'location.upsert', ref: facility.newLocationRef,
          data: { name: labels[facility.purpose] ?? facility.purpose, kind: 'building', parent_ref: facility.districtId ?? selected.subjectId, existence_quality: 'inferred' }, source: 'estimate:world-build' });
        const locationId = ctx.makeId('location', op.opId, facility.newLocationRef.slice(4));
        if (tables.selectOne('locations', branchId, locationId)) continue;
        plan.operations.push(op, programOp(`${key}:route`, { op: 'route.propose', ref: `new:access_${stableHexHash(key).slice(0, 20)}`,
          data: { from_ref: selected.subjectId, to_ref: facility.newLocationRef, kind: 'road', bidirectional: true, quality: 'estimated' }, source: 'estimate:world-build' }));
        addRecord(key, { payloadKind: 'world-build-facility/v1', version: 1, locationId, settlementId: selected.subjectId, slotKey: facility.slotKey, purpose: facility.purpose, inputSignature: proposed.plan.inputSignature });
      }
    }
    if (selected.workKind === 'npc-initial-placement') {
      const placement = planNpcInitialPlacement({ characters: pageAllRows(tables, 'characters', branchId), locations, openJourneys: pageAllRows(tables, 'journeys', branchId),
        placed: readNpcPlacementRecords(progress).values, turnId: ctx.turnId, limit: 32 });
      plan.issues.push(...placement.issues);
      if (placement.skipped.some(entry => entry.reason === 'BATCH_LIMIT')) plan.pendingLocalTargets.add(selected.id);
      for (const entry of placement.placements) {
        plan.operations.push(programOp(`placement:${entry.characterId}`, { ...entry.op, source: 'estimate:world-build' }));
        addRecord(`placement:${entry.characterId}`, { ...entry.record, payloadKind: entry.record.kind, version: 1 });
      }
    }
    if (selected.workKind === 'route-reconcile') {
      const routes = pageAllRows(tables, 'routes', branchId);
      const intents: BuildRouteIntentV1[] = routes.filter(route => str(route['created_turn_id']).startsWith('turn_') && route['map_id'] === null).flatMap(route => {
        const journal = queryBound(ctx.db, "SELECT tc.basis_json FROM turn_changes tc JOIN turns t ON t.id=tc.turn_id WHERE t.branch_id=? AND tc.target_table='routes' AND tc.target_row_id=? AND tc.operation='insert' ORDER BY tc.sequence LIMIT 1", [branchId, str(route['id'])])[0];
        if (!journal) return [];
        let basis: unknown; try { basis = JSON.parse(str(journal['basis_json'])); } catch { return []; }
        if (!record(basis) || !record(basis['routeIntent']) || basis['routeIntent']['mapIntent'] !== 'omitted') return [];
        return [{ routeId: str(route['id']), originJobId: plan.job.id, sourceOperationId: str(basis['routeIntent']['sourceOperationId']), mapIntent: 'omitted', inferredMapId: null }];
      });
      const reconciled = planNewRouteMapAssignments({ intents, endpoints: intents.map(intent => {
        const route = routes.find(row => row['id'] === intent.routeId);
        return { routeId: intent.routeId, fromMapId: str(locations.find(row => row['id'] === route?.['from_location_id'])?.['map_id']) || null,
          toMapId: str(locations.find(row => row['id'] === route?.['to_location_id'])?.['map_id']) || null };
      }) });
      plan.issues.push(...reconciled.issues);
      for (const assignment of reconciled.assignments) if (assignment.action === 'assign' && assignment.mapId) {
        if (plan.operations.length >= 64) { plan.pendingLocalTargets.add(selected.id); continue; }
        const route = routes.find(row => row['id'] === assignment.routeId);
        if (route) {
          const from = locations.find(row => row['id'] === route['from_location_id']), to = locations.find(row => row['id'] === route['to_location_id']);
          const points = [from?.['grid_x'], from?.['grid_y'], to?.['grid_x'], to?.['grid_y']];
          const geometry = points.every(value => typeof value === 'number' && Number.isFinite(value)) ? { kind: 'line', coordinates: [[points[0], points[1]], [points[2], points[3]]] } : undefined;
          plan.operations.push(programOp(`route-map:${route['id']}:${assignment.mapId}`, { op: 'route.propose', ref: assignment.routeId,
            data: { map_ref: assignment.mapId, from_ref: route['from_location_id'], to_ref: route['to_location_id'], ...(geometry ? { geometry, quality: 'estimated' } : {}) }, source: 'estimate:world-build' }));
        }
      }
    }
  }
}

export function prepareWorldBuildWindow(ctx: WorldBuildExecutionContext): WorldBuildWindow {
  const request = ctx.input.worldBuild;
  if (!request) throw new AtlasDbError('INVALID_PAYLOAD', '缺少受信任的建设请求', {});
  const branchId = ctx.input.anchor.branchId;
  const rows = readProgressRows(createTableReadPort(ctx.db), branchId);
  const manifestHash = buildSourceManifestHash(ctx.input.sourceSnapshot);
  const existing = currentBuildJob(ctx.db, branchId);
  if (request.jobId && existing?.id !== request.jobId) throw new AtlasDbError('WORLD_BUILD_JOB_STALE', '建设任务已变化', {});
  if (request.expectedEpoch !== undefined && existing?.runEpoch !== request.expectedEpoch) throw new AtlasDbError('WORLD_BUILD_EPOCH_STALE', '建设运行票据已失效', {});
  const terminal = existing && ['completed', 'completed-with-issues', 'cancelled'].includes(existing.status);
  const entries = request.action === 'start' && terminal ? pendingWorldBuildEntries(ctx.db, branchId) : [];
  const entryJob = entries.length > 0;
  const incremental = Boolean(terminal && request.action === 'start' && existing.sourceManifestHash !== manifestHash);
  let job: WorldBuildJobV1 = existing && !incremental && !entryJob ? existing : { version: 1, id: `build_${stableHexHash(`${ctx.input.anchor.chatUid}:${branchId}:${manifestHash}:${existing?.id ?? 'initial'}:${entries.map(entry => entry.dedupeKey).join(',')}`).slice(0, 24)}`, branchId,
    kind: entryJob ? 'entry' : incremental ? 'lore-incremental' : 'initialize', status: 'running', sourceManifestHash: entryJob ? existing?.sourceManifestHash ?? manifestHash : manifestHash, policyVersion: POLICY, originFloorId: ctx.input.anchor.parentTurnId ?? ctx.turnId,
    runEpoch: 0, nextWindowSequence: 1, committedWindowSequence: 0, cumulativeTransports: 0, cumulativeWindows: 0, stopReason: null };
  const decoded = readWorldBuildTargets(rows, job.id);
  if (decoded.rejectedRows) throw new AtlasDbError('WORLD_BUILD_STATE_INVALID', '建设目标记录损坏', { issues: decoded.issues });
  let targets = decoded.values;
  let manifest = frozenManifest(ctx, job);
  const manifestMutations: RowMutation[] = [];
  if (request.abortedWindow) {
    const window = request.abortedWindow;
    if (!Number.isInteger(window.transports) || window.transports < 0) throw new AtlasDbError('WORLD_BUILD_AUDIT_INVALID', '实际发送计数非法', {});
    const scopeKey=`world-build:${job.id}`,subjectKey=`aborted:${window.id}`,id=progressId('unit',scopeKey,subjectKey);
    if (!rows.some(row=>row.id===id)) {
      job={...job,cumulativeTransports:job.cumulativeTransports+window.transports};
      manifestMutations.push(progressRowMutation(context(ctx),{id,scopeKey,kind:'unit',subjectKey},null,{status:'processed',inputSignature:window.id,
        payload:{payloadKind:'world-build-aborted-window/v1',version:1,id:window.id,transports:window.transports}}));
    }
  }
  for (const entry of entries) {
    const prior = existing ? readWorldBuildTargets(rows, existing.id).values : [];
    const activation = sceneEntryActivation(entry, prior);
    const ids = new Set(activation.activateTargetIds);
    const activated: WorldBuildTargetV1[] = prior.filter(target => ids.has(target.id)).map(target => ({ ...target, jobId: job.id, requirement: 'source-required' as const, status: 'pending' as const,
      originFloorId: entry.turnId, eventId: entry.eventId }));
    if (!activated.length && entry.interiorMapId) activated.push({ ...target(job, 'map-layout', entry.interiorMapId, stableHexHash(entry.dedupeKey)), originFloorId: entry.turnId, eventId: entry.eventId });
    targets.push(...activated.filter(target => !targets.some(old => old.id === target.id)));
    const scopeKey = `world-build:${job.id}`, subjectKey = `entry:${stableHexHash(entry.dedupeKey)}`, id = progressId('unit', scopeKey, subjectKey);
    manifestMutations.push(progressRowMutation(context(ctx), { id, scopeKey, kind: 'unit', subjectKey }, null,
      { status: 'processed', inputSignature: stableHexHash(entry.dedupeKey), payload: { payloadKind: 'world-build-entry/v1', ...entry } }));
  }
  if (!manifest.length && (!existing || incremental)) {
    const previous = existing ? frozenManifest(ctx, existing) : [];
    manifest = ctx.input.sourceSnapshot.filter(source => source.kind === 'lorebook').map(source => ({ sourceKey: source.key, contentHash: source.hash,
      included: !incremental || !previous.some(old => old.sourceKey === source.key && old.contentHash === source.hash) }));
    for (let offset = 0; offset < manifest.length; offset += 24) {
      const scopeKey = `world-build:${job.id}`, subjectKey = `manifest:${offset / 24}`, id = progressId('unit', scopeKey, subjectKey);
      manifestMutations.push(progressRowMutation(context(ctx), { id, scopeKey, kind: 'unit', subjectKey }, null,
        { status: 'processed', inputSignature: manifestHash, payload: { payloadKind: 'world-build-manifest/v1', version: 1, entries: manifest.slice(offset, offset + 24) } }));
    }
  }
  const incoming = ctx.input.sourceSnapshot.filter(source => source.kind === 'lorebook').map(source => ({ sourceKey: source.key, contentHash: source.hash }));
  const delta = planLoreDelta({ previous: manifest, next: incoming });
  const sourceIssues: Issue[] = [...delta.issues];
  for (const old of manifest.filter(entry => entry.included)) {
    const next = incoming.find(entry => entry.sourceKey === old.sourceKey);
    if (!next || next.contentHash !== old.contentHash) {
      const code = next ? 'LORE_STALE_HASH_SUPERSEDED' : 'LORE_PERMISSION_REVOKED';
      targets = targets.map(entry => entry.workKind === 'source-scan' && entry.subjectId === old.sourceKey && entry.status !== 'done' ? { ...entry, status: 'blocked', lastErrorCode: code } : entry);
      if (next) sourceIssues.push(...planStaleHashReplacement({ oldContentHash: old.contentHash, newContentHash: next.contentHash }).issues);
    }
  }
  // The initial denominator stays frozen. New hashes and new keys become a later incremental job.
  ctx = { ...ctx, input: { ...ctx.input, sourceSnapshot: ctx.input.sourceSnapshot.filter(source => job.kind === 'entry' || source.kind !== 'lorebook'
    || manifest.some(entry => entry.included && entry.sourceKey === source.key && entry.contentHash === source.hash)) } };
  const control = request.action === 'stop' || request.action === 'retry-failed' || request.action === 'start';
  if (request.action === 'stop') job = { ...stopBuildRun(job).job, stopReason: request.pauseReason ?? 'stopped' };
  if (request.action === 'start' && !['completed', 'completed-with-issues', 'cancelled'].includes(job.status)) job = { ...job, status: 'running', stopReason: null };
  if (request.action === 'retry-failed') {
    job = { ...job, status: 'running', stopReason: null, runEpoch: job.runEpoch + 1 };
    targets = targets.map(entry => entry.status === 'failed' || entry.status === 'blocked' ? { ...entry, status: 'pending', failureFingerprint: null, lastErrorCode: null } : entry);
  }
  targets = discover(ctx, job, targets);
  const readySignatures=computeMapLayoutSignatures(createTableReadPort(ctx.db),branchId);
  targets = targets.map(entry => entry.workKind === 'map-layout' && entry.status !== 'waiting-for-entry'
    && entry.subjectId && worldBuildMapReady(ctx.db, branchId, entry.subjectId,readySignatures)
    ? { ...entry, status: 'done', lastErrorCode: null, failureFingerprint: null } : entry);
  const sources = sourceCoverage(ctx, job);
  const frozen = freezeWindowSettings({ connectionId: 'selected-model-port', promptHash: POLICY, requestsPerOperation: ctx.input.generationOptions?.batching.requestsPerOperation ?? 0,
    batching: { maxUnitsPerWindow: 1, newUnitsPerRetry: 3 } });
  const ticket = { version: 1 as const, jobId: job.id, chatUid: ctx.input.anchor.chatUid, branchId, ownerFloorId: ctx.input.anchor.parentTurnId ?? ctx.turnId,
    baseRevision: ctx.input.anchor.baseRevision, baseStorageRevision: ctx.input.anchor.baseStorageRevision, sourceManifestHash: job.sourceManifestHash, runEpoch: job.runEpoch, windowSequence: job.nextWindowSequence };
  const decision = nextRunnerDecision({ job, targets, ledger: emptyRunnerLedger(), settings: frozen, ticket, current: ticket, sourceScanComplete: sources.coverage.sourceScanComplete,
    policy: { totalOperations: 64, maxNewLocations: 64, maxNewRoutes: 64 } });
  const selectedIds = new Set(!control && decision.kind === 'run-window' ? decision.units.flatMap(unit => unit.targetIds) : []);
  const selected = targets.filter(entry => selectedIds.has(entry.id));
  const kinds = new Set(selected.map(entry => entry.workKind));
  const input: TurnInput = { ...ctx.input, sourceSnapshot: [...ctx.input.sourceSnapshot, { key: 'estimate:world-build', hash: stableHexHash(POLICY), kind: 'estimate', text: '按有限设施方案与已有角色资料进行估计，不是角色已知事实。' }],
    constructionContinue: true, sceneOnly: true, manual: false, phaseBatches: [], sceneMaps: true,
    layoutMaps: kinds.has('map-layout') ? selected.filter(entry => entry.workKind === 'map-layout').map(entry => str(entry.subjectId)) : undefined,
    worldCompletion: kinds.has('source-scan') ? { mode: 'bootstrap', focusLocationIds: [], policy: { version: 1, density: 'balanced', maxNewLocations: 64, maxNewRoutes: 64, maxAdditionalDepth: 8 } } : undefined };
  const plan: WorldBuildWindow = { job, targets, selected, input, groups: [], operations: [], records: [], issues: [], window: selected.length > 0,
    beforeProgress: buildProgressFingerprint(ctx.db, branchId), pendingLocalTargets: new Set() };
  plan.issues.push(...sourceIssues);
  if (!control) planLocalWork(ctx, plan);
  const beforeRows = new Map(rows.map(row => [row.id, row.raw]));
  const state = planWorldBuildMutation({ job, targets: [], discoveredTargets: targets, coverage: sources.coverage, settlementPlansExpanded: targets.filter(entry => entry.workKind === 'settlement-plan').every(entry => entry.status === 'done'),
    maps: { registered: 0, ready: 0 }, ctx: context(ctx), beforeRows });
  // Start/control persists intent before any network window; terminal state is decided after discovery/execution.
  const jobMutation = worldBuildJobMutation(context(ctx), beforeRows.get(worldBuildJobRowId(job.id)) ?? null, job);
  plan.groups = [...state.groups.map(entry => ({ ...entry, mutations: entry.mutations.filter(mutation => mutation.rowId !== jobMutation.rowId) })), ...group(ctx, 'job', [jobMutation, ...manifestMutations])];
  return plan;
}

export function settleWorldBuildWindow(ctx: WorldBuildExecutionContext, plan: WorldBuildWindow, transports: number, issues: readonly Issue[]): { groups: AtomicGroup[]; receipt: WorldBuildReceiptV1 } {
  const tables = createTableReadPort(ctx.db), branchId = ctx.input.anchor.branchId;
  const sources = sourceCoverage(ctx, plan.job);
  const afterProgress = buildProgressFingerprint(ctx.db, branchId);
  const configuration = issues.find(issue => ['API_NOT_CONFIGURED', 'MODEL_PORT_MISSING', 'SQL_PROMPT_EMPTY', 'SQL_PROMPT_UNREADABLE', 'SQL_PROMPT_INCOMPATIBLE'].includes(issue.code));
  const readySignatures=computeMapLayoutSignatures(tables,branchId);
  let targets = plan.targets.map(entry => {
    if (entry.workKind === 'source-scan') {
      const known = sources.selection.known.find(source => source.sourceKey === entry.subjectId && source.contentHash === entry.inputSignature);
      const processed = [...sources.ledger.chunks.values()].filter(chunk => chunk.sourceKey === entry.subjectId && chunk.contentHash === entry.inputSignature && chunk.status === 'processed').length;
      if (known && !known.hostTruncated && known.chunkCount > 0 && processed >= known.chunkCount) return { ...entry, status: 'done' as const };
    }
    if (entry.workKind === 'map-layout' && entry.status !== 'waiting-for-entry'
      && entry.subjectId && worldBuildMapReady(ctx.db, branchId, entry.subjectId,readySignatures))
      return { ...entry, status: 'done' as const, lastErrorCode: null, failureFingerprint: null };
    if (!plan.selected.some(selected => selected.id === entry.id)) return entry;
    if (configuration) return entry;
    if (plan.pendingLocalTargets.has(entry.id)) return entry;
    const relevant = entry.workKind === 'map-layout' ? mapIssues(issues, entry.subjectId??'') : issues;
    const errors = relevant.filter(issue => issue.severity === 'error' || issue.retryable && !['MODEL_BUDGET_EXHAUSTED', 'WORLD_SOURCE_DEFERRED', 'WORLD_TARGETS_DISCOVERY_TRUNCATED'].includes(issue.code));
    let done = entry.workKind !== 'source-scan';
    if (entry.workKind === 'map-layout') {
      done = false;
    }
    if (entry.workKind === 'npc-initial-placement') done = !plan.operations.length || plan.operations.every(op => {
      const character = tables.selectOne('characters', branchId, str(op.value.ref));
      return !op.value.data?.['location_ref'] || character?.['location_id'] === op.value.data['location_ref'];
    });
    if (done && !errors.length) return { ...entry, status: 'done' as const, lastErrorCode: null };
    if (entry.workKind === 'source-scan' && afterProgress !== plan.beforeProgress && !errors.length) return entry;
    const unsupported=entry.workKind==='map-layout'&&entry.subjectId&&worldBuildMapQuality(ctx.db,branchId,entry.subjectId)?.findings.some(f=>f.code==='MAP_PLAUSIBILITY_UNSUPPORTED');
    return { ...entry, status: 'failed' as const, attempts: entry.attempts + 1, lastErrorCode: errors[0]?.code ?? (unsupported?'SPATIAL_PROFILE_MEMBER_UNSUPPORTED':entry.workKind === 'map-layout' ? 'MAP_LAYOUT_INCOMPLETE' : 'WORLD_BUILD_NO_PROGRESS'),
      failureFingerprint: stableHexHash(JSON.stringify([entry.id, errors.map(issue => issue.code)])) };
  });
  targets = discover(ctx, plan.job, targets);
  let job = { ...plan.job };
  if (configuration) job = { ...job, status: 'paused', stopReason: configuration.code, runEpoch: job.runEpoch + 1 };
  if (plan.window) job = { ...job, nextWindowSequence: job.nextWindowSequence + 1, committedWindowSequence: job.nextWindowSequence,
    cumulativeWindows: job.cumulativeWindows + 1, cumulativeTransports: job.cumulativeTransports + transports };
  const maps = pageAllRows(tables, 'maps', branchId).filter(row => row['status'] === 'active');
  const coverage = buildWorldBuildCoverage({ job, targets, sourceScanComplete: sources.coverage.sourceScanComplete,
    settlementPlansExpanded: targets.filter(entry => entry.workKind === 'settlement-plan').every(entry => entry.status === 'done'), maps: { registered: maps.length, ready: maps.filter(map => record(normalizeFrame(map['frame_json'])['atlasScene'])).length } });
  if (job.status === 'running') {
    job.status = nextJobStatus(job, coverage);
    if (!targets.some(entry => entry.status === 'pending' || entry.status === 'running') && targets.some(entry => entry.status === 'failed' || entry.status === 'blocked')) job.status = 'completed-with-issues';
  }
  const rows = readProgressRows(tables, branchId), beforeRows = new Map(rows.map(row => [row.id, row.raw]));
  const state = planWorldBuildMutation({ job, targets: [], discoveredTargets: targets, coverage: sources.coverage,
    settlementPlansExpanded: coverage.scopeSealed, maps: { registered: maps.length, ready: coverage.readyMaps }, ctx: context(ctx), beforeRows });
  const mutations = state.groups.flatMap(entry => entry.mutations).filter(mutation => mutation.rowId !== worldBuildJobRowId(job.id));
  mutations.push(worldBuildJobMutation(context(ctx), beforeRows.get(worldBuildJobRowId(job.id)) ?? null, job));
  return { groups: group(ctx, 'settled', mutations), receipt: { version: 1, jobId: job.id, status: job.status, coverage, stopReason: job.stopReason } };
}
