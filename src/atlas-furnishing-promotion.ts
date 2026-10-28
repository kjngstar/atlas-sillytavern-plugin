/**
 * atlas-furnishing-promotion.ts — P12 §18.2 / §18.3：陈设 → 物品的**幂等提升**。
 *
 * 问题：普通生成给每个房间补桌椅床柜，如果每件都插一行 `items`，物品表会先被家具灌满；
 * 但如果完全不插，「把桌子搬走」又只能靠编。所以规则是：
 * **先当陈设（canonical furnishing + 稳定 localId），真的被拿/被搬/被转交时才提升成物品。**
 *
 * 这一层只做规划，不写库：产出**一个原子组**（item 行 + canonical.itemId 绑定 + 位置/持有），
 * 交给既有 `applyGroups` 走同一条提交链。纪律：
 *
 * - 提升身份由 `originKey = space:<locationId>:furn:<id>` 派生，**不用名字、不用序号**：
 *   重试、别名、重复事件都落到同一个 key，不会出现第二张桌子。
 * - 已有 `itemId`（来自上一次提升或 canonical 绑定）一律复用；本模块**不新建第二个**。
 * - 源位置不留「一张实体家具 + 一张新物品」的重复占地：绑定后陈设条目仍保留几何，
 *   但 `itemId` 非空，投影层据此不再把它当障碍/入口（见 `atlas-scene-facts.ts`）。
 * - 搬到别的图时**不搬旧坐标**：只留尺寸与来源，坐标按目标图的真实位置重写或留空。
 * - 回退到提升前：三条 mutation 都带 `before`，原子组回退即可恢复行、绑定与位置，
 *   不留幽灵 holder 与重复 ID。
 * - 没有明确物体、歧义 F 引用、锁/只读冲突 → 拒绝整组，保留旧状态。
 *
 * 纯决策层：不调用模型、不读 `Date.now()`、不写库。
 */

import { readSpaceCanonical } from './atlas-space-canonical.ts';
import { createRow } from './atlas-db-defaults.ts';
import type { AtomicGroup, RowMutation } from './atlas-ops-contract.ts';
import type { Issue } from './atlas-ops-contract.ts';
import type { SpaceCanonicalFurnishing, SpaceCanonicalV1 } from './atlas-space-canonical.ts';

export const FURNISHING_PROMOTION_VERSION = 1;

/** 提升只在「已经真的发生」的路径上执行：观察到的正文，或已接受事件的效果适配器。 */
export const FURNISHING_PROMOTION_PHASES = ['observe', 'outcome-effect'] as const;
export type FurnishingPromotionPhase = (typeof FURNISHING_PROMOTION_PHASES)[number];

export function promotionAllowedInPhase(phase: unknown): boolean {
  return (FURNISHING_PROMOTION_PHASES as readonly string[]).includes(String(phase ?? ''));
}

/** 目标形态：原地成为真实物品 / 搬到某处 / 交给某人。 */
export type FurnishingPromotionTarget =
  | { kind: 'in-place' }
  | { kind: 'move'; locationId: string; mapId?: string | null; gridX?: number | null; gridY?: number | null }
  | { kind: 'hold'; characterId: string };

export type FurnishingPromotionEvent = {
  id: string;
  /** 必须是已经发生/已接受的事件；`planned` 是未来意图，不允许在这里执行。 */
  status: string;
  actorId?: string | null;
  /** 事件指向的具体陈设（全限定 localId 或短引用）。 */
  furnishingLocalId?: string | null;
  accepted?: boolean;
};

export type FurnishingPromotionInput = {
  phase: FurnishingPromotionPhase | string;
  branchId: string;
  turnId: string;
  makeId: (kind: string, opId: string, alias: string) => string;
  /** 冻结的当前地点权威：来自本批开始时的地图帧，不在提升中途重读。 */
  map: { id: string; row: Record<string, unknown> } | null;
  locationId: string;
  /** 模型/事件给的对象引用：`F3` / `furn:F3` / `space:<loc>:furn:F3`。 */
  furnishingRef: string | null;
  target: FurnishingPromotionTarget;
  /** 物品必填/可选字段仍按原契约来；这里只搬运，不发明字段。 */
  itemFields: { name?: string | null; kind?: string | null; description?: string | null; quantity?: number | null; unit?: string | null };
  /** 已存在物品行（id → row），用于「已有对应 itemId 就复用」。 */
  existingItems?: ReadonlyMap<string, Record<string, unknown>> | null;
  /** originKey → itemId：上一次提升落下的索引。 */
  promoted?: ReadonlyMap<string, string> | null;
  /** 触发提升的事件；后台搬动陈设**必须**带它。 */
  event?: FurnishingPromotionEvent | null;
  /** 空间尺寸是否被作者锁定：提升不得解除，也不得改尺寸。 */
  sizeLocked?: boolean;
  /** 地点是否为只读（作者确认几何保护）。 */
  readOnly?: boolean;
};

export type FurnishingPromotionResult = {
  group: AtomicGroup | null;
  itemId: string | null;
  reused: boolean;
  issues: Issue[];
};

function issue(code: string, path: string, message: string, severity: 'warning' | 'error' = 'error'): Issue {
  return { code, path, message, severity, retryable: false };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim();
}

/** §18.3.1：稳定 originKey —— 位置 + localId，不含时间/序号/名字。 */
export function furnishingOriginKey(locationId: string, localId: string): string {
  const location = str(locationId);
  const id = str(localId);
  if (id.startsWith('space:')) return id;
  return id === '' ? '' : `space:${location}:furn:${id.replace(/^furn:/, '')}`;
}

/**
 * 把 `F3` / `furn:F3` / 全限定 localId 统一解析成本空间里的那一条陈设。
 *
 * 歧义（同一空间里出现两条短引用相同的条目）返回 null 并给码 ——
 * 「猜一条最像的」是重复占地最常见的来源。
 */
export function resolveFurnishingRef(
  canonical: SpaceCanonicalV1 | null,
  ref: unknown,
): { furnishing: SpaceCanonicalFurnishing | null; localId: string | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const raw = str(ref);
  if (raw === '') {
    issues.push(issue('PROMOTION_OBJECT_REQUIRED', '$.furnishingRef', '没有明确物体就不能提升：不按名字猜一件家具', 'error'));
    return { furnishing: null, localId: null, issues };
  }
  const list = canonical?.furnishing ?? [];
  const locationId = str(canonical?.locationId);
  const full = raw.startsWith('space:') ? raw : furnishingOriginKey(locationId, raw);
  const exact = list.filter((entry) => entry.localId === full);
  if (exact.length === 1) return { furnishing: exact[0] ?? null, localId: full, issues };

  const matches = list.filter((entry) => entry.localId === full || entry.localId.endsWith(`:furn:${raw.replace(/^furn:/, '')}`));
  if (matches.length > 1) {
    issues.push(issue('PROMOTION_REF_AMBIGUOUS', '$.furnishingRef', `陈设引用 ${raw} 在本空间里对应 ${matches.length} 条：歧义引用不提升`, 'error'));
    return { furnishing: null, localId: null, issues };
  }
  if (matches.length === 1) return { furnishing: matches[0] ?? null, localId: matches[0]?.localId ?? null, issues };

  issues.push(issue('PROMOTION_FURNISHING_UNKNOWN', '$.furnishingRef', `本空间陈设目录里没有 ${raw}：不凭名字造一张桌子`, 'error'));
  return { furnishing: null, localId: null, issues };
}

/** canonical 写回：只改那一条的 itemId，其他字段（含尺寸与 revision 之外的一切）不动。 */
function bindCanonical(canonical: SpaceCanonicalV1, localId: string, itemId: string): SpaceCanonicalV1 {
  return {
    ...canonical,
    revision: canonical.revision + 1,
    furnishing: canonical.furnishing.map((entry) => (entry.localId === localId ? { ...entry, itemId } : entry)),
  };
}

function frameWithCanonical(frameRaw: unknown, canonical: SpaceCanonicalV1): Record<string, unknown> | null {
  let frame: Record<string, unknown> | null = null;
  if (typeof frameRaw === 'string' && frameRaw.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(frameRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) frame = parsed as Record<string, unknown>;
    } catch {
      frame = null;
    }
  } else if (frameRaw && typeof frameRaw === 'object' && !Array.isArray(frameRaw)) {
    frame = frameRaw as Record<string, unknown>;
  }
  if (!frame) return null;
  return { ...frame, atlasSpaceCanonical: canonical };
}

/**
 * §18.3：幂等提升计划。
 *
 * 返回的 `group` 是**一个**原子组，成员顺序固定：物品行 → canonical 绑定 → （位置/持有已在物品行里）。
 * `reused` 为 true 时组里只有绑定与位置更新，不会出现第二张桌子。
 */
export function planFurnishingPromotion(input: FurnishingPromotionInput): FurnishingPromotionResult {
  const issues: Issue[] = [];
  const refuse = (): FurnishingPromotionResult => ({ group: null, itemId: null, reused: false, issues });

  if (!promotionAllowedInPhase(input?.phase)) {
    issues.push(issue('PROMOTION_PHASE_NOT_ALLOWED', '$.phase', `阶段 ${str(input?.phase) || '(空)'} 不能提升陈设：决策阶段的意图不是已发生的事实`, 'error'));
    return refuse();
  }
  if (input?.sizeLocked === true || input?.readOnly === true) {
    issues.push(issue('PROMOTION_LOCKED_OBJECT', '$.readOnly', '这块空间被作者锁定/只读：提升不改动它，保留旧状态', 'error'));
    return refuse();
  }

  const locationId = str(input?.locationId);
  const mapRow = input?.map?.row ?? null;
  const mapId = str(input?.map?.id);
  if (!mapRow || mapId === '' || locationId === '') {
    issues.push(issue('PROMOTION_FRAME_REQUIRED', '$.map', '没有冻结的地图帧就没有陈设目录：不能凭名字提升', 'error'));
    return refuse();
  }

  const read = readSpaceCanonical(mapRow.frame_json, locationId);
  issues.push(...read.issues);
  const canonical = read.canonical;
  if (!canonical) {
    issues.push(issue('PROMOTION_NO_CANONICAL', '$.map.frame_json', `地点 ${locationId} 没有空间权威：先建壳/陈设账本，再谈提升`, 'error'));
    return refuse();
  }

  const resolved = resolveFurnishingRef(canonical, input?.furnishingRef);
  issues.push(...resolved.issues);
  const furnishing = resolved.furnishing;
  const localId = resolved.localId;
  if (!furnishing || !localId) return refuse();

  // §18.3.1：核对当前 actor/事件确实作用于该物体 —— 事件不能顺手提升别的东西。
  const event = input?.event ?? null;
  if (event) {
    const eventObject = str(event.furnishingLocalId);
    if (eventObject === '') {
      issues.push(issue('PROMOTION_EVENT_OBJECT_MISSING', '$.event.furnishingLocalId', '事件没有指向具体陈设：不把整间屋子的家具一起提升', 'error'));
      return refuse();
    }
    const normalized = furnishingOriginKey(locationId, eventObject);
    if (normalized !== localId) {
      issues.push(issue('PROMOTION_OBJECT_MISMATCH', '$.event.furnishingLocalId', `事件作用于 ${normalized}，而本次提升的是 ${localId}`, 'error'));
      return refuse();
    }
    const status = str(event.status).toLowerCase();
    const happened = event.accepted === true || ['occurred', 'completed', 'accepted', 'observed'].includes(status);
    if (!happened) {
      issues.push(issue('PROMOTION_EVENT_NOT_EFFECTIVE', '$.event.status', `事件状态为 ${status || '(空)'}：未来的意图不立即执行`, 'error'));
      return refuse();
    }
  } else if (input?.target?.kind === 'move' || input?.target?.kind === 'hold') {
    issues.push(issue('PROMOTION_EVENT_REQUIRED', '$.event', '搬动/转交必须有已接受、实际发生的事件作为依据', 'error'));
    return refuse();
  }

  // §18.3.2：已有对应 itemId 就复用（canonical 绑定优先，其次提升索引）。
  const originKey = localId;
  const indexed = str(input?.promoted?.get?.(originKey) ?? '');
  const bound = str(furnishing.itemId);
  const existing = bound || indexed;
  const existingRow = existing !== '' ? input?.existingItems?.get?.(existing) ?? null : null;
  /**
   * 只要「已经有一个 ID」，就沿用它 —— 哪怕这一批看不到它的行。
   *
   * 理由：新建第二张桌子的代价远大于「更新一条暂时不可见的行」。
   * ID 稳定意味着重试落在同一行上，天然幂等。
   */
  const reused = existing !== '';
  if (existing !== '' && existingRow === null && bound === '') {
    // 索引指向一个这一批没读到的物品：沿用 ID，不新建，并如实说明。
    issues.push(issue('PROMOTION_ITEM_MISSING', '$.existingItems', `提升索引指向的 ${existing} 本批不可见：沿用同一 ID 更新，不新建第二件`, 'warning'));
  }

  const opId = `furnishing-promotion:${localId}`;
  const itemId = existing !== '' ? existing : input.makeId('item', opId, localId);
  const itemBefore = existingRow;
  const itemAfter = buildItemRow({
    input: input as FurnishingPromotionInput,
    itemId,
    locationId,
    localId,
    furnishing,
    before: itemBefore,
  });

  const nextCanonical = bindCanonical(canonical, localId, itemId);
  const nextFrame = frameWithCanonical(mapRow.frame_json, nextCanonical);
  if (!nextFrame) {
    issues.push(issue('PROMOTION_FRAME_UNREADABLE', '$.map.frame_json', '地图帧不可解析：不能把 itemId 绑回陈设，提升放弃', 'error'));
    return refuse();
  }

  const mutations: RowMutation[] = [
    {
      table: 'items',
      rowId: itemId,
      before: itemBefore,
      after: itemAfter,
      sourceOpIds: [opId],
      basis: { kind: 'furnishing-promotion', originKey, locationId, furnishingLocalId: localId },
    },
    {
      table: 'maps',
      rowId: mapId,
      before: { ...mapRow },
      after: { ...mapRow, frame_json: JSON.stringify(nextFrame), row_rev: Number(mapRow.row_rev ?? 1) + 1, updated_turn_id: input.turnId },
      sourceOpIds: [opId],
      basis: { kind: 'furnishing-binding', originKey, locationId, furnishingLocalId: localId, itemId },
    },
  ];

  return {
    group: {
      id: `furnishing-promotion:${locationId}:${localId}`,
      opIds: [opId],
      dependsOn: [],
      readSet: [
        { table: 'maps', rowId: mapId, rowRev: Number(mapRow.row_rev ?? 1) },
        ...(itemBefore ? [{ table: 'items', rowId: itemId, rowRev: Number(itemBefore.row_rev ?? 1) }] : []),
      ],
      mutations,
      opIssues: issues,
      purpose: 'business',
    },
    itemId,
    reused,
    issues,
  };
}

function buildItemRow(args: {
  input: FurnishingPromotionInput;
  itemId: string;
  locationId: string;
  localId: string;
  furnishing: SpaceCanonicalFurnishing;
  before: Record<string, unknown> | null;
}): Record<string, unknown> {
  const { input, itemId, locationId, localId, furnishing, before } = args;
  const fields = input.itemFields ?? {};
  const target = input.target;
  const base = before ?? createRow('items', {
    name: str(fields.name) || furnishing.name || furnishing.type || '物品',
    kind: 'object',
  }, {
    branchId: input.branchId,
    id: itemId,
    turnId: input.turnId,
    clockS: 0,
    nowWallMs: 0,
    rulesetVersion: 'atlas-1',
  });

  const row: Record<string, unknown> = { ...base, name: str(fields.name) || str(base.name) || furnishing.name,
    row_rev: before ? Number(before['row_rev']) + 1 : base['row_rev'], updated_turn_id: input.turnId };
  if (str(fields.kind) !== '') row.kind = str(fields.kind);
  if (typeof fields.description === 'string') row.description = fields.description;
  if (typeof fields.quantity === 'number') row.quantity = fields.quantity;
  if (typeof fields.unit === 'string' && fields.unit !== '') row.unit = fields.unit;

  // §18.3.6：尺寸与来源跟着物品走；坐标按目标图重写，**不搬旧源坐标**。
  const properties = [
    { key: 'fromFurnishing', value: localId },
    { key: 'originLocationId', value: locationId },
    { key: 'sizeM', value: { widthM: furnishing.widthM, heightM: furnishing.heightM } },
  ];
  row.properties_json = JSON.stringify(properties);

  if (target?.kind === 'hold') {
    row.holder_character_id = str(target.characterId);
    row.container_item_id = null;
    row.location_id = null;
    row.map_id = null;
    row.grid_x = null;
    row.grid_y = null;
    row.coord_precision = 'unknown';
    row.uncertainty_radius_cells = null;
  } else if (target?.kind === 'move') {
    row.holder_character_id = null;
    row.container_item_id = null;
    row.location_id = str(target.locationId);
    const sameFrame = str(target.mapId) === '' || str(target.mapId) === str((input.map?.row?.id ?? ''));
    row.map_id = sameFrame ? (target.mapId ?? null) : str(target.mapId);
    // 跨图不搬旧坐标：只有调用方明确给了新图坐标才写。
    row.grid_x = typeof target.gridX === 'number' ? target.gridX : null;
    row.grid_y = typeof target.gridY === 'number' ? target.gridY : null;
    row.coord_precision = typeof target.gridX === 'number' && typeof target.gridY === 'number' ? 'approximate' : 'unknown';
    row.uncertainty_radius_cells = null;
  } else {
    // 原地成为真实物品：仍在原来的地点，坐标沿用陈设（由调用方的真实位置决定，这里只清指针）。
    row.holder_character_id = null;
    row.container_item_id = null;
    row.location_id = locationId;
    row.coord_precision = 'unknown';
  }
  return row;
}

/**
 * §18.3.7：回退到提升前需要还原什么。
 *
 * 原子组天然带 `before`，但「恢复得干净」还需要把三类东西一起退：
 * 物品行、canonical 绑定、位置/持有。这里把要退的清单显式列出来，
 * 便于回退路径逐项核对（有幽灵 holder 或重复 ID 时测试会直接失败）。
 */
export function promotionRestorePlan(group: AtomicGroup | null): {
  items: Array<{ rowId: string; before: Record<string, unknown> | null }>;
  maps: Array<{ rowId: string; before: Record<string, unknown> | null }>;
  complete: boolean;
} {
  const items: Array<{ rowId: string; before: Record<string, unknown> | null }> = [];
  const maps: Array<{ rowId: string; before: Record<string, unknown> | null }> = [];
  for (const mutation of group?.mutations ?? []) {
    if (mutation.table === 'items') items.push({ rowId: mutation.rowId, before: mutation.before });
    if (mutation.table === 'maps') maps.push({ rowId: mutation.rowId, before: mutation.before });
  }
  // 绑定在 maps 帧里，位置/持有在 items 行里：两组都在才算「退得干净」。
  return { items, maps, complete: items.length === 1 && maps.length === 1 && maps[0]?.before !== null };
}

/**
 * §18.2：后台搬动陈设的**事件效果适配器**。
 *
 * 只接受「已经发生、已接受」的 outcome 事件，并且事件必须点名真实陈设、真实 actor、
 * 合法目标；通过后调用**同一个**提升规划，不另写一套。
 */
export function planFurnishingMove(input: {
  phase: string;
  event: FurnishingPromotionEvent | null | undefined;
  target: FurnishingPromotionTarget | null | undefined;
  actorExists: (actorId: string) => boolean;
  targetLegal: (target: FurnishingPromotionTarget) => boolean;
}): { allowed: boolean; issues: Issue[] } {
  const issues: Issue[] = [];
  if (!promotionAllowedInPhase(input?.phase) || String(input?.phase) !== 'outcome-effect') {
    issues.push(issue('PROMOTION_MOVE_PHASE_NOT_ALLOWED', '$.phase', '后台搬动只能在已接受 outcome 的效果适配器里执行', 'error'));
    return { allowed: false, issues };
  }
  const event = input?.event ?? null;
  if (!event) {
    issues.push(issue('PROMOTION_MOVE_EVENT_REQUIRED', '$.event', '没有 outcome 事件就没有搬动', 'error'));
    return { allowed: false, issues };
  }
  if (event.accepted !== true && !['occurred', 'completed'].includes(str(event.status).toLowerCase())) {
    issues.push(issue('PROMOTION_MOVE_EVENT_NOT_EFFECTIVE', '$.event.status', '决策里的未来意图不得立即执行', 'error'));
    return { allowed: false, issues };
  }
  const actorId = str(event.actorId);
  if (actorId === '' || !input.actorExists(actorId)) {
    issues.push(issue('PROMOTION_MOVE_ACTOR_UNKNOWN', '$.event.actorId', '事件必须指向真实 actor', 'error'));
    return { allowed: false, issues };
  }
  if (str(event.furnishingLocalId) === '') {
    issues.push(issue('PROMOTION_MOVE_OBJECT_REQUIRED', '$.event.furnishingLocalId', '事件必须指向真实陈设，不能「把屋里的家具搬走」', 'error'));
    return { allowed: false, issues };
  }
  const target = input?.target ?? null;
  if (!target) {
    issues.push(issue('PROMOTION_MOVE_TARGET_REQUIRED', '$.target', '搬动必须有明确目标（搬到哪儿/交给谁）', 'error'));
    return { allowed: false, issues };
  }
  if (target.kind === 'hold' && str(target.characterId) === '') {
    issues.push(issue('PROMOTION_MOVE_HOLDER_REQUIRED', '$.target.characterId', '交给某人必须点名真实收件人', 'error'));
    return { allowed: false, issues };
  }
  if (target.kind === 'move' && str(target.locationId) === '') {
    issues.push(issue('PROMOTION_MOVE_LOCATION_REQUIRED', '$.target.locationId', '搬到某处必须点名真实地点', 'error'));
    return { allowed: false, issues };
  }
  if (!input.targetLegal(target)) {
    issues.push(issue('PROMOTION_MOVE_TARGET_ILLEGAL', '$.target', '目标不合法（地点不存在/不可到达/收件人不可控）：不执行搬动', 'error'));
    return { allowed: false, issues };
  }
  return { allowed: true, issues };
}
