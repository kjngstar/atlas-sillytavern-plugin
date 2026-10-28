/**
 * atlas-world-build-plan.ts — 世界清单、有限设施方案与地点重要性（P03）。
 *
 * 来源：Atlas 全局建图与空间行为开发执行计划 v2 §9.1–§9.5。
 *
 * 这一层是**纯决策层**：给地点行、断言、角色与剧情链接，只回答三个问题
 *   1. 这个地点开局要不要建壳、内部什么时候建（§9.2 清单与延后分类）；
 *   2. 这个城镇该有哪些设施、哪些可以先复用已有地点（§9.3 有限设施方案）；
 *   3. 它算 ordinary 还是 important，凭什么（§9.5 重要性）。
 * 外加 §9.1 的来源覆盖账本计算 —— `sourceScanComplete` 的**唯一判定点**。
 *
 * 纪律：
 * - 不写 SQL、不调模型、不生成几何；只返回判定 + 理由码，便于逐条断言。
 * - 不按「名字含王 / 文本更长」判重要性，也不按数组顺序取第一条。
 * - 设施方案有界：同一方案里 slotKey 稳定；只有大城才允许同类多家；续建不无限增殖。
 * - 覆盖不足就报 false，不用「差不多读完了」冒充读完了。
 */

import { stableHexHash } from './atlas-hash.ts';
import type { PlanIssue } from './atlas-world-contract.ts';
import type { WorldFactLayer, WorldFactOrigin, WorldFactQuality, WorldFactV1 } from './atlas-world-fact-policy.ts';

/* ------------------------------------------------------------------ *
 * 0 公共小工具
 * ------------------------------------------------------------------ */

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function nonNegativeInt(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.floor(num));
}

function byString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function issue(
  code: string,
  path: string,
  message: string,
  severity: 'warning' | 'error',
  retryable: boolean,
  extra: Partial<PlanIssue> = {},
): PlanIssue {
  return { code, path, message, severity, retryable, ...extra };
}

/* ------------------------------------------------------------------ *
 * 1 §9.2 清单与延后分类
 * ------------------------------------------------------------------ */

/** 地点行的最小面：只读需要的列，缺列按「不知道」处理，不猜。 */
export type BuildLocationRow = {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  parent_location_id?: unknown;
  map_id?: unknown;
  existence_quality?: unknown;
  status?: unknown;
  mobility?: unknown;
  terrain?: unknown;
  description?: unknown;
};

export const INTERIOR_POLICIES = [
  /** 开局就必须有内部（世界书明确，或主角起点）。 */
  'required-at-start',
  /** 常识补的普通设施：外部、入口、交通先建，内部等确认进入再建。 */
  'on-confirmed-entry',
  /** 这个对象本来就不该有室内（区域、河流、地形、装饰元素）。 */
  'not-applicable',
] as const;
export type InteriorPolicy = (typeof INTERIOR_POLICIES)[number];

/** 理由码白名单：每条聚合规则一行，方便与 §9.2 的表格逐行对照。 */
export const BUILD_REQUIREMENT_REASONS = [
  /** 区域 / 城镇 / 城区：登记实体与父子，它的「内部」就是它自己那张图。 */
  'CONTAINER_SHELL',
  /** 世界书里的山河湖海：按实际种类表示，不强行给它们造室内。 */
  'SOURCE_NATURAL_FEATURE',
  /** 世界书里的道路 / 河流等线性地物：登记 route 或自然边界，不造房间。 */
  'SOURCE_LINEAR_FEATURE',
  /** 世界书已有可进入建筑、但内部细节少：内部仍开局必建，可合理补陈设。 */
  'SOURCE_ENTERABLE_LOW_DETAIL',
  /** 世界书明确写了房间 / 内部结构：开局必须覆盖，不能因「非当前位置」延期。 */
  'SOURCE_EXPLICIT_INTERIOR',
  /** 推测出的地形大结构：进事实层并影响几何，可被后续明确资料纠正。 */
  'INFERRED_TERRAIN_STRUCTURE',
  /** 常识补的普通设施：内部延后到确认进入。 */
  'INFERRED_FACILITY_INTERIOR_DEFERRED',
  /** 常识补的设施后来拿到了明确内部资料：升为必建增量，不等主角进入。 */
  'INFERRED_FACILITY_INTERIOR_PROMOTED',
  /** 世界书明确但不可进入的建筑（封闭塔楼等）：壳要登记，内部不建。 */
  'NON_ENTERABLE_STRUCTURE',
  /** 地形 / 装饰元素不具备独立互动身份：不为了凑数生成可进入地点。 */
  'DECORATIVE_NOT_INTERACTIVE',
  /** 无法归类的对象：不冒充空间对象。 */
  'OTHER_NON_SPATIAL',
  /** 假设性存在（existence_quality=hypothetical）：不建，等明确资料。 */
  'HYPOTHETICAL_NOT_BUILT',
] as const;
export type BuildRequirementReason = (typeof BUILD_REQUIREMENT_REASONS)[number];

export type BuildRequirement = {
  shellRequired: boolean;
  interiorPolicy: InteriorPolicy;
  reasonCode: BuildRequirementReason;
};

/** 容器类：它们的「内部」就是自己的地图，不需要额外的室内房间。 */
const CONTAINER_KINDS = new Set(['region', 'city', 'district']);
/** 结构类：真正会有室内的地方。 */
const STRUCTURE_KINDS = new Set(['building', 'room', 'floor', 'vehicle']);
/** 本身就是内部的空间：一旦存在就必须开局覆盖。 */
const INTERIOR_KINDS = new Set(['room', 'floor']);
/** 线性地物：按种类表示，不造室内。 */
const LINEAR_TERRAINS = new Set(['river', 'coast', 'road', 'shoreline', 'stream', 'canal']);
/** 能证明「这里有真实结构」而非纯装饰的断言。 */
const STRUCTURAL_PREDICATES = new Set(['exists', 'entrance', 'contains', 'size']);

function normalizeLocationKind(value: unknown): string {
  const kind = text(value).toLowerCase();
  return kind.length > 0 ? kind : 'other';
}

function normalizeTerrain(value: unknown): string {
  return text(value).toLowerCase();
}

function explicitOrigin(origin: WorldFactOrigin): boolean {
  return origin === 'lorebook' || origin === 'story';
}

/** 断言排序：按 id 升序，保证同样的输入永远给同样的理由。 */
function sortFacts(facts: readonly WorldFactV1[] | undefined): WorldFactV1[] {
  const list = Array.isArray(facts) ? facts.filter((fact): fact is WorldFactV1 => Boolean(fact) && typeof fact === 'object') : [];
  return [...list].sort((left, right) => byString(text(left.id), text(right.id)));
}

/**
 * §9.2：这个地点开局要承担什么。
 *
 * 判定顺序（先判「该不该建」，再判「内部什么时候建」）：
 * 1. 假设性存在 → 不建；
 * 2. 容器类 → 建壳、无室内；
 * 3. 线性地物 → 建壳/边界、无室内；
 * 4. 自然物：世界书来源必建；推测来源只有在有结构断言时才算真结构，否则是装饰；
 * 5. 结构类：不可进入 → 只建壳（世界书来源）；
 * 6. 结构类 + 世界书来源 → 内部开局必建（有没有明确内部只影响理由，不影响责任）；
 * 7. 结构类 + 推测来源 → 有明确内部资料就升级为必建，否则延后到确认进入；
 * 8. 其余 → 非空间对象，世界书来源登记壳，推测来源不建。
 */
export function classifyBuildRequirement(input: {
  location: BuildLocationRow;
  facts: readonly WorldFactV1[];
  origin: 'source' | 'inferred';
  canEnter: boolean;
}): BuildRequirement {
  const location = input?.location ?? {};
  const kind = normalizeLocationKind(location.kind);
  const terrain = normalizeTerrain(location.terrain);
  const quality = text(location.existence_quality).toLowerCase();
  const origin: 'source' | 'inferred' = input?.origin === 'inferred' ? 'inferred' : 'source';
  const canEnter = input?.canEnter === true;
  const facts = sortFacts(input?.facts);

  // 假设性存在：任何情况下都不为它建壳，等明确资料再说（不产生「先建了再说」的幽灵地点）。
  if (quality === 'hypothetical') {
    return { shellRequired: false, interiorPolicy: 'not-applicable', reasonCode: 'HYPOTHETICAL_NOT_BUILT' };
  }

  if (CONTAINER_KINDS.has(kind)) {
    return { shellRequired: true, interiorPolicy: 'not-applicable', reasonCode: 'CONTAINER_SHELL' };
  }

  const explicitInterior = facts.some(
    (fact) => fact.layer === 'baseline' && fact.predicate === 'contains' && explicitOrigin(fact.origin),
  );

  if (kind === 'natural') {
    if (LINEAR_TERRAINS.has(terrain)) {
      return { shellRequired: true, interiorPolicy: 'not-applicable', reasonCode: 'SOURCE_LINEAR_FEATURE' };
    }
    if (origin === 'source') {
      return { shellRequired: true, interiorPolicy: 'not-applicable', reasonCode: 'SOURCE_NATURAL_FEATURE' };
    }
    // 推测出的地形：只有带结构断言（存在 / 入口 / 包含 / 尺寸）才算真结构；
    // 否则是纯装饰，不生成可进入地点 —— 不给地图凑数。
    const structural = facts.some((fact) => STRUCTURAL_PREDICATES.has(fact.predicate));
    if (!structural) {
      return { shellRequired: false, interiorPolicy: 'not-applicable', reasonCode: 'DECORATIVE_NOT_INTERACTIVE' };
    }
    return { shellRequired: true, interiorPolicy: 'not-applicable', reasonCode: 'INFERRED_TERRAIN_STRUCTURE' };
  }

  if (STRUCTURE_KINDS.has(kind)) {
    if (!canEnter) {
      // 世界书明确存在的封闭建筑仍要登记壳（玩家在地图上看得见），但内部不建。
      return {
        shellRequired: origin === 'source',
        interiorPolicy: 'not-applicable',
        reasonCode: 'NON_ENTERABLE_STRUCTURE',
      };
    }
    if (origin === 'source') {
      // 世界书来源：无论内部细节多少，内部都是开局责任（§9.2 第 2、3 行），
      // 差别只在理由码 —— 不允许拿「细节少」当延期借口。
      return {
        shellRequired: true,
        interiorPolicy: 'required-at-start',
        reasonCode: explicitInterior || INTERIOR_KINDS.has(kind) ? 'SOURCE_EXPLICIT_INTERIOR' : 'SOURCE_ENTERABLE_LOW_DETAIL',
      };
    }
    if (explicitInterior) {
      return { shellRequired: true, interiorPolicy: 'required-at-start', reasonCode: 'INFERRED_FACILITY_INTERIOR_PROMOTED' };
    }
    return { shellRequired: true, interiorPolicy: 'on-confirmed-entry', reasonCode: 'INFERRED_FACILITY_INTERIOR_DEFERRED' };
  }

  return {
    shellRequired: origin === 'source',
    interiorPolicy: 'not-applicable',
    reasonCode: 'OTHER_NON_SPATIAL',
  };
}

/* ------------------------------------------------------------------ *
 * 2 §9.3 有限设施方案
 * ------------------------------------------------------------------ */

export const SETTLEMENT_PLAN_VERSION = 1;
export const SETTLEMENT_PLAN_POLICY_VERSION = 1;

export const SETTLEMENT_SCALE_CLASSES = ['small', 'medium', 'large', 'unknown'] as const;
export type SettlementScaleClass = (typeof SETTLEMENT_SCALE_CLASSES)[number];

export type SettlementFacility = {
  /** 同一方案内的稳定身份（不是把中文名当唯一键）。 */
  slotKey: string;
  purpose: string;
  districtId: string | null;
  /** 复用的已有地点；与 `newLocationRef` 互斥。 */
  existingLocationId: string | null;
  /** 本批要声明的 `new:` 引用；与 `existingLocationId` 互斥。 */
  newLocationRef: string | null;
  interiorPolicy: 'required-at-start' | 'on-confirmed-entry';
};

export type SettlementPlanV1 = {
  version: 1;
  settlementId: string;
  inputSignature: string;
  scaleClass: SettlementScaleClass;
  worldviewTags: readonly string[];
  facilities: readonly SettlementFacility[];
};

/** 拆成多个 part 行时的一行；part 只是切片，不复制整个世界。 */
export type SettlementPlanPartV1 = {
  version: 1;
  settlementId: string;
  inputSignature: string;
  part: number;
  totalParts: number;
  facilities: readonly SettlementFacility[];
};

export function decodeSettlementPlanPart(raw: unknown): SettlementPlanPartV1 | null {
  const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  if(!object(raw)||raw['version']!==1||typeof raw['settlementId']!=='string'||!raw['settlementId']||typeof raw['inputSignature']!=='string'
    ||typeof raw['part']!=='number'||!Number.isInteger(raw['part'])||raw['part']<1||typeof raw['totalParts']!=='number'||!Number.isInteger(raw['totalParts'])||raw['totalParts']<raw['part']||!Array.isArray(raw['facilities']))return null;
  const facilities:SettlementFacility[]=[];
  for(const entry of raw['facilities']){
    if(!object(entry)||typeof entry['slotKey']!=='string'||typeof entry['purpose']!=='string'||!entry['slotKey']||!entry['purpose']
      ||entry['districtId']!==null&&typeof entry['districtId']!=='string'||entry['existingLocationId']!==null&&typeof entry['existingLocationId']!=='string'
      ||entry['newLocationRef']!==null&&(typeof entry['newLocationRef']!=='string'||!entry['newLocationRef'].startsWith('new:'))
      ||entry['interiorPolicy']!=='required-at-start'&&entry['interiorPolicy']!=='on-confirmed-entry'
      ||(entry['existingLocationId']===null)===(entry['newLocationRef']===null))return null;
    facilities.push({slotKey:entry['slotKey'],purpose:entry['purpose'],districtId:entry['districtId'],existingLocationId:entry['existingLocationId'],newLocationRef:entry['newLocationRef'],interiorPolicy:entry['interiorPolicy']});
  }
  return {version:1,settlementId:raw['settlementId'],inputSignature:raw['inputSignature'],part:raw['part'],totalParts:raw['totalParts'],facilities};
}

/**
 * 设施目录：按世界观分开列，不套同一张清单。
 *
 * 「中世纪 / 现代 / 海上聚落 / 荒野营地」需要的东西不一样；把同一份九宫格套到所有
 * 世界观上就是 §9.3 明令禁止的做法。
 */
const FACILITY_CATALOGUE: Record<string, readonly string[]> = {
  medieval: ['inn', 'market', 'smithy', 'temple', 'guard-post', 'stable', 'well', 'granary'],
  modern: ['grocery', 'clinic', 'school', 'cafe', 'station', 'pharmacy', 'bank', 'park'],
  maritime: ['dock', 'fish-market', 'warehouse', 'shipyard', 'chandlery', 'lighthouse', 'tavern'],
  wilderness: ['camp', 'water-source', 'watchtower', 'supply-cache', 'trailhead'],
  industrial: ['factory', 'warehouse', 'rail-yard', 'power-plant', 'worker-housing'],
  fantasy: ['inn', 'market', 'temple', 'alchemist', 'smithy', 'stable', 'mage-tower'],
  generic: ['inn', 'market', 'well', 'stable', 'guard-post'],
};

/** 世界观别名：宿主 / 世界书常用中文标签，统一映射到目录键。 */
const WORLDVIEW_ALIASES: Record<string, string> = {
  中世纪: 'medieval',
  古典: 'medieval',
  奇幻: 'fantasy',
  魔法: 'fantasy',
  现代: 'modern',
  都市: 'modern',
  当代: 'modern',
  海上: 'maritime',
  港口: 'maritime',
  航海: 'maritime',
  岛: 'maritime',
  荒野: 'wilderness',
  野外: 'wilderness',
  边疆: 'wilderness',
  工业: 'industrial',
  蒸汽: 'industrial',
};

/** 规模目标：有界，规模不明时按保守值规划，不假装世界书写了人口。 */
const SCALE_FACILITY_TARGET: Record<SettlementScaleClass, number> = {
  small: 4,
  medium: 6,
  large: 9,
  unknown: 5,
};

/** 大城里天然会出现多家的用途；其余用途在方案内唯一。 */
const HIGH_DEMAND_PURPOSES = new Set(['inn', 'market', 'temple', 'tavern', 'smithy', 'grocery', 'cafe', 'dock']);

/** 同一用途最多两份：大城两家酒馆合法，但不能靠副本把方案撑成无限。 */
const MAX_FACILITY_COPIES = 2;

/** 用途的中文线索：用来判断已有地点是不是「同用途设施」。 */
const PURPOSE_NAME_HINTS: Record<string, readonly string[]> = {
  inn: ['客栈', '旅店', '酒馆', '旅馆', '旅舍'],
  tavern: ['酒馆', '酒吧', '酒肆'],
  market: ['市场', '集市', '市集', '摊'],
  smithy: ['铁匠', '锻炉', '锻造'],
  temple: ['神殿', '教堂', '寺庙', '神庙', '礼拜', '神龛'],
  'guard-post': ['卫兵', '哨所', '警卫', '兵营'],
  stable: ['马厩', '马房'],
  well: ['水井', '井'],
  granary: ['粮仓', '谷仓'],
  dock: ['码头', '港口', '埠头'],
  'fish-market': ['鱼市', '渔市'],
  warehouse: ['货仓', '仓库'],
  shipyard: ['船厂', '造船'],
  chandlery: ['船具', '杂货'],
  lighthouse: ['灯塔'],
  grocery: ['杂货', '食品店'],
  clinic: ['诊所', '医院', '医馆'],
  school: ['学校', '学堂'],
  cafe: ['咖啡馆', '茶馆'],
  station: ['车站', '驿站'],
  pharmacy: ['药房', '药店'],
  bank: ['银行', '钱庄'],
  park: ['公园'],
  camp: ['营地', '营帐'],
  'water-source': ['水源', '水井', '泉'],
  watchtower: ['瞭望', '哨塔'],
  'supply-cache': ['补给'],
  trailhead: ['山道', '入口'],
  factory: ['工厂', '作坊'],
  'rail-yard': ['铁路', '车场'],
  'power-plant': ['电站', '动力'],
  'worker-housing': ['工棚', '宿舍'],
  alchemist: ['炼金', '药剂'],
  'mage-tower': ['法师塔', '塔'],
};

export type SettlementExistingLocation = {
  id: string;
  name: string;
  purpose?: string;
  /** 世界书已明确登记的地点：内部责任按来源口径算。 */
  fromSource?: boolean;
};

export type SettlementPlanInput = {
  settlementId: string;
  scaleClass?: unknown;
  worldviewTags?: readonly string[];
  existingLocations?: readonly SettlementExistingLocation[];
  /** 已知城区（有就给设施分派 districtId，没有就留 null，不编造）。 */
  districtIds?: readonly string[];
};

export type SettlementPlanResult = {
  plan: SettlementPlanV1;
  issues: PlanIssue[];
};

function normalizeScaleClass(value: unknown): SettlementScaleClass {
  const scale = text(value).toLowerCase();
  return (SETTLEMENT_SCALE_CLASSES as readonly string[]).includes(scale) ? (scale as SettlementScaleClass) : 'unknown';
}

/** 世界观标签归一：命中别名的转成目录键；未知标签保留原样（进签名，不进设施清单）。 */
function normalizeWorldviewTags(tags: readonly string[] | undefined): { canonical: string[]; unknown: string[] } {
  const canonical = new Set<string>();
  const unknown = new Set<string>();
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = text(raw).toLowerCase();
    if (!tag) continue;
    const mapped = WORLDVIEW_ALIASES[tag] ?? (FACILITY_CATALOGUE[tag] ? tag : '');
    if (mapped) canonical.add(mapped);
    else unknown.add(tag);
  }
  return { canonical: [...canonical].sort(byString), unknown: [...unknown].sort(byString) };
}

/** 把多个世界观的目录并起来：按世界观字典序取，去重，保持确定性。 */
function pooledPurposes(canonical: readonly string[]): string[] {
  const ordered = canonical.length > 0 ? canonical : ['generic'];
  const pooled: string[] = [];
  for (const worldview of ordered) {
    for (const purpose of FACILITY_CATALOGUE[worldview] ?? []) {
      if (!pooled.includes(purpose)) pooled.push(purpose);
    }
  }
  return pooled.length > 0 ? pooled : [...FACILITY_CATALOGUE.generic];
}

function facilityCapacity(purpose: string, scaleClass: SettlementScaleClass): number {
  return scaleClass === 'large' && HIGH_DEMAND_PURPOSES.has(purpose) ? MAX_FACILITY_COPIES : 1;
}

/**
 * 先算 slot 序列，再谈复用 —— 两步分开，长度天然有界（≤ 目录长度 × 2），不会无限增殖。
 */
function slotSequence(purposes: readonly string[], scaleClass: SettlementScaleClass, target: number): Array<{ purpose: string; copy: number }> {
  const slots: Array<{ purpose: string; copy: number }> = [];
  for (let copy = 1; copy <= MAX_FACILITY_COPIES && slots.length < target; copy += 1) {
    for (const purpose of purposes) {
      if (slots.length >= target) break;
      if (copy > facilityCapacity(purpose, scaleClass)) continue;
      slots.push({ purpose, copy });
    }
  }
  return slots;
}

function safeSlug(raw: string, fallbackSeed: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  return cleaned.length > 0 ? cleaned : `s${stableHexHash(fallbackSeed).slice(0, 8)}`;
}

function matchesPurpose(location: SettlementExistingLocation, purpose: string): boolean {
  const declared = text(location.purpose).toLowerCase();
  if (declared.length > 0 && declared === purpose) return true;
  const name = text(location.name);
  if (name.length === 0) return false;
  return (PURPOSE_NAME_HINTS[purpose] ?? []).some((hint) => name.includes(hint));
}

/** 方案签名：输入不变就复用方案，不会每次续建再「发现还缺一家酒馆」。 */
export function settlementInputSignature(input: SettlementPlanInput): string {
  const settlementId = text(input?.settlementId);
  const scaleClass = normalizeScaleClass(input?.scaleClass);
  const { canonical, unknown } = normalizeWorldviewTags(input?.worldviewTags);
  const existing = (Array.isArray(input?.existingLocations) ? input.existingLocations : [])
    .map((location) => `${text(location?.id)}:${text(location?.name)}:${text(location?.purpose)}`)
    .sort(byString);
  const districts = (Array.isArray(input?.districtIds) ? input.districtIds : []).map(text).sort(byString);
  return stableHexHash(
    [
      `policy:${SETTLEMENT_PLAN_POLICY_VERSION}`,
      `settlement:${settlementId}`,
      `scale:${scaleClass}`,
      `worldview:${canonical.join(',')}`,
      `unknown-tags:${unknown.join(',')}`,
      `districts:${districts.join(',')}`,
      `existing:${existing.join('|')}`,
    ].join('\u0001'),
  );
}

/**
 * §9.3：为已知城镇形成一个**有边界**的设施方案。
 *
 * - 目录按世界观挑，不套同一张清单；命中不了世界观时用 generic，不硬编一个世界；
 * - 世界书已存在同用途设施时先复用（`existingLocationId`），不重复造；
 * - 只有大城才允许同类多家（`inn#1` / `inn#2` 是合法 slot），小城不机械重复；
 * - 新设施给确定性的 `new:` 引用，便于本批声明、跨窗口沿用；
 * - 规模不明按保守值规划，并在 issues 里说清楚「这是解释性估计」。
 */
export function planSettlementFacilities(input: SettlementPlanInput): SettlementPlanResult {
  const issues: PlanIssue[] = [];
  const settlementId = text(input?.settlementId);
  const scaleClass = normalizeScaleClass(input?.scaleClass);
  const { canonical, unknown } = normalizeWorldviewTags(input?.worldviewTags);
  const purposes = pooledPurposes(canonical);
  const target = SCALE_FACILITY_TARGET[scaleClass];
  const slots = slotSequence(purposes, scaleClass, target);
  const districts = (Array.isArray(input?.districtIds) ? input.districtIds : []).map(text).filter((id) => id.length > 0).sort(byString);
  const existing = (Array.isArray(input?.existingLocations) ? input.existingLocations : [])
    .filter((location) => text(location?.id).length > 0)
    .slice()
    .sort((left, right) => byString(text(left.id), text(right.id)));
  const consumed = new Set<string>();

  if (settlementId.length === 0) {
    issues.push(issue(
      'SETTLEMENT_ID_MISSING',
      '$.settlementId',
      '没有聚落 ID 就无法给方案一个稳定身份，本方案不生成任何设施。',
      'error',
      false,
    ));
  }
  if (scaleClass === 'unknown') {
    issues.push(issue(
      'SETTLEMENT_SCALE_UNKNOWN',
      '$.scaleClass',
      `规模不明，按保守值 ${target} 个设施规划；这是解释性估计，不声称世界书写了具体人口。`,
      'warning',
      false,
    ));
  }
  if (canonical.length === 0) {
    issues.push(issue(
      'SETTLEMENT_WORLDVIEW_UNKNOWN',
      '$.worldviewTags',
      `没有可识别的世界观标签（拿到的是 ${unknown.length > 0 ? unknown.join('、') : '空'}），按通用目录规划；不同世界观不共用同一张清单。`,
      'warning',
      false,
    ));
  }
  if (slots.length < target) {
    issues.push(issue(
      'SETTLEMENT_PLAN_BELOW_SCALE_TARGET',
      '$.facilities',
      `目录只够规划 ${slots.length} 个设施，低于 ${scaleClass} 的目标 ${target}；差额显式记录，不用重复副本凑数。`,
      'warning',
      false,
    ));
  }

  const slug = safeSlug(settlementId, settlementId);
  const facilities: SettlementFacility[] = settlementId.length === 0 ? [] : slots.map((slot, index) => {
    const reused = existing.find((location) => !consumed.has(text(location.id)) && matchesPurpose(location, slot.purpose));
    if (reused) consumed.add(text(reused.id));
    const slotKey = slot.copy === 1 ? slot.purpose : `${slot.purpose}#${slot.copy}`;
    return {
      slotKey,
      purpose: slot.purpose,
      districtId: districts.length > 0 ? districts[index % districts.length] : null,
      existingLocationId: reused ? text(reused.id) : null,
      newLocationRef: reused ? null : `new:facility_${slug}_${slot.purpose}${slot.copy > 1 ? `_${slot.copy}` : ''}`,
      // 复用的、且是世界书明确登记的地点：内部责任按来源口径（开局必建）；
      // 其余新建设施属常识补充，内部延后到确认进入。
      interiorPolicy: reused?.fromSource === true ? 'required-at-start' : 'on-confirmed-entry',
    };
  });

  return {
    plan: Object.freeze({
      version: SETTLEMENT_PLAN_VERSION,
      settlementId,
      inputSignature: settlementInputSignature(input),
      scaleClass,
      worldviewTags: Object.freeze([...canonical, ...unknown]) as readonly string[],
      facilities: Object.freeze(facilities.map((facility) => Object.freeze(facility))) as readonly SettlementFacility[],
    }) as SettlementPlanV1,
    issues,
  };
}

/** 输入没变就复用已有方案：不再重算、不再「发现还缺一家酒馆」。 */
export function isSettlementPlanCurrent(plan: SettlementPlanV1 | null | undefined, input: SettlementPlanInput): boolean {
  if (!plan || plan.version !== SETTLEMENT_PLAN_VERSION) return false;
  if (text(plan.settlementId) !== text(input?.settlementId)) return false;
  return plan.inputSignature === settlementInputSignature(input);
}

/**
 * 方案过大时拆成多个 part 行（§9.3）：每行自带 part/totalParts，
 * 拼起来**无损**还原原方案，不复制整个世界。
 */
export function splitSettlementPlan(plan: SettlementPlanV1, maxFacilitiesPerPart: number): SettlementPlanPartV1[] {
  const limit = Math.max(1, Math.floor(Number.isFinite(maxFacilitiesPerPart) ? maxFacilitiesPerPart : 1));
  const facilities = plan.facilities ?? [];
  const totalParts = Math.max(1, Math.ceil(facilities.length / limit));
  const parts: SettlementPlanPartV1[] = [];
  for (let part = 1; part <= totalParts; part += 1) {
    parts.push({
      version: SETTLEMENT_PLAN_VERSION,
      settlementId: plan.settlementId,
      inputSignature: plan.inputSignature,
      part,
      totalParts,
      facilities: facilities.slice((part - 1) * limit, part * limit),
    });
  }
  return parts;
}

/* ------------------------------------------------------------------ *
 * 3 §9.5 重要性和细节
 * ------------------------------------------------------------------ */

export const LOCATION_DETAIL_TIERS = ['ordinary', 'important'] as const;
export type LocationDetailTier = (typeof LOCATION_DETAIL_TIERS)[number];

export const DETAIL_TIER_REASONS = [
  /** 重要 NPC 的已登记位置 / 住所 / 据点。 */
  'IMPORTANT_CHARACTER_ANCHOR',
  /** 明确的剧情链接（关键场景、任务目标、反复出场）。 */
  'PLOT_LINKED',
  /** 世界书对它有反复的确认描述（不是名字里带个「王」）。 */
  'SOURCE_HIGHLIGHTED',
  /** 没有命中任何重要证据。 */
  'ORDINARY_DEFAULT',
] as const;
export type DetailTierReason = (typeof DETAIL_TIER_REASONS)[number];

/**
 * 「被世界书重点描述」的代理指标：同一地点有 ≥3 条世界书确认断言。
 *
 * 为什么不用「名字含王」「正文更长」：那两条都会把长名字的杂物间判成王宫。
 * 断言条数是可核对的结构证据，且能进 evidenceFactIds。
 */
const SOURCE_HIGHLIGHT_FACT_THRESHOLD = 3;

/** 重要角色：core / recurring；supporting 与临时角色不构成地点重要性。 */
const ANCHOR_IMPORTANCE = new Set(['core', 'recurring']);

/** 构成剧情链接的链接种类。 */
const PLOT_LINK_KINDS = new Set(['key-scene', 'quest', 'quest-target', 'conflict', 'recurring', 'main']);

export type AnchorCharacterRow = {
  id?: unknown;
  importance?: unknown;
  status?: unknown;
  location_id?: unknown;
  home_location_id?: unknown;
  anchor_location_id?: unknown;
};

export type PlotLinkRow = {
  id?: unknown;
  kind?: unknown;
  location_id?: unknown;
  locationId?: unknown;
};

export type LocationDetailTierResult = {
  tier: LocationDetailTier;
  reasonCodes: readonly DetailTierReason[];
  evidenceFactIds: readonly string[];
};

/** 把各种写法归一成地点 ID：`loc:1` 与 `1` 指同一个地方（旧三表导入的遗留写法）。 */
function sameLocationId(value: unknown, locationId: string): boolean {
  const raw = text(value);
  if (raw.length === 0 || locationId.length === 0) return false;
  if (raw === locationId) return true;
  return raw.startsWith('loc:') && raw.slice(4) === locationId;
}

function factLayerOf(fact: WorldFactV1): WorldFactLayer {
  return fact.layer;
}

function factQualityOf(fact: WorldFactV1): WorldFactQuality {
  return fact.quality;
}

/**
 * §9.5：ordinary 还是 important，凭哪些证据。
 *
 * 只影响**细节深度**：不让明确内部获得延期资格，也不强制把所有推测设施内部提前生成。
 * 本函数没有「人工调整 tier」的入口 —— 本轮不开放。
 */
export function resolveLocationDetailTier(input: {
  location: BuildLocationRow;
  facts: readonly WorldFactV1[];
  knownCharacters: readonly AnchorCharacterRow[];
  plotLinks: readonly PlotLinkRow[];
}): LocationDetailTierResult {
  const locationId = text(input?.location?.id);
  const reasons: DetailTierReason[] = [];
  const evidence = new Set<string>();

  const facts = sortFacts(input?.facts).filter((fact) => sameLocationId(fact.subjectId, locationId));

  const anchored = (Array.isArray(input?.knownCharacters) ? input.knownCharacters : []).some((character) => {
    if (!character || typeof character !== 'object') return false;
    const status = text(character.status).toLowerCase();
    if (status === 'archived' || status === 'merged' || status === 'destroyed') return false;
    if (!ANCHOR_IMPORTANCE.has(text(character.importance).toLowerCase())) return false;
    return sameLocationId(character.location_id, locationId)
      || sameLocationId(character.home_location_id, locationId)
      || sameLocationId(character.anchor_location_id, locationId);
  });
  if (anchored) reasons.push('IMPORTANT_CHARACTER_ANCHOR');

  const linked = (Array.isArray(input?.plotLinks) ? input.plotLinks : []).some((link) => {
    if (!link || typeof link !== 'object') return false;
    const target = link.location_id ?? link.locationId;
    if (!sameLocationId(target, locationId)) return false;
    return PLOT_LINK_KINDS.has(text(link.kind).toLowerCase());
  });
  if (linked) reasons.push('PLOT_LINKED');

  const highlighted = facts.filter(
    (fact) => fact.origin === 'lorebook' && factLayerOf(fact) === 'baseline' && factQualityOf(fact) === 'confirmed',
  );
  if (highlighted.length >= SOURCE_HIGHLIGHT_FACT_THRESHOLD) {
    reasons.push('SOURCE_HIGHLIGHTED');
    for (const fact of highlighted) evidence.add(text(fact.id));
  }

  const tier: LocationDetailTier = reasons.length > 0 ? 'important' : 'ordinary';
  if (tier === 'ordinary') reasons.push('ORDINARY_DEFAULT');

  return {
    tier,
    reasonCodes: reasons,
    evidenceFactIds: [...evidence].filter((id) => id.length > 0).sort(byString),
  };
}

/* ------------------------------------------------------------------ *
 * 4 §9.1 来源覆盖账本
 * ------------------------------------------------------------------ */

export const SOURCE_COVERAGE_VERSION = 1;

/** 与 `WorldSourceKnown` 结构一致：只读需要的字段，不把整条选择结果搬进来。 */
export type SourceCoverageSource = {
  sourceKey: string;
  contentHash?: string;
  kind?: string;
  chars: number;
  hostTruncated: boolean;
  chunkCount: number;
};

export type SourceCoverageDeferred = {
  chunkKey: string;
  sourceKey?: string;
  reason?: string;
};

export type SourceCoverageInput = {
  known: readonly SourceCoverageSource[];
  deferred?: readonly SourceCoverageDeferred[];
  /** 账本里已 processed 的块键（跨窗口累计，不是本批）。 */
  processedChunkKeys?: readonly string[] | ReadonlySet<string>;
  /**
   * 账本里**当前存在**的全部块键。给了它就把统计限制在这批块上：
   * 否则历史 hash 遗留的 processed 块会把覆盖数撑满，看起来像「早就读完了」。
   */
  knownChunkKeys?: readonly string[];
};

export type SourceCoverageV1 = {
  version: 1;
  /** 本次看到的全部来源（含关闭、截断、空文本）。 */
  knownSources: number;
  /** 有内容可分块的来源。 */
  allowedSources: number;
  /** 空文本来源：看到了但没有内容可读。 */
  emptySources: number;
  /** 宿主只给了截断文本的来源：**不能**算读完。 */
  hostTruncatedSources: number;
  totalChunks: number;
  processedChunks: number;
  deferredChunks: number;
  /** 既没处理也没明确延期的块数。 */
  uncheckedChunks: number;
  /** 只有它为 true 才允许对外声称来源扫描完成。 */
  sourceScanComplete: boolean;
  issues: readonly PlanIssue[];
};

/**
 * §9.1：覆盖账本。
 *
 * `sourceScanComplete` 的判定只有这一处，条件全部成立才算读完：
 * - 至少有一个可读来源（零来源不是「读完了」，是「什么都没读到」）；
 * - 每个块都进了账本且为 processed；
 * - 没有被显式延期的块；
 * - 没有宿主截断的来源。
 *
 * 任何人想「差不多读完了」都过不了这几条。
 */
export function computeSourceCoverage(input: SourceCoverageInput): SourceCoverageV1 {
  const known = (Array.isArray(input?.known) ? input.known : []).filter(
    (entry): entry is SourceCoverageSource => Boolean(entry) && typeof entry === 'object',
  );
  const deferred = Array.isArray(input?.deferred) ? input.deferred.filter(Boolean) : [];
  const processedSource = input?.processedChunkKeys;
  const processed = processedSource instanceof Set
    ? new Set<string>([...processedSource].map(String))
    : new Set<string>((Array.isArray(processedSource) ? processedSource : []).map(String));

  let allowedSources = 0;
  let emptySources = 0;
  let hostTruncatedSources = 0;
  let totalChunks = 0;
  const truncatedKeys: string[] = [];

  for (const entry of known) {
    const chunkCount = nonNegativeInt(entry.chunkCount);
    totalChunks += chunkCount;
    if (chunkCount > 0) allowedSources += 1;
    else emptySources += 1;
    if (entry.hostTruncated === true) {
      hostTruncatedSources += 1;
      truncatedKeys.push(text(entry.sourceKey) || '(未命名来源)');
    }
  }

  // 只统计「确实存在」的已处理块：账本里残留的、已经不在当前切分里的键不算数。
  const knownChunkKeys = Array.isArray(input?.knownChunkKeys) ? new Set(input.knownChunkKeys.map(String)) : null;
  const withinKnown = (key: string): boolean => knownChunkKeys === null || knownChunkKeys.has(key);
  const knownChunkCount = totalChunks;
  const processedChunks = Math.min(knownChunkCount, [...processed].filter(withinKnown).length);
  const deferredChunks = knownChunkKeys === null
    ? deferred.length
    : deferred.filter((entry) => withinKnown(text(entry.chunkKey))).length;
  const uncheckedChunks = Math.max(0, knownChunkCount - processedChunks - deferredChunks);

  const issues: PlanIssue[] = [];
  if (known.length > 0 && allowedSources === 0) {
    issues.push(issue(
      'SOURCE_COVERAGE_EMPTY',
      '$.sources',
      `共 ${known.length} 个来源，但没有任何可读内容（全部为空文本或被关闭）；这不等于「读完了」，来源扫描未完成。`,
      'warning',
      false,
    ));
  }
  if (hostTruncatedSources > 0) {
    issues.push(issue(
      'SOURCE_COVERAGE_HOST_TRUNCATED',
      '$.sources',
      `以下来源只拿到截断文本，不能声称已读完：${truncatedKeys.sort(byString).join('、')}。可经现有允许入口取完整内容就取；取不到则标覆盖问题。`,
      'warning',
      true,
    ));
  }
  if (deferredChunks > 0) {
    issues.push(issue(
      'SOURCE_COVERAGE_DEFERRED',
      '$.sources.deferred',
      `有 ${deferredChunks} 个块被显式延期（预算不足或块已不存在），这些块还没被检查，来源扫描未完成。`,
      'warning',
      true,
    ));
  }
  if (uncheckedChunks > 0) {
    issues.push(issue(
      'SOURCE_COVERAGE_INCOMPLETE',
      '$.sources',
      `还有 ${uncheckedChunks} / ${knownChunkCount} 个块没有进账本（既未 processed 也未延期），不允许报 sourceScanComplete。`,
      'warning',
      true,
    ));
  }

  const sourceScanComplete = allowedSources > 0
    && hostTruncatedSources === 0
    && deferredChunks === 0
    && uncheckedChunks === 0
    && processedChunks === knownChunkCount;

  return {
    version: SOURCE_COVERAGE_VERSION,
    knownSources: known.length,
    allowedSources,
    emptySources,
    hostTruncatedSources,
    totalChunks: knownChunkCount,
    processedChunks,
    deferredChunks,
    uncheckedChunks,
    sourceScanComplete,
    issues,
  };
}

/* ------------------------------------------------------------------ *
 * 5 §17.1 已有 NPC 的初始放置（一次性）
 * ------------------------------------------------------------------ */

export const NPC_PLACEMENT_VERSION = 1;
export const NPC_PLACEMENT_BASIS = 'estimated' as const;
/** 初始放置属于 characters 类工作：不塞进 geography 阶段，也不逐 NPC 发请求。 */
export const NPC_PLACEMENT_WORK_CLASS = 'characters' as const;
/** 一批最多放几个：有界，超出显式记账等下一批，不偷偷扩容。 */
export const NPC_PLACEMENT_BATCH_LIMIT = 12;
/** 一次性完成记录在 `construction_progress.payload_json` 里的类型标记。 */
export const NPC_PLACEMENT_RECORD_KIND = 'npc-initial-placement' as const;

export type NpcPlacementSkipReason =
  | 'PROTAGONIST_NOT_PLACED'
  | 'INACTIVE_CHARACTER'
  | 'HAS_LOCATION'
  | 'IN_TRANSIT'
  | 'ALREADY_PLACED'
  | 'NO_LEGAL_LOCATION'
  | 'BATCH_LIMIT';

export type NpcPlacementReasonCode =
  /** 身份/职业对应的合法设施（铁匠→铁匠铺）。 */
  | 'IDENTITY_FACILITY'
  /** 聚落本身：没有更具体的合法设施时，先说他在这个城里。 */
  | 'SETTLEMENT_ANCHOR'
  /** 目录里只有一个合法落点，没有可选项 —— 但不编造。 */
  | 'ONLY_LEGAL_PLACE';

export type NpcPlacementCharacter = {
  id?: unknown;
  name?: unknown;
  role?: unknown;
  importance?: unknown;
  status?: unknown;
  physical_status?: unknown;
  identity?: unknown;
  description?: unknown;
  location_id?: unknown;
  map_id?: unknown;
  grid_x?: unknown;
  grid_y?: unknown;
  coord_precision?: unknown;
};

export type NpcPlacementLocation = {
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  purpose?: unknown;
  parent_location_id?: unknown;
  existence_quality?: unknown;
  status?: unknown;
  /** 是否可进入：结构类地点不可进入就不适合当住处/据点。 */
  canEnter?: unknown;
};

/** 一次性放置记录：**存在就说明已经安排过**，不许每轮重新安排。 */
export type NpcPlacementRecord = {
  kind: typeof NPC_PLACEMENT_RECORD_KIND;
  characterId: string;
  locationId: string;
  basis: typeof NPC_PLACEMENT_BASIS;
  reasonCode: NpcPlacementReasonCode;
  decidedAtTurn: string;
};

export type NpcPlacementTarget = {
  version: 1;
  characterId: string;
  locationId: string;
  basis: typeof NPC_PLACEMENT_BASIS;
  reasonCode: NpcPlacementReasonCode;
  workClass: typeof NPC_PLACEMENT_WORK_CLASS;
  /** 同时写进建造进度的一行，保证「一次就够」。 */
  record: NpcPlacementRecord;
  op: { op: 'character.upsert'; ref: string; data: { location_ref: string }; source: string };
};

export type NpcPlacementSkip = { characterId: string; reason: NpcPlacementSkipReason };

export type NpcPlacementInput = {
  characters: readonly NpcPlacementCharacter[];
  locations: readonly NpcPlacementLocation[];
  /** 未结束行程的 mover：正在路上的人不拉回去重放。 */
  openJourneys?: readonly { mover_entity_id?: unknown; status?: unknown }[];
  /** 已经放置过的记录（来自建造进度）。 */
  placed?: readonly NpcPlacementRecord[];
  settlementId?: string | null;
  limit?: number;
  /** 写进一次性记录的决策楼层；只作审计，不参与身份派生。 */
  turnId?: string | null;
};

export type NpcPlacementResult = {
  placements: NpcPlacementTarget[];
  skipped: NpcPlacementSkip[];
  issues: PlanIssue[];
};

/** 身份 → 设施用途。按**身份优先**匹配，名字只作最后的线索，不单独判定。 */
const IDENTITY_PURPOSE_HINTS: ReadonlyArray<{ purpose: string; hints: readonly string[] }> = [
  { purpose: 'smithy', hints: ['铁匠', '锻工', 'smith', 'forge', 'blacksmith'] },
  { purpose: 'inn', hints: ['掌柜', '店主', '老板娘', 'innkeeper', 'tavern', '酒保'] },
  { purpose: 'guard-post', hints: ['卫兵', '守卫', '巡逻', 'guard', 'watchman', '士兵', 'soldier'] },
  { purpose: 'temple', hints: ['神父', '牧师', '祭司', 'priest', 'cleric', '僧人', '修士'] },
  { purpose: 'market', hints: ['商人', '商贩', '摊贩', 'merchant', 'vendor', 'spice'] },
  { purpose: 'dock', hints: ['渔夫', '渔民', '水手', 'fisher', 'sailor', '船工', 'dockhand'] },
  { purpose: 'granary', hints: ['农夫', '农民', 'farmer', 'mill'] },
  { purpose: 'school', hints: ['学者', '教师', '先生', 'scholar', 'teacher', 'scribe'] },
  { purpose: 'clinic', hints: ['医生', '医师', 'healer', 'doctor', '草药'] },
  { purpose: 'alchemist', hints: ['炼金', 'alchemist', '药剂'] },
  { purpose: 'stable', hints: ['马夫', 'stable', 'groom'] },
];

/** 容器类地点可以当「他在这片区域」的粗粒度落点。 */
const PLACEMENT_CONTAINER_KINDS = new Set(['region', 'city', 'district']);
/** 结构类地点必须是「可进入」的才能当落点。 */
const PLACEMENT_STRUCTURE_KINDS = new Set(['building', 'room', 'floor', 'vehicle']);

function roleRank(importance: unknown): number {
  const value = text(importance).toLowerCase();
  if (value === 'core') return 0;
  if (value === 'recurring') return 1;
  return 2;
}

/**
 * §17.1「位置无明确依据」的判定。
 *
 * 有 `location_id` 就算有依据（哪怕是粗粒度 at_location）；
 * 只有网格坐标也算有依据。**未知就是没有依据**，不用「大概在附近」凑一个。
 */
export function characterHasLocationEvidence(character: NpcPlacementCharacter | null | undefined): boolean {
  if (!character || typeof character !== 'object') return false;
  if (text(character.location_id) !== '') return true;
  const x = typeof character.grid_x === 'number' ? character.grid_x : Number(character.grid_x);
  const y = typeof character.grid_y === 'number' ? character.grid_y : Number(character.grid_y);
  return Number.isFinite(x) && Number.isFinite(y) && text(character.map_id) !== '';
}

/** 身份/职业落在哪个用途上；判不出来就 null（不硬塞一个职业）。 */
export function identityPurposeOf(character: NpcPlacementCharacter | null | undefined): string | null {
  if (!character || typeof character !== 'object') return null;
  const fields = [text(character.identity), text(character.description), text(character.name)].filter((entry) => entry !== '');
  for (const field of fields) {
    const lowered = field.toLowerCase();
    for (const rule of IDENTITY_PURPOSE_HINTS) {
      if (rule.hints.some((hint) => lowered.includes(hint.toLowerCase()))) return rule.purpose;
    }
  }
  return null;
}

/** 这个地点能不能当某个 NPC 的初始落点。 */
export function isLegalPlacementLocation(location: NpcPlacementLocation | null | undefined): { legal: boolean; reasonCode: 'OK' | 'HYPOTHETICAL' | 'GONE' | 'NOT_ENTERABLE' | 'UNKNOWN_KIND' } {
  if (!location || typeof location !== 'object' || text(location.id) === '') return { legal: false, reasonCode: 'UNKNOWN_KIND' };
  if (text(location.existence_quality).toLowerCase() === 'hypothetical') return { legal: false, reasonCode: 'HYPOTHETICAL' };
  const status = text(location.status).toLowerCase();
  if (status === 'destroyed' || status === 'merged' || status === 'archived') return { legal: false, reasonCode: 'GONE' };
  const kind = normalizeLocationKind(location.kind);
  if (PLACEMENT_CONTAINER_KINDS.has(kind)) return { legal: true, reasonCode: 'OK' };
  if (PLACEMENT_STRUCTURE_KINDS.has(kind)) {
    return location.canEnter === false ? { legal: false, reasonCode: 'NOT_ENTERABLE' } : { legal: true, reasonCode: 'OK' };
  }
  return { legal: false, reasonCode: 'UNKNOWN_KIND' };
}

/**
 * §17.1：挑出**该被安排**的 NPC。
 *
 * 只选已登记、位置无明确依据、没有未结束行程、也没被安排过的角色。
 * 主角不在这里安排（他的位置来自剧情），死了/归档的人不动（不制造幽灵行）。
 */
export function selectPlacementCandidates(input: NpcPlacementInput): {
  candidates: NpcPlacementCharacter[];
  skipped: NpcPlacementSkip[];
} {
  const skipped: NpcPlacementSkip[] = [];
  const placed = new Set((input?.placed ?? []).map((record) => text(record?.characterId)).filter((id) => id !== ''));
  const inTransit = new Set(
    (input?.openJourneys ?? [])
      .filter((journey) => ['moving', 'paused', 'blocked'].includes(text(journey?.status).toLowerCase()))
      .map((journey) => text(journey?.mover_entity_id))
      .filter((id) => id !== ''),
  );

  const characters = (Array.isArray(input?.characters) ? input.characters : [])
    .filter((character): character is NpcPlacementCharacter => Boolean(character) && typeof character === 'object')
    .slice()
    .sort((left, right) => {
      const rank = roleRank(left.importance) - roleRank(right.importance);
      return rank !== 0 ? rank : byString(text(left.id), text(right.id));
    });

  const candidates: NpcPlacementCharacter[] = [];
  for (const character of characters) {
    const characterId = text(character.id);
    if (characterId === '') continue;
    if (text(character.role).toLowerCase() === 'protagonist') {
      skipped.push({ characterId, reason: 'PROTAGONIST_NOT_PLACED' });
      continue;
    }
    const status = text(character.status).toLowerCase();
    if (status !== '' && status !== 'active') {
      skipped.push({ characterId, reason: 'INACTIVE_CHARACTER' });
      continue;
    }
    const physical = text(character.physical_status).toLowerCase();
    if (physical === 'dead' || physical === 'unknown') {
      // 死亡的人不安排；身体状态未知的人也不假装他在某个房间。
      skipped.push({ characterId, reason: 'INACTIVE_CHARACTER' });
      continue;
    }
    if (characterHasLocationEvidence(character)) {
      skipped.push({ characterId, reason: 'HAS_LOCATION' });
      continue;
    }
    if (inTransit.has(characterId)) {
      skipped.push({ characterId, reason: 'IN_TRANSIT' });
      continue;
    }
    if (placed.has(characterId)) {
      skipped.push({ characterId, reason: 'ALREADY_PLACED' });
      continue;
    }
    candidates.push(character);
  }
  return { candidates, skipped };
}

/** 从建造进度行里读回一次性放置记录（wiring 层只做搬运，不重判）。 */
export function npcPlacementRecordsFromProgress(rows: readonly { payload?: unknown }[] | null | undefined): NpcPlacementRecord[] {
  const out: NpcPlacementRecord[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const payload = row?.payload;
    if (!payload || typeof payload !== 'object') continue;
    const record = payload as Record<string, unknown>;
    if (text(record.kind) !== NPC_PLACEMENT_RECORD_KIND) continue;
    const characterId = text(record.characterId);
    const locationId = text(record.locationId);
    if (characterId === '' || locationId === '') continue;
    out.push({
      kind: NPC_PLACEMENT_RECORD_KIND,
      characterId,
      locationId,
      basis: NPC_PLACEMENT_BASIS,
      reasonCode: 'IDENTITY_FACILITY',
      decidedAtTurn: text(record.decidedAtTurn),
    });
  }
  return out;
}

/**
 * §17.1：给一个 NPC 选初始落点。
 *
 * 次序固定：身份对应设施 → 聚落本身 → 目录里唯一合法落点 → 放弃。
 * 绝不「先放主角房间再说」：那会让所有未知 NPC 挤在一起，正是本节要避免的。
 */
export function chooseInitialLocation(input: {
  character: NpcPlacementCharacter;
  locations: readonly NpcPlacementLocation[];
  settlementId?: string | null;
}): { locationId: string | null; reasonCode: NpcPlacementReasonCode | null } {
  const locations = (Array.isArray(input?.locations) ? input.locations : []).filter((location) => isLegalPlacementLocation(location).legal);
  if (locations.length === 0) return { locationId: null, reasonCode: null };

  const purpose = identityPurposeOf(input?.character);
  if (purpose) {
    const match = locations
      .filter((location) => text(location.purpose).toLowerCase() === purpose || matchesPurpose({ id: text(location.id), name: text(location.name), purpose: text(location.purpose) }, purpose))
      .sort((left, right) => byString(text(left.id), text(right.id)))[0];
    if (match) return { locationId: text(match.id), reasonCode: 'IDENTITY_FACILITY' };
  }

  const settlementId = text(input?.settlementId);
  if (settlementId !== '' && locations.some((location) => text(location.id) === settlementId)) {
    return { locationId: settlementId, reasonCode: 'SETTLEMENT_ANCHOR' };
  }

  if (locations.length === 1) return { locationId: text(locations[0].id), reasonCode: 'ONLY_LEGAL_PLACE' };
  return { locationId: null, reasonCode: null };
}

/**
 * §17.1：形成一批初始放置目标。
 *
 * 每个目标只带**位置字段**（`location_ref`）与 estimated 来源；
 * 一次性记录单独返回，写进建造进度后同一角色不再进候选。
 */
export function planNpcInitialPlacement(input: NpcPlacementInput): NpcPlacementResult {
  const issues: PlanIssue[] = [];
  const limit = Math.max(1, Math.floor(Number.isFinite(Number(input?.limit)) ? Number(input.limit) : NPC_PLACEMENT_BATCH_LIMIT));
  const { candidates, skipped } = selectPlacementCandidates(input);
  const decidedAtTurn = text(input?.turnId) || 'build';
  const placements: NpcPlacementTarget[] = [];

  for (const character of candidates) {
    if (placements.length >= limit) {
      skipped.push({ characterId: text(character.id), reason: 'BATCH_LIMIT' });
      continue;
    }
    const characterId = text(character.id);
    const choice = chooseInitialLocation({ character, locations: input?.locations ?? [], settlementId: input?.settlementId ?? null });
    if (!choice.locationId || !choice.reasonCode) {
      skipped.push({ characterId, reason: 'NO_LEGAL_LOCATION' });
      issues.push(issue(
        'NPC_PLACEMENT_NO_LOCATION',
        '$.characters',
        `${text(character.name) || characterId} 没有可用的合法落点：不伪造位置，保持未知等后续明确资料。`,
        'warning',
        false,
      ));
      continue;
    }
    placements.push({
      version: NPC_PLACEMENT_VERSION,
      characterId,
      locationId: choice.locationId,
      basis: NPC_PLACEMENT_BASIS,
      reasonCode: choice.reasonCode,
      workClass: NPC_PLACEMENT_WORK_CLASS,
      record: {
        kind: NPC_PLACEMENT_RECORD_KIND,
        characterId,
        locationId: choice.locationId,
        basis: NPC_PLACEMENT_BASIS,
        reasonCode: choice.reasonCode,
        decidedAtTurn,
      },
      // 只写位置字段：不新增人物、不改身份、不带随从。
      op: {
        op: 'character.upsert',
        ref: characterId,
        data: { location_ref: choice.locationId },
        source: `estimate:${NPC_PLACEMENT_RECORD_KIND}`,
      },
    });
  }

  if (placements.length > 0) {
    issues.push(issue(
      'NPC_PLACEMENT_ESTIMATED',
      '$.characters',
      `本批按身份/据点/合法设施为 ${placements.length} 名已有 NPC 估计初始位置（basis=estimated）；后续明确剧情移动可纠正，不会每轮重新安排。`,
      'warning',
      false,
    ));
  }
  return { placements, skipped, issues };
}

/**
 * §17.1 的操作面护栏：初始放置**只能**动目录内现有 NPC 的位置。
 *
 * 明确拒绝：`new:` 人物引用（会凭空多出 NPC）、改身份/重要性/角色、
 * 生成随从（任何非位置字段）。返回 null 表示这条操作是合法的放置。
 */
export function validateNpcPlacementOp(
  op: { op?: unknown; ref?: unknown; data?: unknown } | null | undefined,
  knownCharacterIds: readonly string[],
): PlanIssue | null {
  const kind = text(op?.op);
  if (kind !== 'character.upsert') {
    return issue('NPC_PLACEMENT_OP_NOT_ALLOWED', '$.op', `初始放置只允许 character.upsert，收到 ${kind || '(空)'}`, 'error', false);
  }
  const ref = text(op?.ref);
  if (ref === '') return issue('NPC_PLACEMENT_REF_MISSING', '$.ref', '初始放置必须点名一个已登记人物', 'error', false);
  if (ref.startsWith('new:')) {
    return issue('NPC_PLACEMENT_NEW_CHARACTER_FORBIDDEN', '$.ref', '初始放置不得创建新人物（普通 NPC 总数不增加）', 'error', false);
  }
  const known = new Set((Array.isArray(knownCharacterIds) ? knownCharacterIds : []).map(text));
  if (known.size > 0 && !known.has(ref)) {
    return issue('NPC_PLACEMENT_REF_UNKNOWN', '$.ref', `引用 ${ref} 不在当前人物目录里：不能顺手生成随从`, 'error', false);
  }
  const data = op?.data && typeof op.data === 'object' && !Array.isArray(op.data) ? (op.data as Record<string, unknown>) : null;
  if (!data) return issue('NPC_PLACEMENT_DATA_MISSING', '$.data', '初始放置缺少位置字段', 'error', false);
  const allowed = new Set(['location_ref', 'position']);
  const illegal = Object.keys(data).filter((key) => !allowed.has(key));
  if (illegal.length > 0) {
    return issue('NPC_PLACEMENT_FIELD_NOT_ALLOWED', '$.data', `初始放置只能改位置字段，收到了：${illegal.join('、')}`, 'error', false);
  }
  if (text(data.location_ref) === '') return issue('NPC_PLACEMENT_LOCATION_MISSING', '$.data.location_ref', '初始放置必须给出落点引用', 'error', false);
  return null;
}

/**
 * 阶段闸：放置属于 characters 类，不能混进 geography 阶段的 allowedOps，
 * 也不能在 decision 阶段执行（那会绕过「decision 只写想法/倾向」的既有约束）。
 */
export function placementAllowedInPhase(phase: unknown): boolean {
  const value = text(phase).toLowerCase();
  return value === 'observe' || value === 'build';
}
