# 正式入口引用复查（2026-10-04）

审查入口：根 UI、browser/sql/worker 产物入口、正式 SQL 分发器与 Node 插件。
AST 区分运行、类型、测试、实验；计算引用登记为未知，不能据此自动删除。

| 模块 | 可达范围 | 入边数 |
| --- | --- | --- |
| `lib/ai-connections.ts` | production-type, test, experiment | 1 |
| `lib/demo-events.ts` | production, test | 16 |
| `lib/world-cards.ts` | production, test, experiment | 10 |
| `lib/world-checkpoint.ts` | test | 3 |
| `lib/world-definition.ts` | test | 11 |
| `lib/world-engine.ts` | test | 2 |
| `lib/world-ledger.ts` | test | 6 |
| `lib/world-lineage.ts` | test | 3 |
| `lib/world-npc.ts` | test | 4 |
| `lib/world-projection.ts` | test | 1 |
| `lib/world-schema.ts` | production, test, experiment | 56 |
| `lib/world-timepoint.ts` | test | 1 |
| `lib/world-travel.ts` | test | 1 |
| `src/atlas-background.ts` | test | 3 |
| `src/atlas-schedule.ts` | test | 2 |
| `src/atlas-server.ts` | 无静态入边 | 0 |
| `src/atlas-signal-propagation.ts` | production-type, test | 4 |
| `src/atlas-simulation.ts` | production-type, test | 5 |
| `src/atlas-table-delta.ts` | test | 3 |
| `src/atlas-tables.ts` | production-type, test, experiment | 15 |
| `src/atlas-time-intent.ts` | test | 2 |
| `ui/atlas-host-context.mjs` | production, test | 3 |
| `ui/atlas-map-controller.mjs` | production, test | 2 |
| `ui/atlas-scene-ui-adapter.mjs` | production, test | 2 |
| `ui/atlas-sql-view-controller.mjs` | production, test | 1 |

原旧 dispatch 执行器移入 tests/legacy/atlas-server-fixture.ts，仅供历史回归，正式构建入口不引用。
旧后台与三表写者无生产运行入边；必要类型、迁移解析和旧档读取保留。
lib 的十三份现存快照均有引用，未继续删除。LICENSE 和 VENDORED.md 清单保留。

本次登记 120 条无法静态解析的动态引用；审查结果不能替代实际产物和酒馆验证。

生成命令：`node tools/audit-source-references.mjs`。
