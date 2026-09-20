/**
 * atlas-geo-apply.ts — 0.9.31 每轮新地点确定性并入（纯函数）。
 *
 * 作者需求：每轮推演时判断有没有新地点加入。账本 effect 白名单（lib/ 快照）没有
 * addPoint/addRegion，推演不能造点——本模块把模型在本轮 JSON 里顺带输出的
 * newLocations（{name, regionName?, description?}）在 commit 时直接并入世界：
 * 与 /worlds/geo/adopt 同款口径——重名跳过、黄金角螺旋布点、只增不改、定义修订。
 * 不发任何请求：地名来自推演 JSON，归属与坐标全部本地确定性计算。
 */

import type { World } from "../lib/world-schema.ts";
import { appendDefinitionRevision } from "../lib/world-definition.ts";
import { hashString } from "../lib/world-cards.ts";

/** 单轮新地点上限（与 geo 提炼口径一致：宁缺毋滥）。 */
export const NEW_LOCATIONS_MAX = 12;
const NAME_CHARS = 40;
const DESC_CHARS = 300;

export interface NewLocationDraft {
  name: string;
  regionName?: string;
  description?: string;
}

export interface GeoAdoptOutcome {
  world: World;
  regionsAdded: number;
  pointsAdded: number;
  skipped: number;
  regionNames: string[];
  pointNames: string[];
  revisionAppended: boolean;
}

/** 不可信 newLocations 清洗：坏条目丢弃（name 必填；字段截断；条目封顶）。 */
export function sanitizeNewLocations(raw: unknown): NewLocationDraft[] {
  if (!Array.isArray(raw)) return [];
  const result: NewLocationDraft[] = [];
  for (const item of raw.slice(0, NEW_LOCATIONS_MAX * 2)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const name = String(record.name ?? "").trim().replace(/\s+/g, " ").slice(0, NAME_CHARS);
    if (!name) continue;
    const regionName = String(record.regionName ?? "").trim().replace(/\s+/g, " ").slice(0, NAME_CHARS);
    const description = String(record.description ?? "").trim().replace(/\s+/g, " ").slice(0, DESC_CHARS);
    result.push({
      name,
      ...(regionName ? { regionName } : {}),
      ...(description ? { description } : {}),
    });
    if (result.length >= NEW_LOCATIONS_MAX) break;
  }
  return result;
}

/**
 * 把新地点 / 新地区并入世界（/worlds/geo/adopt 同款口径）：
 * 重名跳过；regionName 解析不到已有地区 → 归入起始地区（与 geo 提炼一致）；
 * 黄金角螺旋布点绕中心散开，绝不与已有点重叠；成功后追加定义修订。
 * 没有新增 → 原世界原样返回（零写入）。
 */
export function applyNewLocations(
  world: World,
  locations: NewLocationDraft[],
  options: { now: number },
): GeoAdoptOutcome {
  const empty: GeoAdoptOutcome = {
    world,
    regionsAdded: 0,
    pointsAdded: 0,
    skipped: 0,
    regionNames: [],
    pointNames: [],
    revisionAppended: false,
  };
  if (!Array.isArray(locations) || locations.length === 0) return empty;

  const clean = (text: unknown): string => String(text ?? "").trim().replace(/\s+/g, " ");
  const norm = (text: string) => text.toLowerCase();

  const existingRegionNames = new Set((world.regions ?? []).map((r) => norm(clean(r.name))));
  const existingPointNames = new Set((world.points ?? []).map((p) => norm(clean(p.name))));
  const regionIdByName = new Map((world.regions ?? []).map((r) => [norm(clean(r.name)), String(r.id)]));

  let skipped = 0;
  const newRegions: Array<{ id: string; worldId: string; name: string; type: "other"; description: string; coordinates: { x: number; y: number } }> = [];
  for (const item of locations) {
    if (newRegions.length >= 6) break; // 单轮地区上限（地点为主，地区少量）
    if (existingRegionNames.has(norm(item.name))) {
      skipped += 1;
      continue;
    }
    const id = `turn-r-${hashString(`${world.id}|r|${item.name}|${options.now}`)}`;
    newRegions.push({
      id,
      worldId: world.id,
      name: item.name,
      type: "other",
      description: item.description || "由剧情推演提炼。",
      coordinates: { x: 0, y: 0 },
    });
    existingRegionNames.add(norm(item.name));
    regionIdByName.set(norm(item.name), id);
  }

  const nextPointIdBase = (world.points ?? []).reduce((max, p) => Math.max(max, Number(p.id) || 0), 0) + 1;
  const newPoints: Array<{ id: number; name: string; x: number; y: number; regionId?: string }> = [];
  for (const item of locations) {
    if (newPoints.length >= NEW_LOCATIONS_MAX) break;
    if (existingPointNames.has(norm(item.name))) {
      skipped += 1;
      continue;
    }
    const regionId = (item.regionName ? regionIdByName.get(norm(item.regionName)) : null) ?? "start";
    const index = newPoints.length;
    const angle = index * 2.39996;
    const radius = 14 + 3.4 * Math.sqrt(index + 1);
    newPoints.push({
      id: nextPointIdBase + newPoints.length,
      name: item.name,
      x: Math.round(Math.min(96, Math.max(4, 50 + radius * Math.cos(angle)))),
      y: Math.round(Math.min(96, Math.max(4, 50 + radius * Math.sin(angle)))),
      regionId,
    });
    existingPointNames.add(norm(item.name));
  }

  if (newRegions.length === 0 && newPoints.length === 0) {
    return { ...empty, skipped };
  }

  let updated: World = {
    ...world,
    regions: [...(world.regions ?? []), ...newRegions],
    points: [...(world.points ?? []), ...newPoints],
    updatedAt: options.now,
  };
  const revision = appendDefinitionRevision(updated, {
    authorNote: `剧情推演新地点：+${newRegions.length} 地区 +${newPoints.length} 地点`,
    now: options.now,
  });
  if (revision.ok) updated = revision.value;

  return {
    world: updated,
    regionsAdded: newRegions.length,
    pointsAdded: newPoints.length,
    skipped,
    regionNames: newRegions.map((r) => r.name),
    pointNames: newPoints.map((p) => p.name),
    revisionAppended: revision.ok,
  };
}
