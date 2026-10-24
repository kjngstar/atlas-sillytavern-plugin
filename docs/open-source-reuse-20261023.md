# Atlas 开源复用评估（2026-10-23）

本次需求是地图控件收纳、空间布局请求和皮肤素材制作。以下基于项目现有原生 DOM、Canvas、SQL.js 和静态 ZIP 皮肤架构评估，链接均为官方资料。用途和采纳顺序是本项目的工程判断。

| 项目 | 可复用能力 | 对 Atlas 的适配结论 | 本次状态 |
| --- | --- | --- | --- |
| [Pillow](https://pillow.readthedocs.io/en/stable/reference/ImageOps.html) | PNG/WebP 解码、透明通道、等比缩放与明确裁切 | 适合离线素材工具；用 `ImageOps.contain/fit` 保持比例，避免每个皮肤重写图片脚本 | **已接入**素材准备和打包前像素检查。开发工具依赖固定 12.3.0，按 [MIT-CMU 许可证](https://github.com/python-pillow/Pillow/blob/main/LICENSE) 管理；插件运行不依赖 Python |
| [Floating UI](https://floating-ui.com/docs/getting-started) | 浮层锚定、滚动跟随、视口碰撞处理，提供原生 DOM 包 | 后续对象浮层、提示卡如果需要跟随地图目标，可复用 `@floating-ui/dom`；应随包构建，不从 CDN 运行时加载 | 候选优先。此次只有一个收纳按钮和原生 select，无需引入浮层依赖；[MIT](https://github.com/floating-ui/floating-ui/blob/master/LICENSE) |
| [Ajv](https://ajv.js.org/guide/getting-started.html) | JSON Schema/JTD 编译与可复用验证函数 | 适合未来把皮肤、生成请求与编辑器统一到共享 Schema；须保留 Atlas 现有错误码、引用/锁/空间语义校验 | 暂缓加入运行包。先做 Schema 与现有契约的等价验证，不能仅用结构校验替代引用与几何约束；[MIT](https://github.com/ajv-validator/ajv/blob/master/LICENSE) |
| [Leaflet](https://leafletjs.com/) | 图层、标记、GeoJSON、图片覆盖、移动端地图手势 | 项目已在开发依赖中有 Leaflet 1.9.4。若新增地理底图或图片底图编辑器，优先复用现有依赖验证；它本身不负责房间共墙、家具占地或父子空间账本 | 此次保留现有 Canvas。替换渲染器会同时触及命中、尺度与皮肤，不属于解决 HUD 拥挤的必要改动；[BSD-2-Clause](https://github.com/Leaflet/Leaflet/blob/main/LICENSE) |
| [elkjs](https://github.com/kieler/elkjs) | 有方向、端口和层级的节点连线布局，支持 Worker | 适合未来地点关系图、计划依赖图。不能直接把图排版坐标当成房间的物理米数和接触边界 | 关系图功能出现时再评估，暂不替代空间求解器；[EPL-2.0](https://github.com/kieler/elkjs/blob/master/LICENSE.md) |

这次直接复用了 Pillow 的图像能力；地图收纳使用浏览器已有的按钮、`hidden`、ARIA 和 select。未增加插件运行时 npm 依赖。下一项最有实际收益的候选是 Floating UI；需要关系图时再采用 elkjs，比提前更换整个地图引擎更符合当前需求。

验收开源依赖时需要以锁定版本检查体积、离线运行、许可证、iframe 环境、取消/释放资源以及与现有错误码的兼容。上表没有承诺未接入项目已经通过 Atlas 验收，也没有以星数代替适配测试。
