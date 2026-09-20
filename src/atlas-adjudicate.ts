/**
 * atlas-adjudicate.ts — 0.9.0 算法裁决层（纯函数，零 API、零 DOM、零随机）。
 *
 * 作者 2026-09-19 反馈：「推演不能纯靠提示词——地点和网格地图坐标配套的算法要配合上」。
 * 借鉴 shujuku agent 决策引擎的思路（算法排序候选、AI 只做裁决）并反转职责：
 * **算法裁定事实，AI 负责叙述。**
 *
 * - 移动：locationChange 目的地必须是已知地点（未知 → 丢弃移动，不再炸整单）；
 *   已知 → 共享网格旅行算法 `buildTravelHint`（基线 + 地形 + 速度档）给出权威耗时，
 *   AI duration 只能加码不能低估：duration = max(aiDuration, travelPeriods)。
 *   非移动回合（无 locationChange）时间仍由 AI 全权推断——事件性推进不受影响。
 * - 实体：npcChanges / memoryDrafts 的 entityId 必须是已知实体
 *   （world.characters ∪ world.entityRecords），未知引用整条丢弃并记录
 *   （此前只有提示词约束，算法不强制）。
 * - 裁定说明合入 summary 尾部（〔裁定〕前缀）——账本 / 回执 / 变化页全程可审计。
 *
 * 0.9.1 时间辅助：用户行动文本的显式时间词（"用了一会儿""花了半天"）→ 耗时下限；
 * 有世界变化但 AI 给 0 时段 → 保底推进 1 时段（时间随变化流动）。抽取器见 atlas-time-intent.ts。
 */

import type { World } from "../lib/world-schema.ts";
import { W0_LIMITS } from "../lib/world-schema.ts";
import { buildTravelHint } from "../lib/world-engine.ts";
import type { AtlasWorldChangeDraft } from "./atlas-turn.ts";
import { extractAtlasTimeIntent } from "./atlas-time-intent.ts";

export interface AtlasAdjudicationResult {
  /** 裁决后的草稿（同形状；只收紧、不放松） */
  draft: AtlasWorldChangeDraft;
  /** 独立的裁定说明（同时已合入 draft.summary 尾部） */
  notes: string[];
}

function knownEntityIds(world: World): Set<string> {
  const ids = new Set<string>();
  for (const c of world.characters ?? []) ids.add(String(c.id));
  for (const e of world.entityRecords ?? []) ids.add(String(e.id));
  return ids;
}

/** 裁决不可信草稿：只收紧不放松；同输入 + 同世界状态 → 同输出。 */
export function adjudicateAtlasDraft(
  world: World,
  input: {
    branchId: string | null;
    /** 本回合开始时的位置（绑定游标） */
    currentPointId: string | null;
    /** 用户行动原文（0.9.1：显式时间词 → 耗时下限；缺省不参与） */
    userText?: string | null;
    draft: AtlasWorldChangeDraft;
  },
): AtlasAdjudicationResult {
  const draft = input.draft;
  const notes: string[] = [];

  const aiDuration =
    typeof draft.duration === "number" && Number.isFinite(draft.duration) && draft.duration >= 0
      ? Math.floor(draft.duration)
      : 0;
  const rawEffects: unknown[] = Array.isArray(draft.rawEffects) ? [...draft.rawEffects] : [];
  const memoryDrafts: Array<{ entityId: string; text: string }> = Array.isArray(draft.memoryDrafts)
    ? draft.memoryDrafts.map((m) => ({ entityId: String(m?.entityId ?? ""), text: String(m?.text ?? "") }))
    : [];
  const next: AtlasWorldChangeDraft = {
    duration: aiDuration,
    locationChange: draft.locationChange ?? null,
    rawEffects,
    memoryDrafts,
    summary: draft.summary,
    // 0.9.32 透传：新地点不在裁定范围（commit 时 sanitizeNewLocations 清洗 + 确定性并入），
    // 但重建 draft 时必须带上——此前被整组丢弃，回执永远不注明「新增地点」。
    ...(Array.isArray(draft.newLocations) ? { newLocations: [...draft.newLocations] } : {}),
  };

  // 1) 位置：未知地点 → 丢弃移动；已知 → 网格旅行算法裁定耗时下限
  const rawToPointId =
    next.locationChange && typeof next.locationChange.toPointId === "string"
      ? next.locationChange.toPointId.trim()
      : "";
  if (next.locationChange && rawToPointId) {
    const toPoint = (world.points ?? []).find((p) => String(p.id) === String(rawToPointId));
    if (!toPoint) {
      notes.push(`〔裁定〕忽略未知地点「${rawToPointId.slice(0, 32)}」的移动`);
      next.locationChange = null;
    } else if (input.currentPointId) {
      const hint = buildTravelHint(world, { fromPointId: String(input.currentPointId), toPointId: rawToPointId });
      const travelPeriods = Math.max(0, Math.round(hint.suggestedPeriods));
      if (travelPeriods > aiDuration) {
        notes.push(`〔裁定〕旅程 ${hint.distance.cells} 格 → 耗时 ${travelPeriods} 时段（网格算法；AI 给 ${aiDuration}）`);
        next.duration = travelPeriods;
      }
    }
  }

  // 1b) 0.9.1 时间意图：用户文本里的显式时间词 → 耗时下限（动作数量只是 prepare 软引导，不作硬限）
  if (input.userText) {
    const intent = extractAtlasTimeIntent(input.userText);
    if (intent.suggestedPeriods !== null && intent.suggestedPeriods > (next.duration ?? 0)) {
      notes.push(
        `〔裁定〕行动文本出现时间词「${intent.timeWords.join("、")}」→ 至少 ${intent.suggestedPeriods} 时段（AI 给 ${next.duration ?? 0}）`,
      );
      next.duration = intent.suggestedPeriods;
    }
  }

  // 1c) 0.9.1 保底：世界确实发生了变化 / 位移，但 AI 给 0 时段 → 时间必须随变化流动
  const hasChange =
    (next.locationChange && (next.locationChange.toPointId || next.locationChange.toRegionId)) ||
    (next.rawEffects ?? []).length > 0 ||
    (next.memoryDrafts ?? []).length > 0;
  if (hasChange && (next.duration ?? 0) < 1) {
    notes.push(`〔裁定〕有世界变化但 AI 给 0 时段 → 保底推进 1 时段`);
    next.duration = 1;
  }

  // 2) 实体白名单：引用未知实体的 effect / 记忆整条丢弃
  //    （无 entityId 的形状（如 setFlag）与解析失败项仍交给 commit 的 parseStateEffect 严格拒绝）
  //    0.9.29：moveEntity 的目的地同样算法裁定——未知地点 / 未知地区整条丢弃（同 locationChange 口径）
  const known = knownEntityIds(world);
  const beforeEffects = rawEffects.length;
  next.rawEffects = rawEffects.filter((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return true;
    const record = raw as { entityId?: unknown; kind?: unknown; pointId?: unknown; regionId?: unknown };
    if (record.kind === "moveEntity") {
      const pointId = typeof record.pointId === "string" ? record.pointId.trim() : "";
      const regionId = typeof record.regionId === "string" ? record.regionId.trim() : "";
      const pointKnown = !pointId || (world.points ?? []).some((p) => String(p.id) === String(pointId));
      const regionKnown = !regionId || (world.regions ?? []).some((r) => String(r.id) === String(regionId));
      if (!pointKnown || !regionKnown) {
        notes.push(`〔裁定〕忽略引用未知${!pointKnown ? "地点" : "地区"}的人物移动`);
        return false;
      }
    }
    const entityId = record.entityId;
    if (typeof entityId !== "string" || entityId.trim() === "") return true;
    return known.has(entityId.trim());
  });
  next.rawEffects = next.rawEffects ?? [];
  const droppedEffects = beforeEffects - (next.rawEffects ?? []).length;
  if (droppedEffects > 0) notes.push(`〔裁定〕丢弃 ${droppedEffects} 条引用未知实体的变化`);

  const beforeMemories = memoryDrafts.length;
  next.memoryDrafts = memoryDrafts.filter(
    (m) => m.entityId.trim() !== "" && m.text.trim() !== "" && known.has(m.entityId.trim()),
  );
  next.memoryDrafts = next.memoryDrafts ?? [];
  const droppedMemories = beforeMemories - (next.memoryDrafts ?? []).length;
  if (droppedMemories > 0) notes.push(`〔裁定〕丢弃 ${droppedMemories} 条未知实体的记忆`);

  // 3) 裁定说明合入 summary 尾部（账本 / 回执 / 变化页全程可审计；有界截断）
  if (notes.length > 0) {
    const base = next.summary.trim();
    const merged = `${base}${base ? "；" : ""}${notes.join("；")}`;
    next.summary = merged.slice(0, W0_LIMITS.maxStateEventSummary);
  }
  return { draft: next, notes };
}
