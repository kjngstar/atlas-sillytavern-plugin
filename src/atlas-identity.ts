/**
 * atlas-identity.ts — R07 人物身份解析与消歧（纯函数）。
 *
 * 对应《修复计划》R07：
 * - canonical ID 唯一，displayName / aliases 只是称呼——「临时称呼不是临时身份」；
 * - 引用解析：精确 ID → 精确名字 / 别名；同名或别名撞车 = 歧义，**不强行合并**；
 * - identityUpdates 更新 displayName / aliases（不重建实体）；
 * - 别名合并有界（每实体封顶），重复别名幂等。
 */

import type { Character, EntityRecord, World } from "../lib/world-schema.ts";

/** 每实体别名上限（tags 字段复用；有界防膨胀）。 */
export const ALIASES_MAX = 16;

export interface EntityRefResolution {
  id: string | null;
  /** 歧义：多个实体匹配同一称呼——调用方必须拒绝，不得挑第一个 */
  ambiguous: boolean;
  candidates: string[];
}

interface IdentityEntry {
  id: string;
  name: string;
  aliases: string[];
}

function identityEntries(world: World): IdentityEntry[] {
  const entries: IdentityEntry[] = [];
  const aliasOf = (c: { tags?: string[] } | undefined): string[] =>
    Array.isArray(c?.tags) ? c.tags.filter((t) => typeof t === "string" && t.trim()) : [];
  for (const c of world.characters ?? []) {
    entries.push({ id: String(c.id), name: String(c.name ?? "").trim(), aliases: aliasOf(c) });
  }
  for (const e of (world.entityRecords ?? []) as EntityRecord[]) {
    if (String(e.type).toLowerCase() !== "npc") continue;
    const id = String(e.id);
    const existing = entries.find((entry) => entry.id === id);
    if (existing) {
      // 同一 id：合并别名（characters 与 entityRecords 冗余双写场景）
      const merged = new Set([...existing.aliases, ...aliasOf(e as unknown as { tags?: string[] })]);
      existing.aliases = [...merged];
    } else {
      entries.push({ id, name: String(e.name ?? "").trim(), aliases: aliasOf(e as unknown as { tags?: string[] }) });
    }
  }
  return entries;
}

/**
 * 实体引用解析：精确 ID 优先；否则 displayName / 别名的**精确**名字匹配。
 * 多个实体命中同一称呼 → ambiguous=true（同场多个女性或同名人物时不强行合并）。
 */
export function resolveEntityByRef(world: World, ref: string): EntityRefResolution {
  const cleaned = String(ref ?? "").trim();
  if (!cleaned) return { id: null, ambiguous: false, candidates: [] };
  const entries = identityEntries(world);
  const byId = entries.find((e) => e.id === cleaned);
  if (byId) return { id: byId.id, ambiguous: false, candidates: [byId.id] };
  const matched = entries.filter(
    (e) => (e.name && e.name === cleaned) || e.aliases.includes(cleaned),
  );
  if (matched.length === 1) return { id: matched[0]!.id, ambiguous: false, candidates: [matched[0]!.id] };
  if (matched.length > 1) {
    return { id: null, ambiguous: true, candidates: matched.map((m) => m.id) };
  }
  return { id: null, ambiguous: false, candidates: [] };
}

/** 已知实体别名/名字合并后的标签列表（幂等去重 + 封顶，原有标签保留在前）。 */
export function mergeAliases(existing: string[] | undefined, addAliases: string[]): string[] {
  const merged: string[] = [];
  for (const tag of [...(existing ?? []), ...addAliases]) {
    const cleaned = String(tag ?? "").trim();
    if (cleaned && !merged.includes(cleaned)) merged.push(cleaned);
    if (merged.length >= ALIASES_MAX) break;
  }
  return merged;
}

/**
 * identityUpdates 应用（不重建实体）：更新 Character.name + EntityRecord.name（displayName
 * 非空时）并把 addAliases 并入 tags。返回新世界与被更新实体（供审计）。
 * 无匹配 / 无实际变化的条目原样跳过（调用方决定是否警告）。
 */
export function applyIdentityUpdates(
  world: World,
  updates: Array<{ entityId: string; displayName: string; addAliases: string[] }>,
): { world: World; updatedIds: string[] } {
  if (updates.length === 0) return { world, updatedIds: [] };
  const byId = new Map(updates.map((u) => [u.entityId, u] as const));
  let changed = false;
  const updatedIds: string[] = [];

  const characters: Character[] = (world.characters ?? []).map((c) => {
    const id = String(c.id);
    const update = byId.get(id);
    if (!update) return c;
    const name = update.displayName || String(c.name ?? "");
    const tags = mergeAliases(c.tags, update.addAliases);
    const tagsChanged = JSON.stringify(tags) !== JSON.stringify(c.tags ?? []);
    if (name === c.name && !tagsChanged) return c;
    updatedIds.push(id);
    changed = true;
    return { ...c, name, ...(tags.length > 0 ? { tags } : {}) };
  });

  const records: EntityRecord[] = (world.entityRecords ?? []).map((e) => {
    const id = String(e.id);
    const update = byId.get(id);
    if (!update) return e;
    const name = update.displayName || String(e.name ?? "");
    const tags = mergeAliases((e as unknown as { tags?: string[] }).tags, update.addAliases);
    const tagsChanged = JSON.stringify(tags) !== JSON.stringify((e as unknown as { tags?: string[] }).tags ?? []);
    if (name === e.name && !tagsChanged) return e;
    if (!updatedIds.includes(id)) updatedIds.push(id);
    changed = true;
    return { ...e, name, ...(tags.length > 0 ? { tags } : {}) } as EntityRecord;
  });

  if (!changed) return { world, updatedIds };
  return { world: { ...world, characters, entityRecords: records }, updatedIds };
}
