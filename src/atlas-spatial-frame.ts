/**
 * atlas-spatial-frame.ts — M3/W00：新空地图的初始幅面估计 + frame 读写助手。
 *
 * 只做三件事，绝不做第四件：
 * 1. 包一层 vendor 的 `prepareInitialFrame`：新空、未锁定、无已定位地点、缺可信尺度的地图
 *    才能初始化一致纵横比（cols=100、mpp=widthM/100、rows=heightM/mpp）。已有图一律 retained，
 *    继续走现有 map.estimate / 作者校准路径 —— 不覆盖、不重标。
 * 2. 读写 frame 里的两个命名空间（`atlasScene` / `atlasLayoutRequest`），供 W01/W05/W06 复用。
 * 3. 把工具包的 Diagnostic 收敛成宿主 Issue，并把 mapId/operationId/entityId 拼进 message
 *    （§「错误必须能复现」：失败要能按这些字段查回来）。
 *
 * 本模块不开启事务、不写库、不调用模型。
 */

import type { Issue } from './atlas-ops-contract.ts';
import type { Diagnostic, RowMutation, SceneDocument } from '../vendor/atlas-spatial/index.mjs';
import { FRAME_SCENE_KEY, prepareInitialFrame, readSceneFrame } from '../vendor/atlas-spatial/index.mjs';

/** 工具包作用域：与 vendor 的 normalizeScope 同形。 */
export type SpatialScope = {
  chatId: string;
  branchId: string;
  revision: number;
  viewMode: 'pov' | 'author';
};

export const SPATIAL_REQUEST_KEY = 'atlasLayoutRequest';
/**
 * frame_json 里场景命名空间的键。取自工具包权威 `FRAME_SCENE_KEY`，不另造第二份字面量；
 * 需要判「本图是否已有 scene」的模块（如世界建设）引用这里，而不是自己写 'atlasScene'。
 */
export const SPATIAL_SCENE_KEY = FRAME_SCENE_KEY;

export type SpatialIssueContext = {
  mapId?: string;
  branchId?: string;
  revision?: number;
  operationId?: string;
  turnId?: string;
  entityId?: string;
};

/** 工具包诊断 → 宿主 Issue；上下文字段并入 message，避免丢失可复现信息。 */
export function spatialIssue(input: Partial<Diagnostic> & { code: string; path: string; message: string }, ctx: SpatialIssueContext = {}): Issue {
  const parts = [input.message];
  if (ctx.mapId) parts.push(`mapId=${ctx.mapId}`);
  if (ctx.branchId) parts.push(`branchId=${ctx.branchId}`);
  if (ctx.revision !== undefined) parts.push(`revision=${ctx.revision}`);
  if (ctx.operationId) parts.push(`operationId=${ctx.operationId}`);
  if (ctx.turnId) parts.push(`turnId=${ctx.turnId}`);
  if (input.entityId) parts.push(`entityId=${input.entityId}`);
  if (ctx.entityId && ctx.entityId !== input.entityId) parts.push(`entityId=${ctx.entityId}`);
  return {
    code: input.code,
    path: input.path,
    message: parts.join(' ｜ '),
    severity: input.severity === 'warning' ? 'warning' : 'error',
    retryable: input.retryable === true,
  };
}

/** frame_json 可能是字符串（codec 写回后）也可能是对象；统一成对象副本。 */
export function normalizeFrame(frame: unknown): Record<string, unknown> {
  if (typeof frame === 'string') {
    try {
      const parsed: unknown = JSON.parse(frame);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      return {};
    }
    return {};
  }
  if (frame !== null && typeof frame === 'object' && !Array.isArray(frame)) {
    return { ...(frame as Record<string, unknown>) };
  }
  return {};
}

/** 幅面归一的固定错误码；P03/P04/S02 按这些码断言。 */
export type SqlMapFrameCode = 'FRAME_INVALID' | 'FRAME_ALIAS_CONFLICT' | 'FRAME_ORIGIN_INVALID';

/**
 * 归一后的地图幅面。ok=false 时 cols/rows 只作诊断用，调用方不得拿去排位。
 * - 尺寸成功：cols/rows 为正整数；缺必需尺寸、两套字段冲突、尺寸非正整数 → ok=false。
 * - origin：缺省（字段不存在 / null / undefined）按 0；出现但不是有限数 → FRAME_ORIGIN_INVALID
 *   且 ok=false，绝不默默当 0（origin 只影响显示偏移，损坏值就是损坏值，不替它圆场）。
 */
export type SqlMapFrame = {
  ok: boolean;
  /** 正整数；失败时 null —— 绝不返回 NaN 让上层继续排位。 */
  cols: number | null;
  rows: number | null;
  originX: number;
  originY: number;
  /** 原 frame 的浅拷贝：atlasScene / atlasLayoutRequest / 未知扩展字段一律保留、不写回。 */
  frame: Record<string, unknown>;
  issues: Issue[];
};

/** 新旧两套尺寸字段的固定对应表。 */
export const SQL_MAP_FRAME_SIZE_FIELDS = Object.freeze({
  cols: { alias: 'reference_width_cells', label: '宽（格数）' },
  rows: { alias: 'reference_height_cells', label: '高（格数）' },
} as const);

const FRAME_SIZE_ABSENT = 0;
const FRAME_SIZE_OK = 1;
const FRAME_SIZE_BAD = 2;

/** 正整数才算合法尺寸：0、负数、小数、字符串、NaN/Infinity 一律算「写了但不合法」。 */
function probeSize(frame: Record<string, unknown>, key: string): { state: number; value: number | null } {
  if (!Object.prototype.hasOwnProperty.call(frame, key)) return { state: FRAME_SIZE_ABSENT, value: null };
  const raw = frame[key];
  if (raw === undefined || raw === null) return { state: FRAME_SIZE_ABSENT, value: null };
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) return { state: FRAME_SIZE_OK, value: raw };
  return { state: FRAME_SIZE_BAD, value: null };
}

/** 内部先攒裸 Issue，最后统一并一次上下文，避免消息里重复拼接 mapId/branchId。 */
function sizeIssue(code: SqlMapFrameCode, key: string, message: string): Issue {
  return { code, path: `$.frame_json.${key}`, message, severity: 'error', retryable: false };
}

/** 单轴归一：两套字段「同时存在且不一致」报 FRAME_ALIAS_CONFLICT，缺必需尺寸报 FRAME_INVALID。 */
function resolveFrameSize(
  frame: Record<string, unknown>,
  key: 'cols' | 'rows',
  issues: Issue[],
): number | null {
  const { alias, label } = SQL_MAP_FRAME_SIZE_FIELDS[key];
  const primary = probeSize(frame, key);
  const secondary = probeSize(frame, alias);
  if (primary.state === FRAME_SIZE_OK && secondary.state === FRAME_SIZE_OK) {
    if (primary.value !== secondary.value) {
      issues.push(
        sizeIssue('FRAME_ALIAS_CONFLICT', key,
          `${label}两套字段不一致：${key}=${primary.value} 与 ${alias}=${secondary.value}；不猜哪个为准，先让作者纠正`),
      );
      return null;
    }
    return primary.value;
  }
  for (const [probe, probeKey] of [[primary, key], [secondary, alias]] as const) {
    if (probe.state !== FRAME_SIZE_BAD) continue;
    issues.push(
      sizeIssue('FRAME_INVALID', probeKey,
        `${label}字段存在但不是正整数：${probeKey}=${JSON.stringify(frame[probeKey])}；拒绝以 NaN/零幅面继续排位`),
    );
    return null;
  }
  if (primary.state === FRAME_SIZE_OK) return primary.value;
  if (secondary.state === FRAME_SIZE_OK) return secondary.value;
  issues.push(
    sizeIssue('FRAME_INVALID', key,
      `缺少必需的地图幅面${label}：${key} 与 ${alias} 都没有正整数（frame_json 缺失、不是对象，或没有可用尺寸）`),
  );
  return null;
}

/** 单轴 origin：缺省 0；出现则必须是有限数，否则报错并原样交回「不可用」信号。 */
function resolveFrameOrigin(frame: Record<string, unknown>, key: 'origin_x' | 'origin_y', issues: Issue[]): number {
  if (!Object.prototype.hasOwnProperty.call(frame, key)) return 0;
  const raw = frame[key];
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  issues.push(
    sizeIssue('FRAME_ORIGIN_INVALID', key,
      `幅面原点不是有限数：${key}=${JSON.stringify(raw)}；不默默按 0 替代，先纠正损坏字段`),
  );
  return Number.NaN;
}

/**
 * M2-08A：旧新幅面字段统一归一。
 *
 * 供 compileSqlSceneMaps / layout-task / 任何需要读 maps.frame_json 尺寸的地方统一调用，
 * 不再各自复制 `frame.cols ?? frame.reference_width_cells ?? 100` 这种 fallback
 * （那种写法会把 120×80 的旧档悄悄当成 100×100，也会把 `Number(frame.cols)` 的 NaN 放进排位）。
 *
 * 纯函数：不写库、不发请求、不改传入对象。
 */
export function normalizeSqlMapFrame(frame: unknown, ctx: SpatialIssueContext = {}): SqlMapFrame {
  const normalized = normalizeFrame(frame);
  const issues: Issue[] = [];
  const cols = resolveFrameSize(normalized, 'cols', issues);
  const rows = resolveFrameSize(normalized, 'rows', issues);
  const originX = resolveFrameOrigin(normalized, 'origin_x', issues);
  const originY = resolveFrameOrigin(normalized, 'origin_y', issues);
  const ok = cols !== null && rows !== null && issues.length === 0;
  return {
    ok,
    cols,
    rows,
    originX,
    originY,
    // 浅拷贝：扩展字段（atlasScene / atlasLayoutRequest / 未知键）完整保留，归一结果不写回。
    frame: normalized,
    issues: issues.map((item) => spatialIssue(item, ctx)),
  };
}

export type SpatialFrameRead = {
  ok: boolean;
  frame: Record<string, unknown>;
  scene: SceneDocument | null;
  /** 待处理/失败的布局请求；没有则 null。 */
  request: Record<string, unknown> | null;
  issues: Issue[];
};

/** 一次读出 frame 的两个命名空间；scene 走工具包校验（版本/分支/地图不匹配会报诊断）。 */
export function readSpatialFrame(
  frame: unknown,
  scope: { branchId: string; mapId: string },
  ctx: SpatialIssueContext = {},
): SpatialFrameRead {
  const normalized = normalizeFrame(frame);
  const read = readSceneFrame(normalized, scope) as { ok: boolean; scene: SceneDocument | null; issues: Diagnostic[] };
  const issues = (read.issues ?? []).map((item) => spatialIssue(item, ctx));
  const rawRequest = normalized[SPATIAL_REQUEST_KEY];
  return {
    ok: read.ok,
    frame: normalized,
    scene: read.ok ? read.scene : null,
    request: rawRequest !== null && typeof rawRequest === 'object' && !Array.isArray(rawRequest)
      ? { ...(rawRequest as Record<string, unknown>) }
      : null,
    issues,
  };
}

export type InitialFrameInput = {
  mapRow: Record<string, unknown>;
  scope: SpatialScope;
  currentScope: SpatialScope;
  expectedRowRev: number;
  widthM?: number | null;
  heightM?: number | null;
  locations?: Array<Record<string, unknown>>;
  turnId: string;
  operationId: string;
};

export type InitialFrameResult = {
  ok: boolean;
  status: 'prepared' | 'retained' | 'failed';
  mutation: RowMutation | null;
  issues: Issue[];
};

/** 工具包 prepareInitialFrame 的实际返回形状（声明里是 Record<string,any>）。 */
type KitInitial = { ok: boolean; status: string; mutation: RowMutation | null; issues: Diagnostic[] };

/**
 * W00 ensureInitialSpatialFrame：新空图才有资格初始化。
 *
 * - prepared：给出一条普通 maps RowMutation（cols=100、尺度 estimated、calibration_rev+1）。
 * - retained：已有 scene / 已定位地点 / 锁定或已确认尺度 → 不写，沿用现有标定路径。
 * - 没有尺寸也不算错误：退回概览并记一条缺项 warning（不把整轮判失败）。
 */
export function ensureInitialSpatialFrame(input: InitialFrameInput): InitialFrameResult {
  const mapId = typeof input.mapRow?.id === 'string' ? input.mapRow.id : '';
  const ctx: SpatialIssueContext = {
    mapId,
    branchId: input.scope?.branchId,
    revision: input.scope?.revision,
    operationId: input.operationId,
    turnId: input.turnId,
  };
  let prepared: KitInitial;
  try {
    // 缺尺寸时传 NaN 而不是 0：工具包的 finite() 会判成 INITIAL_EXTENT_REQUIRED，
    // 由下面转成「走概览 + 记缺项」，绝不拿 0 去算出一个 0 跨度的框。
    prepared = prepareInitialFrame({
      mapRow: input.mapRow,
      scope: input.scope,
      currentScope: input.currentScope,
      expectedRowRev: input.expectedRowRev,
      widthM: typeof input.widthM === 'number' ? input.widthM : Number.NaN,
      heightM: typeof input.heightM === 'number' ? input.heightM : Number.NaN,
      locations: input.locations ?? [],
      turnId: input.turnId,
      operationId: input.operationId,
    }) as KitInitial;
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      mutation: null,
      issues: [spatialIssue({ code: 'INITIAL_FRAME_INVALID', path: '$.frame_json', message: `初始化幅面失败：${(err as Error).message}` }, ctx)],
    };
  }

  const issues = (prepared.issues ?? []).map((item) => spatialIssue(item, ctx));
  if (prepared.ok && prepared.mutation) {
    return { ok: true, status: 'prepared', mutation: prepared.mutation, issues };
  }
  // 没有尺寸也不算错误：退回概览并记一条缺项 warning（不把整轮判失败）。
  const missing =
    typeof input.widthM !== 'number' || typeof input.heightM !== 'number' ||
    !Number.isFinite(input.widthM) || !Number.isFinite(input.heightM) ||
    issues.some((item) => item.code === 'INITIAL_EXTENT_REQUIRED');
  if (missing) {
    return {
      ok: true,
      status: 'retained',
      mutation: null,
      issues: [
        spatialIssue(
          {
            code: 'INITIAL_EXTENT_MISSING',
            path: '$.data.spec',
            message: '新空地图没有可用尺寸：本轮沿用概览，等地图标定或布局请求给出宽高后再初始化。',
            severity: 'warning',
          },
          ctx,
        ),
      ],
    };
  }
  if (prepared.ok) {
    return { ok: true, status: 'retained', mutation: null, issues };
  }
  return { ok: false, status: 'failed', mutation: null, issues };
}

export { FRAME_SCENE_KEY };
