/**
 * atlas-sim-random.ts — F07：可复现随机抽取（§9.5 / §16.7）。
 *
 * 规则：
 * - 种子绑定 `chat_uid + 分支基点 + 正文变体 + 输入哈希 + 规则版本`（`deriveSeed`）。
 * - 每次抽取用**稳定的事件/行动键**派生**独立子种子**；同一个键永远得到同一个值。
 *   **不使用一个全局随机序列按循环顺序取数**：多处理一个无关 NPC 不会改变另一个事件的随机值，
 *   因为本模块没有任何模块级可变状态，取值只由 (seed, eventKey, rule.key) 决定。
 * - 只保存种子不能让重新请求的语言模型输出相同，所以抽样结果要经 `recordDraw` 进入
 *   `decisions_json.random_draws`（§6.3）。
 * - attention 概率默认 `low/normal/high = 0.2/0.5/0.8`（§16.7，可调整的插件默认值）。
 *   说明：§16.2 要求默认值集中在 atlas-runtime-limits.ts；本任务不允许改动既有文件，
 *   因此常量先定义在本模块，待 atlas-runtime-limits.ts 扩展后迁移。
 *
 * 纯函数：没有 `Math.random`，没有 `Date.now()`，不依赖宿主 crypto（浏览器/Worker/Node 同一结果）。
 */

/** §16.7 一次机会的默认注意概率（可调整）。 */
export const ATTENTION_PROBABILITIES: Readonly<Record<'low' | 'normal' | 'high', number>> = {
  low: 0.2,
  normal: 0.5,
  high: 0.8,
};

/** 时间/速度/传播/随机规则版本；随规则改动递增，参与种子派生。 */
export const ATLAS_SIM_RULESET_VERSION = 'atlas-sim-1';

export type SeedParts = {
  chatUid: string;
  branchId: string;
  forkTurnId?: string | null;
  variantKey: string;
  inputHash: string;
  rulesetVersion: string;
};

export type DrawRule = { key: string; distribution: 'uniform' | 'bernoulli'; p?: number };

export type EventDraw = { key: string; value: number; distribution: string; ruleVersion: string };

export type RecordedDraw = { key: string; value: number; distribution: string; rule_version: string };

/** FNV-1a 32 位；纯 JS，浏览器与 Node 结果一致。 */
function fnv1a(text: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function toHex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

/** 稳定子种子：同一输入串永远得到同一 32 位数。 */
export function stableSubSeed(text: string): number {
  return fnv1a(text);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** §9.5：种子绑定聊天、分支基点、正文变体、输入哈希与规则版本。 */
export function deriveSeed(parts: SeedParts): string {
  const material = [
    'atlas-seed-v1',
    `chat:${parts?.chatUid ?? ''}`,
    `branch:${parts?.branchId ?? ''}`,
    `fork:${parts?.forkTurnId ?? ''}`,
    `variant:${parts?.variantKey ?? ''}`,
    `input:${parts?.inputHash ?? ''}`,
    `rules:${parts?.rulesetVersion ?? ''}`,
  ].join('\u0001');
  return `atlas-${toHex32(fnv1a(material))}${toHex32(fnv1a(`${material}\u0002`, 0x9e3779b9))}`;
}

function resolveProbability(p: unknown): number {
  if (typeof p === 'number' && Number.isFinite(p)) return Math.min(1, Math.max(0, p));
  if (typeof p === 'string' && Object.prototype.hasOwnProperty.call(ATTENTION_PROBABILITIES, p)) {
    return ATTENTION_PROBABILITIES[p as 'low' | 'normal' | 'high'];
  }
  return ATTENTION_PROBABILITIES.normal;
}

/**
 * F07：用稳定事件子种子抽样。
 * `key` 由 `eventKey + rule.key` 组成，保存后可回放；`value` 只取决于 (seed, eventKey, rule.key)。
 * bernoulli 用同一底层均匀值 `u`，因此调整 `p` 不会让已经抽过的 `u` 变化。
 */
export function drawForEvent(seed: string, eventKey: string, rule: DrawRule): EventDraw {
  const ruleKey = typeof rule?.key === 'string' && rule.key !== '' ? rule.key : 'default';
  const distribution = rule?.distribution === 'bernoulli' ? 'bernoulli' : 'uniform';
  const subSeed = stableSubSeed(`${seed ?? ''}\u0001${eventKey ?? ''}\u0001${ruleKey}`);
  const u = mulberry32(subSeed)();
  const value = distribution === 'bernoulli' ? (u < resolveProbability(rule?.p) ? 1 : 0) : u;
  return { key: `${eventKey ?? ''}#${ruleKey}`, value, distribution, ruleVersion: ATLAS_SIM_RULESET_VERSION };
}

/** §6.3 DecisionBundle.random_draws 元素：`{key,value,distribution,rule_version}`。 */
export function recordDraw(value: { key: string; value: number; distribution: string }): RecordedDraw {
  return {
    key: String(value?.key ?? ''),
    value: Number.isFinite(value?.value) ? Number(value.value) : 0,
    distribution: String(value?.distribution ?? 'uniform'),
    rule_version: ATLAS_SIM_RULESET_VERSION,
  };
}


/**
 * §18.3 T20「回放复用模型决策而非仅重置 seed」的可断言入口。
 *
 * 关键点：**不需要扩展 §6.3 的记录形状**。记录里的 `key` 就是 `eventKey#ruleKey`
 * （见 drawForEvent），所以只要调用方把 `turns.rng_seed`（由 deriveSeed 派生）传进来，
 * 就能逐条重算并比对。不等即说明记录与当前种子/规则版本不符（换了正文变体、或规则版本变了），
 * 调用方**必须**报冲突而不是照用旧记录。
 */
export function verifyRecordedDraws(
  seed: string,
  recorded: Array<{ key: string; value: number; distribution: string; rule_version?: string }>,
  /**
   * 规则表：ruleKey → 该规则当时的概率/分布。§6.3 的记录里没有 `p`，
   * 因此**不能**用默认 p=0.5 重算——那会把 p≠0.5 的合法回放误判为不符。
   * 调用方必须把当时生效的规则表传进来（同一批决策用的是同一张表）。
   */
  rules: Record<string, { distribution?: string; p?: number }> = {},
): { ok: boolean; mismatches: Array<{ key: string; recorded: number; recomputed: number | null; reason: string }> } {
  const mismatches: Array<{ key: string; recorded: number; recomputed: number | null; reason: string }> = [];
  for (const draw of recorded ?? []) {
    const key = String(draw?.key ?? '');
    const hashAt = key.lastIndexOf('#');
    if (hashAt <= 0 || hashAt === key.length - 1) {
      mismatches.push({ key, recorded: Number(draw?.value), recomputed: null, reason: 'RECORD_MISSING_KEYS' });
      continue;
    }
    const eventKey = key.slice(0, hashAt);
    const ruleKey = key.slice(hashAt + 1);
    // 先按完整抽样 key 查（同一 ruleKey 在不同事件上概率可能不同），再退回按 ruleKey 查。
    const declared = rules?.[key] ?? rules?.[ruleKey];
    const distribution = draw.distribution === 'bernoulli' ? 'bernoulli' : 'uniform';
    // 概率以调用方给的规则表为准；表里没有这一条时按记录自身的分布重算，
    // 并**明确标注**是「无概率依据」而不是悄悄用 0.5。
    const recomputed = drawForEvent(seed, eventKey, {
      key: ruleKey,
      distribution,
      ...(declared && declared.p !== undefined ? { p: declared.p } : {}),
    }).value;
    if (distribution === 'bernoulli' && (!declared || declared.p === undefined)) {
      mismatches.push({ key, recorded: Number(draw.value), recomputed, reason: 'RULE_PROBABILITY_UNKNOWN' });
      continue;
    }
    if (recomputed !== draw.value) {
      mismatches.push({ key, recorded: Number(draw.value), recomputed, reason: 'SEED_OR_RULE_CHANGED' });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
