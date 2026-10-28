/**
 * atlas-spatial-perception.ts — 感知候选与保密过滤（P07 §13.3）。
 *
 * 这一层的产出**永远只是候选**：可能看到了、可能听到了。它不是「已经注意」、
 * 不是「已经认识」、更不是「已经相信」——所以它绝不直接写 `knowledge`。
 *
 * 纪律：
 * - 未知遮挡结果保持不确定，**不以 unknown 自动放行**（宁可少给一条线索）。
 * - 后台隐藏 NPC 的身份、当前位置、秘密房间细节不原样进主角正文。
 * - 已观察人物的位置可给几何；`last-known` 位置必须带时点，不得标成当前实测。
 * - 复杂遮挡 / 能否绕行 / 是否注意交给既有模型阶段判断；本模块只做保守过滤。
 */

import type { PlanIssue } from './atlas-world-contract.ts';
import type { ActorSpatialFactsV1, SpatialTraitV1 } from './atlas-spatial-facts.ts';

export const PERCEPTION_KINDS = ['sighting', 'sound', 'presence', 'passage'] as const;
export type PerceptionKind = (typeof PERCEPTION_KINDS)[number];

export type PerceptionCandidate = {
  candidateId: string;
  kind: PerceptionKind;
  /** 感知到的对象（人物 / 物体 / 空间）。 */
  subjectId: string;
  /** 相关空间物体（可空）。 */
  objectId: string | null;
  /** 依据：`observed` = 当前可观察；`inferred` = 由相邻/声音等弱线索推得。 */
  basis: 'observed' | 'inferred';
  /** **恒为 possible**：候选不宣布确定性。 */
  certainty: 'possible';
  /** 恒为 true：候选只能作为评估材料，不能直接落到角色知识或正文事实。 */
  evaluationOnly: true;
};

export type PerceptionResult = {
  candidates: PerceptionCandidate[];
  issues: PlanIssue[];
};

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/** 视线是否被这张属性挡住：只有明确 `blocksSight === false` 才算「能看见」。 */
function sightOpen(trait: SpatialTraitV1): boolean {
  return trait.blocksSight === false;
}

/**
 * §13.3：为某个角色生成感知候选。
 *
 * 只对**已投影给该角色**的物体生成；秘密与隐匿物体在投影阶段已经不在 `observed` 里，
 * 这里再挡一次是为了防止调用方绕过投影直接塞进来。
 */
export function buildPerceptionCandidates(input: {
  projection: ActorSpatialFactsV1;
  /** 观察者所在空间/物体（可空）。 */
  observerObjectId?: unknown;
  /** 可能被感知到的对象；没给就只用投影里的物体。 */
  subjects?: readonly { subjectId: unknown; atObjectId?: unknown; kind?: unknown }[];
  /** 明确不可感知的物体（秘密空间、隐形等）。 */
  blockedObjectIds?: readonly string[];
}): PerceptionResult {
  const issues: PlanIssue[] = [];
  const projection = input?.projection;
  const blocked = new Set((input?.blockedObjectIds ?? []).map(text).filter((id) => id.length > 0));
  const observerObjectId = text(input?.observerObjectId);

  if (!projection || text(projection.actorId).length === 0) {
    issues.push({
      code: 'PERCEPTION_ACTOR_MISSING',
      path: '$.perception.actorId',
      message: '没有角色 ID 就没有观察者：不生成任何候选（避免把玩家全知视角当角色感知）。',
      severity: 'error',
      retryable: false,
    });
    return { candidates: [], issues };
  }

  // 只有「当前可观察」的物体能支撑观察类候选。
  const observable = new Map<string, SpatialTraitV1>();
  for (const trait of projection.observed ?? []) {
    if (blocked.has(trait.objectId)) continue;
    observable.set(trait.objectId, trait);
  }

  const candidates: PerceptionCandidate[] = [];
  const push = (candidate: PerceptionCandidate): void => {
    if (candidates.some((existing) => existing.candidateId === candidate.candidateId)) return;
    candidates.push(candidate);
  };

  const subjects = (input?.subjects ?? []).map((subject) => ({
    subjectId: text(subject?.subjectId),
    atObjectId: text(subject?.atObjectId),
    kind: text(subject?.kind).toLowerCase(),
  })).filter((subject) => subject.subjectId.length > 0);

  for (const subject of subjects) {
    const here = subject.atObjectId;
    // 同一空间内：视为 presence 候选（不是「已经看见脸」）。
    if (here.length > 0 && here === observerObjectId) {
      push({
        candidateId: `${projection.actorId}:presence:${subject.subjectId}`,
        kind: 'presence',
        subjectId: subject.subjectId,
        objectId: here,
        basis: 'observed',
        certainty: 'possible',
        evaluationOnly: true,
      });
      continue;
    }
    if (here.length === 0) {
      // 位置未知：不给候选。未知不是「就在附近」。
      continue;
    }
    const container = observable.get(here) ?? null;
    if (!container) {
      // 目标所在空间对该角色不可观察 → 不给候选（不泄漏隐藏房间里的 NPC）。
      continue;
    }
    if (!sightOpen(container)) {
      // 视线被挡或状态未知：不生成 sighting。**未知不放行**。
      if (container.blocksSight === null) {
        issues.push({
          code: 'PERCEPTION_SIGHT_UNKNOWN',
          path: `$.perception.${projection.actorId}.${subject.subjectId}`,
          message: `物体 ${container.objectId} 的遮挡状态未知：按保守处理不生成目击候选，等明确档案再判断。`,
          severity: 'warning',
          retryable: false,
        });
      }
      continue;
    }
    push({
      candidateId: `${projection.actorId}:sighting:${subject.subjectId}`,
      kind: 'sighting',
      subjectId: subject.subjectId,
      objectId: here,
      basis: 'observed',
      certainty: 'possible',
      evaluationOnly: true,
    });
  }

  candidates.sort((left, right) => (left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0));
  return { candidates, issues };
}

/**
 * 候选能不能直接变成角色知识？**永远不能。**
 *
 * 存在的意义是把「不许直接写 knowledge」变成可断言的函数，而不是靠注释约束：
 * 想升级成知识，必须走 decision 阶段的 information 提议，经正常校验。
 */
export function canPromoteToKnowledge(): false {
  return false;
}

/**
 * 给正文的感知摘要：只描述**当前可观察**的事实，不贴来源标签、不给精确米数。
 *
 * 未标定图（只有格）不输出任何距离描述 —— 说「大约五步」比说「2.5 米」诚实。
 */
export function summarizePerceptionForNarration(input: {
  projection: ActorSpatialFactsV1;
  candidates?: readonly PerceptionCandidate[];
}): { lines: string[]; issues: PlanIssue[] } {
  const lines: string[] = [];
  const issues: PlanIssue[] = [];
  const projection = input?.projection;
  if (!projection) return { lines, issues };

  const seen = (input?.candidates ?? []).filter((candidate) => candidate.kind === 'presence' || candidate.kind === 'sighting');
  for (const candidate of seen) {
    lines.push(candidate.kind === 'presence'
      ? `同一空间内有人（${candidate.subjectId}）`
      : `可以看到 ${candidate.subjectId}`);
  }

  // 当前可观察的通道：门/窗只描述「通/不通」，不给数值。
  for (const trait of projection.observed ?? []) {
    if (trait.kind !== 'door' && trait.kind !== 'window') continue;
    if (trait.blocksMovement === false) lines.push(`${trait.objectId} 可以通过`);
    else if (trait.blocksMovement === true) lines.push(`${trait.objectId} 目前挡路`);
    else lines.push(`${trait.objectId} 通不通还不确定`);
  }

  if (projection.metersPerCell === null) {
    issues.push({
      code: 'NARRATION_NO_METRICS',
      path: '$.narration.spatial',
      message: '该图未标定：正文不给米数或里程，只用相对描述。',
      severity: 'warning',
      retryable: false,
    });
  }

  return { lines: [...new Set(lines)].sort(), issues };
}
