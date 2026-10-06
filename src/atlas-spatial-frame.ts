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
