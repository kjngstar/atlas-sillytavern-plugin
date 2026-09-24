import { readFileSync, writeFileSync } from "node:fs";

const root = "index.js";
const mirror = "atlas-extension/index.js";
const DEV = 'const attempts = ["./dist/atlas-ui-core.mjs", "../src/atlas-ui-core.ts"];';
const SHIP = 'const attempts = ["./dist/atlas-ui-core.mjs"];';
const rootSource = readFileSync(root, "utf8");
if (!rootSource.includes(SHIP)) throw new Error("根 index.js 里找不到打包行，拒绝同步");
writeFileSync(mirror, rootSource.replace(SHIP, DEV));
const strip = (content) => content.replace(DEV, SHIP);
console.log(strip(readFileSync(mirror, "utf8")) === rootSource ? "mirror in sync" : "MISMATCH");
