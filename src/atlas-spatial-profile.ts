/**
 * atlas-spatial-profile.ts — P13/R03 §20：室外 / 沿线 / 复合场所档案。
 *
 * 这份文件回答一个问题：**这张图到底该画成什么**。它不新增 SQL 地点 kind，也不新增布局 kind
 * （首版仍然只有 overview / city / floor）——档案只是「用哪套绘制模板」的显式决定，
 * 不改变地点的 kind、事实质量，也不改变它在世界里的用途。
 *
 * 纪律（逐条对应 §20）：
 * - **来源必须明确**：作者的显式选择（frame 里的 `atlasSpatialProfile`）> 程序可信的已有类型/关系
 *   推导（如已绑定主走廊 → circulation）> 类型默认（container.kind）> 中性兜底。
 *   没有任何一条来自"名字像驿站/庭院"的字符串猜测。
 * - **档案 → 布局 kind / 导航名 / 指纹责任 / 期望成员用同一个 resolver**，不各写一份。
 * - 缺资料时是 `unknown`，声称的是"中性概览"，**不**假装已确认用途/尺寸/地形。
 * - 部分成员不受当前生成器支持时，说明 unsupported / partial，**不替换实体类型凑成功**。
 *
 * 本模块是纯函数集合：不读库、不写库、不发请求。
 */

import type { PlanIssue } from './atlas-world-contract.ts';
import { normalizeFrame } from './atlas-spatial-frame.ts';

/**
 * frame 里保存绘图档案的命名空间。
 * 宿主专用：kit 不读它，公开 frame 白名单本来也不含它（P13 不需要改 kit）。
 */
export const SPATIAL_PROFILE_FRAME_KEY = 'atlasSpatialProfile';
export const SPATIAL_PROFILE_VERSION = 1;

export const SPATIAL_PROFILE_MODES = Object.freeze(['interior', 'circulation', 'outdoor', 'linear', 'compound', 'unknown'] as const);
export const SPATIAL_PROFILE_BASES = Object.freeze(['typed-default', 'author', 'source-supported', 'neutral'] as const);

export type SpatialProfileMode = (typeof SPATIAL_PROFILE_MODES)[number];
export type SpatialProfileBasis = (typeof SPATIAL_PROFILE_BASES)[number];

export type SpatialProfileV1 = {
  version: 1;
  mode: SpatialProfileMode;
  basis: SpatialProfileBasis;
};

/** 首版仍然只有这三种布局 kind：档案只能在这三者里选一个。 */
export type ProfileLayoutKind = 'floor' | 'city' | 'overview';

type Row = Record<string, unknown>;

const PLAIN = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const TEXT = (value: unknown): string => (typeof value === 'string' && value.length > 0 ? value : '');
const asId = (value: unknown): string | null => TEXT(value) || null;

const isMode = (value: unknown): value is SpatialProfileMode =>
  typeof value === 'string' && (SPATIAL_PROFILE_MODES as readonly string[]).includes(value);
const isBasis = (value: unknown): value is SpatialProfileBasis =>
  typeof value === 'string' && (SPATIAL_PROFILE_BASES as readonly string[]).includes(value);

function issue(
  code: string,
  path: string,
  message: string,
  severity: 'warning' | 'error' = 'warning',
  extra: Partial<PlanIssue> = {},
): PlanIssue {
  return { code, path, message, severity, retryable: false, ...extra };
}

/* ───────────────────────── 档案的定义面 ───────────────────────── */

export type SpatialProfileRule = {
  /** 这张图用哪个布局 kind 生成。 */
  layoutKind: ProfileLayoutKind;
  /** 导航/资料卡上显示的中文名：说明"这是哪一类空间"，不是给地点改名。 */
  navigationName: string;
  /** 这套模板**不画**的东西（生成器层面的禁区）。 */
  forbidden: readonly string[];
  /** 这套模板**负责**的成员职责：布局任务据此声明 unsupported/partial。 */
  responsibility: readonly ('rooms' | 'corridor' | 'footprints' | 'routes' | 'entrances' | 'surface')[];
};

/**
 * §20 表格的机器可读版本。一个 resolver 驱动：布局 kind、导航名、指纹责任、期望成员。
 */
const RULES: Record<SpatialProfileMode, SpatialProfileRule> = {
  interior: {
    layoutKind: 'floor',
    navigationName: '室内',
    forbidden: ['把明确室外的成员硬塞进普通 rooms'],
    responsibility: ['rooms', 'corridor'],
  },
  circulation: {
    layoutKind: 'floor',
    navigationName: '通行空间',
    forbidden: ['普通室内房间重复出现在通行空间里'],
    responsibility: ['corridor', 'rooms'],
  },
  outdoor: {
    layoutKind: 'overview',
    navigationName: '室外场地',
    forbidden: ['室内窗户', '匿名房间'],
    responsibility: ['surface', 'footprints', 'entrances'],
  },
  linear: {
    layoutKind: 'overview',
    navigationName: '沿线',
    forbidden: ['把道路路线当作纯装饰纹理线'],
    responsibility: ['routes', 'footprints'],
  },
  compound: {
    layoutKind: 'overview',
    navigationName: '复合场所',
    forbidden: ['把整座场所做成"两排室内房间"'],
    responsibility: ['footprints', 'entrances', 'surface'],
  },
  unknown: {
    layoutKind: 'overview',
    navigationName: '待确认场所',
    forbidden: ['声称已确认的用途', '声称已确认的尺寸', '声称已确认的地形'],
    responsibility: ['surface'],
  },
};

export const spatialProfileRule = (mode: SpatialProfileMode): SpatialProfileRule => RULES[mode];
export const profileLayoutKind = (mode: SpatialProfileMode): ProfileLayoutKind => RULES[mode].layoutKind;

/* ───────────────────────── 读写 ───────────────────────── */

export type SpatialProfileRead = {
  ok: boolean;
  profile: SpatialProfileV1 | null;
  issues: PlanIssue[];
};

/** 读 frame 里的档案；版本不支持 / 模式非法一律**不采用**（返回 null），不猜。 */
export function readSpatialProfile(frame: unknown): SpatialProfileRead {
  const path = `$.frame_json.${SPATIAL_PROFILE_FRAME_KEY}`;
  let raw: unknown;
  try {
    raw = PLAIN(frame) ? (frame as Row)[SPATIAL_PROFILE_FRAME_KEY] : undefined;
  } catch {
    return { ok: false, profile: null, issues: [issue('SPATIAL_PROFILE_UNREADABLE', path, '地图框架无法读取，本轮不采用任何档案', 'error')] };
  }
  if (raw === undefined || raw === null) return { ok: true, profile: null, issues: [] };
  if (!PLAIN(raw)) return { ok: false, profile: null, issues: [issue('SPATIAL_PROFILE_INVALID', path, '档案记录不是对象，本轮不采用')] };
  if (raw.version !== SPATIAL_PROFILE_VERSION) {
    return { ok: false, profile: null, issues: [issue('SPATIAL_PROFILE_VERSION_UNSUPPORTED', path, `档案版本 ${String(raw.version)} 不受支持（本版只认 ${SPATIAL_PROFILE_VERSION}），本轮不采用`)] };
  }
  const mode = raw.mode;
  if (!isMode(mode)) {
    return { ok: false, profile: null, issues: [issue('SPATIAL_PROFILE_MODE_INVALID', path, `档案模式 ${String(mode)} 不在合法枚举内，本轮不采用（不按名字猜）`)] };
  }
  const basis = isBasis(raw.basis) ? raw.basis : 'author';
  return { ok: true, profile: { version: 1, mode, basis }, issues: [] };
}

export type SpatialProfileWrite = {
  ok: boolean;
  frame: Row;
  issues: PlanIssue[];
};

/** 写档案（返回新对象，不改入参）。模式非法 / 版本非法 → 拒绝且 frame 原样返回。 */
export function writeSpatialProfile(frame: unknown, profile: SpatialProfileV1): SpatialProfileWrite {
  const source = normalizeFrame(frame);
  const path = `$.frame_json.${SPATIAL_PROFILE_FRAME_KEY}`;
  if (!isMode(profile?.mode) || !isBasis(profile?.basis)) {
    return { ok: false, frame: source, issues: [issue('SPATIAL_PROFILE_INVALID', path, '待写入的档案不合法：模式与依据都必须在合法枚举内', 'error')] };
  }
  if (profile.version !== SPATIAL_PROFILE_VERSION) {
    return { ok: false, frame: source, issues: [issue('SPATIAL_PROFILE_VERSION_UNSUPPORTED', path, `只写版本 ${SPATIAL_PROFILE_VERSION} 的档案`, 'error')] };
  }
  return { ok: true, frame: { ...source, [SPATIAL_PROFILE_FRAME_KEY]: { version: 1, mode: profile.mode, basis: profile.basis } }, issues: [] };
}

/* ───────────────────────── 唯一 resolver ───────────────────────── */

/** 容器类型 → 类型默认档案（没有作者选择、也没有可信关系推导时用）。 */
const TYPED_DEFAULT: Record<string, SpatialProfileMode> = {
  // 有内部的容器 → 室内。
  building: 'interior',
  floor: 'interior',
  room: 'interior',
  vehicle: 'interior',
  // 没有内部的容器 → 待确认的室外场地（P06 的中性概览）。
  region: 'unknown',
  natural: 'unknown',
  other: 'unknown',
  city: 'unknown',
  district: 'unknown',
};

/** 有专属布局 kind 的容器类型（只在**类型默认**这条路上生效）。 */
const DEDICATED_KIND: Record<string, ProfileLayoutKind | undefined> = {
  city: 'city',
  district: 'city',
};

export type SpatialProfileResolution = {
  /** 真正采用的档案。 */
  profile: SpatialProfileV1;
  rule: SpatialProfileRule;
  /** 档案 → 布局 kind 的裁决。 */
  layoutKind: ProfileLayoutKind;
  /** 导航名（"这一类空间叫什么"，不是给地点改名）。 */
  navigationName: string;
  /** 指纹责任：这些成员变了才需要重排。 */
  responsibility: readonly ('rooms' | 'corridor' | 'footprints' | 'routes' | 'entrances' | 'surface')[];
  /** 本图登记的成员里，当前档案**不支持**表达的那些（不替换类型凑成功）。 */
  unsupported: { id: string; kind: string; reason: string }[];
  partial: boolean;
  sources: { mode: SpatialProfileMode; basis: SpatialProfileBasis; reason: string }[];
  issues: PlanIssue[];
};

export type SpatialProfileInput = {
  map: Row;
  container: Row | null;
  /** 本图已绑定的命名走廊地点（P11 的 corridor-binding）。 */
  corridorEntityId?: string | null;
  /** 本图负责的地点行（成员）：用于判定 unsupported/partial。 */
  members?: Row[];
  /** 本图已登记的路线行（成员）。 */
  routes?: Row[];
};

/**
 * `resolveSpatialProfile`：§20 的唯一档案裁决点。
 *
 * 顺序：作者显式选择 → 可信关系推导（已绑定走廊 → circulation）→ 类型默认 → 中性 unknown。
 * 名称**从不**参与判断。
 */
export function resolveSpatialProfile(input: SpatialProfileInput): SpatialProfileResolution {
  const issues: PlanIssue[] = [];
  const path = `$.maps.${asId(input.map?.id) ?? '?'}.profile`;
  const containerKind = TEXT(input.container?.kind);
  const sources: SpatialProfileResolution['sources'] = [];

  const stored = readSpatialProfile(input.map?.frame_json);
  issues.push(...stored.issues);
  if (stored.profile) {
    sources.push({ mode: stored.profile.mode, basis: stored.profile.basis, reason: stored.profile.basis === 'author' ? '作者显式选择' : '已保存档案' });
  }

  let chosen: { mode: SpatialProfileMode; basis: SpatialProfileBasis; reason: string } | null = null;
  // 走廊来源：显式入参优先；没给就**自己从这张图的 frame 里读**——可信关系必须由 resolver 自己
  // 掌握，不能靠每个调用方记得传（少传一次就会静默退回类型默认）。
  const corridorEntityId = TEXT(input.corridorEntityId) || boundCorridorIdOf(input.map) || '';
  if (stored.profile && stored.profile.basis === 'author') {
    chosen = { mode: stored.profile.mode, basis: 'author', reason: '作者显式选择档案' };
  } else if (corridorEntityId) {
    // 可信关系推导：本图绑定了一条真实的命名走廊 → 通行空间。这条比类型默认更可信，
    // 但它仍然**不覆盖**作者的显式选择（上一分支已经拦下了 author）。
    chosen = { mode: 'circulation', basis: 'source-supported', reason: `本图已绑定真实走廊 ${corridorEntityId}` };
  } else if (containerKind==='building'&&(input.members??[]).some(m=>m.kind==='building')&&(input.members??[]).some(m=>['region','natural','other'].includes(String(m.kind)))) {
    chosen={mode:'compound',basis:'source-supported',reason:'已登记成员同时包含独立建筑与室外空间'};
  } else if (containerKind && TYPED_DEFAULT[containerKind]) {
    const mode = TYPED_DEFAULT[containerKind];
    chosen = { mode, basis: 'typed-default', reason: `容器类型 ${containerKind} 的类型默认` };
  } else if (stored.profile) {
    // 非作者来源的已保存档案：留着用，但依据不变。
    chosen = { mode: stored.profile.mode, basis: stored.profile.basis, reason: '已保存档案（非作者来源）' };
  } else {
    chosen = { mode: 'unknown', basis: 'neutral', reason: '没有任何结构化依据：按中性概览处理' };
  }
  sources.push({ mode: chosen.mode, basis: chosen.basis, reason: chosen.reason });

  const rule = RULES[chosen.mode];
  // 类型默认只在**没有作者选择**时生效：city/district 有专属布局 kind（首版 city 求解器），
  // 档案层仍记 unknown（不声称已确认用途），但布局 kind 不能被降级成概览。
  const dedicated = chosen.basis === 'typed-default' ? DEDICATED_KIND[containerKind] : undefined;
  const layoutKind = dedicated ?? rule.layoutKind;
  const members = Array.isArray(input.members) ? input.members.filter(PLAIN) : [];
  const routes = Array.isArray(input.routes) ? input.routes.filter(PLAIN) : [];
  const unsupported: SpatialProfileResolution['unsupported'] = [];
  const pushUnsupported = (id: string, kind: string, reason: string) => {
    if (!id) return;
    unsupported.push({ id, kind, reason });
  };
  const INDOOR_KINDS = new Set(['room', 'floor', 'vehicle']);
  const OUTDOOR_KINDS = new Set(['region', 'natural', 'other', 'city', 'district']);
  for (const member of members) {
    const id = String(member.id ?? '');
    const kind = TEXT(member.kind);
    if (!kind) continue;
    if (chosen.mode === 'outdoor' && INDOOR_KINDS.has(kind)) {
      // 室外档案不画室内房间：这些成员等它们自己的室内图，说得明白，不硬塞。
      pushUnsupported(id, kind, '室外档案不生成匿名室内房间：等该地点自己的室内图');
    } else if (chosen.mode === 'interior' && OUTDOOR_KINDS.has(kind)) {
      // 室内档案不把明确室外的成员塞进普通 rooms。
      pushUnsupported(id, kind, '室内档案不把明确室外的成员塞进普通房间：它需要自己的室外/复合图');
    } else if (chosen.mode === 'compound' && kind === 'room') {
      pushUnsupported(id, kind, '复合档案只画真实建筑足迹：房间留给建筑自己的室内图');
    } else if (chosen.mode === 'unknown' && INDOOR_KINDS.has(kind)) {
      // 待确认场所不声称成员性质：室内成员留给自己的图，概览只做中性示意。
      pushUnsupported(id, kind, '待确认场所只做中性示意：不把室内房间画进概览');
    }
  }
  if (chosen.mode === 'linear' && routes.length === 0) {
    // 沿线档案的"线"必须是**已登记路线**：没有就明说，绝不用装饰纹理假装路线。
    issues.push(issue('SPATIAL_PROFILE_NO_REGISTERED_ROUTE', path, '沿线档案没有任何已登记路线：本轮只画场地足迹，不把 road_texture 装饰当作路线', 'warning'));
  }
  if (unsupported.length > 0) {
    issues.push(issue(
      'SPATIAL_PROFILE_MEMBER_UNSUPPORTED',
      path,
      `档案 ${chosen.mode} 下有 ${unsupported.length} 个成员不受当前生成器支持：本轮按 partial 处理，保留实体与事实，不替换类型凑成功`,
      'warning',
      { relatedIds: unsupported.map((item) => item.id), locationId: asId(input.container?.id) ?? undefined },
    ));
  }
  if (!containerKind && !stored.profile) {
    issues.push(issue('SPATIAL_PROFILE_NEUTRAL', path, '这张图没有任何容器类型或作者档案：按中性概览处理，不假装已确认用途', 'warning'));
  }

  return {
    profile: { version: 1, mode: chosen.mode, basis: chosen.basis },
    rule,
    layoutKind,
    navigationName: rule.navigationName,
    responsibility: rule.responsibility,
    unsupported,
    partial: unsupported.length > 0,
    sources,
    issues,
  };
}

/** 作者或程序要切换档案时的合法输入校验：模式必须在枚举内，**不接受**"按名字猜"。 */
export function normalizeRequestedProfileMode(value: unknown): SpatialProfileMode | null {
  return isMode(value) ? value : null;
}

/**
 * 从地图行（或 frame 本身）里读「本图已绑定的命名走廊地点」id（P11/R03 §18）；没有则 null。
 *
 * 放在档案模块里是因为它是 resolver 的**可信关系来源**：绑定真实走廊 → circulation。
 * 视图 DTO 与布局任务共用这一处判据，不各自读一遍 scene.layout.corridor。
 */
export function boundCorridorIdOf(map: unknown): string | null {
  const raw = PLAIN(map) ? (map as Row).frame_json : map;
  const frame = normalizeFrame(raw);
  const scene = (frame as Row).atlasScene;
  if (!PLAIN(scene)) return null;
  const layout = (scene as Row).layout;
  if (!PLAIN(layout)) return null;
  const corridor = (layout as Row).corridor;
  if (!PLAIN(corridor)) return null;
  return asId((corridor as Row).entityId);
}
