/**
 * atlas-layout-signature.ts — P05 / N05：每张图的「布局输入指纹」。
 *
 * 目的：判断「这张图的**结构输入**有没有变」，而不是「这一批请求的参数有没有变」。
 * 旧实现（layout-v2）只哈希成员描述 + 幅面，于是：
 * - 路线新增/封路/改端点不会让负责该图失效（地图上少了或多了路也不重画）；
 * - 各图共用一个批次指纹，A 图改路线会把 B 图也拖下水；
 * - 与成员描述无关的变化（作者改档案、改尺寸账本）完全看不见。
 *
 * 本模块是**纯函数**：不改库、不发请求、不读时钟。调用方负责取行、排序由本模块保证。
 *
 * 计入（每图固定清单，字段顺序写死，不依赖 SQL 行序 / Object.keys / localeCompare）：
 * - mapId、布局种类、明确绘图档案、单位、有效幅面；
 * - 该图负责展示的地点：身份、名称、类型、父/锚点关系与布局相关语义；
 * - 按 P04 归属规则选出的路线（`map_id === mapId`）：ID、两端、归属、责任状态、双向、类型、
 *   几何、几何质量、几何修订；
 * - 权威结构锁（scale_locked）、作者修改的布局意图、尺寸账本修订（calibration_rev）、
 *   程序布局策略版本。
 *
 * 明确排除（写进输入就会造成「自己写自己 → 无限重画」或「人物走动就重画」）：
 * - 人物普通移动、临时 item 位置、无关地图与无关 lore；
 * - row_rev 整体、completedTurnId、时钟、请求耗时、进度 / receipt / journal；
 * - 本轮生成器自动回写的**估计**地点坐标与轮廓（`coord_precision === 'layout'`、
 *   面积 `quality !== 'confirmed'`）；
 * - 保存的 `scene.layout` 整体（不用它「补齐所有信息」）。
 */

import { stableHexHash } from './atlas-hash.ts';

/**
 * 程序布局策略版本。改动布局算法语义（而不是改数据）时递增，
 * 让所有已保存的指纹一次性失效、重排一次，而不是永久卡在旧结果上。
 */
export const LAYOUT_SIGNATURE_POLICY_VERSION = 'layout-v10';

/** 该图负责展示的地点（容器地点 + 本图成员）。 */
export type LayoutSignatureMember = {
  id: string;
  name: string | null;
  kind: string | null;
  parent: string | null;
  anchor: string | null;
  description: string | null;
  mobility: string | null;
};

/**
 * 作者修改的布局意图：只收「非生成器回写」的落位——
 * `coord_precision` 为 exact/approximate 的手工坐标与已确认面积。
 * `coord_precision === 'layout'` 的行是本轮生成器的产物，一律不进指纹。
 */
export type LayoutSignatureAuthorIntent = {
  id: string;
  precision: string;
  gridX: number | null;
  gridY: number | null;
  uncertainty: number | null;
  /** 已作者确认的面积（canonical [[x,y],…]）；无则 null。 */
  area: readonly (readonly number[])[] | null;
  dimensions?: {widthM:number;heightM:number}|null;
};

/** 按 P04 归属规则选出的路线。 */
export type LayoutSignatureRoute = {
  id: string;
  from: string | null;
  to: string | null;
  mapId: string | null;
  status: string | null;
  bidirectional: number | null;
  kind: string | null;
  geometry: string | null;
  geometryQuality: string | null;
  geometryRev: number | null;
};

export type LayoutSignatureInput = {
  mapId: string;
  layoutKind: string;
  profile: string | null;
  units: 'meters' | 'cells';
  extent: { width: number; height: number };
  members: readonly LayoutSignatureMember[];
  authorIntent: readonly LayoutSignatureAuthorIntent[];
  routes: readonly LayoutSignatureRoute[];
  structureLocked: boolean;
  sizeLedgerRev: number | null;
  spaceLedger?: readonly {locationId:string;revision:number|null;widthM:number|null;heightM:number|null}[];
  /** 覆盖策略版本（测试用）；生产不传，走 LAYOUT_SIGNATURE_POLICY_VERSION。 */
  policyVersion?: string;
};

const byId = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function computeLayoutInputSignature(input: LayoutSignatureInput): string {
  const policy = input.policyVersion ?? LAYOUT_SIGNATURE_POLICY_VERSION;

  // 数组按 ID 稳定排序；每项都是定长「位置数组」，不靠键顺序。
  const members = [...input.members]
    .sort((a, b) => byId(a.id, b.id))
    .map((m) => [m.id, str(m.name), str(m.kind), str(m.parent), str(m.anchor), str(m.description), str(m.mobility)]);

  const authorIntent = [...input.authorIntent]
    .sort((a, b) => byId(a.id, b.id))
    .map((a) => [a.id, str(a.precision), num(a.gridX), num(a.gridY), num(a.uncertainty), a.area ?? null, a.dimensions ? [a.dimensions.widthM,a.dimensions.heightM] : null]);

  const routes = [...input.routes]
    .sort((a, b) => byId(a.id, b.id))
    .map((r) => [
      r.id,
      str(r.from),
      str(r.to),
      str(r.mapId),
      str(r.status),
      num(r.bidirectional),
      str(r.kind),
      str(r.geometry),
      str(r.geometryQuality),
      num(r.geometryRev),
    ]);

  const payload = [
    policy,
    input.mapId,
    input.layoutKind,
    str(input.profile),
    input.units,
    num(input.extent?.width),
    num(input.extent?.height),
    input.structureLocked ? 1 : 0,
    num(input.sizeLedgerRev),
    members,
    authorIntent,
    routes,
    [...(input.spaceLedger??[])].sort((a,b)=>byId(a.locationId,b.locationId)).map(s=>[s.locationId,num(s.revision),num(s.widthM),num(s.heightM)]),
  ];

  return stableHexHash(JSON.stringify(payload));
}

/**
 * `geometry_json` → canonical 字符串。
 *
 * 读端口会把 JSON 列解码成对象（不是原始 TEXT），所以这里统一「解析 → 只取
 * kind + 数值化点列 → 定长 JSON」，既不受键顺序影响，也不会把 null/坏点算成不同值。
 * 无法解析时返回原字符串（至少不丢变化），空值返回 null。
 */
export function canonicalRouteGeometry(value: unknown): string | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (!value) return null;
    try {
      parsed = JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (parsed === null || parsed === undefined) return null;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const kind = typeof record.kind === 'string' ? record.kind : null;
  const coordinates = Array.isArray(record.coordinates) ? record.coordinates : Array.isArray(record.points) ? record.points : [];
  const points: Array<number[]> = [];
  for (const point of coordinates) {
    const x = Array.isArray(point) ? Number(point[0]) : Number((point as Record<string, unknown>)?.x);
    const y = Array.isArray(point) ? Number(point[1]) : Number((point as Record<string, unknown>)?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    points.push([x, y]);
  }
  return JSON.stringify([kind, points]);
}

/** 布尔列（bidirectional）在读端口已是 true/false，统一成 0/1，未知 → null。 */
export function canonicalFlag(value: unknown): number | null {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  return null;
}

/**
 * `area_geometry_json` → canonical 点列；只有**作者确认**的面积才参与指纹。
 * 未确认 / 生成器回写的轮廓返回 null（它由本轮布局自己产生，不能反过来让自己失效）。
 */
export function canonicalAuthoredArea(value: unknown): readonly (readonly number[])[] | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.quality !== 'confirmed') return null;
  const points = record.points;
  if (!Array.isArray(points)) return null;
  const out: Array<readonly number[]> = [];
  for (const point of points) {
    const x = Array.isArray(point) ? Number(point[0]) : Number((point as Record<string, unknown>)?.x);
    const y = Array.isArray(point) ? Number(point[1]) : Number((point as Record<string, unknown>)?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push([x, y]);
  }
  return out;
}
