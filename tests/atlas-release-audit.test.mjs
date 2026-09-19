/**
 * atlas-release-audit.test.mjs — ATLAS-07 发布包卫生审计（永久门禁）。
 *
 * 规格（开发规格 README ATLAS-07 验收第 5 条）：
 * - 发布包（根安装单元 + release/）不得包含：API Key、用户数据、本地绝对路径、临时文件。
 * - 根安装单元自包含且版本五处一致（ATLAS-FIX-01 纪律的落地校验）。
 * - 公仓不跟踪内部过程文档（作者 2026-09-18 定的 README 纪律）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 递归收集文件（跳过目录；release 体积有限，全量扫描）。 */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const ROOT_INSTALL_FILES = [
  "manifest.json",
  "index.js",
  "style.css",
  "settings.html",
  "dist/atlas-ui-core.mjs",
];

test("ATLAS-07 根安装单元：五件自包含文件齐全，manifest 版本与包版本一致", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  for (const rel of ROOT_INSTALL_FILES) {
    assert.ok(existsSync(join(root, rel)), `根安装单元缺文件：${rel}`);
  }
  assert.equal(manifest.version, pkg.version, "manifest 版本 = 根包版本");
  assert.equal(manifest.auto_update, false, "auto_update 关闭（更新由作者控制）");
  for (const rel of ["index.js", "style.css"]) {
    assert.equal(manifest[rel === "index.js" ? "js" : "css"], rel, `manifest ${rel === "index.js" ? "js" : "css"} 指向 ${rel}`);
  }
});

test("ATLAS-07 发布包扫描：无 Key 形态串、无本地绝对路径、无临时文件", () => {
  const targets = [
    ...ROOT_INSTALL_FILES.map((rel) => join(root, rel)),
    ...walk(join(root, "release", "atlas-ui-extension")),
    ...walk(join(root, "release", "atlas-server-plugin")),
  ];
  assert.ok(targets.length > 10, "发布包存在（先跑 npm run pack）");
  // sk- 真实密钥形态（占位符 "sk-..." 的点号不匹配）
  const KEY_PATTERN = /sk-[A-Za-z0-9_-]{16,}/;
  // 本地绝对路径（仓库根、Windows 用户目录、unix home）
  const PATH_PATTERNS = [/E:[\\\/]地图/, /C:[\\\/]Users/, /\/home\//, /\/Users\//];
  const TEMP_SUFFIX = [".tmp", ".log", ".bak", ".orig", ".rej"];
  // 并发说明：atlas-integration.test.mjs 会并行执行 tools/pack.mjs（先清空再重建 release/），
  // 与本扫描存在竞态（读到正在被删除/写入的文件 → 假失败）。因此扫描最多重试 3 次：
  // 真违规（密钥形态串 / 绝对路径 / 临时文件）在任一次尝试中都会让断言失败，不会被重试掩盖。
  const scanOnce = () => {
    let scanned = 0;
    for (const file of targets) {
      const rel = relative(root, file);
      const ext = file.slice(file.lastIndexOf("."));
      if (TEMP_SUFFIX.some((s) => ext === s) || file.endsWith(".DS_Store")) {
        assert.fail(`发布包含临时文件：${rel}`);
      }
      if (ext !== ".js" && ext !== ".mjs" && ext !== ".json" && ext !== ".css" && ext !== ".html") continue;
      let text = null;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        return null; // 文件正在被重建 → 本次尝试作废，交给重试
      }
      scanned += 1;
      assert.ok(!KEY_PATTERN.test(text), `发布包含疑似密钥形态串：${rel}`);
      for (const pattern of PATH_PATTERNS) {
        assert.ok(!pattern.test(text), `发布包含本地绝对路径：${rel}（/${pattern.source}/）`);
      }
    }
    return scanned;
  };
  let scanned = null;
  for (let attempt = 0; attempt < 3 && scanned === null; attempt += 1) {
    scanned = scanOnce();
  }
  assert.ok(scanned !== null, "发布包在扫描期间被并行重建（tools/pack.mjs）——请串行运行审计");
  assert.ok(scanned >= 8, `实际扫描文本文件 ${scanned} 个`);
});

test("ATLAS-07 公仓纪律：内部过程文档与参考克隆不入 git", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n");
  const forbidden = [
    "待办计划README.md",
    "验收报告README.md",
    "开发规格README.md",
    "预览环境README.md",
  ];
  for (const name of forbidden) {
    assert.ok(!tracked.includes(name), `公仓不得跟踪 ${name}`);
  }
  assert.ok(!tracked.some((f) => f.startsWith("tools/ref/")), "tools/ref/（shujuku 克隆与纪要）不入公仓");
  for (const rel of ROOT_INSTALL_FILES) {
    assert.ok(tracked.includes(rel), `根安装单元 ${rel} 必须入公仓（链接安装依赖）`);
  }
});
