/**
 * atlas-scene.ts — R06 首次定位、开场识别与「起点」占位迁移（纯函数零副作用）。
 *
 * 对应《修复计划》R06：
 * - 系统占位不是地理事实：起始世界自带的「起点」点/地区只有在**生成来源 + 结构指纹**
 *   双重吻合且无任何用户编辑证据时才认定为系统占位；绝不只按名字匹配——
 *   用户真正创建并命名为「起点」的地点必须原样保留。
 * - 旧占位不删除：标记 retired（sidecar 文档 + 定义修订审计），保留历史引用；
 *   地点选择 / 附近列表等真实地点语境默认过滤 retired 点。
 * - 场景未知与 lastConfirmed 分开表达：当前游标未知 ≠ 场景未知前的最后确认地点。
 *
 * SceneDoc 为独立 sidecar 文档（scene:<worldId>），不进 lib/ 快照 schema。
 */

import type { World } from "../lib/world-schema.ts";
import { appendDefinitionRevision } from "../lib/world-definition.ts";

// ---------------------------------------------------------------------------
// 起点占位指纹（生成来源 + 结构指纹，不只看名字）
// ---------------------------------------------------------------------------

export interface StartPlaceholderInfo {
  isPlaceholder: boolean;
  /** 占位地点 id（isPlaceholder=true 时为 "1" 形态字符串） */
  pointId: string | null;
  regionId: string | null;
  /** 判定依据（isPlaceholder=false 时列出阻止判定的编辑证据） */
  reasons: string[];
}

/**
 * 认定条件（全部满足才是系统占位；任何一条不满足 = 用户/剧情已实际使用，保留）：
 * 1. 恰好 1 个地点：id=1、name=起点、x=50、y=50、regionId=start（buildStarterWorld 指纹）；
 * 2. 恰好 1 个地区：id=start、name=起点；
 * 3. 无账本事件（stateEvents 为空——发生过推演的世界占位可能已被引用）；
 * 4. 无定义修订（definitionRevisions 为空——任何修订都意味着有人动过定义）；
 * 5. 人物只有 char-main（自动建世主角）。
 * 注意：这里**不**检查名字之外的内容相似——多一个点 / 多一条修订即放弃认定。
 */
export function detectStartPlaceholder(world: World): StartPlaceholderInfo {
  const reasons: string[] = [];
  const points = world.points ?? [];
  const regions = world.regions ?? [];

  const point = points.length === 1 ? points[0] : null;
  if (points.length !== 1) reasons.push(`地点数 ${points.length} ≠ 1`);
  if (!point || point.id !== 1) reasons.push("唯一地点 id ≠ 1");
  if (!point || point.name !== "起点") reasons.push(`地点名 ${point ? `「${point.name}」` : "缺失"} ≠ 「起点」`);
  if (!point || point.x !== 50 || point.y !== 50) reasons.push("地点坐标 ≠ (50,50)");
  if (!point || (point.regionId ?? null) !== "start") reasons.push("地点未归属 start 地区");

  const region = regions.length === 1 ? regions[0] : null;
  if (regions.length !== 1) reasons.push(`地区数 ${regions.length} ≠ 1`);
  if (!region || region.id !== "start") reasons.push("唯一地区 id ≠ start");
  if (!region || region.name !== "起点") reasons.push("地区名 ≠ 「起点」");

  if ((world.stateEvents ?? []).length > 0) reasons.push("存在账本事件（世界已被推演过）");
  if ((world.definitionRevisions ?? []).length > 0) reasons.push("存在定义修订（定义被编辑过）");
  const nonMain = (world.characters ?? []).filter((c) => c.id !== "char-main");
  if (nonMain.length > 0) reasons.push(`存在 ${nonMain.length} 个非主角人物`);

  const isPlaceholder = reasons.length === 0;
  return {
    isPlaceholder,
    pointId: isPlaceholder ? String(point!.id) : null,
    regionId: isPlaceholder ? String(region!.id) : null,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// SceneDoc sidecar（scene:<worldId>）
// ---------------------------------------------------------------------------

export interface SceneDoc {
  schemaVersion: 1;
  /** 已标记 retired 的占位地点 id（保留在世界里，仅真实地点语境过滤） */
  retiredPointIds: string[];
  /** 最近一次确认的场景锚点（与「当前未知」分开表达） */
  lastConfirmed: { branchId: string | null; pointId: string; at: number } | null;
  /** 开场识别（mode=bootstrap）簿记：明确调用次数与状态 */
  bootstrap: { attempts: number; lastAt: number | null; lastStatus: string | null } | null;
}

export function emptySceneDoc(): SceneDoc {
  return { schemaVersion: 1, retiredPointIds: [], lastConfirmed: null, bootstrap: null };
}

/** sidecar 形状不可信：宽容清洗，绝不炸面板。 */
export function sanitizeSceneDoc(raw: unknown): SceneDoc {
  const doc = emptySceneDoc();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return doc;
  const record = raw as Record<string, unknown>;
  if (Array.isArray(record.retiredPointIds)) {
    for (const id of record.retiredPointIds.slice(0, 200)) {
      if (typeof id === "string" && id.trim()) doc.retiredPointIds.push(id.trim().slice(0, 64));
    }
  }
  if (record.lastConfirmed && typeof record.lastConfirmed === "object" && !Array.isArray(record.lastConfirmed)) {
    const lc = record.lastConfirmed as Record<string, unknown>;
    const pointId = typeof lc.pointId === "string" ? lc.pointId : "";
    const at = typeof lc.at === "number" && Number.isFinite(lc.at) ? lc.at : null;
    if (pointId && at !== null) {
      doc.lastConfirmed = {
        branchId: typeof lc.branchId === "string" ? lc.branchId : null,
        pointId: pointId.slice(0, 64),
        at,
      };
    }
  }
  if (record.bootstrap && typeof record.bootstrap === "object" && !Array.isArray(record.bootstrap)) {
    const b = record.bootstrap as Record<string, unknown>;
    const attempts = typeof b.attempts === "number" && Number.isFinite(b.attempts) && b.attempts >= 0 ? Math.floor(b.attempts) : null;
    if (attempts !== null) {
      doc.bootstrap = {
        attempts: Math.min(attempts, 9999),
        lastAt: typeof b.lastAt === "number" && Number.isFinite(b.lastAt) ? b.lastAt : null,
        lastStatus: typeof b.lastStatus === "string" ? b.lastStatus.slice(0, 32) : null,
      };
    }
  }
  return doc;
}

/**
 * 标记起点占位 retired：结构零改动（点/地区原样保留，历史引用不悬空），
 * 追加定义修订留审计。重复调用幂等（已在 retired 列表 → 原样返回）。
 */
export function retireStartPlaceholder(
  world: World,
  doc: SceneDoc,
  options: { now: number; info?: StartPlaceholderInfo },
): { world: World; doc: SceneDoc; changed: boolean } {
  const info = options.info ?? detectStartPlaceholder(world);
  if (!info.isPlaceholder || !info.pointId) return { world, doc, changed: false };
  if (doc.retiredPointIds.includes(info.pointId)) return { world, doc, changed: false };
  const nextDoc: SceneDoc = { ...doc, retiredPointIds: [...doc.retiredPointIds, info.pointId] };
  let nextWorld = world;
  const revision = appendDefinitionRevision(nextWorld, {
    authorNote: `系统占位「起点」标记 retired（R06 场景迁移）：历史引用保留，真实地点语境不再展示`,
    now: options.now,
  });
  if (revision.ok) nextWorld = revision.value;
  return { world: nextWorld, doc: nextDoc, changed: true };
}

// ---------------------------------------------------------------------------
// 场景游标语义（未知 vs lastConfirmed 分开）
// ---------------------------------------------------------------------------

export interface SceneStatus {
  /** 当前绑定游标是否落在已知地点 */
  known: boolean;
  /** 当前地点（known=true 时） */
  currentPointId: string | null;
  /** 最后一次确认的场景（known=false 且历史上有锚点时给出，与未知明确区分） */
  lastConfirmed: { pointId: string; pointName: string | null; at: number } | null;
  /** 起点占位信息（含 retired 列表过滤后的可见性） */
  placeholder: StartPlaceholderInfo & { retired: boolean };
}

export function resolveSceneStatus(world: World, doc: SceneDoc, currentPointId: string | null): SceneStatus {
  const fingerprint = detectStartPlaceholder(world);
  // retired 是历史事实：一旦占位进过 retired 列表，即便世界后来生长（指纹破裂），
  // 「占位已退役」仍然成立；isPlaceholder 只在指纹吻合且未退役时为 true。
  const retired = doc.retiredPointIds.length > 0;
  let lastConfirmed: SceneStatus["lastConfirmed"] = null;
  if (doc.lastConfirmed) {
    const point = (world.points ?? []).find((p) => String(p.id) === doc.lastConfirmed!.pointId);
    lastConfirmed = {
      pointId: doc.lastConfirmed.pointId,
      pointName: point ? point.name : null,
      at: doc.lastConfirmed.at,
    };
  }
  return {
    known: currentPointId !== null && currentPointId !== "",
    currentPointId,
    lastConfirmed,
    placeholder: {
      isPlaceholder: fingerprint.isPlaceholder && !retired,
      pointId: fingerprint.pointId,
      regionId: fingerprint.regionId,
      reasons: fingerprint.reasons,
      retired,
    },
  };
}

/** scene:<worldId> 文档键（与 maps:<worldId> 同款明文键风格）。 */
export function sceneDocKey(worldId: string): string {
  return `scene:${worldId}`;
}
