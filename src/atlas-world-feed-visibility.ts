/**
 * atlas-world-feed-visibility.ts — M5-04：按历史见闻过滤事件（02 §7.2 / E04/E05/E06）。
 *
 * 五条硬规则：
 * 1. **作者看得到后台，但都标 background**：作者视角不裁剪，但卡片不冒充「主角已知」。
 * 2. **POV 只认三种依据**：主角是该事件的合格参与者；当时程序支持的直接见闻
 *    （**具体同场**，不是同一座城市）；或者拿到了对应 information 的有效 knowledge。
 * 3. **拿到转述只给消息卡**：POV 只有一条 report/rumor 时，事件卡必须撤掉，
 *    只留 information 自己的 content —— 秘密事件摘要一个字都不能出现。
 * 4. **过去就是过去**：位置与知识一律按该回合的历史快照判定；
 *    绝不使用当前 `sqlVisibility.here`，也不因为「事件 public + 地点已发现」就自动全知。
 * 5. **不下发隐藏量**：POV 结果只含可见项，不带隐藏条数、隐藏 ID、隐藏标题。
 *    被过滤掉的项在 POV 模式下连 issue 都不产生（issue 里也会漏 ID）。
 *
 * 只读：不写库、不改 knowledge、不建事务。
 */

import type { PlanIssue, ViewMode, WorldFeedItem } from './atlas-world-contract.ts';

/** 事件卡的保密级别（来自 events.secrecy）。 */
export type FeedSecrecy = 'public' | 'restricted' | 'secret';

/** POV 在某个回合持有的知识（由 M5-01 的历史快照重建）。 */
export type KnowledgeFact = {
  knowledgeId: string;
  informationId: string;
  /** information.kind：observation 是一手观察，report/rumor 是转述。 */
  informationKind: string;
  sourceEventId: string | null;
  knowerCharacterId: string | null;
  isPov: boolean;
  belief: string;
  status: string;
};

/**
 * 统一的内部候选形状：两个生产器（事件卡 / 动向卡）都适配到这里再过滤，
 * 这样可见性规则只有一份，不会各写各的。
 */
export type FeedCandidate = {
  item: WorldFeedItem;
  /** 事件行 ID（仅事件卡有）。 */
  eventId?: string | null;
  /** 该卡依赖的 knowledge ID（消息/发现卡）。 */
  knowledgeId?: string | null;
  /** 事件参与者（人物/物品/地点）实体 ID。 */
  participantIds?: readonly string[];
  /** 事件发生的**具体**地点；同场判定用它，绝不用城市。 */
  locationId?: string | null;
  secrecy?: FeedSecrecy | null;
  planOnly?: boolean;
};

export type FeedVisibilityContext = {
  viewMode: ViewMode;
  povId: string | null;
  /**
   * 该回合当时的 POV 所在具名地点（历史重建）。
   * 缺省返回 null —— 绝不允许退回当前所在位置。
   */
  povPlaceAtTurn?: (turnId: string) => string | null;
  /** 该回合当时的 POV 有效知识（历史重建）。 */
  knowledgeAtTurn?: (turnId: string) => readonly KnowledgeFact[];
  /** POV 视角下允许出现的实体 ID（已探索地点、已知人物等）。缺省为空集。 */
  visibleEntityIds?: ReadonlySet<string>;
};

export type FeedVisibilityResult = {
  items: WorldFeedItem[];
  issues: PlanIssue[];
};

function planIssue(code: string, path: string, message: string, extra: Partial<PlanIssue> = {}): PlanIssue {
  return { code, path, message, severity: 'warning', retryable: false, ...extra };
}

/** knowledge 是否构成「拿到了这条信息」：被否定的不算证据。 */
function knowledgeIsEvidence(fact: KnowledgeFact): boolean {
  return fact.status === 'active' && fact.belief !== 'rejected';
}

/**
 * E04/E05/E06：按历史见闻过滤候选。
 * 返回的 items 只含可见项；POV 模式下不产生任何带隐藏 ID 的诊断。
 */
export function filterFeedCandidates(
  candidates: readonly FeedCandidate[],
  ctx: FeedVisibilityContext,
): FeedVisibilityResult {
  const author = ctx.viewMode === 'author';
  const povId = ctx.povId;
  const povPlaceAtTurn = ctx.povPlaceAtTurn ?? (() => null);
  const knowledgeAtTurn = ctx.knowledgeAtTurn ?? (() => []);
  const visible = ctx.visibleEntityIds ?? new Set<string>();
  const issues: PlanIssue[] = [];
  const items: WorldFeedItem[] = [];

  if (!author && !povId) {
    return {
      items: [],
      issues: [planIssue('FEED_POV_ID_REQUIRED', '$.povId', 'POV 视角必须指明主角；否则一律不下发', { severity: 'error' })],
    };
  }

  for (const candidate of candidates ?? []) {
    if (!candidate || !candidate.item) continue;
    const item = candidate.item;

    if (author) {
      // 作者看得到后台，但卡片一律标 background：不冒充「主角已知」。
      items.push({ ...item, visibility: 'background' });
      continue;
    }

    // ── POV 判定 ──
    const isPovPersonally = item.visibility === 'known';
    const category = item.category;
    const isEventCard = category === 'event';
    const isMessageLike = category === 'message' || category === 'discovery';

    // 消息/发现卡：生产器已按「是不是主角本人接收」定过 known；只有 known 才给 POV。
    if (isMessageLike) {
      if (isPovPersonally) items.push({ ...item, visibility: 'known' });
      continue;
    }

    const facts = knowledgeAtTurn(item.turnId).filter(knowledgeIsEvidence);
    const firstHand = facts.filter((f) => f.isPov || (povId !== null && f.knowerCharacterId === povId));
    const reported = facts.filter((f) => !firstHand.includes(f));
    const isParticipant = !!povId && (candidate.participantIds ?? []).some((id) => id === povId);
    // 具体同场：必须是同一个具名地点，同城另一栋楼不算见闻（E06）。
    const samePlace = !!candidate.locationId && povPlaceAtTurn(item.turnId) === candidate.locationId;

    if (isEventCard && candidate.eventId) {
      const firstHandCovers = firstHand.some((f) => f.sourceEventId && f.sourceEventId === candidate.eventId);
      // 只拿到转述 → 事件卡撤掉，让消息卡承载（E04）。
      if (reported.some((f) => f.sourceEventId === candidate.eventId) && !firstHandCovers && !isParticipant) continue;
      if (isParticipant) {
        items.push({ ...item, visibility: 'known' });
        continue;
      }
      // 秘密事件不靠「同场」放行：必须有直接观察证据。
      if (candidate.secrecy === 'secret') {
        if (firstHandCovers) items.push({ ...item, visibility: 'known' });
        continue;
      }
      if (samePlace) {
        items.push({ ...item, visibility: 'known' });
        continue;
      }
      if (firstHandCovers) {
        items.push({ ...item, visibility: 'known' });
        continue;
      }
      // public + 地点已发现 ≠ 全知：没有见闻依据就不下发（也不留任何痕迹）。
      continue;
    }

    // 旅程 / 行动 / 物品：主角本人是当事人，或当时确实同场。
    const isActor = !!povId && (candidate.participantIds ?? []).some((id) => id === povId);
    if (isActor) {
      items.push({ ...item, visibility: 'known' });
      continue;
    }
    if (samePlace) {
      items.push({ ...item, visibility: 'known' });
      continue;
    }
  }

  // ── 引用清理：POV 卡片不得带出未公开实体的 ID / 名称 ──
  const sanitized = author
    ? items
    : items.map((item) => {
      const keep = (id: string): boolean => item.target?.id === id || visible.has(id) || id === povId;
      const links = item.links.filter((l) => keep(l.id));
      const locationId = item.locationId && keep(item.locationId) ? item.locationId : null;
      return {
        ...item,
        links,
        locationId,
        mapId: locationId ? item.mapId : null,
      };
    });

  return { items: sanitized, issues };
}

/** 从事件卡候选适配到统一形状。 */
export function eventCandidateToFeed(
  candidate: { item: WorldFeedItem; planOnly?: boolean },
  extra: { eventId: string; participantIds: readonly string[]; secrecy: FeedSecrecy | null },
): FeedCandidate {
  return {
    item: candidate.item,
    eventId: extra.eventId,
    participantIds: extra.participantIds,
    locationId: candidate.item.locationId,
    secrecy: extra.secrecy,
    planOnly: candidate.planOnly === true,
  };
}

/** 从动向卡候选适配到统一形状。 */
export function transitionCandidateToFeed(candidate: {
  item: WorldFeedItem;
  participantIds?: readonly string[];
  knowledgeId?: string | null;
}): FeedCandidate {
  return {
    item: candidate.item,
    participantIds: candidate.participantIds ?? [],
    knowledgeId: candidate.knowledgeId ?? null,
    locationId: candidate.item.locationId,
  };
}
