/**
 * atlas-signal-propagation.ts — D02：消息**逐跳**传播规划（纯函数，零 IO）。
 *
 * 依据《Atlas v0.9.58 → 下一版本施工计划》§2.5 与 D02：
 *
 * 1. **人物得知某消息必须由一条有来源的送达记录证实**。本模块只产出「送达请求」，
 *    由 `atlas-simulation.ts` 赋确定性 ID 后并入 `deliveries`——信号的**存在**本身
 *    不会改变任何人的知识或反应。
 * 2. 第 0 时段**不跨区传播**：没有时间推进，风声一步都不许走
 *    （发起地与会真正同地目击的送达由 `applySimulationEffects` 在时段 0 内单独完成）。
 * 3. 每完整新时段，普通风声沿**已确认的边**最多走 1 跳；同轮跨多个时段就按真实时段数推进。
 *    路径只读 `geoTopology.edges`——**容器 parent 链不是通道**（§2.5），没有边就是 NO_PATH。
 * 4. 关联人物不等于直接得知：只有送达记录能解锁「此人可能反应」的候选，
 *    本模块**不指定**任何人的态度、地点或移动。
 * 5. 有界：每回合最多扫描 20 个候选、最多新增 8 个收件人；超限把确定性排序下标存进
 *    `signal.propagationCursor`，下一轮接着处理，**不丢候选**。
 *
 * 关于「超常通信加速」：通信边（`kind:"communication"`）同样按 1 跳 / 时段保守处理。
 * 首版**刻意不做**加速——宁可慢，也不让一条边把消息瞬移到全图。
 */

import {
  buildEdgeAdjacency,
  neighborsOf,
  type AtlasGeoTopology,
} from "./atlas-geo-topology.ts";
import type {
  AtlasDeliveryConfidence,
  AtlasDeliveryVia,
  AtlasSignal,
} from "./atlas-simulation.ts";

/** 每回合最多新增的收件人（§2.5 硬上限）。 */
export const ATLAS_SIGNAL_MAX_NEW_RECIPIENTS = 8;
/** 每回合最多扫描的候选（§2.5 硬上限）。 */
export const ATLAS_SIGNAL_MAX_SCANS = 20;

/** 传播候选里的人物投影：位置未知（null）的人**不在任何接收点**，不得凭空得知。 */
export interface AtlasPropagationCharacterLocation {
  id: string;
  locationId: string | null;
}

/**
 * 一条**尚未分配 ID** 的送达请求。
 * ID 由 `simulationDeliveryId(signalId, recipientType, recipientId)` 给出，
 * 因此「同一 signal + 同一收件人」天然幂等——本模块只负责判断「该不该送」。
 */
export interface AtlasDeliveryRequest {
  signalId: string;
  recipientType: "location" | "character";
  recipientId: string;
  via: AtlasDeliveryVia;
  fromLocationId: string;
  receivedPeriod: number;
  confidence: AtlasDeliveryConfidence;
}

export interface AtlasSignalSpreadInput {
  topology: AtlasGeoTopology;
  /** 本分支当前的全部信号（含本轮新登记的那条）。 */
  signals: readonly AtlasSignal[];
  /** 已经存在的送达（幂等去重的基线）。 */
  deliveries: readonly { signalId: string; recipientType: string; recipientId: string }[];
  /** 本分支人物的位置投影（引擎从三表取，本模块不读表）。 */
  characterLocations: readonly AtlasPropagationCharacterLocation[];
  /** 当前时间游标（时段序号）。 */
  period: number;
  /** 本轮推进的**完整**新时段数；0 = 不跨区传播。 */
  periodsElapsed: number;
  maxNewRecipients?: number;
  maxScans?: number;
}

export interface AtlasSignalSpreadDiagnostic {
  code: "NO_TIME" | "NO_PATH" | "BACKLOG" | "LIMIT_REACHED";
  signalId: string | null;
  locationId: string | null;
  detail?: string;
}

export interface AtlasSignalSpreadResult {
  /** 本轮新增的送达请求（调用方赋 ID 后并入 deliveries）。 */
  deliveries: AtlasDeliveryRequest[];
  /** 更新后的传播游标：signalId → 下一批候选的确定性排序下标。 */
  cursors: Record<string, number>;
  diagnostics: AtlasSignalSpreadDiagnostic[];
  scanned: number;
  backlog: number;
}

/**
 * 从 `originLocationId` 出发、沿已确认边走 `maxHops` 跳能到达的地点及其跳数。
 * 结果只依赖边的集合与起点，因此同一份输入永远得到同一份可达集（可重放）。
 */
export function reachableLocationsWithin(
  topology: AtlasGeoTopology,
  originLocationId: string,
  maxHops: number,
): Map<string, number> {
  const adjacency = buildEdgeAdjacency(topology);
  const distance = new Map<string, number>([[originLocationId, 0]]);
  if (maxHops <= 0) return distance;
  let frontier: string[] = [originLocationId];
  for (let hop = 1; hop <= maxHops; hop += 1) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbor of neighborsOf(adjacency, node)) {
        if (distance.has(neighbor.locationId)) continue;
        distance.set(neighbor.locationId, hop);
        next.push(neighbor.locationId);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return distance;
}

/**
 * D02：为当前分支的全部活动信号规划这一轮的送达。
 *
 * 纪律：**第 0 时段一步都不走**；没有确认边就是 `NO_PATH`（绝不猜路径、绝不瞬移）；
 * 事件只解锁「此人已知」，不指定此人支持或反对任何立场。
 */
export function planSignalSpread(input: AtlasSignalSpreadInput): AtlasSignalSpreadResult {
  const maxNew = Math.max(0, Math.floor(input.maxNewRecipients ?? ATLAS_SIGNAL_MAX_NEW_RECIPIENTS));
  const maxScans = Math.max(0, Math.floor(input.maxScans ?? ATLAS_SIGNAL_MAX_SCANS));
  const result: AtlasSignalSpreadResult = {
    deliveries: [], cursors: {}, diagnostics: [], scanned: 0, backlog: 0,
  };

  const exists = new Set(
    input.deliveries.map((row) => `${row.signalId}|${row.recipientType}|${row.recipientId}`),
  );
  // 会合点 → 在场人物（按 id 排序，保证候选顺序确定）
  const occupants = new Map<string, string[]>();
  for (const person of input.characterLocations) {
    if (person.locationId === null || person.locationId.length === 0) continue;
    const list = occupants.get(person.locationId) ?? [];
    list.push(person.id);
    occupants.set(person.locationId, list);
  }
  for (const list of occupants.values()) list.sort();

  const periods = Math.max(0, Math.floor(input.periodsElapsed));

  for (const signal of [...input.signals].sort((a, b) => a.id.localeCompare(b.id))) {
    if (signal.status !== "active") continue;
    const reachable = reachableLocationsWithin(input.topology, signal.originLocationId, periods);
    // 候选 = 除发起地以外的可达地点，先近后远、同跳按 id 升序
    const candidates = [...reachable.entries()]
      .filter(([locationId]) => locationId !== signal.originLocationId)
      .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] - b[1]));

    // 第 0 时段：只登记「暂时传不出去」的原因，绝不凭空送达
    if (periods === 0) {
      // 注意：可达集是按 0 跳算的（只剩发起地），所以这里要**另外**看一眼有没有邻居，
      // 否则 NO_TIME 永远被判成 NO_PATH——把「等时间」误报成「没有路」。
      const hasNeighbor = reachableLocationsWithin(input.topology, signal.originLocationId, 1).size > 1;
      result.diagnostics.push(hasNeighbor
        ? {
            code: "NO_TIME", signalId: signal.id, locationId: signal.originLocationId,
            detail: "时间未推进：风声不跨区",
          }
        : {
            code: "NO_PATH", signalId: signal.id, locationId: signal.originLocationId,
            detail: "发起地没有已确认的邻接 / 路线 / 通信边",
          });
      result.cursors[signal.id] = signal.propagationCursor;
      continue;
    }
    if (candidates.length === 0) {
      result.diagnostics.push({
        code: "NO_PATH", signalId: signal.id, locationId: signal.originLocationId,
        detail: "发起地没有已确认的邻接 / 路线 / 通信边",
      });
      result.cursors[signal.id] = signal.propagationCursor;
      continue;
    }

    let cursor = Math.max(0, Math.min(signal.propagationCursor, candidates.length));
    while (cursor < candidates.length) {
      if (result.scanned >= maxScans || result.deliveries.length >= maxNew) break;
      const [locationId, hops] = candidates[cursor]!;
      result.scanned += 1;
      cursor += 1;

      // 接收地本身算一处「风声到达」；多跳之后只是传言，不是已核实事实
      const confidence: AtlasDeliveryConfidence = hops <= 1 ? "confirmed" : "rumor";
      const locationKey = `${signal.id}|location|${locationId}`;
      if (!exists.has(locationKey) && result.deliveries.length < maxNew) {
        exists.add(locationKey);
        result.deliveries.push({
          signalId: signal.id, recipientType: "location", recipientId: locationId,
          via: "contact", fromLocationId: signal.originLocationId,
          receivedPeriod: input.period, confidence,
        });
      }
      // 在场人物：有记录地「在此处听到」才算得知
      for (const characterId of occupants.get(locationId) ?? []) {
        if (result.deliveries.length >= maxNew) break;
        const key = `${signal.id}|character|${characterId}`;
        if (exists.has(key)) continue;
        exists.add(key);
        result.deliveries.push({
          signalId: signal.id, recipientType: "character", recipientId: characterId,
          via: "contact", fromLocationId: signal.originLocationId,
          receivedPeriod: input.period, confidence,
        });
      }
    }

    result.cursors[signal.id] = cursor;
    if (cursor < candidates.length) {
      result.backlog += candidates.length - cursor;
      result.diagnostics.push({
        code: "BACKLOG", signalId: signal.id, locationId: null,
        detail: String(candidates.length - cursor),
      });
    }
  }

  if (result.deliveries.length >= maxNew && result.backlog > 0) {
    result.diagnostics.push({ code: "LIMIT_REACHED", signalId: null, locationId: null, detail: String(maxNew) });
  }
  return result;
}
