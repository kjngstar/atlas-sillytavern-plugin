/**
 * atlas-spatial-branch.ts — M3/W06：fork 时把父分支的场景搬到子分支。
 *
 * 纪律（改这个文件前先读一遍）：
 * 1. **纯函数**：不改传入的 frame / scene 对象，不读库、不写库。
 * 2. **父分支的 pending 布局请求不执行**：子分支复制时直接删掉，绝不在 fork 里跑生成器。
 * 3. **保留 provenance**：几何、约束、生成器版本一律原样带过去，只重写 `branchId` 与 `sourceRevision`。
 * 4. **未知 / 损坏的场景保留但标不可用**：fork 不能成为清存档的借口。
 */

import type { Issue } from './atlas-ops-contract.ts';
import { checkSceneDocument } from '../vendor/atlas-spatial/index.mjs';
import { FRAME_SCENE_KEY, SPATIAL_REQUEST_KEY, normalizeFrame, spatialIssue } from './atlas-spatial-frame.ts';

export type CopySceneResult = {
  /** frame 本身不可解析时才 false；场景不可用不算失败。 */
  ok: boolean;
  /** 新 frame（父对象与父场景都没有被改动）。 */
  frame: Record<string, unknown>;
  /** 复制出来的场景可用（能通过文档校验）。 */
  sceneUsable: boolean;
  issues: Issue[];
};

function issue(code: string, path: string, message: string, severity: 'warning' | 'error' = 'warning'): Issue {
  return { code, path, message, severity, retryable: false };
}

/**
 * W06 copySceneForBranch：给子分支一份能读的场景。
 *
 * - 没有 scene 的旧存档 → 原样保留（其他 frame 字段不动）。
 * - 有 scene → 重写 branchId/sourceRevision，保留 provenance 与几何；父 pending 请求删除。
 * - scene 校验不通过 → 保留 scene 但在 frame 上标 `atlasSceneUnavailable`，供 UI 提示。
 */
export function copySceneForBranch(frame: unknown, newBranchId: string, newRevision: number): CopySceneResult {
  const issues: Issue[] = [];
  if (typeof newBranchId !== 'string' || newBranchId.length === 0) {
    return {
      ok: false,
      frame: normalizeFrame(frame),
      sceneUsable: false,
      issues: [issue('BRANCH_ID_REQUIRED', '$.newBranchId', '复制场景需要目标分支标识', 'error')],
    };
  }
  const revision = Number.isFinite(newRevision) ? Number(newRevision) : 0;

  const raw = typeof frame === 'string' ? frame : frame === null || frame === undefined ? null : frame;
  if (raw === null) {
    return { ok: true, frame: {}, sceneUsable: false, issues };
  }
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, frame: {}, sceneUsable: false, issues: [issue('FRAME_JSON_INVALID', '$.frame_json', '地图框架不是对象，无法复制到新分支', 'error')] };
      }
    } catch {
      return { ok: false, frame: {}, sceneUsable: false, issues: [issue('FRAME_JSON_INVALID', '$.frame_json', '地图框架损坏，无法复制到新分支', 'error')] };
    }
  } else if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, frame: {}, sceneUsable: false, issues: [issue('FRAME_JSON_INVALID', '$.frame_json', '地图框架不是对象，无法复制到新分支', 'error')] };
  }

  const next = normalizeFrame(raw);
  // 父分支还没跑的布局请求不带到子分支：fork 不是执行器。
  delete next[SPATIAL_REQUEST_KEY];
  delete next.atlasSceneUnavailable;

  const scene = next[FRAME_SCENE_KEY];
  if (scene === null || typeof scene !== 'object' || Array.isArray(scene)) {
    return { ok: true, frame: next, sceneUsable: false, issues };
  }
  const doc = scene as Record<string, unknown>;
  const checks = checkSceneDocument(doc as never) as Array<{ code: string; path: string; message: string }>;
  const copied: Record<string, unknown> = {
    ...doc,
    branchId: newBranchId,
    sourceRevision: revision,
  };
  // provenance 只能补充，不能覆盖父分支留下的来源信息。
  if (doc.provenance === null || doc.provenance === undefined) {
    copied.provenance = {
      copiedFromBranchId: typeof doc.branchId === 'string' ? doc.branchId : null,
      copiedFromRevision: typeof doc.sourceRevision === 'number' ? doc.sourceRevision : null,
      copiedAtRevision: revision,
    };
  }
  next[FRAME_SCENE_KEY] = copied;

  if (checks.length > 0) {
    // 未知版本或几何不可绘制：保留场景但标不可用，绝不因为 fork 清掉存档。
    next.atlasSceneUnavailable = {
      reason: checks[0].code,
      issues: checks.map((item) => ({ code: item.code, path: item.path, message: item.message })),
    };
    for (const item of checks) {
      issues.push(spatialIssue({ code: item.code, path: item.path, message: `复制的场景暂不可用：${item.message}` }, { branchId: newBranchId, revision }));
    }
    return { ok: true, frame: next, sceneUsable: false, issues };
  }
  return { ok: true, frame: next, sceneUsable: true, issues };
}
