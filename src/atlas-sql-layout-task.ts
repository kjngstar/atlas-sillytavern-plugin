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
 * 5. 同类型、同依赖层的地图按容量合批，超出部分进 remaining，不静默忘记。
 */

import { createTableReadPort, pageAllRows } from './atlas-db-readport.ts';
import { collectMapLocations, LIMITS } from '../vendor/atlas-spatial/index.mjs';
import { readMetricDimensions } from '../vendor/atlas-spatial/index.mjs';
import { mergeLayoutConstraints } from './atlas-spatial-request.ts';
import { collectTaskRefs } from './atlas-sql-task-refs.ts';
import { buildStagePrompt } from './atlas-ops-prompts.ts';
import { normalizeFrame, normalizeSqlMapFrame } from './atlas-spatial-frame.ts';
import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';
import { workBatchSize } from './atlas-work-batching.ts';
import { normalizeModelBatching, planningOutputTokens } from './atlas-model-batching.ts';
import { stableHexHash } from './atlas-hash.ts';
import { resolveLocationDetailTier } from './atlas-world-build-plan.ts';
import { readWorldFacts } from './atlas-world-build-state.ts';
import { readProgressRows } from './atlas-construction-progress.ts';
import {
  canonicalAuthoredArea,
  canonicalFlag,
  canonicalRouteGeometry,
  computeLayoutInputSignature,
  type LayoutSignatureAuthorIntent,
} from './atlas-layout-signature.ts';
import type { TableReadPort } from './atlas-ops-compile-types.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { ModelBatchRequest, ModelOperation, TurnInput } from './atlas-ops-contract.ts';
import type { LayoutKind, LayoutTask, PlanIssue } from './atlas-world-contract.ts';
import { CAPABILITY_CORRIDOR_BINDING, CAPABILITY_SPACE_CANONICAL, CAPABILITY_SPATIAL_PROFILE, hasSpatialCapability } from './atlas-world-contract.ts';
import { formatTaskContext } from './atlas-prompt-layers.ts';
import {
  locationSpaceSize,
  readSpaceCanonical,
  resolveMapSpaceSize,
  SPACE_CANONICAL_MAX_FURNISHING,
  type MapSpaceSizeResult,
} from './atlas-space-canonical.ts';
import {
  boundCorridorIdOf,
  functionalAreaMembers,
  resolveSpatialProfile,
  type SpatialProfileMode,
  type SpatialProfileResolution,
} from './atlas-spatial-profile.ts';

type SqlRow = Record<string, unknown>;

/**
 * P11/R03 §18.2 第 2 条：命名走廊契约**只在程序真的声明了该能力时**才发给模型。
 * 能力的权威在 atlas-world-contract.ts；这里不写第二份开关。
 */
const CORRIDOR_BINDING_PROMPT = '当程序声明 corridor-binding/v1 能力时，命名走廊使用 corridorLocationRef 绑定已有地点；该地点必须是本图已登记的真实走廊，且不再加入普通 rooms（同一实体只表达一次）。没有真实走廊身份时不新建一个地点充当辅助通道，也不把家具局部 ID 当作走廊地点引用。省略 corridorLocationRef=保持既有绑定，null=解除绑定。走廊几何仍由程序计算，不要输出走廊坐标。';

/**
 * P12/R03 §19：空间尺寸与陈设账本契约。同样**只在能力为真时**追加。
 * 关键两条：程序给的物理尺寸就是权威（不重估）；陈设的稳定空间标识由程序生成（不拿真实 item ID 当布局 ID）。
 */
const SPACE_CANONICAL_PROMPT = '当程序声明 space-canonical/v1 能力时：extent 与 spaceSize 是程序维护的**物理权威**，父图与子图必须共用同一个物理宽高，不要自己再估一个尺寸；childSpaces 给出父图要投影的子空间尺寸，按它画轮廓而不是另算。陈设的稳定空间标识由程序按 space:<地点ID>:furn:<局部ID> 生成，真实物品只能引用已登记 item（items[].id 是真实物品引用，不是布局局部 ID），不要虚构 item。空间已有陈设账本时优先补细节与位置，不因为换了视角/图就重建整套家具。';

/**
 * P13/R03 §20 → P14/§21.5：本图绘图档案契约。**只在能力为真时**追加（与上面两项同一纪律）。
 * 档案的禁区由程序按每图实际档案翻译（见 `PROFILE_PROMPT`），这里只写「档案本身代表什么」。
 */
const SPATIAL_PROFILE_PROMPT = '当程序声明 spatial-profile/v1 能力时，遵循给定档案。复合场所用外场/建筑足迹，室内细节放在已有建筑子图；停车区与庭院不使用室内模板。档案是程序裁决的绘图模板，不是给地点改名，也不改变地点种类；没有档案依据时保持 unknown 并说明原因，不要自己挑一套模板。';

/**
 * P13/R03 §20：每种绘图档案的**禁区**翻译成人话，逐条进提示词。
 * 这是档案唯一在提示词侧的落点；档案本身仍是纯绘图层决定，不改地点 kind 与世界用途。
 */
const PROFILE_PROMPT: Record<SpatialProfileMode, string> = {
  interior: '只画已登记房间与通道；不把明确室外的成员硬塞进普通 rooms。',
  circulation: '这是已绑定走廊的通行空间，保护通行净空；不重复普通室内房间。',
  outdoor: '只画范围/足迹/入口；不生成室内窗户、不生成匿名房间；庭院与场地用 role=outdoor/garden。',
  linear: '路线必须是目录中已登记的 route；road_texture 只是局部装饰，不能当作真实道路或可通行路线。',
  compound: '画外场与真实建筑足迹，建筑的具体房间进入它自己的 floor 子图；不要把整座场所做成"两排室内房间"。',
  unknown: '只做中性概览/自身范围；不声称已确认的用途、尺寸或地形。',
};

/**
 * frame_json 里记录「这张图最后一次布局所依据的结构指纹」的键（M4-23 写入）。
 * 指纹未变 → 结构没变 → 不再为同一张图重复请求模型。
 */
export const LAYOUT_CONTEXT_FRAME_KEY = 'atlasLayoutContext';

/**
 * 容器地点 kind → 布局种类。未列出的 kind 不参与自动布局（role 由真实 container.kind 决定）。
 *
 * P06/N01：`other` 是合法场所（庭院/官道/停靠区）。它不是「未知」，
 * 首版固定按 overview + 中性 mixed 表面处理，空场地由生成器补自身范围示意，
 * 既不静默 null、也不把 other 改写成 building、更不按名称后缀猜用途。
 */
const OVERVIEW_CONTAINER_KINDS = new Set(['region', 'natural', 'other']);
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

/** Schematic capacity only: registered spaces get connected footprints, never invented entities. */
export function baselineFloorRooms(
  locations: SqlRow[],
  extent: {width:number;height:number},
  ref: (id:unknown)=>string|undefined,
  sizeOf?: (id:string)=>{widthM:number;heightM:number}|null,
) {
  const local=locations.filter(row=>row.kind!=='floor').sort((a,b)=>byId(String(a.id),String(b.id)));
  const perSide=Math.ceil(local.length/2);
  if(!perSide)return [];
  const w=Math.floor(Math.min(8,(extent.width-1)/perSide)*2)/2;
  const h=Math.floor(Math.min(8,(extent.height-2)/2-.5)*10)/10;
  if(w<=0||h<=0)return [];
  return local.map((row,i)=>{
    // P12/R03 §19.2：这个空间已有权威尺寸时，父图轮廓就是它的**投影**，不重新独立估计。
    const known=sizeOf?.(String(row.id))??null;
    // A footprint that cannot fit must produce a conflict, never a smaller physical room.
    return {id:ref(row.id),name:row.name,w:known?known.widthM:w,h:known?known.heightM:h,side:i%2?'south':'north'};
  });
}

/** Only registered entity IDs become short refs; local furniture IDs remain intact. */
function aliasLayoutRefs(value:unknown, refs:readonly {id:string;alias:string}[]):unknown{
  if(typeof value==='string')return refs.find(r=>r.id===value)?.alias??value;
  if(Array.isArray(value))return value.map(v=>aliasLayoutRefs(v,refs));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,aliasLayoutRefs(v,refs)]));
  return value;
}

/** Only entity-bearing IDs are checked; furniture and decoration retain local IDs. */
export function unknownLayoutEntityRefs(operations:readonly ModelOperation[],refs:readonly {id:string;alias:string}[]):string[]{
  const known=new Set(refs.flatMap(ref=>[ref.id,ref.alias])),unknown=new Set<string>();
  const check=(value:unknown)=>{if(typeof value==='string'&&value&&!known.has(value))unknown.add(value);};
  for(const operation of operations){
    if(operation.op!=='map.layout.request')continue;
    const spec=operation.data?.spec;
    if(!spec||typeof spec!=='object'||Array.isArray(spec))continue;
    // Local IDs (contents.id/features.id/actors.near/items.on) are intentionally excluded.
    const entityFields: Record<string, readonly string[]> = {
      zones: ['id', 'near'], links: ['id'], features: ['zoneId'],
      districts: ['id'], buildings: ['id', 'districtId'], rooms: ['id'],
      contents: ['roomId'], actors: ['id', 'roomId'], items: ['id'],
    };
    check((spec as Record<string, unknown>).corridorLocationRef);
    for(const [section, fields] of Object.entries(entityFields)){
      const rows=(spec as Record<string,unknown>)[section];
      if(!Array.isArray(rows))continue;
      for(const row of rows){
        if(!row||typeof row!=='object'||Array.isArray(row))continue;
        for(const field of fields)check((row as Record<string, unknown>)[field]);
      }
    }
  }
  return [...unknown];
}

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
  /**
   * P12/R03 §19.2：本图覆盖空间的尺寸权威（作者确认 → canonical → 父图足迹 → 首次估计）。
   * null 表示本图不是"某个具体空间"的图（根图/概览），或该空间还没有任何尺寸依据。
   */
  spaceSize: MapSpaceSizeResult | null;
  /** P13/R03 §20：本图的绘图档案裁决（布局 kind 的来源、导航名、责任范围、partial 说明）。 */
  profile: SpatialProfileResolution;
};

/**
 * 单张图的角色判定。返回 null 表示「不参与自动布局」（容器缺失或类型不在白名单）。
 *
 * P13/R03 §20：布局 kind 由**档案 resolver** 统一裁决 —— 档案是「画成什么」的显式决定，
 * 容器类型只是它的默认来源之一；作者选的档案优先，名称从不参与判断。
 */
function classify(
  map: SqlRow,
  locations: SqlRow[],
  container: SqlRow | null,
  profile: SpatialProfileResolution | null = null,
): LayoutKind | null {
  if (container) {
    const kind = String(container.kind ?? '');
    const known = OVERVIEW_CONTAINER_KINDS.has(kind) || CITY_CONTAINER_KINDS.has(kind) || FLOOR_CONTAINER_KINDS.has(kind);
    if (!known) return null;
    return profile?.layoutKind ?? (OVERVIEW_CONTAINER_KINDS.has(kind) ? 'overview' : CITY_CONTAINER_KINDS.has(kind) ? 'city' : 'floor');
  }
  // 没有容器 = 根图（world / site / region 图都按宏观概览处理）。
  // 注意：只有「容器字段为空」才算根图；容器指向一个查不到的地点属于坏拓扑，走另一条分支。
  const hasContainerField = map.container_location_id !== null && map.container_location_id !== undefined && map.container_location_id !== '';
  if (hasContainerField) return null;
  void locations;
  return profile?.layoutKind ?? 'overview';
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
  // The city solver requires a 900×700 m canvas. Default estimates must satisfy
  // both dimensions; calibrated physical dimensions remain untouched above.
  const mpp = kind==='city'?Math.max(base/maxSide,900/cols,700/rows):base/maxSide;
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

/** frame 里记录「绘图档案」的命名空间（写入方是 P13 的 resolveSpatialProfile / map.profile）。 */
const SPATIAL_PROFILE_FRAME_KEY = 'atlasSpatialProfile';

/** 明确绘图档案的 mode；未登记档案 → null（中性处理，不按名字猜用途）。 */
function profileOf(map: SqlRow): string | null {
  const frame = normalizeFrame(map.frame_json);
  const raw = frame[SPATIAL_PROFILE_FRAME_KEY];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return asId((raw as SqlRow).mode);
}

const asText = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const normalizeArea=(value:unknown):SqlRow|null=>{try{const area=typeof value==='string'?JSON.parse(value):value;return area&&typeof area==='object'&&!Array.isArray(area)?area as SqlRow:null;}catch{return null;}};

/**
 * 单张图的布局输入指纹（构建与保存两处共用同一条路径）。
 *
 * 计入的结构输入见 atlas-layout-signature.ts 的模块注释；这里只负责把 SQL 行映射成
 * 定长字段，绝不把整行（含 row_rev / updated_turn_id）塞进哈希。
 */
function signatureForEntry(entry: Entry, routes: SqlRow[], maps:SqlRow[]): string {
  const memberRows = [...(entry.container ? [entry.container] : []), ...entry.own];
  const members = memberRows.map((row) => ({
    id: String(row.id),
    name: asText(row.name),
    kind: asText(row.kind),
    parent: asText(row.parent_location_id),
    anchor: asText(row.anchor_location_id),
    description: asText(row.description),
    mobility: asText(row.mobility),
  }));
  const authorIntent: LayoutSignatureAuthorIntent[] = [];
  for (const row of memberRows) {
    const precision = asText(row.coord_precision) ?? 'unknown';
    const area=normalizeArea(row.area_geometry_json);
    const dimensions=area?.quality==='confirmed'?readMetricDimensions(area):null;
    // 'layout' 是本轮生成器回写的估计落位，'unknown' 根本没有落位：
    // 两者都进指纹就会「自己写自己」，生成一次后立刻又判定失效。
    const authoredPosition=precision!=='layout'&&precision!=='unknown';
    if (!authoredPosition && !dimensions) continue;
    authorIntent.push({
      id: String(row.id),
      precision:authoredPosition?precision:'unknown',
      gridX: authoredPosition?asNumber(row.grid_x):null,
      gridY: authoredPosition?asNumber(row.grid_y):null,
      uncertainty: authoredPosition?asNumber(row.uncertainty_radius_cells):null,
      area: canonicalAuthoredArea(row.area_geometry_json),
      dimensions,
    });
  }
  const owned = routes
    .filter((row) => asText(row.map_id) === entry.mapId)
    .map((row) => ({
      id: String(row.id),
      from: asText(row.from_location_id),
      to: asText(row.to_location_id),
      mapId: asText(row.map_id),
      status: asText(row.status),
      bidirectional: canonicalFlag(row.bidirectional),
      kind: asText(row.kind),
      geometry: canonicalRouteGeometry(row.geometry_json),
      geometryQuality: asText(row.geometry_quality),
      geometryRev: asNumber(row.geometry_rev),
    }));
  return computeLayoutInputSignature({
    mapId: entry.mapId,
    layoutKind: entry.kind,
    profile: profileOf(entry.map),
    units: entry.extent.units,
    extent: { width: entry.extent.width, height: entry.extent.height },
    members,
    authorIntent,
    routes: owned,
    structureLocked: Number(entry.map.scale_locked ?? 0) === 1,
    sizeLedgerRev: asNumber(entry.map.calibration_rev),
    spaceLedger:maps.filter(m=>memberRows.some(l=>l.id===m.container_location_id)).flatMap(m=>{
      const canonical=normalizeFrame(m.frame_json).atlasSpaceCanonical as SqlRow|undefined;
      if(!canonical||canonical.version!==1||canonical.locationId!==m.container_location_id)return [];
      const size=canonical.size as SqlRow|undefined;
      return [{locationId:String(canonical.locationId),revision:asNumber(canonical.revision),widthM:asNumber(size?.widthM),heightM:asNumber(size?.heightM)}];
    }),
  });
}

/**
 * 保存指纹时按候选库的**实际状态**重算某图的布局输入指纹。
 *
 * 生成器回写的坐标与轮廓已在指纹里排除，所以「生成前构建时算的值」与「生成后保存时算的值」
 * 在语义上一致；仍然以实际状态为准，是为了让生成过程中可能变化的幅面/尺度
 * （例如首次安装 initial-frame 会写入 meters_per_cell 与 calibration_rev）也落进已保存的指纹。
 */
export function computeMapLayoutSignature(tables: TableReadPort, branchId: string, mapId: string): string | null {
  const derived = deriveLayoutSites(tables, branchId);
  const entry = derived.entries.find((item) => item.mapId === mapId);
  if (!entry) return null;
  return signatureForEntry(entry, derived.routes, derived.maps);
}

/** One shared derivation for read-side alignment checks across visible maps. */
export function computeMapLayoutSignatures(tables: TableReadPort, branchId: string): Map<string, string> {
  const derived = deriveLayoutSites(tables, branchId);
  return new Map(derived.entries.map(entry => [entry.mapId, signatureForEntry(entry, derived.routes, derived.maps)]));
}

export type BuildLayoutTaskInput = TurnInput;

/**
 * buildSqlLayoutTask：构造本轮的布局请求（或 null 表示本轮没有需要布局的图）。
 *
 * 选图优先级（`layoutMaps:'active'`）：
 * 1. 沿当前有人地点的祖先链，从根图到具体图依次生成；
 * 2. 远处未进入的内部图留给显式请求；
 * 3. 同类型且同依赖层的图尽量合批，父图完成后再构造子图上下文。
 * 显式给定 `layoutMaps: string[]` 时允许无人图，父图优先、同层保持给定顺序。
 */
export type DerivedLayoutSites = {
  entries: Entry[];
  routes: SqlRow[];
  issues: PlanIssue[];
  locations: SqlRow[];
  maps: SqlRow[];
  characters: SqlRow[];
  items: SqlRow[];
  parentOf: (id: string) => string | null;
};

/**
 * 逐图判定角色与幅面，并按分支读出路线。
 *
 * `buildSqlLayoutTask`（构建时算指纹）与 `computeMapLayoutSignature`（保存时重算指纹）
 * 必须走**同一条派生路径**：否则同一张图在两处的 kind/extent/members 会静默不一致，
 * 指纹永远对不上，图会被无限重画（N05 的反例）。
 */
export function deriveLayoutSites(tables: TableReadPort, branchId: string): DerivedLayoutSites {
  const issues: PlanIssue[] = [];
  const active = (table: 'locations' | 'characters' | 'items' | 'maps'): SqlRow[] =>
    pageAllRows(tables, table, branchId).filter((row) => row.status === 'active');
  const locations = active('locations');
  const characters = active('characters');
  const items = active('items');
  const maps = active('maps');
  const routes = pageAllRows(tables, 'routes', branchId);

  const locationById = new Map<string, SqlRow>();
  for (const row of locations) {
    const id = asId(row.id);
    if (id) locationById.set(id, row);
  }
  const parentOf = (id: string): string | null => asId(locationById.get(id)?.parent_location_id);

  const entries: Entry[] = [];
  for (const map of maps) {
    const mapId = asId(map.id);
    if (mapId === null) continue;
    const containerId = asId(map.container_location_id);
    const container = containerId ? locationById.get(containerId) ?? null : null;
    // P13/R03 §20：档案先解析（作者选择 → 可信关系 → 类型默认），再决定布局 kind。
    const ownForProfile = collectMapLocations({ mapRow: map, maps, locations }).filter((row) => row.mobility !== 'mobile');
    const profile = resolveSpatialProfile({
      map,
      maps,
      container,
      parentContainer: container ? locationById.get(String(container.parent_location_id)) ?? null : null,
      corridorEntityId: boundCorridorIdOf(map),
      members: ownForProfile,
      routes: routes.filter((row) => String(row.branch_id ?? branchId) === branchId
        && (String(row.from_location_id ?? '') === containerId || String(row.to_location_id ?? '') === containerId)),
    });
    const kind = classify(map, locations, container, profile);
    if (kind === null) continue;
    issues.push(...profile.issues);

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

    const own = ownForProfile;
    const containerKind = String(container?.kind ?? '');
    const standalone = kind === 'floor' && (own.length === 0 || containerKind==='room'&&own.every(row=>row.kind==='other'))
      && (containerKind === 'room' || containerKind === 'vehicle' || containerKind === 'floor' || containerKind === 'building'
        || containerKind === 'other' && profile.profile.mode === 'interior');
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
      spaceSize: null,
      profile,
    });
  }

  // ── P12/R03 §19.2：空间尺寸权威 ─────────────────────────────────────────
  // 具体图（有容器）先解析自己的物理尺寸：canonical / 作者确认是**物理权威**，
  // 一旦存在，extent 就以它为准，不再由 frame 独立估一个（否则父图与子图会各说各话）。
  for (const entry of entries) {
    const resolved = resolveMapSpaceSize({
      maps,
      locations,
      mapRow: entry.map,
      branchId,
      // An uncalibrated overview extent is in cells, never physical metres.
      firstEstimate: entry.extent.units==='meters'?{ widthM: entry.extent.width, heightM: entry.extent.height }:null,
    });
    if (!resolved) continue;
    entry.spaceSize = resolved;
    issues.push(...resolved.issues);
    // 采用「本轮真正胜出的来源」，不是 canonical 里记录的**依据种类**（后者可能是 first-estimate）。
    const authoritative = resolved.resolution.source !== 'first-estimate';
    if (authoritative && entry.kind !== 'overview') {
      entry.extent = { width: resolved.resolution.widthM, height: resolved.resolution.heightM, units: 'meters' };
    }
  }
  // Freeze first estimates from the parent footprint before either model sees
  // them. A new room cannot be 7.5 m wide in its parent and 12 m in its own task.
  const entryDepth=(entry:Entry):number=>{
    const seen=new Set<string>();let current:Entry|undefined=entry;
    while(current&&!seen.has(current.mapId)){
      seen.add(current.mapId);
      const parentId:unknown=current.container?.map_id;
      current=entries.find(row=>row.mapId===parentId);
    }
    return seen.size;
  };
  // Unlocked estimates without a saved scene may grow to fit registered child
  // spaces. A nested floor must not inherit an arbitrary 8 m footprint while
  // containing a confirmed 12 m hall. Saved/authoritative geometry stays fixed.
  const expandable = (entry: Entry) => entry.kind === 'floor'
    && entry.spaceSize?.resolution.source === 'first-estimate'
    && entry.map.scale_quality !== 'confirmed'
    && !entry.map.scale_locked && !hasScene(entry.map);
  for (const entry of [...entries].sort((a,b)=>entryDepth(b)-entryDepth(a)||byId(a.mapId,b.mapId))) {
    if (!expandable(entry) || entry.own.length === 0) continue;
    const members=entry.own.filter(row=>row.kind!=='floor').sort((a,b)=>byId(String(a.id),String(b.id)));
    const sizes = members.map(row => {
      const known = locationSpaceSize({maps, locations, locationId:String(row.id), branchId});
      const child = entries.find(child => child.kind === 'floor' && child.container?.id === row.id && child.own.length > 0);
      return known ? [known.widthM, known.heightM] : child ? [child.extent.width, child.extent.height] : [8, 8];
    });
    if(!sizes.length)continue;
    // A directly connected component must share walls on one side of the
    // corridor. Alternating-room capacity alone can leave it impossible to fit.
    const remaining=new Set(members.map(row=>String(row.id)));
    let connectedWidth=0;
    while(remaining.size){
      const queue=[remaining.values().next().value!];remaining.delete(queue[0]);let width=0;
      for(let i=0;i<queue.length;i++){
        const id=queue[i];width+=sizes[members.findIndex(row=>String(row.id)===id)][0];
        for(const route of routes){
          if(route.status==='closed'||route.map_id!==entry.mapId)continue;
          const other=route.from_location_id===id?route.to_location_id:route.to_location_id===id?route.from_location_id:null;
          if(typeof other==='string'&&remaining.delete(other))queue.push(other);
        }
      }
      connectedWidth=Math.max(connectedWidth,width);
    }
    const minW = Math.max(connectedWidth,...[0,1].map(side=>sizes.reduce((sum,size,i)=>sum+(i%2===side?size[0]:0),0))) + 1;
    const minH = Math.max(...sizes.map(size=>size[1])) * 2 + 3;
    entry.extent = {...entry.extent, width:Math.max(entry.extent.width,minW), height:Math.max(entry.extent.height,minH)};
    entry.spaceSize = resolveMapSpaceSize({maps,locations,mapRow:entry.map,branchId,firstEstimate:{widthM:entry.extent.width,heightM:entry.extent.height}});
  }
  for(const child of [...entries].sort((a,b)=>entryDepth(a)-entryDepth(b)||byId(a.mapId,b.mapId))){
    if(child.kind!=='floor'||child.spaceSize?.resolution.source!=='first-estimate'||finite(child.map.meters_per_cell)&&child.map.meters_per_cell>0||child.map.scale_locked||hasScene(child.map))continue;
    const parent=entries.find(entry=>entry.mapId===child.container?.map_id&&entry.kind==='floor');
    if(!parent||!child.container)continue;
    const planned=baselineFloorRooms(parent.own,parent.extent,id=>String(id),id=>{
      const known=locationSpaceSize({maps,locations,locationId:id,branchId});
      const nested=entries.find(entry=>entry.kind==='floor'&&entry.container?.id===id&&entry.own.length>0);
      return known??(nested?{widthM:nested.extent.width,heightM:nested.extent.height}:null);
    });
    const footprint=planned.find(room=>room.id===child.container!.id);
    if(!footprint)continue;
    child.extent={width:footprint.w,height:footprint.h,units:'meters'};
    child.spaceSize=resolveMapSpaceSize({maps,locations,mapRow:child.map,branchId,firstEstimate:{widthM:footprint.w,heightM:footprint.h}});
  }
  // 父图容纳不下已确定房间尺寸：只报告，**绝不按比例缩小确认房间**（§19.3 末段）。
  for (const entry of entries) {
    if (entry.kind !== 'floor' || entry.own.length === 0) continue;
    for (const row of entry.own) {
      if(row.kind==='floor')continue;
      const childId = asId(row.id);
      if (!childId || childId === asId(entry.map.container_location_id)) continue;
      const child = locationSpaceSize({ maps, locations, locationId: childId, branchId });
      if (!child) continue;
      const maxW = entry.extent.width - 1;
      const maxH = (entry.extent.height - 2) / 2 - 0.5;
      if (child.widthM > maxW + 1e-9 || child.heightM > maxH + 1e-9) {
        issues.push({
          code: 'PARENT_CAPACITY_CONFLICT',
          path: `$.maps.${entry.mapId}`,
          message: `空间 ${childId} 的确定尺寸 ${child.widthM}×${child.heightM} m（来源 ${child.source}${child.referenceId ? `/${child.referenceId}` : ''}）装不进父图 ${entry.mapId} 的可用范围（每间房上限 ${maxW.toFixed(2)}×${maxH.toFixed(2)} m）：保留确认尺寸，报告冲突，不按比例缩小该空间`,
          severity: 'warning',
          retryable: false,
          mapId: entry.mapId,
          locationId: childId,
        });
      }
    }
  }
  return { entries, routes, issues, locations, maps, characters, items, parentOf };
}

export function buildSqlLayoutTask(
  db: SqlDatabase,
  branchId: string,
  input: TurnInput,
  turnId: string,
  report?: { issues: PlanIssue[] },
): LayoutTask<ModelBatchRequest> | null {
  const tables = createTableReadPort(db);
  const derived = deriveLayoutSites(tables, branchId);
  const issues = derived.issues;
  const { characters, items, parentOf } = derived;
  const worldFacts=readWorldFacts(readProgressRows(tables,branchId)).values;
  const detailFor=(location:SqlRow)=>resolveLocationDetailTier({location,facts:worldFacts,knownCharacters:characters,plotLinks:[]});
  const entries = derived.entries;
  if (entries.length === 0) return null;

  const mapByContainer = new Map<string, Entry>();
  for (const entry of entries) {
    const containerId = asId(entry.map.container_location_id);
    if (!containerId) continue;
    const held = mapByContainer.get(containerId);
    if (!held || entry.mapId < held.mapId) mapByContainer.set(containerId, entry);
  }

  const entryByMap=new Map(entries.map(entry=>[entry.mapId,entry]));
  const parentEntry=(entry:Entry):Entry|undefined=>{
    let id=asId(entry.container?.parent_location_id);const seen=new Set<string>();
    while(id&&!seen.has(id)){seen.add(id);const parent=mapByContainer.get(id);if(parent&&parent!==entry)return parent;id=parentOf(id);}
    const outer=entryByMap.get(String(entry.container?.map_id??''));return outer!==entry?outer:undefined;
  };
  const depth=(entry:Entry):number=>{let current:Entry|undefined=entry,n=0;const seen=new Set<string>();while(current&&!seen.has(current.mapId)){seen.add(current.mapId);current=parentEntry(current);if(current)n++;}return n;};
  // ── 2. 选图 ────────────────────────────────────────────────────────────
  let chosen: Entry[] = [];
  if (input.layoutMaps === 'active') {
    const occupied = uniqueSorted(characters.map((row) => asId(row.location_id)).filter((id): id is string => id !== null));
    const occupiedSet = new Set(occupied);
    // Automatic layout follows the occupied branch, not every room in the world.
    // Parent geography is assembled first; remote interiors are generated only
    // when explicitly requested. Single-child overview wrappers need no model.
    const activePath=new Set<string>();
    for(const locationId of occupied){
      let id:string|null=locationId;const seen=new Set<string>();
      while(id&&!seen.has(id)){seen.add(id);const entry=mapByContainer.get(id);if(entry)activePath.add(entry.mapId);id=parentOf(id);}
    }
    chosen=entries.filter(entry=>activePath.has(entry.mapId)
      ? occupiedSet.has(String(entry.container?.id))||entry.own.length>0&&(entry.kind!=='overview'||entry.own.length>1)
      : entry.container===null&&entry.own.length>1);
    chosen.sort((a,b)=>depth(a)-depth(b)||byId(a.mapId,b.mapId));
  } else if (Array.isArray(input.layoutMaps)) {
    const requested = input.layoutMaps.map((id) => String(id));
    chosen = entries
      .filter((entry) => requested.includes(entry.mapId))
      .sort((a, b) => depth(a)-depth(b)||requested.indexOf(a.mapId)-requested.indexOf(b.mapId));
  }
  if (chosen.length === 0) return null;

  // Each map owns its fingerprint. A ready hot map must not block later queued maps.
  // Generated coordinates/row revisions do not change the semantic structure.
  const contextHashes:Record<string,string>={};
  for(const entry of chosen){
    contextHashes[entry.mapId]=signatureForEntry(entry,derived.routes,derived.maps);
  }
  // An explicit map selection is also the user's request to update/repair its layout.
  chosen=chosen.filter(entry=>Array.isArray(input.layoutMaps)||!hasScene(entry.map)||storedLayoutHash(entry.map)!==contextHashes[entry.mapId]);
  if(!chosen.length)return null;

  const config=normalizeModelBatching(input.generationOptions?.batching);
  const retryLimit=input.layoutBatchMapLimit;
  const work=input.generationOptions?.workBatching;
  const plannedSize=work?workBatchSize(chosen.length,work.mapBatches):Infinity;
  const batchLimit=Math.min(plannedSize,config.mapsPerBatch||Infinity,ATLAS_RUNTIME_LIMITS.operationsPerResponse,
    typeof retryLimit==='number'&&Number.isSafeInteger(retryLimit)&&retryLimit>0?retryLimit:Infinity);
  const outputBudget=Math.max(0,planningOutputTokens(input.generationOptions)-ATLAS_RUNTIME_LIMITS.batchOutputReserveTokens);
  const first=chosen[0],selected:Entry[]=[];
  let estimatedTokens=0,estimatedRefs=0;
  for(const entry of chosen){
    if((!work&&(entry.kind!==first.kind||depth(entry)!==depth(first)))||selected.length>=batchLimit)continue;
    const scene=normalizeFrame(entry.map.frame_json).atlasScene as SqlRow|undefined;
    const savedChars=JSON.stringify(scene?.constraints??{}).length;
    const tokens=Math.max(192+entry.own.length*(entry.kind==='floor'?112:72),Math.ceil(savedChars/2));
    const refs=entry.own.length+1;
    if(selected.length&&(estimatedTokens+tokens>outputBudget||estimatedRefs+refs>ATLAS_RUNTIME_LIMITS.refCatalogMaxEntries))continue;
    selected.push(entry);estimatedTokens+=tokens;estimatedRefs+=refs;
  }
  if(work&&selected.length<plannedSize){
    report?.issues.push({code:'LAYOUT_BATCH_CAPACITY',path:'$.layout',message:'当前计划批次装不下完整目标；请增加地图分批数，或提高连接输出容量。没有额外发送或丢弃目标。',severity:'warning',retryable:true});
    return null;
  }
  const selectedIds=new Set(selected.map(entry=>entry.mapId));
  const remaining=chosen.filter(entry=>!selectedIds.has(entry.mapId)).map(entry=>entry.mapId);

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
    // P08/R05：作者/程序按真实 ID 声明的必要引用（主角、纠偏目标…）与前景目录同一口径，
    // 否则「前景能解析、布局解析不到」会再次变成 alias 漂移。
    requiredRefs: input.requiredRefs,
  });
  const ref = (id: unknown): string | undefined => catalogue.knownRefs.find((item) => item.id === id)?.alias;

  // P08/R05（REF04）：必要引用本身装不下 → 本批布局**一次都不发**，错误明确；
  // 绝不删掉必要端点后继续发送（断头布局等于把地图画错）。
  if (catalogue.requiredBudgetExceeded) {
    report?.issues.push(...catalogue.issues.filter((item) => item.code === 'REF_REQUIRED_BUDGET_EXCEEDED'));
    return null;
  }

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
  const pending = selected;
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
    const savedRequest=frame.atlasLayoutRequest && typeof frame.atlasLayoutRequest==='object' && !Array.isArray(frame.atlasLayoutRequest)?frame.atlasLayoutRequest as SqlRow:null;
    const sceneConstraints=scene?.constraints && typeof scene.constraints==='object' && !Array.isArray(scene.constraints)?scene.constraints as SqlRow:null;
    const requestConstraints=savedRequest?.spec && typeof savedRequest.spec==='object' && !Array.isArray(savedRequest.spec)?savedRequest.spec as SqlRow:null;
    const retainedConstraints=requestConstraints?mergeLayoutConstraints(sceneConstraints,requestConstraints,false).spec:sceneConstraints;
    const baselineRooms = entry.standalone && container
      ? [{
        id: ref(container.id),
        name: container.name,
        w: entry.spaceSize ? entry.spaceSize.resolution.widthM : entry.extent.width,
        h: entry.spaceSize ? entry.spaceSize.resolution.heightM : entry.extent.height,
        side: 'north',
      }]
      : entry.kind==='floor' ? baselineFloorRooms(entry.own,entry.extent,ref,(id)=>{
        const known = locationSpaceSize({ maps: derived.maps, locations: derived.locations, locationId: id, branchId })??derived.entries.find(e=>e.container?.id===id&&e.kind==='floor')?.spaceSize?.resolution;
        return known ? { widthM: known.widthM, heightM: known.heightM } : null;
      }) : [];
    const local = entry.standalone && container ? [container] : container?.kind==='room'?[container,...entry.own]:entry.own;
    const localIds = new Set(local.map((row) => String(row.id)));
    const functionalAreas=entry.kind==='floor'?functionalAreaMembers(container,entry.own,derived.maps):[];
    for(const area of functionalAreas)localIds.add(String(area.id));
    const physicalRoom=(id:unknown)=>functionalAreas.some(area=>area.id===id)?container?.id:id;
    // P12/R03 §19.3：父图轮廓是子空间权威尺寸在**父坐标系**里的投影；这里把已知尺寸随 scope 下发，
    // 但坐标仍由本图自己的布局决定（局部坐标允许不同，物理宽高必须一致）。
    const childSpaces = entry.own
      .filter(row=>!(container?.kind==='room'&&row.kind==='other'))
      .map((row) => {
        const id = asId(row.id);
        if (!id) return null;
        const planned=derived.entries.find(e=>e.container?.id===id&&e.kind==='floor')?.spaceSize?.resolution;
        const known = locationSpaceSize({ maps: derived.maps, locations: derived.locations, locationId: id, branchId })??(planned?{widthM:planned.widthM,heightM:planned.heightM,source:'first-estimate',referenceId:id}:null);
        const holder = derived.maps.find((map) => map.container_location_id === id && map.status === 'active');
        const canonicalRead = holder ? readSpaceCanonical(holder.frame_json, id) : null;
        const canonical = canonicalRead?.ok && !canonicalRead.deferred ? canonicalRead.canonical : null;
        const furnishing = (canonical?.furnishing ?? []).map((item) => ({
          id: item.localId, type: item.type, name: item.name,
          w: item.widthM, h: item.heightM,
          ...(item.itemId ? { item: ref(item.itemId) } : {}),
        }));
        const nested=derived.locations.some(location=>location.parent_location_id===id&&location.status==='active'&&(row.kind!=='room'||location.kind!=='other'));
        return known ? { ref: ref(id), name: row.name, w: known.widthM, h: known.heightM, source: known.source, referenceId: known.referenceId, detailScope:nested?'descendants':'self', furnishing } : null;
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    const drawnParent=container?derived.entries.find(e=>e.mapId===container.map_id):null;
    const parentFrame=drawnParent?normalizeFrame(drawnParent.map.frame_json):null;
    const parentScene=parentFrame?.atlasScene as SqlRow|undefined;
    const parentLayout=parentScene?.layout as SqlRow|undefined;
    const parentShapes=parentLayout?[parentLayout.shapes,parentLayout.districts,parentLayout.rooms,parentLayout.buildings].flatMap(pool=>Array.isArray(pool)?pool:[]):[];
    const parentFootprint=parentShapes.find(shape=>shape.id===container?.id);
    const parentContext=parentFootprint?{
      name:drawnParent!.map.name,units:parentScene?.units??'unknown',
      footprint:{...parentFootprint,id:ref(container!.id)},
      siblings:parentShapes.filter(shape=>shape.id!==container?.id&&ref(shape.id)).slice(0,32).map(shape=>({...shape,id:ref(shape.id)})),
    }:null;
    return {
      map: ref(entry.mapId),
      name: entry.map.name,
      kind: entry.kind,
      functionalAreas:functionalAreas.map(area=>({ref:ref(area.id),name:area.name,roomId:ref(area.parent_location_id)})),
      units: entry.extent.units,
      container: container ? { ref: ref(container.id), kind: container.kind, name: container.name,detail:detailFor(container) } : null,
      /**
       * P13/R03 §20：本图的绘图档案。`kind` 就是由这份档案裁决出来的；`navigationName` 说明
       * 「这一类空间叫什么」；`forbidden` 是这套模板的禁区；`partial` 为真时说明有登记成员
       * 当前生成器表达不了（绝不替换类型凑成功）。
       */
      profile: {
        mode: entry.profile.profile.mode,
        basis: entry.profile.profile.basis,
        navigationName: entry.profile.navigationName,
        forbidden: entry.profile.rule.forbidden,
        responsibility: entry.profile.responsibility,
        partial: entry.profile.partial,
        unsupported: entry.profile.unsupported.map((item) => ({ ref: ref(item.id), kind: item.kind, reason: item.reason })),
      },
      frame: {
        cols: entry.frameCols,
        rows: entry.frameRows,
        metersPerCell: entry.map.meters_per_cell,
        scaleLocked: !!entry.map.scale_locked,
      },
      extent: { width: entry.extent.width, height: entry.extent.height, units: entry.extent.units },
      /** P12/R03 §19.2：本图空间的物理权威（来源 + 质量 + 是否与作者事实冲突）。 */
      spaceSize: entry.spaceSize ? {
        locationId: entry.spaceSize.locationId,
        source: entry.spaceSize.resolution.source,
        referenceId: entry.spaceSize.resolution.basis.referenceId,
        quality: entry.spaceSize.resolution.quality,
        conflict: entry.spaceSize.resolution.conflict,
        widthM: entry.spaceSize.resolution.widthM,
        heightM: entry.spaceSize.resolution.heightM,
        revision: entry.spaceSize.canonical?.revision ?? 0,
        furnishing: Math.min(entry.spaceSize.canonical?.furnishing.length ?? 0, SPACE_CANONICAL_MAX_FURNISHING),
        furnishingInventory: (entry.spaceSize.canonical?.furnishing??[]).slice(0,SPACE_CANONICAL_MAX_FURNISHING).map(item=>({
          id:item.localId,type:item.type,name:item.name,w:item.widthM,h:item.heightM,
          quality:item.quality,
          ...(item.itemId?{item:ref(item.itemId)}:{}),
        })),
        furnishingReview: Object.values((entry.spaceSize.canonical?.furnishing??[]).slice(0,SPACE_CANONICAL_MAX_FURNISHING).reduce<Record<string, string[]>>((groups,item)=>{
          const name=item.name.trim();
          if(name)(groups[name]??=[]).push(item.localId);
          return groups;
        },Object.create(null))).filter(ids=>ids.length>1).map(ids=>({ids,reason:'same-name-review'})),
      } : null,
      /** P12/R03 §19.3：父图要按这些尺寸投影子空间轮廓，不重新独立估计。 */
      childSpaces,
      parentContext,
      hierarchy:{parentMap:ref(parentEntry(entry)?.mapId),depth:depth(entry),sharedSpace:ref(container?.id)},
      verticalSpaces:entry.own.filter(row=>row.kind==='floor').map(row=>({ref:ref(row.id),name:row.name,kind:row.kind})),
      baselineRooms,
      locations: local.map((row) => ({
        ref: ref(row.id),
        name: row.name,
        kind: row.kind,
        description: row.description,
        detail:detailFor(row),
        parent: ref(row.parent_location_id),
        placement: row.map_id === entry.mapId ? 'local' : 'proxy',
      })),
      routes: derived.routes.filter((row) => row.map_id === entry.mapId && row.status !== 'closed' && ref(row.id))
        .map((row) => ({ ref: ref(row.id), from: ref(row.from_location_id), to: ref(row.to_location_id),
          kind: row.kind, status: row.status, bidirectional: canonicalFlag(row.bidirectional) === 1,
          geometryQuality: row.geometry_quality, distanceM: row.distance_m ?? null })),
      actors: characters
        .filter((row) => localIds.has(String(row.location_id ?? '')) && ref(row.id) && ref(row.location_id))
        .sort((a, b) => {
          const priority = (row: SqlRow): number => row.role === 'protagonist' || input.requiredRefs?.some((r) => r.kind === 'character' && r.id === row.id) ? 0 : 1;
          return priority(a) - priority(b) || byId(String(a.id), String(b.id));
        })
        .slice(0, LIMITS.actors)
        .map((row) => ({ ref: ref(row.id), name: row.name, roomId: ref(physicalRoom(row.location_id)) })),
      items: items.filter(row=>localIds.has(String(row.location_id??'')) && !row.holder_character_id && !row.container_item_id && ref(row.id) && ref(row.location_id))
        .slice(0, LIMITS.items)
        .map(row=>({ref:ref(row.id),name:row.name,kind:row.kind,description:row.description,roomId:ref(physicalRoom(row.location_id))})),
      savedConstraints: aliasLayoutRefs(retainedConstraints, catalogue.knownRefs),
      constraintStatus: savedRequest?(savedRequest.status??'pending'):'saved',
      layoutIssues: aliasLayoutRefs([...(Array.isArray(sceneLayout?.issues)?sceneLayout.issues:[]),...(Array.isArray(savedRequest?.issues)?savedRequest.issues:[])], catalogue.knownRefs),
    };
  });
  const pendingIds = pending.map((entry) => entry.mapId);

  // ── 7. 提示词（M4-22） ────────────────────────────────────────────────
  const layoutKinds = [...new Set(scopes.map(scope => scope.kind))].sort();
  const hasFloor = layoutKinds.includes('floor'), hasCity = layoutKinds.includes('city'), hasOverview = layoutKinds.includes('overview');
  const request = buildStagePrompt({
    phase: 'geography',
    allowedOps: ['map.layout.request', 'noop'],
    batchId: `layout_${turnId}`,
    mapScope: JSON.stringify(scopes),
    geoMissing: '必须为以上地图生成或更新可绘制空间布局，每张图一行 map.layout.request。仅有坐标点不算完成。',
    geoSources: '第一步验证的位置依据将在发送布局请求前附加；本阶段不接收原始剧情或世界书。',
    mapLayoutIds: catalogue.knownRefs.map((item) => `${item.alias}=${item.id}`).join('\n'),
    mapLayoutFrame: [
      'extent 是程序给定的幅面；kind 与 units 以每张图给出的值为准，不得改写。',
      'units=cells 表示这张图还没标定，width/height 是格数，不是米；units=meters 时 width/height 才是米。',
      '逐图使用实际 extent、spaceSize 与 childSpaces；不以通用模板的默认大小覆盖它们。',
      '已有尺度时 extent = cols×metersPerCell、rows×metersPerCell；不要自己换算比例尺。',
    ].join('\n'),
    mapLayoutLocks: [
      '保留 savedConstraints 的既有结构与稳定局部 ID；省略字段表示保持，不表示删除。',
      '已确认/锁定的几何与作者确认的事实不得改写。',
      'functionalAreas 是已有房间内的开放功能分区，由程序投影范围；不输出为 rooms，不为其新增墙、门或陈设实体。人物和物品按所列 roomId 放在同一个实际房间内。',
      '资料支持的事实优先于用途估计；估计不升级为作者确认，不为填满画面添加实体或装饰。',
    ].join('\n'),
  });
  if(work)request.messages[1].content+='\n【整组地图规划】本批可同时包含不同种类和多层父子地图；一次返回所有列出地图的约束。hierarchy 标明父图与共享空间。父子共用 childSpaces/spaceSize 尺寸，程序从父到子求解坐标、继承轮廓；不为每层再请求，不输出独立坐标或改变父子归属。';
  request.messages[1].content += '\n每个操作外层只含 op、ref、data 和可选 why。op 固定 map.layout.request；ref 使用本图 map 引用；data 包含给定 kind 和 spec。下面提供本图完整合法 JSON 示例。幅面用程序给定 extent。'
    + (hasOverview?'\noverview 的 spec 可含 surface、zones、links、features。zone 用 id、name、role、size，可选 sector 与 near。role 取 city/settlement/forest/water/mountain/ruins/district/campus/land/other；size 取 small/medium/large；sector 取八方向或 center。link 的 id 必须是已登记路线引用。feature 用局部 id、type、可选 zoneId 和 density；density 取 low/medium/high，type 取 forest_texture/ridge/shore/building_cluster/road_texture/ruins_scatter/watercourse。'
    + 'overview 的 zone 必须是本图直属地点或目录里已有的代理入口；links 只能用目录中已登记的路线引用；feature 只是本图局部装饰，永远不产生新实体、也不产生新道路。':'')
    + (hasCity?'\ncity 的 districts 每项必须含 id、name、bank、order；bank 取 west/east，order 为整数。buildings 每项必须含 id、name、districtId、w、h。districts 至少一项；没有已登记街区时，以城市容器的地点引用作为自身街区。每个建筑的 districtId 必须对应本次或已保存街区，不能省略街区声明。新城市默认 enclosure="open"；无河流依据时 riverWidth=0。':'')
    + (hasFloor?'\nfloor 的 rooms 每项用 id/name/w/h/side，side 只能 north 或 south；可选 role=indoor/outdoor/garden，分别表示室内、开放院落、园林。contents 每项用 id/name/type/roomId/w/h，type 只能 shelf/desk/bench/reading/stairs/table/chair/bed/cabinet/doorway/light/decor；actors 每项用 id/roomId，可选 near=陈设ID；items 每项用 id/on=陈设ID。所有键都必须双引号，不得照抄省略号或伪 JSON。':'')
    + '\n布局阶段不新建 SQL 实体：所有可交互地点必须已经在目录里。但建设阶段允许新增地点，两者不冲突——不要因为布局不新建实体就停止补全世界。actors/items 是本批有目录引用且在生成器额度内的相关者，不是整张人物表；未发送者仍保存在 SQL，由程序维护位置和地点名单，不能创建替身来凑数。'
    + '\n不要输出其他操作。';
  request.messages[1].content += '\n父图中的本地点轮廓是下钻边界；子图用于细化同一个空间，不重画成一座无关的城市。相邻街区维持父图的相对方位，不能把外城区、内城区、中心区都复制成同一幅城市模板。size=large/medium/small 必须维持相对面积顺序；没有实体依据的 road_texture 不输出，真实道路仅使用已登记 links。';
  request.anchor = input.anchor;
  request.messages[1].content+='\n细节责任：detail.tier=important 的已登记地点按角色锚点、明确剧情或来源事实补齐细节；ordinary 使用有限、够用的细节。重要性不改变已有尺寸、作者锁，也不把推测设施的延后内部自动升级为开局必建。';
  request.promptInput = {
    injectionText: request.messages[1].content,
    userText: '',
    assistantText: '',
    loreSupplement: '',
    baseRevision: input.anchor.baseRevision,
  };
  if(hasFloor){
    request.messages[1].content += '\nbaselineRooms 是程序为已登记空间提供的可容纳轮廓，不是实测尺寸；没有更明确尺寸依据时直接沿用，并在每间房补 role。多空间图必须覆盖 locations 中全部直属空间，庭院和花园也应有连通范围，不能退化成散点；室外空间用 outdoor/garden，不伪造室内窗户。不要把 width/height 写成房间尺寸，房间尺寸字段为 w/h，side 固定选 north 或 south。';
    request.messages[1].content += '\n细节要求：按世界观和各空间用途组装陈设，不能只返回 rooms 空轮廓。正文点名的家具优先；没有逐件描写时可补用途合理的示意家具，每个有明确用途的室内空间通常 2–4 件，空置房间或室外空间可不补。卧室可估计床与储物柜，书房可估计书桌与书架，工作空间按资料选择桌台和储物；不得把同一套陈设复制进每间房，不使用示例世界地名或剧情。局部陈设不是新增 SQL 物品，所有坐标与通行由程序计算。';
    for(const scope of scopes.filter(s=>s.kind==='floor')){
      request.messages[1].content+='\n【本图合法 JSON 外层示例；按资料补齐 contents，不照搬为空布局】\n'+JSON.stringify({op:'map.layout.request',ref:scope.map,data:{kind:'floor',spec:{rooms:scope.baselineRooms,actors:scope.actors.map(a=>({id:a.ref,roomId:a.roomId}))}},why:'依据已登记空间生成估计布局'});
    }
    request.messages[1].content += '\n普通阅览桌用 type="table"，椅子单独用 type="chair"；reading 是桌子加四把椅子的整套组合，占地 w/h 均至少 2 米，不能用于 2×1 米的单张桌子。所有陈设用正数 w/h，完整占地必须装进房间。';
    request.messages[1].content += '\nitems[].on 只能绑定本房间中具有支撑面的 table/desk/shelf/cabinet（reading 组合的桌面也可）。不能把物品绑定到 chair/bed/doorway/decor 上，也不能把椅子本身作为物品放在另一把椅子上。资料没有支撑关系时省略该物品绑定，由程序按真实归属放置地面标记，不要猜测它在桌上。';
    request.messages[1].content += '\n空间身份规则：spaceSize.furnishingInventory 和 childSpaces[].furnishing 是同一物理空间已经登记的陈设。必须沿用其中的 id；省略的既有陈设仍会保留，不要换名或换局部 id 再造一套。已有账本的空间中，新增陈设必须明确 additional=true，且确有新增依据；仅换父图/子图或补布局不属于新增。门洞不是地面家具，不要在 contents 里估计 doorway；程序根据房间边界与已有连接生成门，不能把门摆在房间中间。';
    request.messages[1].content += '\n旧图恢复规则：furnishingReview 列出同名陈设候选，必须逐组核查，不能把历史错误重复当作必须保留的物理事实。quality=layout 是布局估计，不是作者确认。有明确数量依据的两把同名椅子应保留；同一厨房操作台或照明曾在父子图分别估计、但没有第二件依据时，保留一个既有 id，并用 spec.deletes.contents 显式删除另一个 id。禁止仅靠同名由程序自动合并，也不允许删作者确认或绑定不同真实物品的两件陈设。why 中说明核查结论；删除使用候选中的完整 id。';
    request.messages[1].content += '\n层级归属规则：childSpaces.detailScope=descendants 表示该轮廓内部还有已登记子空间，本层只画容器轮廓与通路。大厅的长桌和厨房的操作台应由大厅、厨房各自的空间账本管理，不能又给包含它们的楼层轮廓摆一份。若 savedConstraints 曾在楼层轮廓重复摆放这些后代陈设，用 spec.deletes.contents 显式移除该层重复投影；真实归属于楼层公共通道的陈设保持原身份。';
    request.messages[1].content += '\n单间房内 kind=other 的储藏角、桌边等子地点只表示局部区域，不说明存在隔墙。baselineRooms 只有房间自身时，保持整个房间作为一块物理空间，不为这些角落额外分房或扣走廊；只有明确登记的 room 子空间才参与分房。';
    request.messages[1].content += '\n多房间 floor 由程序保留通行空间，默认 corridorWidth=2；已有 door/adjacent/estimated 房间连接由程序安排共墙门，不能用走廊隔开直接连通的两间房；估计房间必须适合当前幅面，side=north 或 south。同侧多个房间的宽度与间隔合计也必须装得下。childSpaces 的已知宽高不得缩小来凑布局；装不下时说明尺寸冲突。单间房直接沿用完整 baselineRooms，不缩成幅面的 75%，不另扣中央走廊。';
  }
  for(const scope of scopes.filter(s=>s.kind==='overview')){
    request.messages[1].content+='\n【本图合法 overview JSON 外层示例；按资料填写合法 zones/links/features】\n'+JSON.stringify({op:'map.layout.request',ref:scope.map,data:{kind:'overview',spec:{surface:'mixed'}},why:'依据已登记空间生成估计布局'});
  }
  for(const scope of scopes.filter(s=>s.kind==='city')){
    if(!scope.container?.ref)continue;
    const registeredDistricts=scope.locations.filter(location=>location.kind==='district');
    const districts=(registeredDistricts.length?registeredDistricts:[scope.container]).map((district,index)=>({id:district.ref,name:district.name,bank:'west',order:index}));
    const buildings=scope.locations.filter(location=>location.kind==='building').map(location=>{
      const size=scope.childSpaces.find(space=>space.ref===location.ref);
      return {id:location.ref,name:location.name,districtId:districts.find(district=>district.id===location.parent)?.id??scope.container!.ref,w:size?.w??24,h:size?.h??24};
    });
    if(buildings.some(building=>building.districtId===scope.container!.ref)&&!districts.some(d=>d.id===scope.container!.ref))districts.push({id:scope.container.ref,name:scope.container.name,bank:'west',order:districts.length});
    request.messages[1].content+='\n【本图合法 city JSON 示例；所有实体引用均已登记】\n'+JSON.stringify({op:'map.layout.request',ref:scope.map,data:{kind:'city',spec:{districts,buildings,enclosure:'open',riverWidth:0,blocksPerDistrict:0}},why:'使用已登记城市范围生成估计布局'});
    request.messages[1].content+='\ncity 的 districts.id 和 buildings.id 必须沿用上方已登记地点引用，不能使用 B1、B2 等自造编号。没有已登记建筑时 buildings=[]；不能为填满画面而新增可交互建筑。';
  }
  if(scopes.some(scope=>scope.verticalSpaces.length))request.messages[1].content+='\nverticalSpaces 是上下楼层入口，由界面的楼层导航展示。不要把它们放进 rooms、zones 或 buildings，也不把整层用门连接到同层走廊。房间只保留已登记的归属；没有楼层依据时不能擅自迁到一楼或二楼。';
  if(scopes.some(scope=>scope.container?.kind==='room'))request.messages[1].content+='\n房间包含已登记子房间时，baselineRooms 只列子房间；程序另外保留容器房间自身的可用地面。厨房的操作台、厨内人物仍用厨房容器的 roomId，不能迁入储物间，也不能因为存在储物间就省略厨房本身的陈设与人物。不要把容器再次塞进 rooms 形成重叠房间。';
  if(hasCity)request.messages[1].content+='\n建筑的 districtId 不能凭相邻或示意排位推断为另一个已登记街区。没有已登记街区归属的建筑使用当前城市容器作为自身分区，不把住所强行归入温室区等任意首个街区。默认 blocksPerDistrict=0，先表达真实地点与道路，不用装饰街块填满地图。';
  if (hasFloor && hasSpatialCapability(CAPABILITY_CORRIDOR_BINDING)) request.messages[1].content += '\n' + CORRIDOR_BINDING_PROMPT;
  if (hasSpatialCapability(CAPABILITY_SPACE_CANONICAL)) request.messages[1].content += '\n' + SPACE_CANONICAL_PROMPT;
  if (hasSpatialCapability(CAPABILITY_SPATIAL_PROFILE)) request.messages[1].content += '\n' + SPATIAL_PROFILE_PROMPT;
  if(hasOverview)request.messages[1].content += '\noverview 的水系 feature 必须为 {"id":"本图局部水系ID","type":"watercourse","zoneId":"本图已登记水域引用（可选）","fromSector":"north","toSector":"south","widthClass":"narrow/medium/wide"}。fromSector/toSector 取 north/northeast/east/southeast/south/southwest/west/northwest 且不同；不要仅写 zoneId/density 而省略起终方向。方向是估计布局，不能标成已测量事实。';
  if(hasFloor)request.messages[1].content += '\n更新布局时，同一实物必须沿用 savedConstraints 的既有局部 id，不得换 id 重复添加。layoutIssues 是旧图未放下的陈设：按正文校正估计尺寸；若旧约束重复描述同一座椅或柜子，保留一个既有 id，用 spec.deletes={"contents":[重复的局部陈设id]} 显式清理重复约束，并同步 actors.near。不要删除已确认的锁定结构。';
  request.messages[1].content += '\nsavedConstraints 同时包含已保存场景及上次失败/待处理请求的有效约束。constraintStatus=failed/pending 时，继续修正这些约束并沿用其中 ID，不能当作从未规划过而再建一套陈设；原约束不会因失败自动清空。layoutIssues 给出上次失败原因。';
  request.messages[1].content += '\n禁止把载具画成固定地块、城市分区或地理轮廓；载具的行程与停靠由引擎单独投影。只绘制本世界资料支持的水系、山脉、城墙；示例地图和通用模板中的地名与地形不能直接搬入另一个世界。未知地理关系保持估计或未知，不编造原文没有的确定地理事实。';
  // P13/R03 §20：把**实际采用的绘图档案**翻译成模型能执行的禁区。档案是"这张图画成什么"的
  // 显式决定，不能只躺在 scope JSON 里让模型自己悟——模板的 forbidden 必须逐条进提示词。
  const profileModes = [...new Set(pending.map((entry) => entry.profile.profile.mode))].sort();
  if (profileModes.length) {
    request.messages[1].content += '\n【本图绘图档案（决定用哪套模板，不是给地点改名）】'
      + profileModes.map((mode) => `${mode}=${PROFILE_PROMPT[mode]}`).join(' ');
  }
  // ── P14/§21.5 任务上下文（程序按模板填充） ─────────────────────────────
  // 目录、范围、允许 kind、单位、锁、待办必须由程序写清楚，且**不许有没填的占位符**——
  // 模板里的花括号是要被真实数据替换的，不是给模型的字段名。模型不选程序预算、也不宣布 ACK 成功。
  request.messages[1].content += '\n【本批任务上下文（程序填写，不是可选项）】\n' + formatTaskContext({
    phase: 'geography',
    chatUid: input.anchor.chatUid,
    branchId,
    revision: input.anchor.baseRevision,
    storageRevision: input.anchor.baseStorageRevision,
    catalogueHash: catalogue.catalogueHash,
    requiredCatalogue: [
      ...scopes.map((scope, index) => `${scope.map}=${String(scope.name ?? '')}(${scope.kind} ${scope.extent.width}×${scope.extent.height}${scope.units}${pending[index].map.scale_locked ? ' 比例尺已锁定' : ''})`),
      ...(input.requiredRefs ?? []).map((item) => `${ref(item.id) ?? item.id}=必要引用(${item.kind})`),
    ],
    allowedOpsAndKinds: `map.layout.request、noop；本批地图 kind 只能是 ${layoutKinds.join('/')}（以每张图给定值为准，不得改写）`,
    extents: scopes.map((scope) => {
      const mpp = scope.frame.metersPerCell;
      const units = typeof mpp === 'number' && mpp > 0 ? `1 格 = ${mpp} 米`
        : scope.units === 'cells' ? '未标定；宽高及坐标以格为单位，不换算成米'
          : '首次估计的物理幅面；比例尺由程序保存，不自行假定一格一米';
      return `${scope.map}: ${scope.extent.width}×${scope.extent.height} ${scope.units}（框格 ${scope.frame.cols}×${scope.frame.rows}，${scope.frame.scaleLocked ? '比例尺已锁定' : '比例尺未锁定'}；${units}）`;
    }).join('；'),
    locks: [
      `比例尺锁定图：${pending.filter((entry) => entry.map.scale_locked).map((entry) => ref(entry.mapId)).filter(Boolean).join('、') || '（无）'}`,
      'savedConstraints 的既有结构与稳定局部 ID 逐图保留，省略字段=保持、删除只能写 spec.deletes',
      '作者确认事实与已确认/锁定几何不得改写',
    ].join('；'),
    selectedTargetIds: scopes.map((scope) => String(scope.map)),
    sourceBlocks: [],
    deferredSummary: `冻结目录未发送 ${catalogue.remainingIds.length} 项；本批只处理上面列出的目标，未发送内容不计入本批，也不要声称为它们做过处理`,
    priorBindings: [
      ...scopes.filter((scope) => scope.spaceSize).map((scope) => `space:${scope.spaceSize!.locationId}=${scope.spaceSize!.widthM}×${scope.spaceSize!.heightM}m`),
      ...scopes.flatMap((scope) => (scope.childSpaces ?? []).map((child) => `childSpace:${child.ref ?? child.referenceId}=${child.w}×${child.h}m`)),
    ],
  });
  if(hasOverview)request.messages[1].content += '\noverview 的 surface 只能为 mixed/urban/forest/mountain/water/indoor/void；砂石、泥土、草地等具体材料可在 why 中说明，不得用 gravel/dirt/grass 作为 surface 枚举。未知或混合场地用 mixed。';
  request.messages[1].content += '\n【提交前核对，不输出核对过程】逐一覆盖本批每张 map，且每图只提交一行 map.layout.request；kind 与引用逐图匹配，不能串用另一张图的局部陈设。初次生成补齐已登记空间；更新只补缺项或修正 layoutIssues，保留其它约束。示例只展示合法字段，不是空布局答案。尺寸冲突时保留确认值并在 why 说明，不能缩小已确认空间或删除锁定结构来凑成功。程序判定实际可绘制结果，模型不要声称校验已经通过。不得因正文未变化只返回 noop，不输出解释正文。';
  // 兼容预设的注入副本必须与最终任务一致（预览与真实发送不能两套）。
  request.diagnosticTargets = pendingIds;
  request.batchTargets={kind:'maps',count:selected.length,estimatedOutputTokens:estimatedTokens};
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
    contextHashes,
    focusLocationIds: uniqueSorted(focusLocations),
    remainingLocationIds: remaining,
    parentMapIds:Object.fromEntries(chosen.map(entry=>[entry.mapId,parentEntry(entry)?.mapId??null])),
    mapIds: pendingIds,
    kinds: Object.fromEntries(pending.map((entry) => [entry.mapId, entry.kind])),
    extents: Object.fromEntries(pending.map((entry) => [entry.mapId, { ...entry.extent }])),
    baselineRooms: Object.fromEntries(
      pending.map((entry, index) => [entry.mapId, (scopes[index]?.baselineRooms ?? []) as Array<Record<string, unknown>>]),
    ),
  };
}
