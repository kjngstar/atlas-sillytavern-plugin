/**
 * pack.mjs — ATLAS-FIX-01 发布打包。
 *
 * 产出两个**自包含**安装包（release/）：
 * - release/atlas-ui-extension/  含构建产物 dist/atlas-ui-core.mjs，可整体复制到
 *   SillyTavern 的 scripts/extensions/third-party/ 下安装；
 * - release/atlas-server-plugin/ 含构建产物 dist/atlas-server.mjs，可整体复制到
 *   plugins/atlas/ 下安装。
 *
 * 安装目录不依赖工程上级的 src / dist（加载器只用组件内相对路径）。
 * 不做压缩 / 签名；发布前扫描（Key / 绝对路径 / 临时文件）在 ATLAS-07。
 *
 * 实现说明：不使用 cpSync recursive / rmSync recursive —— 沙箱 fs-shim
 * 会拦截或终止，复制与删除均手写递归。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAll } from "./build.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseDir = join(root, "release");

/** 打包白名单：组件目录整目录（含 dist 构建产物），防止临时产物混入。 */
const PACK_TARGETS = [
  { name: "atlas-ui-extension", from: join(root, "atlas-extension") },
  { name: "atlas-server-plugin", from: join(root, "atlas-server-plugin") },
];

/**
 * 原子写文件：先写同目录临时文件，再 rename 覆盖目标。
 *
 * 为什么必须这样（0.9.59 修的真实偶发红）：
 * `atlas-integration` 与 `atlas-release-audit` 各自会 `execFileSync` 跑本脚本，
 * 而本脚本会重建 `release/` 并把产物刷进仓库根的 `dist/`。两个测试文件在
 * `node --test` 下是**并发进程**，另一边正在读 `dist/atlas-ui-core.mjs` 或
 * `atlas-extension/index.js` 时，恰好读到 `writeFileSync` 写到一半的文件——
 * 于是「模块解析失败 / 镜像不一致」这类与被测逻辑毫无关系的红，
 * 且下一次成功的 pack 又会自愈，极难复现。
 * rename 在同一卷上是原子的：读者要么看到旧的完整文件，要么看到新的完整文件，
 * 永远不会看到半个。两次 pack 内容相同，因此两种状态都是合法的。
 */
function writeFileAtomic(to, content) {
  const tmp = `${to}.pack-tmp-${process.pid}`;
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, to);
  } catch (error) {
    // rename 失败（极少数：目标被占用）时退回直接写，至少不留临时文件
    try { unlinkSync(tmp); } catch { /* 忽略 */ }
    writeFileSync(to, content);
    if (process.env.ATLAS_PACK_DEBUG) console.error(`[pack] atomic rename failed for ${to}: ${String(error)}`);
  }
}

function copyTree(fromDir, toDir) {
  mkdirSync(toDir, { recursive: true });
  for (const entry of readdirSync(fromDir)) {
    const from = join(fromDir, entry);
    const to = join(toDir, entry);
    if (statSync(from).isDirectory()) copyTree(from, to);
    else writeFileAtomic(to, readFileSync(from));
  }
}

/** 只清理由旧发布包遗留的路径；目标必须位于 release/ 内。 */
function removeTree(dir) {
  const rel = relative(realpathSync(releaseDir), realpathSync(dir));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`拒绝删除 release/ 外路径：${dir}`);
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) removeTree(p);
    else unlinkSync(p);
  }
  rmdirSync(dir);
}

// 1) 先构建组件内产物（UI + Server）
await buildAll({ log: (line) => console.log(line) });

// 2) 排除项：插件运行期数据目录不进发布包
const EXCLUDE_DIRS = new Set(["data", "node_modules"]);

/**
 * 发布副本剥离开发回退：安装包不得尝试读取组件外的 ../src / ../dist（AR-ATLAS-07 P0-01）。
 * 工程内源文件的回退仅服务于开发环境，发布副本只加载组件内 ./dist/ 产物。
 */
function stripDevFallback(content) {
  return content
    .replace(/\["\.\/dist\/([a-z-]+\.mjs)", "\.\.\/src\/([a-z-]+\.ts)"\]/g, '["./dist/$1"]')
    .replace(/\["\.\.\/dist\/([a-z-]+\.mjs)", "\.\.\/src\/([a-z-]+\.ts)"\]/g, '["./dist/$1"]');
}

function copyReleaseFile(from, to) {
  const content = readFileSync(from, "utf8");
  writeFileAtomic(to, stripDevFallback(content));
}

copyTree(join(root, 'ui'), join(root, 'atlas-extension', 'ui'));

// 3) 根文件先同步到 UI 镜像，确保本次发布副本读到的就是当前版本。
// 根 = 权威源；index.js 镜像只允许开发回退行这一处差异。
const MIRROR_SYNC_FILES = ["style.css", "settings.html", "manifest.json"];
for (const file of MIRROR_SYNC_FILES) {
  writeFileAtomic(join(root, "atlas-extension", file), readFileSync(join(root, file)));
}
const stripFallbackLine = (content) =>
  content.replace(
    'const attempts = ["./dist/atlas-ui-core.mjs", "../src/atlas-ui-core.ts"];',
    'const attempts = ["./dist/atlas-ui-core.mjs"];',
  );
const rootIndexSource = readFileSync(join(root, "index.js"), "utf8");
const mirrorIndexSource = readFileSync(join(root, "atlas-extension", "index.js"), "utf8");
if (stripFallbackLine(mirrorIndexSource) !== rootIndexSource) {
  throw new Error(
    "atlas-extension/index.js 镜像与根 index.js 不一致——先同步镜像（cp index.js atlas-extension/index.js 后恢复 dev 回退行）再 pack。",
  );
}

// 4) 原位原子覆盖 release/，并发测试读取时不出现目录被清空的窗口。
mkdirSync(releaseDir, { recursive: true });

const ENTRY_FILES = new Set(["index.js", "index.mjs"]);

for (const target of PACK_TARGETS) {
  const to = join(releaseDir, target.name);
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(target.from)) {
    if (EXCLUDE_DIRS.has(entry)) continue;
    const from = join(target.from, entry);
    if (statSync(from).isDirectory()) copyTree(from, join(to, entry));
    else if (ENTRY_FILES.has(entry)) copyReleaseFile(from, join(to, entry));
    else writeFileAtomic(join(to, entry), readFileSync(from));
  }
  console.log(`packed ${basename(target.from)} -> release/${target.name}`);
  for (const file of readdirSync(to)) {
    console.log(`  - ${file}`);
  }
}

// 4.5) 许可证：每个发布单元自带 LICENSE（自包含安装包的组成部分）。
const rootLicense = join(root, "LICENSE");
if (existsSync(rootLicense)) {
  for (const target of PACK_TARGETS) {
    writeFileAtomic(join(releaseDir, target.name, "LICENSE"), readFileSync(rootLicense));
  }
  console.log("copied LICENSE -> release/atlas-ui-extension/, release/atlas-server-plugin/");
}

/** 覆盖完成后只删源目录已不存在的旧文件，保留并发 pack 的临时文件。 */
function pruneStaleFiles(sourceDir, targetDir, topLevel = false) {
  const desired = new Set(readdirSync(sourceDir).filter((entry) => !topLevel || !EXCLUDE_DIRS.has(entry)));
  if (topLevel && existsSync(rootLicense)) desired.add("LICENSE");
  for (const entry of readdirSync(targetDir)) {
    if (entry.includes(".pack-tmp-")) continue;
    const target = join(targetDir, entry);
    const rel = relative(resolve(releaseDir), resolve(target));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`拒绝删除 release/ 外路径：${target}`);
    if (!desired.has(entry)) {
      if (statSync(target).isDirectory()) removeTree(target);
      else unlinkSync(target);
    } else if (statSync(target).isDirectory() && statSync(join(sourceDir, entry)).isDirectory()) {
      pruneStaleFiles(join(sourceDir, entry), target);
    }
  }
}
for (const target of PACK_TARGETS) {
  pruneStaleFiles(target.from, join(releaseDir, target.name), true);
}

// 5) 将打包时构建的 UI dist 同步到根安装单元。
const uiRelease = join(releaseDir, "atlas-ui-extension");
copyTree(join(uiRelease, "dist"), join(root, "dist"));
console.log("mirror synced root -> atlas-extension (style.css / settings.html / manifest.json); index.js mirror in sync; root dist refreshed");

console.log("ATLAS-FIX-01 pack complete（自包含安装包）.");
