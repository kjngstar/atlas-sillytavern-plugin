# Atlas 专项工程目录

本目录是阿特拉斯 / Atlas 插件的专项工程目录，独立于上级 Atlasia 构建。

## 命令

在 `E:\地图\阿特拉斯\` 下执行：

```bash
npm run test        # 全部单测（node:test，--experimental-strip-types）
npm run typecheck   # tsc --noEmit -p tsconfig.json
npm run pack        # 组装 release/ 可安装骨架副本
```

## 结构

```text
阿特拉斯/
  package.json                 # 阿特拉斯专项脚本
  tsconfig.json                # 阿特拉斯专项类型检查
  src/
    atlas-contract.ts          # UI Extension ↔ Server Plugin 纯数据契约（含稳定错误码与硬上限）
    atlas-relevance.ts         # 相关性核心：附近地点 / NPC 命中原因 / 触发筛选 / 稳定种子
    atlas-turn.ts              # 回合事务：prepare（零 API）与 commit（账本原子采用）
    atlas-api-client.ts        # 独立推演 API 客户端：单请求 / 错误分类 / 草稿解析 / 脱敏
    atlas-server.ts            # Server Plugin 纯 dispatch 核心：12 条路由 / 队列 / RPM / 幂等
  atlas-extension/             # SillyTavern UI 扩展骨架（本包不接真实事件）
  atlas-server-plugin/         # SillyTavern Server Plugin（薄 Express 接线 + 原子文件存储）
  tests/atlas-contract.test.mjs
  tests/atlas-turn.test.mjs
  tests/atlas-server-plugin.test.mjs
  tools/pack.mjs               # 最小打包：复制骨架到 release/
```

## 模块依赖方向

```text
atlas-server-plugin/index.mjs ─→ src/atlas-server.ts ─→ src/atlas-turn.ts ─→ 上级共享世界核心
                                        │                    │
                                        └─→ src/atlas-api-client.ts   src/atlas-relevance.ts
```

共享世界核心只 import、不复制：`lib/world-engine.ts`、`lib/world-npc.ts`、`lib/world-ledger.ts`、
`lib/world-checkpoint.ts`、`lib/world-definition.ts`、`lib/world-schema.ts`、`lib/context-plan.ts`、`lib/world-cards.ts`。

## 纪律（继承自上级 README.md）

- 密钥永不进入 UI Extension 或 `chatMetadata`；Server Plugin 响应与日志只出脱敏视图。
- 所有契约带 `ATLAS_PROTOCOL_VERSION`，不兼容时拒绝并说明，不静默猜测。
- 错误序列化只允许白名单字段，禁止携带 apiKey / Authorization / 本地绝对路径。
- prepare 零模型请求；一条最终回复的 commit 恰好 1 条请求；重复提交 0 条新请求。
- 上级 `lib/world-*.ts` 属于共享世界核心，本目录不得复制其逻辑。
