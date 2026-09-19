/**
 * atlas-browser-entry.ts — ATLAS-09 纯浏览器模式打包入口。
 *
 * esbuild 以本文件为 entry 打成 atlas-extension/dist/atlas-ui-core.mjs：
 * 一个产物同时携带
 * - UI 核心（createAtlasUiCore / atlasClampZoom / ATLAS_UI_EVENTS / ATLAS_PROTOCOL_VERSION）
 * - 世界引擎核心（createAtlasServerCore：prepare / commit / 相关性 / 账本事务，纯 dispatch 零 Node 依赖）
 * - 浏览器三件套（createBrowserDocumentStore / createLocalAtlasApi / createStProxyFetch）
 *
 * index.js 在 connectAtlas 里用这三件套完成进程内接线：
 *   extensionSettings → 浏览器文档存储 → 引擎核心 → 本地 API（零网络）。
 */

export {
  createAtlasUiCore,
  atlasClampZoom,
  ATLAS_UI_EVENTS,
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
export { createStProxyFetch, ATLAS_ST_GENERATE_PATH } from "./atlas-proxy-fetch.ts";

export { buildStarterWorld } from "./atlas-starter-world.ts";

export {
  createAtlasLorebookWriter,
  lorebookNameFor,
  ATLAS_LOREBOOK_LIMITS,
  ATLAS_LOREBOOK_PREFIX,
  type AtlasLorebookPort,
} from "./atlas-lorebook.ts";
