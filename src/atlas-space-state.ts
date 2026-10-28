/**
 * atlas-space-state.ts — P12 §18.4：门窗/陈设状态补丁的**候选内**应用规则。
 *
 * `space.state.patch` 是本仓库既有操作面里的一个额度分类（见 `atlas-construction-budget.ts`），
 * 但此前没有一层专门校验「这次补丁到底能不能落」。缺了这层，最容易出三类错：
 *
 * 1. **跨图同名门**：AI 说「打开北门」，落到了另一张图里同名的北门上；
 * 2. **状态互相污染**：开窗被当成能走人、玻璃因为透明被当成空气、开锁顺手把门也拆了；
 * 3. **越权改作者**：模型开锁时把作者的锁定/确认几何一起解除或改掉占地。
 *
 * 本模块只做判定：按**候选内顺序**应用补丁，产出最终状态列表 + 问题码；
 * 不写库、不调模型。几何（尺寸/占地）在本层不可变 —— 那是作者锁与陈设账本的领域。
 */

import { spaceLocalId, parseSpaceLocalId } from './atlas-space-canonical.ts';
import type { SpaceCanonicalV1 } from './atlas-space-canonical.ts';
import type { Issue } from './atlas-ops-contract.ts';
import { queryBound } from './atlas-db-runtime.ts';
import { decodeWorldFact, resolveWorldFactConflict, currentFactOf, isFactFieldBlocked } from './atlas-world-fact-policy.ts';
import type { WorldFactV1 } from './atlas-world-fact-policy.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { PlanIssue } from './atlas-world-contract.ts';

export const SPACE_STATE_VERSION = 1;

/** 补丁能改的三件独立的事。开关、锁、材质互不代表。 */
export const SPACE_STATE_FIELDS = ['openingState', 'locked', 'material', 'destroyed'] as const;
export type SpaceStateField = (typeof SPACE_STATE_FIELDS)[number];

export type SpaceStatePatch = {
  /** 目标对象：全限定 `space:<loc>:furn:<id>` 或短引用 `F3`。 */
  objectId?: unknown;
  /** 补丁声明的目标空间与地图：缺一即视为「不知道在说哪扇门」。 */
  locationId?: unknown;
  mapId?: unknown;
  openingState?: unknown;
  locked?: unknown;
  material?: unknown;
  /** 是否还在场（不是「删掉实体」）：§5.7 明确 present=false 不等于删 SQL 实体。 */
  present?: unknown;
  /** 以下三个是**派生**字段：允许写，但必须和门的真实状态一致。 */
  canOpen?: unknown;
  blocksMovement?: unknown;
  blocksSight?: unknown;
  destroyed?: unknown;
  /**
   * 作者锁：模型**永远**不能通过补丁写它。留着这个字段是为了能明确拒绝，
   * 而不是让它被静默忽略（静默忽略会让人以为「已经解除了」）。
   */
  authorLocked?: unknown;
  /** 该补丁在模型输出里的原始下标（`updates[i]`），用于把问题路径指回原文。 */
  sourceIndex?: unknown;
};

export type SpaceObjectState = {
  objectId: string;
  openingState: 'open' | 'closed' | 'not-applicable' | 'unknown';
  locked: boolean | null;
  material: string | null;
  present: boolean;
  destroyed: boolean;
};

export type SpaceObjectStateSeed = {
  openingState?: string;
  locked?: boolean | null;
  material?: string;
  present?: boolean;
  destroyed?: boolean;
};

export type SpaceStateResult = {
  states: SpaceObjectState[];
  issues: Issue[];
  /** 状态变化后需要连带更新的通行条件（由调用方落到 route.access_rules / scene 投影）。 */
  affectedObjectIds: string[];
};

const OPENING_STATES = new Set(['open', 'closed', 'not-applicable', 'unknown']);
const MATERIALS = new Set(['solid', 'glass', 'wood', 'fabric', 'other', 'unknown']);

function issue(code: string, path: string, message: string, severity: 'warning' | 'error' = 'error'): Issue {
  return { code, path, message, severity, retryable: false };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim();
}

function boolOrNull(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (value === 1) return true;
  if (value === 0) return false;
  return null;
}

/**
 * payload 可能已经是**已解码对象**（只读端口会把 JSON 列解码），也可能是原始字符串
 * （直接 SQL 读取）。两种都要认，否则「同一个事实」在编译期与读取期会看到不同结果。
 */
function parseObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 把补丁的对象引用归一成当前空间的 localId。
 *
 * `space:<other>:furn:F3` 这种「写着别的空间」的引用一律拒绝 ——
 * 这正是「未知门不能任意更新另一张图同名门」的执行点。
 */
export function resolvePatchObjectId(input: {
  patch: SpaceStatePatch;
  locationId: string;
}): { objectId: string | null; reasonCode: 'OK' | 'FOREIGN_LOCATION' | 'FOREIGN_SCOPE' | 'MISSING' } {
  const raw = str(input?.patch?.objectId);
  if (raw === '') return { objectId: null, reasonCode: 'MISSING' };
  const parsed = parseSpaceLocalId(raw);
  if (parsed) {
    const location = str((parsed as { locationId?: unknown }).locationId);
    if (location !== '' && location !== str(input.locationId)) return { objectId: null, reasonCode: 'FOREIGN_LOCATION' };
    return { objectId: raw, reasonCode: 'OK' };
  }
  if (raw.startsWith('space:')) return { objectId: null, reasonCode: 'FOREIGN_SCOPE' };
  const full = spaceLocalId(str(input.locationId), raw.replace(/^furn:/, ''));
  return { objectId: full, reasonCode: 'OK' };
}

/** 现有状态：进入判定前的初始值（不再假装「门是关的」也不假装「门是开的」）。 */
function initialState(objectId: string, seed?: Partial<SpaceObjectStateSeed> | null): SpaceObjectState {
  return {
    objectId,
    openingState: (OPENING_STATES.has(String(seed?.openingState)) ? seed?.openingState : 'unknown') as SpaceObjectState['openingState'],
    locked: boolOrNull(seed?.locked),
    material: MATERIALS.has(String(seed?.material)) ? String(seed?.material) : null,
    present: seed?.present === false ? false : true,
    destroyed: (seed as Partial<SpaceObjectState> | null | undefined)?.destroyed === true,
  };
}

/**
 * §18.4「开关、锁和材质独立，开窗不代表能走人」的执行点：
 * 派生字段允许写，但**必须**与门的真实状态一致，不一致就拒绝，
 * 让模型去改 openingState/locked，而不是把「能走」写成一个独立事实。
 */
export function derivedStateFields(state: SpaceObjectState | null): {
  canOpen: boolean | null;
  blocksMovement: boolean | null;
  blocksSight: boolean | null;
} {
  if (!state) return { canOpen: null, blocksMovement: null, blocksSight: null };
  const pass = patchedPassability(state);
  const canOpen = state.destroyed ? false : state.openingState === 'closed';
  return { canOpen, blocksMovement: pass.blocksMovement, blocksSight: pass.blocksSight };
}

/**
 * §18.4：按候选内顺序应用补丁。
 *
 * 顺序有意义：`[开门, 上锁]` 与 `[上锁, 开门]` 的结果不同，不能重排、不能排序去重。
 * 逐条校验，失败的补丁**整条丢弃**，前面的结果保留（部分成功比全失败更接近事实），
 * 但会明确报码，不让调用方以为「都改了」。
 */
export function applySpaceStatePatches(input: {
  canonical: SpaceCanonicalV1 | null;
  locationId: string;
  mapId?: string | null;
  patches: readonly SpaceStatePatch[];
  /** 进入本批之前的已知状态（来自既有事实行）；缺省按 unknown 起。 */
  known?: ReadonlyMap<string, Partial<SpaceObjectStateSeed>> | null;
  /** 作者锁定的对象：不许改状态以外的任何东西，也不许被解锁。 */
  authorLockedObjectIds?: readonly string[];
  readOnly?: boolean;
}): SpaceStateResult {
  const issues: Issue[] = [];
  const locationId = str(input?.locationId);
  const mapId = str(input?.mapId);
  const knownIds = new Set((input?.canonical?.furnishing ?? []).map((entry) => entry.localId));
  const authorLocked = new Set((input?.authorLockedObjectIds ?? []).map((id) => str(id)).filter((id) => id !== ''));
  const state = new Map<string, SpaceObjectState>();
  const affected: string[] = [];

  if (input?.readOnly === true) {
    if ((input?.patches ?? []).length > 0) {
      issues.push(issue('SPACE_PATCH_READ_ONLY', '$.patches', '这块空间是只读的（作者确认/锁定）：状态补丁整批不落', 'error'));
    }
    return { states: [], issues, affectedObjectIds: [] };
  }

  (input?.patches ?? []).forEach((patch, index) => {
    // 问题路径必须指回模型原文的 updates[i]：分组后下标会变，不能拿本层序号冒充。
    const path = `$.patches[${typeof patch?.sourceIndex === 'number' ? patch.sourceIndex : index}]`;

    // 目标地图/空间必须对得上：不靠「同名」跨图打补丁。
    const declaredLocation = str(patch?.locationId);
    if (declaredLocation === '') {
      issues.push(issue('SPACE_PATCH_LOCATION_REQUIRED', `${path}.locationId`, '补丁必须声明目标空间：同名门很多，不能靠猜', 'error'));
      return;
    }
    if (declaredLocation !== locationId) {
      issues.push(issue('SPACE_PATCH_FOREIGN_LOCATION', `${path}.locationId`, `补丁指向空间 ${declaredLocation}，本次处理的是 ${locationId}`, 'error'));
      return;
    }
    const declaredMap = str(patch?.mapId);
    if (declaredMap !== '' && mapId !== '' && declaredMap !== mapId) {
      issues.push(issue('SPACE_PATCH_FOREIGN_MAP', `${path}.mapId`, `补丁指向地图 ${declaredMap}，本次处理的是 ${mapId}：未知门不能更新另一张图里的同名门`, 'error'));
      return;
    }

    if (patch?.authorLocked !== undefined) {
      issues.push(issue('SPACE_PATCH_AUTHOR_LOCK_REFUSED', `${path}.authorLocked`, '作者锁不是模型能写的状态：开锁不得解除作者的锁定/确认几何', 'error'));
      return;
    }

    const resolved = resolvePatchObjectId({ patch, locationId });
    if (!resolved.objectId) {
      const code = resolved.reasonCode === 'FOREIGN_LOCATION' ? 'SPACE_PATCH_FOREIGN_LOCATION'
        : resolved.reasonCode === 'FOREIGN_SCOPE' ? 'SPACE_PATCH_FOREIGN_SCOPE'
          : 'SPACE_PATCH_OBJECT_REQUIRED';
      issues.push(issue(code, `${path}.objectId`, `补丁没有可用的对象引用（${resolved.reasonCode}）`, 'error'));
      return;
    }
    const objectId = resolved.objectId;
    if (!knownIds.has(objectId)) {
      issues.push(issue('SPACE_PATCH_OBJECT_UNKNOWN', `${path}.objectId`, `${objectId} 不在本空间的陈设账本里：不凭空给不存在的门改状态`, 'error'));
      return;
    }

    const current = state.get(objectId) ?? initialState(objectId, input?.known?.get?.(objectId) ?? null);
    const next: SpaceObjectState = { ...current };

    // 四件事各自独立判定，不互相推导。
    if (patch?.openingState !== undefined) {
      const value = str(patch.openingState);
      if (!OPENING_STATES.has(value)) {
        issues.push(issue('SPACE_PATCH_OPENING_INVALID', `${path}.openingState`, `开关状态 ${value || '(空)'} 非法`, 'error'));
        return;
      }
      next.openingState = value as SpaceObjectState['openingState'];
    }
    if (patch?.locked !== undefined) {
      const value = boolOrNull(patch.locked);
      if (value === null) {
        issues.push(issue('SPACE_PATCH_LOCKED_INVALID', `${path}.locked`, 'locked 必须是布尔值；不确定就别写', 'error'));
        return;
      }
      if (value === false && authorLocked.has(objectId)) {
        issues.push(issue('SPACE_PATCH_UNLOCK_AUTHOR_LOCKED', `${path}.locked`, `${objectId} 由作者锁定：模型开锁不能顺带解除作者锁`, 'error'));
        return;
      }
      next.locked = value;
    }
    if (patch?.material !== undefined) {
      const value = str(patch.material);
      if (!MATERIALS.has(value)) {
        issues.push(issue('SPACE_PATCH_MATERIAL_INVALID', `${path}.material`, `材质 ${value || '(空)'} 非法`, 'error'));
        return;
      }
      next.material = value;
    }
    if (patch?.destroyed !== undefined) {
      if(typeof patch.destroyed!=='boolean'){issues.push(issue('SPACE_PATCH_DESTROYED_INVALID',`${path}.destroyed`,'destroyed 必须为布尔值','error'));return;}
      next.destroyed = patch.destroyed === true;
      // 毁坏 ≠ 从几何里消失：占位与尺寸仍然保留（历史布局可回退）。
    }
    if (patch?.present !== undefined) {
      const value = boolOrNull(patch.present);
      if (value === null) {
        issues.push(issue('SPACE_PATCH_PRESENT_INVALID', `${path}.present`, 'present 必须是布尔值；present=false 只表示当前不在场，不等于删除实体', 'error'));
        return;
      }
      next.present = value;
    }

    // 派生字段：可以写，但必须与门的真实状态一致（§18.4「开窗不代表能走人」）。
    const derived = derivedStateFields(next);
    for (const field of ['canOpen', 'blocksMovement', 'blocksSight'] as const) {
      if (patch?.[field] === undefined) continue;
      const declared = boolOrNull(patch[field]);
      if (declared === null) {
        issues.push(issue('SPACE_PATCH_DERIVED_INVALID', `${path}.${field}`, `${field} 必须是布尔值`, 'error'));
        return;
      }
      if (derived[field] === null) {
        issues.push(issue('SPACE_PATCH_DERIVED_UNKNOWN', `${path}.${field}`, `${objectId} 的开关/材质未知，推导不出 ${field}；先写 openingState 或 material，不要直接断言通行`, 'error'));
        return;
      }
      if (declared !== derived[field]) {
        issues.push(issue(
          'SPACE_PATCH_DERIVED_CONFLICT',
          `${path}.${field}`,
          `${field}=${declared} 与这门自己的状态不一致（真实推导为 ${derived[field]}）：改 openingState/locked/material，不要另写一个通行事实`,
          'error',
        ));
        return;
      }
    }

    // 几何不可变：补丁不得改占地/尺寸（那是另一套概念，由作者的 scale_locked 保护）。
    for (const forbidden of ['widthM', 'heightM', 'footprintCells', 'size']) {
      if (Object.prototype.hasOwnProperty.call(patch as Record<string, unknown>, forbidden)) {
        issues.push(issue('SPACE_PATCH_GEOMETRY_IMMUTABLE', `${path}.${forbidden}`, '状态补丁不得改占地/尺寸：几何更新属于陈设账本与作者锁', 'error'));
        return;
      }
    }

    state.set(objectId, next);
    if (!affected.includes(objectId)) affected.push(objectId);
  });

  // 一致性提醒：开窗不等于能走人；玻璃透明不等于空气。这里只报，不改判定。
  for (const entry of state.values()) {
    if (entry.openingState === 'open' && entry.material === 'glass') {
      issues.push(issue('SPACE_PATCH_GLASS_OPEN_NOT_AIR', '$.patches', `${entry.objectId} 打开的是玻璃：透明与可穿越是两件事，通行仍需入口事实`, 'warning'));
    }
  }

  return { states: [...state.values()], issues, affectedObjectIds: affected };
}

/**
 * §18.4 的落点：把补丁结果折算成「这扇门现在能不能挡住人」。
 *
 * 只回答通行结论，不重新定义门窗语义 —— 语义在 `resolveSpatialTrait` 里只有一份。
 */
export function patchedPassability(state: SpaceObjectState | null): {
  blocksMovement: boolean | null;
  blocksSight: boolean | null;
  note: string;
} {
  if (!state) return { blocksMovement: null, blocksSight: null, note: '没有该对象的状态' };
  if (state.destroyed) return { blocksMovement: false, blocksSight: false, note: '已毁坏：不再阻挡（几何仍保留用于诊断）' };
  if (state.openingState === 'open') return { blocksMovement: false, blocksSight: false, note: '打开：不挡路' };
  if (state.openingState === 'closed') {
    return { blocksMovement: true, blocksSight: state.material === 'glass' ? false : true, note: '关闭：挡路，可尝试开门' };
  }
  return { blocksMovement: null, blocksSight: null, note: '开关未知：不假设能穿过，也不假设进不去' };
}

/* ------------------------------------------------------------------ *
 * §18.4 状态事实的唯一读取口（正文、决策、通行判定共用）
 * ------------------------------------------------------------------ */

const WORLD_FACT_PAYLOAD_KIND = 'world-fact/v1';
const OBJECT_STATE_PREDICATES = new Set(['opening-state', 'owner-lock', 'material', 'presence', 'exists']);

export type SpaceStateWorld = { db: SqlDatabase; branchId: string };

function pickStateValue(predicate: string, value: unknown): SpaceObjectStateSeed {
  if(predicate==='exists')return typeof value==='boolean'?{destroyed:!value}:{};
  const textValue = typeof value === 'string' ? value.trim() : '';
  const object = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (predicate === 'opening-state') {
    const state = textValue !== '' ? textValue : str(object?.openingState ?? object?.state);
    return state === '' ? {} : { openingState: state };
  }
  if (predicate === 'owner-lock') {
    const raw = typeof value === 'boolean' ? value : object?.locked;
    return raw === true || raw === false ? { locked: raw } : {};
  }
  if (predicate === 'presence') {
    const raw = typeof value === 'boolean' ? value : object?.present;
    return raw === true || raw === false ? { present: raw } : {};
  }
  const material = textValue !== '' ? textValue : str(object?.material);
  return material === '' ? {} : { material };
}

/**
 * 读世界事实层里的对象状态（开关 / 物理锁 / 材质 / 在场）。
 *
 * 出处是 `construction_progress` 的 `world-fact/v1` 行，**不是**另开一份状态表：
 * 同一扇门在正文、决策切片、通行判定里必须是同一个状态。
 * 覆盖次序：`state-event` 压 `baseline`；同层按 `effectiveClockS` 晚者胜；再同则按行 ID 稳定排序。
 */
/**
 * 覆盖次序的唯一实现：`state-event` 压 `baseline`；同层按 `effectiveClockS` 晚者胜；
 * 再同则按行 ID 稳定排序。**喂什么样的行由调用方决定**（SQL 直读或只读端口分页），
 * 但「谁压谁」只有这一份，不允许各层各算一遍。
 */
export function resolveSpaceStateFacts(
  rows: ReadonlyArray<{ id: unknown; payload_json: unknown }>,
  subjectPrefix: string,
  diagnostics: PlanIssue[] = [],
): Map<string, SpaceObjectStateSeed> {
  const states = new Map<string, SpaceObjectStateSeed>();
  const validated: WorldFactV1[] = [];
  const collected: Array<{
    subjectId: string;
    predicate: string;
    layer: number;
    clock: number;
    id: string;
    factId: string;
    supersedes: string;
    seed: SpaceObjectStateSeed;
  }> = [];

  for (const row of rows ?? []) {
    const payload = parseObject(row?.payload_json);
    if (!payload || str(payload.payloadKind) !== WORLD_FACT_PAYLOAD_KIND) continue;
    const subjectId = str(payload.subjectId);
    const predicate = str(payload.predicate);
    if (!subjectId.startsWith(subjectPrefix) || !OBJECT_STATE_PREDICATES.has(predicate)) continue;
    if (payload.version !== undefined) {
      const decoded = decodeWorldFact(payload);
      if (!decoded.ok) {
        diagnostics.push(...decoded.issues.map(issue=>({code:issue.code,path:`$.construction_progress.${str(row.id)}.${issue.path}`,message:issue.message,severity:'error' as const,retryable:false})));
        continue;
      }
      validated.push(decoded.value);
    }
    const seed = pickStateValue(predicate, payload.value);
    if (Object.keys(seed).length === 0) continue;
    collected.push({
      subjectId,
      predicate,
      layer: str(payload.layer) === 'state-event' ? 1 : 0,
      clock: typeof payload.effectiveClockS === 'number' && Number.isFinite(payload.effectiveClockS) ? Number(payload.effectiveClockS) : 0,
      id: str(row.id),
      factId: str(payload.id) || str(row.id),
      supersedes: str(payload.supersedesFactId),
      seed,
    });
  }

  /**
   * §18.4 / §5.7：**被取代的事实不再参与裁决**。
   *
   * 只靠「同层取 clock 最大、再按行 ID 排序」不够：同一时刻连开两道门（clock 相同）时，
   * 行 ID 是哈希，先后纯属巧合。状态事件本来就带 `supersedesFactId`，
   * 用它把被顶掉的那条剔掉，剩下的才是当前状态。
   */
  const superseded = new Set<string>();
  for (const entry of collected) {
    if (entry.supersedes !== '' && entry.supersedes !== entry.factId) superseded.add(entry.supersedes);
  }
  const surviving = collected.filter((entry) => !superseded.has(entry.factId));

  surviving.sort((left, right) => (left.layer - right.layer) || (left.clock - right.clock) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  for (const entry of surviving) {
    states.set(entry.subjectId, { ...(states.get(entry.subjectId) ?? {}), ...entry.seed });
  }
  const resolution = resolveWorldFactConflict({ baselineFacts: validated.filter(fact=>fact.layer==='baseline'), stateEvents: validated.filter(fact=>fact.layer==='state-event'), currentTurnId: validated[validated.length-1]?.effectiveTurnId ?? '' });
  for (const fact of validated) {
    const seed = { ...(states.get(fact.subjectId) ?? {}) };
    const field = fact.predicate === 'opening-state' ? 'openingState' : fact.predicate === 'owner-lock' ? 'locked' : fact.predicate === 'presence' ? 'present' : fact.predicate === 'exists' ? 'destroyed' : 'material';
    if (isFactFieldBlocked(resolution, fact.subjectId, fact.predicate)) delete seed[field];
    else { const chosen = currentFactOf(resolution, fact.subjectId, fact.predicate); if (chosen) Object.assign(seed, pickStateValue(chosen.predicate, chosen.value)); }
    states.set(fact.subjectId, seed);
  }
  for (const conflict of resolution.conflicts) diagnostics.push({ code: conflict.code, path: `$.space.${conflict.subjectId}.${conflict.predicate}`, message: conflict.message,
    severity: conflict.blocking ? 'error' : 'warning', retryable: false });
  return states;
}

export function readSpaceStateFacts(
  world: SpaceStateWorld,
  subjectPrefix: string,
): { states: Map<string, SpaceObjectStateSeed>; diagnostics: PlanIssue[] } {
  const diagnostics: PlanIssue[] = [];
  let rows: Array<{ id: unknown; payload_json: unknown }> = [];
  try {
    rows = queryBound(
      world.db,
      'SELECT id, payload_json FROM construction_progress WHERE branch_id = ? ORDER BY id',
      [world.branchId],
    ) as Array<{ id: unknown; payload_json: unknown }>;
  } catch {
    // 旧档没有这张表时按「没有状态事实」处理，不让注入整体失败。
    return { states: new Map<string, SpaceObjectStateSeed>(), diagnostics };
  }
  return { states: resolveSpaceStateFacts(rows, subjectPrefix, diagnostics), diagnostics };
}

/** 单个对象的当前状态；从未记录过则返回 null（不假装「门是开的」也不假装「锁着」）。 */
export function readObjectStateFacts(world: SpaceStateWorld, objectId: string): SpaceObjectState | null {
  const id = str(objectId);
  if (id === '') return null;
  const seed = readSpaceStateFacts(world, id).states.get(id);
  if (!seed) return null;
  return initialState(id, seed);
}
