# Atlas SQL 迁移验收报告（H17）

本文件逐条记录《Atlas 世界推演数据设计》第 17～20 章的施工与验收状态。
**不以构建成功替代功能验收；未运行的测试一律记为未运行。**

- 基线：`docs/atlas-sql-migration-baseline.md`（HEAD `c070e63`，0.9.60.1，基线测试 **883/883**）。
- 施工分支：`codex/submap-v2`。
- 最终门禁（本机实测）：`npm run typecheck` **0 errors**；`npm test` **1192 / 1192，0 fail，0 skip**；
  `npm run build` 通过；`npm run pack` 通过；发布包扫描（ATLAS-07）通过。
- 新增工具：`tools/atlas-db-benchmark.mjs`（T30）、`tools/atlas-release-version.mjs`（H16）、
  `tools/atlas-input-format-benchmark.mjs`（T31）。

## 0. 运行模式（重要）

SQL 世界数据是**显式 opt-in 模式**，默认**关闭**：

- 关闭时：所有既有路径行为不变，三表（`chatMetadata.atlas.tables`）仍是唯一写入目标。
- 开启时（`extensionSettings.atlas_world_sim.sqlMode = true`，设置页有可见开关）：SQL 是唯一业务写入目标；
  旧 `world` 只能由 SQL **生成只读兼容投影**，绝不回写。
- **任何时刻只有一个写者**，不存在两套权威同时写（§16.1）。

开启方式的实测路径：
1. 浏览器本地模式：`index.js::loadSqlCore()` 懒加载 `dist/atlas-sql.mjs` → `openSqlSession`（只读视图）；
   世界写入走核心路由 `POST /sql/turn`。
2. Node 服务插件模式：`atlas-server-plugin/index.mjs::loadSqlRuntimeForNode()` 优先加载
   `dist/atlas-sql.mjs`（同入口的 node 平台产物）并**注入核心** `sqlRuntime`；
   六个 `/sql/*` 路由已同时登记进核心清单与插件注册表（各 31 条，一致性有测试把关）。

## 1. 已实现并**实际运行通过**的部分

| 章节 | 交付 | 文件 | 验证（实测） |
| --- | --- | --- | --- |
| A01 | 迁移基线 | `docs/atlas-sql-migration-baseline.md` | 人工核对；登记 0.9.59→0.9.60.1 漂移 |
| A02/A03 | 固定依赖 `sql.js@1.14.1` + 锁文件 | `package.json`、`package-lock.json` | `npm ci` 可复现；未手改 integrity |
| A04 | §16.2 常量集中 | `src/atlas-runtime-limits.ts` | 无第二份硬编码（T02） |
| A05 | §16.3 契约 | `src/atlas-ops-contract.ts` | 14 操作 + noop；`allowedOpsForPhase` |
| A06 | SQL 行 / Repository / 宿主端口类型 | `src/atlas-db-contract.ts` | 20 表逐项对应 |
| A07–A28 | 20 表 DDL + 索引 + 约束 + `installSchema` | `src/atlas-db-schema.ts` | **T02 30/30**：恰 20 用户表、复合 FK 跨分支拒绝、零/负坐标合法、单边坐标拒绝、人物不接受 layout、知识持有者互斥、同人双行程拒绝、events occurred 需时刻、false 谣言可无事件、front 唯一、时钟顺序、渠道 recipient 互斥、索引清单、幂等安装 |
| A29/A30 | 行 ↔ SQL 值转换 | `src/atlas-db-codec.ts` | **T03 16/16**：往返、Unicode/单引号/分号/DROP TABLE 不损坏、损坏 JSON 报具体列、NaN/Infinity 拒绝、列序固定 |
| A31 | 创建器补默认 | `src/atlas-db-defaults.ts` | T03：人物 physical_status=unknown / role=npc / importance=supporting，位置全 NULL（不是 0） |
| B01–B04 | sql.js 加载、打开校验、参数绑定 | `src/atlas-db-runtime.ts` | T02-03（FK 读回=1）、T10 |
| B05–B09 | Repository 打开/候选/导出/确认/丢弃 | `src/atlas-db-repository.ts` | **T10 27/27** |
| B10/B11 | 存档信封 | `src/atlas-db-envelope.ts` | T10-14：往返 byte 一致；hash/schema/长度不符拒绝，不清空建世 |
| B12/B13 | Worker RPC 与客户端 | `src/atlas-db-worker.ts` | T10-16/17：方法白名单、迟到响应不更新 UI、超时/取消错误码 |
| B14 | 每聊天串行 + 单写者锁 | `src/atlas-db-queue.ts` | T10-20 |
| B15/H01 | 宿主端口（envelope 落 `chatMetadata.atlas.database`） | `src/atlas-host-port.ts` | **T11 10/10** |
| B16 | 宿主保存适配 | `src/atlas-host-save.ts` | T10-18/19：缺 save 函数 → `HOST_SAVE_UNAVAILABLE`，绝不返回 true |
| B17–B19 | close / prepareMaintenance / rebase | `src/atlas-db-repository.ts` | T10-21：维护只改 outbox，不动 clock/head/revision，不产生新同步任务 |
| C01/C02 | 载荷抽取与解析 | `src/atlas-ops-parser.ts` | **T04 25/25**：P01/P03/P07/P08/P09/P10/P11、空回复 vs noop 可区分、围栏、超限不静默截断、坏数组不救行 |
| C03/C04 | 规范化与最少字段 | `src/atlas-ops-normalize.ts` | T04：自由文本逐字保持、别名、枚举、系统字段剥离、最少字段表 |
| C05/C06 | new: 声明与引用解析 | `src/atlas-ops-refs.ts` | **T05 20/20**：P02 前向引用、P05、P12、确定性 ID（可被 `node:crypto` 独立复算）、歧义不随机挑 |
| C07 | 来源绑定（永不 `QUOTE_REQUIRED`） | `src/atlas-ops-sources.ts` | T05：observe/decision 两条路径；后台因果不搜正文引文 |
| C08/C09 | 一次定向纠错与票据合并 | `src/atlas-ops-repair.ts` | T09 6/6：票据、原 opId 保留、越权拒绝、额度耗尽 |
| C10 | 统一错误码与脱敏 | `src/atlas-ops-errors.ts` | T04 |
| D01–D14 | 14 个语义操作编译器 | `atlas-ops-entities/relations/actions/events/information/geography.ts` | T10 + T08-14/15（真实编译→分组→落库） |
| D15 | 编译编排 | `src/atlas-ops-compile.ts` | T10、T08-15 |
| D16 | `ensureContainerMap` | `src/atlas-ops-geography.ts` | T21-09：同容器只一张 active 子图、教室复用 M2、查询不写库 |
| E01/E02 | 原子分组与拓扑排序 | `src/atlas-ops-groups.ts` | **T08 15/15**：刺杀+死亡不可拆、同地独立事不合并、资源竞争同组、依赖次序、失败依赖 blocked |
| E03 | §7.6 不变量校验 | `src/atlas-db-invariants.ts` | T08-11/12、T10 |
| E04 | 变更日志 | `src/atlas-db-journal.ts` | T08-08/10 |
| E05 | 保存点事务算法 | `src/atlas-db-commit.ts` | T08-06/07/13（回滚仅本组、拒绝可定位） |
| E06 | `prepareTurn` | `src/atlas-db-repository.ts` | T10-03/04/05/06/07/27 |
| E07 | `retryFailedGroups` | `src/atlas-db-retry.ts` | T07-01…04：原位补交 applied；重复补交 duplicate 且 clock/行数不变；新楼后 `replay_required`+`RETRY_BASE_CHANGED` |
| E09 | `prepareRollback` | `src/atlas-db-repository.ts` | T10-12、T28-01/03 |
| E10 | `forkBranch` | `src/atlas-db-branches.ts` | T14-01…05：同 ID 同数量、父子独立、turns 不复制、`BRANCH_EXISTS`/`REF_UNKNOWN`、FK 空 + 20 表 + 身份详情配对 |
| E11–E14 | 迁移动线与落地 | `src/atlas-db-migrate.ts` | **T15 14/14**：数量/ID 不减、entity_keys 齐全、rumors→information+front 且 **knowledge=0**、period 不折秒、mapId 显式换算且坐标不静默丢、重复导入不重插、finalize 幂等 |
| F01 | 时间推导 | `src/atlas-sim-time.ts` | T16：短对话 0、准备睡觉 0、明确 1800、同区间不叠、未知不假装 0 |
| F02–F04 | 速度/行程/推进 | `src/atlas-sim-motion.ts` | T17：§12 数值例（7200s 抵达、停留 120s、剩 13 分钟、不越过 B）、只有 walk 者不被授予飞机速度、森林 ×0.6 只乘一次、无标定 ETA 未知 |
| F05 | 位置解析 + 批量缓存 | `src/atlas-sim-position.ts` | T17-05（乘客随车）、T21-01/02（粗定位名单、精点） |
| F06 | 候选接触机会 | `src/atlas-sim-opportunities.ts` | 60 秒停留门槛、稳定 ID、已知者排除（模块自测 39 项） |
| F07 | 随机抽样 | `src/atlas-sim-random.ts` | T20：同 key 复现、无关 NPC 不扰动、变体换种子、p=0/1 边界 |
| F08 | 行动推进与死亡停摆 | `src/atlas-sim-actions.ts` | T17-06：死亡角色行程/行动停止、保留最后位置 |
| F09/F10 | 传播与投递 | `src/atlas-sim-propagation.ts` | 3600 秒周期、真实到达时间、`(information,location)` 去重、私密不扩散 |
| F11/F12 | 边界调度 | `src/atlas-sim-scheduler.ts` | `nextBoundary` 确定性；无模型端口时停在最早未决边界（catching_up） |
| F13/F14 | 决策/结果上下文 | `src/atlas-sim-decision-context.ts`、`atlas-sim-outcome-context.ts` | A 看不到 B 的 knowledge；outcome 只允许 `event.propose`/`information.propose` |
| G01–G04 | 地图/附近/详情/动向视图 | `src/atlas-db-views.ts` | **T21 12/12** |
| G05/G06 | 主角认知与在场塑造 | `src/atlas-db-knowledge-view.ts` | **T22 8/8** |
| G07 | 分阶段提示词 | `src/atlas-ops-prompts.ts` | T10-15：不夹 SQL、只给该阶段允许操作 |
| G11 | 统一诊断时间线 | `src/atlas-db-views.ts::queryDiagnostics` | T21-11：分页不截断导出 |
| G12–G14 | 世界书同步任务 | `src/atlas-db-outbox.ts` | T28-01/04/05：失败不丢核心、旧 revision superseded、只动 Atlas 条目 |
| H14 | sql.js 产物 + Worker + 本地 wasm | `tools/build.mjs`、`src/atlas-db-assets.ts`、`src/atlas-sql-*.ts` | **T29 6/6**（构建产物真实存在、Worker 是自包含 IIFE、无 CDN、白名单只放行 sql-wasm.js/wasm） |
| H01–H04/H13 | SQL 会话桥 + `/sql/*` 路由 + H04 旧 DTO 适配 | `src/atlas-sql-session.ts`、`src/atlas-db-state-adapter.ts`、`src/atlas-server.ts` | **T12/T13 部分 26/26**：全新聊天建库、宿主失败不发布、`requested` 不报 coreSaved、信封 `chat_uid` 不符 → `CHAT_CHANGED`、损坏信封不建空世界、两聊天隔离、同基版本并发仅一方提交、迁移数量/ID 不减且 `knowledge=0`、500 上限只是有界投影且有精确 droppedCount、`partial` 映射为 `committed`+`rejectedGroups` |
| H13（Node 可达性） | 服务插件注入 SQL 运行时 + 路由登记 | `atlas-server-plugin/index.mjs`、`tools/build.mjs` | **`tests/atlas-sql-node-runtime.test.mjs` 4/4**：发布形态下 `loadAtlasSqlRuntime` 真能载入并给出 `openSqlSession`/`runSqlTurn`/`runSqlRollback`/`persistSqlSession`；31 条路由两表一致；无 repository 时回 `SQL_MODE_DISABLED`/`SQL_RUNTIME_UNAVAILABLE` 而不是 404 |
| H05–H08/H12 | UI 接线（事件归一、地图/附近/日志、DTO 类型） | `index.js`、`settings.html`、`style.css` | **`tests/atlas-sql-ui-wiring.test.mjs` 8/8**：模式关闭时**不加载** sql 产物；核心缺失 → 具名诊断 + 旧渲染器兜底；城市图只出粗定位名单、**零**人物图标，教室子图才有精点与 `±` 范围；空视图替换旧 DOM；日志单时间线且回执错误与同 log id 锚点一致；缩放只改读数、`data-meters-per-cell` 不变；author/pov 投影深相等 |

## 2. 明确**尚未完成**的部分（不得当成已完成）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| H09–H11 | **已在前序版本完成** | 左下角只剩一条固定长度比例尺、网格步长进网格按钮 tooltip、`getVisibleGridPaths`/`computeViewportScaleBar` 单一权威；相关测试 38/38 通过。本轮未重做。 |
| H16 版本同步脚本 | **已完成** | `tools/atlas-release-version.mjs`：发现 **13 个真实版本点**（含 package-lock 根版本 ×2 与 3 个派生产物），默认 patch+1、`--version` 拒绝降/平号（`VERSION_DOWNGRADE_REJECTED`，退出 1，0 文件改动）、预演不改文件（12 文件 SHA-256 逐一核对未变）、原子写 + 写后读回校验、依赖版本有独立 diff 守卫。⚠️ 它每次运行都会警告 `tests/atlas-packed-replay.test.mjs:91` 硬编码了 `0.9.60.1` —— 真正 bump 后需发布负责人同步该字面量（脚本按规矩不改测试）。 |
| T31 格式对照工具 | **已完成（未做真实模型对照）** | `tools/atlas-input-format-benchmark.mjs`：内置 §20.2 的 20 场景、A/B 两组同等任务与最小充分说明、B 组白名单明确拒绝 DDL/PRAGMA/ATTACH/SELECT/DELETE/多语句/无 WHERE UPDATE/未知列（22/22 自检）。**离线模式下所有成功率字段为 `null`（`OFFLINE_REPLAY_NO_MODEL`）**；§20.4 的 60 例门槛只作「目标值」标注。`--live` 因本机无 API 配置而未执行（`LIVE_CONFIG_MISSING`，未写任何文件）。 |
| E15 候选生命周期 | **已完成并接线** | `src/atlas-db-mentions.ts` 是候选唯一权威（256 上限按重要性/时间回收、重试同楼不重复计数、recent 保留最新 8 条、同名不同 `context_key` 两条候选、二次出现只评估）。为让编译器也能用它，E15 新增**只读端口** `reads?: TableReadPort`（`db` 变可选，两者必居其一，否则 `MENTION_READ_SOURCE_REQUIRED`）；`compileCharacterUpsert` 的 watch/auto 两条候选路径现在**委派 E15**，不再有第二份内联实现。（本轮先误把端口 cast 成 db，导致整条 op 退化成 `INTERNAL_ERROR`；已实测到该失败后改成端口方案。） |
| E08 回退计划 | **已完成并接线** | `src/atlas-db-rollback.ts` 的 `planRollback`/`applyRollbackPlan` 是行恢复的唯一权威（逆因果序、受影响后文定位、`ROLLBACK_TOO_LARGE` 明确拒绝不截断、显式 `foreign_key_check`），`prepareRollback` 现在调用它。接线时发现并处理了**契约差异**：E08 的 branches 步骤把 `head` 设为「目标楼的父」（连目标楼一起撤销），而 `prepareRollback` 的既有契约是「撤销目标楼之后的变化、目标楼仍为 head」（被 T10-12 / T28-01 / T25-04 等多组测试固定）。处理方式：**行的恢复交给 E08**，`branches` 指针沿用本函数契约（计划里的 branches 步骤在应用前摘掉，避免两套 head 语义互相覆盖）。 |
| ~~生产运行时不变量快照~~ | **更正：文档没有这项要求** | 我此前两次把「§7.6 要求存档/导出包含结构化不变量快照」当成文档要求，**这是错的**。全文检索 `运行时不变量` / `不变量快照` / `结构化快照` / `不变量状态` 均为 **0 命中**；§7.6 只列了 10 条提交时必须成立的不变量，没有要求把校验状态写进存档。此处不实现该功能（凭空加协议正是文档禁止的）。 |
| 审计列归属（turnIdOf） | **已修** | `src/atlas-ops-entities.ts::turnIdOf` 原来返回 `ctx.anchor.parentTurnId`，导致 `mention_candidates.first_turn_id/last_turn_id`、`createRow` 的 `created_turn_id/updated_turn_id` **系统性偏一楼**。已给 `CompileContext`/`CompileOperationsInput` 增加 `turnId`（本次**正在创建**的楼），仓库在 `compileOperations` 时传入真实 `turnId`；缺省仍退回父楼以兼容旧调用方。 |
| 回退计划的外键安全顺序 | **已修（缺直接复现测试）** | `applyRollbackPlan` 原按 `turn_changes.sequence` 全局逆序应用，而日志顺序不保证「先清引用再删被引用行」：同一楼内「新建地点 + 人物引用它」会先删地点 → `FOREIGN KEY constraint failed`。现在用 SQLite 自己的 `PRAGMA foreign_key_list` 建引用图（不硬编码表关系）做稳定拓扑排序：父行被删除时子步骤先走，父行被重建时父步骤先走，成环则保持原序并由最终 `foreign_key_check` 判定。**注意**：我尝试补一个直接复现该场景的测试，但夹具用法没跑通（`createRow` 签名与 `turns` 必填列），我**删掉了未完成的测试文件**而不是留一个坏文件——因此这条修复目前**没有专门的回归测试**，建议下一轮用真实 turn 提交流程构造该场景。 |
| manual 写入阶段 | **已修** | `prepareTurnInner` 原来把 phase 硬编码为 `observe`，manual 提交 `attention.propose` / `plan.propose` 会得 `UNKNOWN_OPERATION`。现在 manual（作者手动编辑 = 统一写入层）通过 `allowedOps: ATLAS_SEMANTIC_OPS` 按操作本身判定允许集合，自动推演仍严格按 phase 门禁。 |
| 回退后 head 语义 | **未统一（已登记为语义未定）** | 仓库入口 `prepareRollback`：head = 传入的 `targetParentTurnId`；E08 `planRollback`：head = 目标楼的父楼。两者**各自都有测试固定**（T25-03/T10-12/T28-01 vs T14-02/T14-04）。我尝试统一到「head 指向目标楼」→ 同时打破 5 个测试，说明这不是实现 bug 而是**契约未定**；已回退尝试、在两处源码写明差异，并在仓库侧继续摘掉计划里的 `branches` 步骤以避免互相覆盖。**统一需要先定契约再改测试**。 |
 我此前两次把「§7.6 要求存档/导出包含结构化不变量快照」当成文档要求，**这是错的**。对全文检索 `运行时不变量` / `不变量快照` / `结构化快照` / `不变量状态` 均为 **0 命中**；§7.6 只列了 10 条提交时必须成立的不变量，没有要求把校验状态写进存档。此处不实现该功能（凭空加协议正是文档禁止的）。 |
| UI 主线程阻塞实测（§11.3） | **未完成** | §11.3 明确要求记录「DB 原始/编码后字节、加载、相关查询、导出、宿主保存、**UI 主线程阻塞**」。前五项已实测（见 §3），**UI 主线程阻塞没有测量**——只有 Node 侧基准，不等于浏览器主线程。 |
| 检查点 + 增量存档（§11.3） | **按文档结论不做** | §11.3：「第一阶段采用全库单快照减少实现错误，只有测量表明需要时再改成检查点+增量存档」。实测十倍规模 envelope 约 2.1 MB，属可接受范围，因此**保留全库单快照**，未引入第二套权威。 |
| UI 侧不驱动世界写入（刻意） | **设计取舍** | 一次 `/sql/turn` 在同一请求内完成 prepare→宿主确认→发布，候选句柄不跨宿主事件存活；`index.js` 的 `prepareTurn` 只归一身份并返回 `{delegatedTo:'runSqlTurn'}`，`discardPrepared` **诚实地返回 false**，绝不假装丢弃成功、也绝不从 UI 触发第二次世界写入。因此 `stop` 只有「取消本地 pending + 丢弃迟到结果（`SQL_PREPARE_STALE_DROPPED`）」，没有服务端候选丢弃。 |
| §20 真实模型 A/B | **未执行** | 离线回放可跑，**成功率字段一律为 null**；没有任何实测成功率数据。 |
| Z01 / Z02 | **未执行** | 见 `docs/atlas-host-acceptance-manual.md`（可逐步执行手册，非结果）。 |
| 大世界 UI 主线程阻塞测量 | **部分** | 只有 Node 侧基准（§3），没有真实浏览器 UI 阻塞数据。 |

## 3. 实测数据（`tools/atlas-db-benchmark.mjs`）

```text
small（5 图 / 50 人 / 200 物 / 50 楼历史）
  raw DB            495,616 B
  envelope JSON     661,137 B   （sqlite-base64）
  installSchema      94.7 ms    seed 113.9 ms    history 15.7 ms
  export              1.1 ms    encode 4.3 ms    reload 0.7 ms
  mapView           289.5 ms    nearby 15.2 ms   entityDetail 1.4 ms   changes 1.6 ms

large（50 图 / 500 人 / 2000 物 / 1000 楼历史 ≈ 十倍规模）
  raw DB          1,601,536 B
  envelope JSON   2,135,698 B   （base64 约 +33%）
  installSchema      69.0 ms    seed 599.8 ms    history 231.6 ms
  export              1.3 ms    encode 5.1 ms    reload 0.9 ms
  mapView           251.3 ms    nearby 159.5 ms  entityDetail 1.4 ms   changes 4.8 ms
```

说明：`mapView` 的首次实现是逐实体解析位置的 N+1 查询，在 large 规模实测 **24,057 ms**；
改为一次预取（`buildPositionCache`）后降到 **251 ms（约 96 倍）**。这是基准测出来的真实缺陷，
不是预估。存档体积实测为「约 2.1 MB / 十倍规模」——**全库单快照体积增长是真实的**，
§11.3 要求的「实测后再决定是否改检查点+增量」结论是：当前规模可接受，更大规模需要重新测量。

## 4. 施工中修掉的真实缺陷

1. **`entity_keys` 与详情行写入次序**：详情表 `BEFORE INSERT` 触发器校验身份类型，原实现先写详情 → 所有新建实体 `ENTITY_KEY_KIND_MISMATCH`。改为身份先行。
2. **`new:` 声明的确定性 ID 不一致**：`declareRefs` 用裸别名、编译器用 `new:别名` → 同一别名两个 ID，人物指向不存在的地点。已统一。
3. **组间乱序执行导致外键失败**：引用本轮新建实体的组可能先于写方执行。已加「读后写」组依赖。
4. **组边界外键检查位置错误**：`PRAGMA foreign_key_check` 是全局的，中间组看不到后续组的新行。改为整批应用后、COMMIT 前统一显式检查一次。
5. **编译期错误被记成 applied**：坏引用/零变更组原来报 `applied`，回执会把失败包装成全成功。已在组上携带 `opIssues`，坏 op 不写库、整组 `rejected`，有成功组+失败组时回执如实报 `partial`。
6. **短引用顺序不确定**：`selectWhere` 无 `ORDER BY` → 同一轮里「C2」可能指向不同人物。已固定按主键排序。
7. **坐标 CHECK 写反**：`grid_x IS NOT NULL OR map_id IS NULL` 允许多个 map_id、拒绝合法的无坐标点。已改为 `grid_x IS NULL OR map_id IS NOT NULL`。
8. **空库建世外键失败**：`branches`/`turns` 互为外键，原来分两条独立语句。已放入同一事务。
9. **乘客随车解析缺口**：车厢本身没有行程时，原实现不沿父链找回真正在途的载具，乘客被当成「在某地点」。已改为沿父链解析并返回 `in_transit`。
10. **浏览器产物无法打包**：解析器 `import 'node:crypto'` 使 esbuild 打包失败。已改为跨平台 `stableHash`（Node 下仍是真 sha256，浏览器下确定性纯 JS；存档完整性仍走 WebCrypto）。
11. **大世界地图视图 N+1**（见 §3）：24 s → 251 ms。
12. **发布包出现 `/home/` 形态串**：来自 Emscripten 内存虚拟 FS 的默认路径字面量。已把虚拟 FS 前缀规范为相对目录，**没有放宽**发布扫描规则。
13. **sql.js 被拖进 UI 核心包**：`atlas-browser-entry.ts → atlas-server.ts`，只要服务端字面量 `import("./atlas-sql-session.ts")` 就会把 sql.js/wasm 打进 `atlas-ui-core.mjs`（核心包 864 KB → 1.55 MB，发布扫描报 Emscripten 绝对路径）。已改为「优先注入 `sqlRuntime`，否则运行期拼模块名」，核心包回到 864,773 B 且 `initSqlJs` 计数为 0。
14. **`/sql/*` 在发布形态不可达**（本轮最后修掉）：路由只加在插件侧会让核心清单与插件注册表不一致（路由数断言当场变红）；只加在核心侧则插件边界 404。已同时登记两表，并为 Node 模式构建同入口的 `atlas-server-plugin/dist/atlas-sql.mjs` 注入核心——`loadAtlasSqlRuntime` 在**发布形态**下可载入并有测试把关。
15. **Node SQL 产物漏了发布卫生归一**：新增的 `atlas-server-plugin/dist/atlas-sql.mjs` 同样含 Emscripten 虚拟 FS 字面量，未纳入归一列表导致 ATLAS-07 报本地绝对路径。已纳入（规则一致适用，不是放宽）。

## 5. 未运行的验证（明确声明）

- 未运行任何真实付费模型 API 调用（§20 `--live`）；没有首次/修复后成功率数据。
- 未在真实 SillyTavern 中安装本包并走 Z02 全流程。
- 未运行 `tools/atlas-input-format-benchmark.mjs`（T31，尚未创建）。
- 未测量真实浏览器 UI 主线程阻塞（§11.3 要求的一部分）。
- 未做多标签/多设备并发实测（只有进程内串行与 Web Locks 分支的单元验证）。
