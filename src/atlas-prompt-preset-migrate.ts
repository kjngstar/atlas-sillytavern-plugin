/**
 * atlas-prompt-preset-migrate.ts — §19.3：内置默认与自定义预设严格分开。
 *
 * 这一层解决的是一个很具体的伤害：升级时把新行为说明**拼进用户已经另存的预设**，
 * 或者按名字猜「这套叫默认，应该是我们的」，于是改掉了作者写的东西。
 *
 * 判定只认结构标记，不认名字：
 * - 内置段带 `origin: 'atlas-builtin'` + `builtinId` + `builtinVersion`；
 * - 缺任一项（或叫「默认」却是用户另存的）→ 一律按自定义处理，**一个字节都不改**。
 *
 * 升级范围也只限于内置段自己的文字：顺序、角色、启用状态、段落 ID、自定义段全部原样。
 */

import type { AtlasPromptSegment } from './atlas-settings.ts';
import { PROMPT_POLICY_VERSION } from './atlas-prompt-layers.ts';

/** 内置段的身份标记。写在段上，不写在预设名上。 */
export const BUILTIN_SEGMENT_ORIGIN = 'atlas-builtin';

export type BuiltinSegmentRecord = AtlasPromptSegment & {
  origin?: string;
  builtinId?: string;
  builtinVersion?: string;
};

export type BuiltinCatalogEntry = {
  builtinId: string;
  version: string;
  name: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type PresetClass = 'builtin' | 'custom' | 'mixed';

/**
 * 判定一套预设是内置、自定义还是「内置段 + 作者加段」的混合。
 *
 * 混合仍按自定义对待（不自动改），只是升级内置段时作者段原样保留。
 */
export function classifyPreset(segments: readonly BuiltinSegmentRecord[] | undefined | null): PresetClass {
  const list = Array.isArray(segments) ? segments : [];
  if (list.length === 0) return 'custom';
  const builtinCount = list.filter((segment) => isBuiltinSegment(segment)).length;
  if (builtinCount === 0) return 'custom';
  return builtinCount === list.length ? 'builtin' : 'mixed';
}

/** 只要三个标记齐全才算内置；名字相似、id 相同但缺标记的都不算。 */
export function isBuiltinSegment(segment: BuiltinSegmentRecord | null | undefined): boolean {
  if (!segment || typeof segment !== 'object') return false;
  return segment.origin === BUILTIN_SEGMENT_ORIGIN
    && typeof segment.builtinId === 'string' && segment.builtinId.trim() !== ''
    && typeof segment.builtinVersion === 'string' && segment.builtinVersion.trim() !== '';
}

/**
 * §19.3：只升级**可识别的内置段**，其余一切原样返回。
 *
 * 返回的 `segments` 与输入逐项对应（数量、顺序、角色、enabled、id 都不变）；
 * `changed === false` 时调用方应当直接不回写，避免产生一次无意义的设置写入。
 */
export function planBuiltinPresetUpgrade(input: {
  segments: readonly BuiltinSegmentRecord[] | undefined | null;
  catalog: readonly BuiltinCatalogEntry[];
}): {
  presetClass: PresetClass;
  segments: BuiltinSegmentRecord[];
  changed: boolean;
  upgradedSegmentIds: string[];
  unknownBuiltinIds: string[];
  issues: Array<{ code: string; message: string }>;
} {
  const list = (Array.isArray(input?.segments) ? input.segments : []).map((segment) => ({ ...segment }));
  const catalog = new Map<string, BuiltinCatalogEntry>();
  for (const entry of input?.catalog ?? []) {
    if (typeof entry?.builtinId === 'string' && entry.builtinId !== '') catalog.set(entry.builtinId, entry);
  }
  const presetClass = classifyPreset(list);
  const upgradedSegmentIds: string[] = [];
  const unknownBuiltinIds: string[] = [];

  if (presetClass === 'custom') {
    return { presetClass, segments: list, changed: false, upgradedSegmentIds, unknownBuiltinIds, issues: [] };
  }

  for (const segment of list) {
    if (!isBuiltinSegment(segment)) continue; // 作者加段：不动。
    const entry = catalog.get(String(segment.builtinId));
    if (!entry) {
      // 内置段已从目录里下架：保留原文，只报告，不删段也不清空。
      unknownBuiltinIds.push(String(segment.builtinId));
      continue;
    }
    if (String(segment.builtinVersion) === entry.version) continue;
    // 只换文字与版本号；name/role/enabled/id 全部原样（作者的启用状态与命名不被覆盖）。
    segment.content = entry.content;
    segment.builtinVersion = entry.version;
    upgradedSegmentIds.push(String(segment.builtinId));
  }

  const issues = unknownBuiltinIds.length > 0
    ? [{
      code: 'PRESET_BUILTIN_SEGMENT_UNKNOWN',
      message: `有 ${unknownBuiltinIds.length} 个内置段不在当前内置目录里：原文保留，未删除、未改写`,
    }]
    : [];

  return { presetClass, segments: list, changed: upgradedSegmentIds.length > 0, upgradedSegmentIds, unknownBuiltinIds, issues };
}

export type PresetCompatibilityNotice = {
  /** 是否需要界面提示。false 时不要打扰用户。 */
  needsAttention: boolean;
  code: 'PRESET_OK' | 'PRESET_CUSTOM_POLICY_MAYBE_BEHIND' | 'PRESET_BUILTIN_OUTDATED';
  message: string;
  /** 永远不自动切换：界面只能提示，由用户自己另存或换预设。 */
  autoSwitch: false;
};

/**
 * §19.3：兼容提示。
 *
 * 自定义预设**只提示、不改写、不自动切换**——新行为说明缺席是用户的选择，
 * 程序能做的是把「为什么行为可能不一样」说清楚。
 */
export function presetCompatibilityNotice(input: {
  segments: readonly BuiltinSegmentRecord[] | undefined | null;
  requiredPolicyVersion?: string;
}): PresetCompatibilityNotice {
  const required = input?.requiredPolicyVersion ?? PROMPT_POLICY_VERSION;
  const list = Array.isArray(input?.segments) ? input.segments : [];
  const presetClass = classifyPreset(list);

  // 提示只关心**策略段**的版本：其它内置段有自己的内容版本号，跟策略版本不是一回事。
  const policyVersions = list
    .filter((segment) => isBuiltinSegment(segment) && String(segment.builtinVersion).startsWith('atlas-policy/'))
    .map((segment) => String(segment.builtinVersion));

  if (presetClass === 'builtin') {
    if (policyVersions.length > 0 && policyVersions.every((version) => version === required)) {
      return { needsAttention: false, code: 'PRESET_OK', message: '内置预设已是最新策略版本', autoSwitch: false };
    }
    return {
      needsAttention: true,
      code: 'PRESET_BUILTIN_OUTDATED',
      message: `内置预设仍是 ${policyVersions[0] ?? '未知'}，当前策略为 ${required}：可在设置里另存一份新的内置建议预设，程序不会自动替换`,
      autoSwitch: false,
    };
  }

  // 自定义（含混合）：不看名字，只看有没有认得出的内置策略段。
  const hasCurrentPolicy = list.some((segment) => isBuiltinSegment(segment) && String(segment.builtinVersion) === required);
  if (hasCurrentPolicy) {
    return { needsAttention: false, code: 'PRESET_OK', message: '自定义预设已包含当前策略段', autoSwitch: false };
  }
  return {
    needsAttention: true,
    code: 'PRESET_CUSTOM_POLICY_MAYBE_BEHIND',
    message: `这是自定义预设，不包含 ${required} 的空间行为说明：程序不会追加或尾拼说明。若新行为（门窗状态、陈设按需提升、矛盾不自动重写）表现异常，请手动另存内置建议预设或自行补充`,
    autoSwitch: false,
  };
}

/**
 * §19.3：把内置默认段渲染成可保存的预设段（带身份标记）。
 * 只有经这里产出的段才有资格被下一次升级识别。
 */
export function builtinSegments(catalog: readonly BuiltinCatalogEntry[]): BuiltinSegmentRecord[] {
  return (catalog ?? []).map((entry) => ({
    name: entry.name,
    role: entry.role,
    enabled: true,
    content: entry.content,
    origin: BUILTIN_SEGMENT_ORIGIN,
    builtinId: entry.builtinId,
    builtinVersion: entry.version,
  }));
}
