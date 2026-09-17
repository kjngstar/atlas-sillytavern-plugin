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

## 与逐字节快照唯一的偏差

`world-schema.ts` 第 6 行的类型引用路径：
上游为 `from "../app/lib/ai-connections"`（跨目录指回 Atlasia 应用），
快照内改为 `from "./ai-connections"`（指本目录内的逐字节副本）。
**仅路径改写，零内容差异**；`ai-connections.ts` 本身逐字节复制。

## 纪律（硬规则）

1. **不在快照里做 Atlas 私有修改**。世界核心的逻辑修复 / 演进一律先改 Atlasia 上游，
   再整体重新快照同步过来（保持"两套项目一套逻辑"）。
2. Atlasia 世界核心有变更时，重新执行快照（逐字节复制 + 上表唯一路径改写），
   并跑全套门禁（build / tsc / tests）证明兼容。
3. 快照版本信息就写在本文件"快照日期"一栏；同步时必须更新它。
