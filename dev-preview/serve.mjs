/**
 * serve.mjs — Atlas 插件本地预览服务（零依赖，纯 Node）。
 *
 * 用途：双击 preview.bat（或运行 node dev-preview/serve.mjs）后，
 * 在本机起一个静态服务并自动打开浏览器，直接看到真实插件工作台。
 * 为什么需要服务而不是双击 HTML：SillyTavern 扩展是 ES module，
 * file:// 下浏览器会以 CORS 拦截模块加载（插件根本不会启动），
 * 且扩展的 CSS / dist 产物需要同源路径才能加载。
 *
 * 只读静态文件；不做任何写操作。CSS 保持外链 → 用户可以自由改 style.css。
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const startPort = Number(process.env.ATLAS_PREVIEW_PORT ?? 4173);
const openBrowser = process.env.ATLAS_PREVIEW_NO_OPEN !== "1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function prerequisiteReport() {
  const checks = [
    ["atlas-extension/index.js", join(root, "atlas-extension", "index.js")],
    ["atlas-extension/style.css", join(root, "atlas-extension", "style.css")],
    ["atlas-extension/dist/atlas-ui-core.mjs", join(root, "atlas-extension", "dist", "atlas-ui-core.mjs")],
    ["dev-preview/index.html", join(root, "dev-preview", "index.html")],
    ["dev-preview/demo-world.json", join(root, "dev-preview", "demo-world.json")],
  ];
  const missing = checks.filter(([, file]) => !existsSync(file)).map(([label]) => label);
  return missing;
}

async function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]);
  const target = normalize(join(root, clean));
  if (!target.startsWith(root)) return null;
  try {
    const info = await stat(target);
    if (info.isDirectory()) return resolveFile(join(clean, "index.html"));
    return target;
  } catch {
    return null;
  }
}

function startServer(port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer(async (req, res) => {
      const file = await resolveFile(req.url ?? "/");
      if (!file) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404 Not Found");
        return;
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, {
          "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
          "Cache-Control": "no-store",
        });
        res.end(body);
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("500 Read Error");
      }
    });
    server.on("error", rejectPromise);
    server.listen(port, "127.0.0.1", () => resolvePromise(server));
  });
}

async function main() {
  const missing = prerequisiteReport();
  if (missing.length > 0) {
    console.error("[atlas] 缺少预览所需文件：");
    for (const item of missing) console.error("  - " + item);
    if (missing.some((item) => item.includes("dist/"))) {
      console.error("[atlas] dist 产物缺失：请在项目根执行 `node tools/build.mjs` 后重试。");
    }
    process.exitCode = 1;
    return;
  }

  let port = startPort;
  let server = null;
  for (let attempt = 0; attempt < 20 && !server; attempt += 1) {
    try {
      server = await startServer(port);
    } catch (error) {
      if (error && error.code === "EADDRINUSE") {
        port += 1;
        continue;
      }
      throw error;
    }
  }
  if (!server) {
    console.error("[atlas] 连续 20 个端口都被占用，请设置 ATLAS_PREVIEW_PORT 指定端口。");
    process.exitCode = 1;
    return;
  }

  const url = `http://127.0.0.1:${port}/dev-preview/index.html`;
  console.log("");
  console.log("  Atlas 插件本地预览已启动");
  console.log("  工作台预览：" + url);
  console.log("  预览控制面板在悬浮窗右栏「世界变化」下方的虚线框内（正式环境不出现）");
  console.log("  样式表：" + join(root, "atlas-extension", "style.css") + "（改完刷新即可，用户可自定义）");
  console.log("  按 Ctrl+C 结束服务");
  console.log("");

  if (openBrowser) {
    const opener = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    execFile(opener, args, () => {});
  }
}

main().catch((error) => {
  console.error("[atlas] 预览服务启动失败：", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
