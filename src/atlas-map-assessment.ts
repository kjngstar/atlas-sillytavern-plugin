/**
 * atlas-map-assessment.ts — P14/R04 §21.1–21.2：地图完整性评估（MapAssessmentV1）。
 *
 * 这一项**不能**只做「已保存」文案：程序必须给出分别可核对的状态，UI 才有资格正确展示。
 * 本模块是纯函数：不读库、不写库、不发请求、不看图标数量猜。
 *
 * 硬规矩（逐条对应 §21.1/§21.2）：
 * - 保存状态只由**最终 ACK** 决定（`saveState` 是入参，不由本函数推断）。
 * - `sceneState='ready'` 只表示「有合法可展示场景」；本次重建失败但保留旧有效场景时
 *   是 `sceneState='ready' + requestState='failed' + matchesCurrentInputs=false` —— 既不能
 *   改口说「没有场景」，也不能说当前任务完成。
 * - `completeness='complete'` 只针对**本图当前可见展示责任**，不代表整个世界资料补全。
 * - `metricQuality` 与语义/结构完成分开：美观示意仍是 estimated/uncalibrated。
 * - 不把源文、内部目录或内部队列塞进评估结果。
 *
 * 期望/已表示的判定（§21.2）：
 * - 本图负责：直属成员（已按视角过滤）+ 允许的入口代理 + 该有位置表示的人物/物品 + 本图路线。
 * - 容器自身只由 selfArea / 单空间轮廓承担，**不**重复当普通子地点。
 * - 祖先与跨图实体不因为进了引用目录就必须被本图画出来。
 * - 装饰（路纹/林纹/水系纹/匿名 corridor/无 id 建筑）**永远不算**已经表示了真实地点。
 * - 一个 shape 加一个同 ID 标记只算一次。
 */

import { checkSceneDocument } from '../vendor/atlas-spatial/index.mjs';
import type { PlanIssue } from './atlas-world-contract.ts';

type Row = Record<string, unknown>;

export type MapAssessmentV1 = {
  version: 1;
  saveState: 'saved' | 'unsaved';
  requestState: 'idle' | 'pending' | 'running' | 'failed' | 'cancelled' | 'deferred';
  sceneState: 'missing' | 'ready' | 'unsupported' | 'invalid';
  matchesCurrentInputs: boolean;
  completeness: 'complete' | 'partial' | 'unknown';
  metricQuality: 'confirmed' | 'estimated' | 'uncalibrated';
  semanticState: 'consistent' | 'issues' | 'unknown';
  expectedIds: string[];
  renderedIds: string[];
  missingIds: string[];
  routeIssues: PlanIssue[];
  semanticIssues: PlanIssue[];
};

export type MapAssessmentLayoutKind = 'floor' | 'city' | 'overview';

export type MapAssessmentInput = {
  /** maps 行（用 frame_json / scale_quality）。 */
  map: Row;
  /**
   * **本视图实际下发的场景**（已按视角过滤）。
   *
   * §21.2 第 9 条：POV 必须在**计算之前**过滤 —— 所以评估用的场景必须是过滤后的那一份，
   * 不能回头读 `frame_json.atlasScene`（那是原始存档，里面还带着秘密成员）。
   * 省略该字段时才退回 frame 里的原始场景（只有作者路径可以这么用）。
   */
  scene?: Row | null;
  /** 本图容器地点（根图为 null）。 */
  container?: Row | null;
  /** 本图的绘图档案裁决：决定「这张图该负责什么」。 */
  profile: {
    layoutKind: MapAssessmentLayoutKind;
    unsupported?: ReadonlyArray<{ id: string; kind: string; reason: string }>;
  };
  /** 本图负责的直属地点（**已**按视角过滤：POV 已剔除隐藏；离场/在途已剔除）。 */
  members?: Row[];
  /** 允许的入口代理（祖先/跨图地点，仅显式许可时传入）。 */
  entranceProxies?: ReadonlyArray<{ id: string; kind?: string }>;
  /** 本图应有**点**表示的人物（已过滤：不含粗位置/在途/离场）。 */
  characters?: Row[];
  /** 本图应有**点**表示的物品（已过滤）。 */
  items?: Row[];
  /** 允许用**列表**表示的粗位置对象 id（粗定位名单）：列表表示也是合法表示。 */
  listIds?: ReadonlyArray<string>;
  /** 本图已登记的路线（已过滤）。 */
  routes?: Row[];
  /** 目录里已知的实体 id：用来判断 shape/pin/building 是不是真实地点。装饰与未知 id 不计。 */
  knownEntityIds?: Iterable<string>;
  /** 保存状态：**只**由最终 ACK 决定。 */
  saveState: 'saved' | 'unsaved';
  /** 显式覆盖场景状态（读取链已经判定 invalid/missing 时用，避免评估与下发状态打架）。 */
  sceneState?: MapAssessmentV1['sceneState'];
  /** 显式覆盖请求状态（如队列里 running / 作者取消）；不给则按 frame 里的待处理请求推断。 */
  requestState?: MapAssessmentV1['requestState'];
  /** 当前结构指纹（computeMapLayoutSignature）；与 frame 里保存的不一致 → matchesCurrentInputs=false。 */
  currentLayoutHash?: string | null;
  storedLayoutHash?: string | null;
};

const PLAIN = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const TEXT = (value: unknown): string => (typeof value === 'string' && value.length > 0 ? value : '');
const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].filter((id) => id.length > 0).sort();

function issue(code: string, path: string, message: string, severity: 'warning' | 'error' = 'warning', extra: Partial<PlanIssue> = {}): PlanIssue {
  return { code, path, message, severity, retryable: false, ...extra };
}

/** 装饰与匿名几何的显式名单：它们**永远**不算已经表示了真实地点。 */
const DECORATIVE_SCENE_KEYS = Object.freeze(['features', 'roads', 'segments', 'lamps', 'windows', 'bodies']);

/**
 * 从（已过滤的）场景里抽出**真实实体的已表示集合**。装饰不参与。
 */
function renderedEntityIds(scene: Row | null, known: ReadonlySet<string>): { entities: Set<string>; routeIds: Set<string>; selfIds: Set<string> } {
  const entities = new Set<string>();
  const routeIds = new Set<string>();
  const selfIds = new Set<string>();
  if (!scene) return { entities, routeIds, selfIds };
  const layout = PLAIN(scene.layout) ? (scene.layout as Row) : null;
  if (!layout) return { entities, routeIds, selfIds };
  const kind = TEXT(layout.kind);
  const add = (value: unknown): void => {
    const id = TEXT(value);
    // 只认目录里已知的实体：装饰纹理即便有 id 也不是真实地点。
    if (id && known.has(id)) entities.add(id);
  };
  const addAny = (value: unknown): void => {
    const id = TEXT(value);
    if (id) entities.add(id);
  };
  if (kind === 'overview') {
    for (const shape of Array.isArray(layout.shapes) ? (layout.shapes as Row[]) : []) add(shape?.id);
    for (const pin of Array.isArray(layout.pins) ? (layout.pins as Row[]) : []) add(pin?.id);
    for (const route of Array.isArray(layout.routes) ? (layout.routes as Row[]) : []) {
      const id = TEXT(route?.id);
      if (id) routeIds.add(id);
    }
    // P06：容器自身示意承担「本图自己的范围」，不是新地点。
    const selfArea = PLAIN(layout.selfArea) ? (layout.selfArea as Row) : null;
    const selfId = selfArea ? TEXT(selfArea.locationId) : '';
    if (selfId) selfIds.add(selfId);
  } else if (kind === 'floor') {
    for (const room of Array.isArray(layout.rooms) ? (layout.rooms as Row[]) : []) addAny(room?.id);
    const corridor = PLAIN(layout.corridor) ? (layout.corridor as Row) : null;
    // 程序几何 id 恒为 'corridor'：它不是地点；只有绑定了真实 entityId 才算被表示。
    const corridorEntity = corridor ? TEXT(corridor.entityId) : '';
    if (corridorEntity) addAny(corridorEntity);
    for (const actor of Array.isArray(layout.actors) ? (layout.actors as Row[]) : []) add(actor?.id);
    for (const item of Array.isArray(layout.items) ? (layout.items as Row[]) : []) add(item?.id);
    for (const group of Array.isArray(layout.groups) ? (layout.groups as Row[]) : []) {
      // 陈设是局部 ID，不是地点；登记的 itemId 才是真实物品。
      add(group?.itemId);
    }
  } else if (kind === 'city') {
    for (const district of Array.isArray(layout.districts) ? (layout.districts as Row[]) : []) add(district?.id);
    for (const building of Array.isArray(layout.buildings) ? (layout.buildings as Row[]) : []) add(building?.id);
  }
  void DECORATIVE_SCENE_KEYS;
  return { entities, routeIds, selfIds };
}

/** 场景是不是「有场景但与当前档案模板不匹配」：档案换了、旧 scene 还没重建。 */
function sceneKindMismatch(scene: Row | null, layoutKind: MapAssessmentLayoutKind): boolean {
  if (!scene) return false;
  const layout = PLAIN(scene.layout) ? (scene.layout as Row) : null;
  const kind = layout ? TEXT(layout.kind) : '';
  return kind !== '' && kind !== layoutKind;
}

export function assessMapCompleteness(input: MapAssessmentInput): MapAssessmentV1 {
  const map = input.map ?? {};
  const frame = PLAIN(map.frame_json) ? (map.frame_json as Row) : {};
  // §21.2 第 9 条：调用方给了「本视图实际下发的场景」就用它（POV 已在过滤之后）；
  // 只有完全没给这个键时才退回原始 frame 场景。
  const rawScene = Object.hasOwn(input, 'scene')
    ? (PLAIN(input.scene) ? (input.scene as Row) : null)
    : (PLAIN(frame.atlasScene) ? (frame.atlasScene as Row) : null);

  const checks = rawScene ? (checkSceneDocument(rawScene as never) as Array<{ code: string; path: string; message: string }>) : [];
  const sceneValid = rawScene !== null && checks.length === 0;

  const semanticIssues: PlanIssue[] = [];
  const routeIssues: PlanIssue[] = [];
  const path = `$.maps.${TEXT(map.id) || '?'}`;

  const sceneState: MapAssessmentV1['sceneState'] = input.sceneState ?? (rawScene === null
    ? 'missing'
    : !sceneValid
      ? 'invalid'
      : sceneKindMismatch(rawScene, input.profile.layoutKind)
        ? 'unsupported'
        : 'ready');

  // ① 请求状态：显式覆盖优先；否则按 frame 里的待处理请求推断（成功写回时会删掉该键）。
  const savedRequest = PLAIN(frame.atlasLayoutRequest) ? (frame.atlasLayoutRequest as Row) : null;
  const savedRequestStatus = savedRequest ? TEXT(savedRequest.status) || 'pending' : '';
  const requestState: MapAssessmentV1['requestState'] = input.requestState
    ?? (savedRequestStatus === 'failed' ? 'failed' : savedRequestStatus === 'pending' ? 'pending' : 'idle');

  // ② 期望集合：本图当前可见的展示责任。
  const known = new Set<string>(input.knownEntityIds ?? []);
  for (const row of input.members ?? []) {
    const id = TEXT(row?.id);
    if (id) known.add(id);
  }
  const containerId = input.container ? TEXT(input.container.id) : '';
  const expected = new Set<string>();
  for (const row of input.members ?? []) {
    const id = TEXT(row?.id);
    // 容器自身由 selfArea / 单空间轮廓承担，不重复当普通子地点。
    if (id && id !== containerId) expected.add(id);
  }
  for (const proxy of input.entranceProxies ?? []) {
    const id = TEXT(proxy?.id);
    if (id) expected.add(id);
  }
  for (const row of input.characters ?? []) {
    const id = TEXT(row?.id);
    if (id) expected.add(id);
  }
  for (const row of input.items ?? []) {
    const id = TEXT(row?.id);
    if (id) expected.add(id);
  }

  // ③ 已表示集合：过滤后的场景 + 合法的列表表示。
  const rendered = renderedEntityIds(sceneValid ? rawScene : null, known);
  for (const id of rendered.selfIds) if (id === containerId) rendered.entities.add(id);
  const listRepresented = new Set<string>((input.listIds ?? []).map((value) => TEXT(value)).filter((id) => id.length > 0));

  // ④ 路线单独验证：双端点、归属、有效几何。装饰线不算。
  const expectedRouteIds = new Set<string>();
  const layoutKind = input.profile.layoutKind;
  if (layoutKind === 'overview') {
    for (const row of input.routes ?? []) {
      const id = TEXT(row?.id);
      if (!id) continue;
      const from = TEXT(row?.from_location_id);
      const to = TEXT(row?.to_location_id);
      const unknownEndpoint = (from && !known.has(from)) || (to && !known.has(to));
      const geometry = row?.geometry ?? null;
      if (unknownEndpoint) {
        routeIssues.push(issue('MAP_ROUTE_ENDPOINT_UNKNOWN', `${path}.routes.${id}`, `路线 ${id} 的端点不在当前可见目录内：保留有效部分，不把它画成连接`, 'warning', { relatedIds: [from, to].filter((value) => value.length > 0) }));
        continue;
      }
      if (geometry === null || geometry === undefined) {
        routeIssues.push(issue('MAP_ROUTE_GEOMETRY_MISSING', `${path}.routes.${id}`, `路线 ${id} 没有可绘制几何：本轮只保留端点关系，不画假线`, 'warning', { relatedIds: [id] }));
        continue;
      }
      expectedRouteIds.add(id);
    }
  }
  for (const id of expectedRouteIds) expected.add(id);
  for (const id of rendered.routeIds) rendered.entities.add(id);

  // ⑤ 缺项：只在**有合法场景**时才敢说「少了什么」。没有场景是 unknown，不是 partial。
  const expectedIds = sortedUnique(expected);
  const renderedIds = sortedUnique([...rendered.entities, ...listRepresented]);
  const renderedSet = new Set(renderedIds);
  const missingIds = sceneState === 'missing' || sceneState === 'invalid'
    ? []
    : expectedIds.filter((id) => !renderedSet.has(id));

  // ⑥ 语义问题：档案表达不了的成员、场景与档案不匹配、指纹不一致 —— 都指向具体 id / 路径。
  for (const member of input.profile.unsupported ?? []) {
    const id = TEXT(member?.id);
    semanticIssues.push(issue(
      'MAP_MEMBER_UNSUPPORTED',
      `${path}.profile`,
      `成员 ${id}（${TEXT(member?.kind) || '未知类型'}）当前模板表达不了：${TEXT(member?.reason) || '保留实体与事实，不替换类型凑成功'}`,
      'warning',
      { relatedIds: id ? [id] : [] },
    ));
  }
  if (sceneState === 'unsupported') {
    semanticIssues.push(issue('MAP_SCENE_TEMPLATE_MISMATCH', `${path}.atlasScene.layout.kind`, `已保存场景的模板与当前档案（${layoutKind}）不一致：旧场景保留到新候选成功，不当作更新完成`, 'warning'));
  }
  const layoutContext = PLAIN(frame.atlasLayoutContext) ? (frame.atlasLayoutContext as Row) : null;
  const storedHash = input.storedLayoutHash ?? (layoutContext ? TEXT(layoutContext.hash) : '');
  const currentHash = input.currentLayoutHash ?? null;
  const hashMatches = storedHash === '' || currentHash === null || storedHash === currentHash;
  if (storedHash !== '' && currentHash !== null && storedHash !== currentHash) {
    semanticIssues.push(issue('MAP_INPUTS_CHANGED', `${path}.frame_json.atlasLayoutContext`, '本图的结构输入已变化：场景仍是上一次的，标记为未对齐', 'warning'));
  }

  const completeness: MapAssessmentV1['completeness'] = !sceneValid
    ? 'unknown'
    : missingIds.length === 0 && routeIssues.length === 0
      ? 'complete'
      : 'partial';

  const scaleQuality = TEXT(map.scale_quality);
  const metricQuality: MapAssessmentV1['metricQuality'] = scaleQuality === 'confirmed' ? 'confirmed' : scaleQuality === 'estimated' ? 'estimated' : 'uncalibrated';

  const matchesCurrentInputs = sceneValid
    && sceneState === 'ready'
    && requestState !== 'failed'
    && requestState !== 'pending'
    && hashMatches;

  return {
    version: 1,
    saveState: input.saveState,
    requestState,
    sceneState,
    matchesCurrentInputs,
    completeness,
    metricQuality,
    semanticState: !sceneValid ? 'unknown' : semanticIssues.length > 0 ? 'issues' : 'consistent',
    expectedIds,
    renderedIds,
    missingIds,
    routeIssues,
    semanticIssues,
  };
}
