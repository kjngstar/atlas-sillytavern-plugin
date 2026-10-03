/**
 * atlas-ops-normalize.ts — C03 / C04 / §8.4 / §8.5：确定性规范化与最小字段校验。
 *
 * 只做可以确定判断的修复（§8.5）：op/ref/source 空白、固定别名键、按明确字典归一的 enum、
 * 仅数值字段的完整数字字符串。绝不改动自由文本（name/title/content/description/thought/identity/
 * summary/intent/label/outcome/condition_note 等），`O'Neil；“渡鸦”` 必须逐字节保留（P04）。
 *
 * 未知的可选字段只给 FIELD_IGNORED 警告，不让整组失败；冒充程序维护字段给 SYSTEM_FIELD_IGNORED。
 * 本模块是“某操作允许哪些字段”的唯一来源。
 */

import type { Issue, ModelOperation, Phase } from './atlas-ops-contract.ts';
import {
  ATLAS_NOOP,
  ATLAS_SEMANTIC_OPS,
  OP_FIELD_ALIASES,
  SYSTEM_OWNED_FIELDS,
  allowedOpsForPhase,
  isSemanticOp,
} from './atlas-ops-contract.ts';
import { WHY_MAX_CHARS } from './atlas-runtime-limits.ts';
import { ATLAS_ERROR_CODES, toIssue } from './atlas-ops-errors.ts';

export type NormalizeResult = {
  op: ModelOperation | null;
  issues: Issue[];
  ignoredFields: string[];
  systemFields: string[];
};

export type MinimumFieldResult = { ok: true } | { ok: false; issue: Issue };

/**
 * §8.4 “可选参数”列的冻结副本（含各操作的最少参数）。
 * 未列出的运行态字段不可写：出现时 FIELD_IGNORED，绝不静默写库。
 */
export const OP_KNOWN_FIELDS: Record<string, readonly string[]> = {
  'location.upsert': [
    'name',
    'aliases',
    'kind',
    'description',
    'parent_ref',
    'mobility',
    'anchor_ref',
    'map_ref',
    'position',
    'area',
    'terrain',
    'access',
    'vehicle_profile',
    'existence_quality',
  ],
  'character.upsert': [
    'registration',
    'name',
    'aliases',
    'role',
    'identity',
    'description',
    'personality',
    'importance',
    'importance_reason',
    'thought',
    'action_tendency',
    'physical_status',
    'condition_note',
    'location_ref',
    'map_ref',
    'position',
    'mobility_profiles',
    'capabilities',
  ],
  'item.upsert': [
    'name',
    'aliases',
    'kind',
    'description',
    'quantity',
    'unit',
    'condition_note',
    'properties',
    'status',
    'placement',
  ],
  'item.transfer': ['to', 'quantity', 'from', 'owner_ref'],
  'faction.upsert': [
    'name',
    'aliases',
    'kind',
    'description',
    'goal',
    'headquarters_ref',
    'capabilities',
    'status',
  ],
  'relation.upsert': [
    'subject_ref',
    'object_ref',
    'label',
    'kind',
    'attitude',
    'trust',
    'description',
    'secrecy',
    'ends_after_s',
  ],
  'plan.propose': ['actor_ref', 'goal', 'steps', 'target_ref', 'target_location_ref', 'target_event_ref', 'secrecy'],
  'plan.revise': ['change', 'steps', 'destination_ref', 'why'],
  'event.propose': [
    'title',
    'phase',
    'kind',
    'location_ref',
    'route_ref',
    'actor_ref',
    'subject_ref',
    'participants',
    'action_ref',
    'event_ref',
    'time_hint',
    'activity',
    'result',
    'effects',
    'secrecy',
  ],
  'information.propose': [
    'content',
    'title',
    'kind',
    'event_ref',
    'subject_ref',
    'origin_ref',
    'originator_ref',
    'parent_ref',
    'truth',
    'secrecy',
    'spread_at_ref',
    'recipient_ref',
    'payload',
  ],
  'attention.propose': ['opportunity_ref', 'belief', 'attention', 'thought', 'action_tendency', 'reaction_goal'],
  'channel.upsert': [
    'owner_ref',
    'kind',
    'name',
    'source_ref',
    'source_location_ref',
    'recipient_ref',
    'recipient_location_ref',
    'scope',
    'requirements',
    'latency',
    'transport_mode',
    'reliability',
    'secrecy',
  ],
  'map.estimate': ['width_m', 'height_m', 'meters_per_cell_min', 'meters_per_cell_max', 'basis'],
  'route.propose': [
    'ref',
    'from_ref',
    'to_ref',
    'kind',
    'bidirectional',
    'map_ref',
    'geometry',
    'quality',
    'distance_m',
    'distance_min_m',
    'distance_max_m',
    'terrain',
    'modes',
    'access',
    'duration',
  ],
  [ATLAS_NOOP]: [],
};

/** 每个字段的固定英文取值；只有字典明确的字段才做 enum 归一。 */
const OP_ENUM_DICTS: Record<string, Record<string, readonly string[]>> = {
  'location.upsert': {
    kind: ['region', 'city', 'district', 'building', 'room', 'natural', 'vehicle', 'other'],
    mobility: ['fixed', 'mobile'],
    existence_quality: ['confirmed', 'inferred', 'hypothetical'],
  },
  'character.upsert': {
    registration: ['auto', 'watch'],
    role: ['protagonist', 'companion', 'npc'],
    importance: ['core', 'recurring', 'supporting'],
    physical_status: ['alive', 'incapacitated', 'dead', 'unknown'],
  },
  'item.upsert': {
    kind: ['object', 'resource', 'document', 'equipment', 'container', 'other'],
    status: ['active', 'consumed', 'destroyed', 'lost', 'merged', 'archived'],
  },
  'faction.upsert': {
    kind: ['nation', 'organization', 'family', 'team', 'other'],
    status: ['active', 'dissolved', 'merged', 'archived'],
  },
  'relation.upsert': {
    kind: ['member_of', 'leads', 'controls', 'knows', 'kinship', 'ally', 'hostile', 'owes', 'protects', 'other'],
    attitude: ['supportive', 'neutral', 'suspicious', 'hostile', 'unknown'],
    trust: ['high', 'medium', 'low', 'unknown'],
    secrecy: ['public', 'restricted', 'secret'],
  },
  'plan.propose': { secrecy: ['public', 'restricted', 'secret'] },
  'plan.revise': { change: ['pause', 'cancel', 'resume', 'replace_future'] },
  'event.propose': {
    phase: ['scheduled', 'observed', 'simulated'],
    kind: ['ceremony', 'conflict', 'arrival', 'passage', 'discovery', 'trade', 'communication', 'incident', 'other'],
    secrecy: ['public', 'restricted', 'secret'],
  },
  'information.propose': {
    kind: ['observation', 'report', 'rumor', 'announcement', 'lie', 'hypothesis'],
    truth: ['true', 'false', 'mixed', 'unknown'],
    secrecy: ['public', 'restricted', 'secret'],
  },
  'attention.propose': {
    belief: ['heard', 'doubted', 'believed', 'verified', 'rejected'],
    attention: ['low', 'normal', 'high'],
  },
  'channel.upsert': {
    kind: ['contact', 'faction_network', 'messenger', 'surveillance', 'broadcast', 'magic', 'other'],
    reliability: ['high', 'medium', 'low', 'unknown'],
    secrecy: ['public', 'restricted', 'secret'],
  },
  'route.propose': {
    kind: ['adjacent', 'road', 'path', 'door', 'stairs', 'air', 'water', 'portal', 'estimated'],
  },
};

/**
 * 中文 enum 词 → 候选英文值；只有候选命中该字段自己的字典时才采用，
 * 因此同一个中文词在不同字段可以有不同落点（如“怀疑”在 attitude 是 suspicious、在 belief 是 doubted）。
 */
const ZH_ENUM_CANDIDATES: Record<string, readonly string[]> = {
  公开: ['public'],
  受限: ['restricted'],
  秘密: ['secret'],
  活着: ['alive'],
  活著: ['alive'],
  存活: ['alive'],
  已死: ['dead'],
  死亡: ['dead'],
  死了: ['dead'],
  未知: ['unknown'],
  不明: ['unknown'],
  普通: ['normal', 'ordinary'],
  正常: ['normal'],
  高: ['high'],
  中: ['medium'],
  中等: ['medium'],
  低: ['low'],
  支持: ['supportive'],
  中立: ['neutral'],
  怀疑: ['suspicious', 'doubted'],
  存疑: ['doubted'],
  敌视: ['hostile'],
  敌对: ['hostile'],
  真: ['true'],
  假: ['false'],
  真假混合: ['mixed'],
  混合: ['mixed'],
  听到: ['heard'],
  听说: ['heard'],
  相信: ['believed'],
  证实: ['verified'],
  确认: ['confirmed', 'verified'],
  拒绝: ['rejected'],
  不信: ['rejected'],
  预定: ['scheduled'],
  计划: ['scheduled'],
  观察到: ['observed'],
  已观察: ['observed'],
  推演: ['simulated'],
  模拟: ['simulated'],
  谣言: ['rumor'],
  传闻: ['rumor'],
  报告: ['report'],
  观察: ['observation', 'observed', 'watch'],
  宣布: ['announcement'],
  谎言: ['lie'],
  假设: ['hypothesis'],
  自动: ['auto'],
  关注: ['watch'],
  候选: ['watch'],
  主角: ['protagonist'],
  同伴: ['companion'],
  配角: ['supporting'],
  常驻: ['recurring'],
  核心: ['core'],
  国家: ['nation'],
  组织: ['organization'],
  家族: ['family'],
  团队: ['team'],
  城市: ['city'],
  区域: ['region'],
  地区: ['region'],
  建筑: ['building'],
  房间: ['room'],
  自然: ['natural'],
  载具: ['vehicle'],
  其他: ['other'],
  固定: ['fixed'],
  移动: ['mobile'],
  推断: ['inferred'],
  假设存在: ['hypothetical'],
  活跃: ['active'],
  已消耗: ['consumed'],
  销毁: ['destroyed'],
  丢失: ['lost'],
  合并: ['merged'],
  归档: ['archived'],
  解散: ['dissolved'],
  相邻: ['adjacent'],
  道路: ['road'],
  小路: ['path'],
  门: ['door'],
  楼梯: ['stairs'],
  空中: ['air'],
  水路: ['water'],
  传送门: ['portal'],
  估计: ['estimated'],
  暂停: ['pause'],
  取消: ['cancel'],
  恢复: ['resume'],
  替换未来: ['replace_future'],
  成员: ['member_of'],
  领导: ['leads'],
  首领: ['leads'],
  控制: ['controls'],
  认识: ['knows'],
  亲属: ['kinship'],
  盟友: ['ally'],
  欠: ['owes'],
  保护: ['protects'],
  联络: ['contact'],
  组织网络: ['faction_network'],
  信使: ['messenger'],
  监视: ['surveillance'],
  广播: ['broadcast'],
  魔法: ['magic'],
};

/** 只在数值字段使用完整数字字符串修复（§8.5）。 */
const NUMERIC_FIELDS: Record<string, readonly string[]> = {
  'item.upsert': ['quantity'],
  'item.transfer': ['quantity'],
  'relation.upsert': ['ends_after_s'],
  'map.estimate': ['width_m', 'height_m', 'meters_per_cell_min', 'meters_per_cell_max'],
  'route.propose': ['distance_m', 'distance_min_m', 'distance_max_m'],
};

const FULL_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
/** 写成字符串的 Infinity / NaN 同样非法（§8.5）。 */
const EXPLICIT_NON_FINITE_RE = /^[+-]?(?:infinity|inf|nan)$/i;

const PLAN_CHANGES = ['pause', 'cancel', 'resume', 'replace_future'] as const;
const EVENT_PHASES = ['scheduled', 'observed', 'simulated'] as const;
const BELIEFS = ['heard', 'doubted', 'believed', 'verified', 'rejected'] as const;

function issue(
  code: string,
  path: string,
  message: string,
  extra: { severity?: 'warning' | 'error'; line?: number; opId?: string; retryable?: boolean } = {},
): Issue {
  return toIssue(new Error(message), { code, path, severity: 'warning', ...extra });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function truncateWhy(value: string): string {
  if (value.length <= WHY_MAX_CHARS) return value;
  let out = value.slice(0, WHY_MAX_CHARS);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** 英文先做 lowercase+trim，再尝试中文词到该字段字典的映射；都不命中就不改。 */
function matchEnum(value: string, dict: readonly string[]): string | null {
  const lowered = value.trim().toLowerCase();
  if (dict.includes(lowered)) return lowered;
  const candidates = ZH_ENUM_CANDIDATES[value.trim()];
  if (!candidates) return null;
  for (const candidate of candidates) {
    if (dict.includes(candidate)) return candidate;
  }
  return null;
}

function coerceNumeric(
  value: unknown,
  path: string,
  opName: string,
  issues: Issue[],
): { value: unknown; rejected: boolean } {
  const reject = (shown: string): { value: unknown; rejected: boolean } => {
    issues.push(
      issue(ATLAS_ERROR_CODES.INVARIANT_FAILED, path, `${opName}: ${path} is ${shown}; NaN/Infinity are never legal`, {
        severity: 'error',
        retryable: true,
      }),
    );
    return { value: undefined, rejected: true };
  };

  if (typeof value === 'number') {
    if (Number.isFinite(value)) return { value, rejected: false };
    return reject(String(value));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // 空串保持原样：未知值不写成 0（§8.5）。
    if (trimmed === '') return { value, rejected: false };
    if (FULL_NUMBER_RE.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) return { value: parsed, rejected: false };
      return reject(JSON.stringify(value));
    }
    // 非完整数字字符串不转换；但显式写成 Infinity/NaN 的字符串非法。
    if (EXPLICIT_NON_FINITE_RE.test(trimmed)) return reject(JSON.stringify(value));
    return { value, rejected: false };
  }
  return { value, rejected: false };
}

function normalizeValues(
  opName: string,
  data: Record<string, unknown>,
  issues: Issue[],
): Record<string, unknown> {
  const dicts = OP_ENUM_DICTS[opName] ?? {};
  const numeric = new Set<string>(NUMERIC_FIELDS[opName] ?? []);
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(data)) {
    let next = data[key];

    const dict = dicts[key];
    if (dict && typeof next === 'string') {
      const fixed = matchEnum(next, dict);
      if (fixed !== null) next = fixed;
    }

    if (numeric.has(key)) {
      const coerced = coerceNumeric(next, `$.data.${key}`, opName, issues);
      if (coerced.rejected) continue;
      next = coerced.value;
    }

    if (key === 'position' && isPlainObject(next)) {
      const position: Record<string, unknown> = { ...next };
      for (const axis of ['x', 'y'] as const) {
        if (!hasOwn(position, axis)) continue;
        const coerced = coerceNumeric(position[axis], `$.data.position.${axis}`, opName, issues);
        if (coerced.rejected) delete position[axis];
        else position[axis] = coerced.value;
      }
      next = position;
    }

    if (key === 'why' && typeof next === 'string' && next.length > WHY_MAX_CHARS) {
      const truncated = truncateWhy(next);
      issues.push(
        issue(
          ATLAS_ERROR_CODES.FIELD_IGNORED,
          '$.data.why',
          `${opName}: why is ${next.length} chars, over the ${WHY_MAX_CHARS} char limit; truncated to ${truncated.length}`,
        ),
      );
      next = truncated;
    }

    out[key] = next;
  }
  return out;
}

/** C03：确定性规范化；未知操作返回 `op: null` 并报 UNKNOWN_OPERATION。 */
export function normalizeOperation(
  raw: ModelOperation,
  phase: Phase,
  allowedOps?: readonly string[],
): NormalizeResult {
  const issues: Issue[] = [];
  const ignoredFields: string[] = [];
  const systemFields: string[] = [];

  const allowed = new Set<string>(allowedOps ?? allowedOpsForPhase(phase));
  allowed.add(ATLAS_NOOP);
  const allowedList = [...allowed].sort().join(', ');

  const opName = typeof raw?.op === 'string' ? raw.op.trim() : '';
  if (opName === '' || !allowed.has(opName)) {
    const reason =
      opName === ''
        ? 'operation is missing op'
        : isSemanticOp(opName)
          ? `op ${opName} is not allowed in phase ${phase}`
          : `unknown op ${JSON.stringify(opName)}`;
    issues.push(
      issue(ATLAS_ERROR_CODES.UNKNOWN_OPERATION, '$.op', `${reason}; allowed: ${allowedList}`, {
        severity: 'error',
        retryable: true,
      }),
    );
    return { op: null, issues, ignoredFields, systemFields };
  }

  const op: ModelOperation = { op: opName };

  if (typeof raw.ref === 'string') {
    const ref = raw.ref.trim();
    if (ref !== '') op.ref = ref;
  } else if (raw.ref !== undefined && raw.ref !== null) {
    issues.push(issue(ATLAS_ERROR_CODES.FIELD_IGNORED, '$.ref', `${opName}: ref must be a string; ignored`));
  }

  if (typeof raw.source === 'string') {
    op.source = raw.source.trim();
  } else if (Array.isArray(raw.source)) {
    const list = raw.source
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim());
    if (list.length > 0) op.source = list;
    else issues.push(issue(ATLAS_ERROR_CODES.FIELD_IGNORED, '$.source', `${opName}: source has no usable entries; ignored`));
  } else if (raw.source !== undefined && raw.source !== null) {
    issues.push(issue(ATLAS_ERROR_CODES.FIELD_IGNORED, '$.source', `${opName}: source must be a string or string array; ignored`));
  }

  if (typeof raw.why === 'string') {
    if (raw.why.length > WHY_MAX_CHARS) {
      op.why = truncateWhy(raw.why);
      issues.push(
        issue(
          ATLAS_ERROR_CODES.FIELD_IGNORED,
          '$.why',
          `${opName}: why is ${raw.why.length} chars, over the ${WHY_MAX_CHARS} char limit; truncated to ${op.why.length}`,
        ),
      );
    } else {
      op.why = raw.why;
    }
  } else if (raw.why !== undefined && raw.why !== null) {
    issues.push(issue(ATLAS_ERROR_CODES.FIELD_IGNORED, '$.why', `${opName}: why must be a string; ignored`));
  }

  if (typeof raw.ticket === 'string') op.ticket = raw.ticket.trim();

  let data: Record<string, unknown> | null = null;
  if (raw.data !== undefined && raw.data !== null) {
    if (!isPlainObject(raw.data)) {
      issues.push(issue(ATLAS_ERROR_CODES.FIELD_IGNORED, '$.data', `${opName}: data must be an object; ignored`));
    } else {
      const sourceData = raw.data;
      const collected: Record<string, unknown> = {};

      for (const key of Object.keys(sourceData)) {
        const value = sourceData[key];

        // §16.2：模型不得冒充程序维护字段。唯一例外是 §8.4 把它明确列为可写字段的操作
        // （map.estimate.basis 是“尺寸/距离依据”，与 turn_changes.basis_json 不是同一个东西）。
        if (SYSTEM_OWNED_FIELDS.includes(key) && !isKnownFieldForOp(opName, key)) {
          systemFields.push(key);
          issues.push(
            issue(
              ATLAS_ERROR_CODES.SYSTEM_FIELD_IGNORED,
              `$.data.${key}`,
              `${opName}: program-owned field ${key} ignored`,
            ),
          );
          continue;
        }

        const aliasTarget = hasOwn(OP_FIELD_ALIASES, key) ? OP_FIELD_ALIASES[key] : undefined;
        if (aliasTarget !== undefined) {
          if (aliasTarget === 'position.x' || aliasTarget === 'position.y') {
            if (!isKnownFieldForOp(opName, 'position')) {
              ignoredFields.push(key);
              issues.push(
                issue(ATLAS_ERROR_CODES.FIELD_IGNORED, `$.data.${key}`, `${opName}: alias ${key} → position is not a legal field; ignored`),
              );
              continue;
            }
            const axis = aliasTarget === 'position.x' ? 'x' : 'y';
            const existing = hasOwn(collected, 'position') ? collected['position'] : sourceData['position'];
            if (existing !== undefined && existing !== null && !isPlainObject(existing)) {
              ignoredFields.push(key);
              issues.push(
                issue(ATLAS_ERROR_CODES.FIELD_IGNORED, `$.data.${key}`, `${opName}: position is not an object; alias ${key} ignored`),
              );
              continue;
            }
            const position: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
            if (hasOwn(position, axis)) {
              ignoredFields.push(key);
              issues.push(
                issue(ATLAS_ERROR_CODES.FIELD_IGNORED, `$.data.${key}`, `${opName}: position.${axis} already provided; alias ${key} ignored`),
              );
              collected['position'] = position;
              continue;
            }
            position[axis] = value;
            collected['position'] = position;
            continue;
          }
          if (isKnownFieldForOp(opName, aliasTarget) && !hasOwn(sourceData, aliasTarget)) {
            collected[aliasTarget] = value;
            continue;
          }
          ignoredFields.push(key);
          issues.push(
            issue(
              ATLAS_ERROR_CODES.FIELD_IGNORED,
              `$.data.${key}`,
              `${opName}: alias ${key} → ${aliasTarget} is not usable here (target illegal or already present); ignored`,
            ),
          );
          continue;
        }

        if (!isKnownFieldForOp(opName, key)) {
          ignoredFields.push(key);
          issues.push(
            issue(
              ATLAS_ERROR_CODES.FIELD_IGNORED,
              `$.data.${key}`,
              `${opName}: unknown field ${key} ignored (operation continues)`,
            ),
          );
          continue;
        }

        const previous = collected[key];
        collected[key] = isPlainObject(previous) && isPlainObject(value) ? { ...value, ...previous } : value;
      }

      data = normalizeValues(opName, collected, issues);
    }
  }

  if (data !== null) op.data = data;
  return { op, issues, ignoredFields, systemFields };
}

/**
 * C04：只检查 §8.4 表格里真正的最少参数，不把 20 张表的列都当成模型必填。
 */
export function validateMinimum(
  op: ModelOperation,
  phase: Phase,
  parsed?: { opId?: string; line?: number },
): MinimumFieldResult {
  const opName = typeof op?.op === 'string' ? op.op.trim() : '';
  const rawData = op?.data;
  const data: Record<string, unknown> = isPlainObject(rawData) ? rawData : {};
  const ref = typeof op?.ref === 'string' ? op.ref.trim() : '';
  const isNew = ref === '' || ref.startsWith('new:');
  const changed = Object.keys(data).length > 0;

  const has = (key: string): boolean => hasOwn(data, key);
  const text = (key: string): string => (typeof data[key] === 'string' ? (data[key] as string).trim() : '');
  const meaningful = (key: string): boolean => {
    if (!has(key)) return false;
    const value = data[key];
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') return value.trim() !== '';
    return true;
  };
  const missingOf = (keys: readonly string[]): string[] => keys.filter((key) => !meaningful(key));

  const fail = (path: string, message: string): MinimumFieldResult => ({
    ok: false,
    issue: toIssue(new Error(`${message} (phase ${phase})`), {
      code: ATLAS_ERROR_CODES.MINIMUM_FIELD_MISSING,
      path,
      line: parsed?.line,
      opId: parsed?.opId,
      severity: 'error',
      retryable: true,
    }),
  });

  const createOrModify = (exampleName: string): MinimumFieldResult => {
    if (isNew) {
      if (!meaningful('name')) {
        return fail(
          '$.data.name',
          `${opName} requires data.name (non-empty string) when creating; example: {"op":"${opName}","ref":"new:${exampleName}","data":{"name":"…"}}`,
        );
      }
      return { ok: true };
    }
    if (!changed) {
      return fail(
        '$.data',
        `${opName} modifies an existing object: requires ref plus at least one changed field in data; example: {"op":"${opName}","ref":"${ref}","data":{"description":"…"}}`,
      );
    }
    return { ok: true };
  };

  switch (opName) {
    case 'location.upsert':
      return createOrModify('school');

    case 'character.upsert': {
      if (text('registration').toLowerCase() === 'watch') {
        if (!meaningful('name')) {
          return fail(
            '$.data.name',
            'character.upsert with registration=watch reports a candidate: requires data.name only; example: {"op":"character.upsert","data":{"registration":"watch","name":"戴兜帽的路人"}}',
          );
        }
        return { ok: true };
      }
      if (isNew) {
        if (!meaningful('name')) {
          return fail(
            '$.data.name',
            'character.upsert creating a character requires data.name; example: {"op":"character.upsert","ref":"new:elin","data":{"name":"艾琳","identity":"学校教师"}}',
          );
        }
        const clue = ['identity', 'importance', 'importance_reason'].some((key) => meaningful(key));
        if (!clue) {
          return fail(
            '$.data.identity',
            'character.upsert creating a formal character requires data.name plus one of identity / importance / importance_reason; example: {"op":"character.upsert","ref":"new:captain","data":{"name":"伊娜","identity":"王宫卫队长"}}',
          );
        }
        return { ok: true };
      }
      if (!changed) {
        return fail(
          '$.data',
          `character.upsert modifies an existing character: requires ref plus at least one changed field in data; example: {"op":"character.upsert","ref":"${ref}","data":{"thought":"先观察。"}}`,
        );
      }
      return { ok: true };
    }

    case 'item.upsert':
      return createOrModify('sword');

    case 'item.transfer': {
      if (ref === '') {
        return fail(
          '$.ref',
          'item.transfer requires ref naming the transferred item; example: {"op":"item.transfer","ref":"I1","data":{"to":{"holder_ref":"C1"}}}',
        );
      }
      const to = data['to'];
      if (!isPlainObject(to)) {
        return fail(
          '$.data.to',
          'item.transfer requires data.to with exactly one of {holder_ref} | {container_ref} | {location_ref[,position]} | {unknown:true}; example: {"op":"item.transfer","ref":"I1","data":{"to":{"holder_ref":"C1"}}}',
        );
      }
      const variants = [
        typeof to['holder_ref'] === 'string' && (to['holder_ref'] as string).trim() !== '',
        typeof to['container_ref'] === 'string' && (to['container_ref'] as string).trim() !== '',
        typeof to['location_ref'] === 'string' && (to['location_ref'] as string).trim() !== '',
        to['unknown'] === true,
      ].filter(Boolean).length;
      if (variants !== 1) {
        return fail(
          '$.data.to',
          `item.transfer requires exactly one destination form in data.to (holder_ref | container_ref | location_ref | unknown:true); got ${variants}`,
        );
      }
      return { ok: true };
    }

    case 'faction.upsert':
      return createOrModify('kingdom');

    case 'relation.upsert': {
      if (ref !== '') return { ok: true };
      const missing = missingOf(['subject_ref', 'object_ref', 'label']);
      if (missing.length > 0) {
        return fail(
          `$.data.${missing[0]}`,
          `relation.upsert requires subject_ref, object_ref and label (or ref to update an existing relation); missing: ${missing.join(', ')}; example: {"op":"relation.upsert","data":{"subject_ref":"C1","object_ref":"C2","label":"导师","kind":"knows"}}`,
        );
      }
      return { ok: true };
    }

    case 'plan.propose': {
      const missing = missingOf(['actor_ref', 'goal']);
      const steps = data['steps'];
      if (missing.length > 0) {
        return fail(
          `$.data.${missing[0]}`,
          `plan.propose requires actor_ref, goal and steps (array with at least one step); missing: ${missing.join(', ')}; example: {"op":"plan.propose","data":{"actor_ref":"C3","goal":"刺杀国王","steps":[{"kind":"prepare","title":"踩点"}]}}`,
        );
      }
      if (!Array.isArray(steps) || steps.length === 0) {
        return fail(
          '$.data.steps',
          'plan.propose requires data.steps as an array with at least one step; example: {"op":"plan.propose","data":{"actor_ref":"C3","goal":"刺杀国王","steps":[{"kind":"prepare","title":"踩点"}]}}',
        );
      }
      return { ok: true };
    }

    case 'plan.revise': {
      if (ref === '') {
        return fail(
          '$.ref',
          'plan.revise requires ref naming the plan or action being revised; example: {"op":"plan.revise","ref":"A1","data":{"change":"pause"}}',
        );
      }
      const change = text('change').toLowerCase();
      if (change === '') {
        return fail(
          '$.data.change',
          `plan.revise requires data.change ∈ {${PLAN_CHANGES.join(',')}}; example: {"op":"plan.revise","ref":"${ref}","data":{"change":"pause"}}`,
        );
      }
      if (!(PLAN_CHANGES as readonly string[]).includes(change)) {
        return fail(
          '$.data.change',
          `plan.revise change must be one of {${PLAN_CHANGES.join(',')}}; got ${JSON.stringify(text('change'))}`,
        );
      }
      const steps = data['steps'];
      if (change === 'replace_future' && (!Array.isArray(steps) || steps.length === 0)) {
        return fail(
          '$.data.steps',
          'plan.revise with change=replace_future requires data.steps as an array with at least one step; example: {"op":"plan.revise","ref":"A1","data":{"change":"replace_future","steps":[{"kind":"travel","destination_ref":"L2"}]}}',
        );
      }
      return { ok: true };
    }

    case 'event.propose': {
      if (!meaningful('title')) {
        return fail(
          '$.data.title',
          'event.propose requires data.title (non-empty string); example: {"op":"event.propose","data":{"title":"城门典礼","phase":"scheduled"}}',
        );
      }
      const eventPhase = text('phase').toLowerCase();
      if (eventPhase === '') {
        return fail(
          '$.data.phase',
          `event.propose requires data.phase ∈ {${EVENT_PHASES.join(',')}}; example: {"op":"event.propose","data":{"title":"城门典礼","phase":"scheduled"}}`,
        );
      }
      if (!(EVENT_PHASES as readonly string[]).includes(eventPhase)) {
        return fail(
          '$.data.phase',
          `event.propose phase must be one of {${EVENT_PHASES.join(',')}}; got ${JSON.stringify(text('phase'))}`,
        );
      }
      return { ok: true };
    }

    case 'information.propose': {
      if (!meaningful('content')) {
        return fail(
          '$.data.content',
          'information.propose requires data.content (non-empty string); example: {"op":"information.propose","data":{"content":"城门今晚戒严。"}}',
        );
      }
      return { ok: true };
    }

    case 'attention.propose': {
      const missing = missingOf(['opportunity_ref']);
      if (missing.length > 0) {
        return fail(
          '$.data.opportunity_ref',
          'attention.propose requires data.opportunity_ref from the provided opportunities; example: {"op":"attention.propose","data":{"opportunity_ref":"O1","belief":"heard"}}',
        );
      }
      const belief = text('belief').toLowerCase();
      if (belief === '') {
        return fail(
          '$.data.belief',
          `attention.propose requires data.belief ∈ {${BELIEFS.join(',')}}; example: {"op":"attention.propose","data":{"opportunity_ref":"O1","belief":"heard"}}`,
        );
      }
      if (!(BELIEFS as readonly string[]).includes(belief)) {
        return fail(
          '$.data.belief',
          `attention.propose belief must be one of {${BELIEFS.join(',')}}; got ${JSON.stringify(text('belief'))}`,
        );
      }
      return { ok: true };
    }

    case 'channel.upsert': {
      const missing = missingOf(['owner_ref', 'kind', 'name']);
      if (missing.length > 0) {
        return fail(
          `$.data.${missing[0]}`,
          `channel.upsert requires owner_ref, kind and name; missing: ${missing.join(', ')}; example: {"op":"channel.upsert","data":{"owner_ref":"F1","kind":"faction_network","name":"暗卫报告网"}}`,
        );
      }
      return { ok: true };
    }

    case 'map.estimate': {
      if (ref === '') {
        return fail(
          '$.ref',
          'map.estimate requires ref naming the map; example: {"op":"map.estimate","ref":"M1","data":{"width_m":4200,"height_m":3100,"basis":"叙事里城市走一天"}}',
        );
      }
      const sizeKeys = ['width_m', 'height_m', 'meters_per_cell_min', 'meters_per_cell_max', 'basis'];
      if (!sizeKeys.some((key) => meaningful(key))) {
        return fail(
          '$.data.width_m',
          `map.estimate requires ref plus at least one of {${sizeKeys.join(', ')}}; example: {"op":"map.estimate","ref":"${ref}","data":{"width_m":4200,"basis":"叙事里城市走一天"}}`,
        );
      }
      return { ok: true };
    }

    case 'route.propose': {
      const missing = missingOf(['from_ref', 'to_ref']);
      if (missing.length > 0) {
        return fail(
          `$.data.${missing[0]}`,
          `route.propose requires from_ref and to_ref; missing: ${missing.join(', ')}; example: {"op":"route.propose","data":{"from_ref":"L1","to_ref":"L2","kind":"road"}}`,
        );
      }
      return { ok: true };
    }

    case ATLAS_NOOP:
      return { ok: true };

    default:
      return {
        ok: false,
        issue: toIssue(
          new Error(
            `unknown or unsupported op ${JSON.stringify(opName)}; supported: ${[...ATLAS_SEMANTIC_OPS, ATLAS_NOOP].join(', ')} (phase ${phase})`,
          ),
          {
            code: ATLAS_ERROR_CODES.UNKNOWN_OPERATION,
            path: '$.op',
            line: parsed?.line,
            opId: parsed?.opId,
            severity: 'error',
            retryable: true,
          },
        ),
      };
  }
}

/** FIELD_IGNORED 判定用：字段是否属于该操作的可写集合（本文件是唯一来源）。 */
export function isKnownFieldForOp(op: string, field: string): boolean {
  const list = OP_KNOWN_FIELDS[op] as readonly string[] | undefined;
  if (!list) return false;
  return list.includes(field);
}
