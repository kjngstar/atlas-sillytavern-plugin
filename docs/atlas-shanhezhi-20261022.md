# 山河志皮肤接续交付（2026-10-22）

基于草稿 PR #5 `5ddeeba404ea6f34702e49819b185001ce239331`。接续此前未完成上传的古风皮肤方向，重新生成并交付实际素材；此前的“21 项酒馆检查”不计入本次验收结果。

## 完成

- 新增 `skins/shanhezhi/`：manifest、9 张优化图片、6 个标点 SVG 制作源和说明。
- 新增可选数据角色 `windowBackdrop`、`mapBackdrop`、`avatarFrame`；图片仍经现有 ZIP 白名单、静态解码、预算和资源释放通道处理。
- 新增有界数值 `map.backdrop.opacity`（0–0.50），及 `map.floorWall.fill`、`map.corridor.stroke/fill` 颜色 token；未提供时保留既有行为。
- 山水背景按视口等比裁切，在世界几何之前绘制。相机、地图范围、标点、命中和世界表保持原契约。
- 头像框为不接收指针事件的伪元素；纹理复用于面板、提示、HUD 和底部状态区。切回默认外观清理新增 URL；既有事务失败时恢复先前 CSS / Canvas。
- 室内走廊和图签读取皮肤语义颜色；纸面墨线提高可见性，同时保留估计与确认透明度的大小关系和原有虚线。
- `tools/build-shanhe-skin.mjs` 直接使用正式 ZIP 读写器生成安装包，无新增运行依赖。

## 本次验证

| 检查 | 结果 |
|---|---|
| 实际图片解码、尺寸与静态格式 | 9/9；窗框中心透明，六类标点保留 alpha |
| 正式 ZIP 写入 → 读取 → 图片逐字节比较 | 通过；9 张图片、12 个角色 |
| 新增资源共享、切换清理、失败恢复、参数边界、背景绘制顺序、笔触质量、安装导出与恢复删除 | 8/8 自动测试通过 |
| 既有地图渲染回归 | 21/21 通过 |
| 修改的 JavaScript 语法检查 | 通过 |
| 浏览器视觉检查 | 未完成；当前云浏览器禁止访问本地文件，未绕过该限制 |
| 真实酒馆 / 真实模型生成 | 本次未执行 |

本次没有重跑全套测试、类型检查或自包含全插件打包，不能沿用此前测试总数作为当前提交的全部验证结论。交付的是图片皮肤包和原生界面增量补丁；根 `ui/` 与扩展镜像中的三个修改文件一致。

## 复核命令

```bash
node tools/build-shanhe-skin.mjs
node --test tests/atlas-shanhe-skin.test.mjs tests/atlas-reference-map-render.test.mjs
node --check ui/atlas-reference/js/skin-runtime.js
node --check ui/atlas-reference/js/map.js
```

浏览器复核应覆盖：导入真实 ZIP、完整/地图专注/纯地图、360/720/1600 px、人物与物品标点点击、地图平移缩放、头像状态点、状态提示、切回星幕后零残留、刷新恢复、导出回导与删除活动包。请使用演示聊天完成外观复核。
