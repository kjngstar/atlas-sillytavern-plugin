# Atlas 源码目录

阿特拉斯 / Atlas 插件的工程源码。运行入口与安装说明见仓库根 `README.md` 与 `atlas-extension/README.md`。

## 命令

在仓库根执行：

```bash
npm install
npm run test        # 全部单测（node:test，--experimental-strip-types）
npm run typecheck   # tsc --noEmit -p tsconfig.json
npm run pack        # 构建并组装 release/ 自包含安装包（同时同步仓库根安装单元）
```

## 结构

```text
阿特拉斯/
  package.json                 # 构建与测试脚本
  tsconfig.json                # 类型检查
  src/
    atlas-contract.ts          # 纯数据契约（稳定错误码与硬上限）
    atlas-relevance.ts         # 相关性核心：附近地点 / NPC 命中原因 / 触发筛选 / 稳定种子
    atlas-turn.ts              # 回合事务：prepare（零 API）与 commit（账本原子采用）
    atlas-server.ts            # 引擎纯 dispatch 核心：路由 / 队列 / RPM / 幂等
    atlas-api-client.ts        # 推演 API 客户端：单请求 / 错误分类 / 草稿解析 / 脱敏
    atlas-ui-core.ts           # UI 核心：状态机 / 事件映射 / 注入编排（宿主无关）
    atlas-lorebook.ts          # 世界书注入层：条目规划 / 严格解析 / 滚动修剪
    atlas-browser-store.ts     # 浏览器侧文档存储（extensionSettings 持久化，有界）
    atlas-browser-entry.ts     # 浏览器打包入口（UI 核心 + 引擎核心导出）
  atlas-extension/             # SillyTavern UI 扩展（manifest / index.js / style.css / settings.html）
  atlas-server-plugin/         # 进阶形态：Server Plugin（文件级数据安全）
  lib/                         # 世界核心快照（来源与同步纪律见 lib/VENDORED.md）
  tests/                       # 单测 / 集成 / 扩展夹具契约测试
  tools/                       # 构建（build.mjs）与打包（pack.mjs）
```

## 模块依赖方向

```text
atlas-extension/index.js ─→ dist/atlas-ui-core.mjs（browser-entry 打包产物）
                              ├─→ src/atlas-ui-core.ts ─→ src/atlas-server.ts ─→ src/atlas-turn.ts
                              ├─→ src/atlas-lorebook.ts          │
                              └─→ src/atlas-browser-store.ts     └─→ src/atlas-api-client.ts
                                                                          src/atlas-relevance.ts
```

世界核心快照只 import、不复制：`lib/world-engine.ts`、`lib/world-npc.ts`、`lib/world-ledger.ts`、
`lib/world-checkpoint.ts`、`lib/world-definition.ts`、`lib/world-schema.ts`、`lib/context-plan.ts`、`lib/world-cards.ts`。

## 纪律

- 推演密钥只存浏览器侧、只经酒馆自带后端代理转发；响应与日志只出脱敏视图。
- 所有契约带 `ATLAS_PROTOCOL_VERSION`，不兼容时拒绝并说明，不静默猜测。
- 错误序列化只允许白名单字段，禁止携带 apiKey / Authorization / 本地绝对路径。
- prepare 零模型请求；一条最终回复的 commit 恰好 1 条请求；重复提交 0 条新请求。
- `lib/` 快照不得做 Atlas 私有修改；核心演进先改上游，再整体重新快照（见 `lib/VENDORED.md`）。
