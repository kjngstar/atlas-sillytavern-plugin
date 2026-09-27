# Atlas SQL 迁移基线（A01）

本文件记录《Atlas 世界推演数据设计》第 17 章施工开始前的仓库基线。
目的：能区分「本任务之前就存在的改动」与「本任务新增的改动」，并且不声称本机等于远端最新。

## 1. 仓库身份

| 项 | 值 |
| --- | --- |
| 仓库根 | `E:\地图\阿特拉斯` |
| git HEAD | `c070e63827d63a67ec90d9626751d8944c543a0a` |
| HEAD 摘要 | `0.9.60.1：界面补丁（顶栏不再挤压 + 待定位名牌去斜体）` |
| 当前分支 | `codex/submap-v2` |
| 工作树状态 | 干净（`git status --porcelain` 0 行） |
| 插件版本 | `0.9.60.1`（`package.json` / `manifest.json` / `atlas-server-plugin/package.json` 一致） |

设计文档的「源码对照基线」写的是 0.9.59 工作树；本机实际是 **0.9.60.1**，比对照基线新一个补丁版本
（差异为界面补丁，不涉及数据层）。本任务按 0.9.60.1 施工，并登记该漂移：

> BASELINE_DRIFT：设计文档 §15 称对照基线为 0.9.59；本机 HEAD 为 0.9.60.1。

## 2. 基线测试与工具链

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量测试 | `npm test` | **883 pass / 0 fail / 0 skipped**（`tests/*.test.mjs`） |
| typecheck | `npm run typecheck` | 0 errors（`tsconfig.json` 覆盖 `src/**/*.ts`，含 `noUnusedLocals` / `noUnusedParameters`） |
| Node | `node -v` | v22.20.0（`--experimental-strip-types` 可用，测试直接 import `.ts`） |
| npm | `npm -v` | 10.9.3 |
| 宿主 | SillyTavern 扩展（`manifest.json` `minimum_client_version: 1.12.0`） | 真实宿主机未在本任务中运行（见 §5） |

## 3. 新增与本任务的关系

- 本任务新增目录/文件只落在 `src/atlas-db-*.ts`、`src/atlas-ops-*.ts`、`src/atlas-sim-*.ts`、
  `src/atlas-runtime-limits.ts`、`src/atlas-map-grid.ts`（已有）、`src/atlas-scale.ts`（已有）、
  `tests/fixtures/atlas-sql/*`、`tests/atlas-*.test.mjs`、`tools/atlas-*.mjs`、`docs/atlas-sql-*.md`。
- **既有源码不匹配时的处理**：先登记 `BASELINE_DRIFT` 与具体符号，不凭空把不存在的函数当成已经接线。
- 既有未提交改动：无。本任务不清空、不硬重置工作树。

### 3.1 依赖

| 项 | 值 |
| --- | --- |
| 新增依赖 | `sql.js` 精确 `1.14.1`（§16.1 固定基线） |
| 锁文件 | `npm install --package-lock-only` 后 `npm ci` 复核；未手改 integrity |
| 其它依赖 | 不顺带升级（`esbuild` / `jsdom` / `typescript` 保持原版本） |

## 4. 本任务开始前已存在、明确不动的部分

- 旧协议 v1 / v2 执行链与三表权威（`chatMetadata.atlas.tables`）保持原样，本任务不删除、不改名。
- `lib/` 一行未改。
- `index.js`（根入口，435 KB）只在 B15 / H05–H08 指定函数处修改。

## 5. 未执行、不得声称完成的项

以下项在本机无法由自动化证明，本任务只记录、不冒充：

| 项 | 状态 |
| --- | --- |
| Z01 真实酒馆宿主保存能力实测 | 未执行（`docs/atlas-host-capabilities.md` 记录已知接口形态与待实测标记） |
| Z02 真实 SillyTavern 实机安装验收 | 未执行 |
| §20 真实模型 A/B 对照（`--live`） | 未执行；离线回放夹具可用 |
| 远端仓库最新版本比对 | 未执行，本文件只声明本机 HEAD |
