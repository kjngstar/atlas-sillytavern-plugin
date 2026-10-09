/**
 * atlas-world-build-release.test.mjs — M7-03/M7-04：生产文件与镜像检查（I09 / I10）。
 *
 * I09 生产包无测试故事：build+sync+pack 之后的产物里不许有本包的测试实体名、合成剧情、
 *      fixture 引用；同时必须保留合法的静态渲染常量与生产默认策略。
 * I10 构建门禁完整：每条门禁都真实接在 package.json 上、没有 skip/only；
 *      CSS 保护基线（供给原版）与功能 override 分离；四处版本号一致；
 *      镜像（atlas-extension / release）与源码不缺文件、不落旧文件。
 *
 * 纪律：只读仓库文件，不调用外网，不跑构建（构建由 M7-05 的 checkpoint 负责）。
 *       这里断言的是「产物与源码现在的状态」，所以任何一步漏同步都会在这里变红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// new URL('..', import.meta.url) 在 Windows 上带尾部分隔符；不剥掉会在相对路径里多吃一个字符。
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const at = (...parts) => join(ROOT, ...parts);
const read = (...parts) => readFileSync(at(...parts), 'utf8');
/** 只对文本产物做字符串扫描：把 .woff/.wasm 按 utf8 读会得到替换字符，结论没有意义。 */
const TEXT_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.json', '.html', '.css', '.md', '.txt', '.map', '']);
const isText = (file) => TEXT_EXT.has(extname(file).toLowerCase());

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}
const rel = (path) => path.slice(ROOT.length + 1).replace(/\\/g, '/');

/** 生产产物：用户真正装进酒馆的那几个目录 + 根入口文件。 */
const PRODUCTION_DIRS = ['release/atlas-ui-extension', 'release/atlas-server-plugin', 'atlas-extension', 'atlas-server-plugin', 'dist'];
const productionFiles = [
  ...PRODUCTION_DIRS.flatMap((dir) => walk(at(dir))),
  ...['index.js', 'manifest.json', 'style.css', 'settings.html'].map((name) => at(name)),
].filter((path) => existsSync(path) && isText(path));

/** 本包自己的测试数据：这些字符串出现在生产产物里，就是测试故事泄漏。 */
const FORBIDDEN_IN_PRODUCTION = [
  ['atlas-preview-chronicle', 'dev-preview 专用的演示聊天世界 id'],
  ['演示推演', 'dev-preview 的假推演摘要'],
  ['（演示回复）', 'dev-preview 的假模型回复'],
  ['原版验收世界书', '浏览器门禁的宿主世界书夹具'],
  ['原版接入验收连接', '浏览器门禁的连接预设夹具'],
  ['原版接入验收提示词', '浏览器门禁的提示词夹具'],
  ['空间验收', '浏览器门禁的合成地图名'],
  ['review-shelf', '浏览器门禁的合成家具'],
  ['review-route', '浏览器门禁的合成路线'],
  ['review-water', '浏览器门禁的合成水系'],
  ['tests/fixtures', '测试夹具路径'],
  ['fixtures/atlas-sql', '测试夹具路径'],
  ['karan', '上游示例里被替换掉的旧角色名'],
];

test('I09：生产产物不含本包测试实体名、合成剧情或 fixture 引用', () => {
  assert.ok(productionFiles.length > 40, `生产产物太少（${productionFiles.length}），扫描范围可能写错了`);
  const hits = [];
  for (const file of productionFiles) {
    const text = readFileSync(file, 'utf8');
    for (const [needle, why] of FORBIDDEN_IN_PRODUCTION) {
      if (text.includes(needle)) hits.push(`${rel(file)} 含 ${JSON.stringify(needle)}（${why}）`);
    }
  }
  assert.deepEqual(hits, [], `测试数据泄漏进生产产物：\n${hits.join('\n')}`);
});

test('I09：演示世界模板只来自上游 lib/demo-events.ts —— 不是从测试夹具漏进去的', () => {
  // lib/ 是上游世界核心的逐字节快照，"新手演示模板"是它自带的生产功能，可以出现在包里。
  // 但它必须是**唯一**出处：凡是生产产物里出现的演示地点名，都得能在 lib/demo-events.ts 找到原文。
  const upstream = read('lib', 'demo-events.ts');
  const entry = read('src', 'atlas-browser-entry.ts');
  assert.match(entry, /from\s+"\.\.\/lib\/demo-events\.ts"/, '生产入口必须显式引用上游演示模板模块');
  const demoNames = ['无火大厅', '潮门港', '玻璃温室', '白塔钟座', '雪线驿站', '鲸骨档案馆'];
  const seen = demoNames.filter((name) => productionFiles.some((file) => readFileSync(file, 'utf8').includes(name)));
  assert.ok(seen.length > 0, '演示模板应当随上游核心进入生产包（否则这条规则空转，说明产物不对）');
  for (const name of seen) {
    assert.ok(upstream.includes(name), `生产包里出现演示地点「${name}」，但在 lib/demo-events.ts 里找不到出处 —— 有测试数据绕过了上游模块漏进产物`);
  }
  // 测试夹具与浏览器门禁的合成数据不许出现在 lib/ 快照里（快照要保持逐字节原样）。
  for (const [needle] of FORBIDDEN_IN_PRODUCTION) {
    if (needle === 'karan') continue; // karan 是上游自己的示例名，允许留在快照中
    assert.ok(!upstream.includes(needle), `上游快照 lib/demo-events.ts 被写进了本包测试数据：${needle}`);
  }
});

test('I09：合法的静态渲染常量与生产默认策略必须保留', () => {
  const core = read('dist', 'atlas-ui-core.mjs');
  const sql = read('dist', 'atlas-sql.mjs');
  const entry = read('index.js');
  const required = [
    ['index.js', entry, 'ATLAS_EXTENSION_VERSION', '扩展版本常量'],
    ['dist/atlas-ui-core.mjs', core, '/sql/chat/map/build', '本图建设路由'],
    ['dist/atlas-ui-core.mjs', core, '/sql/upgrade-backup', '升级前备份只读路由'],
    ['dist/atlas-sql.mjs', sql, 'worldCompletion', '世界建设的生产默认策略'],
    ['dist/atlas-sql.mjs', sql, 'OVERVIEW_SURFACE_PAINT', '空间渲染器的静态配色常量'],
  ];
  for (const [where, text, marker, why] of required) {
    assert.ok(text.includes(marker), `${where} 缺少${why} ${JSON.stringify(marker)} —— 构建把该保留的东西删掉了`);
  }
});

test('I09：生产源码里没有 fixture / tests 目录引用', () => {
  const leaks = [];
  for (const file of productionFiles) {
    if (!/\.(mjs|js|cjs|ts)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    const bad = text.match(/(?:from|import|require)\s*\(?\s*["'][^"']*(?:tests\/|fixtures\/|\.\.\/tests)[^"']*["']/g);
    if (bad) leaks.push(`${rel(file)}: ${bad.slice(0, 3).join(' , ')}`);
  }
  assert.deepEqual(leaks, [], `生产代码引用了测试目录：\n${leaks.join('\n')}`);
});

test('I10：每条门禁都真实接在 package.json 上，且测试不许 skip/only', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const script of ['test', 'typecheck', 'build', 'sync', 'pack', 'verify:host-generation']) {
    assert.ok(typeof pkg.scripts?.[script] === 'string' && pkg.scripts[script].trim(), `package.json 缺少门禁脚本 ${script}`);
  }
  const combined = Object.values(pkg.scripts).join(' \n ');
  assert.ok(!/--test-skip-pattern|--skip|--test-only|--test-name-pattern[^"]*\.only/.test(combined), '门禁脚本里不许出现 skip/only 开关');
  assert.ok(existsSync(at('tools', 'verify-reference-browser.mjs')), '真实浏览器门禁必须存在且可执行');
  assert.ok(existsSync(at('tools', 'atlas-release-version.mjs')), '版本同步工具必须存在（M7-07~M7-10 靠它保证四处一致）');

  const offenders = [];
  for (const file of walk(at('tests')).filter((path) => /\.test\.mjs$/.test(path))) {
    const text = readFileSync(file, 'utf8');
    if (/\btest\.skip\b|\btest\.todo\b|\btest\.only\b|\bdescribe\.only\b|\bdescribe\.skip\b/.test(text)) offenders.push(rel(file));
  }
  assert.deepEqual(offenders, [], `测试文件里不许有 skip/todo/only：${offenders.join(', ')}`);
});

test('I10：CSS 保护基线（供给原版）与功能 override 是两层，互不混写', () => {
  const provenance = JSON.parse(read('docs', 'reference-ui', 'provenance.json'));
  assert.deepEqual(Object.keys(provenance.assets).sort(), ['css/atlas.css', 'css/preview.css', 'fonts/atlas-sans.woff'], '供给原版资产清单必须是这三项');
  assert.match(String(provenance.suppliedCommit), /^[0-9a-f]{7,40}$/, '必须记下供给原版最后一次原样入库的提交');
  for (const delta of provenance.auditedDeltas ?? []) {
    assert.ok(delta.file && delta.commit && delta.reason, '每条基线改动都要有文件、提交与原因');
    assert.ok(Array.isArray(delta.linesAdded) && Array.isArray(delta.linesRemoved), '每条基线改动都要逐字列出增删行');
  }
  // 功能 override 必须自己一层，并且真的被页面加载 —— 不许把改动偷偷塞回受保护的基线文件。
  assert.ok(existsSync(at('ui', 'atlas-reference', 'css', 'atlas-world-overrides.css')), '功能 override 必须是独立样式层');
  assert.ok(!Object.keys(provenance.assets).some((file) => file.includes('atlas-world-overrides')), 'override 不能被登记成受保护的供给原版');
  const html = read('ui', 'atlas-reference', 'index.html');
  assert.match(html, /href="css\/atlas-world-overrides\.css"/, 'override 必须被页面真实加载');
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(links.at(-1), 'css/atlas-world-overrides.css', 'override 必须排在原样式之后，才能覆盖原观感');
  for (const href of links) assert.ok(existsSync(at('ui', 'atlas-reference', href)), `${href} 必须真实存在（发布后网络不得 404）`);
});

test('I10：四处版本点一致，release 里打包出来的也是这一版', () => {
  const version = (path, pick = (json) => json.version) => pick(JSON.parse(read(path)));
  const root = version('package.json');
  assert.match(root, /^\d+\.\d+\.\d+$/, '根包版本必须是 x.y.z');
  const points = [
    ['manifest.json', version('manifest.json')],
    ['atlas-extension/manifest.json', version('atlas-extension/manifest.json')],
    ['atlas-server-plugin/package.json', version('atlas-server-plugin/package.json')],
    ['package-lock.json', version('package-lock.json')],
    ['package-lock.json#packages[""]', version('package-lock.json', (json) => json.packages?.['']?.version)],
    ['index.js#ATLAS_EXTENSION_VERSION', (read('index.js').match(/ATLAS_EXTENSION_VERSION\s*=\s*"([^"]+)"/) ?? [])[1]],
    ['atlas-extension/index.js#ATLAS_EXTENSION_VERSION', (read('atlas-extension', 'index.js').match(/ATLAS_EXTENSION_VERSION\s*=\s*"([^"]+)"/) ?? [])[1]],
    ['release/atlas-ui-extension/manifest.json', version('release/atlas-ui-extension/manifest.json')],
    ['release/atlas-server-plugin/package.json', version('release/atlas-server-plugin/package.json')],
  ];
  const drift = points.filter(([, value]) => value !== root).map(([where, value]) => `${where}=${value}`);
  assert.deepEqual(drift, [], `版本号漂移（权威源 package.json=${root}）：${drift.join(', ')}`);
});

test('I10/M7-04：镜像与 release 不缺文件、不落旧文件（新增生产文件必须进镜像）', () => {
  // UI 源码与镜像必须逐文件一一对应，二进制按字节比，文本按内容比。
  const sourceUi = walk(at('ui')).map((path) => rel(path).replace(/^ui\//, '')).sort();
  const mirrorUi = walk(at('atlas-extension', 'ui')).map((path) => rel(path).replace(/^atlas-extension\/ui\//, '')).sort();
  assert.deepEqual(sourceUi, mirrorUi, 'atlas-extension/ui 必须与源码 ui/ 文件清单完全一致（缺文件或落旧文件都不行）');
  for (const name of sourceUi) {
    const a = readFileSync(at('ui', name));
    const b = readFileSync(at('atlas-extension', 'ui', name));
    assert.ok(a.equals(b), `镜像与源码内容不一致：ui/${name}`);
  }
  // 本轮新增的生产文件必须真的在镜像与 release 里。
  for (const name of ['atlas-reference/css/atlas-world-overrides.css', 'atlas-reference-data.mjs', 'atlas-reference-host.mjs']) {
    for (const base of ['atlas-extension/ui', 'release/atlas-ui-extension/ui']) {
      assert.ok(existsSync(at(base, name)), `${base}/${name} 缺失 —— 新增生产文件没进镜像/release`);
    }
  }
  // 根安装单元的三件套：根、镜像、release 逐字节一致。
  for (const name of ['style.css', 'settings.html', 'manifest.json']) {
    const a = readFileSync(at(name));
    assert.ok(a.equals(readFileSync(at('atlas-extension', name))), `${name} 与镜像不一致`);
    assert.ok(a.equals(readFileSync(at('release', 'atlas-ui-extension', name))), `${name} 与 release 不一致`);
  }
  // 入口的 dev 回退行只在源码/镜像出现，release 里必须被剥掉。
  // 注意：注释里提到 ../src 是说明性文字，允许保留；要断言的是**可执行的候选路径数组**里没有它。
  const strip = (text) => text.replace(/const attempts = \["\.\/dist\/atlas-ui-core\.mjs", "\.\.\/src\/atlas-ui-core\.ts"\];/, 'const attempts = ["./dist/atlas-ui-core.mjs"];');
  assert.equal(strip(read('atlas-extension', 'index.js')), read('index.js'), '镜像 index.js 除 dev 回退行外必须与根一致');
  const shippedEntry = read('release', 'atlas-ui-extension', 'index.js');
  const devFallbacks = shippedEntry.match(/[A-Z_]*CANDIDATES\s*=\s*\[[^\]]*\]|attempts\s*=\s*\[[^\]]*\]/g) ?? [];
  assert.ok(devFallbacks.length > 0, 'release 入口里应当能读到候选路径数组（否则这条断言空转）');
  const leaked = devFallbacks.filter((line) => line.includes('../src/'));
  assert.deepEqual(leaked, [], `release 入口的候选路径数组里不许留 dev 回退：${leaked.join(' , ')}`);
});
