/**
 * atlas-world-feed-events.ts — M5-02：把事件生命周期转成「真人能读」的故事卡（02 §7 / E01/E02）。
 *
 * 三条硬规则：
 * 1. **只有真正发生才算发生卡**：status 由非 occurred 变成 occurred 才发一张；
 *    已经是 occurred 的行被改标题/摘要不新发一次发生事件。scheduled 只进计划（planOnly）。
 * 2. **真人内容只来自事件快照**：title/summary 取 events 行的 title/summary/outcome，
 *    绝不使用 journal 的技术 summary（那里写的是「修改events「X」：row_rev」）。
 * 3. **同组 effects 不再重复拆成技术项**：一次 event.propose 与它的
 *    character_status / item_transfer / location_status / action_result 是同一原子组，
 *    这些行由 covered 集合覆盖，后续阶段不得再为它们单独发「字段已改」。
 *
 * 只读：不写库、不建事务、不调用模型。
 */

import type { JournalSnapshot, PlanIssue, WorldFeedItem, FeedEntityKind, WorldFeedCategory } from './atlas-world-contract.ts';

/** 与事件同一原子组、由事件卡覆盖的效果表（§5.1 的四种 effect 目标表）。 */
export const EVENT_EFFECT_TABLES: ReadonlySet<string> = new Set(['characters', 'items', 'locations', 'actions']);

/** 本批要处理的一个已提交回合。 */
export type EventFeedTurn = {
  turnId: string;
  /** 该回合在叙事里的序号（1 起）。 */
  turnOrdinal: number;
  committedRevision: number;
  /** 该回合结束时的故事时刻（turns.clock_after_s）。缺失时绝不用本机墙钟顶替。 */
  clockS?: number | null;
  snapshots: readonly JournalSnapshot[];
};

export type EventFeedOptions = {
  /** 时间标签格式化（由视图层按分支日历提供）。缺省为确定性的 `HH:MM` 故事时刻。 */
  formatTime?: (seconds: number | null) => string;
  /** id → 展示名。缺省直接用 id，不编造名字。 */
  labels?: Record<string, string>;
  /** id → 实体种类。缺省按参与者处理为 character。 */
  entityKindById?: Record<string, FeedEntityKind>;
  /** 每回合的来源标记；缺省按事件字段推断（有 cause_action_id 视为 simulation）。 */
  sourceKindByTurn?: Record<string, WorldFeedItem['sourceKind']>;
  /** location id → 所在图 id；缺省 null（由后续组装阶段补齐）。 */
  mapIdByLocationId?: Record<string, string | null>;
};

export type EventFeedCandidate = {
  item: WorldFeedItem;
  /** 该项覆盖掉的 (table,rowId)：同事件 effects 组内的行不再单独发卡。 */
  covered: Array<{ table: string; rowId: string }>;
  /** 覆盖的组 ID（便于 M5-10 做同组去重）。 */
  coveredGroupIds: string[];
  /** true = 只进计划/日程，不进「已经发生」的 feed（E02）。 */
  planOnly: boolean;
  issues: PlanIssue[];
};

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function planIssue(code: string, path: string, message: string, extra: Partial<PlanIssue> = {}): PlanIssue {
  return { code, path, message, severity: 'warning', retryable: false, ...extra };
}

/** 确定性故事时刻标签：`HH:MM`，无 locale、无墙钟。 */
export function defaultTimeLabel(seconds: number | null): string {
  if (!finite(seconds) || seconds < 0) return '时间未知';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function asRow(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseList(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

const EVENT_KIND_LABELS: Record<string, string> = {
  ceremony: '仪式',
  conflict: '冲突',
  arrival: '抵达',
  passage: '经过',
  discovery: '发现',
  trade: '交易',
  communication: '通讯',
  incident: '事件',
  other: '事件',
};

/** 事件类别的故事分类：默认 event；被使者转达的消息走 message（M5-03 再细化）。 */
function categoryFor(): WorldFeedCategory {
  return 'event';
}

function stableId(flavor: string, eventId: string, turnId: string): string {
  return `feed:event:${flavor}:${eventId}:${turnId}`;
}

/**
 * 把一批已提交回合的事件净变化转成故事卡候选。
 *
 * 返回的候选既含「已发生」也含「仅计划」两类，由调用方按 planOnly 分流；
 * covered 必须被后续阶段尊重，否则同一次事件会被拆成好几条技术动向。
 */
export function buildEventFeedCandidates(
  turns: readonly EventFeedTurn[],
  options: EventFeedOptions = {},
): EventFeedCandidate[] {
  const formatTime = options.formatTime ?? defaultTimeLabel;
  const labels = options.labels ?? {};
  const labelOf = (id: string): string => (typeof labels[id] === 'string' && labels[id] ? labels[id] : id);
  const out: EventFeedCandidate[] = [];

  for (const turn of turns ?? []) {
    if (!turn || typeof turn.turnId !== 'string' || !turn.turnId) continue;
    // 不用 Array.isArray：它会把 readonly JournalSnapshot[] 收窄成 any[]，丢掉元素类型。
    const turnSnapshots: readonly JournalSnapshot[] = turn.snapshots ?? [];
    const eventSnapshots = turnSnapshots.filter((s) => s && s.table === 'events');

    for (const snapshot of eventSnapshots) {
      const issues: PlanIssue[] = [];
      const before = asRow(snapshot.before);
      const after = asRow(snapshot.after);
      if (after === null) continue; // 事件被删除：不是「发生」，不在这里编造故事
      const eventId = snapshot.rowId;
      const beforeStatus = str(before?.status);
      const afterStatus = str(after.status);
      const afterOccurredAt = after.occurred_at_s;
      const hadEnded = before?.ended_at_s !== null && before?.ended_at_s !== undefined;
      const nowEnded = after.ended_at_s !== null && after.ended_at_s !== undefined;

      const isNewOccurrence = afterStatus === 'occurred' || afterStatus === 'ongoing';
      const alreadyOccurred = beforeStatus === 'occurred' || beforeStatus === 'ongoing';

      // E02：发生卡只在「进入 occurred/ongoing」时发一次。
      const occurredTransition = isNewOccurrence && !alreadyOccurred;
      // occurred→ended 也算真实转变；只在 ended_at_s 首次落值时发。
      const endedTransition = nowEnded && !hadEnded && before !== null;
      const planOnly = afterStatus === 'scheduled';

      if (!occurredTransition && !endedTransition && !planOnly) continue;

      const title = str(after.title) || labelOf(eventId);
      const humanSummary = str(after.summary) || str(after.outcome) || title;
      if (!title) {
        issues.push(planIssue('EVENT_TITLE_MISSING', '$.title', '事件缺少可读标题，跳过这张卡', { severity: 'error', relatedIds: [eventId] }));
        continue;
      }

      let occurredAtS: number | null = null;
      if (finite(afterOccurredAt)) occurredAtS = afterOccurredAt;
      else if (finite(turn.clockS)) occurredAtS = turn.clockS as number;
      if (!finite(afterOccurredAt)) {
        // 旧档不确定要标明：绝不填本机墙钟来假装知道时刻。
        issues.push(
          planIssue('EVENT_OCCURRED_AT_UNKNOWN', '$.occurred_at_s',
            occurredAtS === null
              ? '事件没有发生时刻、所在回合也没有故事时刻：卡片标记为时间未知'
              : '事件行没有 occurred_at_s，卡片时间取自所在回合的故事时刻并标为推断',
            { relatedIds: [eventId] }),
        );
      }

      const participants = parseList(after.participants_json);
      const locationId = str(after.location_id) || null;
      const links: WorldFeedItem['links'] = [];
      if (locationId) links.push({ kind: 'location', id: locationId, label: labelOf(locationId) });
      for (const p of participants) {
        const id = str(p.entity_id);
        if (!id || id === locationId) continue;
        links.push({
          kind: options.entityKindById?.[id] ?? 'character',
          id,
          label: str(p.role) && str(p.role) !== 'participant' ? str(p.role) : labelOf(id),
        });
      }
      const subjectId = str(after.subject_entity_id);
      if (subjectId && !links.some((l) => l.id === subjectId)) {
        links.push({ kind: options.entityKindById?.[subjectId] ?? 'character', id: subjectId, label: labelOf(subjectId) });
      }

      // E03：同组 effects 归入 covered，不再单独发技术动向。
      const ownGroups = new Set(snapshot.groupIds ?? []);
      const covered: Array<{ table: string; rowId: string }> = [{ table: 'events', rowId: eventId }];
      const coveredGroupIds = new Set(snapshot.groupIds ?? []);
      if (ownGroups.size > 0) {
        for (const other of turnSnapshots) {
          if (other.table === 'events' && other.rowId === eventId) continue;
          if (!EVENT_EFFECT_TABLES.has(other.table)) continue;
          if (!(other.groupIds ?? []).some((g) => ownGroups.has(g))) continue;
          covered.push({ table: other.table, rowId: other.rowId });
          for (const g of other.groupIds ?? []) coveredGroupIds.add(g);
        }
      }

      const sourceKind = options.sourceKindByTurn?.[turn.turnId]
        ?? (str(after.cause_action_id) ? 'simulation' : 'story');
      const factQuality: WorldFeedItem['factQuality'] = finite(afterOccurredAt) ? 'confirmed' : 'inferred';
      const flavor = endedTransition && !occurredTransition ? 'ended' : planOnly ? 'planned' : 'occurred';

      const item: WorldFeedItem = {
        id: stableId(flavor, eventId, turn.turnId),
        category: categoryFor(),
        title,
        summary: humanSummary,
        // 未知时刻绝不用本机墙钟：没有依据时用 0 并靠 factQuality/timeLabel 标明不确定性。
        occurredAtS: occurredAtS ?? 0,
        timeLabel: formatTime(occurredAtS),
        turnId: turn.turnId,
        turnOrdinal: Number.isFinite(turn.turnOrdinal) ? turn.turnOrdinal : 0,
        committedRevision: Number.isFinite(turn.committedRevision) ? turn.committedRevision : 0,
        locationId,
        mapId: locationId ? (options.mapIdByLocationId?.[locationId] ?? null) : null,
        target: { kind: 'event', id: eventId },
        links,
        visibility: 'background',
        sourceKind,
        factQuality,
        trace: {
          turnId: turn.turnId,
          groupIds: [...new Set(snapshot.groupIds ?? [])].sort(),
          operationIds: [...new Set(snapshot.operationIds ?? [])].sort(),
        },
      };

      out.push({
        item,
        covered,
        coveredGroupIds: [...coveredGroupIds].sort(),
        planOnly: planOnly && !occurredTransition && !endedTransition,
        issues,
      });
    }
  }

  out.sort(
    (a, b) =>
      a.item.turnOrdinal - b.item.turnOrdinal
      || a.item.committedRevision - b.item.committedRevision
      || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
  );
  return out;
}

/** 事件种类的可读名（供卡片副标题使用）。 */
export function eventKindLabel(kind: string): string {
  return EVENT_KIND_LABELS[kind] ?? EVENT_KIND_LABELS.other;
}
