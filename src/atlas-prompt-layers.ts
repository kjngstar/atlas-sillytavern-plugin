/**
 * atlas-prompt-layers.ts — P14/§21.5 提示词分层。
 *
 * 三层各有**唯一权威**，组装顺序固定，任何一层都不许越权写别人的内容：
 *
 *   1. `protocol` 固定协议 —— 程序拥有：操作行格式、本阶段允许的操作与最少参数。
 *      用户预设不能改它（旧协议预设会被 `SQL_PROMPT_INCOMPATIBLE` 拦在发送之前）。
 *   2. `policy`   用户策略 —— 内置默认策略（带版本号）或用户另存的自定义预设。
 *      程序**不覆盖**已另存的预设；升级只增一份带版本标记的内置建议预设。
 *   3. `task`     任务上下文 —— 程序按本批真实状态填充的模板。
 *      模型只处理本批内容，不能挑程序预算、不能自行宣布 ACK 成功。
 *
 * 纪律：
 * - 任务模板的占位符**必须**由程序用真实数据填充；任何一个 `{name}` 残留都直接抛错，
 *   **绝不**把示例花括号原样发给模型（那会让模型以为那是待填字段）。
 * - 预览与实际请求走**同一个**组装函数（`assemblePromptLayers`）——不留第二份预览实现。
 * - 策略层只约束**已实现**的能力；未打通的能力字符串不得提前进入提示词
 *   （见 `atlas-world-contract.ts` 的 `SPATIAL_CAPABILITIES` 纪律）。
 */

export const PROMPT_LAYER_ORDER = ['protocol', 'policy', 'task'] as const;
export type PromptLayerName = (typeof PROMPT_LAYER_ORDER)[number];

/**
 * 内置策略版本。策略文字一改就换号：用户据此判断「我的预设是不是旧策略」，
 * 并可以拿内置建议预设作对照后另存。**升级不会自动改写用户已另存的预设。**
 */
export const PROMPT_POLICY_VERSION = 'atlas-policy/2026-10-11';

/**
 * 策略层固定文字（§21.5「可在当前 v0.9.87 使用的策略文字」）。
 *
 * 只约束**现有能力**，不引入新字段；也治不好 N01/R01/R02 这些程序缺陷，
 * 只用于降低模型的不合法输出。
 */
export const DEFAULT_POLICY_CONTENT = [
  '只维护已经出现或有资料依据的世界结构。正文明确内容与估计必须区分；没有依据的地点、尺寸、路线和陈设不得标成已确认。',
  '地点身份由实体 ID 和父地点决定。同名但父地点不同的对象保持独立。新地点使用 new: 引用，复用已有地点时使用本批提供的引用。',
  '地图生成只输出程序允许的 map.layout.request 小约束，遵循程序给定的 overview/city/floor。不要输出完整 scene、画布坐标、seed 或自行修改比例尺。现有 floor 房间 role 只有 indoor/outdoor/garden。',
  '已有房间、路线和作者锁优先保留。缺少资料时保持未知并说明原因，不通过补造实体使地图看起来完整。',
  '路线有明确同图归属时提供正确 map_ref；跨图连接不拼接不同坐标系。装饰路纹不代表真实路线。',
  '对当前阶段没有必要变更时输出合法 noop；不要把「已保存」「发过请求」或「有一个场景」声称为整个地图建设完成。',
].join('\n');

/** 策略层段的显示名（含版本号，便于界面与预设列表对照）。 */
export const POLICY_SEGMENT_NAME = `越权与声明边界（${PROMPT_POLICY_VERSION}）`;

/**
 * 程序任务消息模板（§21.5）。占位符由程序填充，**不允许**原样发送。
 * 模板本身描述「本批送了什么」；来源块的正文另行逐块渲染，不塞进这一行。
 */
export const TASK_CONTEXT_TEMPLATE = [
  '本批阶段：{phase}',
  '基准作用域：{chatUid}/{branchId}/{revision}/{storageRevision}',
  '冻结目录哈希：{catalogueHash}',
  '本批焦点及必要对象：{requiredCatalogue}',
  '允许操作与地图 kind：{allowedOpsAndKinds}',
  '单位与有效幅面：{extents}',
  '锁定事实：{locks}',
  '本批目标：{selectedTargetIds}',
  '本批来源块：[sourceKey,contentHash,start,end,chunkKey,text]',
  '未发送待办只作摘要：{deferredSummary}',
  '已接受的实体身份：{priorBindings}',
  '你只处理本批发送内容；不要声称处理了未发送来源，也不要改写锁。',
].join('\n');

export type TaskSourceBlock = {
  sourceKey: string;
  contentHash: string;
  start: number;
  end: number;
  chunkKey: string;
  text: string;
};

export type TaskContextInput = {
  phase: string;
  chatUid: string;
  branchId: string;
  revision: number;
  storageRevision: number;
  /** 冻结目录哈希：本批送去的目录指纹，模型据此说明依据，不需要自己算。 */
  catalogueHash: string;
  /** 本批焦点及必要对象（短引用行，程序已按冻结目录筛过）。 */
  requiredCatalogue?: readonly string[];
  allowedOpsAndKinds: string;
  extents: string;
  locks: string;
  selectedTargetIds?: readonly string[];
  sourceBlocks?: readonly TaskSourceBlock[];
  deferredSummary: string;
  priorBindings?: readonly string[];
};

export class PromptLayerError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PromptLayerError';
    this.code = code;
  }
}

const fail = (code: string, message: string) => new PromptLayerError(code, message);
const placeholderRe = () => /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;
const list = (rows: readonly string[] | undefined, empty = '（无）') => (rows && rows.length ? rows.join('、') : empty);

/** 空/空白一律视为「没填」——不允许用空串糊过去。 */
function requireText(code: string, label: string, value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  if (!raw) throw fail(code, `任务上下文缺少 ${label}；不能用空值占位`);
  return raw;
}
function requireInt(code: string, label: string, value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw fail(code, `任务上下文缺少 ${label}；必须是有限数字`);
  return String(Math.trunc(value));
}

/**
 * 用真实程序数据渲染任务上下文。占位符未填 / 残留花括号 → 抛错，不发送。
 */
export function formatTaskContext(input: TaskContextInput): string {
  const values: Record<string, string> = {
    phase: requireText('PROMPT_TASK_CONTEXT_INCOMPLETE', '本批阶段', input.phase),
    chatUid: requireText('PROMPT_TASK_CONTEXT_INCOMPLETE', 'chatUid', input.chatUid),
    branchId: requireText('PROMPT_TASK_CONTEXT_INCOMPLETE', 'branchId', input.branchId),
    revision: requireInt('PROMPT_TASK_CONTEXT_INCOMPLETE', 'revision', input.revision),
    storageRevision: requireInt('PROMPT_TASK_CONTEXT_INCOMPLETE', 'storageRevision', input.storageRevision),
    catalogueHash: requireText('PROMPT_TASK_CONTEXT_INCOMPLETE', '冻结目录哈希', input.catalogueHash),
    requiredCatalogue: list(input.requiredCatalogue, '（本批无焦点对象）'),
    allowedOpsAndKinds: requireText('PROMPT_TASK_CONTEXT_INCOMPLETE', '允许操作与地图 kind', input.allowedOpsAndKinds),
    extents: requireText('PROMPT_TASK_CONTEXT_INCOMPLETE', '单位与有效幅面', input.extents),
    locks: requireText('PROMPT_TASK_CONTEXT_INCOMPLETE', '锁定事实', input.locks),
    selectedTargetIds: list(input.selectedTargetIds, '（本批无目标）'),
    deferredSummary: requireText('PROMPT_TASK_CONTEXT_INCOMPLETE', '未发送待办摘要', input.deferredSummary),
    priorBindings: list(input.priorBindings, '（无）'),
  };
  const rendered = TASK_CONTEXT_TEMPLATE.replace(placeholderRe(), (match, name: string) => {
    const value = values[name];
    if (value === undefined) throw fail('PROMPT_TEMPLATE_UNKNOWN_PLACEHOLDER', `任务模板占位符 ${match} 没有对应的程序数据`);
    return value;
  });
  // 残留检查必须在**拼入来源正文之前**做：来源正文里的花括号是资料，不是模板。
  const leftover = rendered.match(placeholderRe());
  if (leftover) throw fail('PROMPT_PLACEHOLDER_UNFILLED', `任务模板仍有未填充占位符 ${leftover[0]}；禁止把示例花括号发给模型`);
  const blocks = input.sourceBlocks ?? [];
  if (!blocks.length) return rendered;
  const lines = blocks.map((block) => [
    `- sourceKey=${requireText('PROMPT_SOURCE_BLOCK_INCOMPLETE', '来源 sourceKey', block.sourceKey)}`,
    `contentHash=${requireText('PROMPT_SOURCE_BLOCK_INCOMPLETE', '来源 contentHash', block.contentHash)}`,
    `start=${requireInt('PROMPT_SOURCE_BLOCK_INCOMPLETE', '来源 start', block.start)}`,
    `end=${requireInt('PROMPT_SOURCE_BLOCK_INCOMPLETE', '来源 end', block.end)}`,
    `chunkKey=${requireText('PROMPT_SOURCE_BLOCK_INCOMPLETE', '来源 chunkKey', block.chunkKey)}`,
    `chars=${String(block.text ?? '').length}`,
  ].join(' '));
  // 块正文不在这里重复一遍（正文由依据段负责），本行只给身份与范围，避免同一资料发两次。
  return `${rendered}\n${lines.join('\n')}\n（以上是来源块的身份与范围；块正文见本批依据段，不要把这些行当作资料来源）`;
}

export type PromptLayerMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type PromptLayerInput = {
  /** 第一层：固定协议（程序拥有，通常来自 `buildStagePrompt` 的 system 段）。 */
  protocol: string;
  /** 第二层：用户策略段（内置默认或用户另存；作者选定的角色必须原样保留）。 */
  policy: ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** 第三层：任务上下文段（程序填充的模板 + 本批数据）。 */
  task: readonly string[];
  /** 允许消息里出现未填充的模板占位符；默认禁止。 */
  allowPlaceholders?: boolean;
};

/**
 * 唯一组装函数：固定协议 → 用户策略 → 任务上下文。
 * 预览与实际发送都必须走这里（调用方只在 `prepare` 里组装一次）。
 */
export function assemblePromptLayers(input: PromptLayerInput): PromptLayerMessage[] {
  const protocol = requireText('PROMPT_PROTOCOL_MISSING', '固定协议层', input.protocol);
  const policy = (input.policy ?? []).filter((row) => row && String(row.content ?? '').trim().length > 0)
    .map((row) => ({ role: row.role, content: String(row.content) }));
  const task = input.task.map((row) => String(row ?? '')).filter((row) => row.trim().length > 0);
  if (!task.length) throw fail('PROMPT_TASK_MISSING', '任务上下文层为空；阶段任务数据必须由程序提供');
  const messages: PromptLayerMessage[] = [
    { role: 'system', content: protocol },
    ...policy,
    ...task.map((content) => ({ role: 'user' as const, content })),
  ];
  if (!input.allowPlaceholders) {
    // 用户策略段允许保留 {{worldState}} 一类**受支持的**来源占位符（由 api-client 负责展开），
    // 只拦「本层没填的模板变量」——也就是明显的 {phase} / {catalogueHash} 这种。
    const templateNames = new Set(Array.from(TASK_CONTEXT_TEMPLATE.matchAll(placeholderRe()), (m) => m[1]));
    for (const message of messages) {
      for (const match of message.content.matchAll(placeholderRe())) {
        if (templateNames.has(match[1])) {
          throw fail('PROMPT_PLACEHOLDER_UNFILLED', `消息里仍有未填充的模板占位符 ${match[0]}；示例花括号不得发给模型`);
        }
      }
    }
  }
  return messages;
}

/** 供界面/测试核对分层：每段属于哪一层、序号多少。 */
export function promptLayerReport(messages: readonly PromptLayerMessage[], policyCount: number): Array<{
  layer: PromptLayerName; index: number; role: string; chars: number;
}> {
  return messages.map((message, index) => ({
    layer: index === 0 ? 'protocol' : index <= policyCount ? 'policy' : 'task',
    index, role: message.role, chars: message.content.length,
  }));
}