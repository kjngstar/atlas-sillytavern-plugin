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
  createPinchTracker,
  MAP_GESTURE_THRESHOLD_PX,
} from "./atlas-map-interactions.ts";

export {
  createAtlasLorebookWriter,
  lorebookNameFor,
  ATLAS_LOREBOOK_LIMITS,
  ATLAS_LOREBOOK_PREFIX,
  type AtlasLorebookPort,
} from "./atlas-lorebook.ts";

export { createAtlasDiagnosticsSink, sanitizeDiagnostic } from "./atlas-diagnostics.ts";
