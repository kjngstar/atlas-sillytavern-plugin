# Atlas 可选 Node 插件

常规浏览器扩展无需额外安装此组件。Node 形态与浏览器共享正式 SQL Repository、模型协议与楼层回退规则。
它从组件内 `dist/atlas-server.mjs`、`dist/atlas-sql.mjs` 和 `dist/vendor/sql-wasm.wasm` 加载，发布包自包含。

按聊天/分支持有 SQL 会话，信封原子保存在 `data/sql-chat:<chatUid>` 对应编码文档。
模型设置和密钥保存在节点设置文档，响应与日志脱敏。SQL 路由需本机登录或部署方认可的管理员。
初始化后可通过 `/sql/chat/*` 提交、定向重试、回退、读取视图、导入和修改地图。
旧 `/turns/*`、`/worlds/import` 等写入口明确拒绝，旧文档保留用于显式迁移读取。
关闭插件调用核心 `closeSqlSessions()` 释放连接。

完整发布验收见 `tests/atlas-packed-replay.test.mjs`，直接加载发布入口和真实 SQLite/WASM，
覆盖导入、模型提交、协议拒绝零写入、行动计划、时间、回退、重开及地图。
版本与安装说明见仓库根 README；源码职责见 `src/README.md`。
