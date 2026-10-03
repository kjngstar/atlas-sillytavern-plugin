# 架构收口施工记录

基线：0.9.74 / `1807e5e`。开发分支：`codex/architecture-cleanup`。
依据：用户授权的架构清理顺序 A、B → Q → R → S。

## A01–A08：死代码与快照清单

删除 `src/atlas-identity.ts`、`src/atlas-ops-groups-types.ts`、`lib/context-plan.ts`，
以及根入口私有函数 `tableMapNpcById`、`tableMapObjectById`。
删除前检查源码、测试、工具的导入与调用，未发现实际调用者。
人物引用、地点人物名单、地点物品与持有物品的现有实现保留。
更新 `lib/VENDORED.md` 的 13 文件清单和裁剪记录，原快照日期不变；
从 `src/README.md` 移除已裁剪模块。

执行 `node tools/sync-mirror.mjs`、`npm run typecheck`、`npm run pack`、`npm test`，
退出码均为 0；完整测试 1382/1382，无跳过。未删除任何业务测试。
此批为源码清理，未切换真实酒馆的数据模式，未调用模型。

## B01–B07：说明、断言与引用审查

校正 `atlas-settings.ts` 的协议说明、README 的细图人物与实验状态说明、
源码/生成镜像权威约定，以及分组输入接口的陈旧注释。
删除 CSRF 单测中的永真断言，保留轮换 token 的实际请求检查。
新增 `tools/map-lab/README.md` 和 `tools/audit-source-references.mjs`；
审查使用 TypeScript AST，区分静态、字面量动态、类型和计算引用，登记发布入口。
SQL 后台待接线模块显式登记；未知动态引用不判定为死代码，也不自动删除文件。
`atlas-map-render-model` 的入边仍为测试与实验台。

执行镜像同步、typecheck、pack、map:lab、完整 npm test，退出码均为 0。
完整测试 1383/1383，无跳过；新增审查工具行为测试一项。
报告输出到忽略提交的 `.tmp/cleanup-b-reference-audit.json`。
此批未改存储或 AI 输出协议。

## Q02：真实发布资源加载

`atlas-db-assets.ts` 显式映射 sql.js browser 条件导出的 WASM 名称；
`atlas-db-runtime.ts` 在浏览器与经典 Worker 默认使用本地 vendor 定位器，Node 保留包内定位。
Worker 的资源根从其脚本 URL 解析。两个 sql.js WASM 原文件的 SHA256 相同。
新增 `node tools/verify-sql-release.mjs`：只服务真实 release 文件，不加载酒馆或模型，
不注入 SQL 模块、不拦截资源请求。主线程真实打开 20 表数据库、读回外键为 1；
经典 Worker 真实打开并导出 SQLite。两次 WASM 请求均命中 `/dist/vendor/sql-wasm.wasm`。
打开只读会话没有保存元数据。

typecheck、pack、完整 npm test 均退出 0，1385/1385，无跳过（包含 Q04 的新增用例）。
Q02 的资源验收通过，尚不代表 Q01/Q03 正式回合接通。

## Q04：只读快照身份与迟到查询

只读会话缓存身份包含宿主聊天、分支、存档修订、声明的 SHA256、UI 修订，
并比较实际快照内容与宿主元数据对象。身份变化重新打开数据库、关闭旧会话。
异步打开与视图查询均检查捕获身份；视图缓存使用代次守卫，迟到结果不更新新作用域。
关闭 SQL 模式清理只读会话与缓存；只读会话保存端口明确拒绝写入。

新增真实 sql.js 快照接入真实 renderPanel 的测试：修订 0→1、同修订替换快照，
地图读到新地点且附近读到新人物；同快照切页不重复打开；延迟查询在切聊天后被丢弃。
这里的宿主 DOM 是 jsdom、素材是合成测试存档，不是用户真实聊天。
WASM 在真实发布目录中的验证由 Q02 独立浏览器测试覆盖。
镜像同步、pack、typecheck、完整测试均退出 0；1385/1385，无跳过。

## Q01：正式宿主初始化接线（初始化与保存端口完成，模型端口待 Q03）

正式 `index.js → connectAtlas → createAtlasServerCore` 注入 `createBrowserSqlHost` 的懒加载
会话提供者。Repository 由它按捕获的聊天、分支和快照创建，不在测试里手工注入。
关闭 SQL 时不加载运行时；保存前核验实时宿主身份，保存返回 false 或抛错不确认成功。
增加实时快照守卫：模型等待期间同聊天存档被外部更新，候选也不能覆盖它。
重试、回退、维护保存后的快照缓存同步确认；关闭未初始化的引擎不触发 SQL 加载。

发布浏览器验证实际导入 release 的原 `index.js` 并调用 `connectAtlas`，宿主用内存合成
上下文代替酒馆全局；SQL 关闭零 WASM 请求，开启后手动语义操作保存一次真实数据库。
没有注入 Repository、SQL 模块或伪造 WASM 资源。这里不是用户本机酒馆/API 的实测。
新增 5 项宿主生命周期测试：关闭零加载、真实 Repository 创建/复用、打开时切聊天、
旧档禁止空库覆盖、模型等待中外部存档更新拒绝旧候选。

typecheck、pack、真实发布浏览器验证均退出 0；完整测试 1390/1390，无跳过。
此时自动聊天仍走旧三表；正式 SQL 模型端口和提示词/提交分流在 Q03 中完成。
含旧世界且没有 SQL 信封的聊天当前报 `SQL_MIGRATION_REQUIRED`；单向迁移待 Q08。
禁止把手动 SQL 操作验收当作自动聊天提交验收。

## 后续前置条件

Q03 自动提交/提示词适配/重试/回退、Q05 后台结算、Q06 统一视图、Q07 地图写入和 Q08 迁移尚待完成。
R 批未开始；旧三表生产链保留。新地图渲染器仍为独立验证原型。
