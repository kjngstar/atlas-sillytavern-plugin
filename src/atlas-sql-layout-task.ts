/**
 * atlas-sql-layout-task.ts — M4-21 / M4-22：把「已登记的世界」变成一次可绘制的布局请求。
 *
 * 职责边界（改这个文件前先读一遍）：
 * 1. **只读**：本模块在候选事务内读表，不写库、不发请求、不开事务。真正的发送由 repository 记账。
 * 2. **角色来自真实 container.kind，不按名字猜**（contract 02 §6）：
 *    - 根图 / region / natural 容器 → `overview`（宏观概览）；
 *    - city / district 容器 → `city`；
 *    - building / floor / room / vehicle 容器 → `floor`。
 *    大空间永远不会被塞成"超小房间"。
 * 3. **幅面走 normalizeSqlMapFrame**：兼容 `reference_width_cells` 旧档，也绝不把
 *    `Number(frame.cols)` 的 NaN 带进排位。没有可信尺度的 overview 用**格**（units=cells），
 *    不是米。
 * 4. **引用目录必须冻结**：alias 由 `collectTaskRefs` 定向分配，不用全表 `collectKnownRefs`
 *    —— 图一多，第 70 张图就会掉出上限，alias 也会随插入顺序漂移。
 * 5. **一次最多 2 张图**，超出部分进 remaining，不静默忘记。
 */

import { createTableReadPort } from './atlas-db-readport.ts';
import { collectTaskRefs } from './atlas-sql-task-refs.ts';
import { buildStagePrompt } from './atlas-ops-prompts.ts';
import { normalizeFrame, normalizeSqlMapFrame } from './atlas-spatial-frame.ts';
import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';
import { stableHexHash } from './atlas-hash.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { ModelBatchRequest, TurnInput } from './atlas-ops-contract.ts';
import type { LayoutKind, LayoutTask, PlanIssue } from './atlas-world-contract.ts';

type SqlRow = Record<string, unknown>;

/**
 * frame_json 里记录「这张图最后一次布局所依据的结构指纹」的键（M4-23 写入）。
 * 指纹未变 → 结构没变 → 不再为同一张图重复请求模型。
 */
export const LAYOUT_CONTEXT_FRAME_KEY = 'atlasLayoutContext';

/** 容器地点 kind → 布局种类。未列出的 kind 不参与自动布局（role 由真实 container.kind 决定）。 */
const OVERVIEW_CONTAINER_KINDS = new Set(['region', 'natural']);
const CITY_CONTAINER_KINDS = new Set(['city', 'district']);
const FLOOR_CONTAINER_KINDS = new Set(['building', 'floor', 'room', 'vehicle']);

/** 单房间示意幅面的基准边长（米）：没有尺度依据时的估计，绝不写成 1 格 = 1 米。 */
const FLOOR_BASE_SIDE_M = 24;
const ROOM_BASE_SIDE_M = 12;
const CITY_BASE_SIDE_M = 1000;

/** 兜底幅面：frame 损坏时用它继续出图，但会记一条 warning，不静默把 NaN 当尺寸。 */
const FALLBACK_COLS = 100;
const FALLBACK_ROWS = 80;

const asId = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
/** 字典序比较，不用 localeCompare（宿主机 locale 不能影响 alias 分配与排序）。 */
const byId = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const uniqueSorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(byId);

type Entry = {
  map: SqlRow;
  mapId: string;
  kind: LayoutKind;
  container: SqlRow | null;
  frameCols: number;
  frameRows: number;
  extent: { width: number; height: number; units: 'meters' | 'cells' };
  standalone: boolean;
  own: SqlRow[];
};

/**
 * 单张图的角色判定。返回 null 表示「不参与自动布局」（容器缺失或类型不在白名单）。
 */
function classify(map: SqlRow, locations: SqlRow[], container: SqlRow | null): LayoutKind | null {
  if (container) {
    const kind = String(container.kind ?? '');
    if (OVERVIEW_CONTAINER_KINDS.has(kind)) return 'overview';
    if (CITY_CONTAINER_KINDS.has(kind)) return 'city';
    if (FLOOR_CONTAINER_KINDS.has(kind)) return 'floor';
    return null;
  }
  // 没有容器 = 根图（world / site / region 图都按宏观概览处理）。
  // 注意：只有「容器字段为空」才算根图；容器指向一个查不到的地点属于坏拓扑，走另一条分支。
  const hasContainerField = map.container_location_id !== null && map.container_location_id !== undefined && map.container_location_id !== '';
  if (hasContainerField) return null;
  void locations;
  return 'overview';
}

/**
 * 幅面与单位。
 * - overview：已标定 → 米（cols×mpp / rows×mpp）；未标定 → **格**（cols / rows）。
 * - city / floor：一律米；没有可信尺度时按场所功能估计基准边长，并保持 cols:rows 宽高比。
 */
function measure(
  kind: LayoutKind,
  container: SqlRow | null,
  cols: number,
  rows: number,
  metersPerCell: unknown,
): { width: number; height: number; units: 'meters' | 'cells' } {
  const calibrated = finite(metersPerCell) && metersPerCell > 0;
  const maxSide = Math.max(cols, rows);
  if (kind === 'overview') {
    if (calibrated) return { width: cols * metersPerCell, height: rows * metersPerCell, units: 'meters' };
    return { width: cols, height: rows, units: 'cells' };
  }
  if (calibrated) return { width: cols * metersPerCell, height: rows * metersPerCell, units: 'meters' };
  const containerKind = String(container?.kind ?? '');
  // 单间房按一间房的尺度估计；车厢/楼层/建筑等具体图沿用 24 m 的整层底边，
  // 避免「大空间被硬塞成超小房间」（M4-21 完成定义）。宽度比仍按 frame 的 cols:rows 保持。
  const base = containerKind === 'room'
    ? ROOM_BASE_SIDE_M
    : kind === 'city'
      ? CITY_BASE_SIDE_M
      : FLOOR_BASE_SIDE_M;
  const mpp = base / maxSide;
  return { width: cols * mpp, height: rows * mpp, units: 'meters' };
}

/** 该图是否已经落过场景（决定它是不是「missing 上级图」）。 */
function hasScene(map: SqlRow): boolean {
  const frame = normalizeFrame(map.frame_json);
  return frame.atlasScene !== undefined && frame.atlasScene !== null;
}

/** 已保存的结构指纹（M4-23 写入）；缺失或损坏按「未记录」处理，不会误跳过。 */
function storedLayoutHash(map: SqlRow): string | null {
  const frame = normalizeFrame(map.frame_json);
  const stored = frame[LAYOUT_CONTEXT_FRAME_KEY];
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const hash = (stored as SqlRow).hash;
  return typeof hash === 'string' && hash ? hash : null;
}

export type BuildLayoutTaskInput = TurnInput;

/**
 * buildSqlLayoutTask：构造本轮的布局请求（或 null 表示本轮没有需要布局的图）。
 *
 * 选图优先级（`layoutMaps:'active'`）：
 * 1. 当前有人的「具体图」（成员真正站在里面）；
 * 2. 没有 1 时，这些成员向上必经、但还没有场景的「missing 上级图」。
 * 显式给定 `layoutMaps: string[]` 时按给定顺序取（允许无人图），仍受 layoutMapsPerBatch 限制。
 */
export function buildSqlLayoutTask(
  db: SqlDatabase,
  branchId: string,
  input: TurnInput,
  turnId: string,
): LayoutTask<ModelBatchRequest> | null {
  const tables = createTableReadPort(db);
  const issues: PlanIssue[] = [];
  const locations = tables.selectWhere('locations', { branch_id: branchId, status: 'active' }, 1000) as SqlRow[];
  const characters = tables.selectWhere('characters', { branch_id: branchId, status: 'active' }, 1000) as SqlRow[];
  const maps = tables.selectWhere('maps', { branch_id: branchId, status: 'active' }, 1000) as SqlRow[];
  if (maps.length === 0) return null;

  const locationById = new Map<string, SqlRow>();
  for (const row of locations) {
    const id = asId(row.id);
    if (id) locationById.set(id, row);
  }
  const parentOf = (id: string): string | null => asId(locationById.get(id)?.parent_location_id);

  // ── 1. 逐图判定角色与幅面 ───────────────────────────────────────────────
  const entries: Entry[] = [];
  for (const map of maps) {
    const mapId = asId(map.id);
    if (mapId === null) continue;
    const containerId = asId(map.container_location_id);
    const container = containerId ? locationById.get(containerId) ?? null : null;
    const kind = classify(map, locations, container);
    if (kind === null) continue;

    const frame = normalizeSqlMapFrame(map.frame_json, { mapId, branchId });
    let cols = frame.cols;
    let rows = frame.rows;
    if (!frame.ok || !finite(cols) || !finite(rows) || cols <= 0 || rows <= 0) {
      // 绝不拿 NaN 去排位：退回兜底幅面并明确报告，让作者去修 frame。
      issues.push({
        code: 'LAYOUT_FRAME_UNUSABLE',
        path: `$.maps.${mapId}.frame_json`,
        message: `地图 ${mapId} 的幅面不可用（${frame.issues.map((item) => item.code).join('/') || 'FRAME_INVALID'}）：本轮改用 ${FALLBACK_COLS}×${FALLBACK_ROWS} 的兜底幅面出图，请作者校正`,
        severity: 'warning',
        retryable: true,
        mapId,
      });
      cols = FALLBACK_COLS;
      rows = FALLBACK_ROWS;
    }

    const own = locations.filter((row) => String(row.map_id ?? '') === mapId);
    const containerKind = String(container?.kind ?? '');
    const standalone = kind === 'floor' && own.length === 0
      && (containerKind === 'room' || containerKind === 'vehicle' || containerKind === 'floor' || containerKind === 'building');
    entries.push({
      map,
      mapId,
      kind,
      container,
      frameCols: cols,
      frameRows: rows,
      extent: measure(kind, container, cols, rows, map.meters_per_cell),
      standalone,
      own,
    });
  }
  if (entries.length === 0) return null;

  const mapByContainer = new Map<string, Entry>();
  for (const entry of entries) {
    const containerId = asId(entry.map.container_location_id);
    if (!containerId) continue;
    const held = mapByContainer.get(containerId);
    if (!held || entry.mapId < held.mapId) mapByContainer.set(containerId, entry);
  }

  // ── 2. 选图 ────────────────────────────────────────────────────────────
  let chosen: Entry[] = [];
  if (input.layoutMaps === 'active') {
    const occupied = uniqueSorted(characters.map((row) => asId(row.location_id)).filter((id): id is string => id !== null));
    const occupiedSet = new Set(occupied);
    // 优先级 1：成员真正站在里面的具体图。
    const hot = entries
      .filter((entry) => entry.container !== null && occupiedSet.has(String(entry.container.id)))
      .sort((a, b) => byId(a.mapId, b.mapId));
    if (hot.length > 0) {
      chosen = hot;
    } else {
      // 优先级 2：成员向上必经、但还没有场景的 missing 上级图。
      const missing: Entry[] = [];
      for (const locationId of occupied) {
        let current: string | null = locationId;
        const guard = new Set<string>();
        while (current !== null && !guard.has(current)) {
          guard.add(current);
          const entry = mapByContainer.get(current);
          if (entry) {
            if (!hasScene(entry.map)) missing.push(entry);
            break;
          }
          current = parentOf(current);
        }
      }
      chosen = missing.sort((a, b) => byId(a.mapId, b.mapId));
    }
  } else if (Array.isArray(input.layoutMaps)) {
    const requested = input.layoutMaps.map((id) => String(id));
    chosen = entries
      .filter((entry) => requested.includes(entry.mapId))
      .sort((a, b) => requested.indexOf(a.mapId) - requested.indexOf(b.mapId));
  }
  if (chosen.length === 0) return null;

  const batchLimit = ATLAS_RUNTIME_LIMITS.layoutMapsPerBatch;
  const selected = chosen.slice(0, batchLimit);
  const remaining = chosen.slice(batchLimit).map((entry) => entry.mapId);

  // ── 3. 冻结引用目录（失败或未执行时必须用同一份解析） ──────────────────
  const focusLocations: string[] = [];
  for (const entry of selected) {
    const containerId = asId(entry.map.container_location_id);
    if (containerId) focusLocations.push(containerId);
    for (const row of entry.own) {
      const id = asId(row.id);
      if (id) focusLocations.push(id);
    }
  }
  const catalogue = collectTaskRefs(tables, {
    branchId,
    focusMapIds: uniqueSorted(selected.map((entry) => entry.mapId)),
    focusLocationIds: uniqueSorted(focusLocations),
    includeAncestors: true,
    includeDirectChildren: true,
    includeRoutes: true,
    includeOccupants: true,
    maxEntries: ATLAS_RUNTIME_LIMITS.refCatalogMaxEntries,
  });
  const ref = (id: unknown): string | undefined => catalogue.knownRefs.find((item) => item.id === id)?.alias;

  // ── 4. contextHash：只覆盖「结构」输入 ─────────────────────────────────
  // 刻意不纳入角色/物品的 row_rev：成员走动由程序重算锚点（W04/W05），不该触发结构模型请求。
  const structureRefs = catalogue.knownRefs
    .filter((item) => item.kind === 'location' || item.kind === 'route')
    .map((item) => `${item.kind}\u0000${item.id}\u0000${item.rowRev ?? ''}`)
    .join('\u0001');
  const frameSignature = selected
    .map((entry) => `${entry.mapId}\u0000${entry.kind}\u0000${entry.extent.units}\u0000${entry.extent.width}\u0000${entry.extent.height}`)
    .join('\u0001');
  const contextHash = stableHexHash([`layout`, `maps:${selected.map((entry) => entry.mapId).join(',')}`, `frame:${frameSignature}`, `refs:${structureRefs}`].join('\u0002'));

  // ── 5. 结构未变 → 不发请求（unchanged ready 图零重复模型请求） ──────────
  const pending = selected.filter((entry) => storedLayoutHash(entry.map) !== contextHash);
  if (pending.length === 0) return null;

  // ── 6. 组装图范围摘要 ──────────────────────────────────────────────────
  const scopes = pending.map((entry) => {
    const container = entry.container;
    const frame = normalizeFrame(entry.map.frame_json);
    const scene = frame.atlasScene && typeof frame.atlasScene === 'object' && !Array.isArray(frame.atlasScene)
      ? (frame.atlasScene as SqlRow)
      : null;
    const sceneLayout = scene && typeof scene.layout === 'object' && scene.layout !== null && !Array.isArray(scene.layout)
      ? (scene.layout as SqlRow)
      : null;
    const baselineRooms = entry.standalone && container
      ? [{
        id: ref(container.id),
        name: container.name,
        w: Math.min(entry.extent.width * 0.75, container.kind === 'vehicle' ? 4 : Number.POSITIVE_INFINITY),
        h: Math.min(entry.extent.height * 0.75, container.kind === 'vehicle' ? 6 : Number.POSITIVE_INFINITY),
        side: 'north',
      }]
      : [];
    const local = entry.standalone && container ? [container] : entry.own;
    const localIds = new Set(local.map((row) => String(row.id)));
    return {
      map: ref(entry.mapId),
      name: entry.map.name,
      kind: entry.kind,
      units: entry.extent.units,
      container: container ? { ref: ref(container.id), kind: container.kind, name: container.name } : null,
      frame: {
        cols: entry.frameCols,
        rows: entry.frameRows,
        metersPerCell: entry.map.meters_per_cell,
        scaleLocked: !!entry.map.scale_locked,
      },
      extent: { width: entry.extent.width, height: entry.extent.height, units: entry.extent.units },
      baselineRooms,
      locations: local.map((row) => ({
        ref: ref(row.id),
        name: row.name,
        kind: row.kind,
        parent: ref(row.parent_location_id),
      })),
      actors: characters
        .filter((row) => localIds.has(String(row.location_id ?? '')))
        .map((row) => ({ ref: ref(row.id), name: row.name, roomId: ref(row.location_id) })),
      savedConstraints: scene?.constraints ?? null,
      layoutIssues: sceneLayout?.issues ?? [],
    };
  });
  const pendingIds = pending.map((entry) => entry.mapId);

  // ── 7. 提示词（M4-22） ────────────────────────────────────────────────
  const request = buildStagePrompt({
    phase: 'geography',
    allowedOps: ['map.layout.request', 'noop'],
    batchId: `layout_${turnId}`,
    mapScope: JSON.stringify(scopes),
    geoMissing: '必须为以上地图生成或更新可绘制空间布局，每张图一行 map.layout.request。仅有坐标点不算完成。',
    geoSources: input.assistantText,
    sourceSnapshot: input.sourceSnapshot,
    mapLayoutIds: catalogue.knownRefs.map((item) => `${item.alias}=${item.id}`).join('\n'),
    mapLayoutFrame: [
      'extent 是程序给定的幅面；kind 与 units 以每张图给出的值为准，不得改写。',
      'units=cells 表示这张图还没标定，width/height 是格数，不是米；units=meters 时 width/height 才是米。',
      'floor 通常是 12×8 或 24×24 米量级；city 至少 900×700 米；overview 直接用程序给的格幅面。',
      '已有尺度时 extent = cols×metersPerCell、rows×metersPerCell；不要自己换算比例尺。',
    ].join('\n'),
    mapLayoutLocks: [
      '保留 savedConstraints 的既有结构与稳定局部 ID；省略字段表示保持，不表示删除。',
      '已确认/锁定的几何与作者确认的事实不得改写。',
      '没有河流依据时 riverWidth=0；没有生态依据的城市允许无河、无城墙、无树林。',
      '合理陈设可以按场所用途补全（estimated），不要求正文逐项点名。',
    ].join('\n'),
  });
  request.messages[1].content += '\n完整操作外层必须为 {"op":"map.layout.request","ref":"本图map引用","data":{"kind":"overview或city或floor","spec":{...}},"why":"依据"}；spec 只写本次变化的约束，幅面用程序给的 extent。'
    + '\noverview：spec={"surface":"mixed","zones":[{"id":地点引用,"name","role":"city/settlement/forest/water/mountain/ruins/district/campus/land/other","size":"small/medium/large","sector":"north/south/east/west/northeast/northwest/southeast/southwest/center","near":可选地点引用}],"links":[{"id":已登记route引用}],"features":[{"id":"本图局部装饰ID","type":"forest_texture/ridge/shore/building_cluster/road_texture/ruins_scatter/watercourse","zoneId":可选,"density":"low/medium/high"}]}。'
    + 'overview 的 zone 必须是本图直属地点或目录里已有的代理入口；links 只能用目录中已登记的路线引用；feature 只是本图局部装饰，永远不产生新实体、也不产生新道路。'
    + '\ncity：spec={"districts":[{"id":地点引用,"name","bank":"west/east","order":整数}],"buildings":[{"id":地点引用,"name","districtId":地块引用,"w","h"}],"enclosure":"open/wall","riverWidth":数值}。没有已登记街区时允许用城市 container.ref 表示整个城市的单个范围；新城市默认 enclosure="open"（无城墙、无城门、无环城墙道路）。'
    + '\nfloor：spec={"rooms":[{"id":地点引用,"name","w","h","side":"north/south"}],"contents":[{"id":"本图局部陈设ID","name","type":"shelf/desk/bench/reading/stairs/table/chair/bed/cabinet/doorway/light/decor","roomId":房间引用,"w","h"}],"actors":[{"id":人物引用,"roomId":房间引用,"near":可选陈设ID}],"items":[{"id":物品引用,"on":陈设ID}]}。'
    + '\n布局阶段不新建 SQL 实体：所有可交互地点必须已经在目录里。但建设阶段允许新增地点，两者不冲突——不要因为布局不新建实体就停止补全世界。'
    + '\n不要输出其他操作。';
  request.anchor = input.anchor;
  request.promptInput = {
    injectionText: request.messages[1].content,
    userText: input.userText,
    assistantText: input.assistantText,
    loreSupplement: input.sourceSnapshot.filter((item) => item.kind === 'lorebook').map((item) => item.text).join('\n'),
    baseRevision: input.anchor.baseRevision,
  };
  request.messages[1].content += '\n单房间地图的 baselineRooms 是插件提供的合法示意房间；没有更明确尺寸依据时直接保留，至少要包含这个已登记的房间。不要把 width/height 写成房间尺寸，房间尺寸字段为 w/h，side 固定选 north 或 south。';
  request.messages[1].content += '\n更新布局时，同一实物必须沿用 savedConstraints 的既有局部 id，不得换 id 重复添加。layoutIssues 是旧图未放下的陈设：按正文校正估计尺寸；若旧约束重复描述同一座椅或柜子，保留一个既有 id，用 spec.deletes={"contents":[重复的局部陈设id]} 显式清理重复约束，并同步 actors.near。不要删除已确认的锁定结构。';
  // 兼容预设的注入副本必须与最终任务一致（预览与真实发送不能两套）。
  request.promptInput.injectionText = request.messages[1].content;

  return {
    request,
    catalogue: { ...catalogue, issues: [...issues, ...catalogue.issues] },
    guard: {
      chatUid: input.anchor.chatUid,
      branchId,
      baseRevision: input.anchor.baseRevision,
      baseStorageRevision: input.anchor.baseStorageRevision,
    },
    contextHash,
    focusLocationIds: uniqueSorted(focusLocations),
    remainingLocationIds: remaining,
    mapIds: pendingIds,
    kinds: Object.fromEntries(pending.map((entry) => [entry.mapId, entry.kind])),
    extents: Object.fromEntries(pending.map((entry) => [entry.mapId, { ...entry.extent }])),
    baselineRooms: Object.fromEntries(
      pending.map((entry, index) => [entry.mapId, (scopes[index]?.baselineRooms ?? []) as Array<Record<string, unknown>>]),
    ),
  };
}
