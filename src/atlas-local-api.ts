/**
 * atlas-local-api.ts — ATLAS-09 进程内 dispatch。
 *
 * 纯浏览器模式下 Atlas 引擎核心（createAtlasServerCore）整体打进 UI 扩展在浏览器运行，
 * AtlasUiApi 不再走同源 HTTP，而是直连 core.handle()，零网络、零端口。
 *
 * 语义保持与 HTTP 版一致：request(method, path, body) → { status, body }；
 * body 仍为 { ok: true, data } / { ok: false, error } 契约形状。
 */

import type { AtlasServerCore, AtlasRequestContext } from "./atlas-server.ts";

export function createLocalAtlasApi(core: AtlasServerCore, ctx: AtlasRequestContext = { local: true }) {
  return {
    async request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
      const result = await core.handle(method, path, body, ctx);
      return { status: result.status, body: result.body };
    },
  };
}
