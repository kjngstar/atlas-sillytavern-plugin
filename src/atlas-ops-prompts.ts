/**
 * atlas-ops-prompts.ts — G07 buildStagePrompt（§19 分阶段提示词模板）。
 *
 * 规则：
 * - 保留用户可编辑的角色/内容段；程序协议段独立，实际发送内容可预览。
 * - 只输出本次允许的操作；禁止把全部二十张表的 CREATE 语句塞进模板。
 * - 模型看不到 SQL 存储细节；不一边要求 SQL 一边要求 JSON。
 */

import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';
import { allowedOpsForPhase } from './atlas-ops-contract.ts';
import type { ModelBatchRequest, Phase } from './atlas-ops-contract.ts';

export type StagePromptInput = {
  phase: Phase;
  allowedOps?: readonly string[];
  /** 程序提供的现有对象短引用行，例如 `C1=艾琳（人物）`。 */
  entityRefs?: string[];
  lorebookSources?: string[];
  userSource?: string;
  assistantSource?: string;
  timeWindow?: string;
  actorSlices?: string;
  activeActions?: string;
  opportunities?: string;
  dueActions?: string;
  relevantWorldFacts?: string;
  eligibility?: string;
  mapScope?: string;
  geoEntities?: string;
  geoSources?: string;
  geoMissing?: string;
  repairTickets?: string;
  repairRefs?: string;
  repairSources?: string;
  /** 用户可编辑段：保留原有预设，不因协议段更新被清空。 */
  userPresetSegment?: string;
  maxTokens?: number;
  timeoutMs?: number;
  batchId?: string;
  repairOfBatchId?: string;
};

const FORMAT_SEGMENT = [
  '你负责 Atlas 的本次状态任务。',
  '只输出本次允许的操作，每行一个完整 JSON 对象。',
  '只写发生变化的字段。已有对象使用提供的短引用；新对象使用 new: 临时引用。',
  '不要输出整份世界、SQL、解释段或思考过程。',
  '没有需要修改的数据时输出 {"op":"noop"}。',
  '未知信息省略或在允许清空时写 null；不知道精确坐标时保留粗粒度地点。',
  '不要把人物的愿望当作已经发生的行动，也不要把某地有传言当作人人知情。',
  '可选 source 使用给定的来源编号；不需要逐字摘录 quote。',
  '格式示例：',
  '{"op":"character.upsert","ref":"C1","data":{"thought":"先观察。"}}',
  '本次允许的操作与最少参数：',
  '{{allowedOperationHelp}}',
].join('\n');

const MINIMUM_HELP: Record<string, string> = {
  'location.upsert': '新建 name；修改 ref + 至少一个变更字段',
  'character.upsert': '新建 name + 身份/重要性线索之一；候选只需 name（registration=watch）；修改 ref',
  'item.upsert': '新建 name；修改 ref',
  'item.transfer': 'ref + to（holder_ref / container_ref / location_ref / unknown 四选一）',
  'faction.upsert': '新建 name；修改 ref',
  'relation.upsert': 'subject_ref, object_ref, label',
  'plan.propose': 'actor_ref, goal, steps',
  'plan.revise': 'ref, change(pause/cancel/resume/replace_future)',
  'event.propose': 'title, phase(scheduled/observed/simulated)',
  'information.propose': 'content',
  'attention.propose': 'opportunity_ref, belief',
  'channel.upsert': 'owner_ref, kind, name',
  'map.estimate': 'ref + 尺寸或距离依据',
  'route.propose': 'from_ref, to_ref',
  noop: '无修改',
};

const PHASE_TASK: Record<Phase, string[]> = {
  observe: [
    '任务：从本轮已完成正文提取实际变化。不要续写故事。',
    '识别有重要身份/实质世界书资料的人物，允许首楼建档；一闪而过的有名路人用character.upsert加registration=watch报告候选，完全无关无名群众不建档。',
    '每轮主动判断唯一主角当前实际所在地点；正文代词承接上文且唯一指向已到达地点时也更新 location_ref。意图、梦境、回忆、远方镜头不算抵达。',
    '地点包含关系、人物粗位置与精确坐标分开处理。学校内但教室未知，就只给学校引用。',
    '心理/倾向可以依据人物设定合理更新，并保持简短。',
    '已完成行为或明确耗时可以放在 event.propose 的 activity/time_hint 中，未完成计划不算已经经过时间。',
  ],
  geography: [
    '任务：处理这一张地图的层级、范围标定或路线估计。',
    '城内地点归入城市子图，周边地点通过实际邻接/路线表达。移动载具不当作固定建筑。',
    '先根据给定资料判断地图大致现实尺寸；信息不足时给合理估计范围并说明 why，不能声称精确测量。',
    '不要利用界面标签排版坐标推出真实距离。用户已锁定的标定不修改。',
  ],
  decision: [
    '任务：为下面列出的角色判断注意、相信和下一步意图。',
    '每个角色按自己的知情记录行动。不要把其他角色或作者才知道的秘密当成他的知识。',
    '可接受已有后台活动、准备、停留、改道和新计划；不要直接写已抵达或跳过准备。',
    '只能对给定 opportunity_ref 判断是否注意/相信。没有接触机会不能让人物凭空获知消息。',
    '地图上的估计路线可以作为计划，精确路中坐标由程序计算。',
  ],
  outcome: [
    '任务：判断已经满足基本时空条件的行动会产生什么结果。',
    '给出事件和有限效果建议；失败、部分成功或意外停留都允许。',
    '后台可以发生真实后果，不需要主角出现在场。',
    '不要重复准备/旅行尚未完成的动作；不要给已死亡者继续安排不适用的主动行动。',
    '用 event.propose，并把关联行动写入 action_ref；必要的角色状态/物品转移放进同一事件的 effects。',
  ],
  repair: [
    '上一次操作有以下局部问题。其它成功操作已经保留，禁止重复输出或修改它们。',
    '逐条使用给定 ticket 修正原操作，每行一个完整 JSON 对象。',
    '只使用原本允许的操作。若无足够信息完成，输出同 ticket 的 noop，并用 why 说明。',
    '不要重新输出整个世界，不要改用 SQL，不要编造不存在的引用或证据。',
    '示例：',
    '{"ticket":"R1","op":"character.upsert","ref":"C1","data":{"location_ref":"L2"}}',
  ],
};

function allowedOperationHelp(allowedOps: readonly string[]): string {
  return allowedOps.map((op) => `- ${op}：${MINIMUM_HELP[op] ?? ''}`).join('\n');
}

/**
 * G07 buildStagePrompt：只输出该阶段允许的操作与短引用和来源。
 * 完成定义：只输出单种操作协议，不夹 SQL 要求；模板快照测试可断言。
 */
export function buildStagePrompt(input: StagePromptInput): ModelBatchRequest {
  const allowedOps = input.allowedOps ?? allowedOpsForPhase(input.phase);
  const system = [FORMAT_SEGMENT.replace('{{allowedOperationHelp}}', allowedOperationHelp(allowedOps))];
  if (input.userPresetSegment) system.push(input.userPresetSegment);

  const user: string[] = [...(PHASE_TASK[input.phase] ?? [])];

  if (input.phase === 'observe') {
    user.push(`现有对象短引用：${(input.entityRefs ?? []).join('、') || '（无）'}`);
    user.push(`相关世界书：${(input.lorebookSources ?? []).join('、') || '（无）'}`);
    user.push(`本轮用户行动：${input.userSource ?? ''}`);
    user.push(`本轮正文：${input.assistantSource ?? ''}`);
  } else if (input.phase === 'decision') {
    user.push(`本轮可用时间与时刻：${input.timeWindow ?? ''}`);
    user.push(`待判断角色及各自认知：${input.actorSlices ?? ''}`);
    user.push(`当前行动和行程：${input.activeActions ?? ''}`);
    user.push(`程序给出的接触机会：${input.opportunities ?? ''}`);
  } else if (input.phase === 'outcome') {
    user.push(`行动：${input.dueActions ?? ''}`);
    user.push(`现场实际状态及相关能力：${input.relevantWorldFacts ?? ''}`);
    user.push(`时间/路程/资源检查结果：${input.eligibility ?? ''}`);
  } else if (input.phase === 'geography') {
    user.push(`本图：${input.mapScope ?? ''}`);
    user.push(`现有地点与关系：${input.geoEntities ?? ''}`);
    user.push(`地理依据：${input.geoSources ?? ''}`);
    user.push(`本次具体缺项：${input.geoMissing ?? ''}`);
  } else if (input.phase === 'repair') {
    user.push(`失败票据、原操作、准确错误：${input.repairTickets ?? ''}`);
    user.push(`相关对象：${input.repairRefs ?? ''}`);
    user.push(`相关来源/机会：${input.repairSources ?? ''}`);
  }

  return {
    batchId: input.batchId ?? `${input.phase}_batch`,
    phase: input.phase,
    messages: [
      { role: 'system', content: system.join('\n\n') },
      { role: 'user', content: user.join('\n') },
    ],
    allowedOps,
    anchor: {
      chatUid: '',
      branchId: '',
      parentTurnId: null,
      hostMessageUid: '',
      variantKey: '',
      baseRevision: 0,
      baseStorageRevision: 0,
      inputHash: '',
    },
    maxTokens: input.maxTokens ?? (input.phase === 'repair' ? ATLAS_RUNTIME_LIMITS.repairResponseTokens : ATLAS_RUNTIME_LIMITS.normalResponseTokens),
    timeoutMs: input.timeoutMs ?? ATLAS_RUNTIME_LIMITS.modelTimeoutMs,
    repairOfBatchId: input.repairOfBatchId,
  };
}

/** 供测试断言：提示词里不得出现 SQL 要求或建表语句。 */
export function promptForbidsSql(request: ModelBatchRequest): boolean {
  const text = request.messages.map((m) => m.content).join('\n');
  const forbidden = [/CREATE\s+TABLE/i, /PRAGMA/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /ATTACH\s+DATABASE/i];
  return !forbidden.some((re) => re.test(text));
}

/** 供测试断言：14 种操作不会每轮全塞（只给该阶段允许集合）。 */
export function promptOperationNames(request: ModelBatchRequest): string[] {
  return [...request.allowedOps];
}

export const STAGE_PROMPT_TEMPLATES = { FORMAT_SEGMENT, PHASE_TASK, MINIMUM_HELP };
