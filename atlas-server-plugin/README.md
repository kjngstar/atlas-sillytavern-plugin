# 阿特拉斯 / Atlas — Server Plugin

SillyTavern Server Plugin：同源服务端，承载世界存储、聊天绑定、独立推演 API 与回合事务。**密钥只存在于此插件的 `data/` 目录，任何响应、日志与错误只出脱敏视图。**

## 环境要求

- SillyTavern 当前 release（Server Plugins：`init(router)` / `exit()` / `info` 插件约定）。
- Node.js ≥ 18（安装包自带 `dist/atlas-server.mjs` 构建产物，**无需** TypeScript 运行参数）。

## 端点（全部在 `/api/plugins/atlas/` 之下）

| 方法与路径 | 用途 | 说明 |
| --- | --- | --- |
| `GET /health` | 插件 / 协议版本 | 不含路径、环境变量或密钥 |
| `GET /settings` | 脱敏设置视图 | Key 只返回 `exists` + 尾号 4 位 |
| `PUT /settings` | 保存独立 API 预设 | 已认证（`req.user`）且本机回环，或管理员；否则 `FORBIDDEN` |
| `GET /worlds` | 世界摘要列表 | 只有计数与名称，不含账本 / 记忆 / 正文 |
| `POST /worlds/import` | 显式导入版本化世界 | 同上写策略；必须通过 `parseWorld` schema 校验 |
| `POST /bindings` | 绑定 / 解绑 | `action:"bind"` 带 `binding`；`action:"unbind"` 带 `chatId` |
| `GET /state/:chatId` | 当前状态视图 | 位置 / 游标时间 / 附近 NPC（带命中原因）/ 触发器 / 有界 map 数据 |
| `GET /map/image/:chatId` | 世界底图 dataURL | 无底图返回空 data；独立端点不撑爆 /state |
| `POST /turns/prepare` | 生成前相关性筛选 | **零模型请求**；产出有界注入文本与来源清单 |
| `POST /turns/commit` | 回复后世界推演 | 恰好 **1** 条推演请求；幂等；原子提交 |
| `POST /turns/retry` | 重试失败回合 | 沿用原幂等键；已成功回合返回 `duplicate` |
| `POST /turns/restore` | 恢复预览 | 显式 `checkpointId`；返回 `previewRestore` 有界预览 |
| `POST /map/travel-preview` | 旅行预览 | 只读，不推进时间 |

## 回合纪律

- **prepare 零 API**；一条最终回复的 `commit` 恰好 1 条请求；重复 commit 总计仍 1 条。
- 每聊天**串行队列**：同聊天并发 commit / retry 逐个执行。
- **RPM 保护**：每分钟每预设限额（`settings.rpmLimit`，默认 30），超额直接 `API_RATE_LIMITED` 且 0 fetch。
- 错误分类映射到契约稳定错误码（401/403→`API_AUTH_FAILED`、404→`API_NOT_FOUND`、429→`API_RATE_LIMITED`、超时→`API_TIMEOUT`、断网→`SERVICE_OFFLINE`、非 JSON/损坏草稿→`RESPONSE_MALFORMED`、5xx→`API_REQUEST_FAILED`）。
- 失败回合的原始请求持久化在 `pending/`，崩溃或重启后仍可 retry；成功后原子删除。
- 未配置推演 API 时 commit 返回 `API_NOT_CONFIGURED`，**不假装更新世界**。

## 存储

`data/` 目录 JSON 文档（文档名统一 **base64url 规范编码**，可逆一一映射——`world:a:b` 与 `world:a?b` 等不同合法 ID 绝不落同一文件；0.5.x 及以前的旧编码文件按原规则**兼容读取**，不迁移、不静默覆盖）。写入为**临时文件 + rename 原子替换**——崩溃不留半截 JSON；单文档上限 4MB。

## 写操作身份策略

当前 SillyTavern 的 Express Request 公开 `req.user = { profile, directories }`（不存在 `req.session.userId`）。默认策略：`req.user.profile.handle` 为非空字符串（已认证）且（请求来自本机回环地址 **或** `profile.admin === true`）。可用插件初始化选项 `isLocal` 覆盖。

## 安装

1. 把 **release 打包产物** `release/atlas-server-plugin/` 整目录复制到 SillyTavern 的 `plugins/atlas/`。安装包自带 `dist/atlas-server.mjs`，不需要复制工程源码。
2. `config.yaml` 设置 `enableServerPlugins: true`。
3. 用 SillyTavern 标准命令启动即可（无需 `--experimental-strip-types`）。

## 更新与卸载

- 更新：用新版目录覆盖 `plugins/atlas/`（保留 `data/`）后重启 SillyTavern。
- 卸载：删除 `plugins/atlas/`；如需彻底清除数据，手动删除 `data/` 目录（含世界与绑定，删除前请确认）。

> 这是进阶形态：世界数据落服务端文件（文件级数据安全）。常规使用只需安装 UI 扩展，见 `../atlas-extension/README.md`。
