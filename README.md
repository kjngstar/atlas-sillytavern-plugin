# 阿特拉斯 / Atlas 开发计划

> 文档用途：交给其他 AI 或开发者直接实施。开始工作前必须完整阅读本文件，并先核对当前代码与测试；本文件描述的是目标与验收，不代表功能已经完成。
>
> 项目位置：`E:\地图\阿特拉斯\`。上级目录 `E:\地图\` 是 Atlasia 独立平台；阿特拉斯是其下属的 SillyTavern 适配项目，不建立第二套世界核心。
>
> 更新时间：2026-09-17
>
> 当前状态：**ATLAS-00 ～ 05 + ATLAS-FIX-01 自动测试通过；ATLAS-09 纯浏览器形态实施中。**
>
> 当前执行进度与唯一工作包见 [`待办计划README.md`](./待办计划README.md)。本文件负责长期规格，待办文件负责当前排期；两者不可互相替代。

> **【当前形态（2026-09-17 拍板，09-18 独立化）——读本文其余部分前先看这里】**
>
> **阿特拉斯与 Atlasia 是两个完全独立的项目**：本仓库（`E:\地图\阿特拉斯\`）自包含——世界核心以逐字节快照内嵌在 `lib/`（14 文件，来源与同步纪律见 `lib/VENDORED.md`），构建与测试不依赖 Atlasia 工作区，可单独作为 GitHub 仓库发布。与 Atlasia 的联系 = **同源同逻辑**：核心演进先改 Atlasia 上游，再整体重新快照同步；不在快照里做 Atlas 私有修改。
>
> 发布形态 = **shujuku 式：一个 GitHub 链接装完即玩**。
> - **UI 扩展单件交付**：世界引擎核心（prepare / commit / 相关性 / 账本事务）整体打进扩展，浏览器内进程派发、零网络；世界文档落 `extensionSettings`；推演模型调用走酒馆自带后端代理（`/api/backends/chat-completions/generate`），API 密钥只存浏览器侧。**用户不需要安装 Server Plugin。**
> - **安装 = 单步**：SillyTavern「Install extension」贴发布仓库链接（要求发布仓库根有 `manifest.json`；`release/atlas-ui-extension/` 即发布单元）。详见 `atlas-extension/README.md`。
> - **Server Plugin 保留为进阶形态**（文件级数据安全），代码不删、不再作为发布必需品；其安装说明见 `atlas-server-plugin/README.md`。
> - 本文第 3.1 节"两个组件"、ATLAS-02 / 07 等章节描述的是组件拆分规格与历史工作包，**发布要求以本框为准**；两者冲突时以待办计划README.md 的当前排期为准。

## 1. 产品定义

### 1.1 名称与关系

- **Atlasia**：保留为独立平台，继续承担完整的世界创建、世界观编辑、地图与时间轴管理、人物资料、分支、检查点、世界推演、导入导出和诊断能力。
- **阿特拉斯 / Atlas**：SillyTavern 扩展产品，只把 Atlasia 的地图、世界时间、周边地点、相关 NPC、世界事件触发和独立推演 API 带进酒馆。
- 两者必须共享同一套纯世界逻辑，不允许复制出两套距离算法、时间算法、NPC 位置算法、触发算法或账本规则。

一句话定义：

> **Atlasia 是完整世界平台；阿特拉斯 / Atlas 是这个世界引擎在 SillyTavern 里的轻量驾驶舱。**

### 1.2 核心用户旅程

1. 用户在 SillyTavern 正常打开角色卡与聊天。
2. 点击「阿特拉斯 / Atlas」按钮，为当前聊天绑定一个 Atlas 世界或新建最小世界。
3. 酒馆界面旁出现可收起的阿特拉斯面板，显示当前地点、世界时间、小地图、附近 NPC 和最近世界事件。
4. 用户仍在酒馆原输入框中说话或行动；阿特拉斯不接管酒馆聊天 UI。
5. 每次生成前，阿特拉斯用本地规则筛选本轮相关地点、条目和 NPC，并向酒馆请求注入一份有界上下文。
6. 酒馆主模型正常生成角色回复。
7. 回复完成后，阿特拉斯使用**独立 API 预设**至多调用一次世界推演模型，产生结构化变化草稿。
8. 变化通过 Atlas 世界账本原子写入，更新时间、地点、NPC 状态和记忆；面板给出简短、可展开的「世界发生了什么」。
9. 刷新、切换聊天、重新生成、滑动回复、编辑或删除历史消息后，世界状态仍与对应聊天分支一致。

## 2. 产品边界

### 2.1 阿特拉斯第一版必须提供

- 当前聊天绑定 / 解绑 Atlas 世界。
- 当前地点、地图、相邻地点和路线预览。
- 当前世界时间、最近一次时间推进及原因。
- 当前地点、相邻地点或路线上可能出现的 NPC。
- 按地点、时间、NPC 日程、关系、记忆、关键词和持久化随机种子筛选相关触发。
- 生成前向 SillyTavern 注入有界世界上下文。
- 回复完成后调用独立 API，生成有界、可校验的世界变化。
- 每轮幂等、失败可重试、失败不阻断酒馆正常聊天。
- 消息重新生成 / swipe、编辑、删除后的恢复与分支处理。
- 清楚显示：在线 / 离线、未绑定、准备中、推演中、待重试、已同步。

### 2.2 第一版明确不做

- 不把 Atlasia 完整工作台嵌入酒馆。
- 不复制视觉小说、书籍阅读器、故事编辑器、世界书编辑器或 API 连接库整页 UI。
- 不替代 SillyTavern 的角色卡、聊天记录、输入框、主模型连接和消息渲染。
- 不做无人值守的后台世界自转；只有用户可见的聊天操作或明确按钮可以触发推演。
- 不允许一次聊天回合自动连续调用多个阿特拉斯模型。
- 不允许 UI 扩展直接读取、保存或回传明文 API Key。
- 不在第一版做 Atlasia 与酒馆之间的实时多人协作或云同步。
- 不把 SillyTavern 的 DOM、内部源码路径或未公开模块当作稳定协议。

### 2.3 保留但后移

- 在 Atlasia 独立平台中直接打开同一个酒馆世界进行深度编辑。
- 独立运行而不需要 Atlasia 或 SillyTavern 服务端插件的便携版本。
- 多玩家、云同步、远程托管和账号体系。
- 高级 NPC 日程编辑器、路线动画、地图迷雾、复杂气候模拟。
- 自动长周期世界推演、多 Agent 调度和向量检索。

## 3. 技术架构

### 3.1 一个产品、两个酒馆组件

SillyTavern 的浏览器 UI 扩展不适合保存密钥。阿特拉斯在技术上必须拆成两个组件，但对用户仍作为一个产品发布：

```text
阿特拉斯 / Atlas
├─ Atlas UI Extension
│  ├─ 面板与小地图
│  ├─ 监听酒馆聊天事件
│  ├─ 注入有界世界上下文
│  └─ 调用同源 Atlas Server API
│
└─ Atlas Server Plugin
   ├─ 独立 API 预设与密钥
   ├─ 世界存储与聊天绑定
   ├─ 世界回合事务
   ├─ 幂等、队列、限流与日志脱敏
   └─ 调用共享 Atlasia 世界核心
```

原因与边界：

- 官方文档说明 UI 扩展的 `extensionSettings` 是明文且可被其他扩展访问，因此 API Key 不得放入 UI 扩展。
- Server Plugin 可以建立 `/api/plugins/{id}/...` 路由，适合承担独立 API 与持久化；它不受沙箱保护，所以权限和端点必须保持最小化。
- UI 扩展只调用同一 SillyTavern 服务下的 Atlas Server API，不允许从浏览器直接向任意模型地址发送密钥。

官方参考：

- [SillyTavern UI Extensions](https://docs.sillytavern.app/for-contributors/writing-extensions/)
- [SillyTavern Server Plugins](https://docs.sillytavern.app/for-contributors/server-plugins/)
- [SillyTavern Extensions](https://docs.sillytavern.app/extensions/)

### 3.2 共享世界核心

优先复用现有纯逻辑，不先做全仓重构。只有当酒馆端需要某段能力时，才把它从 UI 或浏览器存储中抽离为无 DOM、无 React、无 localStorage、无明文密钥的纯模块。

首批复用点：

| 能力 | 当前真实实现 | 阿特拉斯用途 |
| --- | --- | --- |
| 距离、地形、旅行耗时 | `lib/world-engine.ts` | 地图点击与移动预览 |
| 周边地点与触发 | `nearbyPoints`、`selectTriggers`、持久化 RNG | 生成前筛选本轮相关内容 |
| NPC 位置与记忆 | `lib/world-npc.ts` | 附近 NPC、人物流转、相关记忆 |
| 世界时间 | `lib/world-engine.ts`、`lib/world-timeline.ts` | 时间显示、推进和变化摘要 |
| 世界账本 | `lib/world-ledger.ts` | 原子采用结构化世界变化 |
| 分支投影 | `lib/world-projection.ts`、`lib/world-lineage.ts` | swipe / 编辑后的分支隔离 |
| 检查点 | `lib/world-checkpoint.ts` | 每条已提交回复的恢复锚点 |
| 上下文装配 | `lib/context-plan.ts` | 有界世界上下文与来源清单 |
| AI 路由 | `app/lib/ai-gateway.ts` | 独立世界推演请求；需抽出服务端安全适配层 |
| 世界存储契约 | `lib/world-repository.ts` | 服务端存储适配，不直接复用浏览器 localStorage |

### 3.3 建议目录

其他 AI 不得一开始搬动全仓。插件专属文件全部放进 `阿特拉斯/`；上级 `lib/world-*.ts` 仍属于 Atlasia 提供的共享世界核心。建议按以下目录增量建立：

```text
阿特拉斯/
  README.md                    # 本开发计划与唯一实施入口
  package.json                 # 插件专项构建、测试和打包命令
  src/
    atlas-contract.ts          # UI Extension ↔ Server Plugin 的纯数据契约
    atlas-chat-sync.ts         # 酒馆消息与检查点 / 分支的纯映射
    atlas-relevance.ts         # 地点 / NPC / 触发候选选择，调用上级世界核心
    atlas-turn.ts              # prepare / commit 的纯事务编排
  atlas-extension/
    manifest.json
    index.js
    style.css
    settings.html
    README.md
  atlas-server-plugin/
    package.json
    index.mjs
    README.md
    data.example.json
  tests/
    atlas-contract.test.mjs
    atlas-chat-sync.test.mjs
    atlas-relevance.test.mjs
    atlas-turn.test.mjs
    atlas-extension-harness.test.mjs
    atlas-server-plugin.test.mjs
```

如 SillyTavern 的插件加载方式要求最终目录不同，可以在构建 / 打包阶段复制产物；不要因此把运行时文件散落进 `app/WorldStudio.tsx`。`阿特拉斯/` 第一版不是独立 Git 仓库，不得在其中另建 `.git`；等共享契约稳定后再决定是否拆仓。

## 4. 数据与接口契约

### 4.1 聊天绑定

UI 扩展只在 SillyTavern `chatMetadata` 中保存少量、不敏感的绑定数据：

```ts
interface AtlasChatBinding {
  schemaVersion: 1;
  enabled: boolean;
  chatId: string;
  characterId?: string | null;
  worldId: string;
  branchId: string | null;
  currentLocationId?: string | null;
  worldTimeCursor: number;
  lastCommittedMessageId?: string | null;
  lastCheckpointId?: string | null;
}
```

要求：

- 完整世界、事件账本、NPC 记忆和 API 配置不得塞入 `chatMetadata`。
- 每次 `CHAT_CHANGED` 后重新读取当前 `chatMetadata`，不得长期缓存旧聊天对象引用。
- 未绑定世界时，插件保持只读空状态，不偷偷创建世界或调用 API。

### 4.2 世界回合：prepare

`prepare` 在酒馆主模型生成前执行，默认**不调用独立 API**，只运行本地确定性筛选。

```ts
interface AtlasTurnPrepareRequest {
  chatId: string;
  messageId: string;
  worldId: string;
  branchId: string | null;
  userText: string;
  recentMessageRefs: Array<{ id: string; role: "user" | "assistant" }>;
}

interface AtlasTurnPrepareResponse {
  turnId: string;
  injectionText: string;
  sourceRefs: string[];
  relevantNpcIds: string[];
  triggerIds: string[];
  currentTime: number;
  currentLocationId: string | null;
  travelPreview?: {
    destinationId: string;
    distance: number;
    estimatedDuration: number;
    factors: string[];
  };
}
```

约束：

- `injectionText` 必须有字符预算和来源清单，不得把整个世界或完整聊天发给主模型。
- 周边与 NPC 候选优先由地点、邻接、路线、时间、日程、分支、关系、记忆、关键词和持久化随机种子决定。
- 相同世界状态、消息 ID 和种子必须得到相同候选结果，便于回退重放。
- `prepare` 失败不能阻断 SillyTavern 主模型生成；UI 显示「本轮未注入阿特拉斯上下文」。

### 4.3 世界回合：commit

`commit` 在完整助手回复保存后执行；默认每条最终助手回复至多产生 **1 次**独立 API 请求。

```ts
interface AtlasTurnCommitRequest {
  turnId: string;
  chatId: string;
  userMessageId: string;
  assistantMessageId: string;
  swipeId?: string | null;
  userText: string;
  assistantText: string;
}

interface AtlasTurnReceipt {
  receiptId: string;
  status: "committed" | "duplicate" | "pending-review" | "failed";
  checkpointId?: string;
  branchId: string | null;
  previousTime: number;
  currentTime: number;
  previousLocationId?: string | null;
  currentLocationId?: string | null;
  triggeredNpcIds: string[];
  adoptedEventIds: string[];
  summary: string;
  retryable: boolean;
}
```

约束：

- 幂等键至少包含 `chatId + userMessageId + assistantMessageId + swipeId`。
- 同一幂等键重复提交必须返回原 receipt，不能再次推进时间或追加事件。
- AI 输出先经过严格解析、引用校验、容量预检和分支校验，再作为单个原子事务写入。
- 失败时不能写入半套时间 / 地点 / 记忆；保留待重试记录和用户可见原因。
- 日志只记录连接 ID、模型名、耗时、响应状态、字符数和脱敏错误；不得记录明文 Key。

### 4.4 建议服务端端点

所有端点位于 `/api/plugins/atlas/`：

| 方法与路径 | 用途 | 安全要求 |
| --- | --- | --- |
| `GET /health` | 插件版本、协议版本、服务状态 | 不返回路径、环境变量或密钥 |
| `GET /settings` | 返回脱敏预设和功能开关 | Key 只返回是否存在和尾号掩码 |
| `PUT /settings` | 保存独立 API 预设 | 仅本机已登录用户；服务端校验 URL 与字段上限 |
| `GET /worlds` | 获取可绑定世界摘要 | 不返回完整世界和记忆 |
| `POST /bindings` | 当前聊天绑定 / 解绑世界 | 校验世界存在；不得静默创建 |
| `GET /state/:chatId` | 当前地图、时间、附近 NPC 摘要 | 有界结果；不返回未来分支事实 |
| `POST /turns/prepare` | 生成前相关性筛选与注入文本 | 默认零 API 调用 |
| `POST /turns/commit` | 回复后独立 API 推演并原子提交 | 单回合至多一次调用；幂等 |
| `POST /turns/retry` | 重试失败的同一回合 | 沿用原幂等键，不生成新回合 |
| `POST /turns/restore` | swipe / 编辑 / 删除时恢复 | 必须返回恢复预览和新分支信息 |
| `POST /map/travel-preview` | 地图目的地预览 | 只读，不推进时间 |

第一版不提供“任意 URL 代理”“执行脚本”“读文件”“返回完整配置”等通用接口。

## 5. 酒馆事件映射

UI 扩展优先使用 `SillyTavern.getContext()`、公开事件和公开上下文能力，不依赖内部模块路径。

| SillyTavern 事件 / 操作 | Atlas 行为 |
| --- | --- |
| `APP_READY` | 初始化面板；只检查 Server Plugin 健康状态 |
| `CHAT_CHANGED` | 重新读取当前聊天绑定和世界摘要 |
| `MESSAGE_SENT` | 建立 pending turn，调用 `prepare`，准备本轮注入 |
| 生成拦截器 | 注入 `prepare.injectionText`；不得写入可见聊天历史 |
| `MESSAGE_RECEIVED` / `GENERATION_ENDED` | 仅在最终回复完整保存后调用 `commit` |
| `GENERATION_STOPPED` / 生成错误 | 放弃 pending turn；不得推进世界 |
| `MESSAGE_SWIPED` | 恢复到该回复之前的检查点，为新 swipe 建立同级分支 |
| `MESSAGE_EDITED` | 显示影响预览；从编辑点恢复并使后续 Atlas receipt 失效 |
| `MESSAGE_DELETED` | 恢复到删除范围之前；不得只删聊天而保留未来世界状态 |
| `CHAT_DELETED` | 默认只解除绑定；删除 Atlas 世界必须在 Atlasia 中单独确认 |

必须验证 SillyTavern 各事件携带的数据形状；官方文档明确指出事件参数并不统一，不能凭名称猜字段。

## 6. 阿特拉斯 UI 要求

### 6.1 入口与布局

- 产品显示名固定为：**阿特拉斯 / Atlas**。
- 扩展内部 ID 建议：`atlas-world-sim`；Server Plugin ID 固定：`atlas`。
- 在扩展菜单和聊天顶部提供一个 Atlas 按钮；不覆盖酒馆原菜单。
- 面板默认收起，展开后为可滚动侧栏或窄屏底部抽屉。
- 不复制 SillyTavern 的源码或像素级 UI；只遵循其主题变量与公开扩展机制。

### 6.2 第一版面板

1. **概览**：世界名、分支、当前位置、世界时间、服务状态。
2. **地图**：小地图、当前位置、相邻地点、路线；缩放只作用于地图画布。
3. **附近**：相关 NPC、出现原因、距离 / 所在区域、是否将注入本轮。
4. **变化**：最近 receipt、时间变化、位置变化、NPC / 事件摘要、失败重试。
5. **设置**：启用开关、世界绑定、独立 API 预设选择、上下文预算、触发强度。

### 6.3 操作规则

- 点击目的地只把建议行动填入酒馆输入框，默认不自动发送。
- 点击 NPC 只显示资料摘要或把“与某人交互”填入输入框，默认不自动发送。
- 用户必须能看到本轮向酒馆主模型注入了哪些来源；默认折叠正文，只显示来源标签和字符数。
- 任何失败都要有文字状态，不能只变颜色或只写控制台。
- 窄屏下保留世界、时间、状态和设置的文字入口；不能只剩无说明图标。
- 主要文字不小于 14px，输入和关键操作原则上不小于 16px；支持键盘与焦点可见。

## 7. 独立 API 策略

### 7.1 默认路由

- 酒馆主模型：继续由 SillyTavern 自己管理，阿特拉斯不改连接。
- Atlas `world-turn`：低成本预设，负责理解本轮行动和结构化世界变化。
- Atlas `major-event`：可选高质量预设，只允许用户明确点击「深度推演」或达到可见阈值时调用。
- 地图距离、时间计算、附近 NPC、关键词触发与持久化随机默认全部本地执行，不消耗 API。

### 7.2 调用纪律

- 一条最终助手回复最多一次 `world-turn` 请求。
- 页面加载、刷新、自动保存、面板展开、切换标签和查看地图均不得触发模型请求。
- 同一聊天同一消息只有一个在途请求；后续请求排队或拒绝，不并发冲击 RPM。
- 请求必须有超时、取消、有限重试和指数退避；重试沿用原幂等键。
- 发送前显示上下文字符数、来源和所用预设；用户可以关闭某一聊天的自动推演。
- API 不可用时酒馆聊天继续工作；Atlas 保持上一稳定状态并显示待重试，不伪造变化。

### 7.3 模型输出

模型只输出有界 JSON 草稿，至少包含：

- `duration`
- `locationChange`
- `npcChanges`
- `memoryDrafts`
- `eventDrafts`
- `triggerResults`
- `summary`

不得允许模型直接指定文件路径、网络 URL、API Key、任意代码或未存在的世界 ID。所有引用必须由服务端映射到已知实体；未知引用拒绝或留为待审阅草稿。

## 8. 实施工作包

### ATLAS-00｜基线冻结与契约（P0）

**目标：** 在不改现有 UI 的前提下确定边界并建立可失败的契约测试。

实施：

1. 新建 `阿特拉斯/src/atlas-contract.ts`，定义 binding、prepare、commit、receipt、错误码和协议版本。
2. 建立 Server Plugin 与 UI Extension 的最小目录和版本号，但不连接真实 API。
3. 为所有请求设置字段长度、数组数量、上下文总字符数上限。
4. 记录当前 Atlasia 全部门禁基线，确认新增目录不会被现有构建误打包。

验收：

- 非法版本、空 ID、超长文本、过量 NPC / 事件、非法状态全部拒绝。
- 契约序列化往返不丢字段，错误不包含 Key。
- Atlasia 现有 `test`、`test:e2e`、`test:e2e:v4`、`lint`、两套 `tsc`、`ui000`、`r3` 和 build 无新增失败。

### ATLAS-01｜共享相关性与回合核心（P0）

**目标：** 不接酒馆也能用纯函数完成“筛选 → 预览 → 提交 / 失败回滚”。

实施：

1. 新建 `阿特拉斯/src/atlas-relevance.ts`，组合 `nearbyPoints`、`charactersAtPoint` / `charactersInRegion`、`selectTriggers`、记忆和分支可见性。
2. 新建 `阿特拉斯/src/atlas-turn.ts`，实现 prepare、commit 预检、幂等收据、原子账本提交。
3. 使用 `deriveActionSeed` 或同级稳定种子；禁止 `Math.random()` 决定权威触发。
4. commit 复用 `adoptPendingProposals` / `appendStateEvent`，不能新建绕过账本的直写路径。

验收：

- 同输入、同状态和同种子结果稳定。
- 相邻 / 路线 NPC 能命中，远处无关 NPC 不注入。
- 未来正史、兄弟 IF、未采用草稿不会泄漏到当前分支。
- 重复 commit 不重复推进时间、地点、记忆或事件。
- 容量失败、非法引用和存储失败均为零部分写入。

### ATLAS-02｜Server Plugin 与独立 API（P0）

**目标：** 建立不向浏览器暴露密钥的同源服务。

实施：

1. 实现 `/health`、`/settings`、`/worlds`、`/bindings`、`/state`、`/turns/prepare`、`/turns/commit`、`/turns/retry`、`/turns/restore`。
2. 把 `app/lib/ai-gateway.ts` 中可复用的路由、解析和错误分类抽为服务端安全模块；Atlasia 原调用方保持兼容。
3. 独立预设与密钥只保存在服务端配置；GET 只返回脱敏信息。
4. 增加每聊天串行队列、超时、取消、RPM 保护、幂等缓存和脱敏日志。
5. 所有数据写入使用临时文件 + 原子替换或等价事务；崩溃不得留下半截 JSON。

验收：

- 浏览器网络响应、`extensionSettings`、`chatMetadata`、控制台和测试快照均找不到明文 Key。
- 模拟 API 覆盖成功、401、403、404、429、超时、非 JSON、部分 JSON 和断网。
- `prepare` 为零模型请求；一条最终回复的 `commit` 恰好 1 请求；重复 commit 仍为总计 1 请求。
- Server Plugin 不可用时返回明确离线状态，不影响酒馆正常聊天。

### ATLAS-03｜UI Extension 外壳与聊天绑定（P0）

**目标：** 在真实 SillyTavern 中安装、打开面板、绑定世界并刷新恢复。

实施：

1. `manifest.json` 显示名设为「阿特拉斯 / Atlas」。
2. 使用 `SillyTavern.getContext()` 初始化；监听 `APP_READY`、`CHAT_CHANGED` 和设置更新。
3. 面板实现概览 / 地图 / 附近 / 变化 / 设置五页，第一批可以是只读真实数据。
4. binding 只存入当前聊天的 `chatMetadata`；切聊天立即重新读取。
5. 提供服务离线、世界不存在、协议不兼容和未绑定的清楚空状态。

验收：

- 安装、启用、停用和卸载不会破坏 SillyTavern 原聊天。
- A / B 两个聊天可绑定不同世界，切换 20 次不串状态。
- 刷新后绑定、面板开关和最近状态恢复。
- 不使用硬编码角色名、世界名、地点或演示计数。

### ATLAS-04｜地图、时间与相关 NPC 面板（P1）

**目标：** 插件的三个核心可视能力真实可用。

实施：

1. 地图复用 Atlasia 的坐标 / 网格 / 缩放语义，但只实现查看、定位、目的地预览。
2. 当前时间取绑定分支运行态，显示最近一次推进值及来源。
3. 附近页显示 NPC 命中原因：同地点 / 相邻 / 路线 / 日程 / 关系 / 关键词 / 随机事件。
4. 地图点击生成旅行预览；确认后只填充酒馆输入框，不自动发送。

验收：

- 地图缩放不把图片推出视口；标记与底图同步变换。
- 从 A 到 B 的网格距离、地形修正和预计耗时与 Atlasia 独立平台同输入结果一致。
- 切分支后时间、位置和 NPC 列表同步变化，兄弟分支不串。
- 390 / 768 / 1024 / 1400px 下可用，无关键入口只剩无说明图标。

### ATLAS-05｜生成前注入与回复后世界推演（P0）

**目标：** 打通一条真实完整回合。

实施：

1. `MESSAGE_SENT` 建 pending turn 并调用 prepare。
2. 使用公开生成拦截能力注入 Atlas 上下文；注入必须是临时上下文，不能变成可见聊天消息。
3. 仅在最终 `MESSAGE_RECEIVED` / `GENERATION_ENDED` 后 commit。
4. 把 receipt 摘要展示在面板中；详细来源与变化可展开。
5. 停止、生成失败和空回复放弃 pending，不推进世界。

验收：

- 主模型实际收到当前地点、时间和相关 NPC，但不收到远处无关 NPC 或未来事实。
- 完整回复后时间 / 地点 / NPC / 事件按 receipt 更新，刷新后仍在。
- 点击停止、主模型失败或 Atlas API 失败均不产生半套变化。
- 同一条回复的重复事件通知不会重复 commit。

### ATLAS-06｜swipe、编辑、删除与分支一致性（P0）

**目标：** 酒馆常用历史操作不会让世界状态漂移。

实施：

1. 每个 committed assistant message 关联 receipt 和检查点。
2. swipe：恢复到回复前检查点，为新的 swipe 建立同级分支；旧结果保留可返回。
3. 编辑：先显示受影响的后续 Atlas 回合数，再恢复并使后续 receipt 失效。
4. 删除：恢复到删除范围前的稳定检查点；默认不永久删除世界历史。
5. Chat 删除只解除绑定；世界删除必须回到 Atlasia 明确确认。

验收：

- 连续 5 次 swipe 不递归生成 `IF: IF:` 名称，不重复推进时间。
- 返回旧 swipe 可恢复当时地点、时间、NPC 状态和记忆。
- 编辑第 3 轮后，第 4～10 轮的旧世界变化不再影响新线，但仍能从历史分支恢复。
- 删除和恢复后刷新，UI 与服务端投影一致。

### ATLAS-07｜打包、安装与完整验收（P1）

**目标：** 让非开发者按 README 完成安装、连接、游玩、停用和恢复。

实施：

1. 为 UI Extension 与 Server Plugin 分别写安装说明，并提供一个总入口 README。
2. 明确 `enableServerPlugins` 要求、版本兼容范围、更新和卸载方式。
3. 提供模拟 API 演示世界，不要求用户先填写付费密钥。
4. 若申请进入 SillyTavern 扩展列表，先确定开源与 libre license；不得未经审查复制第三方代码。
5. 生成可安装发布包，禁止包含用户世界、聊天、API Key、日志和本地绝对路径。

验收：

- 从干净 SillyTavern 实例按文档安装成功。
- 绑定演示世界后完成：查看地图 → 点击目的地 → 输入框出现行动 → 发送 → 回复 → 世界时间推进 → 附近 NPC 变化 → 刷新恢复。
- 停用 Atlas 后酒馆仍正常聊天；重新启用后状态不丢。
- 卸载 UI 扩展不删除世界；卸载 Server Plugin 前给出导出提示。
- 发布包扫描无 Key、用户数据、绝对路径和临时文件。

### ATLAS-08｜Atlasia 联动（后续，不阻塞第一版）

**目标：** 用户可以在独立 Atlasia 中打开同一个插件世界进行深度编辑。

实施前必须先决定：

- 共享单一存储，还是显式导入 / 导出同步。
- 同时打开两端时的写入锁和冲突解决。
- Atlasia 3011 未启动时的降级方式。
- API 预设是否共享；若共享，必须迁移到受控本地服务，不能从浏览器 localStorage 偷读。

第一版推荐**不做双端同时写入**；先提供版本化导出 / 导入或只读打开。

## 9. 完整验收场景

### 场景 A：零 API 基线

1. 安装并启用阿特拉斯。
2. 不配置独立 API，绑定演示世界。
3. 地图、时间、附近 NPC 和旅行预览可用。
4. 酒馆正常聊天；Atlas 明确显示「未配置推演 API」，不假装更新世界。

### 场景 B：正常世界回合

1. 配置模拟 API 预设。
2. 玩家从城门前往集市。
3. prepare 注入城门、集市、路线和可能 NPC。
4. 酒馆生成回复。
5. commit 一次请求，更新时间、位置、事件和相关记忆。
6. 刷新后所有状态保持一致。

### 场景 C：相关 NPC 触发

1. 当前时间满足 NPC 日程，NPC 位于当前地点或路线。
2. prepare 选中该 NPC，并展示命中原因。
3. 远处无关 NPC 不进入上下文。
4. 同一轮回退重放得到相同候选；另一个分支可因状态不同得到不同候选。

### 场景 D：API 失败

1. commit 返回 429 或超时。
2. 酒馆回复保持可见，世界状态不推进。
3. Atlas 显示待重试和错误分类。
4. 重试沿用原幂等键；成功后只写入一次。

### 场景 E：swipe 与编辑

1. 对第 5 轮回复 swipe 三次。
2. 每个结果有独立 receipt / 分支，世界时间不累计三次。
3. 返回第一条 swipe，世界状态恢复为第一条对应投影。
4. 编辑第 3 轮，后续旧结果不再注入新线。

### 场景 F：多聊天隔离

1. 聊天 A 绑定世界 A，聊天 B 绑定世界 B。
2. A 推进时间、移动并触发 NPC。
3. 切到 B，B 的时间、地图、NPC 和请求计数不变。
4. 反复切换并刷新后仍不串线。

## 10. 门禁与测试要求

每个工作包都要记录实际命令、退出码、断言数量和遗留项。最低门禁：

### Atlasia 回归

- `npm run test`
- `npm run test:e2e`
- `npm run test:e2e:v4`
- `npm run lint`
- `npx tsc --noEmit`
- Worker / 服务端对应的第二套 TypeScript 检查
- `node scripts/ui000-verify.mjs`
- `node scripts/r3-verify.mjs`
- `npm run build`

### Atlas 专项

- 契约解析与上下限单测。
- 相关 NPC / 触发筛选的绝对期望值测试。
- prepare 零 API 调用测试。
- commit 单请求、幂等和原子失败测试。
- 401 / 403 / 404 / 429 / 5xx / 超时 / 断网 / 非 JSON 测试。
- 消息事件乱序、重复、取消和跨聊天污染测试。
- swipe / 编辑 / 删除后的检查点与分支测试。
- UI Extension mock harness：真正运行初始化函数并验证事件监听注册与清理。
- Server Plugin 路由测试：认证、字段上限、脱敏、路径隔离和错误码。
- 真实 SillyTavern 人工旅程；自动脚本不能冒充人工安装与交互确认。

真实付费 API 只能在用户明确授权使用指定预设后测试，且结果单独记录，不能用模拟通过冒充真实提供商通过。

## 11. 数据与安全纪律

- 不删除、重置或迁移用户现有 Atlasia 世界，除非先提供可恢复备份并得到明确同意。
- UI Extension 中禁止保存 API Key、密码、Token 或完整世界数据库。
- Server Plugin 的任何 GET 响应禁止返回明文 Key。
- 日志和错误必须脱敏，不打印完整请求正文、角色私密聊天或用户路径。
- 所有输入有长度和数量上限；所有模型输出按不可信数据解析。
- 禁止 `eval`、`Function`、任意脚本执行、任意文件路径和任意网络代理。
- Server Plugin 只注册 `/api/plugins/atlas/` 下的明确端点。
- 所有写入有世界 ID、分支 ID、聊天 ID 和消息 ID 范围校验。
- Atlasia 独立平台与 Atlas 插件的 schema 都必须带版本；不兼容时拒绝并说明，不静默猜测。
- UI 事件监听在停用 / 卸载时必须清理，避免重复监听与一次回复多次提交。

## 12. 开放决策

以下决策可以由实施者提出结论，但必须先写入验收报告再编码：

1. **服务端存储**：第一版使用用户隔离 JSON + 原子替换，还是 SQLite / Drizzle。判断标准是事务、备份、跨用户隔离和安装复杂度，不按“代码量看起来少”决定。
2. **世界来源**：第一版只允许绑定 Server Plugin 内的世界，还是支持从 Atlasia 导入版本化世界包。倾向：先支持显式导入，不做双端实时写。
3. **变化采用策略**：世界推演结果默认自动采用，还是先显示草稿。倾向：低风险时间 / 位置变化可按严格规则自动采用；新增实体、死亡、阵营变化、重大记忆等高影响变化必须待审阅。
4. **swipe 映射**：每个 swipe 都建立分支，还是只有被选为当前回复时才物化。倾向：先保存轻量 receipt，选中并 commit 后物化分支。
5. **API 预设管理 UI**：放在 Atlas Server Plugin 设置页，还是从 Atlasia 导入。无论选择哪种，Key 都不得进入 UI Extension 存储。
6. **官方发布**：是否提交 SillyTavern 扩展列表；若提交，先确定开源许可、仓库拆分方式和维护责任。

## 13. 交接记录格式

其他 AI 每完成一个工作包，只需在本文件顶部状态或单独验收报告中追加以下内容，不要改写历史结论：

```text
工作包：ATLAS-XX
状态：未开始 / 编码中 / 已编码待验收 / 自动测试通过 / 人工验收通过 / 阻塞
改动文件：
完成内容：
未完成内容：
实际运行命令与结果：
发现的真实缺陷：
数据迁移：无 / 有（附恢复包）
真实 API：未调用 / 已经用户授权并调用指定预设
下一步：
```

不得把以下状态混写：

- 写了代码 ≠ 自动测试通过。
- 自动测试通过 ≠ 真实 SillyTavern 安装通过。
- 模拟 API 通过 ≠ 真实提供商通过。
- UI 能显示 ≠ 世界状态真的写入并可恢复。
- 脚本模拟浏览器事件 ≠ 用户人工确认完整旅程。

## 14. 推荐开工顺序

严格按以下顺序推进：

1. `ATLAS-00` 契约与基线。
2. `ATLAS-01` 纯世界回合核心。
3. `ATLAS-02` Server Plugin 和模拟独立 API。
4. `ATLAS-03` UI Extension 与聊天绑定。
5. `ATLAS-04` 地图、时间和相关 NPC 面板。
6. `ATLAS-05` 生成前注入与回复后推演。
7. `ATLAS-06` swipe / 编辑 / 删除一致性。
8. `ATLAS-07` 安装包与完整验收。
9. `ATLAS-08` Atlasia 联动只在第一版稳定后开始。

第一个 AI 应从 **ATLAS-00** 开始，不要先画完整面板，也不要先接真实付费 API。
