# Atlas 0.9.96 日志增强与验收

基线：远端 `main` 提交 `b2c1aa361ba9d3e39ebb37e7a9952a7a204592c2`，已发布 `v0.9.96-rc.1`。
该版本已包含 PR #3 的分批、尺寸和嵌套布局改动。本补丁沿用 0.9.96 的版本号，通过构建标识区分代码；发布新 tag 需单独执行发布流程。

## 本次问题与结果

用户导出的诊断包含 62 条记录，其中大量 `details` 为空。合法接口路径先经过不接受 `/` 的通用原子校验，因此被丢弃；地图回执写入诊断时没有携带逐项问题；模型主动超时在 fetch 包装层被笼统标为网络失败。日志折叠次数也容易被误读为模型调用次数。

现在每次模型发送、收到响应头、最终成功或失败都有结构化记录。超时区分等待响应与读取响应体，保留 `API_TIMEOUT`、设定阈值、取消来源及可观察状态。地图部分失败逐项列出错误码、字段路径和地图指纹，并独立记录保存是否确认。

浏览器验收还发现，建设阶段的业务请求锚点不含完整楼层身份。诊断身份现随本轮局部预算实例显式传递，提取、建设、空间资料和布局可归到同一回合；不会改写业务锚点，也不写入模型提示词或数据库。

日志通知曾参与世界读取缓存键：读库产生新日志，新日志又触发读库。本次将日志增量刷新与世界数据读取分开；新增日志不重建地图或回执详情，日志页保留搜索、等级和展开状态。

## 字段契约

诊断 `schemaVersion` 保持 1，新字段均为可选字段。

| 位置 | 字段 | 含义 |
| --- | --- | --- |
| 顶层 | `pluginVersion` | 插件版本 |
| 顶层 | `buildId` | 运行源码哈希，形如 `build-` 加 16 位十六进制 |
| 顶层 | `buildCommit`, `buildDirty` | 构建时的检出提交及运行源码是否存在本地改动；源码归档无 Git 时可缺省 |
| 顶层 | `chatFingerprint` | 稳定的聊天指纹，捕获于请求发起时 |
| 顶层 | `requestRef` | 一次逻辑模型请求或写接口操作的关联指纹 |
| 顶层 | `errorCode`, `causeCode` | 当前层错误与回执中保留的底层原因，例如 `TURN_FAILED` 与 `API_TIMEOUT` |
| details | `branchRef`, `turnRef`, `batchRef` | 分支、回合、批次指纹 |
| details | `module`, `function`, `stage` | 代码模块、函数和业务阶段 |
| details | `route`, `method` | 精确白名单中的接口路径和方法，拒绝任意 URL、查询参数 |
| details | `mode`, `apiFormat`, `model`, `modelRef` | 连接方式、协议、可安全显示的模型名及模型指纹 |
| details | `timeoutMs`, `maxTokens`, `promptChars`, `requestChars`, `messageCount` | 当前客户端请求参数和输入规模 |
| details | `headersMs`, `bodyMs`, `responseChars`, `finishReason` | 等到响应头、读取响应体的耗时，以及响应规模、明确停止原因 |
| details | `transportAttempt`, `retryKind`, `modelRequests` | 真实发送序号、普通/补交/纠错/兼容重发类别及发送总量 |
| details | `failureStage`, `cancelledBy`, `errorName` | 失败位置、取消来源和安全异常类型，不复制异常原文 |
| details | `issueIndex`, `issueCount`, `schemaPath`, `pathRef`, `rowLine`, `mapRef` | 问题序号、总量、字段路径、完整路径指纹、行号和地图指纹 |
| details | `coreSaved`, `saveConfirmed`, `sceneSaved`, `receiptStatus` | 世界保存确认、可绘制场景保存结果和原生回执状态 |
| details | `baseRevision`, `revision`, `storageRevision`, `changedRows`, `groupCount`, `rejectedGroups` | 修订及回执提供的变更统计 |

字符数量不是 token 计量。`maxTokens:0` 表示客户端未显式发送 `max_tokens`，供应商仍有自身上限。`headersMs` 是响应头等待耗时，不冒充模型首 token 耗时。

## 请求计数和错误关联

- 统计真实模型发送时，只计 `MODEL_REQUEST_STARTED`。纯预览、预算拒绝不产生该事件。
- 同一逻辑请求的兼容重发共享 `requestRef`，`transportAttempt` 从 1 增至 2。每次发送独立记录。
- 阶段补交、格式纠错使用独立请求编号，以同一 `turnRef` 关联。
- 最终模型事件的 `modelRequests` 是该逻辑请求的真实发送量；接口回执中的该字段来自整轮预算记账。二者不应跨事件累加。
- `count` 继续只表示日志折叠条数。错误、警告及模型发送不折叠，健康检查与状态轮询可折叠；不同聊天和状态不能合并。
- `API_CALL_PARTIAL` 可同时带 `coreSaved:true` 和布局问题。接口 HTTP 成功、世界保存成功、布局完成是分别记录的事实。
- HTTP 500 本身不推断保存结果；只有明确的 `coreSaved` 回执才写入保存确认字段。

## 导出与保留

地图及回执问题按不同 `code/path/line/op/group/map` 去重后逐项产生 `REQUEST_ISSUE`，不只保留第一条。动态地图键投影为 `$.maps[*]` 等路径，具体地图以 `mapRef` 定位。

密钥、认证头、端点、提示词和完整模型输出不进入新增诊断。数据库 DTO 和界面最后错误进入显示、复制与导出前还会兜底清除密钥字段、Bearer 和端点文本；构建哈希及关联指纹保留。

没有原始时间的旧界面错误标为 `timestampSource:observed`，同时记录 `observedAt`，避免空时间，也不伪称这是原故障发生时间。

当前会话内存最多保留 2000 条诊断，容量耗尽优先淘汰低等级记录。刷新恢复沿用已有的警告/错误持久化策略；需保留整段过程时应在复现后及时导出。

## 验证

- 最新远端基线重新构建后：2285 项自动测试全部通过，类型检查通过。
- 本补丁：2303 项自动测试全部通过，类型检查、镜像同步和自包含打包通过。
- 新增回归覆盖请求/响应体超时、HTTP 错误、兼容重发、预算拒绝、并发反序完成、聊天切换、地图部分保存、逐项问题、导出脱敏和日志页展开状态。
- 发布包浏览器验证：一轮 4 次正常请求均有独立发送编号，提取、建设、空间资料和布局共享回合指纹；宿主及引擎保存结果一致，仍只保存一次。
- 发布包模拟宿主忽略取消：1000ms 后得到 `API_TIMEOUT`，引擎保留底层原因，实际发送 1 次，保存 0 次。
- 宿主事件浏览器验证：30 项通过。
- 界面浏览器验证：99 项通过，浏览器错误 0 项。

核心命令：`npm test`、`npm run typecheck`、`npm run sync`、`npm run pack`、`node tools/verify-sql-release.mjs`、`node tools/verify-host-generation.mjs`、`node tools/verify-reference-browser.mjs`。
浏览器脚本通过 `ATLAS_CHROME_PATH` 指向本机 Chromium；模型使用本地夹具，尚未访问用户真实供应商 API。

另外补登记了提交 `55c4048` 中已有的窄屏关闭按钮样式变动，修复原版 UI 审计哈希失配；本补丁没有新增该样式改动。
