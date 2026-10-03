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

## 后续前置条件

Q 批的正式 SQL 初始化、真实 WASM、提交/保存/刷新/回退与后台结算尚待贯通。
R 批未开始；旧三表生产链保留。新地图渲染器仍为独立验证原型。
