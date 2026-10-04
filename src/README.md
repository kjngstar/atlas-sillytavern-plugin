# Atlas 源码与构建

权威源码为根 `index.js`、`style.css`、`settings.html`、`manifest.json`、`ui/` 和 `src/`。
`atlas-extension/`、根 `dist/` 与 `release/` 由工具生成，不手工修补镜像。

```bash
node tools/sync-mirror.mjs
npm run typecheck
npm run pack
npm test
node tools/audit-source-references.mjs
node tools/verify-sql-release.mjs
```

## 正式运行

浏览器 `index.js` 使用 `src/atlas-browser-entry.ts` 的产物启动；宿主注入按聊天隔离的
SQL provider、模型端口和保存端口。`atlas-production-server` 仅分发设置和 SQL 路由。
Node 插件也注入同一 SQL 运行时，聊天信封原子保存到 `sql-chat:<chatUid>` 文档。
新安装默认启用 SQL；已明确关闭的设置保留为暂停，关闭期间不加载 WASM、不运行旧写者。

回合进入 `atlas-sql-chat` → Repository 隔离候选 → 编译语义操作、时间与后台结算
→ 校验、导出 → 宿主保存确认 → 发布新修订。重试沿用原楼日志，回退撤销原楼及依赖后文。
地图写入、作者纠偏、布局、尺度、底图、导入与修复使用同一候选/保存/回退机制。
只读缓存按聊天、分支、存档修订、快照和资产指纹刷新；失败报告原因，不用旧档覆盖 SQL。

## 职责边界

| 模块 | 职责 |
| --- | --- |
| `ui/atlas-host-context.mjs` | 宿主会话、身份和迟到响应守卫，注入 context 端口 |
| `ui/atlas-sql-view-controller.mjs` | 只读快照连接、视图缓存、失效与关闭 |
| `ui/atlas-scene-ui-adapter.mjs` | 地图、附近和兼容数据的纯只读适配，无 DOM/持久化 |
| `ui/atlas-map-controller.mjs` | 相机、层级栈、手势、弹卡位置、resize 与 cleanup |
| `src/atlas-production-server.ts` | 正式路由分发，拒绝已退出的旧写入口 |
| `src/atlas-server-contract.ts` | 宿主/存储类型契约，独立于旧执行器 |
| `src/atlas-settings-routes.ts` | 设置命令、脱敏响应与访问控制 |
| `src/atlas-sql-routes.ts` | SQL 会话、提交、重试、回退与查询路由 |
| `src/atlas-browser-sql-host.ts` / `atlas-node-sql-host.ts` | 当前聊天 SQL 生命周期和宿主保存桥 |
| `src/atlas-sql-*` / `atlas-db-*` / `atlas-sim-*` | 地图、迁移、提示词、数据库和后台结算 |

`src/atlas-server.ts` 是正式入口的转出门面。原三表执行器已移到
`tests/legacy/atlas-server-fixture.ts`，仅供历史回归；不进入正式源码入口或发布产物。
旧解析器、类型与必要的只读投影保留在迁移/兼容边界，不持续反向写入。
`lib/` 按实际类型、迁移、演示和测试引用保留，来源见 `lib/VENDORED.md`。

Leaflet 地图实验台仍是独立实验；正式渲染复用原网格、相机和房间布局模块。
引用审查区分生产、类型、测试、实验及无法静态解析的引用；它不自动删除文件。

## 验收

发布产物验收必须加载实际 WASM 和真实 SQL 快照，不能只检查文件存在。
正文推演与后台阶段按需要调用模型，重复通知不再请求；预热/预览不调用模型。
世界书按启用条目原顺序与明确预算发送，不按内容筛除；作者视图不扩大正文注入认知范围。
完整施工与实机证据见 `docs/atlas-architecture-cleanup-progress.md`。
