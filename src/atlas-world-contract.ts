/**
 * atlas-world-contract.ts — 世界建设 / 地图拓扑 / 事件流的共享类型权威（M1-10）。
 *
 * 来源：ATLAS 世界建设施工包 contracts/atlas-world-plan-contract.ts。
 *
 * 规则：
 * - 只放类型与必要的字面量常量，不放示例数据、不放实现、不放测试夹具。
 * - 已经有权威的类型一律 import，不另造第二份（Issue / KnownRef / Phase / AtlasLocationKind）。
 * - 不 import 任何 Node 专有对象（不使用 Buffer），保证浏览器与 Worker 可直接引用。
 * - `PlanIssue` 与模型操作层的 `Issue` 字段不同（前者要带 locationId/mapId 等定位信息），
 *   两者各司其职，不做强行合并。
 */

import type { Issue, Phase } from './atlas-ops-contract.ts';
import type { KnownRef } from './atlas-sql-refs.ts';
import type { AtlasLocationKind } from './atlas-location-kinds.ts';

export type ViewMode = 'author' | 'pov';
export type Point = { x: number; y: number };
export type Extent = { x: number; y: number; w: number; h: number };
/** 与 atlas-location-kinds.ts 同一权威（含 floor）；此处只提供契约层的名字。 */
export type LocationKind = AtlasLocationKind;
export type ModelPhase = Phase;

/** 拓扑/生成层的诊断项：比模型操作层的 Issue 多带实体定位字段。 */
export type PlanIssue = {
  code: string;
  path: string;
  message: string;
  severity: 'warning' | 'error';
  retryable: boolean;
  locationId?: string;
  mapId?: string;
  relatedIds?: string[];
  operationId?: string;
};

/** 通用错误类型别名，便于与既有权威互操作。 */
export type WorldIssue = Issue | PlanIssue;

// ─────────────────────────── 地图拓扑（02 §3） ───────────────────────────

export const CONNECTION_QUALITIES = ['contained', 'anchored', 'root', 'unclassified', 'invalid'] as const;
export type ConnectionQuality = (typeof CONNECTION_QUALITIES)[number];

export type TopologyMap = {
  id: string;
  branchId: string;
  containerLocationId: string | null;
  status: string;
};

export type TopologyLocation = {
  id: string;
  branchId: string;
  kind: LocationKind;
  parentLocationId: string | null;
  anchorLocationId: string | null;
  mobility: 'fixed' | 'mobile';
  mapId: string | null;
  status: string;
};

export type MapTopology = {
  nodes: Array<{
    mapId: string;
    containerLocationId: string | null;
    parentMapId: string | null;
    connectionQuality: ConnectionQuality;
  }>;
  rootMapIds: string[];
  unlinkedMapIds: string[];
  issues: PlanIssue[];
};

export type TopologyInput = {
  branchId: string;
  rootMapId: string | null;
  maps: TopologyMap[];
  locations: TopologyLocation[];
  maxDepth: number;
};

// ───────────────────────── 世界建设与填充状态（01 §4） ─────────────────────────

export const WORLD_COMPLETION_MODES = ['bootstrap', 'local'] as const;
export type WorldCompletionMode = (typeof WORLD_COMPLETION_MODES)[number];

export const WORLD_FILL_STATUSES = ['ready', 'partial', 'deferred'] as const;
export type WorldFillStatus = (typeof WORLD_FILL_STATUSES)[number];

export type CompletionPolicy = {
  version: 1;
  density: 'balanced';
  maxNewLocations: number;
  maxNewRoutes: number;
  maxAdditionalDepth: 2;
};

export type WorldCompletionInput = {
  mode: WorldCompletionMode;
  focusLocationIds: string[];
  policy: CompletionPolicy;
};

export type WorldFillState = {
  version: 1;
  policyVersion: 1;
  contextHash: string;
  status: WorldFillStatus;
  completedTurnId: string | null;
  createdLocationIds: string[];
  createdRouteIds: string[];
  remainingLocationIds: string[];
  reasonCode: string | null;
};

// ───────────────────────────── 定向引用目录（M3） ─────────────────────────────

export type TaskRefInput = {
  branchId: string;
  focusMapIds: string[];
  focusLocationIds: string[];
  includeAncestors: boolean;
  includeDirectChildren: boolean;
  includeRoutes: boolean;
  includeOccupants: boolean;
  maxEntries: number;
};

export type TaskCatalogue = {
  knownRefs: readonly KnownRef[];
  rows: Record<string, Record<string, unknown>[]>;
  remainingIds: string[];
  issues: PlanIssue[];
  catalogueHash: string;
};

/** 统一的模型预算记账（M3-03 / M3-03A）；limit 固定 4，含真实传输发送。 */
export type GenerationBudget = {
  limit: 4;
  used: number;
  reservedBackground: 0 | 1;
  attempts: Array<{ stage: string; batchId: string; status: 'requested' | 'completed' | 'failed' }>;
};

// ───────────────────────── 概览 / 布局场景（02 §6） ─────────────────────────

export const LAYOUT_KINDS = ['overview', 'city', 'floor'] as const;
export type LayoutKind = (typeof LAYOUT_KINDS)[number];

export const OVERVIEW_SECTORS = [
  'north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'center',
] as const;
export type Sector = (typeof OVERVIEW_SECTORS)[number];

export type OverviewSpec = {
  width: number;
  height: number;
  surface?: 'mixed' | 'urban' | 'forest' | 'mountain' | 'water' | 'indoor' | 'void';
  zones?: Array<{
    id: string;
    name?: string;
    role: 'city' | 'settlement' | 'forest' | 'water' | 'mountain' | 'ruins' | 'district' | 'campus' | 'land' | 'other';
    size?: 'small' | 'medium' | 'large';
    sector?: Sector;
    near?: string;
    quality?: 'estimated';
  }>;
  links?: Array<{ id: string }>;
  features?: Array<{
    id: string;
    type: 'forest_texture' | 'ridge' | 'shore' | 'building_cluster' | 'road_texture' | 'ruins_scatter' | 'watercourse';
    zoneId?: string;
    density?: 'low' | 'medium' | 'high';
    fromSector?: Exclude<Sector, 'center'>;
    toSector?: Exclude<Sector, 'center'>;
    widthClass?: 'narrow' | 'medium' | 'wide';
  }>;
  deletes?: { zones?: string[]; links?: string[]; features?: string[] };
  rebuild?: boolean;
};

export type OverviewLayout = {
  id: string;
  name: string;
  kind: 'overview';
  bounds: Extent;
  surface: NonNullable<OverviewSpec['surface']>;
  pins: Array<Point & {
    id: string; entityId: string; name: string; type: 'location'; quality: string;
    placementKind?: 'physical' | 'layout' | 'proxy';
  }>;
  shapes: Array<{
    id: string; name: string; role: string; polygon: Point[]; quality: string;
    placementKind?: 'physical' | 'layout' | 'proxy';
  }>;
  routes: Array<{
    id: string; path: Point[]; quality: string; dashed: boolean;
    fromLocationId: string; toLocationId: string;
  }>;
  features: Array<{
    id: string; type: string; zoneId: string | null; density: string;
    polygon?: Point[]; path?: Point[]; points?: Point[]; width?: number; decorative: true;
  }>;
  issues: Array<{ code: string; id?: string }>;
};

export type SceneDocument = {
  kind: 'atlas-scene';
  version: 1;
  generator: string;
  mapId: string;
  branchId: string;
  sourceRevision: number;
  units: 'meters' | 'cells';
  metersPerCell: number | null;
  metricQuality: 'uncalibrated' | 'estimated' | 'confirmed';
  inputSignature: string;
  layout: OverviewLayout | Record<string, unknown>;
  constraints?: Record<string, unknown>;
};

export type GenerationTask<Request> = {
  request: Request;
  catalogue: TaskCatalogue;
  guard: { chatUid: string; branchId: string; baseRevision: number; baseStorageRevision: number };
  contextHash: string;
  focusLocationIds: string[];
  remainingLocationIds: string[];
};

export type LayoutTask<Request> = GenerationTask<Request> & {
  mapIds: string[];
  kinds: Record<string, LayoutKind>;
  extents: Record<string, { width: number; height: number; units: 'meters' | 'cells' }>;
  baselineRooms: Record<string, Array<Record<string, unknown>>>;
};

// ───────────────────────── 故事事件流（02 §7） ─────────────────────────

export const WORLD_FEED_CATEGORIES = ['event', 'message', 'journey', 'item', 'action', 'discovery'] as const;
export type WorldFeedCategory = (typeof WORLD_FEED_CATEGORIES)[number];

export const FEED_ENTITY_KINDS = ['location', 'character', 'item', 'event', 'information', 'journey', 'action'] as const;
export type FeedEntityKind = (typeof FEED_ENTITY_KINDS)[number];

export type WorldFeedItem = {
  id: string;
  category: WorldFeedCategory;
  title: string;
  summary: string;
  occurredAtS: number;
  timeLabel: string;
  turnId: string;
  turnOrdinal: number;
  committedRevision: number;
  locationId: string | null;
  mapId: string | null;
  target: { kind: FeedEntityKind; id: string } | null;
  links: Array<{ kind: FeedEntityKind; id: string; label: string }>;
  visibility: 'known' | 'background';
  sourceKind: 'story' | 'simulation' | 'delivery' | 'derived';
  factQuality: 'confirmed' | 'inferred' | 'reported';
  trace: { turnId: string; groupIds: string[]; operationIds: string[] };
};

export type FeedFilter = {
  category?: WorldFeedCategory;
  mapId?: string;
  entityId?: string;
  currentTurnOnly?: boolean;
};

export type FeedCursor = {
  version: 1;
  branchId: string;
  revision: number;
  viewMode: ViewMode;
  povId: string | null;
  filterHash: string;
  after: { occurredAtS: number; committedRevision: number; id: string } | null;
  scanAfterTurnId: string | null;
};

export type FeedMetadata = {
  latestNarrativeTurnId: string | null;
  latestNarrativeOrdinal: number;
  scanCursor?: string;
  hasMoreVisible: boolean;
};

/** 单个回合在单行上的净变化快照（由 journal 合并得到，M5-01）。 */
export type JournalSnapshot = {
  turnId: string;
  table: string;
  rowId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  operationIds: string[];
  groupIds: string[];
};
