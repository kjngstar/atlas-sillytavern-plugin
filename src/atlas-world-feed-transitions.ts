/**
 * atlas-world-feed-transitions.ts — M5-03：旅行 / 行动 / 物品 / 消息的业务动向（02 §7 / E03/E04/E07）。
 *
 * 判断口径：
 * - **业务动向才算故事**：旅程出发、停留、恢复/改道、到达；行动开始/完成/失败/取消；
 *   物品换位置/换持有者/数量变化；知识第一次接收（消息卡）；有证据的真实发现。
 * - **技术微调不算故事**：坐标、row_rev、进度秒数、segment_index、last_advanced_at_s、
 *   belief/attention 变化一律不发卡，否则每轮都会刷出「journeys updated」这种废话。
 * - **消息卡只用当时的 information.content**：知识第一次接收才发卡，内容取该回合
 *   的历史 information 快照；绝不能把 source_event 的完整摘要塞进消息卡。
 *   rumor_front 只是「在这个地方有机会听到」，不是全员知情。
 * - **生成地点不等于发现**：只有「当回合真的产生了观察（information.kind=observation）
 *   且被记录为知识」才算发现。
 * - **人工纠偏不是剧情**：author manual / migration 回合不产出任何动向卡。
 *
 * 只读：不写库、不建事务、不调用模型。
 */

import type {
  FeedEntityKind,
  JournalSnapshot,
  PlanIssue,
  WorldFeedCategory,
  WorldFeedItem,
} from './atlas-world-contract.ts';

/** 被事件 effects 卡覆盖的 (table,rowId)；同组子变更不得再单独发卡（M5-02 的 covered）。 */
export type CoveredRef = { table: string; rowId: string };

export type TransitionFeedTurn = {
  turnId: string;
  turnOrdinal: number;
  committedRevision: number;
  /** 该回合结束时的故事时刻。缺失时绝不用本机墙钟。 */
  clockS?: number | null;
  /**
   * 变更来源：story（正常叙事/推演）才产出故事卡；
   * manual = 作者手工纠偏，migration = 初始导入，都不伪装成剧情移动。
   */
  origin?: 'story' | 'manual' | 'migration';
  snapshots: readonly JournalSnapshot[];
};

/** 该回合当时的信息快照（由 M5-01 的历史重建提供；缺省视为未知，不编造内容）。 */
export type InformationSnapshot = {
  title?: string | null;
  content?: string | null;
  kind?: string | null;
  truth_status?: string | null;
  subject_entity_id?: string | null;
  origin_location_id?: string | null;
  secrecy?: string | null;
};

export type TransitionFeedOptions = {
  formatTime?: (seconds: number | null) => string;
  labels?: Record<string, string>;
  entityKindById?: Record<string, FeedEntityKind>;
  mapIdByLocationId?: Record<string, string | null>;
  informationById?: Record<string, InformationSnapshot>;
  coveredByEvents?: readonly CoveredRef[];
};

export type TransitionFeedCandidate = {
  item: WorldFeedItem;
  issues: PlanIssue[];
};

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function planIssue(code: string, path: string, message: string, extra: Partial<PlanIssue> = {}): PlanIssue {
  return { code, path, message, severity: 'warning', retryable: false, ...extra };
}

function asRow(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 确定性故事时刻标签；与 M5-02 同一口径。 */
export function defaultTransitionTimeLabel(seconds: number | null): string {
  if (!finite(seconds) || seconds < 0) return '时间未知';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const ACTION_KINDS: Record<string, string> = {
  goal: '计划',
  prepare: '准备',
  travel: '赶路',
  wait: '等待',
  interact: '交涉',
  transmit: '传讯',
  investigate: '调查',
  act: '行动',
};

const ACTION_VERB: Record<string, string> = {
  active: '开始',
  ready: '准备',
  completed: '完成',
  failed: '失败',
  cancelled: '取消',
};

type Draft = {
  flavor: string;
  category: WorldFeedCategory;
  title: string;
  summary: string;
  target: { kind: FeedEntityKind; id: string };
  locationId: string | null;
  links: WorldFeedItem['links'];
  visibility: WorldFeedItem['visibility'];
  factQuality: WorldFeedItem['factQuality'];
  sourceKind: WorldFeedItem['sourceKind'];
};

/**
 * 把一批已提交回合的净变化转成业务动向卡。
 * 每个 (行, 回合) 至多一张卡；已被事件 effects 覆盖的行直接跳过。
 */
export function buildTransitionFeedCandidates(
  turns: readonly TransitionFeedTurn[],
  options: TransitionFeedOptions = {},
): TransitionFeedCandidate[] {
  const formatTime = options.formatTime ?? defaultTransitionTimeLabel;
  const labels = options.labels ?? {};
  const labelOf = (id: string | null | undefined): string => {
    const key = str(id);
    if (!key) return '';
    const label = labels[key];
    return typeof label === 'string' && label ? label : key;
  };
  const kindOf = (id: string): FeedEntityKind => options.entityKindById?.[id] ?? 'character';
  const mapOf = (id: string | null): string | null => (id ? (options.mapIdByLocationId?.[id] ?? null) : null);
  const info = options.informationById ?? {};
  const covered = new Set((options.coveredByEvents ?? []).map((c) => `${c.table}\u0000${c.rowId}`));

  const out: TransitionFeedCandidate[] = [];

  for (const turn of turns ?? []) {
    if (!turn || typeof turn.turnId !== 'string' || !turn.turnId) continue;
    // 人工纠偏 / 初始导入不是剧情：一句都不编。
    if (turn.origin === 'manual' || turn.origin === 'migration') continue;
    const snapshots: readonly JournalSnapshot[] = turn.snapshots ?? [];
    const turnIssues: PlanIssue[] = [];

    const emit = (rowId: string, draft: Draft, snapshot: JournalSnapshot): void => {
      const item: WorldFeedItem = {
        id: `feed:${draft.category}:${draft.flavor}:${rowId}:${turn.turnId}`,
        category: draft.category,
        title: draft.title,
        summary: draft.summary,
        occurredAtS: finite(turn.clockS) ? (turn.clockS as number) : 0,
        timeLabel: formatTime(finite(turn.clockS) ? (turn.clockS as number) : null),
        turnId: turn.turnId,
        turnOrdinal: Number.isFinite(turn.turnOrdinal) ? turn.turnOrdinal : 0,
        committedRevision: Number.isFinite(turn.committedRevision) ? turn.committedRevision : 0,
        locationId: draft.locationId,
        mapId: mapOf(draft.locationId),
        target: draft.target,
        links: draft.links,
        visibility: draft.visibility,
        sourceKind: draft.sourceKind,
        factQuality: draft.factQuality,
        trace: {
          turnId: turn.turnId,
          groupIds: [...new Set(snapshot.groupIds ?? [])].sort(),
          operationIds: [...new Set(snapshot.operationIds ?? [])].sort(),
        },
      };
      out.push({ item, issues: turnIssues });
    };

    // ── 旅程：出发 / 停留 / 恢复 / 改道 / 到达 ──
    for (const snapshot of snapshots) {
      if (snapshot.table !== 'journeys') continue;
      if (covered.has(`journeys\u0000${snapshot.rowId}`)) continue;
      const before = asRow(snapshot.before);
      const after = asRow(snapshot.after);
      if (after === null) continue;
      const mover = str(after.mover_entity_id);
      const who = labelOf(mover);
      const destination = str(after.destination_location_id);
      const destName = labelOf(destination);
      const nextStatus = str(after.status);
      const prevStatus = str(before?.status);
      const rerouted = before !== null && str(before.destination_location_id) !== destination;
      const started = before === null;

      let flavor = '';
      let title = '';
      let summary = '';
      if (nextStatus === 'arrived' && prevStatus !== 'arrived') {
        flavor = 'arrive';
        title = `${who}到达${destName}`;
        summary = `旅程结束，${who}抵达${destName}。`;
      } else if (nextStatus === 'cancelled' && prevStatus !== 'cancelled') {
        flavor = 'cancel';
        title = `${who}中止前往${destName}的旅程`;
        summary = `原定前往${destName}的行程已取消。`;
      } else if (nextStatus === 'blocked' && prevStatus !== 'blocked') {
        flavor = 'blocked';
        title = `${who}的行程受阻`;
        summary = `前往${destName}的路上受阻，暂时停在${labelOf(str(after.stop_location_id)) || '途中'}。`;
      } else if (nextStatus === 'paused' && prevStatus === 'moving') {
        flavor = 'stop';
        const at = labelOf(str(after.stop_location_id)) || labelOf(str(after.last_reached_location_id));
        title = `${who}在${at || '途中'}停留`;
        summary = `行程暂停${at ? `，${who}停在${at}` : ''}。`;
      } else if (rerouted && !started) {
        flavor = 'reroute';
        title = `${who}改道前往${destName}`;
        summary = `旅程改变目的地，转向${destName}。`;
      } else if (nextStatus === 'moving' && prevStatus === 'paused') {
        flavor = 'resume';
        title = `${who}继续前往${destName}`;
        summary = `行程恢复，${who}重新上路。`;
      } else if (started && nextStatus === 'moving') {
        flavor = 'start';
        title = `${who}出发前往${destName}`;
        summary = `从${labelOf(str(after.origin_location_id)) || '出发地'}启程，目标${destName}。`;
      }
      if (!flavor) continue;

      const stop = str(after.stop_location_id) || str(after.last_reached_location_id) || str(after.origin_location_id);
      const links: WorldFeedItem['links'] = [];
      if (destination) links.push({ kind: 'location', id: destination, label: destName });
      if (mover) links.push({ kind: kindOf(mover), id: mover, label: who });
      emit(snapshot.rowId, {
        flavor,
        category: 'journey',
        title,
        summary,
        target: { kind: 'journey', id: snapshot.rowId },
        locationId: flavor === 'arrive' ? destination || null : (stop || positionLocation(after)),
        links,
        visibility: 'background',
        factQuality: finite(after.arrived_at_s) || !started ? 'confirmed' : 'inferred',
        sourceKind: 'simulation',
      }, snapshot);
    }

    // ── 行动：开始 / 完成 / 失败 / 取消 ──
    for (const snapshot of snapshots) {
      if (snapshot.table !== 'actions') continue;
      if (covered.has(`actions\u0000${snapshot.rowId}`)) continue;
      const before = asRow(snapshot.before);
      const after = asRow(snapshot.after);
      if (after === null) continue;
      const status = str(after.status);
      const prev = str(before?.status);
      const verb = ACTION_VERB[status];
      if (!verb) continue; // planned/ready/paused/blocked 等中间态不发卡
      if (before !== null && prev === status) continue;
      if (before === null && !(status === 'active' || status === 'completed' || status === 'failed')) continue;
      // progress_s 变到天荒地老也不发卡：只有状态真的换了才发。
      const actor = str(after.actor_entity_id);
      const who = labelOf(actor);
      const kindLabel = ACTION_KINDS[str(after.kind)] ?? ACTION_KINDS.act;
      const what = str(after.title) || str(after.intent) || kindLabel;
      const links: WorldFeedItem['links'] = [];
      if (actor) links.push({ kind: kindOf(actor), id: actor, label: who });
      if (str(after.target_location_id)) links.push({ kind: 'location', id: str(after.target_location_id), label: labelOf(str(after.target_location_id)) });
      emit(snapshot.rowId, {
        flavor: `action-${status}`,
        category: 'action',
        title: `${who}${verb}${kindLabel}：${what}`,
        summary: str(after.result_event_id) ? `${verb}「${what}」，并由此产生了一个后续事件。` : `${who}的${kindLabel}「${what}」已${verb}。`,
        target: { kind: 'action', id: snapshot.rowId },
        locationId: str(after.target_location_id) || null,
        links,
        visibility: 'background',
        factQuality: 'confirmed',
        sourceKind: 'simulation',
      }, snapshot);
    }

    // ── 物品：换位置 / 换持有者 / 数量变化（合并成一张卡） ──
    for (const snapshot of snapshots) {
      if (snapshot.table !== 'items') continue;
      if (covered.has(`items\u0000${snapshot.rowId}`)) continue;
      const before = asRow(snapshot.before);
      const after = asRow(snapshot.after);
      if (after === null) continue;
      const holder = str(after.holder_character_id);
      const location = str(after.location_id);
      const container = str(after.container_item_id);
      const prevHolder = str(before?.holder_character_id);
      const prevLocation = str(before?.location_id);
      const qty = after.quantity;
      const prevQty = before?.quantity;
      const holderChanged = holder !== prevHolder && (holder !== '' || prevHolder !== '');
      const locationChanged = location !== prevLocation && (location !== '' || prevLocation !== '');
      const quantityChanged = finite(qty) && finite(prevQty) && qty !== prevQty;
      const name = str(after.name) || snapshot.rowId;
      if (!holderChanged && !locationChanged && !quantityChanged) continue;

      const parts: string[] = [];
      let flavor = '';
      if (holderChanged) { flavor ||= 'holder'; parts.push(holder ? `由${labelOf(holder)}持有` : '已不在任何人手上'); }
      if (!holderChanged && locationChanged) { flavor ||= 'location'; parts.push(location ? `位于${labelOf(location)}` : '离开了原来的位置'); }
      if (!holderChanged && !locationChanged && container) { flavor ||= 'location'; parts.push(`收在${labelOf(container)}里`); }
      if (quantityChanged) { flavor ||= 'quantity'; parts.push(`数量 ${prevQty} → ${qty}`); }

      const links: WorldFeedItem['links'] = [];
      if (holder) links.push({ kind: 'character', id: holder, label: labelOf(holder) });
      if (location) links.push({ kind: 'location', id: location, label: labelOf(location) });
      emit(snapshot.rowId, {
        flavor: `item-${flavor}`,
        category: 'item',
        title: quantityChanged && !holderChanged && !locationChanged ? `${name}数量变化` : `${name}易主/移动`,
        summary: `${name}${parts.length ? '：' + parts.join('；') : ''}。`,
        target: { kind: 'item', id: snapshot.rowId },
        locationId: location || null,
        links,
        visibility: 'background',
        factQuality: 'confirmed',
        sourceKind: 'simulation',
      }, snapshot);
    }

    // ── 消息：知识第一次接收（内容取当时的 information.content） ──
    const knowledgeInfos = new Set<string>();
    for (const snapshot of snapshots) {
      if (snapshot.table !== 'knowledge') continue;
      if (covered.has(`knowledge\u0000${snapshot.rowId}`)) continue;
      const before = asRow(snapshot.before);
      const after = asRow(snapshot.after);
      if (after === null) continue;
      if (before !== null) continue; // 只有第一次接收才算「有人听说」
      const informationId = str(after.information_id);
      if (!informationId) continue;
      const snapshotInfo = info[informationId];
      if (!snapshotInfo) {
        turnIssues.push(planIssue('KNOWLEDGE_INFORMATION_UNKNOWN', '$.information_id',
          '知识指向的信息没有当时快照：卡片不编造内容，只保留「收到一条消息」', { relatedIds: [informationId] }));
      }
      const title = str(snapshotInfo?.title) || labelOf(informationId);
      const content = str(snapshotInfo?.content);
      const truth = str(snapshotInfo?.truth_status);
      const isPov = Number(after.is_pov) === 1;
      const knower = str(after.knower_character_id);
      knowledgeInfos.add(informationId);
      emit(snapshot.rowId, {
        flavor: 'knowledge',
        category: 'message',
        title,
        // 只展示这条信息自己的内容与真伪；绝不转用 source_event.summary。
        summary: `${content || '（这条消息没有可读内容）'}${truth && truth !== 'unknown' ? `（可信度：${truth}）` : ''}`,
        target: { kind: 'information', id: informationId },
        locationId: str(snapshotInfo?.origin_location_id) || null,
        links: [
          { kind: 'information', id: informationId, label: title },
          ...(knower ? [{ kind: 'character' as FeedEntityKind, id: knower, label: labelOf(knower) }] : []),
        ],
        // 主角本人收到的信息属于程序支持的直接见闻；其他人的接收是后台。
        visibility: isPov ? 'known' : 'background',
        factQuality: truth === 'true' ? 'confirmed' : truth === 'false' ? 'reported' : 'reported',
        sourceKind: 'delivery',
      }, snapshot);
    }

    // ── 发现：只有「真的观察到 + 记录成知识」才算发现 ──
    for (const snapshot of snapshots) {
      if (snapshot.table !== 'knowledge') continue;
      const after = asRow(snapshot.after);
      if (after === null || asRow(snapshot.before) !== null) continue;
      const informationId = str(after.information_id);
      const record = info[informationId];
      if (!record || str(record.kind) !== 'observation') continue;
      const subject = str(record.subject_entity_id);
      const origin = str(record.origin_location_id);
      const discovered = subject && kindOf(subject) === 'location' ? subject
        : origin && kindOf(origin) === 'location' ? origin : '';
      if (!discovered) continue;
      emit(snapshot.rowId, {
        flavor: 'observation',
        category: 'discovery',
        title: `发现${labelOf(discovered)}`,
        summary: str(record.content) || `${labelOf(discovered)}第一次被实际观察到。`,
        target: { kind: 'location', id: discovered },
        locationId: discovered,
        links: [{ kind: 'location', id: discovered, label: labelOf(discovered) }],
        visibility: Number(after.is_pov) === 1 ? 'known' : 'background',
        factQuality: 'confirmed',
        sourceKind: 'story',
      }, snapshot);
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

/** 旅程行里能当成「现在在哪」的字段，按可信度取第一个非空。 */
function positionLocation(row: Record<string, unknown>): string | null {
  for (const key of ['stop_location_id', 'last_reached_location_id', 'origin_location_id']) {
    const value = str(row[key]);
    if (value) return value;
  }
  return null;
}

/** rumor_front 的定位说明：它只是「有机会听到」，不是已知情。 */
export const RUMOR_FRONT_IS_OPPORTUNITY_ONLY = true;
