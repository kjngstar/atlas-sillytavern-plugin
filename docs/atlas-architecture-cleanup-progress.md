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

## 后续前置条件

Q 批的正式 SQL 初始化、真实 WASM、提交/保存/刷新/回退与后台结算尚待贯通。
R 批未开始；旧三表生产链保留。新地图渲染器仍为独立验证原型。
