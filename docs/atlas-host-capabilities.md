# Atlas 宿主保存能力（Z01）— 接口形态与待实测标记

> **状态：未执行真实宿主实测。** 本文件只登记本仓库现有代码里可核实的接口形态，
> 以及**必须在目标酒馆/工作台里实测**的项。**不得**把工作台的成功 stub 当成真实酒馆保存证明。

## 1. 仓库内可核实的现状

| 项 | 位置 | 结论 |
| --- | --- | --- |
| 会话写回入口 | `index.js::writeAtlasSession(context, session, expectedChatId, expectedMetadata)` | 写 `chatMetadata.atlas` 后调用 `ctx.saveMetadata()`；失败抛错，不静默返回成功 |
| 保存函数形态 | `context().saveMetadata` | 可选函数；**存在性必须显式探测**（`typeof === 'function'`） |
| 聊天身份 | `context().chatId` | 用于「发起时捕获 / 写回前核对」，防迟到响应覆盖别的聊天 |
| 三表权威 | `chatMetadata.atlas.tables` | 现有权威；SQL 方案把同一次写回扩展出 `atlas.database` 信封字段 |
| 启动/切换事件 | `index.js` 的 `activate` / 事件归一入口 | 见 H05（本任务未改） |

## 2. 本任务新增的宿主端口

`src/atlas-host-port.ts::createAtlasHostPort`：

- `captureAnchor()` → `{chatUid, hostChatId, metadataIdentity, branchId, revision, storageRevision}`；
  `metadataIdentity` 是**进程内对象标识**，不写进 JSON。
- `isCurrent(anchor)` → 写回前核对：聊天身份相同 **且** `chatMetadata` 还是同一个对象。
- `saveCandidate({capturedHostAnchor, prepared, envelope})` → 把信封写入 `chatMetadata.atlas.database`，
  再经 `writeSession`（缺省用 `saveMetadata`）落盘；返回 `saved / requested / failed`：
  - 缺保存函数 → `HOST_SAVE_UNAVAILABLE`（**绝不返回 true**）；
  - 宿主只排队、无完成信号 → `requested`（保留候选并显示「保存待确认」）；
  - 保存中切聊天 → `CHAT_CHANGED`，不回写、不恢复、不覆盖 B 的 metadata。
- `restoreMetadata(...)` → 仅当仍为同聊天、同 `metadataIdentity` 时恢复本次未持久化的值。

自动验证见 `tests/atlas-db-host-port.test.mjs`（T11 10/10）。

## 3. **必须在真实宿主实测**（尚未执行）

| 编号 | 实测项 | 判定标准 | 状态 |
| --- | --- | --- | --- |
| Z01-1 | 目标酒馆读取实际宿主保存函数行为：记录宿主版本、调用函数、返回形态 | 能区分「可等待完成」与「仅排队」 | 未执行 |
| Z01-2 | 写一条合成聊天 `chatMetadata` 标记，正常保存后重开核验 | 标记确实耐久（不是内存对象） | 未执行 |
| Z01-3 | 失败如何暴露：磁盘/权限/切聊天 | 能拿到明确失败信号或明确「未确认」 | 未执行 |
| Z01-4 | 宿主是否提供保存读回（用于按 `snapshotSha256` 核对） | 有/无都要记录；无则保持 `HOST_SAVE_UNCONFIRMED` | 未执行 |
| Z01-5 | 多标签/多设备并发 | 是否具备条件写入；无则限制单一写入者 | 未执行 |

## 4. 明确不能声称的事

- 不能声称「工作台 stub 成功 = 真实酒馆保存成功」。
- 不能声称「HTTP 200 / SQL 提交完成 = 已保存到聊天」。
- 在上述实测完成前，`AtlasHostPort.saveCandidate` 的 `saved` 只代表**调用方核对了
  `metadataIdentity` 与聊天身份并拿到了保存函数的返回**，不代表磁盘耐久性已被独立证明。
