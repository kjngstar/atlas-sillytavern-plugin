/**
 * atlas-scene-layout.ts — 只读场景布局（M2-07 稳定排位 / 旧接口兼容）。
 *
 * `placeUnlocatedScenePoints`（02 §4.1）固定规则：
 * 1. `existing` 里**有效有限**的真实/估计/示意坐标全部固定保留——不能只锁 exact，
 *    更不能因为新实体插进来就重排老点。
 * 2. `pending` 按 ID 排序；默认 `minGapCells = max(1, min(cols,rows)/12)`；
 *    目标优先取合法方位 hint，否则取 frame 中心。程序里**没有**剧情模板或中文关键字。
 * 3. 以稳定哈希 `seed + entityId` 决定黄金角螺旋的起始序号；围绕目标最多 512 个候选，
 *    每个候选都必须落在留白边界内，并与 obstacle / 已放点保持间隔。
 * 4. 找不到位置时按间隔 1 → 0.75 → 0.5 三档重试；仍找不到返回 `PLACEMENT_FULL` +
 *    `remainingIds`。绝不把多个点默默叠到 (0,0)，也绝不重排老点。
 * 5. 返回的 placed 一律 `precision='layout'`（示意坐标，不是真实位置）。
 *
 * 也**不**允许 `Math.random` / `Date.now`：同一输入必须给出同一结果（P01）。
 */

import type { Extent, PlanIssue, Point } from './atlas-world-contract.ts';

const GOLDEN_ANGLE = 2.399963229728653;
const MAX_CANDIDATES = 512;
const GAP_RETRY_FACTORS = [1, 0.75, 0.5] as const;

export type PlacementInput = {
  frame: { cols: number; rows: number };
  existing: Array<Point & { id: string }>;
  pending: Array<{ id: string; hint?: Point }>;
  obstacles: Extent[];
  minGapCells?: number;
  seed: string;
};

export type PlacementResult = {
  placed: Array<Point & { id: string; precision: 'layout'; reason: string }>;
  remainingIds: string[];
  issues: PlanIssue[];
};

function placementIssue(code: string, message: string, severity: PlanIssue['severity'] = 'error', extra: Partial<PlanIssue> = {}): PlanIssue {
  return { code, path: '$.placeUnlocatedScenePoints', message, severity, retryable: false, ...extra };
}

/** 稳定 32 位哈希：同样的 (seed, id) 永远给同样的起始序号，不依赖随机/时间。 */
function stableHash(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isFinitePoint(value: unknown): value is Point {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isFinite((value as Point).x) &&
    Number.isFinite((value as Point).y)
  );
}

/** 点到矩形的最短距离（点在矩形内 → 0）。 */
function distanceToExtent(point: Point, extent: Extent): number {
  const dx = Math.max(extent.x - point.x, 0, point.x - (extent.x + extent.w));
  const dy = Math.max(extent.y - point.y, 0, point.y - (extent.y + extent.h));
  return Math.hypot(dx, dy);
}

function outsideAll(neighbourhood: number, distances: number[]): boolean {
  return distances.every((distance) => distance >= neighbourhood);
}

export function placeUnlocatedScenePoints(input: PlacementInput): PlacementResult {
  const issues: PlanIssue[] = [];
  const pendingIds = input.pending.map((entry) => entry.id);
  const cols = Number(input.frame?.cols);
  const rows = Number(input.frame?.rows);
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
    issues.push(
      placementIssue('FRAME_INVALID', `场景 frame 必须是有限正数（收到 cols=${String(input.frame?.cols)}, rows=${String(input.frame?.rows)}）：拒绝以 NaN/零幅面继续排位`),
    );
    return { placed: [], remainingIds: [...pendingIds].sort(), issues };
  }

  const defaultGap = Math.max(1, Math.min(cols, rows) / 12);
  const requestedGap = input.minGapCells === undefined ? defaultGap : Number(input.minGapCells);
  if (!Number.isFinite(requestedGap) || requestedGap <= 0) {
    issues.push(placementIssue('MIN_GAP_INVALID', `minGapCells 必须是有限正数（收到 ${String(input.minGapCells)}）`));
    return { placed: [], remainingIds: [...pendingIds].sort(), issues };
  }
  const minGap = requestedGap;
  // 留白边界：四周各留一个间隔，保证点在可见范围内而不是贴边。
  const lowX = Math.min(minGap, cols / 2);
  const lowY = Math.min(minGap, rows / 2);
  const highX = Math.max(lowX, cols - minGap);
  const highY = Math.max(lowY, rows - minGap);

  // ── 1. 老点固定：有效有限的旧坐标全部进 occupied，ordinal 不变 ────────
  const occupied: Array<{ id: string; point: Point }> = [];
  for (const entry of input.existing) {
    if (!isFinitePoint(entry)) continue;
    occupied.push({ id: entry.id, point: { x: entry.x, y: entry.y } });
  }

  const obstacles: Extent[] = [];
  for (const extent of input.obstacles) {
    const candidate = extent as Partial<Extent> | null | undefined;
    if (
      !candidate ||
      !Number.isFinite(candidate.x) ||
      !Number.isFinite(candidate.y) ||
      !Number.isFinite(candidate.w) ||
      !Number.isFinite(candidate.h) ||
      Number(candidate.w) < 0 ||
      Number(candidate.h) < 0
    ) {
      issues.push(placementIssue('OBSTACLE_INVALID', '存在非法障碍（坐标为 NaN/∞ 或宽高为负）：该障碍按忽略处理，其余照常排位', 'warning'));
      continue;
    }
    obstacles.push({ x: Number(candidate.x), y: Number(candidate.y), w: Number(candidate.w), h: Number(candidate.h) });
  }

  const placed: PlacementResult['placed'] = [];
  const remainingIds: string[] = [];

  // ── 2. pending 按 ID 排序：输入顺序不影响结果 ────────────────────────
  const pending = [...input.pending].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const entry of pending) {
    const rawHint = entry.hint;
    let target: Point = { x: (lowX + highX) / 2, y: (lowY + highY) / 2 };
    let reason = 'layout:center';
    if (rawHint !== undefined) {
      if (isFinitePoint(rawHint)) {
        target = {
          x: Math.min(highX, Math.max(lowX, rawHint.x)),
          y: Math.min(highY, Math.max(lowY, rawHint.y)),
        };
        reason = 'layout:hint';
      } else {
        issues.push(
          placementIssue('HINT_INVALID', `实体 ${entry.id} 的方位 hint 不是有限坐标：按 frame 中心处理`, 'warning', {
            locationId: entry.id,
          }),
        );
      }
    }

    const startIndex = stableHash(`${input.seed}\u0000${entry.id}`) % MAX_CANDIDATES;
    let chosen: Point | null = null;
    let chosenGap = minGap;
    for (const factor of GAP_RETRY_FACTORS) {
      const neighbourhood = minGap * factor;
      for (let step = 0; step < MAX_CANDIDATES; step += 1) {
        const index = startIndex + step;
        const radius = neighbourhood * Math.sqrt(step + 1);
        const angle = index * GOLDEN_ANGLE;
        const candidate: Point = { x: target.x + radius * Math.cos(angle), y: target.y + radius * Math.sin(angle) };
        // 必须留在留白边界内（第一个候选就是目标本身，也要过这一关）。
        if (candidate.x < lowX || candidate.x > highX || candidate.y < lowY || candidate.y > highY) continue;
        const pointsOk = outsideAll(
          neighbourhood,
          occupied.map((item) => Math.hypot(candidate.x - item.point.x, candidate.y - item.point.y)),
        );
        if (!pointsOk) continue;
        if (!outsideAll(neighbourhood, obstacles.map((extent) => distanceToExtent(candidate, extent)))) continue;
        chosen = candidate;
        chosenGap = neighbourhood;
        break;
      }
      if (chosen) break;
    }

    if (!chosen) {
      remainingIds.push(entry.id);
      continue;
    }
    occupied.push({ id: entry.id, point: chosen });
    placed.push({
      ...chosen,
      id: entry.id,
      precision: 'layout',
      reason: chosenGap === minGap ? reason : `${reason}:tightened`,
    });
  }

  if (remainingIds.length > 0) {
    issues.push(
      placementIssue(
        'PLACEMENT_FULL',
        `场景内没有可用空位：${remainingIds.length} 个示意点未能排位（不会叠到同一点）`,
        'error',
        { relatedIds: [...remainingIds] },
      ),
    );
  }

  return { placed, remainingIds: remainingIds.sort(), issues };
}

/**
 * 旧接口（兼容视图）：把显示用示意点按下面的相对方位表重新表达。
 *
 * 注意：**中文方位表只属于这个旧接口**，不属于 `placeUnlocatedScenePoints`。
 * 02 §4.1 要求新算法里没有剧情模板；但既有 UI 靠这张表把「窗边 / 门口」这类
 * 叙述落成可点的相对位置，所以兼容层原样保留，不能因为新算法上线就把交互改掉。
 * 仍保留导出，避免旧调用方断裂；新代码请直接用 placeUnlocatedScenePoints。
 */
function interiorPositionHint(action: string, id: string): { x: number; y: number; label: string } | null {
  const zones: Array<[RegExp, number, number, string]> = [
    [/(窗边|窗旁|靠窗|window)/i, 80, 30, "窗边"],
    [/(门口|门边|门旁|门前|入口|巷口|路口|door)/i, 18, 80, "入口附近"],
    [/(角落|墙角|corner)/i, 18, 18, "角落"],
    [/(桌边|桌旁|桌子|课桌|讲台|desk|table)/i, 55, 55, "桌旁"],
    [/(中央|中间|中心|center|middle)/i, 50, 45, "中央"],
    [/(左侧|左边|left)/i, 22, 50, "左侧"],
    [/(右侧|右边|right)/i, 78, 50, "右侧"],
  ];
  const zone = zones.map((entry) => {
    const matches = [...action.matchAll(new RegExp(entry[0].source, "gi"))];
    return { entry, index: matches.length ? matches[matches.length - 1]!.index : -1 };
  }).sort((a, b) => b.index - a.index)[0];
  if (!zone || zone.index < 0) return null;
  let hash = 0;
  for (const letter of id) hash = (Math.imul(hash, 31) + letter.charCodeAt(0)) | 0;
  return { x: zone.entry[1] + ((hash >>> 0) % 11) - 5,
    y: zone.entry[2] + (((hash >>> 4) % 11) - 5), label: zone.entry[3] };
}

export function scenePositions(
  rows: Array<{ id: string; currentAction?: string; positionHint?: string }>,
  frame: { cols: number; rows: number },
): Map<string, { x: number; y: number; label: string }> {
  const cols = Math.max(1, frame.cols), height = Math.max(1, frame.rows);
  const width = Math.max(1, Math.ceil(Math.sqrt(rows.length * cols / height)));
  const depth = Math.max(1, Math.ceil(rows.length / width));
  const slots = Array.from({ length: width * depth }, (_, i) => ({
    x: width === 1 ? 50 : 18 + (i % width) * 64 / (width - 1),
    y: depth === 1 ? 50 : 18 + Math.floor(i / width) * 64 / (depth - 1),
  }));
  const result = new Map<string, { x: number; y: number; label: string }>();
  const occupied: Array<{ x: number; y: number }> = [];
  const gap = Math.min(12, 45 / Math.sqrt(Math.max(1, rows.length)));
  const ordered = [...rows].sort((a, b) => Number(Boolean(b.positionHint || b.currentAction)) - Number(Boolean(a.positionHint || a.currentAction)) || a.id.localeCompare(b.id));
  for (const row of ordered) {
    const hint = interiorPositionHint(row.positionHint || row.currentAction || "", row.id);
    let index = 0;
    if (hint) {
      let best = Infinity;
      slots.forEach((slot, i) => { const score = (slot.x - hint.x) ** 2 + (slot.y - hint.y) ** 2;
        if (score < best) { best = score; index = i; } });
    }
    let slot = slots.splice(index, 1)[0]!;
    const desired = hint ?? slot;
    for (let attempt = 0; attempt < 300; attempt++) {
      const radius = attempt === 0 ? 0 : gap * Math.sqrt(attempt);
      const angle = attempt * 2.399963;
      const candidate = { x: Math.max(14, Math.min(86, desired.x + radius * Math.cos(angle))),
        y: Math.max(14, Math.min(86, desired.y + radius * Math.sin(angle))) };
      if (occupied.every((point) => Math.hypot(candidate.x - point.x, candidate.y - point.y) >= gap)) {
        slot = candidate; break;
      }
    }
    occupied.push(slot);
    // 相对方位按本场景实际格数缩放；示意坐标绝不写回三表。
    result.set(row.id, { x: slot.x * cols / 100, y: slot.y * height / 100,
      label: row.positionHint || hint?.label || "场景内，细部位置估计" });
  }
  return result;
}
