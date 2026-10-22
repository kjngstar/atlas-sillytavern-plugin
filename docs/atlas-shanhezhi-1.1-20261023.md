# 山河志 1.1 交付记录

日期：2026-10-23。关联草稿：[PR #5](https://github.com/kjngstar/atlas-sillytavern-plugin/pull/5)。

## 本次变化

新增四张透明图片：薄金面板框、青玉按钮框、朱砂选中框与云纹分隔线。扩展增加六个可选图片角色：`panelFrame`、`controlFrame`、`controlActiveFrame`、`inputFrame`、`selectionFrame`、`divider`。一张薄金框供面板、普通按钮和输入框复用；按钮普通与激活图共用控件切片参数。

接入原生面板、浮层、导航、工具按钮、文本输入、选中树节点和卡片。补充悬停、键盘焦点、按下与禁用反馈，保留输入错误提示边框。装饰框不接收指针事件，业务状态和操作仍使用原有通道。可选资源切换时统一清理；应用失败恢复上一套 CSS 和 Canvas 皮肤。旧 v1 图片包无需添加新字段。

安装 ZIP 沿用 `user.shanhezhi`，导入覆盖 1.0；扩展需先更新到本次草稿。主插件版本仍为 0.9.96，没有发布正式版或创建标签。

## 验证

```bash
node tools/build-shanhe-skin.mjs
node --test tests/atlas-shanhe-skin.test.mjs tests/atlas-reference-map-render.test.mjs
node --check ui/atlas-reference/js/skin-runtime.js
node tools/sync-mirror.mjs
```

- 33/33 测试通过：12 项山河志/控件资源测试，21 项既有地图渲染回归。未宣称全仓库测试通过。
- 测试覆盖实际 ZIP 往返、13 个资源共享/回收、安装/导出/重启/移除、切换清理、失败回滚、严格字段校验、旧 v1 包兼容、切片单位以及静态文字色对比度。
- 13 张图片均完成实际像素解码与尺寸检查；透明框体与标点保留 alpha。运行资源不含动画、SVG、远程 URL 或任意样式代码。
- 安装 ZIP：295,372 字节；总像素 1,923,072；18 个资源位。
- ZIP SHA-256：`e157129be21f240cadb13f2b45f2911dab2322f0389fd928a435397eed4d230f`。
- 组件素材排版图使用实际图片和 manifest 切片值，边轨拉伸、四角保留；不是浏览器截图。

## 待完成验收

本次环境不能打开项目页面，尚未完成浏览器视觉和真实 SillyTavern 验收。自动测试与素材排版图不能替代这两项。正常项目预览服务可打开 `dev-preview/shanhe-skin.html`，使用固定演示数据检查三种显示配置、窄屏、导航/输入/选中态、切回星幕与重启。

同一 PR 中其他地图生成功能的验收结论不由本次皮肤工作改变；PR 保持草稿。

