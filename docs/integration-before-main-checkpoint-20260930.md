# Atlas 0.9.64 合并前验收记录（2026-09-30）

当前修复分支：`codex/atlas-integration-0.9.64`。本记录是合并前检查点；`main` 尚未合并。

| 阶段 | 改动 | 验证结果 |
| --- | --- | --- |
| M1-A | 发布包显式导出世界书选择器；真实宿主请求按当前聊天、正文和用途选书；移除跨请求旧结果缓存；诊断只记录计数和模式。 | 发布包直接导入得到 `function`；宿主适配与纯选择器测试通过。 |
| M1-B | 根据已校验证据及主角最终确切地点决定动向可见性；默认 `/state` 先在服务端过滤隐藏摘要与远方任务，作者视图保留。 | 完整 commit→state 双视图及 DOM 切换测试通过。 |
| M2 | 自动开场、一次模型调用的预览/应用、过期预览 409；地图待定位父图归属和细格人物标点。 | 开场、预览、地图布局和浏览器回放测试通过。 |
| M3 修复 | 真实酒馆发现 `/scene/bootstrap` 缺少会话承载，修复后不再收到 `SESSION_STALE`；子图内位置的概览名称改从子图查找。 | 回归测试与 8000 端口实测确认。 |

干净安装后依次执行 `npm ci`、`npm run typecheck`、`npm run build`、`npm test`、`npm run pack`、`git diff --check`：退出码均为 0；最终 1,332 项测试全部通过。根扩展与 `atlas-extension` 镜像一致，CSS 镜像一致，manifest/package 版本均为 0.9.64，UI 发布包含 wasm。直接导入 `release/atlas-ui-extension/dist/atlas-ui-core.mjs` 的 `selectAtlasLoreSupplement` 得到 `function`。

本地 SillyTavern 8000 实测使用原有的 `atlas-sillytavern-plugin` Git 安装目录，未启动第二个服务端实例。专用测试角色「Atlas 自动化验收 20260930」的一次完整回合记录了：自动开场成功 1 次，3 个地点、2 个人物，普通回合提交和世界书同步成功。模型另有 2 行因 `INFERRED_FIELD_NOT_ALLOWED` 被拒，合法行仍被采纳；这是有记录的部分接受，不是丢失整轮。酒馆主模型该回合响应较长且耗时明显，故没有继续消耗 API 跑第二题材和更多交互场景。

尚未完成的人工门槛：两本百条世界书的真实宿主激活/编辑实验、远方后台动向与送达的真实聊天、swipe/删楼/A-B 切换、地图多层点击与窄屏截图。对应自动测试存在，但不能冒充真实酒馆结果。`main` 合并以这些人工门槛完成为前提。
