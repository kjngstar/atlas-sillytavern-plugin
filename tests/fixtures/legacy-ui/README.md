# 历史界面回归夹具

此目录仅供历史合约测试使用，不进入正式 UI 或安装包。

- `render-panel.js.txt`、`panel-support.js.txt`：旧面板及它依赖的标签、缓存和上下文辅助定义。
- `skin.mjs`：旧 CSS 主题与地图令牌 API；当前界面使用 `AtlasSkinRuntime`。
- `modules/`：退出生产入口的 11 个旧工作台组件。
- `tests/ui-source-helper.mjs` 的 `readLegacyUiSource` 明确拼接旧面板，不代表当前界面。

正式入口为根 `index.js` → `ui/atlas-reference-host.mjs` → HTML 的 `atlas-boot-scripts` 清单。
当前界面以 `atlas-reference-*`、`atlas-appearance-system`、`atlas-shanhe-skin` 和实际浏览器门禁验证。
历史测试继续保留，迁移路径时不删除其行为断言。
