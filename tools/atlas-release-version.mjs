/**
 * atlas-release-version.mjs — H16 版本同步脚本（规格 §17H H16）。
 *
 * 规格原文（§17H H16）：
 *   `tools/atlas-release-version.mjs`｜只编写版本同步脚本；默认 patch+1，
 *   也支持显式更高 `--version`，拒绝降号｜预演列出将改版本；发布门槛运行后
 *   package/manifest/server package/health 一致。
 *
 * 用法（默认 = 预演，不改任何文件）：
 *   node tools/atlas-release-version.mjs                       # 预演 patch+1
 *   node tools/atlas-release-version.mjs --patch               # 同上（显式）
 *   node tools/atlas-release-version.mjs --minor | --major     # 便利档，见下方说明
 *   node tools/atlas-release-version.mjs --version 0.9.61      # 显式更高版本
 *   node tools/atlas-release-version.mjs --apply               # 真正写入
 *   node tools/atlas-release-version.mjs --json                # 机器可读（只输出 JSON）
 *   node tools/atlas-release-version.mjs --root <dir>          # 覆盖仓库根（自检/演练用）
 *
 * 为什么除了规格要求的 patch+1 与显式 `--version` 之外还有 `--minor` / `--major`：
 *   规格只要求两条路径（默认 patch+1、显式更高 --version）。人工改版本号时最容易
 *   犯的错是手打错一位（0.9.60 → 0.9.6），两个便利档让「按分量进位」这件事由代码
 *   做，且**不改变默认行为**：不给任何 bump 参数时仍然是 patch+1（见 computeNextVersion）。
 *   多段版本（本仓库 0.9.60.1 这类四段号）按「最后一段是 patch」处理——0.9.60 → 0.9.60.1
 *   在提交 c070e63 里就是一次补丁发布；minor/major 进位并清零更低分量，段数保持不变。
 *
 * 硬规则：
 *   - 默认预演，列出每个文件与准确的 `旧 → 新`；`--apply` 才写。
 *   - `--version` 不高于当前版本 → VERSION_DOWNGRADE_REJECTED（退出码 1，不碰任何文件）。
 *   - 原子写（同目录临时文件 + rename，理由与 tools/pack.mjs::writeFileAtomic 相同：
 *     测试进程可能并发读取这些文件，半截写入会造成与被测逻辑无关的红）。
 *   - 写后重读校验：目标版本不在文件里 → VERSION_WRITE_UNVERIFIED。
 *   - package-lock.json 只允许改**根本包自己的** version 两处；任何依赖条目被改动
 *     立即回滚并报 VERSION_LOCKFILE_DEPENDENCY_TOUCHED。
 *   - 最后打印一致性检查：全部已解析版本点相等 → VERSION_CONSISTENT；否则列差异并退出 1。
 *   - 本脚本**不自己跑测试**：§18.5 的门槛顺序由操作者按序执行，脚本只打印该序列。
 *
 * 版本点的发现方式（不硬编码来路不明的清单）：见 VERSION_POINT_SPECS；每个点都在
 * 注释里写明「测试在哪一行断言它」。discoverVersionAssertions() 每次运行还会现场
 * 扫描 tests/，把断言版本一致性的测试与「硬编码的当前版本字面量」列出来，避免清单一
 * 旦与测试脱节却没人发现。
 */

import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// 错误码（全部具名，便于脚本化判断与日志检索）
// ---------------------------------------------------------------------------

export const VERSION_ERROR_CODES = {
  USAGE: "VERSION_USAGE",
  INVALID: "VERSION_INVALID",
  DOWNGRADE_REJECTED: "VERSION_DOWNGRADE_REJECTED",
  POINT_UNRESOLVED: "VERSION_POINT_UNRESOLVED",
  POINT_MISMATCH: "VERSION_POINT_MISMATCH",
  WRITE_UNVERIFIED: "VERSION_WRITE_UNVERIFIED",
  LOCKFILE_DEPENDENCY_TOUCHED: "VERSION_LOCKFILE_DEPENDENCY_TOUCHED",
};

export class VersionToolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "VersionToolError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// 版本数学
// ---------------------------------------------------------------------------

/** 解析点分数字版本；非法形状直接拒绝（绝不「尽力而为」地猜一个版本）。 */
export function parseVersion(text) {
  const raw = String(text ?? "").trim();
  if (!/^\d+(?:\.\d+)*$/.test(raw)) {
    throw new VersionToolError(
      VERSION_ERROR_CODES.INVALID,
      `版本号形状非法：${JSON.stringify(String(text))}（只接受点分数字，如 0.9.60 或 0.9.60.1）`,
    );
  }
  return { raw, parts: raw.split(".").map((part) => Number(part)) };
}

/** 比较两个点分版本：a>b 返回 1，相等 0，a<b 返回 -1；缺的分量按 0 补齐。 */
export function compareVersions(a, b) {
  const left = parseVersion(a).parts;
  const right = parseVersion(b).parts;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

/**
 * 计算目标版本。
 * - explicit 给了 → 必须严格高于 current，否则 VERSION_DOWNGRADE_REJECTED（含相等）。
 * - kind = explicit | patch | minor | major；未给 kind 时按规格默认 patch。
 * - patch：最后一段 +1（四段号的最后一段就是本仓库的补丁位）。
 * - minor：第二段 +1、更低分量清零；major：第一段 +1、更低分量清零。
 */
export function computeNextVersion(current, { kind, explicit } = {}) {
  const parsed = parseVersion(current);
  if (explicit !== undefined && explicit !== null) {
    const target = String(explicit).trim();
    const candidate = parseVersion(target);
    const order = compareVersions(candidate.raw, parsed.raw);
    if (order <= 0) {
      throw new VersionToolError(
        VERSION_ERROR_CODES.DOWNGRADE_REJECTED,
        `拒绝降号/平号：当前 ${parsed.raw}，请求 ${candidate.raw}（--version 必须严格高于当前版本）`,
        { current: parsed.raw, requested: candidate.raw },
      );
    }
    return candidate.raw;
  }
  const effective = kind && kind !== "explicit" ? kind : "patch";
  const parts = [...parsed.parts];
  if (effective === "patch") {
    parts[parts.length - 1] += 1;
  } else if (effective === "minor") {
    while (parts.length < 2) parts.push(0);
    parts[1] += 1;
    for (let i = 2; i < parts.length; i += 1) parts[i] = 0;
  } else if (effective === "major") {
    parts[0] += 1;
    for (let i = 1; i < parts.length; i += 1) parts[i] = 0;
  } else {
    throw new VersionToolError(VERSION_ERROR_CODES.USAGE, `未知的版本进位方式：${effective}`);
  }
  return parts.join(".");
}

// ---------------------------------------------------------------------------
// JSON 值跨度扫描（package-lock.json 只改根本包自己的 version，必须精确到路径）
// ---------------------------------------------------------------------------

/**
 * 扫描 JSON 文本，返回每个**字符串值**的路径与原文跨度。
 * 只用于定位，不做完整 JSON 语义（结构合法性另外用 JSON.parse 校验）。
 */
export function findJsonStringSpans(text) {
  const spans = [];
  let i = 0;
  const skipWs = () => {
    while (i < text.length && " \t\r\n".includes(text[i])) i += 1;
  };
  const readString = () => {
    const start = i;
    i += 1;
    let decoded = "";
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\") {
        decoded += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') {
        i += 1;
        break;
      }
      decoded += ch;
      i += 1;
    }
    return { value: decoded, valueStart: start + 1, valueEnd: i - 1 };
  };
  const parseValue = (path) => {
    skipWs();
    const ch = text[i];
    if (ch === undefined) return;
    if (ch === '"') {
      const span = readString();
      spans.push({ path, ...span });
      return;
    }
    if (ch === "{") {
      i += 1;
      skipWs();
      if (text[i] === "}") {
        i += 1;
        return;
      }
      for (;;) {
        skipWs();
        const key = readString();
        skipWs();
        if (text[i] === ":") i += 1;
        parseValue([...path, key.value]);
        skipWs();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "}") i += 1;
        return;
      }
    }
    if (ch === "[") {
      i += 1;
      skipWs();
      if (text[i] === "]") {
        i += 1;
        return;
      }
      let index = 0;
      for (;;) {
        parseValue([...path, String(index)]);
        index += 1;
        skipWs();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "]") i += 1;
        return;
      }
    }
    while (i < text.length && !",}] \t\r\n".includes(text[i])) i += 1;
  };
  parseValue([]);
  return spans;
}

function findJsonSpanByPath(raw, path) {
  const wanted = path.join("\u0000");
  const spans = findJsonStringSpans(raw);
  const hits = spans.filter((span) => span.path.join("\u0000") === wanted);
  if (hits.length !== 1) return null;
  return { start: hits[0].valueStart, end: hits[0].valueEnd, value: hits[0].value };
}

// ---------------------------------------------------------------------------
// 版本点清单
// ---------------------------------------------------------------------------

/**
 * 每个版本点的 locator 类型：
 * - json           ：按 JSON 路径取字符串值（精确到值的字符跨度，不动格式）
 * - js-const       ：`export const NAME = "x.y.z"` 的值
 * - anchored-field ：在 anchor 之后第一个 `key: "x.y.z"` 的值（health 响应字段）
 * - unique-literal ：全文件恰好出现一次的 `key: "<当前值>"`（构建产物里的 health 字面量）
 *
 * required=true 的点找不到 → VERSION_POINT_UNRESOLVED（不装作同步成功）。
 * derived=true 的点是构建产物：由 `npm run build` / `npm run pack` 重新生成；
 * 找不到就报 unresolved 并交给构建，不算失败（但也不会被谎报成「一致」）。
 */
const VERSION_POINT_SPECS = [
  {
    id: "package.json#version",
    file: "package.json",
    role: "根包版本（权威源，其余点向它看齐）",
    required: true,
    locator: { type: "json", path: ["version"] },
    assertedBy: ["tests/atlas-integration.test.mjs rootPkg.version", "tests/atlas-release-audit.test.mjs manifest.version = pkg.version"],
  },
  {
    id: "manifest.json#version",
    file: "manifest.json",
    role: "根安装单元 manifest（SillyTavern 读它）",
    required: true,
    locator: { type: "json", path: ["version"] },
    assertedBy: ["tests/atlas-release-audit.test.mjs manifest 版本 = 根包版本"],
  },
  {
    id: "atlas-extension/manifest.json#version",
    file: "atlas-extension/manifest.json",
    role: "UI 组件发布镜像 manifest（pack 会从根 manifest.json 正向同步）",
    required: true,
    locator: { type: "json", path: ["version"] },
    assertedBy: ["tests/atlas-integration.test.mjs manifest.version", "tests/atlas-extension-harness.test.mjs manifest 版本与代码一致"],
  },
  {
    id: "index.js#ATLAS_EXTENSION_VERSION",
    file: "index.js",
    role: "根 UI 入口版本常量",
    required: true,
    locator: { type: "js-const", identifier: "ATLAS_EXTENSION_VERSION" },
    assertedBy: ["tools/pack.mjs 断言 atlas-extension/index.js 镜像与根 index.js 一致（除 dev 回退行）"],
  },
  {
    id: "atlas-extension/index.js#ATLAS_EXTENSION_VERSION",
    file: "atlas-extension/index.js",
    role: "UI 组件入口版本常量（发布副本）",
    required: true,
    locator: { type: "js-const", identifier: "ATLAS_EXTENSION_VERSION" },
    assertedBy: ["tests/atlas-integration.test.mjs uiMod.ATLAS_EXTENSION_VERSION", "tests/atlas-extension-harness.test.mjs"],
  },
  {
    id: "atlas-server-plugin/package.json#version",
    file: "atlas-server-plugin/package.json",
    role: "Server 插件包版本",
    required: true,
    locator: { type: "json", path: ["version"] },
    assertedBy: ["tests/atlas-integration.test.mjs serverPkg.version", "tests/atlas-packed-replay.test.mjs packedServerPkg.version"],
  },
  {
    id: "atlas-server-plugin/index.mjs#ATLAS_PLUGIN_VERSION",
    file: "atlas-server-plugin/index.mjs",
    role: "Server 插件版本常量（health 处理器与路由元数据都用它）",
    required: true,
    locator: { type: "js-const", identifier: "ATLAS_PLUGIN_VERSION" },
    assertedBy: ["tests/atlas-integration.test.mjs serverMod.ATLAS_PLUGIN_VERSION", "tests/atlas-server-plugin.test.mjs health version", "tests/atlas-packed-replay.test.mjs"],
  },
  {
    id: "src/atlas-server.ts#health.version",
    file: "src/atlas-server.ts",
    role: "dispatch 核心 health 响应里的 version（「六处同步第 6 处」）",
    required: true,
    locator: { type: "anchored-field", anchor: "async function handleHealth(", key: "version" },
    assertedBy: ["tests/atlas-server-plugin.test.mjs health version = ATLAS_PLUGIN_VERSION"],
  },
  {
    id: "package-lock.json#root.version",
    file: "package-lock.json",
    role: "锁文件里根本包自己的 version（第 1 处）",
    required: false,
    lockRootOnly: true,
    locator: { type: "json", path: ["version"] },
    assertedBy: ["npm ci 前后 package.json / package-lock.json 自洽（非测试断言）"],
  },
  {
    id: "package-lock.json#packages[\"\"].version",
    file: "package-lock.json",
    role: "锁文件 packages[\"\"] 里根本包自己的 version（第 2 处）",
    required: false,
    lockRootOnly: true,
    locator: { type: "json", path: ["packages", "", "version"] },
    assertedBy: ["npm ci 前后 package.json / package-lock.json 自洽（非测试断言）"],
  },
  {
    id: "dist/atlas-ui-core.mjs#health.version",
    file: "dist/atlas-ui-core.mjs",
    role: "根安装单元随包发布的 UI 构建产物（pack 从 atlas-extension/dist 同步过来）",
    required: false,
    derived: true,
    locator: { type: "unique-literal", key: "version" },
    assertedBy: ["无测试断言；npm run build + npm run pack 会重新生成"],
  },
  {
    id: "atlas-extension/dist/atlas-ui-core.mjs#health.version",
    file: "atlas-extension/dist/atlas-ui-core.mjs",
    role: "UI 组件构建产物（gitignore，由 npm run build 生成）",
    required: false,
    derived: true,
    locator: { type: "unique-literal", key: "version" },
    assertedBy: ["无测试断言；npm run build 会重新生成"],
  },
  {
    id: "atlas-server-plugin/dist/atlas-server.mjs#health.version",
    file: "atlas-server-plugin/dist/atlas-server.mjs",
    role: "Server 插件构建产物（gitignore，由 npm run build 生成）",
    required: false,
    derived: true,
    locator: { type: "unique-literal", key: "version" },
    assertedBy: ["无测试断言；npm run build 会重新生成"],
  },
];

/** 在给定文本里定位 locator 的值跨度；找不到返回 null。 */
export function locateVersionValue(locator, raw, expectedValue) {
  if (locator.type === "json") {
    return findJsonSpanByPath(raw, locator.path);
  }
  if (locator.type === "js-const") {
    const pattern = new RegExp(`(export\\s+const\\s+${locator.identifier}\\s*=\\s*)(["'])([^"']*)\\2`);
    const match = pattern.exec(raw);
    if (!match) return null;
    const start = match.index + match[1].length + 1;
    return { start, end: start + match[3].length, value: match[3] };
  }
  if (locator.type === "anchored-field") {
    const anchorAt = raw.indexOf(locator.anchor);
    if (anchorAt < 0) return null;
    const rest = raw.slice(anchorAt);
    const pattern = new RegExp(`\\b${locator.key}\\s*:\\s*(["'])([^"']*)\\1`);
    const match = pattern.exec(rest);
    if (!match) return null;
    const start = anchorAt + match.index + match[0].length - match[2].length - 1;
    return { start, end: start + match[2].length, value: match[2] };
  }
  if (locator.type === "unique-literal") {
    if (expectedValue === undefined || expectedValue === null) return null;
    const pattern = new RegExp(`\\b${locator.key}\\s*:\\s*(["'])${escapeRegExp(String(expectedValue))}\\1`, "g");
    const hits = [...raw.matchAll(pattern)];
    if (hits.length !== 1) return null;
    const hit = hits[0];
    const start = hit.index + hit[0].length - String(expectedValue).length - 1;
    return { start, end: start + String(expectedValue).length, value: String(expectedValue) };
  }
  return null;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 现场发现版本点：读每个文件、定位当前值、核对是否与权威源一致。
 * 返回 { root, current, points, unresolved, mismatches, versionAssertions, problems }。
 */
export function discoverVersionPoints(root = REPO_ROOT) {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) {
    throw new VersionToolError(VERSION_ERROR_CODES.USAGE, `找不到 ${packagePath}（用 --root 指定仓库根）`);
  }
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const current = parseVersion(packageJson.version).raw;

  const points = [];
  const unresolved = [];
  for (const spec of VERSION_POINT_SPECS) {
    const abs = join(root, spec.file);
    const point = { ...spec, abs, exists: existsSync(abs), value: null, locatorFound: false };
    if (!point.exists) {
      point.status = "absent";
      if (spec.derived) {
        point.note = "构建产物不存在：npm run build 生成后即可纳入同步（不算失败）";
        unresolved.push(point);
      } else {
        point.note = "必需版本点缺失";
        unresolved.push(point);
      }
      points.push(point);
      continue;
    }
    const raw = readFileSync(abs, "utf8");
    // unique-literal 需要「当前值」才能定位（它就是要找等于当前版本的那一处字面量）
    const span = locateVersionValue(spec.locator, raw, spec.locator.type === "unique-literal" ? current : undefined);
    if (!span) {
      point.status = "unresolved";
      point.note = spec.derived
        ? "产物里没找到等于当前版本的字面量（可能已过期或结构变化）：交给 npm run build / npm run pack 重新生成"
        : `定位不到 ${spec.locator.type} 值（源码形状可能变了：${JSON.stringify(spec.locator)}）`;
      unresolved.push(point);
    } else {
      point.status = "resolved";
      point.value = span.value;
    }
    points.push(point);
  }

  const mismatches = points.filter((p) => p.status === "resolved" && p.value !== current);
  return {
    root,
    current,
    packageName: packageJson.name,
    points,
    unresolved,
    mismatches,
    versionAssertions: discoverVersionAssertions(root, current),
    problems: unresolved.filter((p) => p.required).map((p) => ({
      code: VERSION_ERROR_CODES.POINT_UNRESOLVED,
      pointId: p.id,
      file: p.file,
      note: p.note,
    })),
  };
}

/**
 * 现场扫描 tests/：哪些测试断言版本一致性、哪些地方硬编码了当前版本字面量。
 * 后者在 bump 之后必须由对应负责人同步（本脚本不改测试文件）。
 */
export function discoverVersionAssertions(root = REPO_ROOT, current) {
  const testsDir = join(root, "tests");
  const result = { scannedFiles: 0, consistencyTests: [], hardCodedLiterals: [] };
  if (!existsSync(testsDir)) return result;
  const files = readdirSync(testsDir).filter((name) => name.endsWith(".mjs"));
  const literalPattern = /["'](\d+\.\d+(?:\.\d+)*)["']/;
  for (const name of files) {
    const abs = join(testsDir, name);
    if (!statSync(abs).isFile()) continue;
    result.scannedFiles += 1;
    const lines = readFileSync(abs, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const at = `tests/${name}:${index + 1}`;
      const mentionsVersionSync =
        /(版本\s*(一致|=|：|:)|ATLAS_(PLUGIN|EXTENSION)_VERSION|\.version\b|manifest\.version|pkg\.version|根包)/.test(line) &&
        // 排除 schema/protocol/user_version 这类「另一种版本」的噪声行
        !/user_version|schema_version|storage_version|protocolVersion|SCHEMA_VERSION|VENDOR|ATLAS_SQL_VERSION|基版本|基态/.test(line);
      if (mentionsVersionSync) {
        result.consistencyTests.push({ at, text: line.trim().slice(0, 200) });
      }
      const literal = literalPattern.exec(line);
      if (current && literal && literal[1] === current) {
        result.hardCodedLiterals.push({
          at,
          literal: literal[1],
          text: line.trim().slice(0, 200),
          note: "硬编码当前版本；bump 后需要发布负责人同步（本脚本不改测试文件）",
        });
      }
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 预演计划
// ---------------------------------------------------------------------------

/**
 * 生成写入计划。points 可以是 discoverVersionPoints() 的返回值，也可以是它的 points 数组。
 * 计划里的每个 edit 都带 locator：真正写入时**重新定位**，不使用可能过期的偏移。
 */
export function planVersionSync(points, next) {
  const discovery = Array.isArray(points)
    ? { points, root: REPO_ROOT, current: points.find((point) => point.status === "resolved")?.value ?? parseVersion(next).raw }
    : points;
  const current = discovery.current;
  const target = parseVersion(next).raw;
  if (compareVersions(target, current) < 0) {
    throw new VersionToolError(
      VERSION_ERROR_CODES.DOWNGRADE_REJECTED,
      `拒绝降号：当前 ${current}，计划 ${target}`,
      { current, requested: target },
    );
  }
  const edits = [];
  const unchanged = [];
  const mismatches = [];
  const unresolved = [];
  for (const point of discovery.points) {
    if (point.status !== "resolved") {
      unresolved.push(point);
      continue;
    }
    if (point.value === target) {
      unchanged.push(point);
      continue;
    }
    if (point.value !== current) {
      mismatches.push(point);
      continue;
    }
    edits.push({ pointId: point.id, file: point.file, abs: point.abs, from: point.value, to: target, locator: point.locator, required: point.required });
  }
  return {
    root: discovery.root,
    current,
    next: target,
    edits,
    unchanged,
    mismatches,
    unresolved,
    blockingMismatches: mismatches.filter((point) => point.required),
  };
}

// ---------------------------------------------------------------------------
// 原子写（与 tools/pack.mjs::writeFileAtomic 同一纪律）
// ---------------------------------------------------------------------------

/**
 * 原子写文件：先写同目录临时文件，再 rename 覆盖目标。
 *
 * 理由与 pack.mjs 相同且同样真实：`node --test` 下多个测试文件是并发进程，
 * 会在本脚本写入 version 字段的同时读这些文件（atlas-integration 读五处版本、
 * atlas-release-audit 读 manifest 与根包）。rename 在同一卷上原子：读者要么看到
 * 旧完整文件、要么看到新完整文件，不会看到半个 JSON——半截 JSON 会让
 * JSON.parse 抛错，制造与被测逻辑毫无关系的红。
 */
function writeFileAtomic(to, content) {
  const tmp = `${to}.version-tmp-${process.pid}`;
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, to);
  } catch (error) {
    // rename 失败（极少数：目标被占用）时退回直接写，至少不留临时文件
    try {
      unlinkSync(tmp);
    } catch {
      /* 忽略 */
    }
    writeFileSync(to, content);
    if (process.env.ATLAS_VERSION_DEBUG) console.error(`[version] atomic rename failed for ${to}: ${String(error)}`);
  }
}

/** 只比较 packages 里非根条目的 version，确保锁文件依赖没被碰过。 */
function lockfileDependencyVersions(parsed) {
  const out = {};
  const packages = parsed.packages ?? {};
  for (const [key, value] of Object.entries(packages)) {
    if (key === "") continue;
    out[key] = value && typeof value === "object" ? value.version ?? null : null;
  }
  return out;
}

/**
 * 执行写入计划。每个文件：重新定位 → 替换 → 原子写 → 重读校验。
 * 返回 { applied, verified, lockGuard }；任一环节不成立就抛具名错误。
 */
export function applyVersionPlan(plan) {
  const applied = [];
  const verified = [];
  for (const edit of plan.edits) {
    const before = readFileSync(edit.abs, "utf8");
    const span = locateVersionValue(edit.locator, before, edit.locator.type === "unique-literal" ? plan.current : undefined);
    if (!span) {
      throw new VersionToolError(VERSION_ERROR_CODES.POINT_UNRESOLVED, `写入前重新定位失败：${edit.pointId}`, { pointId: edit.pointId, file: edit.file });
    }
    if (span.value === plan.next) {
      verified.push({ pointId: edit.pointId, file: edit.file, value: span.value, note: "写入前已是目标版本" });
      continue;
    }
    if (span.value !== plan.current) {
      throw new VersionToolError(
        VERSION_ERROR_CODES.POINT_MISMATCH,
        `写入前值漂移：${edit.pointId} 期望 ${plan.current}，实际 ${span.value}`,
        { pointId: edit.pointId, file: edit.file, expected: plan.current, actual: span.value },
      );
    }
    const after = `${before.slice(0, span.start)}${plan.next}${before.slice(span.end)}`;
    if (after === before) {
      throw new VersionToolError(VERSION_ERROR_CODES.POINT_MISMATCH, `替换没有产生任何变化：${edit.pointId}`, { pointId: edit.pointId });
    }
    const lockBefore = edit.pointId.startsWith("package-lock.json#") ? JSON.parse(before) : null;
    writeFileAtomic(edit.abs, after);

    // 写后重读：目标版本必须真的在文件里，且位置与预期一致
    const reread = readFileSync(edit.abs, "utf8");
    const verifySpan = locateVersionValue(edit.locator, reread, edit.locator.type === "unique-literal" ? plan.next : undefined);
    if (!verifySpan || verifySpan.value !== plan.next) {
      throw new VersionToolError(
        VERSION_ERROR_CODES.WRITE_UNVERIFIED,
        `写后校验失败：${edit.pointId} 里找不到 ${plan.next}`,
        { pointId: edit.pointId, file: edit.file, expected: plan.next, actual: verifySpan ? verifySpan.value : null },
      );
    }
    if (lockBefore) {
      const lockAfter = JSON.parse(reread);
      const beforeDeps = lockfileDependencyVersions(lockBefore);
      const afterDeps = lockfileDependencyVersions(lockAfter);
      const changedDeps = Object.keys(beforeDeps).filter((key) => beforeDeps[key] !== afterDeps[key]);
      if (changedDeps.length > 0) {
        // 立刻回滚，绝不把「依赖版本被改」留在工作区
        writeFileAtomic(edit.abs, before);
        throw new VersionToolError(
          VERSION_ERROR_CODES.LOCKFILE_DEPENDENCY_TOUCHED,
          `package-lock.json 的依赖条目被改动，已回滚：${changedDeps.slice(0, 5).join(", ")}`,
          { pointId: edit.pointId, changedDeps },
        );
      }
    }
    applied.push({ pointId: edit.pointId, file: edit.file, from: edit.from, to: plan.next });
    verified.push({ pointId: edit.pointId, file: edit.file, value: verifySpan.value });
  }
  return { applied, verified, lockGuard: { onlyRootVersionFields: true } };
}

// ---------------------------------------------------------------------------
// 一致性检查与报告
// ---------------------------------------------------------------------------

/** 预演用投影值：等于当前值的点将被改成 next，其余保持原样。 */
function projectedValue(point, plan) {
  if (point.status !== "resolved") return null;
  if (point.value === plan.current) return plan.next;
  return point.value;
}

/**
 * 最终一致性检查。dryRun=false 时按「文件已写入」投影；dryRun=true 时按计划投影。
 * 只对**已解析**的点判定一致；未解析的点单独列出，不冒充一致也不冒充不一致。
 */
export function checkVersionConsistency(discovery, plan, { dryRun }) {
  const rows = discovery.points.map((point) => ({
    pointId: point.id,
    file: point.file,
    status: point.status,
    current: point.value,
    projected: projectedValue(point, plan),
    required: Boolean(point.required),
    derived: Boolean(point.derived),
    note: point.note ?? null,
  }));
  const resolved = rows.filter((row) => row.status === "resolved");
  const mismatched = resolved.filter((row) => row.projected !== plan.next);
  const unresolvedRows = rows.filter((row) => row.status !== "resolved");
  return {
    target: plan.next,
    consistent: mismatched.length === 0,
    code: mismatched.length === 0 ? "VERSION_CONSISTENT" : "VERSION_MISMATCH",
    checkedCount: resolved.length,
    mismatched,
    unresolved: unresolvedRows,
    rows,
  };
}

function formatPointLine(row) {
  const from = row.current ?? "—";
  const to = row.projected ?? "—";
  const flag = row.status === "resolved" ? (row.projected === row.current && row.current !== undefined ? "unchanged" : "write") : row.status;
  return `  ${row.pointId.padEnd(46)} ${String(from).padEnd(10)} → ${String(to).padEnd(10)} [${flag}] ${row.file}`;
}

const GATE_COMMANDS = ["npm ci", "npm run typecheck", "npm test", "npm run build", "npm run pack"];

function buildWarnings(discovery, plan) {
  const warnings = [];
  if (discovery.versionAssertions.hardCodedLiterals.length > 0) {
    warnings.push(
      "以下位置硬编码了当前版本字面量，bump 之后必须由发布负责人同步（本脚本按规矩不改测试文件）：",
    );
    for (const hit of discovery.versionAssertions.hardCodedLiterals) {
      warnings.push(`  - ${hit.at}  ${hit.literal}  ${hit.text}`);
    }
  }
  if (plan.unresolved.length > 0) {
    warnings.push("以下版本点未能解析（不计入一致性判定）：");
    for (const point of plan.unresolved) warnings.push(`  - ${point.id}：${point.note ?? point.status}`);
  }
  if (plan.mismatches.length > 0) {
    warnings.push("以下版本点在同步前就已经不等于权威源（需要人工判断哪边是对的）：");
    for (const point of plan.mismatches) warnings.push(`  - ${point.id}：${point.value} ≠ ${plan.current}`);
  }
  warnings.push("本脚本不运行测试：请按 §18.5 的顺序人工执行门槛（见下方命令序列）。");
  return warnings;
}

function humanReport({ mode, dryRun, discovery, plan, consistency, applied, warnings }) {
  const lines = [];
  lines.push(`Atlas 版本同步（H16）— ${dryRun ? "预演（不写文件）" : "已写入"}${mode === "json" ? "" : ""}`);
  lines.push(`仓库根：${discovery.root}`);
  lines.push(`当前版本（权威源 package.json）：${discovery.current}    目标版本：${plan.next}`);
  lines.push("");
  lines.push(`将改动的版本点（${plan.edits.length}）：`);
  if (plan.edits.length === 0) lines.push("  （无：全部已解析的点都已是目标版本）");
  for (const edit of plan.edits) {
    lines.push(`  ${edit.pointId.padEnd(46)} ${edit.from} → ${edit.to}  [${edit.file}]`);
  }
  if (plan.unchanged.length > 0) {
    lines.push("");
    lines.push(`已是目标版本（${plan.unchanged.length}）：`);
    for (const point of plan.unchanged) lines.push(`  ${point.id} = ${point.value}`);
  }
  lines.push("");
  lines.push("全部已发现版本点：");
  for (const row of consistency.rows) lines.push(formatPointLine(row));
  lines.push("");
  if (applied) {
    lines.push(`写入结果：applied=${applied.applied.length} verified=${applied.verified.length}（逐文件重读校验通过）`);
  }
  const assertionTests = discovery.versionAssertions.consistencyTests;
  lines.push(`版本一致性断言（现场扫描 tests/，共命中 ${assertionTests.length} 行）：`);
  for (const hit of assertionTests.slice(0, 12)) lines.push(`  - ${hit.at}  ${hit.text}`);
  if (assertionTests.length > 12) lines.push(`  … 其余 ${assertionTests.length - 12} 行见 --json`);
  lines.push("");
  lines.push("一致性检查：");
  lines.push(`  ${consistency.code}  （已解析 ${consistency.checkedCount} 个点，目标 ${consistency.target}）`);
  for (const row of consistency.mismatched) lines.push(`  不一致：${row.pointId} = ${row.current}（期望 ${consistency.target}）`);
  for (const row of consistency.unresolved) lines.push(`  未解析：${row.pointId}（${row.note ?? row.status}）`);
  lines.push("");
  lines.push("警告：");
  for (const warning of warnings) lines.push(`  ${warning}`);
  lines.push("");
  lines.push("§18.5 发布门槛（按顺序执行，本脚本不代跑）：");
  for (const command of GATE_COMMANDS) lines.push(`  ${command}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { apply: false, json: false, kind: null, explicit: null, root: REPO_ROOT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--patch") options.kind = "patch";
    else if (arg === "--minor") options.kind = "minor";
    else if (arg === "--major") options.kind = "major";
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new VersionToolError(VERSION_ERROR_CODES.USAGE, "--version 需要一个值，例如 --version 0.9.61");
      }
      options.explicit = value;
      options.kind = "explicit";
      i += 1;
    } else if (arg.startsWith("--version=")) {
      options.explicit = arg.slice("--version=".length);
      options.kind = "explicit";
    } else if (arg === "--root") {
      const value = argv[i + 1];
      if (!value) throw new VersionToolError(VERSION_ERROR_CODES.USAGE, "--root 需要一个目录");
      options.root = value;
      i += 1;
    } else {
      throw new VersionToolError(VERSION_ERROR_CODES.USAGE, `未知参数：${arg}`);
    }
  }
  return options;
}

const USAGE = [
  "用法：node tools/atlas-release-version.mjs [--apply] [--patch|--minor|--major|--version X.Y.Z] [--json] [--root <dir>]",
  "  默认（无 bump 参数）= patch+1；默认预演（不写文件），--apply 才写。",
  "  --version 必须严格高于当前版本；否则 VERSION_DOWNGRADE_REJECTED（退出码 1，不碰文件）。",
].join("\n");

function runCli(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return { exitCode: 0 };
  }
  const discovery = discoverVersionPoints(options.root);
  const next = computeNextVersion(discovery.current, { kind: options.kind ?? "patch", explicit: options.explicit });
  const plan = planVersionSync(discovery, next);

  // 必需点漂移 → 拒绝写入（否则会在一个已经不自洽的仓库上做半套同步）
  if (plan.blockingMismatches.length > 0) {
    throw new VersionToolError(
      VERSION_ERROR_CODES.POINT_MISMATCH,
      `拒绝在漂移的仓库上同步：${plan.blockingMismatches.map((point) => `${point.id}=${point.value}`).join(", ")}（权威源 ${discovery.current}）`,
      { mismatches: plan.blockingMismatches.map((point) => ({ pointId: point.id, value: point.value })) },
    );
  }

  let applied = null;
  if (options.apply) applied = applyVersionPlan(plan);
  const consistency = checkVersionConsistency(discovery, plan, { dryRun: !options.apply });
  const warnings = buildWarnings(discovery, plan);

  const report = {
    tool: "atlas-release-version",
    spec: "§17H H16",
    mode: options.json ? "json" : "human",
    dryRun: !options.apply,
    applied: Boolean(applied),
    root: discovery.root,
    current: discovery.current,
    next: plan.next,
    bump: options.kind ?? "patch",
    points: discovery.points.map((point) => ({
      pointId: point.id,
      file: point.file,
      role: point.role,
      required: Boolean(point.required),
      derived: Boolean(point.derived),
      status: point.status,
      current: point.value,
      target: point.status === "resolved" && point.value === discovery.current ? plan.next : point.value,
      note: point.note ?? null,
      assertedBy: point.assertedBy,
    })),
    edits: plan.edits.map((edit) => ({ pointId: edit.pointId, file: edit.file, from: edit.from, to: edit.to })),
    unchanged: plan.unchanged.map((point) => ({ pointId: point.id, value: point.value })),
    unresolved: plan.unresolved.map((point) => ({ pointId: point.id, file: point.file, status: point.status, note: point.note ?? null })),
    mismatches: plan.mismatches.map((point) => ({ pointId: point.id, file: point.file, value: point.value })),
    applyResult: applied,
    consistency: {
      code: consistency.code,
      consistent: consistency.consistent,
      target: consistency.target,
      checkedCount: consistency.checkedCount,
      mismatched: consistency.mismatched.map((row) => ({ pointId: row.pointId, value: row.current })),
      unresolved: consistency.unresolved.map((row) => ({ pointId: row.pointId, status: row.status })),
    },
    versionAssertions: discovery.versionAssertions,
    warnings,
    gateCommands: GATE_COMMANDS,
    note: "本脚本只同步版本号，不运行测试；§18.5 的门槛顺序由操作者按序执行。",
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(humanReport({ mode: "human", dryRun: !options.apply, discovery, plan, consistency, applied, warnings }));
  }
  return { exitCode: consistency.consistent ? 0 : 1, report };
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;

if (invokedDirectly) {
  try {
    const { exitCode } = runCli(process.argv.slice(2));
    if (exitCode !== 0) process.exitCode = exitCode;
  } catch (error) {
    const code = error instanceof VersionToolError ? error.code : "VERSION_INTERNAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    const payload = { ok: false, error: code, message };
    if (error instanceof VersionToolError && Object.keys(error.details).length > 0) payload.details = error.details;
    // 人读信息一律走 stderr；只有显式 --json 时 stdout 才输出一行机器可读 JSON。
    console.error(`${code}: ${message}`);
    if (process.argv.includes("--json")) console.log(JSON.stringify(payload));
    process.exitCode = 1;
  }
}
