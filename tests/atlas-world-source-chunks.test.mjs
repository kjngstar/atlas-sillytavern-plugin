/**
 * atlas-world-source-chunks.test.mjs — W10 世界书分块（M3-16）。
 *
 * 口径来源：05-验收场景与精确预期 §W10 / 03-统一逐文件施工单 M3-16。
 *
 * - 一条 12000 字启用资料，**唯一地点关系只在最后一段**：尾部必须进入完整来源块，
 *   不许因为分块而丢尾部、也不许在正文里插省略号。
 * - `disable=true` 条目不进模型；**非激活的启用条目依然入模型**
 *   （地理建图读完整启用条目，不受普通回合激活清单 / 6000 字注入预算限制）。
 * - SQL 路径每块只做 extract-only；三块抽取结束后**只发一次** `map/build`
 *   （chunk 间不反复扩建）。
 * - 抽取途中切换聊天 → 旧聊天的最终 `map/build` 未发生。
 *
 * 纪律：
 * - 不发真实外网；合成世界书经 `window.__atlasWorldInfoModule` 注入。
 * - 合成资料只存在本文件的常量里，不落盘、不碰用户 worldbook。
 * - 施工单 M3-16 规定唯一手改文件是本测试，因此 index.js 一个字节都不改：
 *   内部函数 `importWorldbookGeography` / 模块级 `atlasRuntime` 经
 *   **data:URL 源码注入**追加导出取得（沿用 tests 既有的 S10 / B 阶段做法）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHAT_ID = "chat-w10";
const WORLD_ID = "world-w10";
const OTHER_CHAT_ID = "chat-w10-other";
const BOOK = "甲书";

/** 尾部才有、且全文唯一的那个地点关系。 */
const TAIL = "唯一地点关系：灰烬渡口位于北境河与雾脊山脉交汇处，隶属霜落公国。";
/** 无地理语义的填充段落（本身不含任何地点关系）。 */
const FILLER = "群山与河流之间的旧道仍在延伸，旅人沿着石阶远行。";
/** 已关闭条目的独有标记：出现在请求里就是泄漏。 */
const DISABLED_MARKER = "废弃设定：这个聚落已在旧稿中删除。";
/** 非激活但仍启用的条目标记：必须进模型。 */
const BIZ_MARKER = "青石集市街巷交错，商铺沿河一字排开。";

const ENTRY_TITLE = "大陆地理总纲";
const PREFIX_CHARS = `- [${BOOK}] ${ENTRY_TITLE}：`.length;
/** buildAtlasGeoLoreChunks 的默认 maxChars（见 index.js 导出签名）。 */
const CHUNK_MAX_CHARS = 5500;
/** 每片正文预算；用来证明 12000 字必然是**三**片而不是随便几片。 */
const PART_CHARS = CHUNK_MAX_CHARS - PREFIX_CHARS;

/** 至少 12000 字、尾部收在那个唯一地点关系上。 */
function geoSourceChars(total = 12000) {
  let body = "";
  while (body.length < total - TAIL.length) body += FILLER;
  return body + TAIL;
}

/** `readCardGeoLoreChunks` 交到分块器手上的形状（地理建图的真实输入）。 */
function makeEntries() {
  return [
    { bookName: BOOK, title: ENTRY_TITLE, content: geoSourceChars(), enabled: true },
    { bookName: BOOK, title: "废弃地理总纲", content: DISABLED_MARKER + FILLER.repeat(200), enabled: false },
    { bookName: BOOK, title: "非激活商业区", content: BIZ_MARKER, enabled: true },
  ];
}

/** 世界书原文形状（含 `disable: true`）——错误过滤必须在这里被抓住。 */
function makeBooks() {
  return {
    [BOOK]: {
      entries: {
        "geo-main": { uid: 1, comment: ENTRY_TITLE, key: ["地理"], content: geoSourceChars() },
        "hidden": { uid: 2, comment: "废弃地理总纲", key: ["地理"], disable: true,
          content: DISABLED_MARKER + FILLER.repeat(200) },
        "biz": { uid: 3, comment: "非激活商业区", key: ["商业区"], content: BIZ_MARKER },
      },
    },
  };
}

let moduleSeq = 0;
/**
 * 载入仓库根 index.js，并额外导出内部绑定（每调用一次都是全新实例）。
 * index.js 的 5 个静态相对导入全部形如 `from './ui/x.mjs'`，data:URL 下无法解析，
 * 所以先改写成绝对 file: URL。
 */
async function loadExtensionModule() {
  moduleSeq += 1;
  const source = readFileSync(join(root, "index.js"), "utf8")
    .replaceAll("\r\n", "\n")
    .replace(/(from\s+["'])\.\/ui\/([^"']+)(["'])/g,
      (_, prefix, file, suffix) => prefix + pathToFileURL(resolve(root, "ui", file)).href + suffix);
  const patched = `${source}\nexport { importWorldbookGeography, atlasRuntime };\n// w10-${moduleSeq}\n`;
  return import("data:text/javascript;base64," + Buffer.from(patched, "utf8").toString("base64"));
}

/**
 * 跑一次真实的地理建图链路：真实 `readCardGeoLoreChunks` → 真实分块
 * → 真实 `importWorldbookGeography`，只把宿主与 API 换成记录器。
 */
async function runPipeline({ onRequest = null } = {}) {
  const previous = {
    window: globalThis.window,
    SillyTavern: globalThis.SillyTavern,
    TavernHelper: globalThis.TavernHelper,
    getTavernHelper: globalThis.getTavernHelper,
  };
  const books = makeBooks();
  const stContext = {
    chatId: CHAT_ID,
    characterId: 0,
    chatMetadata: { world_info: null },
    characters: [{ data: { extensions: { world: BOOK } } }],
    extensionSettings: { atlas_world_sim: { sqlMode: true } },
    chat: [],
  };
  const calls = [];
  const extracted = [];
  stContext.__books = books;

  const reads = [];
  globalThis.window = {
    __atlasWorldInfoModule: {
      loadWorldInfo: async (name) => { reads.push(String(name)); return books[name]; },
    },
  };
  globalThis.SillyTavern = { getContext: () => stContext };
  delete globalThis.TavernHelper;
  delete globalThis.getTavernHelper;

  try {
    const mod = await loadExtensionModule();
    mod.atlasRuntime.mod = null;
    mod.atlasRuntime.core = {
      getState: () => ({ binding: { worldId: WORLD_ID } }),
      refresh: async () => {},
    };
    mod.atlasRuntime.api = {
      request: async (method, path, body) => {
        calls.push({ method, path, body });
        if (body?.constructionMode === "extract-only") {
          extracted.push(body);
          onRequest?.({ body, stContext, index: extracted.length });
          return { status: 200, body: { ok: true, data: { regionsAdded: 1, pointsAdded: 2 } } };
        }
        return { status: 200, body: { ok: true, data: { build: { status: "committed" } } } };
      },
    };
    const progress = [];
    const result = await mod.importWorldbookGeography(CHAT_ID, WORLD_ID, (event) => progress.push(event));
    return { calls, extracted, progress, result, stContext, books, mod, reads };
  } finally {
    globalThis.window = previous.window;
    globalThis.SillyTavern = previous.SillyTavern;
    globalThis.TavernHelper = previous.TavernHelper;
    globalThis.getTavernHelper = previous.getTavernHelper;
  }
}

/** 只做建设、不做逐块抽取的那些请求。 */
const buildCalls = (calls) => calls.filter((call) => call.body?.constructionMode !== "extract-only");
const payloads = (calls) => calls.map((call) => String(call.body?.loreSupplement ?? ""));

test("W10：12000 字资料来源分三块、尾部关系进模型；抽取完成后只发一次 map/build", async () => {
  const { calls, extracted, progress, result, mod, reads } = await runPipeline();

  // 世界书真的被读了（否则下面全是空转自嗨）。
  assert.deepEqual(reads, [BOOK], "地理建图必须真的去读绑定的世界书");

  // 先钉住夹具本身：12000 字确实只能切成三片（不是两片也不是四片）。
  const entries = makeEntries();
  const content = entries[0].content;
  assert.ok(content.length >= 12000, `合成资料应不少于 12000 字，实际 ${content.length}`);
  assert.ok(content.length > 2 * PART_CHARS, `每片 ${PART_CHARS} 字 → 12000 字必须超过两片`);
  assert.ok(content.length <= 3 * PART_CHARS, `每片 ${PART_CHARS} 字 → 12000 字必须落在三片内`);
  assert.equal(mod.buildAtlasGeoLoreChunks(entries).length, 3, "同口径复核：分块器给出三块");

  // 三块 → 三次 extract-only，一次都不多。
  assert.equal(extracted.length, 3, "三块资料来源 → 三次 extract-only");
  assert.equal(result.completed, 3);
  assert.equal(result.total, 3);
  assert.equal(result.buildStatus, "committed");
  assert.equal(progress.length, 3, "每块都要有进度回调");

  // 抽取结束后只发一次 map/build，且必须是最后一次。
  const builds = buildCalls(calls);
  assert.equal(builds.length, 1, "chunk 间不反复扩建：建设请求恰好一次");
  assert.equal(calls.at(-1), builds[0], "最终的 map/build 是最后一次请求");
  assert.equal(builds[0].path, "/sql/chat/map/build");
  assert.equal(builds[0].body.mode, "bootstrap");
  assert.equal(builds[0].body.requestId, `build_${CHAT_ID}`);
  assert.deepEqual(builds[0].body.focusLocationIds, []);
  assert.equal(builds[0].body.constructionMode, undefined, "最终建设不是 extract-only");

  // 每块抽取都是 extract-only + 空焦点 + 完整来源。
  for (const [index, body] of extracted.entries()) {
    assert.equal(body.requestId, `geo_${CHAT_ID}_${index}`);
    assert.equal(body.mode, "bootstrap");
    assert.deepEqual(body.focusLocationIds, []);
    assert.ok(String(body.loreSupplement).length > 0, "每块都带来源正文");
  }

  // 身份：所有请求都是同一个聊天 / 同一条路由。
  for (const call of calls) {
    assert.equal(call.path, "/sql/chat/map/build");
    assert.equal(call.body.chatId, CHAT_ID, "请求身份必须是当前聊天");
  }

  // 尾部：唯一地点关系落在**最后一块**，并原样进最终建设。
  assert.equal(extracted[0].loreSupplement.includes(TAIL), false, "尾部不在第一块");
  assert.equal(extracted[1].loreSupplement.includes(TAIL), false, "尾部不在第二块");
  assert.equal(extracted[2].loreSupplement.includes(TAIL), true, "尾部地点关系必须进入完整来源块");
  assert.equal(builds[0].body.loreSupplement.includes(TAIL), true, "最终建设拿到含尾部的完整来源");
  assert.equal(builds[0].body.loreSupplement.includes(DISABLED_MARKER), false, "关闭条目不进最终建设");

  // 无 UI 省略号 / 截断标记：来源正文原样进模型。
  for (const payload of payloads(calls)) {
    assert.equal(/…|省略|truncated/.test(payload), false, "来源正文不得带省略号或截断标记");
  }
  assert.equal(result.truncated, false, "本用例不触达分块上限");
});

test("W10：disable=true 条目不进模型；非激活的启用条目仍然入模型", async () => {
  const { calls, books, extracted } = await runPipeline();
  const all = payloads(calls);

  // 夹具确实带了这条关闭条目（排除只能是过滤的结果，不是夹具里没有）。
  const hidden = books[BOOK].entries.hidden;
  assert.equal(hidden.disable, true, "夹具里必须有 disable=true 条目");
  assert.ok(hidden.content.includes(DISABLED_MARKER));
  assert.ok(String(hidden.content).length > 4000, "关闭条目给足体量：一旦泄漏就会多出一块");

  assert.equal(all.some((payload) => payload.includes(DISABLED_MARKER)), false,
    "disable=true 条目不进模型");
  assert.equal(extracted.length, 3, "关闭条目若被收进来会变成第四块");

  assert.equal(all.some((payload) => payload.includes(BIZ_MARKER)), true,
    "非激活的启用条目依然入模型（地理建图读完整启用条目）");
});

test("W10：抽取途中切换聊天 → 旧聊天的最终 map/build 未发生", async () => {
  const { calls, extracted, result } = await runPipeline({
    onRequest: ({ body, stContext }) => {
      // 第三块（最后一块）抽取途中切走聊天。
      if (body.requestId === `geo_${CHAT_ID}_2`) stContext.chatId = OTHER_CHAT_ID;
    },
  });

  assert.equal(extracted.length, 3, "切换发生在最后一块抽取途中");
  assert.equal(extracted.at(-1).chatId, CHAT_ID, "已发出的抽取请求仍属于原聊天");
  assert.equal(buildCalls(calls).length, 0, "旧聊天的 map/build 未发生");
  assert.equal(result.buildStatus, "skipped", "抽取未全部完成 → 不假装已建");
});
