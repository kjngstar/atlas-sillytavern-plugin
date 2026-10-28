/**
 * atlas-scene-contradictions.ts — P10 §16.4/§16.5：有限、可核对的的空间矛盾识别。
 *
 * 三条边界先写清楚：
 * 1. **不冒充全检**：只判「来源与状态摆得出来」的几类；自然语言正文一律记进 `unevaluated`。
 * 2. **不改世界**：这里只产出发现，不改 `World`、不重写正文、不加一次「审查正文」的请求。
 * 3. **按顺序判**：先合理开门再通行是正常描写，不能因为「门锁着」就误报。
 */

import type { SpatialTraitV1 } from './atlas-spatial-facts.ts';
import type { PlanIssue } from './atlas-world-contract.ts';

export const SCENE_CONTRADICTION_CODES = [
  /** 没有开门/解锁事件，却声称穿过仍锁着、仍关闭的入口。 */
  'LOCKED_ENTRY_CROSSED',
  /** 把玻璃当可直接步行穿越。 */
  'GLASS_WALKED_THROUGH',
  /** 把已毁出口当有效通道。 */
  'DESTROYED_EXIT_USED',
  /** 对已知实体作明确相反方位断言，且双方确在同一参考系。 */
  'OPPOSITE_DIRECTION_CLAIM',
  /** 已识别的「看见」与明确遮挡相冲突。 */
  'SIGHT_THROUGH_OPAQUE',
] as const;
export type SceneContradictionCode = (typeof SCENE_CONTRADICTION_CODES)[number];

export type SceneClaimV1 = {
  claimId: string;
  actorId: string;
  /** 断言种类：只有这四种会被评估，其余进 unevaluated。 */
  kind: 'pass-through' | 'see-through' | 'direction' | 'take';
  objectId: string | null;
  /** 方向断言：正文声称的方向，与已知方向。 */
  direction?: string | null;
  observedDirection?: string | null;
  /** 参考系；两边必须同参考系才比较。 */
  referenceFrame?: string | null;
  observedReferenceFrame?: string | null;
  /** 同一楼层内的事件顺序，用来判断「先开门再通过」。 */
  sequence: number;
  turnId: string;
  eventId?: string | null;
};

/** 会让入口变成可通行的已确认事件（开门/解锁/破坏）。 */
export type SceneAccessEventV1 = {
  objectId: string;
  kind: 'open' | 'unlock' | 'break';
  sequence: number;
  turnId: string;
};

export type SceneContradictionInput = {
  traits?: readonly SpatialTraitV1[];
  claims?: readonly SceneClaimV1[];
  accessEvents?: readonly SceneAccessEventV1[];
  /** 已确认被摧毁的出口/通道。 */
  destroyedObjectIds?: readonly string[];
};

export type SceneContradictionV1 = {
  version: 1;
  /** 同一 floor/event/object/code 派生的稳定 ID。 */
  issueId: string;
  code: SceneContradictionCode;
  actorId: string;
  objectId: string | null;
  turnId: string;
  eventId: string | null;
  message: string;
  evidence: Record<string, unknown>;
};

export type UnevaluatedScopeV1 = { scope: string; reason: string };

export type SceneContradictionResult = {
  contradictions: SceneContradictionV1[];
  /** 明确没评估的范围：不用一个正则宣称所有空间矛盾都已识别。 */
  unevaluated: UnevaluatedScopeV1[];
};

/** 恒定断言语义：本模块永不改写世界真相。 */
export const CONTRADICTIONS_MUTATE_WORLD = false;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * §16.5：**同一 floor/event/object/code** 派生稳定 ID —— claimId 不参与。
 * 同一句正文被解析成两条 claim 是常事，claimId 进哈希会让同一个问题看起来像两个。
 */
export function sceneContradictionIssueId(input: { turnId: string; eventId?: string | null; objectId?: string | null; code: string }): string {
  return ['scene-contradiction', text(input?.turnId), text(input?.eventId) || '-', text(input?.objectId) || '-', text(input?.code)].join(':');
}

/** 按楼层与序号取「这条断言发生时」的实际状态：先开门再通行是正常的。 */
function accessBefore(accessEvents: readonly SceneAccessEventV1[], objectId: string, turnId: string, sequence: number): SceneAccessEventV1 | null {
  const sameScene = (accessEvents ?? [])
    .filter((event) => text(event?.objectId) === objectId && text(event?.turnId) === turnId && Number(event.sequence) < sequence)
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
  return sameScene.length ? sameScene[sameScene.length - 1] : null;
}

type Verdict = { code: SceneContradictionCode; message: string; evidence: Record<string, unknown> } | { skip: 'unevaluated'; reason: string } | null;

/**
 * 单条断言的判定。返回 `null` = 一致或无从判断但不值得记 unevaluated。
 */
function evaluateClaim(
  claim: SceneClaimV1,
  trait: SpatialTraitV1 | undefined,
  destroyed: boolean,
  access: SceneAccessEventV1 | null,
): Verdict {
  const objectId = text(claim?.objectId) || null;
  if (claim.kind === 'pass-through' || claim.kind === 'take') {
    if (!objectId) return { skip: 'unevaluated', reason: '断言没有绑定具体物体：无法核对穿透/拿取' };
    if (!trait) return { skip: 'unevaluated', reason: `物体 ${objectId} 没有空间属性：不猜它挡不挡路` };
    if (destroyed && claim.kind === 'pass-through') {
      return { code: 'DESTROYED_EXIT_USED', message: `${objectId} 已确认被摧毁，不能再当作有效通道。`, evidence: { objectId, destroyed: true } };
    }
    if (claim.kind === 'take') {
      // 拿取只在「明确遮挡且没有接触证据」时才算矛盾；首版不做接触事件推断。
      return { skip: 'unevaluated', reason: '拿取与遮挡的关系需要接触事件，首版不推断' };
    }
    if (access) return null; // 先开门/解锁/破坏再通过：按顺序更新，不误报。
    if (trait.kind === 'glass' && trait.blocksMovement === true) {
      return { code: 'GLASS_WALKED_THROUGH', message: '玻璃是实体隔断：可以直接看见，但不能直接走过去。', evidence: { objectId, kind: trait.kind, material: trait.material } };
    }
    if (trait.blocksMovement === true) {
      if (trait.kind === 'door' && trait.locked === true && trait.openingState !== 'open') {
        return { code: 'LOCKED_ENTRY_CROSSED', message: '门仍上锁且没有被打开的事件，却声称已经穿过。', evidence: { objectId, locked: true, openingState: trait.openingState } };
      }
      // 其他 blocked 情况（墙、关闭的窗）不强行归类：首版只覆盖计划点名的类型。
      return { skip: 'unevaluated', reason: `物体 ${objectId} 挡路但不是本次判定的类型（${trait.kind}）` };
    }
    if (trait.blocksMovement === null) return { skip: 'unevaluated', reason: `物体 ${objectId} 通行状态未知：未知不放行，也不判违规` };
    return null;
  }
  if (claim.kind === 'see-through') {
    if (!objectId) return { skip: 'unevaluated', reason: '看见断言没有绑定具体遮挡物' };
    if (!trait) return { skip: 'unevaluated', reason: `物体 ${objectId} 没有空间属性：不猜它挡不挡视线` };
    if (trait.blocksSight === true) {
      return { code: 'SIGHT_THROUGH_OPAQUE', message: '该物体明确阻挡视线，不能在被遮挡的同时「看见」。', evidence: { objectId, kind: trait.kind, blocksSight: true } };
    }
    if (trait.blocksSight === null) return { skip: 'unevaluated', reason: `物体 ${objectId} 遮挡状态未知：不判违规` };
    return null;
  }
  if (claim.kind === 'direction') {
    const direction = text(claim.direction);
    const observed = text(claim.observedDirection);
    if (!direction || !observed) return { skip: 'unevaluated', reason: '方位断言缺少一边的方向，无法比较' };
    const leftFrame = text(claim.referenceFrame) || 'unknown';
    const rightFrame = text(claim.observedReferenceFrame) || 'unknown';
    if (leftFrame !== rightFrame || leftFrame === 'unknown') {
      return { skip: 'unevaluated', reason: `方位断言不在同一参考系（${leftFrame} vs ${rightFrame}）：不比较` };
    }
    if (direction === observed) return null;
    return { code: 'OPPOSITE_DIRECTION_CLAIM', message: `同一参考系下方位相反：正文说 ${direction}，已知是 ${observed}。`, evidence: { referenceFrame: leftFrame, direction, observed } };
  }
  return { skip: 'unevaluated', reason: `未登记的断言种类 ${String((claim as { kind?: unknown }).kind)}` };
}

/**
 * §16.4：只做「可证实」的判定。输入是已接受的事件/位置变化、来源片段、空间事实与状态变更，
 * **不新增一次专门审查正文的请求**。
 */
export function detectSceneContradictions(input: SceneContradictionInput): SceneContradictionResult {
  const traits = new Map<string, SpatialTraitV1>();
  for (const trait of input?.traits ?? []) {
    const id = text(trait?.objectId);
    if (id && !traits.has(id)) traits.set(id, trait);
  }
  const destroyed = new Set((input?.destroyedObjectIds ?? []).map((id) => text(id)).filter(Boolean));
  const unevaluated: UnevaluatedScopeV1[] = [
    { scope: 'free-text-narration', reason: '自然语言正文不做全检：只核对结构化事件与已知空间事实能对上的部分' },
  ];
  const found = new Map<string, SceneContradictionV1>();

  for (const claim of input?.claims ?? []) {
    const objectId = text(claim?.objectId) || null;
    const trait = objectId ? traits.get(objectId) : undefined;
    const access = objectId ? accessBefore(input?.accessEvents ?? [], objectId, text(claim.turnId), Number(claim.sequence)) : null;
    const verdict = evaluateClaim(claim, trait, objectId ? destroyed.has(objectId) : false, access);
    if (!verdict) continue;
    if ('skip' in verdict) {
      unevaluated.push({ scope: `${claim.kind}:${objectId ?? claim.claimId}`, reason: verdict.reason });
      continue;
    }
    const issueId = sceneContradictionIssueId({ turnId: text(claim.turnId), eventId: claim.eventId ?? null, objectId, code: verdict.code });
    if (found.has(issueId)) continue;
    found.set(issueId, {
      version: 1,
      issueId,
      code: verdict.code,
      actorId: text(claim.actorId),
      objectId,
      turnId: text(claim.turnId),
      eventId: text(claim.eventId) || null,
      message: verdict.message,
      evidence: { ...verdict.evidence, claimId: text(claim.claimId) },
    });
  }

  const contradictions = [...found.values()].sort((left, right) => (left.issueId < right.issueId ? -1 : left.issueId > right.issueId ? 1 : 0));
  return { contradictions, unevaluated: dedupeUnevaluated(unevaluated) };
}

function dedupeUnevaluated(scopes: readonly UnevaluatedScopeV1[]): UnevaluatedScopeV1[] {
  const seen = new Set<string>();
  const out: UnevaluatedScopeV1[] = [];
  for (const scope of scopes) {
    const key = `${scope.scope}|${scope.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(scope);
  }
  return out;
}

/**
 * §16.5：下一轮只强调**仍适用**的约束，不把警告永久附到每轮。
 * 「仍适用」= 该物体当前的属性还和当初判定时一致。
 */
export function stillApplicable(contradiction: SceneContradictionV1, traits: readonly SpatialTraitV1[]): boolean {
  const objectId = text(contradiction?.objectId);
  if (!objectId) return false;
  const trait = (traits ?? []).find((candidate) => text(candidate?.objectId) === objectId);
  if (!trait) return false;
  switch (contradiction.code) {
    case 'GLASS_WALKED_THROUGH':
    case 'LOCKED_ENTRY_CROSSED':
      return trait.blocksMovement === true;
    case 'SIGHT_THROUGH_OPAQUE':
      return trait.blocksSight === true;
    case 'DESTROYED_EXIT_USED':
    case 'OPPOSITE_DIRECTION_CLAIM':
      return false; // 这两类没有「状态仍适用」的概念，只记当轮。
    default:
      return false;
  }
}

export type NextTurnConstraintV1 = { issueId: string; code: SceneContradictionCode; message: string };

/**
 * 下一轮上下文用的约束集：本轮 + 仍适用的历史条目，按 issueId 去重、上限 3 条。
 * 不刷屏、不重复、不把旧警告当新事实。
 */
export function constraintsForNextTurn(
  contradictions: readonly SceneContradictionV1[],
  traits: readonly SpatialTraitV1[],
  options: { currentTurnId: string; limit?: number },
): NextTurnConstraintV1[] {
  const limit = Math.max(1, Math.floor(Number.isFinite(options?.limit) ? Number(options.limit) : 3));
  const current = text(options?.currentTurnId);
  const out: NextTurnConstraintV1[] = [];
  for (const contradiction of contradictions) {
    if (out.length >= limit) break;
    const isCurrent = current.length > 0 && text(contradiction?.turnId) === current;
    if (!isCurrent && !stillApplicable(contradiction, traits)) continue;
    if (out.some((entry) => entry.issueId === contradiction.issueId)) continue;
    out.push({ issueId: contradiction.issueId, code: contradiction.code, message: contradiction.message });
  }
  return out;
}

/** 转成诊断条目（工作台提示 + 诊断记录），不碰正文。 */
export function contradictionsToDiagnostics(contradictions: readonly SceneContradictionV1[]): PlanIssue[] {
  return (contradictions ?? []).map((contradiction) => ({
    code: contradiction.code,
    path: `$.scene.claims.${contradiction.issueId}`,
    message: contradiction.message,
    severity: 'warning' as const,
    retryable: false,
  }));
}
