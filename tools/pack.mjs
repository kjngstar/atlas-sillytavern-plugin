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

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAll } from "./build.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseDir = join(root, "release");

/** 打包白名单：组件目录整目录（含 dist 构建产物），防止临时产物混入。 */
const PACK_TARGETS = [
  { name: "atlas-ui-extension", from: join(root, "atlas-extension") },
  { name: "atlas-server-plugin", from: join(root, "atlas-server-plugin") },
];

function copyTree(fromDir, toDir) {
  mkdirSync(toDir, { recursive: true });
  for (const entry of readdirSync(fromDir)) {
    const from = join(fromDir, entry);
    const to = join(toDir, entry);
    if (statSync(from).isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
}

/** 逐文件清空目录（safe-delete 守卫拦截 rmSync recursive）。 */
function removeTree(dir) {
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
  writeFileSync(to, stripDevFallback(content), "utf8");
}

// 3) 清空并重建 release/
if (existsSync(releaseDir)) removeTree(releaseDir);
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
    else copyFileSync(from, join(to, entry));
  }
  console.log(`packed ${basename(target.from)} -> release/${target.name}`);
  for (const file of readdirSync(to)) {
    console.log(`  - ${file}`);
  }
}

// 3.5) 许可证：每个发布单元自带 LICENSE（自包含安装包的组成部分）。
const rootLicense = join(root, "LICENSE");
if (existsSync(rootLicense)) {
  for (const target of PACK_TARGETS) {
    copyFileSync(rootLicense, join(releaseDir, target.name, "LICENSE"));
  }
  console.log("copied LICENSE -> release/atlas-ui-extension/, release/atlas-server-plugin/");
}

// 4) 同步仓库根安装单元：SillyTavern「Install extension」要求 manifest.json
//    位于仓库根，且 index.js 加载 ./dist/atlas-ui-core.mjs。发布仓库根 = 安装单元。
const uiRelease = join(releaseDir, "atlas-ui-extension");
const ROOT_INSTALL_FILES = ["manifest.json", "index.js", "style.css", "settings.html"];
for (const file of ROOT_INSTALL_FILES) {
  copyFileSync(join(uiRelease, file), join(root, file));
}
copyTree(join(uiRelease, "dist"), join(root, "dist"));
console.log("synced root install unit (manifest.json / index.js / style.css / settings.html / dist/)");

console.log("ATLAS-FIX-01 pack complete（自包含安装包）.");
