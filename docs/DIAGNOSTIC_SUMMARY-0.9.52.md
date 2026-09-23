# Atlas 0.9.52 诊断链路摘要（无密钥 / 无原文）

> 本文件是《Atlas 0.9.52 世界推进与地图更新修复施工单》第 5 节要求的交付物：
> 「模型 HTTP 状态 → v2 校验 → 账本回执 → `/state` 地图点」的脱敏诊断摘要。
>
> **脱敏纪律**：全文不含 API Key、不含模型输出正文、不含原始引文、不含角色姓名与聊天 ID。

## 1. 判定链路总览

一次推演从模型返回走到地图可见，要过四道彼此独立的判定。**任何一道通过都不代表下一道通过**，
尤其 HTTP 200 只说明接口处理成功。

```
① 模型 HTTP 状态        →  ok / 401 / 404 / 429 / 5xx / 超时
② 长度截断与正文可解析性 →  finish_reason 是否 length；正文能否取到一个顶层 JSON 对象
③ v2 协议与语义校验      →  字段形状 / 证据包含 / 引用可解析
④ 账本（ledger）校验     →  实体存在 / 字段声明 / 值类型 / 关系值形状
   ↓
⑤ /state 地图点与附近列表
```

**关键纪律**：`HTTP 200 + body.ok` 只表示 ① 通过。是否真正推进世界，必须看回执
`body.data.receipt.status` ∈ `committed` / `duplicate` / `failed`。

## 2. 各阶段信号与对应错误码

| 阶段 | 观察到的信号 | 错误码 | 可重试 | 世界是否变化 |
|---|---|---|---|---|
| ① 无独立预设 | `API_NOT_CONFIGURED` | 同名 | — | 否（不假装更新） |
| ① 鉴权失败 | HTTP 401 / 403 | `API_AUTH_FAILED` | 否 | 否 |
| ① 地址或模型不存在 | HTTP 404 | `API_NOT_FOUND` | 否 | 否 |
| ① 供应商限流 | HTTP 429 | `API_RATE_LIMITED` | 是 | 否（0 fetch） |
| ① 超时 | 等待超过 `timeoutMs` | `API_TIMEOUT` | 是 | 否 |
| ① 上游 5xx | HTTP 5xx | `API_REQUEST_FAILED` | 是 | 否 |
| ② 长度截断 | `finish_reason === "length"` | `RESPONSE_MALFORMED` | 是 | 否（**不从 `<think>` 抢数据**） |
| ② 正文无 JSON | 取不到顶层对象 | `RESPONSE_MALFORMED` | 否 | 否 |
| ② 空回复 | `choices` 为空且 0 补全 | `RESPONSE_MALFORMED` | 否 | 否（供应商安全过滤） |
| ③ v2 校验不过 | `$…` 字段路径 | `RESPONSE_MALFORMED` | 是 | 否（整单拒绝） |
| ④ 账本拒绝 | 关系值 / 字段 / 实体 | 回执 `status:"failed"` | 按回执 | 否（零部分写入） |
| ⑤ 仅地图不显示 | `/state` 有点、地图无点 | — | — | 世界已变，属渲染问题 |

`timeoutMs` 与 `maxTokens` 是**两个独立设置**：有效范围 `1000..120000ms`（缺省 `30000`）
与 `1..65536`。本施工单场景的模型响应耗时约 68–75 秒，验收需把超时设为 `110000`。

## 3. 本次事故的四段现场（脱敏复述）

| 序号 | 观察 | 定位 |
|---|---|---|
| 1 | `/turns/commit` 约 30 秒返回 `504 API_TIMEOUT` | ① 超时路径；无成功模型结果可写入 |
| 2 | `maxTokens=51200` 后约 68 秒 HTTP 200，`/turns/retry` 返回 `502 RESPONSE_MALFORMED` | ② 或 ③；**当时缺少原始校验路径，不能凭日志断言是哪个字段** |
| 3 | 约 75 秒 HTTP 200，`/turns/retry` 也 HTTP 200，但回执 `status:"failed"`、世界时间 `0→0` | ④ 账本拒绝；真因是关系值走 `Number()` 判定 |
| 4 | 更早一次完整响应 `finish_reason:"length"`，`message.content` 只有 `<think>…</think>` | ② 截断；其中多个 JSON 草稿互相矛盾 |

**注意**：诊断里旧字段 `responseChars:1500` 是**截取到 1500 字符片段的长度**，不是模型完整响应长度。
0.9.52 起改为记录真实 `call.text.length`，并新增 `schemaPath`（首个失败字段路径）与
`count`（失败条数），使第 2 类现场可凭日志直接定位，不必再猜。

## 4. 0.9.52 对本链路的改动

- **② 新增截断判定**：`finish_reason` 恰好等于 `length` → `RESPONSE_MALFORMED`（可重试），
  即使正文里恰好含完整 JSON 也不提交；`stop` / 缺失 / `null` 维持原行为。
- **③ 收紧关系值入口**：`relationUpdates[i].value` 必须是非空字符串或有限数字，
  否则报告 `$.relationUpdates[i].value`。不再把 `null` / 布尔 / 对象 / 数组送进应用层。
- **④ 修正账本关系值判定**：`adjustRelation.value` 接受非空字符串或有限数字并**原样落账**。
  旧实现 `!isFinite(Number(value))` 有两个方向的错误：`Number("依赖")` = NaN →
  合法文字关系被整单拒绝；`Number("")` = 0（有限）→ 空关系值反被放过。
- **⑤ 失败回执不再被当成成功**：HTTP 200 + `receipt.status:"failed"` 时展示失败摘要、
  按 `retryable` 保留或清除挂单，且**不刷新地图、不同步世界书**。
- **诊断**：`schemaPath` 正则修正为真正的 JSONPath 形状（旧字符集缺 `$` `[` `]`，
  导致该字段恒为空），并拒绝引文 / URL / 裸密钥借道。

## 5. 分层事实（避免误判）

- **`NaN` / `Infinity` 到不了账本**：JSON 本身不支持，`draftToEffects` 会先以
  `RESPONSE_MALFORMED` 拒绝整单。账本层测试需直接构造 `appendStateEvent` 输入。
- **未知场景 ≠ 未发现地点**：`scene.resolution="unknown"` + `locationRef=null` 时，
  `discoveries.locations` 仍可登记被证据证实的固定地点；玩家**不得**被锚定到目的地。
- **`op=set` 配 `locationRef=null` 始终非法**；去向不明应用 `keep` 或 `clear`。
- **诊断体积**：单条上限 2048 字节，超限则剥离 `details` 并标 `truncated`，**不丢弃整条**
  （安全代码必须留下）。实测当前字段约束下单条理论最大约 788 字节，该阀门不可达。

## 6. 排障对照

| 看到的信号 | 先检查 | 已知判断 |
|---|---|---|
| `504 API_TIMEOUT` | API 预设 `timeoutMs`；`callAtlasWorldTurnApi` | 超时路径；先核对外部网关耗时 |
| `MODEL_HTTP_COMPLETE` 后 `RESPONSE_MALFORMED` | 诊断 `schemaPath`；`atlas-contract-v2.ts` | 看路径，不要猜 |
| HTTP 200 + 回执 `failed` | `world-ledger.ts:validateEffect`；`commitAtlasTurn` | 模型与 JSON 可成功但账本拒绝，以回执为准 |
| `/state` 有点、地图无点 | `/state` 映射与 `index.js` 地图渲染 | 仅在已 `committed` 且 `/state` 确有点时才查 UI |
| `/state` 无新点 | 回执与 `discoveries.locations` | 先看是否登记，不用改地图 CSS |

## 7. 人工验收（未执行）

本摘要为代码侧交付。施工单第 4 节的真机验收（真实酒馆 + 真实模型）**尚未执行**，
清单见 `docs/VERIFICATION.md` 与施工单第 4 节 5 步流程。任何一项失败需回写到对应阶段。
