# 原版 UI 接入验收 · 0.9.77

## 实际接入方式

正式 `index.js` 只挂载 `mountReferenceUi`。原版 HTML、样式、字体、地图与页面控制器在独立文档中运行，通过宿主端口读取 SQL、设置和世界书。独立文档隔离酒馆与历史样式对原版配色、布局的影响。

原始模板保存于 `docs/reference-ui/original-template.html.txt`。正式文档以它为基础替换演示启动脚本和演示文案。控制器的改动集中在数据查询、实际动作、持久化、异步作用域守卫，以及真实空间单位与路线的转换。演示人物移动、演示回执和演示重置代码已移除。

CSS 和字体哈希保持与用户提供的原包一致；`.gitattributes` 保证 Windows 检出时也保持这些资产的原始字节。

## 运行验收

```text
npm run typecheck
npm test
npm run pack
npm run verify:workbench
node tools/verify-sql-release.mjs
```

预期结果：完整测试 1608 项通过；原版接线单测 27 项通过；实际安装目录的 Chrome 检查 47 项通过；无浏览器错误。SQL 发布验证涵盖真正的 WASM 和 Worker。

浏览器脚本会启动隔离的本地预览，将预览中的插件路径替换为 `release/atlas-ui-extension`。城市与楼层夹具经过正式空间生成器生成，再保存到临时聊天 SQL 数据库中；原版界面经正式 scene 查询读取这些结果。测试不接触用户的真实聊天数据，也不调用真实外部模型。

证据输出位于 `.tmp/reference-browser/`，包括 `evidence.json`、桌面、窄屏、楼层和城市截图；该目录不进入安装包。

## 历史测试的处理

旧 DOM 布局、96px 标尺、SVG 网格和旧浮动详情面板的断言不适用于原版 UI。历史 renderer 被移入 `tests/fixtures/legacy-ui/`，旧 jsdom harness 明确使用该夹具，继续覆盖历史兼容行为和共享宿主接口。正式挂载冒烟与当前入口断言已经改为新接入；新 UI 的实际样式、canvas 与交互由 Chrome 门禁检查。

历史夹具不进入 UI 或服务端安装包，也不被正式入口导入。

## 尚未验证的环境

真实酒馆内的在线模型全流程尚未验证。当前通过的是隔离宿主的实际安装文件、真实 SQL 快照、浏览器操作与离线后端契约；不要据此宣称真实模型已完成端到端验收。
