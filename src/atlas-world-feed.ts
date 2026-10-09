/**
 * atlas-world-feed.ts — M5-06：组装真实只读事件视图（02 §7 / E01–E10 / I11）。
 *
 * 把 M5-01…M5-05 串成一次只读查询：
 *   历史重建（journal）→ 每回合净变化 → 事件卡 + 动向卡 → 按历史见闻过滤 → 稳定分页。
 *
 * 纪律：
 * - **读取不写库**：不开事务、不落 journal、不调模型、不碰 host save；partial 回合按只读成功组读取，
 *   rolled_back / failed / pending 回合一律不显示。
 * - **整轮读取**：一轮的净变化必须从该轮**完整** journal 算；单轮相关行数超过
 *   feedTurnJournalMax（2000）时整轮不发卡并明确报 FEED_TURN_TOO_LARGE，绝不造半轮卡。
 * - **有界内部扫描**：每块 24 个完整回合，最多 8 块；可见卡不够一页时返回 scanCursor 继续，
 *   且**不报告隐藏卡数量**（连隐藏 ID/标题都不出现）。
 * - **最新叙事回合**来自真实 turns.kind='narrative'，不用数组长度、不用 manual 回合顶替。
 * - 空结果就是 `items: []`，不塞「未提交/应用 N 行」这类开发信息当读者内容。
 */

import { AtlasDbError, queryBound } from './atlas-db-runtime.ts';
import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';
import { normalizeViewLimit } from './atlas-ops-contract.ts';
import type { ViewQuery, ViewResult } from './atlas-ops-contract.ts';
import type { ViewContext } from './atlas-db-views.ts';
import { collapseTurnSnapshots, readHistoricalRows, readTurnChangeRows } from './atlas-world-feed-history.ts';
import type { HistoricalSnapshotResult, TurnChangeInput } from './atlas-world-feed-history.ts';
import { buildEventFeedCandidates } from './atlas-world-feed-events.ts';
import { buildTransitionFeedCandidates } from './atlas-world-feed-transitions.ts';
import type { InformationSnapshot } from './atlas-world-feed-transitions.ts';
import { filterFeedCandidates } from './atlas-world-feed-visibility.ts';
import type { FeedCandidate, KnowledgeFact } from './atlas-world-feed-visibility.ts';
import {
  cursorAnchorOf,
  encodeFeedCursor,
  feedFilterHash,
  isAfterCursor,
  sortFeedItems,
  validateFeedCursor,
} from './atlas-world-feed-cursor.ts';
import type { FeedCursor, FeedEntityKind, PlanIssue, WorldFeedItem } from './atlas-world-contract.ts';

/** 事件流关心的表（journal 白名单的子集，不含 entity_keys / branches 这类技术表）。 */
const FEED_TABLES = ['events', 'journeys', 'actions', 'items', 'knowledge', 'information', 'locations', 'characters'] as const;
/**
 * 逐回合快照需要的表。
 *
 * **characters 必须在列**：POV 的「当时在哪儿」是靠历史重建读出来的
 * （filterFeedCandidates 的 povPlaceAtTurn）。少一张表，同场判定就永远为 false，
 * 主角亲眼看到的事会被整片误杀。
 */
const CONTEXT_TABLES = ['information', 'knowledge', 'locations', 'characters'] as const;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

type TurnRow = {
  id: string;
  kind: string;
  status: string;
  committedRevision: number;
  clockAfterS: number;
  wallMs: number;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 该分支可展示的回合：committed / partial。rolled_back、failed、pending 一概不显示。 */
function readTurnWindow(ctx: ViewContext): TurnRow[] {
  const rows = queryBound(
    ctx.db,
    `SELECT id, kind, status, committed_revision, clock_after_s, created_wall_ms
       FROM turns WHERE branch_id = ? AND status IN ('committed','partial') AND committed_revision IS NOT NULL
       ORDER BY clock_after_s DESC, committed_revision DESC, id ASC`,
    [ctx.branchId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    kind: String(r.kind ?? ''),
    status: String(r.status ?? ''),
    committedRevision: Number(r.committed_revision ?? 0),
    clockAfterS: Number(r.clock_after_s ?? 0),
    wallMs: Number(r.created_wall_ms ?? 0),
  }));
}

function readLabelTables(ctx: ViewContext): {
  labels: Record<string, string>;
  kinds: Record<string, FeedEntityKind>;
  mapIdByLocationId: Record<string, string | null>;
} {
  const labels: Record<string, string> = {};
  const kinds: Record<string, FeedEntityKind> = {};
  const mapIdByLocationId: Record<string, string | null> = {};
  // 注意：events / information / actions 的名称列叫 title，不是 name；journeys 干脆没有名称列。
  // 统一查 name 会在运行时直接炸 SQL（tsc 抓不到），所以这里逐表写明标签列。
  const sources: Array<[string, FeedEntityKind, string]> = [
    ['locations', 'location', 'name'],
    ['characters', 'character', 'name'],
    ['items', 'item', 'name'],
    ['events', 'event', 'title'],
    ['information', 'information', 'title'],
    ['actions', 'action', 'title'],
  ];
  for (const [table, kind, labelColumn] of sources) {
    for (const row of queryBound(ctx.db, `SELECT id, ${labelColumn} AS label FROM ${table} WHERE branch_id = ?`, [ctx.branchId])) {
      const id = String(row.id ?? '');
      if (!id) continue;
      kinds[id] = kind;
      const name = str(row.label);
      if (name) labels[id] = name;
    }
  }
  for (const row of queryBound(ctx.db, 'SELECT id, map_id FROM locations WHERE branch_id = ?', [ctx.branchId])) {
    mapIdByLocationId[String(row.id ?? '')] = row.map_id === null || row.map_id === undefined ? null : String(row.map_id);
  }
  return { labels, kinds, mapIdByLocationId };
}

/**
 * POV 可见实体集合：主角本人、主角待过的地点（历史，不取当前位置）、
 * 主角有效知识覆盖的信息及其来源地点。别的实体一律当「不可命名」处理。
 */
function povVisibleSet(ctx: ViewContext, povId: string): Set<string> {
  const set = new Set<string>([povId]);
  for (const row of queryBound(
    ctx.db,
    `SELECT DISTINCT tc.after_json AS after_json FROM turn_changes tc JOIN turns t ON t.id = tc.turn_id
      WHERE t.branch_id = ? AND t.status IN ('committed','partial')
        AND tc.target_table = 'characters' AND tc.target_row_id = ? AND tc.after_json IS NOT NULL`,
    [ctx.branchId, povId],
  )) {
    try {
      const parsed = JSON.parse(String(row.after_json));
      if (isPlainObject(parsed) && str(parsed.location_id)) set.add(str(parsed.location_id));
    } catch {
      /* 坏 JSON 由历史层报诊断；这里只是补可见集合 */
    }
  }
  for (const row of queryBound(
    ctx.db,
    `SELECT k.information_id, i.origin_location_id, i.subject_entity_id
       FROM knowledge k LEFT JOIN information i ON i.branch_id = k.branch_id AND i.id = k.information_id
      WHERE k.branch_id = ? AND k.status = 'active' AND (k.is_pov = 1 OR k.knower_character_id = ?)`,
    [ctx.branchId, povId],
  )) {
    const infoId = str(row.information_id);
    if (infoId) set.add(infoId);
    for (const key of ['origin_location_id', 'subject_entity_id'] as const) {
      const id = str(row[key]);
      if (id) set.add(id);
    }
  }
  return set;
}

const PLACEHOLDER: Record<FeedEntityKind, string> = {
  location: '某处',
  character: '某人',
  item: '某物',
  event: '某事件',
  information: '某条消息',
  journey: '某段行程',
  action: '某个行动',
};

/** 知识事实：从历史 knowledge 快照里挑出与某回合有关的有效条目。 */
function knowledgeFactsAt(history: HistoricalSnapshotResult, informationKindOf: (id: string) => string): KnowledgeFact[] {
  const facts: KnowledgeFact[] = [];
  for (const [key, row] of Object.entries(history.rows)) {
    if (!key.startsWith('knowledge\u0000')) continue;
    if (!row.exists || !row.row) continue;
    const informationId = str(row.row.information_id);
    if (!informationId) continue;
    facts.push({
      knowledgeId: row.rowId,
      informationId,
      informationKind: informationKindOf(informationId),
      sourceEventId: informationSourceEvent(history, informationId),
      knowerCharacterId: str(row.row.knower_character_id) || null,
      isPov: Number(row.row.is_pov) === 1,
      belief: str(row.row.belief) || 'heard',
      status: str(row.row.status) || 'active',
    });
  }
  return facts;
}

function informationSourceEvent(history: HistoricalSnapshotResult, informationId: string): string | null {
  const row = history.rows[`information\u0000${informationId}`];
  return row?.exists && row.row ? str(row.row.source_event_id) || null : null;
}

/** 把历史重建结果里的 information 行折成卡片可用的内容快照。 */
function informationSnapshots(history: HistoricalSnapshotResult): Record<string, InformationSnapshot> {
  const out: Record<string, InformationSnapshot> = {};
  for (const [key, row] of Object.entries(history.rows)) {
    if (!key.startsWith('information\u0000')) continue;
    if (!row.exists || !row.row) continue;
    out[row.rowId] = {
      title: str(row.row.title) || null,
      content: str(row.row.content) || null,
      kind: str(row.row.kind) || null,
      truth_status: str(row.row.truth_status) || null,
      subject_entity_id: str(row.row.subject_entity_id) || null,
      origin_location_id: str(row.row.origin_location_id) || null,
      secrecy: str(row.row.secrecy) || null,
    };
  }
  return out;
}

/**
 * E01–E10：只读事件流视图。
 * 绝不写库、不调模型、不返回值里带隐藏数量。
 */
export function queryWorldFeed(ctx: ViewContext, query: ViewQuery): ViewResult {
  const branchId = ctx.branchId;
  const revision = ctx.revision;
  const viewMode: 'pov' | 'author' = ctx.viewMode ?? 'pov';
  const povId = ctx.povId ?? null;
  const filter = query.feedFilter ?? {};
  const filterHash = feedFilterHash(filter);
  const limit = normalizeViewLimit(query.limit, { fallback: 50, max: ATLAS_RUNTIME_LIMITS.feedPageMax });

  // 视角缺失是**参数错误**，不是「恰好没有故事」—— 直接抛，别回报空列表让调用方以为世界很安静。
  if (viewMode === 'pov' && !povId) {
    throw new AtlasDbError('FEED_POV_ID_REQUIRED', 'POV 事件流必须指定视角角色', { branchId });
  }

  // ── 游标：形状错了报 VIEW_CURSOR_INVALID，身份/修订变了报 VIEW_CURSOR_STALE ──
  // 必须**抛**出去：只有抛出的 code 才走得到路由层的状态映射（409/400）。
  // 返回一个带 metadata.code 的空列表等于让 UI 把「游标过期」误当成「没有新故事」。
  let after: FeedCursor['after'] = null;
  let scanAfterTurnId: string | null = null;
  if (typeof query.cursor === 'string' && query.cursor) {
    const checked = validateFeedCursor(query.cursor, { branchId, revision, viewMode, povId, filterHash });
    if (!checked.ok) {
      throw new AtlasDbError(checked.code, checked.message, { branchId, viewMode, filterHash });
    }
    after = checked.cursor.after;
    scanAfterTurnId = checked.cursor.scanAfterTurnId;
  }

  const turnWindow = readTurnWindow(ctx);
  const latestNarrativeIndex = turnWindow.findIndex((t) => t.kind === 'narrative');
  const latestNarrative = latestNarrativeIndex >= 0 ? turnWindow[latestNarrativeIndex] : null;
  const ascending = [...turnWindow].reverse();
  const latestNarrativeOrdinal = latestNarrative ? ascending.findIndex((t) => t.id === latestNarrative.id) + 1 : 0;

  const issues: PlanIssue[] = [];
  const collected: WorldFeedItem[] = [];
  let blocks = 0;
  let lastScannedTurnId: string | null = null;

  let startIndex = 0;
  if (scanAfterTurnId) {
    const idx = turnWindow.findIndex((t) => t.id === scanAfterTurnId);
    if (idx >= 0) startIndex = idx + 1;
  }

  const labelTables = readLabelTables(ctx);
  const visibleSet = viewMode === 'pov' && povId ? povVisibleSet(ctx, povId) : null;
  const placeholderOf = (id: string): string => {
    const kind = labelTables.kinds[id];
    return kind ? PLACEHOLDER[kind] : '某个已知对象';
  };
  // POV：给**每个已知实体**都铺一条标签，不可见的用中性指代。
  // 关键：builder 内部是 `labels[id] ?? id`；只要漏掉任何一个已知 id，原始 ID 就会进标题 —— 那就是泄漏。
  const effectiveLabels: Record<string, string> = {};
  if (viewMode === 'pov') {
    for (const id of Object.keys(labelTables.kinds)) {
      effectiveLabels[id] = visibleSet?.has(id) ? (labelTables.labels[id] ?? id) : placeholderOf(id);
    }
  } else {
    for (const [id, name] of Object.entries(labelTables.labels)) effectiveLabels[id] = name;
  }

  while (blocks < ATLAS_RUNTIME_LIMITS.feedMaxScanBlocks && collected.length < limit) {
    const batch = turnWindow.slice(
      startIndex + blocks * ATLAS_RUNTIME_LIMITS.feedTurnsPerScan,
      startIndex + (blocks + 1) * ATLAS_RUNTIME_LIMITS.feedTurnsPerScan,
    );
    if (batch.length === 0) {
      break;
    }
    blocks += 1;
    lastScannedTurnId = batch[batch.length - 1].id;

    const batchIds = batch.map((t) => t.id);
    const journal = readTurnChangeRows(ctx.db, batchIds, FEED_TABLES);
    issues.push(...journal.issues);
    const byTurn = new Map<string, TurnChangeInput[]>();
    for (const entry of journal.entries) {
      const list = byTurn.get(entry.turnId) ?? [];
      list.push(entry);
      byTurn.set(entry.turnId, list);
    }

    const historyCache = new Map<string, HistoricalSnapshotResult>();
    const historyOf = (turnId: string): HistoricalSnapshotResult => {
      let cached = historyCache.get(turnId);
      if (!cached) {
        cached = readHistoricalRows(ctx.db, { branchId, turnId, tables: [...CONTEXT_TABLES] });
        historyCache.set(turnId, cached);
      }
      return cached;
    };

    const batchItems: WorldFeedItem[] = [];
    for (const turn of batch) {
      const rawCount = journal.countsByTurn.get(turn.id) ?? 0;
      // E10：单轮相关 journal 超上限 → 整轮不发卡，绝不造半轮卡。
      if (rawCount > ATLAS_RUNTIME_LIMITS.feedTurnJournalMax) {
        issues.push({
          code: 'FEED_TURN_TOO_LARGE',
          path: '$.turnId',
          message: `单轮变更行数 ${rawCount} 超过上限 ${ATLAS_RUNTIME_LIMITS.feedTurnJournalMax}；该轮整体跳过，不返回半轮故事`,
          severity: 'error',
          retryable: false,
        });
        continue;
      }
      const entries = byTurn.get(turn.id) ?? [];
      const snapshots = collapseTurnSnapshots(entries);
      if (snapshots.length === 0) continue;

      const history = historyOf(turn.id);
      const infoById = informationSnapshots(history);
      const kindOfInfo = (id: string): string => str(infoById[id]?.kind);

      const turnOrigin = turn.kind === 'manual' ? 'manual' : turn.kind === 'migration' ? 'migration' : 'story';
      const turnBase = {
        turnId: turn.id,
        turnOrdinal: ascending.findIndex((t) => t.id === turn.id) + 1,
        committedRevision: turn.committedRevision,
        clockS: turn.clockAfterS,
        origin: turnOrigin as 'story' | 'manual' | 'migration',
        snapshots,
      };

      const eventCandidates = buildEventFeedCandidates([turnBase], {
        labels: effectiveLabels,
        entityKindById: labelTables.kinds,
        mapIdByLocationId: labelTables.mapIdByLocationId,
      });
      const covered = eventCandidates.flatMap((c) => c.covered);
      const transitionCandidates = buildTransitionFeedCandidates([turnBase], {
        labels: effectiveLabels,
        entityKindById: labelTables.kinds,
        mapIdByLocationId: labelTables.mapIdByLocationId,
        informationById: infoById,
        coveredByEvents: covered,
      });

      const feedCandidates: FeedCandidate[] = [];
      for (const c of eventCandidates) {
        if (c.planOnly) continue; // scheduled 只进计划，不进已发生 feed
        const snap = snapshots.find((s) => s.table === 'events' && s.rowId === c.item.target?.id);
        const eventRow = snap?.after ?? null;
        const participants: string[] = [];
        if (isPlainObject(eventRow)) {
          const subject = str(eventRow.subject_entity_id);
          if (subject) participants.push(subject);
          const list = Array.isArray(eventRow.participants_json) ? eventRow.participants_json : [];
          for (const p of list) if (isPlainObject(p) && str(p.entity_id)) participants.push(str(p.entity_id));
          const actor = str(eventRow.subject_entity_id);
          if (actor && !participants.includes(actor)) participants.push(actor);
        }
        feedCandidates.push({
          item: c.item,
          eventId: c.item.target?.id ?? null,
          participantIds: participants,
          locationId: c.item.locationId,
          secrecy: isPlainObject(eventRow) ? (str(eventRow.secrecy) as 'public' | 'restricted' | 'secret') || null : null,
        });
        issues.push(...c.issues);
      }
      for (const c of transitionCandidates) {
        const snap = snapshots.find((s) => s.table === (c.item.category === 'journey' ? 'journeys'
          : c.item.category === 'action' ? 'actions' : c.item.category === 'item' ? 'items' : 'knowledge')
          && s.rowId === c.item.target?.id);
        const row = snap?.after ?? null;
        const participants: string[] = [];
        if (isPlainObject(row)) {
          for (const key of ['mover_entity_id', 'actor_entity_id', 'holder_character_id', 'knower_character_id']) {
            const id = str(row[key]);
            if (id) participants.push(id);
          }
        }
        feedCandidates.push({
          item: c.item,
          participantIds: participants,
          knowledgeId: c.item.category === 'message' ? c.item.target?.id ?? null : null,
          locationId: c.item.locationId,
        });
        issues.push(...c.issues);
      }

      const visible = filterFeedCandidates(feedCandidates, {
        viewMode,
        povId,
        // 历史重建：只按该回合当时的位置判定，绝不退回当前 sqlVisibility.here。
        povPlaceAtTurn: (turnId) => {
          if (!povId) return null;
          const h = historyOf(turnId);
          const row = h.rows[`characters\u0000${povId}`];
          return row?.exists && row.row ? str(row.row.location_id) || null : null;
        },
        knowledgeAtTurn: (turnId) => knowledgeFactsAt(historyOf(turnId), kindOfInfo),
        visibleEntityIds: visibleSet ?? new Set<string>(),
      });
      issues.push(...visible.issues);
      for (const item of visible.items) batchItems.push(item);
    }

    batchItems.sort((a, b) => (a.occurredAtS !== b.occurredAtS ? b.occurredAtS - a.occurredAtS
      : a.committedRevision !== b.committedRevision ? b.committedRevision - a.committedRevision
        : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const item of batchItems) if (isAfterCursor(item, after)) collected.push(item);
  }

  // ── 筛选（白名单字段；不认识的键在请求校验层就被挡掉，这里只按契约过滤）──
  let items = sortFeedItems(collected);
  if (filter.category) items = items.filter((i) => i.category === filter.category);
  if (filter.mapId) items = items.filter((i) => i.mapId === filter.mapId);
  if (filter.entityId) {
    const wanted = String(filter.entityId);
    items = items.filter((i) => i.target?.id === wanted || i.links.some((l) => l.id === wanted));
  }
  if (filter.currentTurnOnly) items = items.filter((i) => i.turnId === latestNarrative?.id);

  const page = items.slice(0, limit);
  /**
   * 扫描是否已覆盖当前 revision 下的**全部**回合。
   *
   * 这里必须区分两件事：`collected` 装不下（一页不够） vs 还有更老的回合没扫。
   * 只有后者才允许把 scanCursor 往前推 —— 否则「一页装不下」会被当成「这个回合看完了」，
   * 该回合剩下的卡会被整个跳过且永远取不回来（实测：单轮 150 张只吐回 50 张）。
   * 跨页去重交给 after 排序锚点，它按 (时刻, 修订, id) 严格推进，不重不漏。
   */
  const scannedTurnCount = startIndex + blocks * ATLAS_RUNTIME_LIMITS.feedTurnsPerScan;
  const moreTurnsToScan = scannedTurnCount < turnWindow.length;
  const hasMoreVisible = items.length > limit || moreTurnsToScan;
  const nextCursorValue = hasMoreVisible
    ? encodeFeedCursor({
      version: 1,
      branchId,
      revision,
      viewMode,
      povId,
      filterHash,
      after: page.length > 0 ? cursorAnchorOf(page[page.length - 1]) : after,
      scanAfterTurnId: moreTurnsToScan ? lastScannedTurnId : null,
    })
    : undefined;

  return {
    branchId,
    revision,
    items: page,
    ...(nextCursorValue ? { nextCursor: nextCursorValue } : {}),
    metadata: {
      viewMode,
      count: page.length,
      latestNarrativeTurnId: latestNarrative?.id ?? null,
      latestNarrativeOrdinal,
      hasMoreVisible,
      // 需要继续往更老的回合扫才能凑满时给 scanCursor；绝不报告隐藏卡数量。
      ...(moreTurnsToScan && nextCursorValue ? { scanCursor: nextCursorValue } : {}),
      ...(issues.length ? { issues } : {}),
    },
  };
}
