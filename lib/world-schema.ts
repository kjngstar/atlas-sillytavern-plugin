// P0-001 数据模型 v1 — World / Region / Event / Character / Story 5 实体
// 锁定 2026-08-22 — 解锁 UI-000 第二批 / UI-001~004 / LT-003
// === 事件持久化：World.events 按 regionId 索引 UIEvent[]（schemaVersion 保持 1，向后兼容旧 world 数据无 events 仍能 parse；CRUD 待 UI-006/UI-007 启用）===

// === P0-006：World 携带 AI 配置（connections + bindings），复用 ai-connections 类型（不造成 cycle：ai-connections.ts 不 import lib/world-schema）===
import type { AIConnection, AIBindings } from "./ai-connections";

export const SCHEMA_VERSION = 1;
export const WORLD_STORAGE_PREFIX = "world-storage:";

// 世界观库保持在 World 内，因此会随世界切换、备份与恢复一起迁移。
// 维持 schemaVersion=1：这两个字段均为可选，旧世界无需迁移即可兼容。
export const WORLD_BIBLE_MAX_ENTRIES = 80;
export const WORLD_GLOBAL_PROMPT_MAX_LENGTH = 8_000;
export const WORLD_BIBLE_ENTRY_TITLE_MAX_LENGTH = 120;
export const WORLD_BIBLE_ENTRY_CONTENT_MAX_LENGTH = 5_000;
export const WORLD_BIBLE_MAX_KEYS = 24;
export const WORLD_BIBLE_KEY_MAX_LENGTH = 80;

export const WORLD_BIBLE_CATEGORY_OPTIONS = [
  "世界概况",
  "时代与历史",
  "地理与势力",
  "种族与文化",
  "魔法与科技",
  "政治与经济",
  "宗教与禁忌",
  "人物关系",
  "关键事件",
  "叙事风格",
  "术语词典",
  "自定义",
] as const;

/** 世界书只保留当前创作真正需要的两种触发方式。旧条目默认是常驻。 */
export const WORLD_BIBLE_ACTIVATION_MODES = ["always", "keywords"] as const;
export type WorldBibleActivationMode = typeof WORLD_BIBLE_ACTIVATION_MODES[number];

export interface WorldBibleEntry {
  id: string;
  category: string;
  title: string;
  content: string;
  tags?: string[];
  /** false = 仅保留在资料库，不会作为 AI 世界观上下文发送。 */
  enabled?: boolean;
  /** 常驻条目始终附带；关键词条目仅在当前创作上下文命中 keys 后附带。 */
  activationMode?: WorldBibleActivationMode;
  /** 关键词触发的主关键字；分类/标签仅用于整理，不能替代触发关键词。 */
  keys?: string[];
  updatedAt?: number;
}

export interface World {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  description: string;
  currentRegionId: string | null;
  currentYear: number;
  createdAt: number;
  updatedAt: number;
  // P0-006：AI 配置作为可选字段（schemaVersion 保持 1，向后兼容旧 world 数据无连接库信息）
  connections?: AIConnection[];
  bindings?: AIBindings;
  // UI-016 v2 地图底图持久化：base64 dataURL（schemaVersion 保持 1，旧 world 数据无 mapImage 仍能 parse；与 points 一起构成"地图资源与世界绑定"的最小持久化）
  mapImage?: string;
  // 事件持久化：按 regionId 索引 UIEvent[]（schemaVersion 保持 1，旧 world 数据无 events 仍能 parse；与 points/mapImage 一起构成"地图资源与世界绑定"的完整持久化；CRUD 由 UI-006/UI-007 实现）
  events?: Record<string, UIEvent[]>;
  // UI-004 v1：人物资料库（Character[]，schemaVersion 保持 1，向后兼容旧 world 数据无 characters 仍能 parse；CRUD 由 character-editor modal 实现；与 Region 双向通过 currentRegionId 引用）
  characters?: Character[];
  // B1 v1：每个世界自己持久化的地区列表（替代页面 const regions 演示数组）
  // 可选，向后兼容：旧世界无此字段时，迁移时按模板或 Aurelia 兼容回退补齐
  regions?: Region[];
  // B1 v1：地图地点命名类型 + 可选 regionId 关联（替代 points 数组的 inline 形状）
  // world.points 数组项改用 MapPoint；旧无 regionId 字段视为未归属
  points?: MapPoint[];
  // B4：故事线列表（正史/IF）。可选，向后兼容：旧世界数据无 stories 仍能 parse。
  stories?: Story[];
  // B5：阅读进度（视觉小说/书籍阅读器双模式共享）。可选，向后兼容：旧世界无此字段仍能 parse。
  readingProgress?: ReadingProgress | null;
  // 全局提示词：作者写给 AI 的长期创作约束。可选，旧世界无此字段仍能 parse。
  globalPrompt?: string;
  // 结构化世界观资料库；启用条目会在用户主动调用 AI 时以受限长度作为上下文附带。
  worldBible?: WorldBibleEntry[];
  // -------------------------------------------------------------------------
  // W0：世界运转、NPC 状态与故事会话 Agent。全部为可选字段；旧世界无这些字段照常解析。
  // -------------------------------------------------------------------------
  /** 人物动态状态（与 Character 档案分离；按 characterId 唯一） */
  characterStates?: CharacterState[];
  /** 人物记忆（只存事实或作者确认的结果） */
  characterMemories?: CharacterMemory[];
  /** 可运行的事件钩子（世界书只负责静态设定，触发器才负责「这次会不会发生」） */
  triggers?: WorldTrigger[];
  /** 每条正史 / IF 的动态世界快照（IF 深拷贝，正史与 IF 不共享可写对象） */
  storyRuntimes?: StoryRuntime[];
  /** 行动日志（可追溯：保留来源、持续时间与种子） */
  actions?: WorldAction[];
  /** 行动结果日志（「无事发生」也要有可解释记录） */
  outcomes?: WorldOutcome[];
  /** 故事线 / IF 的本地 AI 会话摘要与路由（绝不存 API Key） */
  agentSessions?: StoryAgentSession[];
  /**
   * R4-04：从阅读段落开启的酒馆式扮演会话（可先作为临时试玩保存）。
   * 会话**不自动改写世界**；只有用户采用草稿中的变更、或显式「保存为 IF」才写入。
   */
  roleplaySessions?: RoleplaySession[];
  // -------------------------------------------------------------------------
  // W0-01b：卡片 Agent、入口锚点与旅行设置。全部为可选字段，旧世界无此字段照常解析。
  // -------------------------------------------------------------------------
  /** 卡片 Agent 静态配置（附着于事件 / 地点 / 人物 / 故事起点卡；不保存密钥与聊天记录） */
  cardProfiles?: CardAgentProfile[];
  /** 卡片 Agent 在某条正史 / IF 内的运行状态（storyId + branchId 作用域） */
  cardSessions?: CardAgentSession[];
  /** 入口锚点：把卡放到地图 / 时间轴可进入的位置（可只绑地图或只绑时间） */
  entryAnchors?: StoryEntryAnchor[];
  /** 地图旅行设置：把可见网格转为可计算的旅行尺度 */
  travelSettings?: MapTravelSettings | null;
  /**
   * W0-01c：当前世界**唯一**的根 Agent（单值字段，天然保证一个世界最多一份）。
   * 缺失 / 删除 / 解析失败时，所有故事请求无条件回退 `DEFAULT_TRAVEL_BASELINE`。
   */
  worldAgent?: WorldAgentProfile | null;
  // -------------------------------------------------------------------------
  // R5-01：世界定义版本与实体目录。全部为可选字段；旧世界无这些字段照常解析。
  // -------------------------------------------------------------------------
  /** 定义修订历史（追加式；「作者修订设定」与「世界内变化」由本字段与 R5-02 账本显式区分） */
  definitionRevisions?: DefinitionRevision[];
  /** 实体目录：城市 / 人物 / 组织 / 物品等稳定身份 + 基线字段 + 时态字段声明 */
  entityRecords?: EntityRecord[];
  /**
   * R5-02：状态事件账本（追加式、按 branchId + at + sequence 排序）。
   * 「世界内发生变化」的唯一真实来源；一经采用不得原地覆写，更正以新事件 / 撤销事件表达。
   */
  stateEvents?: StateEvent[];
  // -------------------------------------------------------------------------
  // R5-04：检查点与游玩头。可选字段；旧世界无这些字段照常解析。
  // -------------------------------------------------------------------------
  /** 检查点（技术 / 作者命名）：账本游标 + 物化投影 + hash；不是唯一事实，不取代账本 */
  checkpoints?: WorldCheckpoint[];
  /** 各分支的游玩头（「将检查点设为当前游玩头」的落点；回到过去不删除未来） */
  playheads?: PlayheadState[];
}

// ===========================================================================
// R5-01：世界定义版本与实体目录（静态 / 可变分离）
// - 「作者修订设定」→ 追加 DefinitionRevision（旧修订绝不原地覆写）；
// - 「世界内发生变化」→ R5-02 的 StateEvent（带时间 / 分支 / 来源）；
// - 实体的可计算状态以带时间与分支范围的状态条目附着，绝不只靠一段 AI 散文。
// ===========================================================================

/** 字段归属：base=基础设定（定义层）；temporal=时态（账本提供）；computed=派生；private=私有（不进 AI） */
export type EntityFieldKind = "base" | "temporal" | "computed" | "private";
export const ENTITY_FIELD_KINDS: EntityFieldKind[] = ["base", "temporal", "computed", "private"];

export type EntityFieldValueType = "string" | "number" | "boolean" | "string[]";
export const ENTITY_FIELD_VALUE_TYPES: EntityFieldValueType[] = ["string", "number", "boolean", "string[]"];

/** 实体字段声明：key 唯一；自定义字段必须声明是否可进入 AI / 时间轴 / 地图 */
export interface EntityTemporalField {
  key: string;
  kind: EntityFieldKind;
  valueType: EntityFieldValueType;
  /** 缺省按 kind 推导（base/temporal 可见；private 不进 AI） */
  entersAI?: boolean;
  entersTimeline?: boolean;
  entersMap?: boolean;
}

/** 实体稳定身份（城市 / 人物 / 组织 / 物品等） */
export interface EntityRecord {
  id: string;
  worldId: string;
  /** 实体类型（非空短标识，如 city / npc / faction / item；作者可自定义） */
  type: string;
  name: string;
  /** 基线字段（base / 静态描述；时态值绝不写在这里，由 R5-02 账本提供） */
  baseline: Record<string, unknown>;
  /** 字段声明：key 必须唯一 */
  temporalSchema: EntityTemporalField[];
  mapAnchor?: { regionId?: string; pointId?: string; x?: number; y?: number };
  createdAt?: number;
  updatedAt?: number;
  authorNote?: string;
}

// ===========================================================================
// R5-04：检查点、游玩头与恢复
// - 检查点是「账本游标 + 物化投影缓存 + hash」；不是唯一事实，损坏可从账本重建；
// - 恢复三动作：仅查看 / 设为当前游玩头 / 从此另建 IF；默认不提供「覆盖并删除未来」；
// - 不保存 API Key、请求头、未采用草稿。
// ===========================================================================

/** 检查点种类：technical = 自动（IF 锚点 / 重大变化前 / 迁移前）；author = 作者命名 */
export type WorldCheckpointKind = "technical" | "author";

/** 物化投影快照（与 R5-03 ProjectionCheckpoint 同构；hash 覆盖其全部内容） */
export interface CheckpointSnapshot {
  entityStates: Record<string, Record<string, unknown>>;
  flags: Record<string, string | boolean>;
  memoryRefs: Record<string, string[]>;
  narrativeEntries: Record<string, Record<string, { text: string; closed: boolean }>>;
  sourceChain: string[];
  stateHash: string;
}

/**
 * A24-F04：检查点创建时该分支的**游玩位置**。
 * 「设为游玩头」必须把时间 / 地区 / 地点 / 标记一起还原，否则界面指针回到了过去，
 * 引擎仍从旧 runtime 继续——下一次行动会从未来时刻发生。
 */
export interface CheckpointRuntime {
  currentTime: number;
  currentRegionId: string | null;
  currentPointId: string | null;
  worldFlags: string[];
  /** 位置 / 标记无法由该时刻的资料精确重建 → 界面必须显示「按现有资料近似」 */
  approx: boolean;
  /**
   * PLAY-05：检查点当时的「已播放行动指针」（WorldAction.id 列表）。
   * 有了它，回退就能精确还原指针，而不必靠时间比较去猜——
   * 「行动起点恰好等于检查点时刻」的未来行动不会再被误判成已播放。
   * 旧检查点没有该字段 → 回退到时间比较（见 restoreAsPlayhead）。
   */
  actionLog?: string[];
}

/** 检查点：某分支某时刻的物化投影 + 账本游标 */
export interface WorldCheckpoint {
  id: string;
  worldId: string;
  name?: string;
  kind: WorldCheckpointKind;
  /** A24-F04：创建时的游玩位置快照（旧数据缺失 → 恢复只还原时间并标记 approx） */
  runtime?: CheckpointRuntime;
  /** 创建原因（if-fork / before-major-change / before-migration / author-named 等） */
  reason: string;
  branchId: string | null;
  at: number;
  /** 账本游标：该检查点覆盖的最后一条账本事件 id（null = 无事件） */
  ledgerHead: string | null;
  /** 账本游标计数（该分支该时刻及之前的事件数） */
  ledgerCount: number;
  definitionRevisionId?: string | null;
  parentCheckpointId?: string | null;
  snapshot: CheckpointSnapshot;
  createdAt?: number;
}

/** 游玩头：某条线「当前玩到哪」的指针（设回过去不删除其后的账本未来） */
export interface PlayheadState {
  branchId: string | null;
  at: number;
  checkpointId?: string | null;
  updatedAt?: number;
}

/**
 * R5-RC-01：定义内容的不可变快照。
 * 修订创建时一次性捕获；此后即使同 ID 条目被编辑，快照内容（与 hash）也不变——
 * 历史时点的投影 / 检查点 / ContextPlan 读取的是快照，而不是实时数据。
 */
export interface DefinitionSnapshot {
  /** 世界书条目全文（启用状态一并捕获） */
  worldBible: WorldBibleEntry[];
  /** 地区 / 地点基线（id、名称、类型、描述、坐标、归属） */
  regions: Region[];
  points: MapPoint[];
  /** 规则：全局提示词与触发器全文 */
  globalPrompt: string | null;
  triggers: WorldTrigger[];
  /** 实体基线与时态字段声明（创建时的完整副本） */
  entities: EntityRecord[];
  /** 快照内容 hash（不可变性由单测保证） */
  contentHash: string;
}

/** 定义修订（追加式；一经创建不可原地覆写） */
export interface DefinitionRevision {
  id: string;
  worldId: string;
  createdAt: number;
  authorNote: string;
  baseWorldbookRefs?: string[];
  mapRefs?: string[];
  ruleRefs?: string[];
  entityBaselineRefs?: string[];
  parentRevisionId?: string | null;
  /** 跨历史 retcon 必须由作者显式标记；R5-04 检查点记录创建时的 definitionRevisionId */
  isRetcon?: boolean;
  // --- R5-RC-01：历史定义真实回放 ---
  /**
   * 世界内生效时间：该修订从哪个世界时刻起成为权威定义。
   * 与 createdAt（现实时间戳）严格区分；缺省视为 0（基线）。
   */
  effectiveAt?: number;
  /** 生效分支（null / 缺省 = 全部分支；retcon 可按作者选择限定） */
  effectiveBranchId?: string | null;
  /** 不可变内容快照（缺省 = 旧版修订，仅元数据；投影须诚实标 approx） */
  snapshot?: DefinitionSnapshot;
}

// ===========================================================================
// R5-02：类型化状态附着、事件账本与结构化变化提案
// - effects 走白名单 schema，AI / 表格不得提交任意 JSON path；
// - `proposal → preview → 作者接受 → 原子追加 StateEvent` 是唯一写入路径；
// - 更正以新事件 / 撤销事件表达，绝不原地覆写。
// ===========================================================================

/** 状态变化来源：作者登记 / 玩家行动（WorldAction 关联）/ AI 已采用提案 */
export type StateEventSource = "author" | "action" | "ai-adopted";
export const STATE_EVENT_SOURCES: StateEventSource[] = ["author", "action", "ai-adopted"];

/** 白名单 effect：每种都校验实体类型、字段类型与值形状（不提供任意 JSON path） */
export type StateEffect =
  | { kind: "setTemporalField"; entityId: string; key: string; value: string | number | boolean | string[] }
  | { kind: "moveEntity"; entityId: string; regionId?: string; pointId?: string }
  | { kind: "adjustRelation"; entityId: string; targetEntityId: string; key: string; value: string | number }
  | { kind: "addTag"; entityId: string; tag: string }
  | { kind: "removeTag"; entityId: string; tag: string }
  | { kind: "appendMemoryRef"; entityId: string; memoryId?: string; text?: string }
  | { kind: "attachNarrativeEntry"; entityId: string; text: string }
  | { kind: "closeNarrativeEntry"; entityId: string; entryId: string }
  | { kind: "setFlag"; key: string; value?: string };

export const STATE_EFFECT_KINDS: StateEffect["kind"][] = [
  "setTemporalField", "moveEntity", "adjustRelation", "addTag", "removeTag",
  "appendMemoryRef", "attachNarrativeEntry", "closeNarrativeEntry", "setFlag",
];

/** 状态事件：账本的一条追加记录（不可变） */
export interface StateEvent {
  id: string;
  worldId: string;
  /** 正史线为 null；IF 线为 story id */
  branchId: string | null;
  /** 世界内时间 */
  at: number;
  /** 同一 (branchId, at) 内的稳定排序号（先到者小；由追加函数分配） */
  sequence: number;
  source: StateEventSource;
  /** 关联的 WorldAction.id / 会话 id（可追溯来源） */
  actionId?: string | null;
  sessionId?: string | null;
  /** 叙事摘要（发生了什么） */
  narrativeSummary: string;
  /** 受影响实体 id（冗余索引，加速投影） */
  entityRefs: string[];
  effects: StateEffect[];
  /** 更正 / 撤销指向的原事件 */
  reversesEventId?: string | null;
  createdAt?: number;
}

/** 结构化变化提案：AI / 世界 Agent 只能返回提案，采用前零写入 */
export interface ChangeProposal {
  id: string;
  summary: string;
  /** R5-07：提案归属（跨世界 / 过期定义版本的提案被拒绝） */
  worldId?: string;
  definitionRevisionId?: string | null;
  /** 世界内时间与分支（作者确认时可修改） */
  at: number;
  branchId: string | null;
  effects: StateEffect[];
  narrativeText?: string;
  memorySuggestions?: string[];
  /** 置信 / 原因（人类可读） */
  reason?: string;
}

export type RegionType = "city" | "forest" | "mountain" | "sea" | "plain" | "other";

export interface Region {
  id: string;
  worldId: string;
  name: string;
  type: RegionType;
  description: string;
  coordinates: { x: number; y: number };
  // B1 v1：可选视觉字段（subtitle 短标题用于地图图钉 / tone 颜色用于图钉背景 / 与 schema 强制字段区分）
  subtitle?: string;
  tone?: string;
  /** R4-05：可选场景图（URL / data URL）。视觉小说只在提供时渲染；缺失时退回中性氛围，绝不渲染固定奇幻背景。 */
  sceneImage?: string;
  /** 地区自己的静态设定条目；与 MapPoint.worldBook 同形，旧地区默认没有条目。 */
  worldBook?: WorldBibleEntry[];
}

// === B1 v1：地图地点类型（从 World.points 数组项抽出） ===
// 关联 regionId 可选：旧地点无此字段视为未归属；新版本可显式设 null 解绑
export interface MapPoint {
  id: number;
  name: string;
  x: number;
  y: number;
  regionId?: string | null;
  /**
   * 直接父地点（0.9.55 S1）：v2 子图的权威来源。
   * 缺省 / null = 世界图根地点；非 null = 该地点所在的内层地点。
   * 旧存档无此字段照常读取；v1 的 `sub-*` 虚拟点不参与 v2 父链。
   * 注意：本字段是 lib/ 快照的第 2 处蓄意偏差，见 lib/VENDORED.md。
   */
  parentPointId?: number | null;
  /** 地点独有的世界书条目；与 World.worldBible 同形、随地点一起持久化。 */
  worldBook?: WorldBibleEntry[];
}

// === 事件持久化 UIEvent：UI 层事件显示形状（年字符串 + 标题 + 摘要 + 分支数；与正式 Event 类型解耦，避免 schema 重构）===
export interface UIEvent {
  // B3 v1：稳定事件 ID。新事件在创建时生成 crypto.randomUUID()；旧数据（无 id）在 parseWorld 时按 regionId+下标 派生确定性 id。
  // 事件身份以 id 为准（不再用数组下标充当长期身份），用于时间轴—地图精确联动。
  id?: string;
  year: string;
  title: string;
  summary: string;
  // LT-006：可选长正文。摘要用于地图、时间轴等信息密集界面；正文用于事件详情和两种阅读器。
  // 保持可选以兼容已有世界和旧导出文件。
  content?: string;
  branches: number;
  // UI-006/UI-007 v3：参与人物 Character.id 数组（可选，向后兼容；未填则视为无关联）
  characterIds?: string[];
  // B4：特异点标记（可选，向后兼容；标记该事件为关键分歧点）
  singularity?: boolean;
}
export interface Event {
  id: string;
  worldId: string;
  regionId: string | null;
  year: number;
  title: string;
  description: string;
  characterIds: string[];
  isCanon: boolean;
}

export interface Character {
  id: string;
  worldId: string;
  name: string;
  role: string;
  description: string;
  currentRegionId: string | null;
  // UI-004 v1：标签数组（可选，向后兼容；用于筛选与角色分类，如 "主角"/"反派"/"法师"）
  tags?: string[];
  /** R4-05：可选角色立绘（URL / data URL）。视觉小说只在提供时渲染；缺失时退回中性氛围。 */
  portrait?: string;
}

export type StoryMode = "canon" | "if";

// B4：故事步骤——引用事件 + 该处的分歧选择（choice 为在事件处所走路线标签；null = 正史默认走法）
export interface StoryStep {
  eventId: string;
  choice: string | null;
  // B4：步骤备注（可选）
  note?: string;
}

// B4：章节——从某个步骤下标起的分段标题（fromStep 为 0-based 步骤下标）
export interface StoryChapter {
  id: string;
  title: string;
  fromStep: number;
}

// B4：故事线（正史/IF）。最小持久化模型：故事线 + 步骤（含分歧选择）+ 章节 + 父线/分歧事件 + 特异点（事件侧）。
export interface Story {
  id: string;
  worldId: string;
  mode: StoryMode;
  title: string;
  steps: StoryStep[];
  // B4：章节列表（可选）
  chapters?: StoryChapter[];
  // B4：父线 ID（IF 派生自哪条故事线；正史为 undefined/null）
  parentStoryId?: string | null;
  // B4：分歧事件 ID（IF 从此事件处从父线分叉；正史为 undefined/null）
  divergenceEventId?: string | null;
  createdAt?: number;
  updatedAt?: number;
  // --- R4-03：IF 的结构化谱系（标题与身份**绝不**从父标题字符串推导）---
  ifOrigin?: IFOrigin | null;
}

/**
 * R4-03：一条 IF 的**结构化出身**。
 *
 * 存在的理由：旧实现用 `IF：${parent.title}` 递归拼标题，反复从 IF 再开 IF 就会得到
 * `IF：IF：IF：…`。这里把谱系全部落到字段上——标题只是这些字段的可编辑渲染结果，
 * 任何一条线都能一路回溯到 `rootStoryId`，不依赖任何字符串解析。
 */
export interface IFOrigin {
  /** 分歧家族的根：任何一代 IF 都指向最初那条正史线（不得再套娃） */
  rootStoryId: string;
  /** 直接来源线（正史或另一条 IF） */
  sourceStoryId: string;
  /** 锚点事件 id（从此事件的时点分叉；无事件锚点时 null） */
  anchorEventId: string | null;
  /** 锚点步骤下标（与 anchorEventId 互补；无步骤锚点时 null） */
  anchorStep: number | null;
  /** 锚点世界时间：IF 的初始时间由它投影得出，绝不复制来源线末尾 */
  anchorAt: number;
  /** 视角人物（同一锚点下不同视角算不同变体） */
  viewpointCharacterId: string | null;
  /**
   * 平行变体序号（同一锚点下的第 N 条；从 1 起）。
   * 与上面字段一起构成**幂等会话键**：相同键重复创建只会恢复既有 IF。
   */
  variant: number;
  /** 用户可编辑的短标签；缺省用序号渲染（a / b / c…） */
  label?: string | null;
  /** 起点为近似（缺资料无法精确重建），界面必须诚实显示 */
  approx?: boolean;
}

// B5：阅读进度——当前正在阅读的（故事线 + 步骤 + 模式 + 字号）。
// 视觉小说（visual）与书籍阅读器（reader）共享同一 storyId，进度统一落在此处，
// 实现「双阅读模式读同一故事、刷新恢复、切世界不串」。
export type PresentationMode = "visual" | "reader";

export interface ReadingProgress {
  // 正在阅读的故事线 ID（指向 World.stories 中某条 Story；精确身份，不用下标）
  storyId: string;
  // 当前步骤下标（0-based，指向 Story.steps）
  step: number;
  // B5：当前章节下标（可选；可由 step 经 Story.chapters 推导；显式存以便直接跳转/恢复）
  chapter?: number | null;
  // B5：呈现模式——视觉小说 / 书籍阅读
  presentationMode?: PresentationMode;
  // B5：阅读字号（书籍阅读器；pt 单位）
  fontSize?: number;
}

// ===========================================================================
// W0：世界运转、NPC 状态与故事会话 Agent 的数据模型
// ---------------------------------------------------------------------------
// 设计约束（来自 待办计划 README 的 W0 详细交接要求）：
// - 所有新字段均为 World 下的**可选**字段；旧世界没有这些字段时必须照常打开，
//   不能迁移时丢失地区、地点、人物、事件、故事、阅读进度、世界书或 API 配置。
// - 世界工作台是「状态与日志层」，不是第三种阅读模式；**时间只由作者行动推进**，
//   页面打开、刷新、切换工作区或后台停留绝不能让世界偷偷前进。
// - 每条故事线 / IF 都有独立运行快照；IF 从分歧时刻**深拷贝**，绝不共享可写对象。
// - 人物档案（Character）与动态状态 / 记忆分离：不把记忆和临时状态塞回简介字段。
// - 会话 Agent 绝不保存 API Key；连接被删除后显示失效，不静默换到未知模型。
// ===========================================================================

// W0 容量 / 长度上限：parser 严格校验，超限条目一律拒绝（不静默截断造成数据错觉）。
export const W0_LIMITS = {
  maxCharacterStates: 500,
  maxCharacterMemories: 1000,
  maxMemoryContent: 2000,
  maxTriggers: 200,
  maxTriggerTitle: 120,
  maxTriggerSummary: 500,
  maxOutcomeTemplate: 2000,
  maxOutcomeTags: 20,
  maxTagLength: 60,
  maxStoryRuntimes: 50,
  maxCompanions: 24,
  maxWorldFlags: 100,
  maxFlagLength: 80,
  maxActions: 500,
  maxOutcomes: 500,
  maxViaPoints: 24,
  maxCandidateSources: 60,
  maxSourceLabel: 120,
  maxStatusLength: 500,
  maxAgentSessions: 50,
  maxSessionSummary: 4000,
  maxOpenThreads: 50,
  maxThreadLength: 500,
  maxChangeRefs: 50,
  maxReasonLength: 1000,
  // --- N4：创作反馈（可编辑行动摘要） ---
  maxActionSummary: 400,
  // --- R5-01：世界定义版本与实体目录 ---
  maxDefinitionRevisions: 200,
  maxEntityRecords: 500,
  maxEntityTemporalFields: 50,
  maxEntityBaselineFields: 50,
  maxEntityFieldKey: 60,
  maxEntityTypeName: 40,
  maxRevisionNote: 500,
  // --- R5-02：状态事件账本 ---
  maxStateEvents: 5000,
  // --- R5-04：检查点与游玩头 ---
  maxCheckpoints: 200,
  maxCheckpointName: 120,
  maxCheckpointReason: 200,
  maxStateEventEffects: 20,
  maxStateEventSummary: 500,
  maxStateEntityRefs: 40,
  maxNarrativeEntry: 2000,
  // --- R4-04：酒馆式扮演会话 ---
  maxRoleplaySessions: 24,
  maxRoleplayMessages: 120,
  maxRoleplayMessageChars: 8000,
  maxRoleplayChoices: 12,
  maxRoleplayChanges: 24,
  maxRoleplayChangeLabel: 120,
  maxRoleplayChangeDetail: 600,
  maxRoleplayContextTitles: 60,
} as const;

// 人物动态状态（与 Character 档案分离：档案相对稳定，状态随行动变化）。
// currentPointId 必须指向存在的地点，且该地点归属地区要与人物地区一致。
export interface CharacterState {
  characterId: string;
  currentRegionId: string | null;
  currentPointId?: string | null;
  /** 状态摘要（人类可读；不是简介字段的副本） */
  status?: string;
  updatedAt: number;
  // --- N2：分支化 NPC 动态位置（正史基线 + IF 覆盖）---
  /**
   * 所属分支（某条 IF 的 story id）。
   * 缺失 / null = **正史基线**（旧世界没有该字段，语义完全等价，不丢状态）。
   * IF 的移动只写自己的覆盖条目，绝不改写正史基线或兄弟 IF。
   */
  branchId?: string | null;
}

// 人物记忆：只存事实或作者确认的结果；AI 猜测必须经作者确认后才写入。
// 每个 IF 使用独立记忆视图 / 快照，绝不回流污染正史或其他 IF。
export interface CharacterMemory {
  /** 稳定 id */
  id: string;
  characterId: string;
  /** 发生时间（世界时间；由行动推进，不由系统时钟） */
  at: number;
  content: string;
  regionId?: string | null;
  pointId?: string | null;
  eventId?: string | null;
  /** 重要标记（用于压缩摘要时保留） */
  important?: boolean;
  createdAt: number;
  // --- W0-03：时间化记忆（关联行动 + 分支作用域）---
  /** 产生这条记忆的行动 id；用于从行动日志反查「为什么记得」 */
  actionId?: string | null;
  /**
   * 所属分支（正史或某条 IF 的 story id）。
   * 每个 IF 使用独立记忆视图，绝不回流污染正史或其他 IF。
   */
  branchId?: string | null;
}

// 触发器条件：首版只支持可解释条件（时间、位置、参与人物、已发生/未发生标记）。
// 不加入优先级、递归和隐藏后台任务。
export interface WorldTriggerCondition {
  minTime?: number | null;
  maxTime?: number | null;
  regionId?: string | null;
  pointId?: string | null;
  characterIds?: string[];
  /** 需要已存在的世界标记 */
  requiresFlag?: string | null;
  /** 需要未发生的世界标记 */
  forbidsFlag?: string | null;
}

// 可运行的事件钩子（不是世界书条目：世界书只负责静态设定）。
export interface WorldTrigger {
  id: string;
  enabled: boolean;
  title: string;
  /** 条件摘要（人类可读，供日志与 UI 展示） */
  conditionSummary?: string;
  condition?: WorldTriggerCondition;
  /** 可记录的结果模板 */
  outcomeTemplate?: string;
  outcomeTags?: string[];
  /** 来源范围：触发器只从本次行动可达的来源中挑选 */
  scopeRegionIds?: string[];
  scopePointIds?: string[];
  createdAt?: number;
  updatedAt?: number;
}

// 某一正史或 IF 的动态世界快照。IF 创建时深拷贝分歧时刻状态；
// 正史与不同 IF 不能共享可写对象。
export interface StoryRuntime {
  storyId: string;
  /** 当前世界时间（只由行动推进） */
  currentTime: number;
  currentRegionId: string | null;
  currentPointId?: string | null;
  /** 同行者 characterId 列表 */
  companions?: string[];
  /** 世界标记（已发生的事实标签） */
  worldFlags?: string[];
  /** 行动日志引用（WorldAction.id，按时间顺序） */
  actionLog?: string[];
  /** 快照来源 storyId（IF 从哪条线复制而来；正史为 null/undefined） */
  snapshotFrom?: string | null;
  updatedAt?: number;
}

/** 行动类型：探索移动 / 等待 / 交互 / 选择分歧 */
export type WorldActionKind = "move" | "wait" | "interact" | "choice";

/** 本次行动筛选出的候选来源（可见、可复现） */
export interface WorldActionSourceRef {
  kind: "region" | "point" | "character" | "worldBook" | "trigger";
  id: string;
  label?: string;
}

// 一条行动记录：必须保留来源与持续时间，不能只存最终文本。
export interface WorldAction {
  id: string;
  /** 行动发生时的世界时间 */
  at: number;
  kind: WorldActionKind;
  /** 发起者 characterId（可为空，表示世界/作者侧行动） */
  actorId?: string | null;
  fromRegionId?: string | null;
  fromPointId?: string | null;
  toRegionId?: string | null;
  toPointId?: string | null;
  /** 作者明确选择的途经点 */
  viaPointIds?: string[];
  /** 明确持续时间（首版为作者可选；不填则由引擎给默认） */
  duration?: number;
  candidateSources?: WorldActionSourceRef[];
  /** 随机种子：任何随机结果刷新后必须一致 */
  seed?: number;
  outcomeId?: string | null;
  // --- W0-01c：时长来源与基线 / 世界 Agent 版本（日志可识别，绝不丢失归因） ---
  /** 行动开始时间（世界时间） */
  startedAt?: number;
  /** 行动结束时间（世界时间） */
  endedAt?: number;
  /** 时长来源：默认基线建议 / 世界 Agent 辅助 / 作者手动填写 */
  durationSource?: DurationSource;
  /** 本次行动使用的默认移动提示基线版本（写进日志，任何回退都可被识别） */
  baselineVersion?: string;
  /** 本次行动引用的世界 Agent revision（未使用世界 Agent 时为 null） */
  worldAgentRevision?: string | null;
  /** 本次行动的焦点卡 id（CardAgentProfile.id；无焦点时为 null） */
  focusCardId?: string | null;
  // --- N4：作者审阅后的可编辑行动摘要（创作反馈面板接受后才写入） ---
  /** 行动摘要（作者可编辑；默认由行动 + 结果推导） */
  summary?: string;
}

/** 行动时长来源：默认基线 / 世界 Agent 辅助 / 作者手动确认 */
export type DurationSource = "baseline" | "worldAgent" | "manual";
export const DURATION_SOURCES: DurationSource[] = ["baseline", "worldAgent", "manual"];

// 行动结果：无事发生也要有可解释日志；结果必须保留变更理由。
export interface WorldOutcome {
  id: string;
  actionId: string;
  kind: "nothing" | "trigger";
  triggerId?: string | null;
  /** 结果文本 / 摘要 */
  result?: string;
  /** 状态变更引用（可追溯，不能只存最终文本） */
  changeRefs?: string[];
  /** 变更理由 */
  reason?: string;
  seed?: number;
  at?: number;
}

/** 调用策略：仅手动（默认）/ 重大事件时询问 / 每次行动前询问 */
export type AgentCallStrategy = "manual" | "ask-on-major" | "ask-each-action";

// 某故事线的本地 AI 会话摘要和路由。
// 绝不保存 API Key；切换 API 预设不会丢失故事会话。
export interface StoryAgentSession {
  storyId: string;
  /** 绑定的连接 id（绝不存 key）；连接被删除后应显示失效，不静默换模型 */
  connectionId?: string | null;
  strategy?: AgentCallStrategy;
  /** 世界 / 人物压缩摘要（受限，不发送整个数据库） */
  worldSummary?: string;
  /** 未解决线索 */
  openThreads?: string[];
  // --- W0-01b：叙事镜头、知识范围与活动卡片 ---
  /** 叙事镜头：第一人称视觉小说 / 阅读式叙事。只改变呈现与知识可见范围，不新建世界状态 */
  presentationMode?: NarrativePresentationMode;
  /** 第一人称时的视角人物 characterId */
  viewpointCharacterId?: string | null;
  /** 阅读式叙事的作者指定可见范围（人类可读说明） */
  knowledgeScope?: string;
  /** 本故事线当前活动的焦点卡会话 id（CardAgentSession.id；W0-01c 起语义为焦点） */
  activeCardSessionIds?: string[];
  // --- W0-01c：引用世界 Agent 的固定 revision（故事 / IF 不复制世界 Agent）---
  /** 引用的世界 Agent id；未使用或已删除时为 null */
  worldAgentId?: string | null;
  /** 引用的世界 Agent revision；IF 可继续固定旧版本，绝不无提示升级 */
  worldAgentRevision?: string | null;
  updatedAt?: number;
}

// ===========================================================================
// W0-01b：卡片 Agent、入口锚点与来源版本
// ---------------------------------------------------------------------------
// 这里的「Agent」不是独立大模型，也不是自动改写资料的脚本，而是**故事上下文中
// 一张卡的受限职责**。四层严格分离，任何一层都不能反向污染其他层：
//   原卡（作者资料，唯一事实来源）
//     → CardAgentProfile（静态职责 / 来源版本 / 参与范围；不发请求）
//     → CardAgentSession（某正史或 IF 的焦点、摘要与检查点；不保存密钥）
//     → StoryAgentSession（合并上下文后唯一允许调用 API 的入口）
// ===========================================================================

/** 可拥有 Agent 配置的卡片类型：事件 / 地点 / 人物 / 故事起点 */
export type CardType = "event" | "point" | "character" | "story";
export const CARD_TYPES: CardType[] = ["event", "point", "character", "story"];

/**
 * 参与方式（W0-01c 语义对齐：卡片不再「启动 Agent」，只提供焦点）：
 * - `passive`：仅在来源命中时提供压缩事实，不是叙事焦点；
 * - `focusable`：可被某条正史 / IF 设为焦点，只改变当前请求的焦点，不创建新 Agent。
 */
export type CardParticipation = "passive" | "focusable";
export const CARD_PARTICIPATIONS: CardParticipation[] = ["passive", "focusable"];

/** 卡片会话生命周期状态 */
export type CardSessionStatus = "idle" | "active" | "paused" | "archived";
export const CARD_SESSION_STATUSES: CardSessionStatus[] = ["idle", "active", "paused", "archived"];

/**
 * 入口策略：
 * - `read-canon` 阅读正史（只读，不写状态）
 * - `branch-if` 从这里开始体验（创建独立 IF）
 * - `import-moment` 从当前导入时刻开始
 * - `direct-play` 直接游玩（不启动卡片 Agent）
 */
export type EntryPolicy = "read-canon" | "branch-if" | "import-moment" | "direct-play";
export const ENTRY_POLICIES: EntryPolicy[] = ["read-canon", "branch-if", "import-moment", "direct-play"];

/** 叙事镜头：第一人称视觉小说 / 阅读式叙事 */
export type NarrativePresentationMode = "firstPerson" | "reader";
export const NARRATIVE_PRESENTATION_MODES: NarrativePresentationMode[] = ["firstPerson", "reader"];

/** W0-01b 容量 / 长度上限（parser 严格校验，超限即拒绝） */
export const W0_CARD_LIMITS = {
  maxProfiles: 300,
  maxSessions: 600,
  maxAnchors: 300,
  maxSourceRefs: 60,
  maxRoleConstraints: 2000,
  maxSummary: 2000,
  maxContextSummary: 4000,
  maxCheckpointSummary: 2000,
  maxCheckpointFlags: 100,
  maxManualEditedFields: 40,
  maxActiveCardSessions: 24,
  maxKnowledgeScope: 2000,
  maxTerrainFactors: 200,
  maxDistanceUnit: 24,
} as const;

// 附着于原卡的**静态** Agent 配置。
// 绝不保存 API Key、聊天记录或可写世界状态。
export interface CardAgentProfile {
  id: string;
  cardType: CardType;
  /** 原卡 id（事件 / 地点 / 人物 / 故事起点） */
  sourceCardId: string;
  enabled: boolean;
  participation: CardParticipation;
  /** 有效时间范围（世界时间；两端可选，可只填一端） */
  activeFrom?: number | null;
  activeTo?: number | null;
  /** 关联来源 id（世界书条目 / 事件 / 地点等；受限，不塞整库） */
  sourceRefs?: string[];
  /** 角色约束 / 叙事边界（人类可读） */
  roleConstraints?: string;
  /** 可选默认连接 id（仅存 id，绝不存 key） */
  defaultConnectionId?: string | null;
  /** 来源卡版本：原卡内容变更时用于标记「待复核」，绝不静默重写 profile */
  sourceRevision: string;
  /** 作者手改过的字段名；这些字段禁止被 AI 草稿或重新编译静默覆盖 */
  manuallyEdited?: string[];
  /** 源卡已更新但作者尚未处理 → 需复核 */
  needsReview?: boolean;
  /** 职责摘要（受限长度） */
  summary?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** 会话检查点：可重建的最小状态引用，用于 IF 派生与恢复 */
export interface CardSessionCheckpoint {
  actionId?: string | null;
  at?: number | null;
  summary?: string;
  worldFlags?: string[];
}

// 某 profile 在**一条正史 / IF** 内的运行状态。
// 「活动」只能属于具体故事线，不能全世界共享；归档后不再进入请求上下文。
export interface CardAgentSession {
  id: string;
  profileId: string;
  /** 所属正史线 id */
  storyId: string;
  /** 当前分支 id：正史时等于 storyId，IF 时等于该 IF 的 story id */
  branchId: string;
  status: CardSessionStatus;
  /** 启动时的行动 id */
  startedAtActionId?: string | null;
  /** 上下文摘要（受限，不发送整个数据库） */
  contextSummary?: string;
  /** 检查点（可重建，不保存可写世界状态） */
  checkpoint?: CardSessionCheckpoint | null;
  /** 启动时的 sourceRevision，用于检测运行期源卡变更 */
  sourceRevision?: string | null;
  lastUsedAt?: number;
  updatedAt?: number;
}

// 入口锚点：把导入卡和已有卡放到地图 / 时间轴可进入的位置。
// 卡片可以只绑时间或只绑地图；引用删除后显示失效入口而非静默消失。
export interface StoryEntryAnchor {
  id: string;
  sourceCardId: string;
  cardType: CardType;
  /** 关联事件（可选） */
  eventId?: string | null;
  /** 时间点（世界时间）；只绑地图时可为空 */
  at?: number | null;
  regionId?: string | null;
  pointId?: string | null;
  /** 网格坐标引用；只绑时间时可为空 */
  x?: number | null;
  y?: number | null;
  entryPolicy: EntryPolicy;
  /**
   * 历史入口的时点快照引用。创建 IF 前必须保存**可重建的时点快照**，
   * 绝不能读取未来状态。
   */
  snapshotRef?: string | null;
  /**
   * 引用已失效（源卡被删除，或地区 / 地点不存在）。
   * 失效入口**保留**并显示，让作者能处理，绝不静默删除。
   */
  invalid?: boolean;
  createdAt?: number;
  /** 资料完整度备注：导入 / 编辑时对来源材料覆盖程度的作者自评 */
  completenessNote?: string;
}

// 地图旅行设置：把可见网格转为可计算的旅行尺度。
// 无设置的旧地图仍正常编辑，只是移动改为要求作者确认时长，不凭空计算。
export interface MapTravelSettings {
  enabled: boolean;
  /** 每个网格格子代表的距离 */
  distancePerCell: number;
  /** 距离单位（如「里」「公里」） */
  distanceUnit: string;
  /** 默认旅行速度（距离单位 / 世界时间单位） */
  defaultSpeed: number;
  /** 简化地形系数：地点 id / 地区 id / 途经段 key → 系数（1 = 无修正） */
  terrainFactors?: Record<string, number>;
}

// ===========================================================================
// W0-01c：默认移动提示基线与世界 Agent 根配置
// ---------------------------------------------------------------------------
// Agent 的根属于**当前世界**，不属于某张卡或某条故事：
//   DefaultTravelBaseline（版本化系统常量；任何世界都能用的兜底基线）
//     → WorldAgentProfile（每个世界最多一份，编译该世界的世界书 / 地图 / 人物）
//     → CardAgentProfile / CardAgentSession（兼容名；语义为焦点配置 / 分支焦点状态）
//     → StoryAgentSession（唯一主故事请求入口，引用 worldAgentId + revision）
// 任何解析失败、删除或失效，所有故事请求**无条件回退**到 DefaultTravelBaseline。
// ===========================================================================

/** 默认移动提示基线的稳定版本；必须写进日志，使任何回退都可被识别。 */
export const DEFAULT_TRAVEL_BASELINE_VERSION = "dtb-1";

/** 无地图比例时的默认速度档：每个时段可推进的网格格数 */
export interface TravelBaselineSpeedTier {
  id: string;
  label: string;
  /** 每个时段行进的格数 */
  cellsPerPeriod: number;
}

/** 无地图比例时的默认地形档：行进修正系数（1 = 无修正，>1 更慢） */
export interface TravelBaselineTerrainTier {
  id: string;
  label: string;
  /** 系数；1 = 无修正 */
  factor: number;
}

// 未 Agent 化时每次故事请求都携带的系统提示基线。
// **不是**世界书条目，也不要求用户预先配置；必须在 UI 可查看，版本要写进日志。
export interface DefaultTravelBaseline {
  /** 稳定版本（如 dtb-1） */
  version: string;
  /** 网格距离公式（人类可读；UI 可查看） */
  distanceFormula: string;
  /** 默认速度档（无地图比例时使用） */
  speedTiers: TravelBaselineSpeedTier[];
  /** 默认地形档（无地图比例时使用） */
  terrainTiers: TravelBaselineTerrainTier[];
  /** 无地图比例时的抽象「格程 / 时段」规则；绝不伪装有真实世界尺度 */
  abstractRule: string;
  /** 要求模型返回 duration + basis 的输出约束 */
  outputConstraint: string;
}

/**
 * 版本化的默认移动提示基线（系统常量，非世界数据）。
 * 无世界书、无地图比例、无世界 Agent 的旧世界也能凭它生成完整提示上下文。
 */
export const DEFAULT_TRAVEL_BASELINE: DefaultTravelBaseline = {
  version: DEFAULT_TRAVEL_BASELINE_VERSION,
  distanceFormula:
    "网格距离 = round(√((x2-x1)² + (y2-y1)²))，按地图 0-100 网格坐标计算；地图已标定每格距离时，再乘以每格距离换算为实际距离。",
  speedTiers: [
    { id: "slow", label: "缓行（负重 / 侦查）", cellsPerPeriod: 4 },
    { id: "normal", label: "常速（默认）", cellsPerPeriod: 8 },
    { id: "fast", label: "疾行（轻装 / 赶路）", cellsPerPeriod: 14 },
  ],
  terrainTiers: [
    { id: "road", label: "大道 / 平原", factor: 1 },
    { id: "rough", label: "丘陵 / 林地", factor: 1.4 },
    { id: "mountain", label: "山地 / 沼泽", factor: 2 },
  ],
  abstractRule:
    "地图未标定时不换算真实里数，只用「格程」与「时段」表达：先给网格距离，再按速度档得出需要多少个时段；作者确认后才写入 duration，绝不生成伪精确数字。",
  outputConstraint:
    '只输出 JSON：{ "duration": <数字>, "basis": "<一句话依据：网格距离 / 速度档 / 地形档 / 是否已标定>" }。不要输出正文，不要编造地图比例，不要修改世界状态。',
};

/** 世界 Agent 生命周期状态（无 profile 即为 disabled，由解析器推导） */
export type WorldAgentStatus = "ready" | "optimizing" | "active" | "stale";
export const WORLD_AGENT_STATUSES: WorldAgentStatus[] = ["ready", "optimizing", "active", "stale"];

// 世界级旅行辅助：服务于该世界内的**全部**故事与卡片，不是为某条故事单独创建。
export interface WorldAgentTravelGuide {
  /** 旅行辅助正文（受限长度） */
  content: string;
  /** 生成该辅助时使用的来源 id（世界书 / 地图 / 人物等） */
  sourceRefs?: string[];
  /** 生成时的假设（作者可查看） */
  assumptions?: string[];
  updatedAt?: number;
}

// 当前世界唯一的根 Agent。
// **不含任何 story / IF 可写状态**，也不保存 API Key；一个世界最多一份（故为单值字段）。
export interface WorldAgentProfile {
  id: string;
  worldId: string;
  status: WorldAgentStatus;
  /** 编译该 profile 时使用的默认基线版本 */
  baselineVersion: string;
  /** 作者选定的世界书 / 地图 / 人物来源 id */
  sourceRefs?: string[];
  /** 世界摘要（受限） */
  worldSummary?: string;
  /** 旅行辅助；存在且非空即为 active */
  travelGuide?: WorldAgentTravelGuide | null;
  /** 来源版本：由世界书 / 地图 / 人物共同决定 */
  sourceRevision: string;
  /** 假设清单（作者可查看） */
  assumptions?: string[];
  /** 连接路由（仅存 id，绝不存 key）；未设置时回退 `worldRuntime` 绑定 */
  connectionId?: string | null;
  // --- R5-07：世界级 Agent 运行态 ---
  /** 本 artifact 基于的定义版本（与 definitionRevisions 最新 id 比对判断过期） */
  definitionRevisionId?: string | null;
  /** 上次作者刷新（生成 / 采用 artifact）时间 */
  lastRefreshedAt?: number;
  /** 失效原因（stale 时给作者可读说明） */
  invalidReason?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export function worldStorageKey(worldId: string): string {
  return WORLD_STORAGE_PREFIX + worldId;
}


// === B1 v1：parseMapPoint 校验 MapPoint 形状（id 必填 number + 坐标 + 可选 regionId） ===
export function parseMapPoint(raw: unknown): MapPoint | null {
  if (!isObject(raw)) return null;
  if (!isNumber(raw.id)) return null;
  if (!isString(raw.name)) return null;
  if (!isNumber(raw.x) || !isNumber(raw.y)) return null;
  if (raw.regionId !== undefined && raw.regionId !== null && !isString(raw.regionId)) return null;
  // 0.9.55 S1：父地点只接受 null / 缺省，或**有限正整数**。
  // 明确拒绝字符串（含 "9001"）、负数、0、小数、NaN、Infinity —— 父链是结构化标识，
  // 不做宽松转换（否则 "abc" 会静默变成断链）。
  if (raw.parentPointId !== undefined && raw.parentPointId !== null) {
    if (!isNumber(raw.parentPointId)) return null;
    if (!Number.isInteger(raw.parentPointId) || raw.parentPointId <= 0) return null;
  }
  if (raw.worldBook !== undefined) {
    if (!Array.isArray(raw.worldBook) || raw.worldBook.length > WORLD_BIBLE_MAX_ENTRIES) return null;
    for (const entry of raw.worldBook) {
      if (parseWorldBibleEntry(entry) === null) return null;
    }
  }
  return {
    id: raw.id,
    name: raw.name,
    x: raw.x,
    y: raw.y,
    ...(raw.regionId !== undefined ? { regionId: raw.regionId as string | null } : {}),
    ...(raw.parentPointId !== undefined ? { parentPointId: raw.parentPointId as number | null } : {}),
    ...(Array.isArray(raw.worldBook) ? { worldBook: (raw.worldBook as unknown[]).map((entry) => parseWorldBibleEntry(entry)!).filter((entry): entry is WorldBibleEntry => entry !== null) } : {}),
  };
}

export function parseWorldBibleEntry(raw: unknown): WorldBibleEntry | null {
  if (!isObject(raw)) return null;
  if (!isString(raw.id) || raw.id.length === 0) return null;
  if (!isString(raw.category) || raw.category.length === 0) return null;
  // 草稿条目允许标题/正文暂为空，避免作者新建一项时因为尚未填写而无法自动保存。
  if (!isString(raw.title) || !isString(raw.content)) return null;
  if (raw.tags !== undefined && (!Array.isArray(raw.tags) || !raw.tags.every(isString))) return null;
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return null;
  if (raw.activationMode !== undefined && !WORLD_BIBLE_ACTIVATION_MODES.includes(raw.activationMode as WorldBibleActivationMode)) return null;
  if (raw.keys !== undefined && (!Array.isArray(raw.keys)
    || raw.keys.length > WORLD_BIBLE_MAX_KEYS
    || !raw.keys.every((key) => isString(key) && key.trim().length > 0 && key.length <= WORLD_BIBLE_KEY_MAX_LENGTH))) return null;
  if (raw.updatedAt !== undefined && !isNumber(raw.updatedAt)) return null;
  return {
    id: raw.id,
    category: raw.category,
    title: raw.title,
    content: raw.content,
    ...(Array.isArray(raw.tags) ? { tags: raw.tags as string[] } : {}),
    ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
    ...(raw.activationMode === "always" || raw.activationMode === "keywords" ? { activationMode: raw.activationMode } : {}),
    ...(Array.isArray(raw.keys) ? { keys: raw.keys as string[] } : {}),
    ...(isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
  };
}

export function parseRegion(raw: unknown): Region | null {
  if (!isObject(raw)) return null;
  if (!isString(raw.id) || raw.id.length === 0) return null;
  if (!isString(raw.worldId) || raw.worldId.length === 0) return null;
  if (!isString(raw.name)) return null;
  const validTypes: RegionType[] = ["city", "forest", "mountain", "sea", "plain", "other"];
  if (!isString(raw.type) || !validTypes.includes(raw.type as RegionType)) return null;
  if (!isString(raw.description)) return null;
  if (!isObject(raw.coordinates)) return null;
  if (!isNumber(raw.coordinates.x) || !isNumber(raw.coordinates.y)) return null;
  // B1 v1：可选 subtitle / tone 字段（保留合法值；非法值忽略不写入）
  if (raw.subtitle !== undefined && !isString(raw.subtitle)) return null;
  if (raw.tone !== undefined && !isString(raw.tone)) return null;
  // R4-05：可选场景图 / 立绘——只接受安全协议（http(s)/data:image/相对路径），拒绝 javascript: 等危险值（忽略不写入）
  const safeSceneImage = isString(raw.sceneImage) && /^(https?:\/\/|data:image\/|\/|\.\/|\.\.\/)/i.test(raw.sceneImage) ? raw.sceneImage : null;
  // W0：地区自己的静态设定条目（与 MapPoint.worldBook 同形）；旧地区默认没有条目。
  if (raw.worldBook !== undefined) {
    if (!Array.isArray(raw.worldBook) || raw.worldBook.length > WORLD_BIBLE_MAX_ENTRIES) return null;
    for (const entry of raw.worldBook) {
      if (parseWorldBibleEntry(entry) === null) return null;
    }
  }
  return {
    id: raw.id,
    worldId: raw.worldId,
    name: raw.name,
    type: raw.type as RegionType,
    description: raw.description,
    coordinates: { x: raw.coordinates.x, y: raw.coordinates.y },
    ...(isString(raw.subtitle) ? { subtitle: raw.subtitle } : {}),
    ...(isString(raw.tone) ? { tone: raw.tone } : {}),
    ...(safeSceneImage ? { sceneImage: safeSceneImage } : {}),
    ...(Array.isArray(raw.worldBook) ? { worldBook: (raw.worldBook as unknown[]).map((entry) => parseWorldBibleEntry(entry)!).filter((entry): entry is WorldBibleEntry => entry !== null) } : {}),
  };
}

export function parseEvent(raw: unknown): Event | null {
  if (!isObject(raw)) return null;
  if (!isString(raw.id) || raw.id.length === 0) return null;
  if (!isString(raw.worldId) || raw.worldId.length === 0) return null;
  if (raw.regionId !== null && !isString(raw.regionId)) return null;
  if (!isNumber(raw.year)) return null;
  if (!isString(raw.title)) return null;
  if (!isString(raw.description)) return null;
  if (!Array.isArray(raw.characterIds)) return null;
  if (!raw.characterIds.every(isString)) return null;
  if (typeof raw.isCanon !== "boolean") return null;
  if (raw.singularity !== undefined && typeof raw.singularity !== "boolean") return null;
  return {
    id: raw.id,
    worldId: raw.worldId,
    regionId: raw.regionId,
    year: raw.year,
    title: raw.title,
    description: raw.description,
    characterIds: raw.characterIds as string[],
    isCanon: raw.isCanon,
    ...(typeof raw.singularity === "boolean" ? { singularity: raw.singularity } : {}),
  };
}

export function parseCharacter(raw: unknown): Character | null {
  if (!isObject(raw)) return null;
  if (!isString(raw.id) || raw.id.length === 0) return null;
  if (!isString(raw.worldId) || raw.worldId.length === 0) return null;
  if (!isString(raw.name)) return null;
  if (!isString(raw.role)) return null;
  if (!isString(raw.description)) return null;
  if (raw.currentRegionId !== null && !isString(raw.currentRegionId)) return null;
  if (raw.tags !== undefined && !Array.isArray(raw.tags)) return null;
  if (raw.tags !== undefined && !raw.tags.every(isString)) return null;
  const safePortrait = isString(raw.portrait) && /^(https?:\/\/|data:image\/|\/|\.\/|\.\.\/)/i.test(raw.portrait) ? raw.portrait : null;
  return {
    id: raw.id,
    worldId: raw.worldId,
    name: raw.name,
    role: raw.role,
    description: raw.description,
    currentRegionId: raw.currentRegionId,
    ...(Array.isArray(raw.tags) ? { tags: raw.tags as string[] } : {}),
    ...(safePortrait ? { portrait: safePortrait } : {}),
  };
}

export function parseStory(raw: unknown): Story | null {
  if (!isObject(raw)) return null;
  if (!isString(raw.id) || raw.id.length === 0) return null;
  if (!isString(raw.worldId) || raw.worldId.length === 0) return null;
  if (raw.mode !== "canon" && raw.mode !== "if") return null;
  if (!isString(raw.title)) return null;
  if (!Array.isArray(raw.steps)) return null;
  const steps: StoryStep[] = [];
  for (const step of raw.steps) {
    if (!isObject(step)) return null;
    if (!isString(step.eventId) || step.eventId.length === 0) return null;
    if (step.choice !== null && !isString(step.choice)) return null;
    if (step.note !== undefined && !isString(step.note)) return null;
    steps.push({
      eventId: step.eventId,
      choice: step.choice as string | null,
      ...(typeof step.note === "string" ? { note: step.note } : {}),
    });
  }
  // B4：父线 / 分歧事件（可选；正史为 undefined 或 null）
  if (raw.parentStoryId !== undefined && raw.parentStoryId !== null && !isString(raw.parentStoryId)) return null;
  if (raw.divergenceEventId !== undefined && raw.divergenceEventId !== null && !isString(raw.divergenceEventId)) return null;
  if (raw.createdAt !== undefined && !isNumber(raw.createdAt)) return null;
  if (raw.updatedAt !== undefined && !isNumber(raw.updatedAt)) return null;
  // B4：章节（可选数组；每项含 id/title/fromStep）
  let chapters: StoryChapter[] | undefined;
  if (raw.chapters !== undefined) {
    if (!Array.isArray(raw.chapters)) return null;
    chapters = [];
    for (const ch of raw.chapters) {
      if (!isObject(ch)) return null;
      if (!isString(ch.id) || ch.id.length === 0) return null;
      if (!isString(ch.title)) return null;
      if (!isNumber(ch.fromStep)) return null;
      chapters.push({ id: ch.id, title: ch.title, fromStep: ch.fromStep });
    }
  }
  // R4-03：IF 谱系（可选；损坏或缺失时**整条丢弃该字段**，绝不因此拒绝整条故事线）
  let ifOrigin: IFOrigin | null | undefined;
  if (raw.ifOrigin !== undefined && raw.ifOrigin !== null) {
    ifOrigin = parseIFOrigin(raw.ifOrigin);
    if (ifOrigin === null) return null;
  } else if (raw.ifOrigin === null) {
    ifOrigin = null;
  }

  return {
    id: raw.id,
    worldId: raw.worldId,
    mode: raw.mode,
    title: raw.title,
    steps,
    ...(chapters ? { chapters } : {}),
    ...(raw.parentStoryId !== undefined ? { parentStoryId: raw.parentStoryId as string | null } : {}),
    ...(raw.divergenceEventId !== undefined ? { divergenceEventId: raw.divergenceEventId as string | null } : {}),
    ...(isNumber(raw.createdAt) ? { createdAt: raw.createdAt } : {}),
    ...(isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
    ...(ifOrigin !== undefined ? { ifOrigin } : {}),
  };
}

/**
 * R4-03：校验 IF 谱系。形状不对返回 null（调用方按「无谱系」处理，绝不抛异常）。
 * 缺字段按最保守的「未知」填：锚点时间非数字一律视为 0，变体序号非法视为 1。
 */
export function parseIFOrigin(raw: unknown): IFOrigin | null {
  if (!isObject(raw)) return null;
  if (!isString(raw.rootStoryId) || raw.rootStoryId.length === 0) return null;
  if (!isString(raw.sourceStoryId) || raw.sourceStoryId.length === 0) return null;
  const anchorEventId = raw.anchorEventId === null || raw.anchorEventId === undefined
    ? null
    : (isString(raw.anchorEventId) ? raw.anchorEventId : null);
  if (raw.anchorEventId !== null && raw.anchorEventId !== undefined && !isString(raw.anchorEventId)) return null;
  const anchorStep = raw.anchorStep === null || raw.anchorStep === undefined
    ? null
    : (isNumber(raw.anchorStep) && raw.anchorStep >= 0 ? raw.anchorStep : null);
  if (raw.anchorStep !== null && raw.anchorStep !== undefined && (!isNumber(raw.anchorStep) || raw.anchorStep < 0)) return null;
  if (!isNumber(raw.anchorAt)) return null;
  const viewpointCharacterId = raw.viewpointCharacterId === null || raw.viewpointCharacterId === undefined
    ? null
    : (isString(raw.viewpointCharacterId) ? raw.viewpointCharacterId : null);
  if (raw.viewpointCharacterId !== null && raw.viewpointCharacterId !== undefined && !isString(raw.viewpointCharacterId)) return null;
  const variant = isNumber(raw.variant) && Number.isInteger(raw.variant) && raw.variant >= 1 ? raw.variant : 1;
  if (raw.variant !== undefined && (!isNumber(raw.variant) || !Number.isInteger(raw.variant) || raw.variant < 1)) return null;
  if (raw.label !== undefined && raw.label !== null && !isString(raw.label)) return null;
  if (raw.approx !== undefined && typeof raw.approx !== "boolean") return null;
  return {
    rootStoryId: raw.rootStoryId,
    sourceStoryId: raw.sourceStoryId,
    anchorEventId,
    anchorStep,
    anchorAt: raw.anchorAt,
    viewpointCharacterId,
    variant,
    ...(isString(raw.label) ? { label: raw.label } : {}),
    ...(typeof raw.approx === "boolean" ? { approx: raw.approx } : {}),
  };
}

// ===========================================================================
// R4-04：酒馆式扮演会话（RoleplaySession）
// ---------------------------------------------------------------------------
// 「扮演」不是「点击就切断并新建 IF」。从阅读段落开启的会话：
//   - 只是一条**可持久化的聊天记录 + 待审阅草稿**，不新增故事线、不推进世界时间；
//   - 一次用户发送至多一次 AI 请求；回复先是草稿，用户逐项采用后才写世界；
//   - 上下文有硬边界（见 lib/world-roleplay.ts 的 compileRoleplayContext）：
//     锚点后的正史、兄弟 IF、未采用草稿、他人私有记忆与任何密钥都不得进入。
// 用户确认「保存为 IF」后，会话的 targetStoryId 才指向一条真正的 IF 线。
// ===========================================================================

/** 输入方式：叙述指令（第三人称行动）/ 角色对白（台词）/ 观察或 OOC（不扮演、只提问）。 */
export type RoleplayInputMode = "narrative" | "dialogue" | "ooc";
export const ROLEPLAY_INPUT_MODES: RoleplayInputMode[] = ["narrative", "dialogue", "ooc"];

export const ROLEPLAY_INPUT_LABELS: Record<RoleplayInputMode, string> = {
  narrative: "叙述指令",
  dialogue: "角色对白",
  ooc: "观察 / OOC",
};

/** 会话入口：第三人称阅读 / 第一人称视觉小说 / 以某 NPC 为视角。三者共用同一会话。 */
export type RoleplayEntryMode = "reader" | "firstPerson" | "npc";
export const ROLEPLAY_ENTRY_MODES: RoleplayEntryMode[] = ["reader", "firstPerson", "npc"];

export const ROLEPLAY_ENTRY_LABELS: Record<RoleplayEntryMode, string> = {
  reader: "第三人称阅读",
  firstPerson: "第一人称视觉小说",
  npc: "NPC 视角",
};

/** 草稿提出的一处世界变化建议（只是建议，采用后才写入）。 */
export type RoleplayChangeKind = "time" | "location" | "npc" | "memory" | "flag" | "note";
export const ROLEPLAY_CHANGE_KINDS: RoleplayChangeKind[] = ["time", "location", "npc", "memory", "flag", "note"];

export const ROLEPLAY_CHANGE_LABELS: Record<RoleplayChangeKind, string> = {
  time: "时间消耗",
  location: "地点变化",
  npc: "NPC 状态",
  memory: "记忆变化",
  flag: "世界标记",
  note: "叙事备注",
};

export interface RoleplayChange {
  kind: RoleplayChangeKind;
  /** 简短标题（变更卡上可见） */
  label: string;
  /** 人类可读说明 */
  detail: string;
  // --- 结构化载荷：有值才能被精确写入；缺失时该条只能作为「待作者确认的备注」---
  /** time：建议的时间消耗 */
  duration?: number | null;
  /** location：目标地点 id */
  pointId?: string | null;
  /** npc / memory：涉及的 characterId */
  characterId?: string | null;
  /** flag：世界标记名 */
  flag?: string | null;
}

/** 一条 AI 回复草稿：正文 + 可选选择 + 变更建议。**采用前不写世界。** */
export interface RoleplayDraft {
  narrative: string;
  choices: string[];
  /** 建议的时间消耗（世界时间单位）；只建议，不自动推进 */
  durationSuggestion: number | null;
  changes: RoleplayChange[];
  /** 本次引用的来源 id（事件 / 行动 / 记忆），供「本次载入了什么」摘要显示 */
  sourceIds: string[];
  raw: string;
}

export interface RoleplayMessage {
  id: string;
  role: "user" | "assistant";
  /** 该条消息的输入方式（assistant 沿用触发它的用户消息） */
  inputMode: RoleplayInputMode;
  text: string;
  at: number;
  /** 助手消息的草稿；用户消息为 null */
  draft?: RoleplayDraft | null;
  /** 已被用户采用写入世界的变更下标（assistant 消息才有意义） */
  appliedChangeIndexes?: number[];
  /** 采用时写入 / 继续的那条 IF 线 */
  savedStoryId?: string | null;
  /** 失败原因（网络 / 无连接 / 取消…）；成功为 null */
  error?: string | null;
  /** 本次请求实际使用的预设名与模型（只记名字，绝不记 endpoint / key） */
  presetName?: string | null;
  model?: string | null;
}

/** 本次上下文来源摘要：可见、可折叠，但绝不泄露私有条目全文或密钥。 */
export interface RoleplayContextSummary {
  /** 本次载入的世界书条目**名称**（不含正文） */
  worldBookTitles: string[];
  /** 本次载入的地区名 */
  regionName: string | null;
  /** 本次载入的地点名 */
  pointNames: string[];
  /** 本次载入的人物名 */
  characterNames: string[];
  /** 本次载入的记忆 id（只显示 id 与时间，不显示全文） */
  memoryIds: string[];
  /** 来自来源线、且被证明在锚点之前的行动 id（N1 投影结果） */
  keptActionIds: string[];
  /** 来自本 IF 已接受结果的行动 id */
  ownActionIds: string[];
  /** 被刻意排除的类别（人类可读），如「锚点后正史 3 条行动」 */
  excluded: string[];
  /** 起点无法精确重建（N1 投影为近似） */
  approx: boolean;
}

export interface RoleplaySession {
  id: string;
  /**
   * 幂等会话键：`rootStoryId | sourceStoryId | 锚点事件 | 锚点步骤 | 视角人物`。
   * 同一段落从任一阅读器反复进入，只恢复同一个会话。
   */
  sessionKey: string;
  /** 来源线（正史或某条 IF） */
  sourceStoryId: string;
  /** 分歧家族的根（来自 R4-03 的 rootStoryIdOf） */
  rootStoryId: string;
  /** 已「保存为 IF」后指向的线；仍是临时试玩时为 null */
  targetStoryId: string | null;
  anchorEventId: string | null;
  anchorStep: number | null;
  /** 锚点世界时间（上下文只取锚点以前的事实） */
  anchorAt: number;
  viewpointCharacterId: string | null;
  /** 开启会话的入口（三种入口共用同一会话，绝不因此新建第二条） */
  entryMode: RoleplayEntryMode;
  /** 当前输入框的输入方式 */
  inputMode: RoleplayInputMode;
  messages: RoleplayMessage[];
  /** 最近一次编译的上下文摘要（可见但不泄露全文 / 密钥） */
  contextSummary: RoleplayContextSummary | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * R4-04：校验一条扮演会话。形状不对返回 null。
 * 与本项目其他 parser 同一纪律：**不抛异常、不静默偷改**；
 * 消息里出现的未知字段一律丢弃，绝不留下半截数据结构。
 */
export function parseRoleplaySession(raw: unknown): RoleplaySession | null {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  const sessionKey = parseId(raw.sessionKey);
  if (!sessionKey) return null;
  const sourceStoryId = parseId(raw.sourceStoryId);
  if (!sourceStoryId) return null;
  const rootStoryId = parseId(raw.rootStoryId);
  if (!rootStoryId) return null;
  const targetStoryId = parseOptionalId(raw.targetStoryId);
  if (targetStoryId === false) return null;
  const anchorEventId = parseOptionalId(raw.anchorEventId);
  if (anchorEventId === false) return null;
  let anchorStep: number | null = null;
  if (raw.anchorStep !== null && raw.anchorStep !== undefined) {
    if (!isNumber(raw.anchorStep) || raw.anchorStep < 0) return null;
    anchorStep = raw.anchorStep;
  }
  if (!isNumber(raw.anchorAt)) return null;
  const viewpointCharacterId = parseOptionalId(raw.viewpointCharacterId);
  if (viewpointCharacterId === false) return null;
  const entryMode: RoleplayEntryMode = ROLEPLAY_ENTRY_MODES.includes(raw.entryMode as RoleplayEntryMode)
    ? (raw.entryMode as RoleplayEntryMode)
    : "reader";
  if (raw.entryMode !== undefined && !ROLEPLAY_ENTRY_MODES.includes(raw.entryMode as RoleplayEntryMode)) return null;
  const inputMode: RoleplayInputMode = ROLEPLAY_INPUT_MODES.includes(raw.inputMode as RoleplayInputMode)
    ? (raw.inputMode as RoleplayInputMode)
    : "narrative";
  if (raw.inputMode !== undefined && !ROLEPLAY_INPUT_MODES.includes(raw.inputMode as RoleplayInputMode)) return null;
  const messages = parseBoundedArray(raw.messages ?? [], W0_LIMITS.maxRoleplayMessages, parseRoleplayMessage);
  if (messages === null) return null;
  let contextSummary: RoleplayContextSummary | null = null;
  if (raw.contextSummary !== undefined && raw.contextSummary !== null) {
    contextSummary = parseRoleplayContextSummary(raw.contextSummary);
    if (contextSummary === null) return null;
  }
  if (!isNumber(raw.createdAt) || !isNumber(raw.updatedAt)) return null;
  return {
    id,
    sessionKey,
    sourceStoryId,
    rootStoryId,
    targetStoryId: targetStoryId ?? null,
    anchorEventId: anchorEventId ?? null,
    anchorStep,
    anchorAt: raw.anchorAt,
    viewpointCharacterId: viewpointCharacterId ?? null,
    entryMode,
    inputMode,
    messages,
    contextSummary,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function parseRoleplayMessage(raw: unknown): RoleplayMessage | null {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  if (raw.role !== "user" && raw.role !== "assistant") return null;
  const inputMode: RoleplayInputMode = ROLEPLAY_INPUT_MODES.includes(raw.inputMode as RoleplayInputMode)
    ? (raw.inputMode as RoleplayInputMode)
    : "narrative";
  if (raw.inputMode !== undefined && !ROLEPLAY_INPUT_MODES.includes(raw.inputMode as RoleplayInputMode)) return null;
  if (!isString(raw.text) || raw.text.length > W0_LIMITS.maxRoleplayMessageChars) return null;
  if (!isNumber(raw.at)) return null;
  let draft: RoleplayDraft | null = null;
  if (raw.draft !== undefined && raw.draft !== null) {
    draft = parseRoleplayDraft(raw.draft);
    if (draft === null) return null;
  }
  let appliedChangeIndexes: number[] | undefined;
  if (raw.appliedChangeIndexes !== undefined) {
    if (!Array.isArray(raw.appliedChangeIndexes)) return null;
    if (!raw.appliedChangeIndexes.every((n) => isNumber(n) && Number.isInteger(n) && n >= 0)) return null;
    appliedChangeIndexes = raw.appliedChangeIndexes as number[];
  }
  const savedStoryId = parseOptionalId(raw.savedStoryId);
  if (savedStoryId === false) return null;
  let error: string | null = null;
  if (raw.error !== undefined && raw.error !== null) {
    if (!isString(raw.error) || raw.error.length > W0_LIMITS.maxReasonLength) return null;
    error = raw.error;
  }
  if (raw.presetName !== undefined && raw.presetName !== null && !isString(raw.presetName)) return null;
  if (raw.model !== undefined && raw.model !== null && !isString(raw.model)) return null;
  return {
    id,
    role: raw.role,
    inputMode,
    text: raw.text,
    at: raw.at,
    ...(draft !== null ? { draft } : {}),
    ...(appliedChangeIndexes ? { appliedChangeIndexes } : {}),
    ...(savedStoryId !== undefined ? { savedStoryId } : {}),
    ...(error !== null ? { error } : {}),
    ...(isString(raw.presetName) ? { presetName: raw.presetName } : {}),
    ...(isString(raw.model) ? { model: raw.model } : {}),
  };
}

function parseRoleplayDraft(raw: unknown): RoleplayDraft | null {
  if (!isObject(raw)) return null;
  if (!isString(raw.narrative)) return null;
  if (!isBoundedStringList(raw.choices ?? [], W0_LIMITS.maxRoleplayChoices, 400)) return null;
  let durationSuggestion: number | null = null;
  if (raw.durationSuggestion !== undefined && raw.durationSuggestion !== null) {
    if (!isNumber(raw.durationSuggestion) || raw.durationSuggestion < 0) return null;
    durationSuggestion = raw.durationSuggestion;
  }
  const changes = parseBoundedArray(raw.changes ?? [], W0_LIMITS.maxRoleplayChanges, parseRoleplayChange);
  if (changes === null) return null;
  if (!isBoundedStringList(raw.sourceIds ?? [], 40, 120)) return null;
  return {
    narrative: raw.narrative,
    choices: (raw.choices as string[] | undefined) ?? [],
    durationSuggestion,
    changes,
    sourceIds: (raw.sourceIds as string[] | undefined) ?? [],
    raw: isString(raw.raw) ? raw.raw : raw.narrative,
  };
}

function parseRoleplayChange(raw: unknown): RoleplayChange | null {
  if (!isObject(raw)) return null;
  if (!ROLEPLAY_CHANGE_KINDS.includes(raw.kind as RoleplayChangeKind)) return null;
  if (!isString(raw.label) || raw.label.length === 0 || raw.label.length > W0_LIMITS.maxRoleplayChangeLabel) return null;
  if (!isString(raw.detail) || raw.detail.length > W0_LIMITS.maxRoleplayChangeDetail) return null;
  let duration: number | null = null;
  if (raw.duration !== undefined && raw.duration !== null) {
    if (!isNumber(raw.duration) || raw.duration < 0) return null;
    duration = raw.duration;
  }
  const pointId = parseOptionalId(raw.pointId);
  if (pointId === false) return null;
  const characterId = parseOptionalId(raw.characterId);
  if (characterId === false) return null;
  const flag = parseOptionalId(raw.flag);
  if (flag === false) return null;
  return {
    kind: raw.kind as RoleplayChangeKind,
    label: raw.label,
    detail: raw.detail,
    ...(duration !== null ? { duration } : {}),
    ...(pointId ? { pointId } : {}),
    ...(characterId ? { characterId } : {}),
    ...(flag ? { flag } : {}),
  };
}

function parseRoleplayContextSummary(raw: unknown): RoleplayContextSummary | null {
  if (!isObject(raw)) return null;
  const lists = ["worldBookTitles", "pointNames", "characterNames", "memoryIds", "keptActionIds", "ownActionIds", "excluded"] as const;
  for (const key of lists) {
    if (!isBoundedStringList(raw[key] ?? [], W0_LIMITS.maxRoleplayContextTitles, 300)) return null;
  }
  const regionName = raw.regionName === null || raw.regionName === undefined
    ? null
    : (isString(raw.regionName) ? raw.regionName : null);
  if (raw.regionName !== null && raw.regionName !== undefined && !isString(raw.regionName)) return null;
  if (raw.approx !== undefined && typeof raw.approx !== "boolean") return null;
  const pick = (key: (typeof lists)[number]): string[] => ((raw[key] as string[] | undefined) ?? []).slice();
  return {
    worldBookTitles: pick("worldBookTitles"),
    regionName,
    pointNames: pick("pointNames"),
    characterNames: pick("characterNames"),
    memoryIds: pick("memoryIds"),
    keptActionIds: pick("keptActionIds"),
    ownActionIds: pick("ownActionIds"),
    excluded: pick("excluded"),
    approx: raw.approx === true,
  };
}

// B5：校验 ReadingProgress 形状（storyId 必填非空 + step 非负；其余可选且须为合法枚举/正数）
export function parseReadingProgress(raw: unknown): ReadingProgress | null {
  if (!isObject(raw)) return null;
  if (!isString(raw.storyId) || raw.storyId.length === 0) return null;
  if (!isNumber(raw.step) || raw.step < 0) return null;
  if (raw.chapter !== undefined && raw.chapter !== null && (!isNumber(raw.chapter) || raw.chapter < 0)) return null;
  if (raw.presentationMode !== undefined && raw.presentationMode !== "visual" && raw.presentationMode !== "reader") return null;
  if (raw.fontSize !== undefined && (!isNumber(raw.fontSize) || raw.fontSize <= 0)) return null;
  return {
    storyId: raw.storyId,
    step: raw.step,
    ...(raw.chapter !== undefined ? { chapter: raw.chapter as number | null } : {}),
    ...(raw.presentationMode !== undefined ? { presentationMode: raw.presentationMode as PresentationMode } : {}),
    ...(isNumber(raw.fontSize) ? { fontSize: raw.fontSize } : {}),
  };
}

// ===========================================================================
// W0：严格 parser（无 React / 无 DOM，可在 node:test 中直接调用）
// 纪律：任何非法字段一律返回 null；绝不静默截断或补默认值造成「数据还在」的错觉。
// 旧世界没有这些字段时 parseWorld 不会调用这些 parser，因此照常解析。
// ===========================================================================

/** 非空字符串 id */
function parseId(v: unknown): string | null {
  return isString(v) && v.trim().length > 0 ? v : null;
}

/** 可选 id：字段不存在 → undefined；显式 null → null；非空串 → 该串；其余 → false（非法） */
function parseOptionalId(v: unknown): string | null | undefined | false {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return isString(v) && v.trim().length > 0 ? v : false;
}

/** 受限非空字符串列表 */
function isBoundedStringList(v: unknown, max: number, itemMax = 0): boolean {
  if (!Array.isArray(v) || v.length > max) return false;
  return v.every((x) => isString(x) && x.trim().length > 0 && (itemMax <= 0 || x.length <= itemMax));
}

/** 解析有上限的对象数组；任一项非法 → 整体 null（不静默丢弃坏条目） */
function parseBoundedArray<T>(raw: unknown, max: number, parse: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw) || raw.length > max) return null;
  const out: T[] = [];
  for (const item of raw) {
    const p = parse(item);
    if (p === null) return null;
    out.push(p);
  }
  return out;
}

/** 可选数组：字段不存在 → undefined；存在但非法 → null */
function parseOptionalArray<T>(raw: unknown, max: number, parse: (x: unknown) => T | null): T[] | undefined | null {
  if (raw === undefined) return undefined;
  return parseBoundedArray(raw, max, parse);
}

export const WORLD_ACTION_KINDS: WorldActionKind[] = ["move", "wait", "interact", "choice"];
export const WORLD_OUTCOME_KINDS: Array<WorldOutcome["kind"]> = ["nothing", "trigger"];
export const AGENT_CALL_STRATEGIES: AgentCallStrategy[] = ["manual", "ask-on-major", "ask-each-action"];

export function parseCharacterState(raw: unknown): CharacterState | null {
  if (!isObject(raw)) return null;
  const characterId = parseId(raw.characterId);
  if (!characterId) return null;
  // 当前地区：缺失视为 null（人物可无归属地区），但类型必须是字符串或 null
  const regionId = raw.currentRegionId === undefined ? null : raw.currentRegionId;
  if (regionId !== null && !isString(regionId)) return null;
  const pointId = parseOptionalId(raw.currentPointId);
  if (pointId === false) return null;
  if (raw.status !== undefined && (!isString(raw.status) || raw.status.length > W0_LIMITS.maxStatusLength)) return null;
  if (!isNumber(raw.updatedAt)) return null;
  // N2：分支作用域。缺失 = 正史基线；显式值必须是字符串或 null。
  const branchId = parseOptionalId(raw.branchId);
  if (branchId === false) return null;
  return {
    characterId,
    currentRegionId: regionId as string | null,
    ...(pointId !== undefined ? { currentPointId: pointId } : {}),
    ...(isString(raw.status) ? { status: raw.status } : {}),
    updatedAt: raw.updatedAt,
    ...(branchId !== undefined ? { branchId } : {}),
  };
}

export function parseCharacterMemory(raw: unknown): CharacterMemory | null {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  const characterId = parseId(raw.characterId);
  if (!characterId) return null;
  if (!isNumber(raw.at)) return null;
  if (!isString(raw.content) || raw.content.length === 0 || raw.content.length > W0_LIMITS.maxMemoryContent) return null;
  const regionId = parseOptionalId(raw.regionId);
  if (regionId === false) return null;
  const pointId = parseOptionalId(raw.pointId);
  if (pointId === false) return null;
  const eventId = parseOptionalId(raw.eventId);
  if (eventId === false) return null;
  if (raw.important !== undefined && typeof raw.important !== "boolean") return null;
  if (!isNumber(raw.createdAt)) return null;
  // W0-03：时间化记忆（关联行动 + 分支作用域）
  const actionId = parseOptionalId(raw.actionId);
  if (actionId === false) return null;
  const branchId = parseOptionalId(raw.branchId);
  if (branchId === false) return null;
  return {
    id,
    characterId,
    at: raw.at,
    content: raw.content,
    ...(regionId !== undefined ? { regionId } : {}),
    ...(pointId !== undefined ? { pointId } : {}),
    ...(eventId !== undefined ? { eventId } : {}),
    ...(typeof raw.important === "boolean" ? { important: raw.important } : {}),
    createdAt: raw.createdAt,
    ...(actionId !== undefined ? { actionId } : {}),
    ...(branchId !== undefined ? { branchId } : {}),
  };
}

export function parseWorldTriggerCondition(raw: unknown): WorldTriggerCondition | null {
  if (!isObject(raw)) return null;
  if (raw.minTime !== undefined && raw.minTime !== null && !isNumber(raw.minTime)) return null;
  if (raw.maxTime !== undefined && raw.maxTime !== null && !isNumber(raw.maxTime)) return null;
  const regionId = parseOptionalId(raw.regionId);
  if (regionId === false) return null;
  const pointId = parseOptionalId(raw.pointId);
  if (pointId === false) return null;
  if (raw.characterIds !== undefined && !isBoundedStringList(raw.characterIds, W0_LIMITS.maxCompanions)) return null;
  const requiresFlag = parseOptionalId(raw.requiresFlag);
  if (requiresFlag === false) return null;
  const forbidsFlag = parseOptionalId(raw.forbidsFlag);
  if (forbidsFlag === false) return null;
  return {
    ...(isNumber(raw.minTime) ? { minTime: raw.minTime } : {}),
    ...(isNumber(raw.maxTime) ? { maxTime: raw.maxTime } : {}),
    ...(regionId !== undefined ? { regionId } : {}),
    ...(pointId !== undefined ? { pointId } : {}),
    ...(Array.isArray(raw.characterIds) ? { characterIds: raw.characterIds as string[] } : {}),
    ...(requiresFlag !== undefined ? { requiresFlag } : {}),
    ...(forbidsFlag !== undefined ? { forbidsFlag } : {}),
  };
}

export function parseWorldTrigger(raw: unknown): WorldTrigger | null {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  if (typeof raw.enabled !== "boolean") return null;
  if (!isString(raw.title) || raw.title.length === 0 || raw.title.length > W0_LIMITS.maxTriggerTitle) return null;
  if (raw.conditionSummary !== undefined && (!isString(raw.conditionSummary) || raw.conditionSummary.length > W0_LIMITS.maxTriggerSummary)) return null;
  let condition: WorldTriggerCondition | undefined;
  if (raw.condition !== undefined && raw.condition !== null) {
    condition = parseWorldTriggerCondition(raw.condition) ?? undefined;
    if (!condition) return null;
  }
  if (raw.outcomeTemplate !== undefined && (!isString(raw.outcomeTemplate) || raw.outcomeTemplate.length > W0_LIMITS.maxOutcomeTemplate)) return null;
  if (raw.outcomeTags !== undefined && !isBoundedStringList(raw.outcomeTags, W0_LIMITS.maxOutcomeTags, W0_LIMITS.maxTagLength)) return null;
  if (raw.scopeRegionIds !== undefined && !isBoundedStringList(raw.scopeRegionIds, W0_LIMITS.maxTriggers)) return null;
  if (raw.scopePointIds !== undefined && !isBoundedStringList(raw.scopePointIds, W0_LIMITS.maxTriggers)) return null;
  if (raw.createdAt !== undefined && !isNumber(raw.createdAt)) return null;
  if (raw.updatedAt !== undefined && !isNumber(raw.updatedAt)) return null;
  return {
    id,
    enabled: raw.enabled,
    title: raw.title,
    ...(isString(raw.conditionSummary) ? { conditionSummary: raw.conditionSummary } : {}),
    ...(condition ? { condition } : {}),
    ...(isString(raw.outcomeTemplate) ? { outcomeTemplate: raw.outcomeTemplate } : {}),
    ...(Array.isArray(raw.outcomeTags) ? { outcomeTags: raw.outcomeTags as string[] } : {}),
    ...(Array.isArray(raw.scopeRegionIds) ? { scopeRegionIds: raw.scopeRegionIds as string[] } : {}),
    ...(Array.isArray(raw.scopePointIds) ? { scopePointIds: raw.scopePointIds as string[] } : {}),
    ...(isNumber(raw.createdAt) ? { createdAt: raw.createdAt } : {}),
    ...(isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
  };
}

export function parseStoryRuntime(raw: unknown): StoryRuntime | null {
  if (!isObject(raw)) return null;
  const storyId = parseId(raw.storyId);
  if (!storyId) return null;
  if (!isNumber(raw.currentTime)) return null;
  const regionId = raw.currentRegionId === undefined ? null : raw.currentRegionId;
  if (regionId !== null && !isString(regionId)) return null;
  const pointId = parseOptionalId(raw.currentPointId);
  if (pointId === false) return null;
  if (raw.companions !== undefined && !isBoundedStringList(raw.companions, W0_LIMITS.maxCompanions)) return null;
  if (raw.worldFlags !== undefined && !isBoundedStringList(raw.worldFlags, W0_LIMITS.maxWorldFlags, W0_LIMITS.maxFlagLength)) return null;
  if (raw.actionLog !== undefined && !isBoundedStringList(raw.actionLog, W0_LIMITS.maxActions)) return null;
  const snapshotFrom = parseOptionalId(raw.snapshotFrom);
  if (snapshotFrom === false) return null;
  if (raw.updatedAt !== undefined && !isNumber(raw.updatedAt)) return null;
  return {
    storyId,
    currentTime: raw.currentTime,
    currentRegionId: regionId as string | null,
    ...(pointId !== undefined ? { currentPointId: pointId } : {}),
    ...(Array.isArray(raw.companions) ? { companions: raw.companions as string[] } : {}),
    ...(Array.isArray(raw.worldFlags) ? { worldFlags: raw.worldFlags as string[] } : {}),
    ...(Array.isArray(raw.actionLog) ? { actionLog: raw.actionLog as string[] } : {}),
    ...(snapshotFrom !== undefined ? { snapshotFrom } : {}),
    ...(isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
  };
}

export function parseWorldActionSourceRef(raw: unknown): WorldActionSourceRef | null {
  if (!isObject(raw)) return null;
  const kind = raw.kind;
  if (kind !== "region" && kind !== "point" && kind !== "character" && kind !== "worldBook" && kind !== "trigger") return null;
  const id = parseId(raw.id);
  if (!id) return null;
  if (raw.label !== undefined && (!isString(raw.label) || raw.label.length > W0_LIMITS.maxSourceLabel)) return null;
  return { kind, id, ...(isString(raw.label) ? { label: raw.label } : {}) };
}

export function parseWorldAction(raw: unknown): WorldAction | null {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  if (!isNumber(raw.at)) return null;
  if (!isString(raw.kind) || !WORLD_ACTION_KINDS.includes(raw.kind as WorldActionKind)) return null;
  const actorId = parseOptionalId(raw.actorId);
  if (actorId === false) return null;
  const fromRegionId = parseOptionalId(raw.fromRegionId);
  if (fromRegionId === false) return null;
  const fromPointId = parseOptionalId(raw.fromPointId);
  if (fromPointId === false) return null;
  const toRegionId = parseOptionalId(raw.toRegionId);
  if (toRegionId === false) return null;
  const toPointId = parseOptionalId(raw.toPointId);
  if (toPointId === false) return null;
  if (raw.viaPointIds !== undefined && !isBoundedStringList(raw.viaPointIds, W0_LIMITS.maxViaPoints)) return null;
  if (raw.duration !== undefined && (!isNumber(raw.duration) || raw.duration < 0)) return null;
  let candidateSources: WorldActionSourceRef[] | undefined;
  if (raw.candidateSources !== undefined) {
    candidateSources = parseBoundedArray(raw.candidateSources, W0_LIMITS.maxCandidateSources, parseWorldActionSourceRef) ?? undefined;
    if (!candidateSources) return null;
  }
  if (raw.seed !== undefined && !isNumber(raw.seed)) return null;
  const outcomeId = parseOptionalId(raw.outcomeId);
  if (outcomeId === false) return null;
  // W0-01c：时长来源与基线 / 世界 Agent 版本（让日志可识别归因）
  if (raw.startedAt !== undefined && !isNumber(raw.startedAt)) return null;
  if (raw.endedAt !== undefined && !isNumber(raw.endedAt)) return null;
  if (raw.durationSource !== undefined) {
    if (!isString(raw.durationSource)) return null;
    if (!DURATION_SOURCES.includes(raw.durationSource as DurationSource)) return null;
  }
  if (raw.baselineVersion !== undefined && (!isString(raw.baselineVersion) || raw.baselineVersion.length === 0 || raw.baselineVersion.length > 40)) return null;
  const worldAgentRevision = parseOptionalId(raw.worldAgentRevision);
  if (worldAgentRevision === false) return null;
  const focusCardId = parseOptionalId(raw.focusCardId);
  if (focusCardId === false) return null;
  // N4：可编辑行动摘要（超出上限整条拒绝，与既有字段纪律一致）
  if (raw.summary !== undefined && (!isString(raw.summary) || raw.summary.length > W0_LIMITS.maxActionSummary)) return null;
  return {
    id,
    at: raw.at,
    kind: raw.kind as WorldActionKind,
    ...(actorId !== undefined ? { actorId } : {}),
    ...(fromRegionId !== undefined ? { fromRegionId } : {}),
    ...(fromPointId !== undefined ? { fromPointId } : {}),
    ...(toRegionId !== undefined ? { toRegionId } : {}),
    ...(toPointId !== undefined ? { toPointId } : {}),
    ...(Array.isArray(raw.viaPointIds) ? { viaPointIds: raw.viaPointIds as string[] } : {}),
    ...(isNumber(raw.duration) ? { duration: raw.duration } : {}),
    ...(candidateSources ? { candidateSources } : {}),
    ...(isNumber(raw.seed) ? { seed: raw.seed } : {}),
    ...(outcomeId !== undefined ? { outcomeId } : {}),
    ...(isNumber(raw.startedAt) ? { startedAt: raw.startedAt } : {}),
    ...(isNumber(raw.endedAt) ? { endedAt: raw.endedAt } : {}),
    ...(isString(raw.durationSource) ? { durationSource: raw.durationSource as DurationSource } : {}),
    ...(isString(raw.baselineVersion) ? { baselineVersion: raw.baselineVersion } : {}),
    ...(worldAgentRevision !== undefined ? { worldAgentRevision } : {}),
    ...(focusCardId !== undefined ? { focusCardId } : {}),
    ...(isString(raw.summary) ? { summary: raw.summary } : {}),
  };
}

export function parseWorldOutcome(raw: unknown): WorldOutcome | null {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  const actionId = parseId(raw.actionId);
  if (!actionId) return null;
  if (!isString(raw.kind) || !WORLD_OUTCOME_KINDS.includes(raw.kind as WorldOutcome["kind"])) return null;
  const triggerId = parseOptionalId(raw.triggerId);
  if (triggerId === false) return null;
  if (raw.result !== undefined && (!isString(raw.result) || raw.result.length > W0_LIMITS.maxOutcomeTemplate)) return null;
  if (raw.changeRefs !== undefined && !isBoundedStringList(raw.changeRefs, W0_LIMITS.maxChangeRefs)) return null;
  if (raw.reason !== undefined && (!isString(raw.reason) || raw.reason.length > W0_LIMITS.maxReasonLength)) return null;
  if (raw.seed !== undefined && !isNumber(raw.seed)) return null;
  if (raw.at !== undefined && !isNumber(raw.at)) return null;
  return {
    id,
    actionId,
    kind: raw.kind as WorldOutcome["kind"],
    ...(triggerId !== undefined ? { triggerId } : {}),
    ...(isString(raw.result) ? { result: raw.result } : {}),
    ...(Array.isArray(raw.changeRefs) ? { changeRefs: raw.changeRefs as string[] } : {}),
    ...(isString(raw.reason) ? { reason: raw.reason } : {}),
    ...(isNumber(raw.seed) ? { seed: raw.seed } : {}),
    ...(isNumber(raw.at) ? { at: raw.at } : {}),
  };
}

// === R5-01：定义修订与实体目录 parser ===

function parseEntityBaseline(baseline: unknown): Record<string, unknown> | null {
  if (!isObject(baseline)) return null;
  const keys = Object.keys(baseline);
  if (keys.length > W0_LIMITS.maxEntityBaselineFields) return null;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key.length === 0 || key.length > W0_LIMITS.maxEntityFieldKey) return null;
    const value = baseline[key];
    if (!(isString(value) || isNumber(value) || typeof value === "boolean" || (Array.isArray(value) && value.every(isString)))) return null;
    out[key] = value;
  }
  return out;
}

function parseEntityTemporalField(raw: unknown): EntityTemporalField | null {
  if (!isObject(raw)) return null;
  if (!isString(raw.key) || raw.key.length === 0 || raw.key.length > W0_LIMITS.maxEntityFieldKey) return null;
  if (!isString(raw.kind) || !ENTITY_FIELD_KINDS.includes(raw.kind as EntityFieldKind)) return null;
  if (!isString(raw.valueType) || !ENTITY_FIELD_VALUE_TYPES.includes(raw.valueType as EntityFieldValueType)) return null;
  const entersAI = raw.entersAI;
  const entersTimeline = raw.entersTimeline;
  const entersMap = raw.entersMap;
  if (entersAI !== undefined && typeof entersAI !== "boolean") return null;
  if (entersTimeline !== undefined && typeof entersTimeline !== "boolean") return null;
  if (entersMap !== undefined && typeof entersMap !== "boolean") return null;
  return {
    key: raw.key,
    kind: raw.kind as EntityFieldKind,
    valueType: raw.valueType as EntityFieldValueType,
    ...(typeof entersAI === "boolean" ? { entersAI } : {}),
    ...(typeof entersTimeline === "boolean" ? { entersTimeline } : {}),
    ...(typeof entersMap === "boolean" ? { entersMap } : {}),
  };
}

export function parseEntityRecord(raw: unknown): EntityRecord | null {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  const worldId = parseId(raw.worldId);
  if (!worldId) return null;
  if (!isString(raw.type) || raw.type.length === 0 || raw.type.length > W0_LIMITS.maxEntityTypeName) return null;
  if (!isString(raw.name) || raw.name.length === 0 || raw.name.length > W0_LIMITS.maxSourceLabel) return null;
  const baseline = parseEntityBaseline(raw.baseline);
  if (baseline === null) return null;
  if (!Array.isArray(raw.temporalSchema) || raw.temporalSchema.length > W0_LIMITS.maxEntityTemporalFields) return null;
  const schema: EntityTemporalField[] = [];
  const seen = new Set<string>();
  for (const item of raw.temporalSchema) {
    const field = parseEntityTemporalField(item);
    if (field === null) return null;
    if (seen.has(field.key)) return null;
    seen.add(field.key);
    schema.push(field);
  }
  // 基线字段必须已声明为 base / computed / private（temporal 的值只能来自账本）
  for (const key of Object.keys(baseline)) {
    const declared = schema.find((f) => f.key === key);
    if (!declared) return null;
    if (declared.kind === "temporal") return null;
  }
  let mapAnchor: EntityRecord["mapAnchor"];
  if (raw.mapAnchor !== undefined) {
    if (!isObject(raw.mapAnchor)) return null;
    const regionId = parseOptionalId(raw.mapAnchor.regionId);
    if (regionId === false) return null;
    const pointId = parseOptionalId(raw.mapAnchor.pointId);
    if (pointId === false) return null;
    const x = raw.mapAnchor.x;
    const y = raw.mapAnchor.y;
    if (x !== undefined && (!isNumber(x) || x < 0 || x > 100)) return null;
    if (y !== undefined && (!isNumber(y) || y < 0 || y > 100)) return null;
    mapAnchor = {
      ...(regionId !== undefined && regionId !== null ? { regionId } : {}),
      ...(pointId !== undefined && pointId !== null ? { pointId } : {}),
      ...(isNumber(x) ? { x } : {}),
      ...(isNumber(y) ? { y } : {}),
    };
  }
  if (raw.createdAt !== undefined && !isNumber(raw.createdAt)) return null;
  if (raw.updatedAt !== undefined && !isNumber(raw.updatedAt)) return null;
  if (raw.authorNote !== undefined && (!isString(raw.authorNote) || raw.authorNote.length > W0_LIMITS.maxRevisionNote)) return null;
  return {
    id,
    worldId,
    type: raw.type,
    name: raw.name,
    baseline,
    temporalSchema: schema,
    ...(mapAnchor !== undefined ? { mapAnchor } : {}),
    ...(isNumber(raw.createdAt) ? { createdAt: raw.createdAt } : {}),
    ...(isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
    ...(isString(raw.authorNote) ? { authorNote: raw.authorNote } : {}),
  };
}

export function parseDefinitionRevision(raw: unknown): DefinitionRevision | null {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  const worldId = parseId(raw.worldId);
  if (!worldId) return null;
  if (!isNumber(raw.createdAt)) return null;
  if (!isString(raw.authorNote) || raw.authorNote.length === 0 || raw.authorNote.length > W0_LIMITS.maxRevisionNote) return null;
  const refList = (value: unknown): string[] | null | undefined => {
    // 字段缺席 = 未声明（合法）；存在但非法才拒绝
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > W0_LIMITS.maxCandidateSources || !value.every(isString)) return null;
    return value;
  };
  const baseWorldbookRefs = refList(raw.baseWorldbookRefs);
  if (baseWorldbookRefs === null) return null;
  const mapRefs = refList(raw.mapRefs);
  if (mapRefs === null) return null;
  const ruleRefs = refList(raw.ruleRefs);
  if (ruleRefs === null) return null;
  const entityBaselineRefs = refList(raw.entityBaselineRefs);
  if (entityBaselineRefs === null) return null;
  const parentRevisionId = parseOptionalId(raw.parentRevisionId);
  if (parentRevisionId === false) return null;
  if (raw.isRetcon !== undefined && typeof raw.isRetcon !== "boolean") return null;
  // R5-RC-01：生效范围与不可变快照
  if (raw.effectiveAt !== undefined && (!isNumber(raw.effectiveAt) || raw.effectiveAt < 0)) return null;
  const effectiveBranchId = parseOptionalId(raw.effectiveBranchId);
  if (effectiveBranchId === false) return null;
  let snapshot: DefinitionSnapshot | undefined;
  if (raw.snapshot !== undefined) {
    if (!isObject(raw.snapshot)) return null;
    const worldBible = parseOptionalArray(raw.snapshot.worldBible, WORLD_BIBLE_MAX_ENTRIES, parseWorldBibleEntry);
    if (worldBible === null) return null;
    const regions = parseOptionalArray(raw.snapshot.regions, W0_LIMITS.maxCandidateSources, parseRegion);
    if (regions === null) return null;
    const points = parseOptionalArray(raw.snapshot.points, W0_LIMITS.maxCandidateSources, parseMapPoint);
    if (points === null) return null;
    const triggers = parseOptionalArray(raw.snapshot.triggers, W0_LIMITS.maxTriggers, parseWorldTrigger);
    if (triggers === null) return null;
    const entities = parseOptionalArray(raw.snapshot.entities, W0_LIMITS.maxEntityRecords, parseEntityRecord);
    if (entities === null) return null;
    const globalPrompt = raw.snapshot.globalPrompt;
    if (globalPrompt !== undefined && globalPrompt !== null && !isString(globalPrompt)) return null;
    if (!isString(raw.snapshot.contentHash) || raw.snapshot.contentHash.length === 0) return null;
    snapshot = {
      worldBible: worldBible ?? [],
      regions: regions ?? [],
      points: points ?? [],
      triggers: triggers ?? [],
      entities: entities ?? [],
      globalPrompt: globalPrompt ?? null,
      contentHash: raw.snapshot.contentHash,
    };
  }
  return {
    id,
    worldId,
    createdAt: raw.createdAt,
    authorNote: raw.authorNote,
    ...(baseWorldbookRefs ? { baseWorldbookRefs } : {}),
    ...(mapRefs ? { mapRefs } : {}),
    ...(ruleRefs ? { ruleRefs } : {}),
    ...(entityBaselineRefs ? { entityBaselineRefs } : {}),
    ...(parentRevisionId !== undefined ? { parentRevisionId } : {}),
    ...(typeof raw.isRetcon === "boolean" ? { isRetcon: raw.isRetcon } : {}),
    ...(isNumber(raw.effectiveAt) ? { effectiveAt: raw.effectiveAt } : {}),
    ...(effectiveBranchId !== undefined ? { effectiveBranchId } : {}),
    ...(snapshot ? { snapshot } : {}),
  };
}

// === R5-02：状态事件账本 parser ===

/**
 * 单个 effect 的形状解析（严格：形状不合法返回 null，绝不静默丢字段）。
 * PLAY-01 / A24-F02：预览校验必须与写入校验共用同一份形状规则——
 * 否则「预览可选、采用失败」会把作者带进假成功。
 */
export function parseStateEffect(raw: unknown): StateEffect | null {
  if (!isObject(raw)) return null;
  const entityId = parseOptionalId(raw.entityId);
  if (entityId === false) return null;
  // entityId 在需要实体的 effect 中必须存在（undefined/null 一律拒绝）
  const trim = (v: unknown, max: number): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length > 0 && t.length <= max ? t : null;
  };
  const parseValue = (v: unknown): string | number | boolean | string[] | null => {
    if (isString(v)) return v.slice(0, W0_LIMITS.maxMemoryContent);
    if (isNumber(v) || typeof v === "boolean") return v;
    if (Array.isArray(v) && v.every(isString) && v.length <= W0_LIMITS.maxTagLength) return v as string[];
    return null;
  };
  switch (raw.kind) {
    case "setTemporalField": {
      if (!entityId) return null;
      const key = trim(raw.key, W0_LIMITS.maxEntityFieldKey);
      if (!key) return null;
      const value = parseValue(raw.value);
      if (value === null) return null;
      return { kind: "setTemporalField", entityId, key, value };
    }
    case "moveEntity": {
      if (!entityId) return null;
      const regionId = parseOptionalId(raw.regionId);
      if (regionId === false) return null;
      const pointId = parseOptionalId(raw.pointId);
      if (pointId === false) return null;
      return {
        kind: "moveEntity", entityId,
        ...(regionId ? { regionId } : {}),
        ...(pointId ? { pointId } : {}),
      };
    }
    case "adjustRelation": {
      if (!entityId) return null;
      const targetEntityId = parseOptionalId(raw.targetEntityId);
      if (!targetEntityId) return null;
      const key = trim(raw.key, W0_LIMITS.maxEntityFieldKey);
      if (!key) return null;
      const value = raw.value;
      if (!isString(value) && !isNumber(value)) return null;
      return { kind: "adjustRelation", entityId, targetEntityId, key, value };
    }
    case "addTag":
    case "removeTag": {
      if (!entityId) return null;
      const tag = trim(raw.tag, W0_LIMITS.maxFlagLength);
      if (!tag) return null;
      return { kind: raw.kind as "addTag" | "removeTag", entityId, tag };
    }
    case "appendMemoryRef": {
      if (!entityId) return null;
      const memoryId = parseOptionalId(raw.memoryId);
      if (memoryId === false) return null;
      const text = raw.text !== undefined ? trim(raw.text, W0_LIMITS.maxMemoryContent) : undefined;
      if (raw.text !== undefined && !text) return null;
      return {
        kind: "appendMemoryRef", entityId,
        ...(memoryId ? { memoryId } : {}),
        ...(text ? { text } : {}),
      };
    }
    case "attachNarrativeEntry": {
      if (!entityId) return null;
      const text = trim(raw.text, W0_LIMITS.maxNarrativeEntry);
      if (!text) return null;
      return { kind: "attachNarrativeEntry", entityId, text };
    }
    case "closeNarrativeEntry": {
      if (!entityId) return null;
      const entryId = parseOptionalId(raw.entryId);
      if (!entryId) return null;
      return { kind: "closeNarrativeEntry", entityId, entryId };
    }
    case "setFlag": {
      const key = trim(raw.key, W0_LIMITS.maxFlagLength);
      if (!key) return null;
      const value = raw.value !== undefined ? trim(raw.value, W0_LIMITS.maxFlagLength) : undefined;
      if (raw.value !== undefined && !value) return null;
      return { kind: "setFlag", key, ...(value ? { value } : {}) };
    }
    default:
      return null;
  }
}

export function parseStateEvent(raw: unknown): StateEvent | null {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  const worldId = parseId(raw.worldId);
  if (!worldId) return null;
  const branchId = parseOptionalId(raw.branchId);
  if (branchId === false) return null;
  if (!isNumber(raw.at)) return null;
  if (!isNumber(raw.sequence) || raw.sequence < 0 || !Number.isInteger(raw.sequence)) return null;
  if (!isString(raw.source) || !STATE_EVENT_SOURCES.includes(raw.source as StateEventSource)) return null;
  const actionId = parseOptionalId(raw.actionId);
  if (actionId === false) return null;
  const sessionId = parseOptionalId(raw.sessionId);
  if (sessionId === false) return null;
  if (!isString(raw.narrativeSummary) || raw.narrativeSummary.length === 0 || raw.narrativeSummary.length > W0_LIMITS.maxStateEventSummary) return null;
  if (!Array.isArray(raw.entityRefs) || raw.entityRefs.length > W0_LIMITS.maxStateEntityRefs || !raw.entityRefs.every(isString)) return null;
  if (!Array.isArray(raw.effects) || raw.effects.length > W0_LIMITS.maxStateEventEffects) return null;
  const effects: StateEffect[] = [];
  for (const effect of raw.effects) {
    const parsedEffect = parseStateEffect(effect);
    if (parsedEffect === null) return null;
    effects.push(parsedEffect);
  }
  const reversesEventId = parseOptionalId(raw.reversesEventId);
  if (reversesEventId === false) return null;
  if (raw.createdAt !== undefined && !isNumber(raw.createdAt)) return null;
  return {
    id,
    worldId,
    // 正史线统一归一化为 null（缺失 = 正史）
    branchId: branchId ?? null,
    at: raw.at,
    sequence: raw.sequence,
    source: raw.source as StateEventSource,
    ...(actionId !== undefined ? { actionId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    narrativeSummary: raw.narrativeSummary,
    entityRefs: raw.entityRefs as string[],
    effects,
    ...(reversesEventId !== undefined ? { reversesEventId } : {}),
    ...(isNumber(raw.createdAt) ? { createdAt: raw.createdAt } : {}),
  };
}

function parseCheckpointSnapshot(raw: unknown): CheckpointSnapshot | null {
  if (!isObject(raw)) return null;
  const narrativeDict = (value: unknown): Record<string, Record<string, { text: string; closed: boolean }>> | null => {
    if (value === undefined) return {};
    if (!isObject(value)) return null;
    const out: Record<string, Record<string, { text: string; closed: boolean }>> = {};
    for (const key of Object.keys(value)) {
      const inner = value[key];
      if (!isObject(inner)) return null;
      const innerOut: Record<string, { text: string; closed: boolean }> = {};
      for (const innerKey of Object.keys(inner)) {
        const entry = inner[innerKey];
        if (!isObject(entry) || !isString(entry.text) || typeof entry.closed !== "boolean") return null;
        innerOut[innerKey] = { text: entry.text, closed: entry.closed };
      }
      out[key] = innerOut;
    }
    return out;
  };
  const strArrayDict = (value: unknown): Record<string, string[]> | null => {
    if (value === undefined) return {};
    if (!isObject(value)) return null;
    const out: Record<string, string[]> = {};
    for (const key of Object.keys(value)) {
      if (!Array.isArray(value[key]) || !value[key].every(isString)) return null;
      out[key] = value[key] as string[];
    }
    return out;
  };
  const valueDict = (value: unknown): Record<string, unknown> | null => {
    if (value === undefined) return {};
    if (!isObject(value)) return null;
    return value;
  };
  const flagDict = (value: unknown): Record<string, string | boolean> | null => {
    if (value === undefined) return {};
    if (!isObject(value)) return null;
    const out: Record<string, string | boolean> = {};
    for (const key of Object.keys(value)) {
      const v = value[key];
      if (!isString(v) && typeof v !== "boolean") return null;
      out[key] = v;
    }
    return out;
  };
  const entityStates = valueDict(raw.entityStates);
  if (entityStates === null) return null;
  const flags = flagDict(raw.flags);
  if (flags === null) return null;
  const memoryRefs = strArrayDict(raw.memoryRefs);
  if (memoryRefs === null) return null;
  const narrativeEntries = narrativeDict(raw.narrativeEntries);
  if (narrativeEntries === null) return null;
  if (!Array.isArray(raw.sourceChain) || !raw.sourceChain.every(isString)) return null;
  if (!isString(raw.stateHash) || raw.stateHash.length === 0) return null;
  return {
    entityStates: entityStates as CheckpointSnapshot["entityStates"],
    flags,
    memoryRefs,
    narrativeEntries,
    sourceChain: raw.sourceChain as string[],
    stateHash: raw.stateHash,
  };
}

/** A24-F04：游玩位置快照解析（整块缺失 → null，由调用方标记近似）。 */
export function parseCheckpointRuntime(raw: unknown): CheckpointRuntime | null {
  if (!isObject(raw)) return null;
  if (!isNumber(raw.currentTime)) return null;
  const currentRegionId = parseOptionalId(raw.currentRegionId);
  if (currentRegionId === false) return null;
  // currentPointId 允许为 null（该时刻没有可定位的地点）
  const currentPointId = raw.currentPointId === null || raw.currentPointId === undefined
    ? null
    : (typeof raw.currentPointId === "string" ? raw.currentPointId : String(raw.currentPointId));
  if (currentPointId !== null && typeof currentPointId !== "string") return null;
  if (!Array.isArray(raw.worldFlags) || !raw.worldFlags.every(isString)) return null;
  if (typeof raw.approx !== "boolean") return null;
  // PLAY-05：已播放行动指针（可选；非法条目整条丢弃该字段，不因此判整个检查点损坏）
  const actionLog = Array.isArray(raw.actionLog) && raw.actionLog.every(isString)
    ? raw.actionLog.slice(-W0_LIMITS.maxActions)
    : undefined;
  return {
    currentTime: raw.currentTime,
    currentRegionId: currentRegionId ?? null,
    currentPointId,
    worldFlags: raw.worldFlags.slice(0, W0_LIMITS.maxWorldFlags),
    approx: raw.approx,
    ...(actionLog ? { actionLog } : {}),
  };
}

export function parseWorldCheckpoint(raw: unknown): WorldCheckpoint | null {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  const worldId = parseId(raw.worldId);
  if (!worldId) return null;
  if (raw.name !== undefined && (!isString(raw.name) || raw.name.length > W0_LIMITS.maxCheckpointName)) return null;
  if (!isString(raw.kind) || !["technical", "author"].includes(raw.kind)) return null;
  if (!isString(raw.reason) || raw.reason.length === 0 || raw.reason.length > W0_LIMITS.maxCheckpointReason) return null;
  const branchId = parseOptionalId(raw.branchId);
  if (branchId === false) return null;
  if (!isNumber(raw.at)) return null;
  const ledgerHead = parseOptionalId(raw.ledgerHead);
  if (ledgerHead === false) return null;
  if (!isNumber(raw.ledgerCount) || raw.ledgerCount < 0) return null;
  const definitionRevisionId = parseOptionalId(raw.definitionRevisionId);
  if (definitionRevisionId === false) return null;
  const parentCheckpointId = parseOptionalId(raw.parentCheckpointId);
  if (parentCheckpointId === false) return null;
  const snapshot = parseCheckpointSnapshot(raw.snapshot);
  if (snapshot === null) return null;
  if (raw.createdAt !== undefined && !isNumber(raw.createdAt)) return null;
  // A24-F04：游玩位置快照可选；形状不合法直接判定整条检查点不可解析（绝不静默丢字段）
  if (raw.runtime !== undefined && raw.runtime !== null) {
    const runtime = parseCheckpointRuntime(raw.runtime);
    if (runtime === null) return null;
    return {
      id,
      worldId,
      ...(isString(raw.name) ? { name: raw.name } : {}),
      kind: raw.kind as WorldCheckpoint["kind"],
      reason: raw.reason,
      // 正史检查点统一归一化为 null（缺失 = 正史）
      branchId: branchId ?? null,
      at: raw.at,
      ledgerHead: ledgerHead ?? null,
      ledgerCount: raw.ledgerCount,
      ...(definitionRevisionId !== undefined ? { definitionRevisionId } : {}),
      ...(parentCheckpointId !== undefined ? { parentCheckpointId } : {}),
      runtime,
      snapshot,
      ...(isNumber(raw.createdAt) ? { createdAt: raw.createdAt } : {}),
    };
  }
  return {
    id,
    worldId,
    ...(isString(raw.name) ? { name: raw.name } : {}),
    kind: raw.kind as WorldCheckpoint["kind"],
    reason: raw.reason,
    // 正史检查点统一归一化为 null（缺失 = 正史）
    branchId: branchId ?? null,
    at: raw.at,
    ledgerHead: ledgerHead ?? null,
    ledgerCount: raw.ledgerCount,
    ...(definitionRevisionId !== undefined ? { definitionRevisionId } : {}),
    ...(parentCheckpointId !== undefined ? { parentCheckpointId } : {}),
    snapshot,
    ...(isNumber(raw.createdAt) ? { createdAt: raw.createdAt } : {}),
  };
}

export function parsePlayheadState(raw: unknown): PlayheadState | null {
  if (!isObject(raw)) return null;
  const branchId = parseOptionalId(raw.branchId);
  if (branchId === false) return null;
  if (!isNumber(raw.at)) return null;
  const checkpointId = parseOptionalId(raw.checkpointId);
  if (checkpointId === false) return null;
  if (raw.updatedAt !== undefined && !isNumber(raw.updatedAt)) return null;
  return {
    branchId: branchId ?? null,
    at: raw.at,
    ...(checkpointId !== undefined ? { checkpointId } : {}),
    ...(isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
  };
}

export function parseStoryAgentSession(raw: unknown): StoryAgentSession | null {
  if (!isObject(raw)) return null;
  const storyId = parseId(raw.storyId);
  if (!storyId) return null;
  const connectionId = parseOptionalId(raw.connectionId);
  if (connectionId === false) return null;
  if (raw.strategy !== undefined && !isString(raw.strategy)) return null;
  if (isString(raw.strategy) && !AGENT_CALL_STRATEGIES.includes(raw.strategy as AgentCallStrategy)) return null;
  if (raw.worldSummary !== undefined && (!isString(raw.worldSummary) || raw.worldSummary.length > W0_LIMITS.maxSessionSummary)) return null;
  if (raw.openThreads !== undefined && !isBoundedStringList(raw.openThreads, W0_LIMITS.maxOpenThreads, W0_LIMITS.maxThreadLength)) return null;
  if (raw.updatedAt !== undefined && !isNumber(raw.updatedAt)) return null;
  // W0-01b：叙事镜头 / 视角人物 / 知识范围 / 活动卡片会话
  if (raw.presentationMode !== undefined) {
    if (!isString(raw.presentationMode)) return null;
    if (!NARRATIVE_PRESENTATION_MODES.includes(raw.presentationMode as NarrativePresentationMode)) return null;
  }
  const viewpointCharacterId = parseOptionalId(raw.viewpointCharacterId);
  if (viewpointCharacterId === false) return null;
  if (raw.knowledgeScope !== undefined && (!isString(raw.knowledgeScope) || raw.knowledgeScope.length > W0_CARD_LIMITS.maxKnowledgeScope)) return null;
  if (raw.activeCardSessionIds !== undefined && !isBoundedStringList(raw.activeCardSessionIds, W0_CARD_LIMITS.maxActiveCardSessions)) return null;
  // W0-01c：引用世界 Agent 的固定 revision（故事 / IF 不复制世界 Agent）
  const worldAgentId = parseOptionalId(raw.worldAgentId);
  if (worldAgentId === false) return null;
  const worldAgentRevision = parseOptionalId(raw.worldAgentRevision);
  if (worldAgentRevision === false) return null;
  return {
    storyId,
    ...(connectionId !== undefined ? { connectionId } : {}),
    ...(isString(raw.strategy) ? { strategy: raw.strategy as AgentCallStrategy } : {}),
    ...(isString(raw.worldSummary) ? { worldSummary: raw.worldSummary } : {}),
    ...(Array.isArray(raw.openThreads) ? { openThreads: raw.openThreads as string[] } : {}),
    ...(isString(raw.presentationMode) ? { presentationMode: raw.presentationMode as NarrativePresentationMode } : {}),
    ...(viewpointCharacterId !== undefined ? { viewpointCharacterId } : {}),
    ...(isString(raw.knowledgeScope) ? { knowledgeScope: raw.knowledgeScope } : {}),
    ...(Array.isArray(raw.activeCardSessionIds) ? { activeCardSessionIds: raw.activeCardSessionIds as string[] } : {}),
    ...(worldAgentId !== undefined ? { worldAgentId } : {}),
    ...(worldAgentRevision !== undefined ? { worldAgentRevision } : {}),
    ...(isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
  };
}

export function parseCardSessionCheckpoint(raw: unknown): CardSessionCheckpoint | null {
  if (!isObject(raw)) return null;
  const actionId = parseOptionalId(raw.actionId);
  if (actionId === false) return null;
  if (raw.at !== undefined && raw.at !== null && !isNumber(raw.at)) return null;
  if (raw.summary !== undefined && (!isString(raw.summary) || raw.summary.length > W0_CARD_LIMITS.maxCheckpointSummary)) return null;
  if (raw.worldFlags !== undefined && !isBoundedStringList(raw.worldFlags, W0_CARD_LIMITS.maxCheckpointFlags, W0_LIMITS.maxFlagLength)) return null;
  return {
    ...(actionId !== undefined ? { actionId } : {}),
    ...(isNumber(raw.at) ? { at: raw.at } : {}),
    ...(isString(raw.summary) ? { summary: raw.summary } : {}),
    ...(Array.isArray(raw.worldFlags) ? { worldFlags: raw.worldFlags as string[] } : {}),
  };
}

export function parseCardAgentProfile(raw: unknown): CardAgentProfile | null {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  if (!isString(raw.cardType) || !CARD_TYPES.includes(raw.cardType as CardType)) return null;
  const sourceCardId = parseId(raw.sourceCardId);
  if (!sourceCardId) return null;
  if (typeof raw.enabled !== "boolean") return null;
  if (!isString(raw.participation) || !CARD_PARTICIPATIONS.includes(raw.participation as CardParticipation)) return null;
  if (raw.activeFrom !== undefined && raw.activeFrom !== null && !isNumber(raw.activeFrom)) return null;
  if (raw.activeTo !== undefined && raw.activeTo !== null && !isNumber(raw.activeTo)) return null;
  if (isNumber(raw.activeFrom) && isNumber(raw.activeTo) && raw.activeFrom > raw.activeTo) return null;
  if (raw.sourceRefs !== undefined && !isBoundedStringList(raw.sourceRefs, W0_CARD_LIMITS.maxSourceRefs)) return null;
  if (raw.roleConstraints !== undefined && (!isString(raw.roleConstraints) || raw.roleConstraints.length > W0_CARD_LIMITS.maxRoleConstraints)) return null;
  const defaultConnectionId = parseOptionalId(raw.defaultConnectionId);
  if (defaultConnectionId === false) return null;
  const sourceRevision = parseId(raw.sourceRevision);
  if (!sourceRevision) return null;
  if (raw.manuallyEdited !== undefined && !isBoundedStringList(raw.manuallyEdited, W0_CARD_LIMITS.maxManualEditedFields)) return null;
  if (raw.needsReview !== undefined && typeof raw.needsReview !== "boolean") return null;
  if (raw.summary !== undefined && (!isString(raw.summary) || raw.summary.length > W0_CARD_LIMITS.maxSummary)) return null;
  if (raw.createdAt !== undefined && !isNumber(raw.createdAt)) return null;
  if (raw.updatedAt !== undefined && !isNumber(raw.updatedAt)) return null;
  return {
    id,
    cardType: raw.cardType as CardType,
    sourceCardId,
    enabled: raw.enabled,
    participation: raw.participation as CardParticipation,
    ...(isNumber(raw.activeFrom) ? { activeFrom: raw.activeFrom } : {}),
    ...(isNumber(raw.activeTo) ? { activeTo: raw.activeTo } : {}),
    ...(Array.isArray(raw.sourceRefs) ? { sourceRefs: raw.sourceRefs as string[] } : {}),
    ...(isString(raw.roleConstraints) ? { roleConstraints: raw.roleConstraints } : {}),
    ...(defaultConnectionId !== undefined ? { defaultConnectionId } : {}),
    sourceRevision,
    ...(Array.isArray(raw.manuallyEdited) ? { manuallyEdited: raw.manuallyEdited as string[] } : {}),
    ...(typeof raw.needsReview === "boolean" ? { needsReview: raw.needsReview } : {}),
    ...(isString(raw.summary) ? { summary: raw.summary } : {}),
    ...(isNumber(raw.createdAt) ? { createdAt: raw.createdAt } : {}),
    ...(isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
  };
}

export function parseCardAgentSession(raw: unknown): CardAgentSession | null {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  const profileId = parseId(raw.profileId);
  if (!profileId) return null;
  const storyId = parseId(raw.storyId);
  if (!storyId) return null;
  const branchId = parseId(raw.branchId);
  if (!branchId) return null;
  if (!isString(raw.status) || !CARD_SESSION_STATUSES.includes(raw.status as CardSessionStatus)) return null;
  const startedAtActionId = parseOptionalId(raw.startedAtActionId);
  if (startedAtActionId === false) return null;
  if (raw.contextSummary !== undefined && (!isString(raw.contextSummary) || raw.contextSummary.length > W0_CARD_LIMITS.maxContextSummary)) return null;
  let checkpoint: CardSessionCheckpoint | null | undefined;
  if (raw.checkpoint !== undefined) {
    if (raw.checkpoint === null) checkpoint = null;
    else {
      checkpoint = parseCardSessionCheckpoint(raw.checkpoint) ?? undefined;
      if (checkpoint === undefined) return null;
    }
  }
  const sourceRevision = parseOptionalId(raw.sourceRevision);
  if (sourceRevision === false) return null;
  if (raw.lastUsedAt !== undefined && !isNumber(raw.lastUsedAt)) return null;
  if (raw.updatedAt !== undefined && !isNumber(raw.updatedAt)) return null;
  return {
    id,
    profileId,
    storyId,
    branchId,
    status: raw.status as CardSessionStatus,
    ...(startedAtActionId !== undefined ? { startedAtActionId } : {}),
    ...(isString(raw.contextSummary) ? { contextSummary: raw.contextSummary } : {}),
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
    ...(isNumber(raw.lastUsedAt) ? { lastUsedAt: raw.lastUsedAt } : {}),
    ...(isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
  };
}

export function parseStoryEntryAnchor(raw: unknown): StoryEntryAnchor | null {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  const sourceCardId = parseId(raw.sourceCardId);
  if (!sourceCardId) return null;
  if (!isString(raw.cardType) || !CARD_TYPES.includes(raw.cardType as CardType)) return null;
  const eventId = parseOptionalId(raw.eventId);
  if (eventId === false) return null;
  if (raw.at !== undefined && raw.at !== null && !isNumber(raw.at)) return null;
  const regionId = parseOptionalId(raw.regionId);
  if (regionId === false) return null;
  const pointId = parseOptionalId(raw.pointId);
  if (pointId === false) return null;
  if (raw.x !== undefined && raw.x !== null && !isNumber(raw.x)) return null;
  if (raw.y !== undefined && raw.y !== null && !isNumber(raw.y)) return null;
  if (!isString(raw.entryPolicy) || !ENTRY_POLICIES.includes(raw.entryPolicy as EntryPolicy)) return null;
  const snapshotRef = parseOptionalId(raw.snapshotRef);
  if (snapshotRef === false) return null;
  if (raw.invalid !== undefined && typeof raw.invalid !== "boolean") return null;
  if (raw.createdAt !== undefined && !isNumber(raw.createdAt)) return null;
  if (raw.completenessNote !== undefined && !isString(raw.completenessNote)) return null;
  return {
    id,
    sourceCardId,
    cardType: raw.cardType as CardType,
    ...(eventId !== undefined ? { eventId } : {}),
    ...(isNumber(raw.at) ? { at: raw.at } : {}),
    ...(regionId !== undefined ? { regionId } : {}),
    ...(pointId !== undefined ? { pointId } : {}),
    ...(isNumber(raw.x) ? { x: raw.x } : {}),
    ...(isNumber(raw.y) ? { y: raw.y } : {}),
    entryPolicy: raw.entryPolicy as EntryPolicy,
    ...(snapshotRef !== undefined ? { snapshotRef } : {}),
    ...(typeof raw.invalid === "boolean" ? { invalid: raw.invalid } : {}),
    ...(isNumber(raw.createdAt) ? { createdAt: raw.createdAt } : {}),
    ...(isString(raw.completenessNote) ? { completenessNote: raw.completenessNote } : {}),
  };
}

export function parseMapTravelSettings(raw: unknown): MapTravelSettings | null {
  if (!isObject(raw)) return null;
  if (typeof raw.enabled !== "boolean") return null;
  if (!isNumber(raw.distancePerCell) || raw.distancePerCell <= 0) return null;
  if (!isString(raw.distanceUnit) || raw.distanceUnit.length === 0 || raw.distanceUnit.length > W0_CARD_LIMITS.maxDistanceUnit) return null;
  if (!isNumber(raw.defaultSpeed) || raw.defaultSpeed <= 0) return null;
  if (raw.terrainFactors !== undefined) {
    if (!isObject(raw.terrainFactors)) return null;
    const entries = Object.entries(raw.terrainFactors);
    if (entries.length > W0_CARD_LIMITS.maxTerrainFactors) return null;
    for (const [key, value] of entries) {
      if (key.length === 0) return null;
      if (!isNumber(value) || value <= 0) return null;
    }
  }
  return {
    enabled: raw.enabled,
    distancePerCell: raw.distancePerCell,
    distanceUnit: raw.distanceUnit,
    defaultSpeed: raw.defaultSpeed,
    ...(isObject(raw.terrainFactors) ? { terrainFactors: raw.terrainFactors as Record<string, number> } : {}),
  };
}

export function parseDefaultTravelBaseline(raw: unknown): DefaultTravelBaseline | null {
  if (!isObject(raw)) return null;
  if (!isString(raw.version) || raw.version.length === 0 || raw.version.length > 40) return null;
  if (!isString(raw.distanceFormula) || raw.distanceFormula.length === 0 || raw.distanceFormula.length > W0_CARD_LIMITS.maxSummary) return null;
  if (!Array.isArray(raw.speedTiers) || raw.speedTiers.length === 0 || raw.speedTiers.length > 20) return null;
  const speedTiers: TravelBaselineSpeedTier[] = [];
  for (const t of raw.speedTiers) {
    if (!isObject(t)) return null;
    if (!isString(t.id) || t.id.length === 0) return null;
    if (!isString(t.label)) return null;
    if (!isNumber(t.cellsPerPeriod) || t.cellsPerPeriod <= 0) return null;
    speedTiers.push({ id: t.id, label: t.label, cellsPerPeriod: t.cellsPerPeriod });
  }
  if (!Array.isArray(raw.terrainTiers) || raw.terrainTiers.length === 0 || raw.terrainTiers.length > 20) return null;
  const terrainTiers: TravelBaselineTerrainTier[] = [];
  for (const t of raw.terrainTiers) {
    if (!isObject(t)) return null;
    if (!isString(t.id) || t.id.length === 0) return null;
    if (!isString(t.label)) return null;
    if (!isNumber(t.factor) || t.factor <= 0) return null;
    terrainTiers.push({ id: t.id, label: t.label, factor: t.factor });
  }
  if (!isString(raw.abstractRule) || raw.abstractRule.length === 0 || raw.abstractRule.length > W0_CARD_LIMITS.maxSummary) return null;
  if (!isString(raw.outputConstraint) || raw.outputConstraint.length === 0 || raw.outputConstraint.length > W0_CARD_LIMITS.maxSummary) return null;
  return {
    version: raw.version,
    distanceFormula: raw.distanceFormula,
    speedTiers,
    terrainTiers,
    abstractRule: raw.abstractRule,
    outputConstraint: raw.outputConstraint,
  };
}

export function parseWorldAgentTravelGuide(raw: unknown): WorldAgentTravelGuide | null {
  if (!isObject(raw)) return null;
  if (!isString(raw.content) || raw.content.length === 0 || raw.content.length > W0_CARD_LIMITS.maxSummary) return null;
  if (raw.sourceRefs !== undefined && !isBoundedStringList(raw.sourceRefs, W0_CARD_LIMITS.maxSourceRefs)) return null;
  if (raw.assumptions !== undefined && !isBoundedStringList(raw.assumptions, W0_CARD_LIMITS.maxSourceRefs)) return null;
  if (raw.updatedAt !== undefined && !isNumber(raw.updatedAt)) return null;
  return {
    content: raw.content,
    ...(Array.isArray(raw.sourceRefs) ? { sourceRefs: raw.sourceRefs as string[] } : {}),
    ...(Array.isArray(raw.assumptions) ? { assumptions: raw.assumptions as string[] } : {}),
    ...(isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
  };
}

export function parseWorldAgentProfile(raw: unknown): WorldAgentProfile | null {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  const worldId = parseId(raw.worldId);
  if (!worldId) return null;
  if (!isString(raw.status) || !WORLD_AGENT_STATUSES.includes(raw.status as WorldAgentStatus)) return null;
  if (!isString(raw.baselineVersion) || raw.baselineVersion.length === 0 || raw.baselineVersion.length > 40) return null;
  if (raw.sourceRefs !== undefined && !isBoundedStringList(raw.sourceRefs, W0_CARD_LIMITS.maxSourceRefs)) return null;
  if (raw.worldSummary !== undefined && (!isString(raw.worldSummary) || raw.worldSummary.length > W0_CARD_LIMITS.maxSummary)) return null;
  let travelGuide: WorldAgentTravelGuide | null | undefined;
  if (raw.travelGuide !== undefined) {
    if (raw.travelGuide === null) travelGuide = null;
    else {
      travelGuide = parseWorldAgentTravelGuide(raw.travelGuide) ?? undefined;
      if (travelGuide === undefined) return null;
    }
  }
  const sourceRevision = parseId(raw.sourceRevision);
  if (!sourceRevision) return null;
  if (raw.assumptions !== undefined && !isBoundedStringList(raw.assumptions, W0_CARD_LIMITS.maxSourceRefs)) return null;
  const connectionId = parseOptionalId(raw.connectionId);
  if (connectionId === false) return null;
  if (raw.createdAt !== undefined && !isNumber(raw.createdAt)) return null;
  if (raw.updatedAt !== undefined && !isNumber(raw.updatedAt)) return null;
  return {
    id,
    worldId,
    status: raw.status as WorldAgentStatus,
    baselineVersion: raw.baselineVersion,
    ...(Array.isArray(raw.sourceRefs) ? { sourceRefs: raw.sourceRefs as string[] } : {}),
    ...(isString(raw.worldSummary) ? { worldSummary: raw.worldSummary } : {}),
    ...(travelGuide !== undefined ? { travelGuide } : {}),
    sourceRevision,
    ...(Array.isArray(raw.assumptions) ? { assumptions: raw.assumptions as string[] } : {}),
    ...(connectionId !== undefined ? { connectionId } : {}),
    ...(isNumber(raw.createdAt) ? { createdAt: raw.createdAt } : {}),
    ...(isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
  };
}

/** W0 顶层数组字段的统一解析入口：字段不存在 → undefined；存在但非法 → null */
export function parseW0Collections(world: Record<string, unknown>): {
  characterStates?: CharacterState[];
  characterMemories?: CharacterMemory[];
  triggers?: WorldTrigger[];
  storyRuntimes?: StoryRuntime[];
  actions?: WorldAction[];
  outcomes?: WorldOutcome[];
  agentSessions?: StoryAgentSession[];
  cardProfiles?: CardAgentProfile[];
  cardSessions?: CardAgentSession[];
  entryAnchors?: StoryEntryAnchor[];
  travelSettings?: MapTravelSettings | null;
  worldAgent?: WorldAgentProfile | null;
  roleplaySessions?: RoleplaySession[];
} | null {
  const characterStates = parseOptionalArray(world.characterStates, W0_LIMITS.maxCharacterStates, parseCharacterState);
  if (characterStates === null) return null;
  const characterMemories = parseOptionalArray(world.characterMemories, W0_LIMITS.maxCharacterMemories, parseCharacterMemory);
  if (characterMemories === null) return null;
  const triggers = parseOptionalArray(world.triggers, W0_LIMITS.maxTriggers, parseWorldTrigger);
  if (triggers === null) return null;
  const storyRuntimes = parseOptionalArray(world.storyRuntimes, W0_LIMITS.maxStoryRuntimes, parseStoryRuntime);
  if (storyRuntimes === null) return null;
  const actions = parseOptionalArray(world.actions, W0_LIMITS.maxActions, parseWorldAction);
  if (actions === null) return null;
  const outcomes = parseOptionalArray(world.outcomes, W0_LIMITS.maxOutcomes, parseWorldOutcome);
  if (outcomes === null) return null;
  const agentSessions = parseOptionalArray(world.agentSessions, W0_LIMITS.maxAgentSessions, parseStoryAgentSession);
  if (agentSessions === null) return null;
  // R4-04：扮演会话（可选字段；存在则逐条严格校验，非法条目 → 整个世界拒绝）
  const roleplaySessions = parseOptionalArray(world.roleplaySessions, W0_LIMITS.maxRoleplaySessions, parseRoleplaySession);
  if (roleplaySessions === null) return null;
  // W0-01b：卡片 Agent、入口锚点与旅行设置
  const cardProfiles = parseOptionalArray(world.cardProfiles, W0_CARD_LIMITS.maxProfiles, parseCardAgentProfile);
  if (cardProfiles === null) return null;
  const cardSessions = parseOptionalArray(world.cardSessions, W0_CARD_LIMITS.maxSessions, parseCardAgentSession);
  if (cardSessions === null) return null;
  const entryAnchors = parseOptionalArray(world.entryAnchors, W0_CARD_LIMITS.maxAnchors, parseStoryEntryAnchor);
  if (entryAnchors === null) return null;
  // travelSettings 是单个对象而非数组：字段不存在 → undefined；显式 null 合法；存在但非法 → null
  let travelSettings: MapTravelSettings | null | undefined;
  if (world.travelSettings !== undefined) {
    if (world.travelSettings === null) travelSettings = null;
    else {
      travelSettings = parseMapTravelSettings(world.travelSettings) ?? undefined;
      if (travelSettings === undefined) return null;
    }
  }
  // W0-01c：世界 Agent 是**单值**字段（一个世界最多一份）；不存在 → undefined，
  // 显式 null 合法（已删除），存在但非法 → null（调用方会让整个 parseWorld 返回 null，
  // 从而由上层回退到默认基线，绝不保留半截 Agent 配置）。
  let worldAgent: WorldAgentProfile | null | undefined;
  if (world.worldAgent !== undefined) {
    if (world.worldAgent === null) worldAgent = null;
    else {
      worldAgent = parseWorldAgentProfile(world.worldAgent) ?? undefined;
      if (worldAgent === undefined) return null;
    }
  }
  // R5-01：定义修订与实体目录
  const definitionRevisions = parseOptionalArray(world.definitionRevisions, W0_LIMITS.maxDefinitionRevisions, parseDefinitionRevision);
  if (definitionRevisions === null) return null;
  const entityRecords = parseOptionalArray(world.entityRecords, W0_LIMITS.maxEntityRecords, parseEntityRecord);
  if (entityRecords === null) return null;
  // R5-02：状态事件账本
  const stateEvents = parseOptionalArray(world.stateEvents, W0_LIMITS.maxStateEvents, parseStateEvent);
  if (stateEvents === null) return null;
  // R5-04：检查点与游玩头
  const checkpoints = parseOptionalArray(world.checkpoints, W0_LIMITS.maxCheckpoints, parseWorldCheckpoint);
  if (checkpoints === null) return null;
  const playheads = parseOptionalArray(world.playheads, W0_LIMITS.maxStoryRuntimes, parsePlayheadState);
  if (playheads === null) return null;
  return {
    ...(characterStates !== undefined ? { characterStates } : {}),
    ...(characterMemories !== undefined ? { characterMemories } : {}),
    ...(triggers !== undefined ? { triggers } : {}),
    ...(storyRuntimes !== undefined ? { storyRuntimes } : {}),
    ...(actions !== undefined ? { actions } : {}),
    ...(outcomes !== undefined ? { outcomes } : {}),
    ...(agentSessions !== undefined ? { agentSessions } : {}),
    ...(roleplaySessions !== undefined ? { roleplaySessions } : {}),
    ...(cardProfiles !== undefined ? { cardProfiles } : {}),
    ...(cardSessions !== undefined ? { cardSessions } : {}),
    ...(entryAnchors !== undefined ? { entryAnchors } : {}),
    ...(travelSettings !== undefined ? { travelSettings } : {}),
    ...(worldAgent !== undefined ? { worldAgent } : {}),
    // R5-01/R5-02：定义修订、实体目录与状态事件账本（可选集合；非法条目 → 整个世界拒绝）
    ...(definitionRevisions !== undefined ? { definitionRevisions } : {}),
    ...(entityRecords !== undefined ? { entityRecords } : {}),
    ...(stateEvents !== undefined ? { stateEvents } : {}),
    ...(checkpoints !== undefined ? { checkpoints } : {}),
    ...(playheads !== undefined ? { playheads } : {}),
  };
}

export function loadWorld(worldId: string, storage: StorageLike): World | null {
  const raw = storage.getItem(worldStorageKey(worldId));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parseWorld(parsed);
  } catch {
    return null;
  }
}

export function saveWorld(world: World, storage: StorageLike): void {
  const validated = parseWorld(world);
  if (validated === null) {
    throw new Error(`saveWorld: invalid world ${JSON.stringify(world)}`);
  }
  storage.setItem(worldStorageKey(validated.id), JSON.stringify(validated));
}

export function deleteWorld(worldId: string, storage: StorageLike): void {
  storage.removeItem(worldStorageKey(worldId));
}

export function listWorldIds(storage: StorageLike): string[] {
  const ids: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key !== null && key.startsWith(WORLD_STORAGE_PREFIX)) {
      ids.push(key.slice(WORLD_STORAGE_PREFIX.length));
    }
  }
  return ids;
}

// === B1 v1：旧世界迁移 ===
// 旧世界（持久化数据无 regions 字段）需要补齐地区资料；模板无法识别时使用 Aurelia 兼容回退
// 同时清理 dangling 引用：currentRegionId / character.currentRegionId / point.regionId / events by region
// 如果 region 不在最终 regions 列表中，引用统一置 null（不删 entity，只清空引用）
//
// 入参 templateResolver：(name) => Region[] | null
//   - 用于按世界名称解析模板（如 name=Aurelia → 返回 3 个 Aurelia 地区）
//   - 不能识别时返回 null，走 Aurelia 兼容回退
//
// 纯函数：返回新 World（不修改原对象；不写 storage）
export function migrateLegacyWorld(
  world: World,
  templateResolver: (name: string) => Array<Omit<Region, "worldId">> | null
): World {
  // 1. 解析最终地区列表
  let resolvedRegions: Array<Omit<Region, "worldId">>;
  if (world.regions && world.regions.length > 0) {
    // 已有有效地区列表 → 保留
    resolvedRegions = world.regions;
  } else {
    // 无地区 → 按模板解析；不能识别时使用 Aurelia 兼容回退
    const fromTemplate = templateResolver(world.name);
    if (fromTemplate && fromTemplate.length > 0) {
      resolvedRegions = fromTemplate;
    } else {
      // Aurelia 兼容回退（3 地区 + 默认 tone）
      resolvedRegions = [
        { id: "north", name: "北境要塞", type: "mountain", description: "（B1 迁移：Aurelia 兼容回退）", coordinates: { x: 35, y: 24 }, subtitle: "北境", tone: "#b6d9d1" },
        { id: "capital", name: "星环王都", type: "city", description: "（B1 迁移：Aurelia 兼容回退）", coordinates: { x: 57, y: 48 }, subtitle: "王都", tone: "#e7c982" },
        { id: "isles", name: "潮汐群岛", type: "sea", description: "（B1 迁移：Aurelia 兼容回退）", coordinates: { x: 76, y: 72 }, subtitle: "群岛", tone: "#8bc0cc" },
      ];
    }
  }
  // 写入 worldId
  const finalRegions: Region[] = resolvedRegions.map((r) => ({ ...r, worldId: world.id }));
  const validRegionIds = new Set(finalRegions.map((r) => r.id));

  // 2. 清理 currentRegionId
  const cleanCurrentRegionId = world.currentRegionId && validRegionIds.has(world.currentRegionId) ? world.currentRegionId : null;

  // 3. 清理 characters 中 dangling currentRegionId
  const cleanCharacters = (world.characters ?? []).map((c) => ({
    ...c,
    currentRegionId: c.currentRegionId && validRegionIds.has(c.currentRegionId) ? c.currentRegionId : null,
  }));

  // 4. 清理 points 中 dangling regionId
  const cleanPoints = (world.points ?? []).map((p) => ({
    ...p,
    regionId: p.regionId && validRegionIds.has(p.regionId) ? p.regionId : (p.regionId === null ? null : undefined),
  }));

  // 5. 清理 events：删除指向不存在地区的 events 桶
  const cleanEvents: Record<string, UIEvent[]> = {};
  for (const [regionId, events] of Object.entries(world.events ?? {})) {
    if (validRegionIds.has(regionId)) {
      cleanEvents[regionId] = events;
    }
  }

  // 6. 返回迁移后世界（updatedAt 不变；调用方负责 saveWorld 写回）
  return {
    ...world,
    regions: finalRegions,
    currentRegionId: cleanCurrentRegionId,
    characters: cleanCharacters,
    points: cleanPoints,
    events: cleanEvents,
  };
}
// validation helpers
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// B3 v1：为事件补齐稳定 ID。新事件自带 uuid；旧数据（无 id）按 regionId+下标 派生确定性 id，
// 使旧 localStorage 数据无需写回即获得稳定身份（下标在该世界内事件增删时保持稳定，因为事件以 id 定位、删除不重排其余）。
export function normalizeEventIds(events: Record<string, UIEvent[]>): Record<string, UIEvent[]> {
  const out: Record<string, UIEvent[]> = {};
  for (const [regionId, list] of Object.entries(events)) {
    if (!Array.isArray(list)) continue;
    out[regionId] = list.map((e, i) =>
      e && typeof e.id === "string" && e.id.length > 0 ? e : { ...e, id: `${regionId}__${i}` }
    );
  }
  return out;
}

export function parseWorld(raw: unknown): World | null {
  if (!isObject(raw)) return null;
  // B3 v1：事件稳定 ID 归一化（旧数据无 id 时按 regionId+下标 派生确定性 id；新数据携带 uuid）
  const normalizedEvents = raw.events && isObject(raw.events)
    ? normalizeEventIds(raw.events as Record<string, UIEvent[]>)
    : undefined;
  if (raw.schemaVersion !== SCHEMA_VERSION) return null;
  if (!isString(raw.id) || raw.id.length === 0) return null;
  if (!isString(raw.name)) return null;
  if (!isString(raw.description)) return null;
  if (raw.currentRegionId !== null && !isString(raw.currentRegionId)) return null;
  if (!isNumber(raw.currentYear)) return null;
  if (!isNumber(raw.createdAt)) return null;
  if (raw.mapImage !== undefined && !isString(raw.mapImage)) return null;
  if (!isNumber(raw.updatedAt)) return null;
  if (raw.globalPrompt !== undefined && !isString(raw.globalPrompt)) return null;
  if (raw.worldBible !== undefined) {
    if (!Array.isArray(raw.worldBible) || raw.worldBible.length > WORLD_BIBLE_MAX_ENTRIES) return null;
    for (const entry of raw.worldBible) {
      if (parseWorldBibleEntry(entry) === null) return null;
    }
  }
  if (raw.events !== undefined && !isObject(raw.events)) return null;
  if (raw.characters !== undefined && !Array.isArray(raw.characters)) return null;
  // B1 v1：regions 字段（数组 + 每项用 parseRegion 校验；任何非法地区 → 返回 null）
  if (raw.regions !== undefined) {
    if (!Array.isArray(raw.regions)) return null;
    for (const r of raw.regions) {
      if (parseRegion(r) === null) return null;
    }
  }
  // B1 v1：points 数组项改用 parseMapPoint 校验（regionId 可选；旧无 regionId 视为未归属）
  if (raw.points !== undefined) {
    if (!Array.isArray(raw.points)) return null;
    for (const p of raw.points) {
      if (parseMapPoint(p) === null) return null;
    }
  }
  // B4：stories 数组项用 parseStory 校验（可选，向后兼容；旧世界无 stories 仍能 parse）
  if (raw.stories !== undefined) {
    if (!Array.isArray(raw.stories)) return null;
    for (const s of raw.stories) {
      if (parseStory(s) === null) return null;
    }
  }
  // B5：readingProgress 校验（可选，向后兼容；旧世界无此字段仍能 parse；null 合法）
  if (raw.readingProgress !== undefined) {
    if (raw.readingProgress === null) {
      // 保留显式 null（「未在读任何故事」也持久化）
    } else if (!isObject(raw.readingProgress)) {
      return null;
    } else if (parseReadingProgress(raw.readingProgress) === null) {
      return null;
    }
  }
  // W0：世界运转 / 人物状态 / 记忆 / 触发器 / 运行快照 / 行动与结果日志 / 会话 Agent。
  // 全部为可选字段：旧世界没有这些字段时 parseW0Collections 返回空对象，照常解析；
  // 一旦存在则逐项严格校验，任何非法条目 → 整个世界拒绝（不静默丢弃造成数据错觉）。
  const w0 = parseW0Collections(raw);
  if (w0 === null) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: raw.id,
    name: raw.name,
    description: raw.description,
    ...(Array.isArray(raw.connections) ? { connections: raw.connections as AIConnection[] } : {}),
    ...(isObject(raw.bindings) ? { bindings: raw.bindings as AIBindings } : {}),
    ...(Array.isArray(raw.points) ? { points: (raw.points as unknown[]).map((p) => parseMapPoint(p)!).filter((p): p is MapPoint => p !== null) } : {}),
    ...(normalizedEvents ? { events: normalizedEvents } : {}),
    ...(Array.isArray(raw.characters) ? { characters: raw.characters as Character[] } : {}),
    ...(Array.isArray(raw.regions) ? { regions: (raw.regions as unknown[]).map((r) => parseRegion(r)!).filter((r): r is Region => r !== null) } : {}),
    ...(Array.isArray(raw.stories) ? { stories: (raw.stories as unknown[]).map((s) => parseStory(s)!).filter((s): s is Story => s !== null) } : {}),
    ...(raw.readingProgress !== undefined ? { readingProgress: raw.readingProgress === null ? null : parseReadingProgress(raw.readingProgress) } : {}),
    ...(isString(raw.mapImage) ? { mapImage: raw.mapImage } : {}),
    ...(isString(raw.globalPrompt) ? { globalPrompt: raw.globalPrompt } : {}),
    ...(Array.isArray(raw.worldBible) ? { worldBible: (raw.worldBible as unknown[]).map((entry) => parseWorldBibleEntry(entry)!).filter((entry): entry is WorldBibleEntry => entry !== null) } : {}),
    ...(w0 ? w0 : {}),
    currentRegionId: raw.currentRegionId,
    currentYear: raw.currentYear,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

// === B7：故事治理纯函数（无 React；可在单测中直接调用，UI 层经其实现可追溯/引用完整性）===

// 返回某父线下的所有子 IF 线（parentStoryId === parentId）
export function childStoriesOf(stories: Story[], parentId: string): Story[] {
  return stories.filter((s) => s.parentStoryId === parentId);
}

// 返回包含某事件（任一步骤 eventId === eventId）的所有故事线
export function storiesContainingEvent(stories: Story[], eventId: string): Story[] {
  return stories.filter((s) => s.steps.some((st) => st.eventId === eventId));
}

// 删除某故事线的影响：其下子 IF 将变为孤儿（parentStoryId 悬空）
export interface StoryDeleteImpact {
  childCount: number;
  childTitles: string[];
}
export function computeDeleteStoryImpact(stories: Story[], storyId: string): StoryDeleteImpact {
  const children = childStoriesOf(stories, storyId);
  return { childCount: children.length, childTitles: children.map((c) => c.title) };
}

// 删除某事件的影响：引用该事件的故事线步骤将出现断点（findEventById 返回 null → UI 显「未知事件」）
export interface EventDeleteImpact {
  storyCount: number;
  storyTitles: string[];
}
export function computeDeleteEventImpact(stories: Story[], eventId: string): EventDeleteImpact {
  const refs = storiesContainingEvent(stories, eventId);
  return { storyCount: refs.length, storyTitles: refs.map((s) => s.title) };
}

// 改章节标题（按 id；空标题忽略）
export function updateChapterTitle(story: Story, chapterId: string, title: string): Story {
  const t = title.trim();
  if (!t) return story;
  return {
    ...story,
    chapters: (story.chapters ?? []).map((c) => (c.id === chapterId ? { ...c, title: t } : c)),
    updatedAt: Date.now(),
  };
}

// 章节重排：在按 fromStep 升序的列表中上/下移，并重排 fromStep 为相邻下标的互换值（保证稳定、可回放）
export function reorderChapter(story: Story, chapterId: string, dir: "up" | "down"): Story {
  const chapters = [...(story.chapters ?? [])].sort((a, b) => a.fromStep - b.fromStep);
  const idx = chapters.findIndex((c) => c.id === chapterId);
  if (idx < 0) return story;
  const swap = dir === "up" ? idx - 1 : idx + 1;
  if (swap < 0 || swap >= chapters.length) return story;
  const a = chapters[idx];
  const b = chapters[swap];
  const next = [...chapters];
  next[idx] = { ...b, fromStep: a.fromStep };
  next[swap] = { ...a, fromStep: b.fromStep };
  next.sort((x, y) => x.fromStep - y.fromStep);
  return { ...story, chapters: next, updatedAt: Date.now() };
}

// 改步骤备注（按步下标；空字符串清空 note，但保留 undefined 语义用空串表示已清空）
export function updateStepNote(story: Story, stepIndex: number, note: string): Story {
  if (stepIndex < 0 || stepIndex >= story.steps.length) return story;
  return {
    ...story,
    steps: story.steps.map((st, i) => (i === stepIndex ? { ...st, note } : st)),
    updatedAt: Date.now(),
  };
}

// 纯函数派生 IF 线（不修改入参；记录父线 + 分歧事件 + 该步 choice；可选注入 id 以便测试确定化）
export function pureForkStoryFromStep(
  stories: Story[],
  parentId: string,
  stepIndex: number,
  opts?: { choice?: string | null; title?: string; id?: string }
): Story | null {
  const parent = stories.find((s) => s.id === parentId);
  if (!parent) return null;
  const divergence = parent.steps[stepIndex];
  if (!divergence) return null;
  const id = opts?.id && opts.id.trim() ? opts.id.trim() : `story-${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2))}`;
  const choice = opts?.choice && opts.choice.trim() ? opts.choice.trim() : null;
  const steps: StoryStep[] = parent.steps.slice(0, stepIndex + 1).map((s, i) => ({
    ...s,
    ...(i === stepIndex && choice ? { choice } : {}),
  }));
  const chapters: StoryChapter[] = (parent.chapters ?? [])
    .filter((c) => c.fromStep <= stepIndex)
    .map((c) => ({ ...c }));
  return {
    id,
    worldId: parent.worldId,
    mode: "if",
    title: opts?.title && opts.title.trim() ? opts.title.trim() : `IF：${parent.title} @ ${divergence.eventId}`,
    steps,
    ...(chapters.length ? { chapters } : {}),
    parentStoryId: parent.id,
    divergenceEventId: divergence.eventId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ===========================================================================
// W0-01.3：引用完整性检查与 W0-01.4：深拷贝隔离（纯函数，无 React / 无 DOM）
// ---------------------------------------------------------------------------
// 纪律：
// - 悬空引用（指向已删除的人物 / 地点 / 故事 / 连接）统一清理或拒绝，
//   绝不静默写入坏数据，也绝不静默把失效连接换成「随便一个可用模型」。
// - currentPointId 必须指向存在的地点，且该地点归属地区要与人物 / 快照当前地区一致，
//   否则清空为 null（避免「人物卡显示在 A 区、世界工作台显示在 B 区」）。
// - 返回新的 World，不修改入参。
// ===========================================================================

/**
 * 清理 W0 数据中的悬空引用。只处理 W0 字段；地区 / 地点 / 人物 / 故事 / 事件
 * 之间的既有引用完整性由 migrateLegacyWorld 负责。
 */
export function normalizeWorldReferences(world: World): World {
  const regionIds = new Set((world.regions ?? []).map((r) => r.id));
  const pointById = new Map((world.points ?? []).map((p) => [String(p.id), p]));
  const characterIds = new Set((world.characters ?? []).map((c) => c.id));
  const storyIds = new Set((world.stories ?? []).map((s) => s.id));
  const triggerIds = new Set((world.triggers ?? []).map((t) => t.id));
  const actionIds = new Set((world.actions ?? []).map((a) => a.id));
  const connectionIds = new Set((world.connections ?? []).map((c) => c.id));
  const eventIds = new Set(
    Object.values(world.events ?? {})
      .flat()
      .map((e) => e.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  // 世界书条目 id（全局 + 地区 + 地点）
  const worldBookIds = new Set<string>();
  for (const e of world.worldBible ?? []) worldBookIds.add(e.id);
  for (const r of world.regions ?? []) for (const e of r.worldBook ?? []) worldBookIds.add(e.id);
  for (const p of world.points ?? []) for (const e of p.worldBook ?? []) worldBookIds.add(e.id);

  /** 地点必须存在，且其 regionId 与给定地区一致 */
  const pointMatchesRegion = (pointId: string, regionId: string | null): boolean => {
    const p = pointById.get(pointId);
    if (!p) return false;
    return (p.regionId ?? null) === regionId;
  };
  const safeRegion = (id: string | null | undefined): string | null =>
    id && regionIds.has(id) ? id : null;

  // 1. 人物动态状态：悬空人物 → 丢弃；地区 / 地点不一致 → 清空为 null
  const characterStates = (world.characterStates ?? [])
    .map((s): CharacterState | null => {
      if (!characterIds.has(s.characterId)) return null;
      const region = safeRegion(s.currentRegionId);
      let point: string | null = null;
      if (s.currentPointId && pointMatchesRegion(s.currentPointId, region)) point = s.currentPointId;
      // N2：分支引用失效时**回落到正史基线**（= null），绝不删除作者的位置状态。
      const branch = s.branchId && storyIds.has(s.branchId) ? s.branchId : null;
      return {
        ...s,
        currentRegionId: region,
        ...(s.currentPointId !== undefined ? { currentPointId: point } : {}),
        ...(s.branchId !== undefined || branch === null ? { branchId: branch } : {}),
      };
    })
    .filter((s): s is CharacterState => s !== null);

  // 2. 人物记忆：悬空人物 → 丢弃；关联对象不存在 → 置 null（保留记忆本身）
  const characterMemories = (world.characterMemories ?? [])
    .map((m): CharacterMemory | null => {
      if (!characterIds.has(m.characterId)) return null;
      const clean: CharacterMemory = { ...m };
      if (clean.regionId && !regionIds.has(clean.regionId)) clean.regionId = null;
      if (clean.pointId && !pointById.has(clean.pointId)) clean.pointId = null;
      if (clean.eventId && !eventIds.has(clean.eventId)) clean.eventId = null;
      // W0-03：清理悬空的行动与分支引用（记忆本身保留，绝不删除作者写过的正文）
      if (clean.actionId && !actionIds.has(clean.actionId)) clean.actionId = null;
      if (clean.branchId && !storyIds.has(clean.branchId)) clean.branchId = null;
      return clean;
    })
    .filter((m): m is CharacterMemory => m !== null);

  // 3. 触发器：清理条件与来源范围里的悬空 id
  const triggers = (world.triggers ?? []).map((t): WorldTrigger => {
    const clean: WorldTrigger = { ...t };
    if (clean.condition) {
      const cond: WorldTriggerCondition = { ...clean.condition };
      if (cond.regionId && !regionIds.has(cond.regionId)) cond.regionId = null;
      if (cond.pointId && !pointById.has(cond.pointId)) cond.pointId = null;
      if (cond.characterIds) cond.characterIds = cond.characterIds.filter((id) => characterIds.has(id));
      clean.condition = cond;
    }
    if (clean.scopeRegionIds) clean.scopeRegionIds = clean.scopeRegionIds.filter((id) => regionIds.has(id));
    if (clean.scopePointIds) clean.scopePointIds = clean.scopePointIds.filter((id) => pointById.has(id));
    return clean;
  });

  // 4. 故事运行快照：悬空故事 → 丢弃；地区 / 地点不一致 → 清空；同行者过滤
  const storyRuntimes = (world.storyRuntimes ?? [])
    .map((rt): StoryRuntime | null => {
      if (!storyIds.has(rt.storyId)) return null;
      const region = safeRegion(rt.currentRegionId);
      let point: string | null = null;
      if (rt.currentPointId && pointMatchesRegion(rt.currentPointId, region)) point = rt.currentPointId;
      const clean: StoryRuntime = {
        ...rt,
        currentRegionId: region,
        ...(rt.currentPointId !== undefined ? { currentPointId: point } : {}),
      };
      if (clean.companions) clean.companions = clean.companions.filter((id) => characterIds.has(id));
      return clean;
    })
    .filter((rt): rt is StoryRuntime => rt !== null);

  // 5. 行动日志：悬空发起者 / 起终点 → 置 null；途经点与候选来源过滤
  const sourceExists = (ref: WorldActionSourceRef): boolean => {
    if (ref.kind === "region") return regionIds.has(ref.id);
    if (ref.kind === "point") return pointById.has(ref.id);
    if (ref.kind === "character") return characterIds.has(ref.id);
    if (ref.kind === "trigger") return triggerIds.has(ref.id);
    return worldBookIds.has(ref.id);
  };
  const actions = (world.actions ?? []).map((a): WorldAction => {
    const clean: WorldAction = { ...a };
    if (clean.actorId && !characterIds.has(clean.actorId)) clean.actorId = null;
    if (clean.fromRegionId && !regionIds.has(clean.fromRegionId)) clean.fromRegionId = null;
    if (clean.toRegionId && !regionIds.has(clean.toRegionId)) clean.toRegionId = null;
    if (clean.fromPointId && !pointById.has(clean.fromPointId)) clean.fromPointId = null;
    if (clean.toPointId && !pointById.has(clean.toPointId)) clean.toPointId = null;
    if (clean.viaPointIds) clean.viaPointIds = clean.viaPointIds.filter((id) => pointById.has(id));
    if (clean.candidateSources) clean.candidateSources = clean.candidateSources.filter(sourceExists);
    return clean;
  });

  // 6. 结果日志：悬空行动 → 丢弃；悬空触发器 → 置 null
  const outcomes = (world.outcomes ?? [])
    .map((o): WorldOutcome | null => {
      if (!actionIds.has(o.actionId)) return null;
      const clean: WorldOutcome = { ...o };
      if (clean.triggerId && !triggerIds.has(clean.triggerId)) clean.triggerId = null;
      return clean;
    })
    .filter((o): o is WorldOutcome => o !== null);

  // 7. 会话 Agent：悬空故事 → 丢弃；连接被删除 → 置 null 标记失效，
  //    绝不静默换成「随便一个可用连接 / 未知模型」
  const agentSessions = (world.agentSessions ?? [])
    .map((s): StoryAgentSession | null => {
      if (!storyIds.has(s.storyId)) return null;
      const connection = s.connectionId && connectionIds.has(s.connectionId) ? s.connectionId : null;
      return { ...s, ...(s.connectionId !== undefined ? { connectionId: connection } : {}) };
    })
    .filter((s): s is StoryAgentSession => s !== null);

  // 8. R4-04 扮演会话：来源线消失 → 丢弃（没有可锚定的线）；
  //    已保存的 IF 被删除 → 退回「临时试玩」（targetStoryId 置 null，聊天记录保留）；
  //    视角人物被删除 → 置 null。绝不静默把会话挂到另一条线上。
  const roleplaySessions = (world.roleplaySessions ?? [])
    .map((s): RoleplaySession | null => {
      if (!storyIds.has(s.sourceStoryId)) return null;
      if (!storyIds.has(s.rootStoryId)) return null;
      const target = s.targetStoryId && storyIds.has(s.targetStoryId) ? s.targetStoryId : null;
      const viewpoint = s.viewpointCharacterId && characterIds.has(s.viewpointCharacterId) ? s.viewpointCharacterId : null;
      return {
        ...s,
        ...(s.targetStoryId !== undefined || target === null ? { targetStoryId: target } : {}),
        ...(s.viewpointCharacterId !== undefined || viewpoint === null ? { viewpointCharacterId: viewpoint } : {}),
      };
    })
    .filter((s): s is RoleplaySession => s !== null);

  // 只回写原本存在的字段，避免给旧世界凭空长出空数组
  return {
    ...world,
    ...(world.characterStates ? { characterStates } : {}),
    ...(world.characterMemories ? { characterMemories } : {}),
    ...(world.triggers ? { triggers } : {}),
    ...(world.storyRuntimes ? { storyRuntimes } : {}),
    ...(world.actions ? { actions } : {}),
    ...(world.outcomes ? { outcomes } : {}),
    ...(world.agentSessions ? { agentSessions } : {}),
    ...(world.roleplaySessions ? { roleplaySessions } : {}),
  };
}

// ===========================================================================
// W0-01.4：IF 运行快照深拷贝隔离
// 正史与不同 IF 绝不能共享可写对象；IF 从分歧时刻深拷贝状态，后续变更只写该 IF。
// ===========================================================================

/**
 * 安全深拷贝。循环引用 / 不可序列化（函数、Symbol）→ 返回 null 由调用方拒绝。
 * **绝不退化成浅拷贝**，否则会造成 IF 与正史串线。
 */
export function deepCloneJson<T>(value: T): T | null {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return null;
  }
}

/**
 * N2：解析某条故事线应写入 / 读取的**分支作用域**（人物动态位置的正史基线 / IF 覆盖）。
 *
 * 规则（旧世界零迁移成本）：
 * - 正史线（`mode === "canon"`）→ `null`，即**正史基线**；旧 world 的 `characterStates`
 *   没有 `branchId`，语义完全等价，不丢状态。
 * - IF（`mode === "if"`）→ 该 IF 的 story id，读写只落在自己的覆盖条目上。
 * - 找不到该故事时按 `null`（基线）处理，绝不猜测。
 */
export function branchScopeForStory(world: World, storyId: string | null | undefined): string | null {
  if (!storyId) return null;
  const story = (world.stories ?? []).find((s) => s.id === storyId);
  if (!story) return null;
  return story.mode === "if" ? story.id : null;
}

/**
 * N2：按分支读取某人物的动态状态。
 * - `branchId` 为 IF id 时：优先命中该 IF 的覆盖；没有覆盖则回落正史基线。
 * - `branchId` 为 null / 缺省时：只读正史基线。
 */
export function characterStateFor(
  world: World,
  characterId: string,
  branchId?: string | null,
): CharacterState | null {
  const states = world.characterStates ?? [];
  if (branchId) {
    const override = states.find((s) => s.characterId === characterId && s.branchId === branchId);
    if (override) return override;
  }
  return states.find((s) => s.characterId === characterId && !s.branchId) ?? null;
}

/**
 * N2：某分支的**合并人物位置视图**——正史基线 + 该 IF 的覆盖。
 * IF 里没有覆盖的人物直接显示基线位置；返回新数组，不修改入参。
 */
export function branchCharacterStates(
  world: World,
  branchId: string | null | undefined,
): CharacterState[] {
  const states = world.characterStates ?? [];
  const baselines = states.filter((s) => !s.branchId);
  if (!branchId) return baselines.map((s) => ({ ...s }));
  const overrides = new Map<string, CharacterState>();
  for (const s of states) {
    if (s.branchId === branchId) overrides.set(s.characterId, s);
  }
  // 覆盖**替换**同名基线条目，而不是追加（否则同一人物会在视图里出现两次，
  // 且「先命中基线」的调用方会读到正史位置而不是本 IF 的位置）。
  const merged = baselines.map((s) => {
    const override = overrides.get(s.characterId);
    if (!override) return { ...s };
    overrides.delete(s.characterId);
    return { ...override };
  });
  for (const override of overrides.values()) merged.push({ ...override });
  return merged;
}

/** 为 IF 深拷贝运行快照：新快照 storyId = targetStoryId，snapshotFrom 记为来源线。 */
export function cloneStoryRuntime(source: StoryRuntime, targetStoryId: string): StoryRuntime | null {
  if (!targetStoryId.trim()) return null;
  const cloned = deepCloneJson(source);
  if (cloned === null) return null;
  return { ...cloned, storyId: targetStoryId, snapshotFrom: source.storyId, updatedAt: Date.now() };
}

/** 为 IF 深拷贝会话摘要（会话本来就不存 API Key）。 */
export function cloneAgentSession(source: StoryAgentSession, targetStoryId: string): StoryAgentSession | null {
  if (!targetStoryId.trim()) return null;
  const cloned = deepCloneJson(source);
  if (cloned === null) return null;
  return { ...cloned, storyId: targetStoryId, updatedAt: Date.now() };
}

/**
 * 为一条新 IF 建立运行快照 + 会话副本。纯函数：返回新数组，不修改入参。
 * 源线没有快照 / 会话时只复制存在的那一个；两者都没有则原样返回。
 */
export function createIFRuntimeSnapshot(
  world: World,
  sourceStoryId: string,
  targetStoryId: string,
): { storyRuntimes: StoryRuntime[]; agentSessions: StoryAgentSession[] } | null {
  if (!targetStoryId.trim()) return null;
  const source = (world.storyRuntimes ?? []).find((r) => r.storyId === sourceStoryId);
  const sourceSession = (world.agentSessions ?? []).find((s) => s.storyId === sourceStoryId);
  const storyRuntimes: StoryRuntime[] = [...(world.storyRuntimes ?? [])];
  const agentSessions: StoryAgentSession[] = [...(world.agentSessions ?? [])];
  if (source) {
    const cloned = cloneStoryRuntime(source, targetStoryId);
    if (cloned === null) return null;
    storyRuntimes.push(cloned);
  }
  if (sourceSession) {
    const cloned = cloneAgentSession(sourceSession, targetStoryId);
    if (cloned === null) return null;
    agentSessions.push(cloned);
  }
  return { storyRuntimes, agentSessions };
}
