# Atlas 界面与皮肤制作说明

该接口基于 `v0.9.96-rc.2`，沿用现有工作台、宿主桥和 Canvas 2D 地图。一套业务状态负责地图、人物、选择和操作；显示配置负责可见模块；皮肤负责视觉。切换外观不增加 AI 请求或世界数据库字段。

## 使用

打开“预设与外观 → 外观”，选择已安装皮肤，分别调整框体、面板、按钮、图标边框、字体、颜色、圆角和地图笔触。星幕为原有风格，纸面为浅色预览主题。

“导入皮肤”支持 JSON 和 ZIP；含图片时使用 ZIP。“导出当前皮肤”对纯配置输出 JSON，对含图片配置输出完整 ZIP；“导出完整皮肤包”始终输出 ZIP。移除正在使用的皮肤时，先保存默认星幕偏好，再移除资源。

成功安装后，图片保存在同一浏览器、同一酒馆地址下，可离线使用。换浏览器或地址时用 ZIP 搬迁。存储失败会保留本次预览并给出提示，此时应导出备份；未保存的图片引用不会作为新的启动偏好写入。

## JSON 主题 v1

```json
{
  "kind": "atlas-ui-theme",
  "schemaVersion": 1,
  "id": "user.paper",
  "baseTheme": "builtin.parchment",
  "tokens": {
    "ui.accent": "#825128",
    "ui.window.radius": 12,
    "ui.font.family": "serif",
    "map.road.stroke": "#806443"
  },
  "components": {"frame": "minimal", "panels": "paper", "buttons": "outlined", "icons": "boxed"},
  "mapStyles": {"markers": "seal", "road": "ink", "water": "ink", "buildingOutline": "ink", "floorWall": "ink", "furniture": "ink"},
  "options": {"motion": false, "radar": false, "coordinates": false},
  "assets": {}
}
```

未填写的字段继承内置基底。基底仅可为 `builtin.starmap` 或 `builtin.parchment`；基础配色与框体变体独立。第三方包的 ID 使用 1–80 位英文字母、数字、点、连字符或下划线，不得使用 `builtin.` 前缀。显示名称可用中文。

颜色必须为 `#RRGGBB`；数值必须为 JSON 数字，不带 `px`。未知字段、版本、枚举、类型、超范围值均拒绝。没有任意 CSS、HTML、JS、字体文件或远程 URL 接口。

| 项目 | 可选值 |
|---|---|
| `components.frame` | `starmap` / `parchment` / `minimal` |
| `components.panels` | `glass` / `paper` / `flat` |
| `components.buttons` | `glow` / `outlined` / `flat` |
| `components.icons` | `line` / `boxed` |
| `mapStyles.markers` | `classic` / `seal` |
| `mapStyles.road/water/buildingOutline/floorWall/furniture` | `original` / `ink` / `technical` |

地图笔触只作用于原有路径，不改变建筑占地、道路网络、角色位置、标定、图形命中或知识过滤。虚线、透明度与估计范围继续保留原有质量区分。

## Token

权威清单为 `window.AtlasSkinRuntime.TOKEN_REGISTRY` 与 `TOKEN_RULES`。

| 类别 | Token |
|---|---|
| 窗口 | `ui.window.bg`、`ui.window.border` |
| 面板 | `ui.panel.bg`、`ui.panel.border` |
| 文字 | `ui.text.primary`、`ui.text.muted`、`ui.text.onAccent` |
| 强调色 | `ui.accent` |
| 地图 | `map.canvas.bg`、`map.grid.minor`、`map.label.primary`、`map.label.background` |
| 标点与图例 | `map.marker.character/place/item/message/event/exit` |
| 道路 | `map.road.stroke` |
| 水系 | `map.water.stroke`、`map.water.fill` |
| 建筑 | `map.buildingOutline.stroke`、`map.buildingOutline.fill` |
| 墙体 | `map.floorWall.stroke` |
| 陈设 | `map.furniture.stroke`、`map.furniture.fill` |

| 数值或枚举 Token | 合法值 |
|---|---|
| `ui.window.radius` | 0–28 |
| `ui.panel.radius` | 0–24 |
| `ui.control.radius` | 0–20 |
| `ui.spacing` | 8–24 |
| `ui.window.frameSlice` | 1–256，无单位图片切片数值 |
| `ui.window.frameWidth` | 1–24，显示宽度 |
| `ui.font.family` | `sans` / `serif` / `mono` |
| `map.texture.opacity` | 0–0.30 |

字体采用内置字体族与本地回退；中文保留插件随附字体回退。颜色 token 可继承基底；将非默认 token 设置为自定义值会启用对应视觉适配。

## 图片 ZIP

ZIP 根目录必须包含 `manifest.json`；图片仅允许位于 `assets/` 下。路径使用 ASCII 英文字母、数字、点、连字符或下划线；每段首字符不得是点。不允许绝对路径、反斜杠、目录穿越、隐藏文件、链接或未声明文件。

```json
{
  "kind": "atlas-skin-pack",
  "schemaVersion": 1,
  "skinApiVersion": 1,
  "id": "user.paper",
  "name": "纸面示例",
  "theme": {
    "kind": "atlas-ui-theme",
    "schemaVersion": 1,
    "id": "user.paper",
    "baseTheme": "builtin.parchment",
    "assets": {"windowFrame": "frame", "characterMarker": "character"}
  },
  "assets": [
    {"id": "frame", "path": "assets/frame.png", "mime": "image/png"},
    {"id": "character", "path": "assets/character.webp", "mime": "image/webp"}
  ]
}
```

包 ID 与主题 ID 必须相同。`assets` 数组声明文件，`theme.assets` 将资源 ID 绑定到角色；多个角色可共享一个 ID，只解码一次。同一路径不得声明多次。

| 资源角色 | 用法 |
|---|---|
| `windowFrame` | 九宫格边框；建议 64–256 px 方图，四角清晰，中间保持适合拉伸的纹理 |
| `panelTexture` | 面板重复纹理，建议 64–256 px 无缝图 |
| `mapTexture` | 地图重复纹理，受透明度 token 控制 |
| `characterMarker` | 人物标点 |
| `placeMarker` | 地点标点 |
| `itemMarker` | 物品标点 |
| `messageMarker` | 消息标点 |
| `eventMarker` | 事件标点 |
| `exitMarker` | 出入口；移动载具复用该图片角色 |

标点图显示为 24×24 CSS px，中心为原有坐标与命中锚点。建议制作 48×48 或 96×96 的透明图；不要在图片中烘焙位置、名称或距离。窗口图片通过受控 `border-image` 应用，无原始样式注入。

只支持静态 PNG/WebP。拒绝 SVG、APNG、动画 WebP、脚本、HTML、远程资源，以及与 MIME/真实图片尺寸不一致的文件。

| 限制 | 上限 |
|---|---:|
| ZIP 压缩文件 | 8 MiB |
| 解压总量（含 manifest） | 32 MiB |
| 单个资源 | 8 MiB |
| manifest | 64 KiB |
| ZIP 条目（含目录） | 96 |
| 图片单边 | 2048 px |
| 包内图片总像素 | 8,388,608 |
| 单用户安装数量 | 24 包 |
| 单用户已安装图片字节 | 64 MiB |

ZIP 校验包括中央/本地目录一致性、重复路径、重叠数据、真实流式解压量及 CRC；不只相信压缩包声明的尺寸。ZIP 库按需加载，不计入默认启动请求。安装前实际解码所有图片，失败时不覆盖已安装的同名包。

## 接口与维护

```js
await AtlasPreview.setTheme('builtin.parchment');
const skin = AtlasPreview.getSkin();
skin.components.frame = 'minimal';
skin.mapStyles.road = 'technical';
const result = await AtlasPreview.setSkin(skin);
// result.ok / saved / warnings / errorCode

await AtlasPreview.importSkinFile(file); // File: JSON 或 ZIP
const zipBytes = await AtlasPreview.exportSkinPack();
const catalog = await AtlasPreview.listSkins();
await AtlasPreview.removeSkin('user.paper');
await AtlasPreview.setUIProfile('mapOnly'); // 独立的显示范围配置
```

设置写入失败时，`ok` 可为真而 `saved` 为假：当前预览已应用，但尚未持久化。异步请求被更新的选择取代时返回 `SKIN_SUPERSEDED`，不会覆盖较新的外观。关闭或销毁时停止动画并回收图片资源。

旧 `atlas-preview-skin v1` 的强调色、动画、雷达与坐标选项可迁移；旧主题 JSON 导入后成为可复用的用户皮肤。未经定义的旧格式不做猜测转换。

权威目录为根 `ui/`；`npm run pack` 生成 `atlas-extension/ui/` 和自包含安装包。不要仅替换 CSS 或单个 JS。

| 模块 | 职责 |
|---|---|
| `atlas-reference/js/skin-runtime.js` | 白名单契约、主题解析、CSS/Canvas 提交与回滚 |
| `atlas-appearance-controller.mjs` | 安装、预览、保存、竞态和卸载 |
| `atlas-appearance-settings.mjs` | 外观设置的纯渲染 |
| `atlas-skin-pack.mjs` | ZIP、manifest、图片头与预算校验 |
| `atlas-skin-assets.mjs` | 串行解码、共享引用与释放 |
| `atlas-skin-storage.mjs` | 宿主 IndexedDB、用户隔离、配额与原子替换 |
| `atlas-reference/js/map.js` | 原有路径、命中和受控绘制样式 |
