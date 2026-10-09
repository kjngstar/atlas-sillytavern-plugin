/**
 * atlas-spatial-occupants.ts — M3/W04：房间占用者（人物 / 地面物品）的 SQL 归属对账。
 *
 * 纪律（改这个文件前先读一遍）：
 * 1. **SQL 归属是唯一权威**：谁在哪个房间由 `characters.location_id` / `items.location_id` 说了算，
 *    场景里的锚点只是视觉投影。对账只决定「画不画、画在哪」，绝不写回 characters/items 的 exact 坐标。
 * 2. **不丢数据库行**：物品没有支撑家具组时走 `looseItemMarkers`（通用地面摆放），
 *    不是把 items 行删掉，也不是凭空造一张桌子出来。
 * 3. **在途 / 跨房间 / 已持有的实体不下场**：迁出的角色移除旧锚点；被持有的物品不再当地面物品显示。
 * 4. 纯函数：不读库、不写库、不调模型。输出交给 W05 去拼进生成请求。
 */

import type { Issue } from './atlas-ops-contract.ts';
import type { SceneDocument } from '../vendor/atlas-spatial/index.mjs';
import { placeMarkers } from '../vendor/atlas-spatial/index.mjs';
import { spatialIssue } from './atlas-spatial-frame.ts';

type SqlRow = Record<string, unknown>;

export type EffectivePosition = {
  entityId: string;
  mapId?: string | null;
  locationId?: string | null;
  x?: number | null;
  y?: number | null;
};

export type OccupantsInput = {
  /** 已保存场景（可为 null：新图首轮）。 */
  scene: SceneDocument | null;
  /** 本轮布局请求里的约束（rooms / contents / actors / items）。 */
  requestSpec: SqlRow;
  locations?: SqlRow[];
  characters?: SqlRow[];
  items?: SqlRow[];
  /** 本轮结算出的有效位置（在途判定用）。 */
  effectivePositions?: EffectivePosition[];
};

export type ActorSpec = { id: string; roomId: string; near?: string; position?: { x: number; y: number } };
export type ItemSpec = { id: string; on: string };

/** 没有支撑家具组的地面物品：W05 用 placeMarkers 在房间可通行区里找点。 */
export type LooseItemMarker = { id: string; roomId: string; name: string; type: 'item' };

export type OccupantsResult = {
  spec: { actors: ActorSpec[]; items: ItemSpec[] };
  looseItemMarkers: LooseItemMarker[];
  /**
   * 需要显式删除的锚点（迁出 / 被持有 / 跨房间）。
   * 生成器的语义是「省略=保持」，所以要真的移除旧锚点必须走 `deletes`。
   */
  deleted: { actors: string[]; items: string[] };
  /** 与已保存场景相比确实变了：调用方据此决定要不要重生/重写。 */
  dirty: boolean;
  issues: Issue[];
};

function rows(list: SqlRow[] | undefined): SqlRow[] {
  return Array.isArray(list) ? list : [];
}

function plain(value: unknown): value is SqlRow {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

/** 稳定的形状签名：只比「谁在哪个房间 / 靠哪件家具」，不比浮点坐标。 */
function signature(actors: ActorSpec[], items: ItemSpec[]): string {
  const a = [...actors]
    .sort((l, r) => (l.id < r.id ? -1 : l.id > r.id ? 1 : 0))
    .map((x) => `${x.id}>${x.roomId}${x.near ? `#${x.near}` : ''}`);
  const i = [...items]
    .sort((l, r) => (l.id < r.id ? -1 : l.id > r.id ? 1 : 0))
    .map((x) => `${x.id}@${x.on}`);
  return `${a.join(',')}|${i.join(',')}`;
}

function warn(code: string, path: string, message: string, entityId?: string): Issue {
  return { code, path, message: entityId ? `${message}（${entityId}）` : message, severity: 'warning', retryable: false };
}

/**
 * W04 reconcileOccupantsSpec：以最后 SQL 归属重建 actors / items。
 *
 * - 人物：只有 `location_id` 落在本布局房间里的才下场；请求里写了但 SQL 不在那个房间的一律移除并告警。
 * - 物品：只有「未被持有、未被收纳、落在本布局房间」的才是地面物品；没有支撑组的进 `looseItemMarkers`。
 * - `near` / `on` 仍指向合法目标时保留旧值，避免每次重排。
 */
export function reconcileOccupantsSpec(input: OccupantsInput): OccupantsResult {
  const issues: Issue[] = [];
  const requestSpec = plain(input.requestSpec) ? input.requestSpec : {};
  const scene = input.scene ?? null;
  const mapId = text(scene?.mapId) || '';
  const branchId = text(scene?.branchId) || '';

  /* ── 房间集合：本轮请求 + 已保存场景（都在同一张图上才对账） ── */
  const roomIds = new Set<string>();
  for (const room of rows(requestSpec.rooms as SqlRow[])) {
    const id = text(room?.id);
    if (id) roomIds.add(id);
  }
  const layout = (scene?.layout ?? null) as SqlRow | null;
  if (layout?.kind === 'floor' && Array.isArray(layout.rooms)) {
    for (const room of layout.rooms as SqlRow[]) {
      const id = text(room?.id);
      if (id) roomIds.add(id);
    }
  }

  /* ── 家具组：id → roomId（局部视觉 ID，只在本次布局内有效） ── */
  const groupRoom = new Map<string, string>();
  const groupIds = new Set<string>();
  const collectGroups = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      if (!plain(raw)) continue;
      const id = text(raw.id);
      if (!id) continue;
      groupIds.add(id);
      const roomId = text(raw.roomId);
      if (roomId) groupRoom.set(id, roomId);
    }
  };
  const savedConstraints = (() => {
    const raw = (scene as unknown as SqlRow | null)?.constraints;
    return plain(raw) ? raw : {};
  })();
  collectGroups(requestSpec.contents);
  collectGroups(savedConstraints.contents);
  if (layout?.kind === 'floor' && Array.isArray(layout.groups)) {
    for (const group of layout.groups as SqlRow[]) {
      const id = text(group?.id);
      if (id) {
        groupIds.add(id);
        const roomId = text(group?.roomId);
        if (roomId) groupRoom.set(id, roomId);
      }
    }
  }

  /* ── 上一轮的视觉锚点（保留仍合法的 near / on） ── */
  const prevActors = new Map<string, ActorSpec>();
  const collectActors = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      if (!plain(raw)) continue;
      const id = text(raw.id);
      const roomId = text(raw.roomId);
      if (!id || !roomId) continue;
      prevActors.set(id, { id, roomId, ...(text(raw.near) ? { near: text(raw.near) } : {}) });
    }
  };
  collectActors(requestSpec.actors);
  collectActors(savedConstraints.actors);

  const prevItems = new Map<string, ItemSpec>();
  const collectItems = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      if (!plain(raw)) continue;
      const id = text(raw.id);
      const on = text(raw.on);
      if (id && on) prevItems.set(id, { id, on });
    }
  };
  collectItems(requestSpec.items);
  collectItems(savedConstraints.items);

  /* ── 在途判定：本轮结算把他/它放到了别处 ── */
  const transit = new Set<string>();
  for (const pos of rows(input.effectivePositions as unknown as SqlRow[])) {
    const entityId = text(pos?.entityId);
    if (!entityId) continue;
    const posMapId = text(pos?.mapId);
    if (mapId && posMapId && posMapId !== mapId) transit.add(entityId);
  }

  const alive = (row: SqlRow) => String(row?.status ?? 'active') === 'active';
  const inBranch = (row: SqlRow) => !branchId || String(row?.branch_id ?? branchId) === branchId;

  const characterRows = rows(input.characters).filter((row) => alive(row) && inBranch(row));
  const itemRows = rows(input.items).filter((row) => alive(row) && inBranch(row));
  const charById = new Map<string, SqlRow>();
  for (const row of characterRows) {
    const id = text(row?.id);
    if (id) charById.set(id, row);
  }
  const itemById = new Map<string, SqlRow>();
  for (const row of itemRows) {
    const id = text(row?.id);
    if (id) itemById.set(id, row);
  }

  /* ── 人物 ── */
  const actors: ActorSpec[] = [];
  const seenActors = new Set<string>();
  const pushActor = (spec: ActorSpec) => {
    if (seenActors.has(spec.id)) return;
    seenActors.add(spec.id);
    actors.push(spec);
  };

  for (const raw of rows(requestSpec.actors as SqlRow[])) {
    const id = text(raw?.id);
    const roomId = text(raw?.roomId);
    if (!id) continue;
    if (!roomIds.has(roomId)) {
      issues.push(warn('ACTOR_ROOM_UNKNOWN', '$.actors.roomId', '名单里的房间不在本布局中，移除该锚点', id));
      continue;
    }
    const row = charById.get(id);
    if (!row) {
      issues.push(warn('ACTOR_REF_UNKNOWN', '$.actors.id', '人物不在当前分支的可用名单中，移除该锚点', id));
      continue;
    }
    const actualRoom = text(row.location_id);
    if (actualRoom && actualRoom !== roomId) {
      issues.push(warn('ACTOR_LOCATION_MISMATCH', '$.actors.roomId', '该人物当前不在名单指定的房间，按真实 SQL 归属处理', id));
      continue;
    }
    if (transit.has(id)) {
      issues.push(warn('ACTOR_IN_TRANSIT', '$.actors', '该人物本轮在途，不进入室内名单', id));
      continue;
    }
    const previous = prevActors.get(id);
    const near = text(raw?.near) || previous?.near || '';
    pushActor({ id, roomId, ...(near && groupIds.has(near) ? { near } : {}) });
  }

  // SQL 归属补齐：刚迁入这个房间的人物本轮就要有可点标点，不等下一轮。
  for (const row of characterRows) {
    const id = text(row?.id);
    const roomId = text(row?.location_id);
    if (!id || !roomIds.has(roomId)) continue; // 在学校但不在具体教室 → 不下场
    if (seenActors.has(id) || transit.has(id)) continue;
    // location_id 已明确落在本图房间时，外层/旧地图上的坐标不能覆盖当前房间归属。
    // 真正在途的角色已由 effectivePositions 上面的 transit 集合排除。
    const previous = prevActors.get(id);
    pushActor({ id, roomId, ...(previous?.near && groupIds.has(previous.near) ? { near: previous.near } : {}) });
  }

  /* ── 物品 ── */
  const items: ItemSpec[] = [];
  const looseItemMarkers: LooseItemMarker[] = [];
  const seenItems = new Set<string>();
  const groundInRoom = itemRows.filter((row) => {
    if (text(row?.holder_character_id) || text(row?.container_item_id)) return false;
    return roomIds.has(text(row?.location_id));
  });

  for (const raw of rows(requestSpec.items as SqlRow[])) {
    const id = text(raw?.id);
    if (!id) continue;
    const row = itemById.get(id);
    if (!row) {
      issues.push(warn('ITEM_REF_UNKNOWN', '$.items.id', '物品不在当前分支的可用名单中，移除该锚点', id));
      continue;
    }
    if (text(row.holder_character_id) || text(row.container_item_id)) {
      issues.push(warn('ITEM_HELD', '$.items.on', '物品已被持有或收纳，不再作为地面物品显示', id));
      continue;
    }
    const on = text(raw?.on) || prevItems.get(id)?.on || '';
    const groupRoomId = on ? text(groupRoom.get(on)) : '';
    const actualRoom = text(row.location_id);
    if (on && groupIds.has(on) && groupRoomId && actualRoom && groupRoomId === actualRoom) {
      seenItems.add(id);
      items.push({ id, on });
      continue;
    }
    // 支撑组没了或跨房间：改走通用地面摆放，不删数据库行。
    if (roomIds.has(actualRoom)) {
      looseItemMarkers.push({ id, roomId: actualRoom, name: text(row.name) || id, type: 'item' });
      seenItems.add(id);
    } else {
      issues.push(warn('ITEM_LOCATION_MISMATCH', '$.items.on', '物品不在本布局的房间内，移除该锚点', id));
    }
  }

  for (const row of groundInRoom) {
    const id = text(row?.id);
    if (!id || seenItems.has(id)) continue;
    looseItemMarkers.push({ id, roomId: text(row.location_id), name: text(row.name) || id, type: 'item' });
  }

  /* ── 迁出/失效锚点：省略=保持，所以必须显式表达删除 ── */
  const looseIds = new Set(looseItemMarkers.map((m) => m.id));
  const deleted = {
    actors: [...prevActors.keys()].filter((id) => !seenActors.has(id)).sort(),
    items: [...prevItems.keys()].filter((id) => !seenItems.has(id) && !looseIds.has(id)).sort(),
  };

  /* ── dirty：与已保存场景的占用者对账结果是否变化 ── */
  // 已经摆好视觉点的地面物品不算「新变化」，避免每轮都判脏。
  const placedIds = new Set<string>();
  if (Array.isArray(layout?.items)) {
    for (const point of layout.items as SqlRow[]) {
      const id = text(point?.id);
      if (id) placedIds.add(id);
    }
  }
  const newLoose = looseItemMarkers.filter((marker) => !placedIds.has(marker.id)).length > 0;
  const savedActors: ActorSpec[] = [];
  const savedItems: ItemSpec[] = [];
  if (plain(savedConstraints)) {
    if (Array.isArray(savedConstraints.actors)) {
      for (const raw of savedConstraints.actors) {
        if (!plain(raw)) continue;
        const id = text(raw.id);
        const roomId = text(raw.roomId);
        if (!id || !roomId) continue;
        savedActors.push({ id, roomId, ...(text(raw.near) ? { near: text(raw.near) } : {}) });
      }
    }
    if (Array.isArray(savedConstraints.items)) {
      for (const raw of savedConstraints.items) {
        if (!plain(raw)) continue;
        const id = text(raw.id);
        const on = text(raw.on);
        if (id && on) savedItems.push({ id, on });
      }
    }
  }
  const dirty =
    scene === null
      ? actors.length + items.length + looseItemMarkers.length > 0
      : signature(actors, items) !== signature(savedActors, savedItems) || newLoose;

  return { spec: { actors, items }, looseItemMarkers, deleted, dirty, issues };
}

export type PlaceLooseInput = {
  scene: SceneDocument;
  markers: LooseItemMarker[];
  /** 房间 id → 可通行多边形（米制）；没有的房间直接跳过并告警。 */
  regions: Map<string, Array<{ x: number; y: number }>>;
  /** 房间 id → 家具障碍矩形（米制）。 */
  obstacles?: Map<string, Array<{ x: number; y: number; w: number; h: number }>>;
  previous?: Array<{ id: string; locationId?: string; x?: number; y?: number; locked?: boolean }>;
  step?: number;
  clearance?: number;
};

export type PlaceLooseResult = {
  /** 可直接追加进 `scene.layout.items` 的视觉点。 */
  points: Array<{ id: string; x: number; y: number; quality: 'layout' | 'exact'; roomId: string; name: string }>;
  issues: Issue[];
};

/**
 * W05 用：把没有支撑组的地面物品摆到房间可通行区里。
 *
 * 结果**只**追加到 `scene.layout.items`，不改任何 SQL 归属。
 * 房间没有可通行区时给告警并保留名单，绝不猜坐标。
 */
export function placeLooseItems(input: PlaceLooseInput): PlaceLooseResult {
  const issues: Issue[] = [];
  const points: PlaceLooseResult['points'] = [];
  const markers = Array.isArray(input.markers) ? input.markers : [];
  if (markers.length === 0) return { points, issues };
  const byRoom = new Map<string, LooseItemMarker[]>();
  for (const marker of markers) {
    const id = text(marker?.id);
    const roomId = text(marker?.roomId);
    if (!id || !roomId) continue;
    const list = byRoom.get(roomId) ?? [];
    list.push({ id, roomId, name: text(marker?.name) || id, type: 'item' });
    byRoom.set(roomId, list);
  }
  const scene = input.scene as unknown as SqlRow;
  const ctx = { mapId: text(scene?.mapId) || undefined, branchId: text(scene?.branchId) || undefined };
  for (const [roomId, list] of byRoom) {
    const region = input.regions.get(roomId);
    if (!region || region.length < 3) {
      issues.push(warn('ROOM_REGION_MISSING', `$.layout.rooms[${roomId}]`, '房间没有可通行区，本次不放地面物品', roomId));
      continue;
    }
    const placed = placeMarkers({
      region,
      markers: list.map((marker) => ({ id: marker.id, locationId: marker.roomId, name: marker.name })),
      obstacles: input.obstacles?.get(roomId) ?? [],
      previous: (input.previous ?? []).filter((p) => text(p?.locationId) === roomId),
      step: typeof input.step === 'number' && input.step > 0 ? input.step : 0.5,
      clearance: typeof input.clearance === 'number' && input.clearance > 0 ? input.clearance : 0.4,
    }) as { ok: boolean; markers?: Array<Record<string, unknown>>; issues?: Array<Record<string, unknown>>; code?: string; message?: string };
    if (!placed.ok) {
      issues.push(warn(String(placed.code ?? 'PLACEMENT_FAILED'), '$', String(placed.message ?? '地面物品摆放失败，保留名单'), roomId));
      continue;
    }
    for (const diagnostic of placed.issues ?? []) {
      issues.push(spatialIssue(diagnostic as never, { ...ctx, entityId: text(diagnostic?.entityId) || undefined }));
    }
    for (const marker of placed.markers ?? []) {
      const id = text(marker?.id);
      const x = typeof marker?.x === 'number' ? marker.x : Number.NaN;
      const y = typeof marker?.y === 'number' ? marker.y : Number.NaN;
      if (!id || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      points.push({
        id,
        x,
        y,
        quality: String(marker?.quality ?? 'layout') === 'exact' ? 'exact' : 'layout',
        roomId,
        name: text(marker?.name) || id,
      });
    }
  }
  return { points, issues };
}
