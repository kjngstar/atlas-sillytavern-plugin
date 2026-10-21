# Atlas UI 与皮肤系统预览包

日期：2026-10-21。基线为 `v0.9.96-rc.2`，开发分支为 `codex/ui-profiles-skin-runtime-rc2`。这是独立分支测试包，manifest 保持 `0.9.96`，没有发布新标签。

1. 备份当前 Atlas 插件目录并关闭 SillyTavern。
2. 将 ZIP 中完整的 `atlas-sillytavern-plugin/` 放入 `public/scripts/extensions/third-party/`。替换现有插件时沿用原目录名，并确保只启用一个 Atlas 插件。
3. 启动并刷新 SillyTavern。包内已包含脚本、样式、`ui/`、`dist/`、WASM、设置和 manifest，无需安装 npm 依赖。本次更新不需要替换独立服务端插件。
4. 打开 Atlas 的“预设与外观 → 外观”，选择基底并调整组件、地图笔触，或导入 JSON/ZIP 皮肤。

请替换整个安装目录；单独复制 CSS 或 JS 会缺少控制器、资源存储和按需加载的 ZIP 库。

`UI-SKIN-PREVIEW-INFO.json` 记录本次预览提交及验证结果；既有 `ATLAS-PATCH-INFO.json` 保留 rc.2 基线发布记录。真实酒馆的模型调用、多用户配置与宿主主题仍需部署后验收。纸面主题为预览。

详见 [皮肤制作说明](atlas-skin-authoring.md) 与 [实现和验收](atlas-ui-skin-runtime-20261021.md)。
