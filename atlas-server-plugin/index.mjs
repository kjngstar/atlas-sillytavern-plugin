/**
 * 阿特拉斯 / Atlas — SillyTavern Server Plugin（ATLAS-02）。
 *
 * 结构纪律（上级 README 第 3.1 / 4.4 节）：
 * - 本文件只是薄适配：Express 接线 + 节点文件存储（临时文件 + rename 原子替换），
 *   全部业务逻辑在 ../src/atlas-server.ts（纯 dispatch 核心，node:test 可完整覆盖）。
 * - 独立 API 预设与密钥只保存在本插件 data/ 目录；任何响应只出脱敏视图。
 * - 所有端点固定在 /api/plugins/atlas/ 之下（ST 自动加前缀，这里注册相对路径）。
 * - 核心以 ES + TS 源码分发：init 时先尝试已构建产物 ../dist/atlas-server.mjs，
 *   再尝试 ../src/atlas-server.ts（需 Node ≥22.6 --experimental-strip-types）；
 *   正式打包（esbuild 单文件）在 ATLAS-07 实现。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ATLAS_PLUGIN_ID = "atlas";
export const ATLAS_PLUGIN_VERSION = "0.9.59";
export const ATLAS_PROTOCOL_VERSION = 1;
export const ATLAS_API_BASE = "/api/plugins/atlas";

/** 相对路由清单（ST 会自动挂到 /api/plugins/atlas 前缀下）。0.9.42 会话承载：世界数据随请求体往返。 */
export const ATLAS_PLUGIN_ROUTES = [
  { method: "GET", path: "/health" },
  { method: "GET", path: "/settings" },
  { method: "PUT", path: "/settings" },
  { method: "GET", path: "/worlds" },
  { method: "POST", path: "/worlds/import" },
  { method: "POST", path: "/worlds/ensure-starter" },
  { method: "POST", path: "/worlds/geo/adopt" },
  { method: "POST", path: "/worlds/move-author" },
  { method: "POST", path: "/worlds/scale/calibrate" },
  // H07a：作者手动确认归属 / 邻接 / 载具 / 坐标（会话路由）
  { method: "POST", path: "/maps/topology/confirm" },
  // H15a：作者手动涂色范围（只写 evidence=manual）
  { method: "POST", path: "/maps/areas/upsert" },
  { method: "POST", path: "/bindings" },
  { method: "POST", path: "/state" },
  { method: "POST", path: "/map/image" },
  { method: "POST", path: "/turns/prepare" },
  { method: "POST", path: "/turns/preview" },
  { method: "POST", path: "/scene/bootstrap" },
  { method: "POST", path: "/scene/repair-start" },
  { method: "POST", path: "/turns/commit" },
  { method: "POST", path: "/turns/retry" },
  { method: "POST", path: "/turns/restore" },
  { method: "POST", path: "/turns/rollback" },
  { method: "POST", path: "/map/travel-preview" },
  { method: "POST", path: "/session/export" },
  { method: "POST", path: "/session/purge" },
];

function isoNow() {
  return new Date().toISOString();
}

/**
 * 健康检查处理器。
 * 响应只含插件身份与状态，禁止返回路径、环境变量或密钥。
 */
export function createHealthHandler(now = isoNow) {
  return function handleHealth() {
    return {
      ok: true,
      plugin: ATLAS_PLUGIN_ID,
      version: ATLAS_PLUGIN_VERSION,
      protocolVersion: ATLAS_PROTOCOL_VERSION,
      time: now(),
    };
  };
}

/** 路由元数据（不实例化核心；供加载器与测试检查路由形状）。 */
export function createAtlasServerPlugin() {
  return {
    id: ATLAS_PLUGIN_ID,
    version: ATLAS_PLUGIN_VERSION,
    protocolVersion: ATLAS_PROTOCOL_VERSION,
    routes: ATLAS_PLUGIN_ROUTES.map((route) => ({
      method: route.method,
      path: `${ATLAS_API_BASE}${route.path}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// 节点文档存储：临时文件 + rename 原子替换（崩溃不留半截 JSON）
//
// 文件名编码（ATLAS-FIX-01 P0-08）：文档名一律 base64url 编码——可逆且一一映射，
// `world:a:b` 与 `world:a?b` 等不同合法 ID 绝不落同一文件。
// 旧版实现（非安全字符 → `__`，list 时 `__` → `:`）的遗留文件按原规则兼容读取，
// 不迁移、不静默覆盖；写入 / 删除只作用于新编码。
// ---------------------------------------------------------------------------

const MAX_DOC_BYTES = 4 * 1024 * 1024;
const FILE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

/** 新编码：base64url（UTF-8），可逆一一映射。 */
function canonicalFileName(name) {
  const safe = Buffer.from(name, "utf8").toString("base64url");
  if (!FILE_NAME_PATTERN.test(safe)) {
    throw new Error(`非法的文档名长度或形状：${safe.length}`);
  }
  return `${safe}.json`;
}

/** 旧编码（ATLAS-00～05 实现）：非安全字符统一替换 `__`。 */
function legacyFileName(name) {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "__");
  return FILE_NAME_PATTERN.test(safe) ? `${safe}.json` : null;
}

/** 判断磁盘条目是否是某个文档名的新编码（严格 re-encode 校验，防 legacy 误判）。 */
function decodeCanonical(stem) {
  try {
    const decoded = Buffer.from(stem, "base64url").toString("utf8");
    return Buffer.from(decoded, "utf8").toString("base64url") === stem ? decoded : null;
  } catch {
    return null;
  }
}

export function createNodeDocumentStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  return {
    async read(name) {
      const canonical = join(dataDir, canonicalFileName(name));
      if (!existsSync(canonical)) {
        // 旧版遗留文件兼容读取（不迁移不覆盖）
        const legacyName = legacyFileName(name);
        if (legacyName && legacyName !== canonicalFileName(name)) {
          const legacyFile = join(dataDir, legacyName);
          if (existsSync(legacyFile)) {
            try {
              return JSON.parse(readFileSync(legacyFile, "utf8"));
            } catch {
              return null;
            }
          }
        }
        return null;
      }
      try {
        return JSON.parse(readFileSync(canonical, "utf8"));
      } catch {
        // 半截文件视为不存在（写入是原子的，正常不会出现）
        return null;
      }
    },
    async write(name, value) {
      const payload = JSON.stringify(value);
      if (payload.length > MAX_DOC_BYTES) {
        throw new Error(`文档 ${name} 超过 ${MAX_DOC_BYTES} 字节上限，拒绝写入`);
      }
      const finalFile = join(dataDir, canonicalFileName(name));
      const tmpFile = `${finalFile}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmpFile, payload, "utf8");
      renameSync(tmpFile, finalFile);
    },
    async remove(name) {
      const file = join(dataDir, canonicalFileName(name));
      if (existsSync(file)) unlinkSync(file);
      // 历史遗留文件一并清理（幂等）
      const legacyName = legacyFileName(name);
      if (legacyName && legacyName !== canonicalFileName(name)) {
        const legacyFile = join(dataDir, legacyName);
        if (existsSync(legacyFile)) unlinkSync(legacyFile);
      }
    },
    async list(prefix) {
      const legacyPrefix = prefix.replace(/[^A-Za-z0-9_-]/g, "__");
      const names = [];
      const canonicalNames = new Set();
      const entries = readdirSync(dataDir);
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const stem = entry.slice(0, -".json".length);
        const decoded = decodeCanonical(stem);
        if (decoded !== null) {
          // 新编码文件
          if (decoded.startsWith(prefix)) {
            names.push(decoded);
            canonicalNames.add(decoded);
          }
          continue;
        }
        // 旧编码遗留文件：按旧规则还原文档名
        const legacyDoc = stem.replace(/__/g, ":");
        if (stem.startsWith(legacyPrefix) && !canonicalNames.has(legacyDoc)) {
          names.push(legacyDoc);
        }
      }
      return names;
    },
  };
}

// ---------------------------------------------------------------------------
// SillyTavern 插件入口
// ---------------------------------------------------------------------------

let corePromise = null;

async function loadCore(dataDir, fetchFn) {
  const store = createNodeDocumentStore(dataDir);
  // 先组件内构建产物（发布形态），再上级 src（开发形态，需 Node ≥22.6 strip-types）
  const attempts = ["./dist/atlas-server.mjs", "../src/atlas-server.ts"];
  let lastError = null;
  for (const specifier of attempts) {
    try {
      const mod = await import(new URL(specifier, import.meta.url).href);
      if (typeof mod.createAtlasServerCore !== "function") throw new Error("模块缺少 createAtlasServerCore 导出");
      return mod.createAtlasServerCore({ store, ...(fetchFn ? { fetchFn } : {}) });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Atlas 核心模块加载失败：${lastError?.message ?? "未知原因"}。` +
      "安装包应自带 dist/atlas-server.mjs；开发环境请先执行 npm run build（或 Node ≥22.6 加 --experimental-strip-types）。",
  );
}

/**
 * 默认写操作身份策略（ATLAS-FIX-01 P0-07）：
 * 当前 SillyTavern Express Request 公开 `req.user = { profile: User, directories }`，
 * 不存在 `req.session.userId`（CookieSession 只有 handle / csrfToken）。
 * 策略：已认证（req.user.profile.handle 为非空字符串）且（本机回环地址或管理员）。
 * 部署方可用 options.isLocal 覆盖本机 / 管理策略。
 */
export function defaultWriteAllowed(req) {
  const profile = req?.user?.profile;
  if (!profile || typeof profile !== "object") return false;
  if (typeof profile.handle !== "string" || !profile.handle) return false;
  const remote = String(req?.socket?.remoteAddress ?? "");
  const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (loopback) return true;
  return profile.admin === true;
}

/** 真实请求路径：优先 originalUrl，退回 baseUrl + path / url；去掉查询串。 */
function requestPathFor(req) {
  const raw =
    typeof req?.originalUrl === "string" && req.originalUrl
      ? req.originalUrl
      : `${req?.baseUrl ?? ""}${req?.path ?? req?.url ?? ""}`;
  return raw.split("?")[0] || "/";
}

/**
 * 初始化插件。
 * @param {import('express').Router} router Express router（挂在 /api/plugins/atlas 下）
 * @param {{ dataDir?: string, fetchFn?: typeof fetch, isLocal?: (req: unknown) => boolean }} [options]
 * @returns {Promise<{ core: Awaited<ReturnType<typeof loadCore>> }>}
 */
export async function init(router, options = {}) {
  const pluginDir = dirname(fileURLToPath(import.meta.url));
  const dataDir = options.dataDir ?? join(pluginDir, "data");
  corePromise = loadCore(dataDir, options.fetchFn);
  const core = await corePromise;
  const isLocal = options.isLocal ?? defaultWriteAllowed;

  const wire = (method) => (handler) => {
    router[method](handler.path, async (req, res) => {
      try {
        // 动态路由必须传真实请求路径（req.params 已编码进 path），
        // 不能把注册模板 `/state/:chatId` 交给核心解析（AR-ATLAS-07 P0-06）
        const result = await core.handle(method.toUpperCase(), requestPathFor(req), req.body, { local: isLocal(req) });
        res.status(result.status).json(result.body);
      } catch (error) {
        // 双保险：handler 内部已捕获业务异常；这里只兜底意外错误（脱敏后返回）
        res.status(500).json({ ok: false, error: { code: "WRITE_FAILED", message: "Atlas 插件内部错误。", details: {} } });
        console.error(`[atlas] ${method.toUpperCase()} ${handler.path} failed:`, error instanceof Error ? error.message : String(error));
      }
    });
  };

  const get = wire("get");
  const post = wire("post");
  const put = wire("put");

  get({ path: "/health" });
  get({ path: "/settings" });
  put({ path: "/settings" });
  get({ path: "/worlds" });
  post({ path: "/worlds/import" });
  post({ path: "/worlds/ensure-starter" });
  post({ path: "/worlds/geo/adopt" });
  post({ path: "/worlds/move-author" });
  post({ path: "/worlds/scale/calibrate" });
  post({ path: "/bindings" });
  post({ path: "/state" });
  post({ path: "/map/image" });
  post({ path: "/turns/prepare" });
  post({ path: "/turns/preview" });
  post({ path: "/scene/bootstrap" });
  post({ path: "/scene/repair-start" });
  post({ path: "/turns/commit" });
  post({ path: "/turns/retry" });
  post({ path: "/turns/restore" });
  post({ path: "/turns/rollback" });
  post({ path: "/map/travel-preview" });
  post({ path: "/session/export" });
  post({ path: "/session/purge" });

  return { core };
}

export async function exit() {
  corePromise = null;
  return Promise.resolve();
}

export const info = {
  id: ATLAS_PLUGIN_ID,
  name: "阿特拉斯 / Atlas",
  description: "Atlasia 世界引擎的 SillyTavern 适配：地图、世界时间、附近 NPC 与有界世界推演。",
};
