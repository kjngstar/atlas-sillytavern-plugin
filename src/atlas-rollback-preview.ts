/**
 * atlas-rollback-preview.ts — P14/§21.4：回退影响预览（**只读**）。
 *
 * 回退按钮在执行前必须让作者看到真实影响范围：
 *  - 目标正文楼层；
 *  - 将一并撤销的后续推演（含手动建设结果）——来自 `planRollback().turns`，不是数 UI 卡片；
 *  - 受影响的地图与建设进度范围（来自真实 step 的目标表/行）；
 *  - 时钟会回到哪个值。
 *
 * 这里的 `summarizeRollbackPlan` 是**纯函数**：不读库、不写库，只把已经算好的计划与
 * 调用方查到的 turn 行整理成 DTO。真正的计划仍由 `planRollback`（只读）产出，
 * 执行仍走既有候选 + ACK + journal 的 `/sql/chat/rollback`。
 *
 * 视角纪律：`viewMode==='pov'` 时只给**计数**，不给楼层之外的 ID 清单
 * （受影响的行里可能包含主角看不见的地点/地图），`withheld=true` 明示这一点。
 */

import type { Issue } from './atlas-ops-contract.ts';
import type { RollbackPlan, RollbackStep } from './atlas-db-rollback.ts';

/** 计划里被触及、且属于「建设进度」的行所携带的作用域键。 */
const PROGRESS_TABLE = 'construction_progress';
const MAP_TABLE = 'maps';

export type RollbackPreviewTurn = {
  turnId: string;
  /** 正文楼层号（`decisions.host_message_index`），读不到就是 null，不编一个。 */
  floor: string | null;
  kind: string;
  /** 这一楼是不是作者手动动作（map/build、标定、主角设置…）。 */
  manual: boolean;
  status: string | null;
};

export type RollbackPreviewV1 = {
  version: 1;
  branchId: string;
  targetTurnId: string;
  targetFloor: string | null;
  /** 将一并撤销的楼层，**含目标楼本身**（与 `plan.turns` 一致）。 */
  affectedTurns: RollbackPreviewTurn[];
  affectedTurnCount: number;
  manualTurnCount: number;
  steps: number;
  clockBeforeS: number;
  clockTargetS: number;
  tableCounts: Record<string, number>;
  /** 会被删除/恢复的地图 id（POV 下为空，用 `withheld` 说明）。 */
  affectedMaps: string[];
  /** 会被恢复的建设进度作用域键（只在能读到真实行时才列，POV 下为空）。 */
  affectedProgressScopes: string[];
  /** 行级清单是否因视角被隐去。 */
  withheld: boolean;
  issues: Issue[];
};

export type RollbackPreviewInput = {
  /** 受影响 turn 的行信息（调用方按 `plan.turns` 查真实 turns 表得出）。 */
  turns?: ReadonlyArray<RollbackPreviewTurn>;
  viewMode?: 'author' | 'pov';
};

const text = (value: unknown): string => (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value));

/** 从「要写回的整行」里读作用域键；insert 的行 restore 为 null，读不到就不列。 */
function scopeKeyOf(step: RollbackStep): string {
  const restore = step.restore;
  if (!restore || typeof restore !== 'object') return '';
  return text((restore as Record<string, unknown>).scope_key);
}

export function summarizeRollbackPlan(plan: RollbackPlan, input: RollbackPreviewInput = {}): RollbackPreviewV1 {
  const viewMode = input.viewMode === 'pov' ? 'pov' : 'author';
  const withheld = viewMode !== 'author';
  const turns = [...(input.turns ?? [])];
  const steps = Array.isArray(plan.steps) ? plan.steps : [];

  const maps = new Set<string>();
  const scopes = new Set<string>();
  for (const step of steps) {
    // 目标表名以计划为准：回退计划里出现的表就是要动到的表，这里不自己再推一遍。
    if (step.targetTable === MAP_TABLE) maps.add(text(step.targetRowId));
    if (step.targetTable === PROGRESS_TABLE) {
      const scope = scopeKeyOf(step);
      if (scope) scopes.add(scope);
    }
  }

  const target = turns.find((turn) => turn.turnId === plan.targetTurnId) ?? null;
  const tableCounts: Record<string, number> = {};
  for (const key of Object.keys(plan.tableCounts ?? {}).sort()) tableCounts[key] = Number(plan.tableCounts[key]) || 0;

  return {
    version: 1,
    branchId: plan.branchId,
    targetTurnId: plan.targetTurnId,
    targetFloor: target?.floor ?? null,
    affectedTurns: withheld ? [] : turns,
    affectedTurnCount: turns.length || plan.affectedTurns || 0,
    manualTurnCount: turns.filter((turn) => turn.manual).length,
    steps: steps.length,
    clockBeforeS: plan.clockBeforeS,
    clockTargetS: plan.clockTargetS,
    tableCounts,
    affectedMaps: withheld ? [] : [...maps].filter((id) => id.length > 0).sort(),
    affectedProgressScopes: withheld ? [] : [...scopes].sort(),
    withheld,
    issues: Array.isArray(plan.issues) ? plan.issues : [],
  };
}
