# lib/ — 世界核心快照（Vendored World Core）

> 本目录是 **Atlasia 世界核心的逐字节快照**（`app/lib/ai-connections.ts` 除外，它来自
> `app/lib/`）。阿特拉斯是**独立项目**：与 Atlasia 同源同逻辑，但仓库完全独立、自包含，
> 脱离 Atlasia 工作区也能 `npm install && npm test`。

## 快照来源

- 来源项目：Atlasia（`E:\地图\`，非 git 仓库）`lib/` 与 `app/lib/ai-connections.ts`
- 快照日期：**2026-09-18**
- 快照时的 Atlasia 状态：ATLAS-09 收口时的 `E:\地图\lib`（世界核心 P0/W0 主线已完成，
  与 Atlas 143 用例全绿对应）
- 文件清单（14 个）：world-schema / world-cards / world-ledger / world-definition /
  world-lineage / world-npc / world-engine / world-travel / world-checkpoint /
  world-projection / world-timepoint / context-plan / demo-events / ai-connections

## 与逐字节快照的偏差

### 偏差 1（路径改写，零内容差异）

`world-schema.ts` 第 6 行的类型引用路径：
上游为 `from "../app/lib/ai-connections"`（跨目录指回 Atlasia 应用），
快照内改为 `from "./ai-connections"`（指本目录内的逐字节副本）。
**仅路径改写，零内容差异**；`ai-connections.ts` 本身逐字节复制。

### 偏差 2（内容改动，**待回灌上游**）

**引入版本**：0.9.55（v2 子地图 S1）。**涉及文件**：`world-schema.ts` 两处。

- `MapPoint` 新增可选字段 `parentPointId?: number | null`（缺省/null = 世界图根地点）。
- `parseMapPoint` 新增该校验：只接受 null / 缺省或**有限正整数**，
  明确拒绝字符串、负数、0、小数、NaN、Infinity；并原样透传该字段。

**为什么违反纪律 1**：施工单 S1 明确要求在此文件加字段，且「父子关系的权威来源」
必须落在 `World.points`（不得以 `maps:<worldId>` sidecar 的写入成败判定父子关系）。
Atlasia 上游位于 `E:\地图\`，**不是 git 仓库**，本次会话无法改上游再重新快照。

**回灌要求（下次同步快照前必须处理）**：把上述两处改动以同样语义合入 Atlasia
`lib/world-schema.ts`，再整体重新快照；否则本文件将成为「两套项目两套逻辑」的分叉点。
回灌时保持：字段名 `parentPointId`、可选性、正整数校验、旧存档缺字段可读。

## 纪律（硬规则）

1. **不在快照里做 Atlas 私有修改**。世界核心的逻辑修复 / 演进一律先改 Atlasia 上游，
   再整体重新快照同步过来（保持"两套项目一套逻辑"）。
   *例外*：偏差 2 为经施工单明确授权的一次性改动，已在此登记，必须在下次同步时回灌。
2. Atlasia 世界核心有变更时，重新执行快照（逐字节复制 + 上表唯一路径改写），
   并跑全套门禁（build / tsc / tests）证明兼容。
3. 快照版本信息就写在本文件"快照日期"一栏；同步时必须更新它。
4. 任何新的偏差都必须在此登记「引入版本 / 涉及文件 / 为什么违反纪律 / 回灌要求」，
   不允许无声累积。
