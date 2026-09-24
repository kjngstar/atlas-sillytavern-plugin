/**
 * atlas-browser-entry.ts — ATLAS-09 纯浏览器模式打包入口。
 *
 * esbuild 以本文件为 entry 打成 atlas-extension/dist/atlas-ui-core.mjs：
 * 一个产物同时携带
 * - UI 核心（createAtlasUiCore / ATLAS_UI_EVENTS / ATLAS_PROTOCOL_VERSION）
 * - 世界引擎核心（createAtlasServerCore：prepare / commit / 相关性 / 账本事务，纯 dispatch 零 Node 依赖）
 * - 浏览器三件套（createBrowserDocumentStore / createLocalAtlasApi / createStProxyFetch）
 *
 * index.js 在 connectAtlas 里用这三件套完成进程内接线：
 *   extensionSettings → 浏览器文档存储 → 引擎核心 → 本地 API（零网络）。
 */

export {
  createAtlasUiCore,
  ATLAS_UI_EVENTS,
  // C6（0.9.54）：导航页清单唯一权威在 atlas-ui-core；index.js 不再自带 PAGES 副本。
  ATLAS_UI_PAGES,
  type AtlasUiPage,
} from "./atlas-ui-core.ts";

export {
  ATLAS_PROTOCOL_VERSION,
  ATLAS_ERROR_CODES,
  ATLAS_LIMITS,
  parseAtlasChatBinding,
  AtlasError,
} from "./atlas-contract.ts";

export {
  createAtlasServerCore,
  type AtlasServerCore,
  type AtlasDocumentStore,
} from "./atlas-server.ts";

export { DEFAULT_WORLD_TURN_SYSTEM_PROMPT } from "./atlas-api-client.ts";

export {
  createBrowserDocumentStore,
  ATLAS_BROWSER_DOC_LIMITS,
  type AtlasBrowserStoreHost,
} from "./atlas-browser-store.ts";

export { createLocalAtlasApi } from "./atlas-local-api.ts";

export {
  DEMO_TEMPLATES,
  getDemoTemplate,
  getDemoTemplateByName,
  buildWorldFromTemplate,
  type DemoTemplate,
} from "../lib/demo-events.ts";
// atlasCustomIncludeHeaders 必须转出：index.js 的 testConnection / 模型列表从 loadUiCore() 解构它
// （0.9.2/0.9.3 漏转 → 测试连接报 "atlasCustomIncludeHeaders is not a function"，加载模型全废）。
export {
  createStProxyFetch,
  atlasCustomIncludeHeaders,
  normalizeAtlasClaudeBase,
  normalizeAtlasGeminiBase,
  normalizeAtlasExcludeBody,
  normalizeAtlasPromptPostProcessing,
  ATLAS_ST_GENERATE_PATH,
} from "./atlas-proxy-fetch.ts";

export {
  isTavernMainAvailable,
  isConnectionManagerAvailable,
  getConnectionManagerProfiles,
  createTavernMainFetch,
  createTavernProfileFetch,
} from "./atlas-host-connections.ts";

export { buildStarterWorld, starterWorldIdForChat } from "./atlas-starter-world.ts";

// C5（0.9.54）：比例尺 / 距离格式化只保留 src/atlas-scale.ts 这一份权威实现。
// index.js 的地图渲染与旅行预览从 mod 解构使用，不再自带副本。
export {
  computeScaleBar,
  // H17/H19a：左下角常驻的是**固定长度**标尺（96 CSS px），读数随 camera.k 变化
  computeViewportScaleBar,
  formatFixedScaleDistance,
  formatScaleReading,
  SCALE_BAR_FIXED_PX,
  SCALE_BAR_FIXED_MIN_PX,
  formatDistanceMeters,
  formatTravelDistance,
  validateScaleResponse,
  sanitizeCalibration,
} from "./atlas-scale.ts";

// R08 地图相机与手势：index.js renderPanel 从 mod 解构使用（dist 必须导出，
// atlas-r08-camera.test.mjs 显式把关）。
export {
  computeMapFrame,
  emptyMapFrame,
  fitCamera,
  setCameraZoom,
  zoomCameraAtPoint,
  panCameraBy,
  centerCameraOn,
  worldToScreen,
  screenToWorld,
  cameraStageTransform,
  cameraZoomPercent,
  markerInverseScale,
  MAP_ZOOM_MIN_FACTOR,
  MAP_ZOOM_MAX_FACTOR,
  type MapCamera,
  type MapFrame,
} from "./atlas-map-camera.ts";

export {
  createPanGesture,
  createDragGesture,
  createHoldDragGesture,
  createPinchTracker,
  MAP_GESTURE_THRESHOLD_PX,
  MAP_LONGPRESS_HOLD_MS,
} from "./atlas-map-interactions.ts";

/**
 * H12/H13：视口对齐 SVG 网格的纯函数实现。
 * index.js 的 updateGridVisual 从 mod 解构它——格线只由这一个权威实现算出，
 * 不再用会被 stage 的 scale(k) 拉伸的 CSS 渐变。
 */
export {
  getVisibleGridPaths,
  gridCameraFromMapCamera,
  gridScreenPosition,
  gridMajorStepForScale,
  MAP_GRID_MAX_LINES_PER_AXIS,
  MAP_GRID_MINOR_MIN_PX,
  MAP_GRID_MAJOR_STEPS,
  MAP_GRID_STROKE_PX,
} from "./atlas-map-grid.ts";

/**
 * H15/H16：已证实范围的填色投影。index.js 的 renderMap 从 mod 解构使用——
 * 「只染有证据的格、没有 areas 就一格都不染」的判定只在这一处实现。
 */
export {
  projectColorAreas,
  type AtlasColorAreaProjection,
} from "./atlas-map-areas.ts";

/**
 * H08（0.9.59）：缺坐标地点的**示意布局**。
 *
 * 这个模块早就实现并有完整单测，但一直**没有生产调用点**——于是「未定位地点」
 * 在真实地图上根本不渲染（F01 只在数据层把它们挑出来了）。这里转出给 index.js 的
 * renderMap 消费：`displayOnly` 的点只做渲染，绝不回写三表 / world，
 * `collisionPoints` 也明确不含示意点（示意位置不是已知几何）。
 */
export {
  layoutUnplacedMarkers,
  ATLAS_MAP_LAYOUT_LIMITS,
  type AtlasMapLayoutResult,
} from "./atlas-map-layout.ts";

export {
  createAtlasLorebookWriter,
  lorebookNameFor,
  ATLAS_LOREBOOK_LIMITS,
  ATLAS_LOREBOOK_PREFIX,
  type AtlasLorebookPort,
} from "./atlas-lorebook.ts";

/**
 * A04（0.9.59）：安全诊断的**可公开面**补全。
 *
 * `createAtlasDiagnosticsSink` / `sanitizeDiagnostic` 早已转出；这里补上引用指纹与
 * 具名诊断表——它们决定「什么能进日志、什么必须被抹掉」：
 * - `atlasRefFingerprint` / `isAtlasRefFingerprint` / `chatFingerprintFromRef`：
 *   只给**不可逆指纹**，原文（聊天名、角色名、正文）永不进诊断；
 * - `ATLAS_NAMED_DIAGNOSTICS` / `namedDiagnosticSpec` / `isAllowedNamedDiagnosticDetail`：
 *   具名诊断只放行登记过的字段，未登记字段一律丢弃（不静默透传自由文本）；
 * - `namedDiagnosticInput`：按登记表构造诊断负载，非法输入 → null。
 *
 * 放在出口的意义：index.js 与预览页可以复用同一套口径，而不必各自再实现一份
 * 「哪些字段算敏感」的判断——两份判断迟早会分叉。
 */
export {
  createAtlasDiagnosticsSink,
  sanitizeDiagnostic,
  atlasRefFingerprint,
  isAtlasRefFingerprint,
  chatFingerprintFromRef,
  ATLAS_NAMED_DIAGNOSTICS,
  namedDiagnosticSpec,
  isAllowedNamedDiagnosticDetail,
  namedDiagnosticInput,
  type AtlasDiagnostic,
  type AtlasNamedDiagnosticCode,
  type AtlasNamedDiagnosticSpec,
} from "./atlas-diagnostics.ts";
