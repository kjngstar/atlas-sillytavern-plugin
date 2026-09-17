/**
 * build.mjs — Atlas 构建产物打包（独立项目；不依赖任何上级目录即可运行）。
 *
 * 用 esbuild 把 TS 纯核心打包成组件目录内的自包含 ESM 产物：
 * - src/atlas-browser-entry.ts → atlas-extension/dist/atlas-ui-core.mjs（browser，含引擎与契约）
 * - src/atlas-server.ts        → atlas-server-plugin/dist/atlas-server.mjs（node，含世界核心快照）
 *
 * esbuild 优先本仓库 node_modules（devDependencies），在 Atlasia 工作区内开发时向上兜底；
 * esbuild 不进发布包。打包是复制快照，不修改 lib/ 世界核心快照。
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

function loadEsbuild() {
  // 独立项目：优先本仓库 node_modules（npm install 后），解析不到再沿目录树向上
  // （在 Atlasia 工作区内开发时用上级 node_modules 兜底）。esbuild 不进发布包。
  const localRequire = createRequire(join(root, "package.json"));
  try {
    return localRequire("esbuild");
  } catch {
    const parentRequire = createRequire(join(root, "..", "package.json"));
    try {
      return parentRequire("esbuild");
    } catch {
      throw new Error(
        "未找到 esbuild：请在阿特拉斯仓库根执行 `npm install`（devDependencies 内置 esbuild），" +
          "或在 Atlasia 工作区（E:\\地图）内开发（上级 node_modules 兜底）。",
      );
    }
  }
}

export async function buildAll({ log = () => {} } = {}) {
  const esbuild = loadEsbuild();
  const common = { bundle: true, format: "esm", sourcemap: false, charset: "utf8", logLevel: "silent" };
  await esbuild.build({
    ...common,
    entryPoints: [join(root, "src", "atlas-browser-entry.ts")],
    outfile: join(root, "atlas-extension", "dist", "atlas-ui-core.mjs"),
    platform: "browser",
    target: "es2022",
  });
  log("built atlas-extension/dist/atlas-ui-core.mjs");
  await esbuild.build({
    ...common,
    entryPoints: [join(root, "src", "atlas-server.ts")],
    outfile: join(root, "atlas-server-plugin", "dist", "atlas-server.mjs"),
    platform: "node",
    target: "node18",
  });
  log("built atlas-server-plugin/dist/atlas-server.mjs");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  buildAll({ log: console.log }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
