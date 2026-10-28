/**
 * atlas-ops-space-state.ts — §5.7 / §18.4：`space.state.patch` 的严格编译器。
 *
 * 为什么必须是一个**操作**而不是让模型重发整份 scene：
 * 重发 scene 会连带重写几何与其它房间，一次开个门就能把已经确认的布局改坏。
 *
 * 本模块负责三件事，缺一个就会退化成「假装改了」：
 * 1. **目标不能靠猜**：objectRef 必须能在本图冻结的陈设账本里找到，
 *    locationRef 必须真的属于这张图（跨图同名门一律拒）。
 * 2. **状态写进世界事实层**（`construction_progress` 的 `world-fact/v1` 行，`layer=state-event`），
 *    同一扇门在正文、决策切片、通行判定里是同一个状态；不新开状态表、不升 schema。
 * 3. **只产出真实变化**：与已有事实比对，没有变化的补丁不写行（重试幂等）。
 *
 * 几何、拆除、人物/物品移动都不在这里：那些走陈设账本、事件与转移的既有语义。
 */

import type { Issue, ParsedOperation, RowMutation } from './atlas-ops-contract.ts';
import type { CompileContext, CompileResult } from './atlas-ops-compile-types.ts';
import { emptyCompileResult } from './atlas-ops-compile-types.ts';
import { resolveRef } from './atlas-ops-refs.ts';
import { readSpaceCanonical, parseSpaceLocalId } from './atlas-space-canonical.ts';
import type { SpaceCanonicalV1 } from './atlas-space-canonical.ts';
import { applySpaceStatePatches, resolvePatchObjectId, resolveSpaceStateFacts } from './atlas-space-state.ts';
import type { SpaceObjectState, SpaceObjectStateSeed, SpaceStatePatch } from './atlas-space-state.ts';
import { encodeWorldFactPayload, worldFactRowId } from './atlas-world-build-state.ts';
import { progressRowMutation } from './atlas-construction-progress.ts';
import type { WorldFactPredicate, WorldFactV1 } from './atlas-world-fact-policy.ts';
import { stableHexHash } from './atlas-hash.ts';
import { SPACE_STATE_PATCH_LIMIT } from './atlas-ops-normalize.ts';

/** 允许改状态的阶段：正文观察、后台已发生的结果、以及由原失败组继承的 repair。 */
export const SPACE_STATE_PATCH_PHASES = ['observe', 'outcome', 'repair'] as const;

/** 读到多少事实行就够用：超过这个量说明在扫全库，必须改成分页。 */
const FACT_ROW_PAGE = 500;
const FACT_ROW_MAX_PAGES = 20;

function issue(code: string, path: string, message: string, op: ParsedOperation, extra: Partial<Issue> = {}): Issue {
  return { code, path, message, severity: 'error', retryable: false, opId: op.opId, line: op.line, ...extra };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim();
}

function boolOrNull(value: unknown): boolean | null {
  return value === true ? true : value === false ? false : null;
}

/**
 * 经只读端口分页读事实行。编译器拿不到原始连接，也不该为了读几行就把 db 塞进上下文。
 */
function loadFactRows(ctx: CompileContext): Array<{ id: unknown; payload_json: unknown }> {
  const rows: Array<{ id: unknown; payload_json: unknown }> = [];
  if (typeof ctx.tables.selectWherePage !== 'function') return rows;
  let afterId: string | null = null;
  for (let page = 0; page < FACT_ROW_MAX_PAGES; page += 1) {
    const batch = ctx.tables.selectWherePage('construction_progress', { branch_id: ctx.branchId }, afterId, FACT_ROW_PAGE);
    if (batch.length === 0) break;
    for (const row of batch) rows.push({ id: row['id'], payload_json: row['payload_json'] });
    const last = str(batch[batch.length - 1]?.['id']);
    if (last === '' || last === afterId) break;
    afterId = last;
    if (batch.length < FACT_ROW_PAGE) break;
  }
  return rows;
}

/** 该对象该断言上最近的一条事实行：供 `supersedesFactId` 留痕（不是裁决机制）。 */
function latestFactId(
  rows: ReadonlyArray<{ id: unknown; payload_json: unknown }>,
  subjectId: string,
  predicate: string,
): string | null {
  let best: { id: string; layer: number; clock: number } | null = null;
  for (const row of rows) {
    const raw = row?.payload_json;
    // 只读端口给的是已解码对象，直连 SQL 给的是字符串：两种都认。
    let payload: Record<string, unknown> | null = null;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      payload = raw as Record<string, unknown>;
    } else if (typeof raw === 'string') {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
      } catch {
        payload = null;
      }
    }
    if (!payload) continue;
    if (str(payload.payloadKind) !== 'world-fact/v1') continue;
    if (str(payload.subjectId) !== subjectId || str(payload.predicate) !== predicate) continue;
    const id = str(payload.id) || str(row.id);
    if (id === '') continue;
    const layer = str(payload.layer) === 'state-event' ? 1 : 0;
    const clock = typeof payload.effectiveClockS === 'number' && Number.isFinite(payload.effectiveClockS) ? Number(payload.effectiveClockS) : 0;
    if (!best || layer > best.layer || (layer === best.layer && clock >= best.clock)) best = { id, layer, clock };
  }
  return best ? best.id : null;
}

type DeclaredState = { objectId: string; openingState: boolean; locked: boolean; material: boolean; present: boolean; destroyed: boolean };

function declaredFor(entry: Record<string, unknown>, objectId: string): DeclaredState {
  return {
    objectId,
    openingState: entry['openingState'] !== undefined && entry['openingState'] !== null,
    locked: entry['locked'] !== undefined && entry['locked'] !== null,
    material: entry['material'] !== undefined && entry['material'] !== null,
    present: entry['present'] !== undefined && entry['present'] !== null,
    destroyed: entry['destroyed'] !== undefined && entry['destroyed'] !== null,
  };
}

/** 状态 → 事实（只产出本批真正声明过、且确实变了的字段）。 */
function factsForState(input: {
  state: SpaceObjectState;
  declared: DeclaredState;
  known: SpaceObjectStateSeed | null;
}): Array<{ predicate: WorldFactPredicate; value: unknown }> {
  const out: Array<{ predicate: WorldFactPredicate; value: unknown }> = [];
  const known = input.known ?? {};
  if(input.declared.destroyed&&(known.destroyed??false)!==input.state.destroyed)out.push({predicate:'exists',value:!input.state.destroyed});
  if (input.declared.openingState && str(known.openingState) !== input.state.openingState) {
    out.push({ predicate: 'opening-state', value: input.state.openingState });
  }
  if (input.declared.locked && boolOrNull(known.locked) !== input.state.locked) {
    // §18.4：锁是布尔状态，解锁也必须是可记录的状态事件（不是「不再提到」）。
    out.push({ predicate: 'owner-lock', value: input.state.locked });
  }
  if (input.declared.material && str(known.material) !== str(input.state.material ?? '')) {
    out.push({ predicate: 'material', value: input.state.material });
  }
  if (input.declared.present && (known.present === undefined ? true : known.present) !== input.state.present) {
    out.push({ predicate: 'presence', value: input.state.present });
  }
  return out.filter((entry) => entry.value !== null && entry.value !== undefined);
}

/**
 * §5.7：`{"op":"space.state.patch","ref":"M1","data":{"updates":[{"objectRef":"O2","locationRef":"L3","openingState":"closed","locked":true}]}}`
 *
 * `ref` 是本批冻结地图；每条 update 的 objectRef 在该图的陈设账本里解析。
 */
export function compileSpaceStatePatch(op: ParsedOperation, ctx: CompileContext): CompileResult {
  const result = emptyCompileResult();
  const data = (op.value.data ?? {}) as Record<string, unknown>;

  // 阶段闸：决策阶段的「打算开门」不是已经发生的状态变化。
  if (!(SPACE_STATE_PATCH_PHASES as readonly string[]).includes(ctx.phase)) {
    result.issues.push(issue('SPACE_PATCH_PHASE_NOT_ALLOWED', '$.op', `space.state.patch 不能在 ${ctx.phase} 阶段改状态：意图不等于已发生`, op));
    return result;
  }

  const updates = Array.isArray(data['updates']) ? (data['updates'] as unknown[]) : [];
  if (updates.length === 0) {
    result.issues.push(issue('SPACE_PATCH_EMPTY', '$.data.updates', 'space.state.patch 需要至少一条 update；没有变化就输出 noop', op));
    return result;
  }
  if (updates.length > SPACE_STATE_PATCH_LIMIT) {
    result.issues.push(issue('SPACE_PATCH_TOO_MANY', '$.data.updates', `一次最多 ${SPACE_STATE_PATCH_LIMIT} 个对象；${updates.length} 项超限，按批拆分`, op));
    return result;
  }

  const ref = str(op.value.ref);
  if (ref === '') {
    result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.ref', 'space.state.patch 需要 ref 指明本批冻结地图', op));
    return result;
  }
  const resolvedMap = resolveRef(ref, 'map', ctx.scope, { opId: op.opId, line: op.line, field: 'ref' });
  if (!resolvedMap.entry) {
    result.issues.push(...resolvedMap.issues);
    return result;
  }
  const mapId = resolvedMap.entry.id;
  const mapRow = ctx.tables.selectOne('maps', ctx.branchId, mapId);
  if (!mapRow) {
    result.issues.push(issue('REF_UNKNOWN', '$.ref', `地图行不存在：${mapId}`, op));
    return result;
  }
  result.readSet.push({ table: 'maps', rowId: mapId, rowRev: Number(mapRow['row_rev'] ?? 0) });

  // 1) 每条 update 先落定「这是哪张图上的哪个空间、哪个对象」。
  const groups = new Map<string, { canonical: SpaceCanonicalV1 | null; entries: Array<{ index: number; entry: Record<string, unknown>; objectId: string }> }>();
  const declared = new Map<string, DeclaredState>();

  updates.forEach((raw, index) => {
    const path = `$.data.updates[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      result.issues.push(issue('SPACE_PATCH_ENTRY_INVALID', path, '每个 update 必须是对象', op));
      return;
    }
    const entry = raw as Record<string, unknown>;

    // 目标空间：显式 locationRef 优先；否则从全限定 objectRef 反推。
    let locationId = '';
    const locationRef = str(entry['locationRef']);
    if (locationRef !== '') {
      const resolvedLocation = resolveRef(locationRef, 'location', ctx.scope, { opId: op.opId, line: op.line, field: `${path}.locationRef` });
      if (!resolvedLocation.entry) {
        result.issues.push(...resolvedLocation.issues);
        return;
      }
      locationId = resolvedLocation.entry.id;
    }
    const objectRef = str(entry['objectRef']);
    const parsedObject = parseSpaceLocalId(objectRef);
    if (locationId === '' && parsedObject) locationId = str((parsedObject as { locationId?: unknown }).locationId);

    if (locationId === '') {
      result.issues.push(issue(
        'SPACE_PATCH_LOCATION_REQUIRED',
        `${path}.locationRef`,
        '这条 update 不知道在哪个空间：同名门/同名柜很多，必须给 locationRef 或用全限定 objectRef',
        op,
      ));
      return;
    }

    // 该空间必须真的在这张图上：跨图 = 改到了另一张地图的同名对象。
    const locationRow = ctx.tables.selectOne('locations', ctx.branchId, locationId);
    if (!locationRow) {
      result.issues.push(issue('SPACE_PATCH_LOCATION_UNKNOWN', `${path}.locationRef`, `地点行不存在：${locationId}`, op));
      return;
    }
    const locationMapId = str(locationRow['map_id']);
    if (locationMapId !== '' && locationMapId !== mapId) {
      result.issues.push(issue(
        'SPACE_PATCH_FOREIGN_MAP',
        `${path}.locationRef`,
        `${locationId} 属于地图 ${locationMapId}，本次处理的是 ${mapId}：未知门不能更新另一张图里的同名门`,
        op,
      ));
      return;
    }

    const resolvedObject = resolvePatchObjectId({ patch: { objectId: objectRef }, locationId });
    if (!resolvedObject.objectId) {
      const code = resolvedObject.reasonCode === 'FOREIGN_LOCATION' ? 'SPACE_PATCH_FOREIGN_LOCATION'
        : resolvedObject.reasonCode === 'FOREIGN_SCOPE' ? 'SPACE_PATCH_FOREIGN_SCOPE'
          : 'SPACE_PATCH_OBJECT_REQUIRED';
      result.issues.push(issue(code, `${path}.objectRef`, `补丁没有可用的对象引用（${resolvedObject.reasonCode}）`, op));
      return;
    }

    const group = groups.get(locationId) ?? { canonical: null, entries: [] };
    if (!groups.has(locationId)) {
      const read = readSpaceCanonical(mapRow['frame_json'], locationId);
      group.canonical = read.canonical;
      groups.set(locationId, group);
      // 账本自身的问题必须带出来：静默跳过等于「门不存在也没人说」。
      for (const readIssue of read.issues) {
        result.issues.push({ code: readIssue.code, path: readIssue.path, message: readIssue.message, severity: 'warning', retryable: false, opId: op.opId, line: op.line });
      }
    }
    if (!group.canonical) {
      result.issues.push(issue(
        'SPACE_PATCH_NO_CANONICAL',
        `${path}.objectRef`,
        `${locationId} 还没有冻结的陈设账本：没有稳定 localId 就没有可改的对象，先让布局落地`,
        op,
      ));
      return;
    }
    group.entries.push({ index, entry, objectId: resolvedObject.objectId });
    const previous = declared.get(resolvedObject.objectId);
    const current = declaredFor(entry, resolvedObject.objectId);
    declared.set(resolvedObject.objectId, previous
      ? {
        objectId: current.objectId,
        openingState: previous.openingState || current.openingState,
        locked: previous.locked || current.locked,
        material: previous.material || current.material,
        present: previous.present || current.present,
        destroyed: previous.destroyed || current.destroyed,
      }
      : current);
  });

  if (result.issues.some((entry) => entry.severity === 'error')) return result;

  const factRows = loadFactRows(ctx);
  const states = resolveSpaceStateFacts(factRows, 'space:');
  const turnId = typeof ctx.turnId === 'string' && ctx.turnId !== '' ? ctx.turnId : ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;

  // 2) 按空间分组、按候选内顺序应用补丁。
  for (const [locationId, group] of groups) {
    const patches: SpaceStatePatch[] = group.entries.map(({ entry, objectId, index }) => ({
      objectId,
      locationId,
      mapId,
      openingState: entry['openingState'],
      locked: entry['locked'],
      material: entry['material'],
      present: entry['present'],
      destroyed: entry['destroyed'],
      canOpen: entry['canOpen'],
      blocksMovement: entry['blocksMovement'],
      blocksSight: entry['blocksSight'],
      sourceIndex: index,
    }));

    const applied = applySpaceStatePatches({
      canonical: group.canonical,
      locationId,
      mapId,
      patches,
      known: states,
    });
    result.issues.push(...applied.issues.map((entry) => ({ ...entry, opId: op.opId, line: op.line })));

    for (const state of applied.states) {
      const declaredState = declared.get(state.objectId);
      if (!declaredState) continue;
      const facts = factsForState({ state, declared: declaredState, known: states.get(state.objectId) ?? null });
      if (facts.length === 0) {
        result.issues.push({
          code: 'SPACE_PATCH_NO_OP',
          path: '$.data.updates',
          message: `${state.objectId} 的状态与已有事实一致：本次没有真实变化，不写新行`,
          severity: 'warning',
          retryable: false,
          opId: op.opId,
          line: op.line,
        });
        continue;
      }
      for (const fact of facts) {
        const factId = `fact_${stableHexHash([state.objectId, fact.predicate, turnId, op.opId].join('\u0000')).slice(0, 24)}`;
        const rowId = worldFactRowId(factId);
        const before = ctx.tables.selectOne('construction_progress', ctx.branchId, rowId);
        if (before) result.readSet.push({ table: 'construction_progress', rowId, rowRev: Number(before['row_rev'] ?? 0) });
        const worldFact: WorldFactV1 = {
          version: 1,
          id: factId,
          subjectId: state.objectId,
          predicate: fact.predicate,
          layer: 'state-event',
          // 剧情里真的发生了；后台 outcome 也是真实后果，不是「推演出来的猜测」。
          origin: 'story',
          producer: 'model',
          sourceKey: str((Array.isArray(op.value.source) ? op.value.source[0] : op.value.source)) || null,
          sourceHash: null,
          sourceSpan: null,
          quality: 'confirmed',
          effectiveTurnId: turnId,
          effectiveClockS: Number.isFinite(ctx.clockS) ? ctx.clockS : null,
          supersedesFactId: latestFactId(factRows, state.objectId, fact.predicate),
          value: fact.value,
        };
        const basis = ctx.basisFor
          ? (ctx.basisFor(op, { certainty: 'confirmed' }) as unknown as Record<string, unknown>)
          : {
            kind: ctx.phase === 'observe' ? 'story' : 'simulation',
            sources: [],
            causes: [],
            reason: op.value.why ?? '空间状态变化',
            verification: ctx.phase === 'observe' ? 'source_bound' : 'causal',
            certainty: 'confirmed',
          };
        const mutation: RowMutation = progressRowMutation(
          { branchId: ctx.branchId, turnId, opId: op.opId },
          {
            id: rowId,
            scopeKey: 'world-facts:v1',
            kind: 'target',
            subjectKey: `fact:${factId}`,
          },
          before,
          {
            inputSignature: stableHexHash(['world-fact', worldFact.subjectId, worldFact.predicate, worldFact.effectiveTurnId, String(worldFact.effectiveClockS ?? '')].join('\u0000')),
            status: 'processed',
            payload: encodeWorldFactPayload(worldFact),
            basis,
          },
        );
        result.mutations.push(mutation);
      }
    }
  }

  if (result.issues.some((entry) => entry.severity === 'error')) return result;
  if (result.mutations.length === 0) {
    result.issues.push({
      code: 'SPACE_PATCH_NO_OP',
      path: '$.data.updates',
      message: '本批补丁没有产生任何真实状态变化（重复提交是安全的，但别期待新行）',
      severity: 'warning',
      retryable: false,
      opId: op.opId,
      line: op.line,
    });
  }
  return result;
}
