/**
 * P08 §14：玩家视图是**第三个作用域**，不是「作者视角关掉几个字」。
 *
 * 三层分离落到三个 scope 上：
 * - `player`：完整**已记录**世界 —— 秘密地点、隐藏房间、全部 NPC 都在；位置未知就显示未知。
 *   但没有内部独白 / 供应商正文 / 未提交候选，也不在正文贴「推测补全」「来源复核」徽标
 *   （技术出处与质量走诊断，见 `playerDetailPresentation`）。
 * - `author`：完整已记录世界 **加上** 机器内部字段与技术出处。
 * - `pov`：角色认知过滤。只给模型输入与角色决策用，**不再是 UI 里可切换的一个模式**。
 *
 * 为什么 player 与 author 必须分开：§14.9 要求「author/POV 的缓存、查询和 export scope 分开；
 * 不能共用一个缓存后只抹去名字」。抹字段可以，抹名字不行 —— 见 `cacheMayServe`。
 */

export type AtlasViewScope = 'player' | 'author' | 'pov';

export const VIEW_SCOPES: readonly AtlasViewScope[] = ['player', 'author', 'pov'];

/**
 * 归一化所有历史写法。**默认 player**：缺字段、空串、未知值一律落到玩家视图。
 * 理由（§14.5）：升级后不能因为旧偏好里残留一个值就把玩家按回半张地图。
 * 作者后台必须**显式**声明 `author`，绝不靠默认值进入。
 */
const SCOPE_ALIASES: Readonly<Record<string, AtlasViewScope>> = {
  player: 'player',
  author: 'author',
  pov: 'pov',
  // 旧客户端/旧设置里出现过的同义写法，统统当玩家视图。
  world: 'player',
  full: 'player',
  all: 'player',
  viewer: 'player',
  player_view: 'player',
};

export function resolveViewScope(requested: unknown): AtlasViewScope {
  const key = typeof requested === 'string' ? requested.trim().toLowerCase() : '';
  return SCOPE_ALIASES[key] ?? 'player';
}

/**
 * UI 偏好里的旧 `viewMode` 迁移。**永远不返回 `pov`**。
 *
 * 这条和 `resolveViewScope` 是两条入口，不能合并：请求体允许 `pov`（模型输入、角色决策
 * 仍然需要它），UI 偏好不允许 —— UI 上没有「主角所知」这个模式了（§14.4）。
 */
export function migrateViewModePreference(stored: unknown): 'player' | 'author' {
  return typeof stored === 'string' && stored.trim().toLowerCase() === 'author' ? 'author' : 'player';
}

/**
 * UI 状态 → 请求体 `viewMode`。**永远不产出 `pov`**（§14.5：旧 viewMode 不得污染正文 query）。
 * 服务端若按 `pov` 解释请求，玩家地图就会只剩主角走过的部分。
 */
export function toRequestViewMode(uiMode: unknown): 'player' | 'author' {
  return migrateViewModePreference(uiMode);
}

export function isAuthorScope(scope: unknown): boolean {
  return resolveViewScope(scope) === 'author';
}

export function isPovScope(scope: unknown): boolean {
  return resolveViewScope(scope) === 'pov';
}

/** 玩家与作者都看完整已记录世界；只有 pov 按主角认知裁剪（§14.1/§14.2）。 */
export function seesWholeRecordedWorld(scope: unknown): boolean {
  return resolveViewScope(scope) !== 'pov';
}

/**
 * 已记录的行动（`action_tendency`）对玩家可见 —— §14.6「NPC 当前位置与已记录行动可查看」。
 * 内部独白（`thought`）不属于「已记录行动」，只有作者可见。
 */
export function seesRecordedAction(scope: unknown): boolean {
  return seesWholeRecordedWorld(scope);
}

/** 内部独白只有作者可见。 */
export function seesInternalMonologue(scope: unknown): boolean {
  return isAuthorScope(scope);
}

/**
 * 模型输入的作用域收敛：**只有显式 author 才是 author，其余一律 pov**。
 *
 * 玩家界面放宽到全量，绝不能顺着把模型输入也放宽 —— 那是三层分离里最贵的一次事故。
 * 所有「拼提示词 / 选注入内容 / 生成角色决策上下文」的路径都要先过这一层。
 */
export function promptScopeOf(scope: unknown): 'pov' | 'author' {
  return isAuthorScope(scope) ? 'author' : 'pov';
}

export type ScopeDisclosure = {
  /** `characters.thought`：后台想法。 */
  internalMonologue: boolean;
  /** 供应商推理正文 / 原始响应 / 请求体。 */
  supplierProse: boolean;
  /** 未提交的候选操作与草稿。 */
  unsubmittedCandidates: boolean;
  /** 来源 basis、内容 hash、解析优先级等技术出处。 */
  technicalProvenance: boolean;
  /** 「推测补全」「来源复核」这类质量徽标。 */
  qualityBadges: boolean;
  /** `locations.existence_quality`（confirmed / inferred / hypothetical）。 */
  existenceQuality: boolean;
};

/** 一张表说清三个 scope 各能看到什么；视图层只读这张表，不再各自写分支。 */
export function scopeDisclosure(scope: unknown): ScopeDisclosure {
  const author = isAuthorScope(scope);
  return {
    internalMonologue: author,
    supplierProse: author,
    unsubmittedCandidates: author,
    technicalProvenance: author,
    qualityBadges: author,
    existenceQuality: author,
  };
}

/** 按表名列出**结构性**的作者字段；行级清洗用 `stripScopeFields`。 */
export const AUTHOR_ONLY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  characters: ['thought', 'importance_reason'],
  turns: ['attempts_json', 'receipt_json', 'decisions_json'],
};

/** 供应商正文的键名（可能出现在任何一行的 JSON 扩展里）。 */
export const SUPPLIER_PROSE_KEYS: readonly string[] = [
  'reasoning',
  'raw_reasoning',
  'reasoning_content',
  'provider_payload',
  'supplier_payload',
  'raw_response',
  'prompt',
  'completion',
  'logprobs',
];

/** 未提交候选的键名：§14.6 明确不许导出。 */
export const UNSUBMITTED_CANDIDATE_KEYS: readonly string[] = [
  'candidates',
  'pending_operations',
  'draft_operations',
  'staged_operations',
  'proposal',
];

const PROSE_KEY_SET = new Set<string>(SUPPLIER_PROSE_KEYS);
const CANDIDATE_KEY_SET = new Set<string>(UNSUBMITTED_CANDIDATE_KEYS);

/**
 * 行级清洗：非作者作用域去掉内部独白、供应商正文、未提交候选。
 * 作者作用域**原样返回同一个引用**，避免多一次无意义的拷贝。
 */
export function stripScopeFields<T extends Record<string, unknown>>(row: T, scope: unknown, table?: string): T {
  if (!row || isAuthorScope(scope)) return row;
  const structured = new Set<string>(table ? (AUTHOR_ONLY_COLUMNS[table] ?? []) : []);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (structured.has(key) || PROSE_KEY_SET.has(key) || CANDIDATE_KEY_SET.has(key)) continue;
    out[key] = value;
  }
  return out as T;
}

export type PlayerPositionQuality = 'exact' | 'approximate' | 'unknown';

export type PlayerPositionLabel = {
  text: string;
  quality: PlayerPositionQuality;
  /** 是否用「约」表达精度（§14.7）。 */
  approximate: boolean;
  /** 恒为 false：界面不伪造未知位置（§14.1）。 */
  fabricated: false;
};

type PositionLike = {
  kind?: string;
  precision?: string | null;
  locationId?: string | null;
  mapId?: string | null;
} | null | undefined;

/**
 * 位置文案的唯一出口。
 *
 * 关键纪律：`kind === 'unknown'` 时**即使调用方塞了 locationName 也不显示** ——
 * 名字来自别的路径（目录、缓存、上一帧），拿它填位置就是界面在伪造（§14.1）。
 */
export function playerPositionLabel(position: PositionLike, locationName?: string | null): PlayerPositionLabel {
  const kind = position?.kind ?? 'unknown';
  if (kind === 'unknown') return { text: '位置未知', quality: 'unknown', approximate: false, fabricated: false };
  if (kind === 'in_transit') return { text: '在途（未落地）', quality: 'approximate', approximate: true, fabricated: false };
  if (kind === 'at_location') {
    const name = typeof locationName === 'string' && locationName.trim() ? locationName.trim() : '某处';
    return { text: `约在 ${name}`, quality: 'approximate', approximate: true, fabricated: false };
  }
  if (kind === 'at_grid') {
    const precision = position?.precision ?? 'unknown';
    if (precision === 'exact') return { text: '图上精确位置', quality: 'exact', approximate: false, fabricated: false };
    if (precision === 'unknown') return { text: '位置未知', quality: 'unknown', approximate: false, fabricated: false };
    return { text: '图上约略位置', quality: 'approximate', approximate: true, fabricated: false };
  }
  return { text: '位置未知', quality: 'unknown', approximate: false, fabricated: false };
}

export type ScalePresentation = {
  text: string;
  approximate: boolean;
  diagnostics: Array<{ code: string; message: string }>;
};

/**
 * 尺度文案：玩家正文只用「约」，锁定过的才敢说确定（§14.7）。
 * 技术出处（哪一档解析出来的、hash 多少）不在这里，它走 `playerDetailPresentation` 的诊断。
 */
export function presentScaleLabel(input: { metersPerCell?: number | null; quality?: string | null }): ScalePresentation {
  const meters = input?.metersPerCell;
  if (typeof meters !== 'number' || !Number.isFinite(meters) || meters <= 0) {
    return {
      text: '尺度未知',
      approximate: true,
      diagnostics: [{ code: 'SCALE_UNKNOWN', message: '没有可用的米/格尺度，图上距离不具可比性。' }],
    };
  }
  const locked = input?.quality === 'confirmed' || input?.quality === 'locked';
  const rounded = Math.round(meters * 1000) / 1000;
  return {
    text: locked ? `每格 ${rounded} 米` : `约每格 ${rounded} 米`,
    approximate: !locked,
    diagnostics: [],
  };
}

export type PlayerDetailPresentation = {
  /** 玩家详情不贴质量徽标：恒为空数组（§14.7）。 */
  badges: string[];
  scale: string;
  diagnostics: Array<{ code: string; message: string; payload?: Record<string, unknown> }>;
};

/**
 * 详情面板的展示路由：把「出处 / 质量」从正文挪到诊断。
 *
 * 作者视图照样可以拿到徽标；玩家视图恒 `badges: []`，但**信息不丢** ——
 * 它落在 `diagnostics` 里，需要时仍然可查（§14.7 后半句）。
 */
export function playerDetailPresentation(input: {
  scope?: unknown;
  existenceQuality?: string | null;
  scale?: { metersPerCell?: number | null; quality?: string | null } | null;
  sourceBasis?: string | null;
}): PlayerDetailPresentation {
  const disclosure = scopeDisclosure(input?.scope);
  const diagnostics: PlayerDetailPresentation['diagnostics'] = [];
  const existenceQuality = typeof input?.existenceQuality === 'string' ? input.existenceQuality : null;
  if (existenceQuality === 'inferred' || existenceQuality === 'hypothetical') {
    diagnostics.push({
      code: existenceQuality === 'inferred' ? 'EXISTENCE_INFERRED' : 'EXISTENCE_HYPOTHETICAL',
      message: existenceQuality === 'inferred'
        ? '这条记录是按世界逻辑推测补全的，不是来源直接给出的。'
        : '这条记录是假设性存在，正文不把它当成已确认事实。',
      payload: { existenceQuality },
    });
  }
  const sourceBasis = typeof input?.sourceBasis === 'string' && input.sourceBasis.trim() ? input.sourceBasis.trim() : null;
  if (sourceBasis) {
    diagnostics.push({ code: 'SOURCE_BASIS', message: '来源出处只在诊断里显示。', payload: { basis: sourceBasis } });
  }
  const scale = presentScaleLabel(input?.scale ?? {});
  diagnostics.push(...scale.diagnostics);
  return {
    badges: disclosure.qualityBadges
      ? [...(existenceQuality ? [`existence:${existenceQuality}`] : []), ...(sourceBasis ? ['source:basis'] : [])]
      : [],
    scale: scale.text,
    diagnostics,
  };
}

export type MapGeometrySource = 'saved' | 'overview' | 'none';

export type MapGeometryResolution<T = unknown> = {
  geometry: T | null;
  source: MapGeometrySource;
  /** 无法证明属于本图时为 true；调用方照常使用，但要知道这份几何没被校验过。 */
  unverified: boolean;
  rejected: Array<{ code: string; message: string }>;
};

function documentMapId(doc: unknown): string | null {
  if (!doc || typeof doc !== 'object') return null;
  const record = doc as Record<string, unknown>;
  const layout = record.layout && typeof record.layout === 'object' ? (record.layout as Record<string, unknown>) : null;
  for (const candidate of [record.mapId, record.map_id, layout?.mapId]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * §14.8：未完成的图显示真实入口与工作状态，**不残留另一张图的几何**。
 *
 * 已保存帧按 mapId 取，但概览投影是按图现算的，两条路都可能把别的图的 layout 带过来
 * （尤其是「上一张图刚生成完、这张图还在排队」的时候）。这里按文档自报的 mapId 复核一次：
 * 自报的不是本图 → 整份几何拒收，退回 `none`，由界面显示「在建设 / 待生成」而不是画错图。
 */
export function resolveMapGeometrySource<T = unknown>(input: {
  mapId: string;
  saved?: T | null;
  overview?: T | null;
}): MapGeometryResolution<T> {
  const mapId = typeof input?.mapId === 'string' ? input.mapId.trim() : '';
  const rejected: Array<{ code: string; message: string }> = [];
  let unverified = false;
  const accept = (doc: T | null | undefined, source: MapGeometrySource): MapGeometryResolution<T> | null => {
    if (doc === null || doc === undefined) return null;
    const declared = documentMapId(doc);
    if (declared === null) { unverified = true; return { geometry: doc, source, unverified, rejected }; }
    if (mapId && declared !== mapId) {
      rejected.push({
        code: 'MAP_GEOMETRY_FOREIGN_MAP',
        message: `这份几何自报属于 ${declared}，不是当前图 ${mapId}；整份拒收，不画到别的图上。`,
      });
      return null;
    }
    return { geometry: doc, source, unverified, rejected };
  };
  return accept(input?.saved, 'saved') ?? accept(input?.overview, 'overview') ?? { geometry: null, source: 'none', unverified, rejected };
}

/** §14.8：打开、切图、搜索、收纳、换皮肤都不发模型请求。 */
export const PLAYER_ZERO_MODEL_ACTIONS: readonly string[] = [
  'open-map', 'switch-map', 'switch-page', 'open-detail', 'select-entity',
  'search', 'filter', 'collapse', 'expand', 'toggle-layer', 'pan', 'zoom', 'skin',
];

const ZERO_MODEL_ACTION_SET = new Set<string>(PLAYER_ZERO_MODEL_ACTIONS);

export type PlayerActionEffect = {
  action: string;
  /** 这条动作是否分类为「纯界面」；未分类不等于会发模型，只是没被登记。 */
  classified: boolean;
  sendsModel: boolean;
  modelCalls: number;
  reason: string;
};

export function playerActionEffect(action: unknown): PlayerActionEffect {
  const key = typeof action === 'string' ? action.trim() : '';
  if (ZERO_MODEL_ACTION_SET.has(key)) {
    return { action: key, classified: true, sendsModel: false, modelCalls: 0, reason: 'PLAYER_NAVIGATION_ONLY' };
  }
  return { action: key, classified: false, sendsModel: false, modelCalls: 0, reason: 'ACTION_UNCLASSIFIED' };
}

/** §14.8 的验收算法：点 N 次地图，模型调用总数必须是 0，且没有未登记的动作。 */
export function summarizePlayerActions(actions: readonly unknown[]): { actions: number; modelCalls: number; unclassified: string[] } {
  let modelCalls = 0;
  const unclassified: string[] = [];
  for (const action of actions ?? []) {
    const effect = playerActionEffect(action);
    modelCalls += effect.modelCalls;
    if (!effect.classified) unclassified.push(effect.action);
  }
  return { actions: (actions ?? []).length, modelCalls, unclassified };
}

/** §14.3：只读视图写不到这些表，也不产生事件。 */
export const PLAYER_READ_ONLY_TABLES: readonly string[] = [
  'knowledge', 'characters', 'locations', 'events', 'turns', 'journal', 'maps', 'routes', 'items',
];

const READ_ONLY_TABLE_SET = new Set<string>(PLAYER_READ_ONLY_TABLES);

/** 读路径一旦企图写这些表就是违规；返回被拒的表名单。 */
export function assertPlayerReadIsPure(writes: readonly string[]): string[] {
  return (writes ?? []).filter((table) => READ_ONLY_TABLE_SET.has(typeof table === 'string' ? table.trim() : ''));
}

/**
 * §14.9：作用域不能共用一个缓存后只抹名字。
 *
 * 键里带 `scope` 本身；`povId` 只在 pov 作用域参与（player/author 都是全量，与 POV 无关）。
 */
export function viewScopeKey(input: {
  scope: unknown;
  chatUid?: string | null;
  branchId?: string | null;
  revision?: number | null;
  povId?: string | null;
  filterHash?: string | null;
}): string {
  const scope = resolveViewScope(input?.scope);
  return JSON.stringify([
    scope,
    input?.chatUid ?? null,
    input?.branchId ?? null,
    input?.revision ?? null,
    scope === 'pov' ? (input?.povId ?? null) : null,
    input?.filterHash ?? null,
  ]);
}

/** 作者缓存**不能**直接服务玩家请求（哪怕只差一个 `thought` 字段）。 */
export function cacheMayServe(requested: unknown, cached: unknown): boolean {
  return resolveViewScope(requested) === resolveViewScope(cached);
}
