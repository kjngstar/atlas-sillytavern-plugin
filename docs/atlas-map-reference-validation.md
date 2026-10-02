# Atlas 地图参考项目：第一轮验证

基于 0.9.73 数据契约。验证日期：2026-10-02。

## 已实现

- 独立的 Leaflet 1.9.4 / markercluster 1.5.3 验证页，读取 Atlas 现有三表地图投影。
- 统一坐标适配：Atlas 的右向 x、下向 y 转为 CRS.Simple 的 `[-y, x]`，保留小数与负坐标；地图格、屏幕像素分别处理。
- 复用 Atlas 现有网格函数、建筑区域布局和人物投影，不建立另一套在场规则。
- 多层地点面包屑与按地图保存的视角；人物聚合可查看完整成员，点击展开标记。
- 建筑区域高亮与点击进入，房间陈设按缩放显示细节。
- 原 Atlas 页面加入房间区域点击：与地点标点打开同一份详情，并沿用详情中的内部地图入口。
- 原 Atlas 页面将房间、建筑和通道边界按屏幕像素显示，避免缩放时边界过粗。沿用现有配色和皮肤令牌。

Leaflet 和 markercluster 仅为开发依赖，没有进入默认渲染器或酒馆安装包。验证页自带必要脚本、样式和许可证，可离线打开。验证页中的学校、人物和布局是测试数据，不连接用户聊天或模型 API。

## 验证结果

类型检查、构建打包、完整 1380 项仓库测试通过，无跳过。

另外在 Chrome 中运行真实页面交互检查：

| 用例 | 结果 |
| --- | --- |
| 12×8 教室，使用实际地图尺寸 | 6 个人物标点全部位于地图内 |
| 世界→城市→街区→学校→教学楼→楼层→教室 | 七段面包屑可切换，返回恢复中心和缩放 |
| 缩放 -2、3、6 | 自动改变主线间距、次线显隐、细分密度 |
| 50 人同一坐标 | 聚合显示，50 个成员均可访问，第 50 人可打开详情，展开后有 50 枚标记 |
| 展开后切换地图再返回 | 人物原坐标恢复；三表和地图投影未改写 |
| 世界图和父地图 | 不显示教室中的独立人物标记 |
| 1280px / 540px 宽度 | 验证页和 Atlas 原页面工具栏、面包屑不遮挡地图 |
| Atlas 原页面建筑区域 | 6 个房间区域可点击打开对应地点详情 |
| Atlas 原页面边界宽度 | 两种宽度下均约 1.5 屏幕像素 |

纯函数测试另覆盖离场过滤、50 个估计位置、已确认房间坐标保持、恢复旧投影后不残留新增房间布局。
这里的回退检查验证渲染器消费恢复后的数据；底层回退仍由仓库已有测试验收。

## 如何复跑

```sh
npm install
npm run pack
npm run typecheck
npm test
npm run map:lab
npm run map:verify
```

`map:lab` 生成 `artifacts/map-lab/index.html`。`map:verify` 生成同目录的截图和 `verification.json`。
浏览器测试默认使用 Windows Chrome，可用 `ATLAS_CHROME_PATH` 指定 Chrome 可执行文件。
原页面测试的请求全部由测试浏览器截获并提供夹具数据，不启动另一套酒馆、不读取或写入原酒馆文件。

## 接入判断

Leaflet 的坐标、层级、区域与拥挤人物交互验证通过，值得继续作为渲染层候选。
默认地图先采用已验收的区域点击和边界表现。

正式替换默认渲染器前，仍需接入并验收 Atlas 的 SQL 视图、各地图标定比例尺、路线、载具、作者拖拽纠偏、范围绘制、皮肤、IF 分支切换和宿主生命周期。这一轮不能视为上述全部功能的迁移验收。

自动生成世界、房间和家具的质量仍取决于 Atlas 的场景数据与模型输出；地图库本身不会推断世界观。当前建筑区域继续沿用展示布局，不能用作已确认距离或写回地理事实。

## 参考范围和许可

- [Leaflet CRS.Simple](https://leafletjs.com/examples/crs-simple/crs-simple.html)：平面坐标、地图单位与图像像素分离；BSD-2-Clause，验证页保留许可证。
- [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster)：聚合、展开；MIT，验证页保留许可证。
- [SimpleGraticule](https://github.com/ablakey/Leaflet.SimpleGraticule)：借鉴随缩放改变网格密度的思路，实际继续使用 Atlas 自有网格模块。
- [Indoor Map](https://github.com/arcataroger/openlayers_indoor_map)：借鉴区域交互和按缩放显示细节；项目已停止维护，没有复制其代码或 CC-BY-4.0 素材。
- [Azgaar 架构文档](https://github.com/Azgaar/Fantasy-Map-Generator/blob/master/docs/architecture/architecture.md)：参考生成、数据、样式和渲染分工。该文档包含目标架构，不能全部当作已完成实现。

2026-10-02 的初轮没有发布新 main 版本或更新本地酒馆。2026-10-03 已更新原插件并完成真实宿主测试，详见 [本地酒馆验收记录](atlas-map-local-host-validation.md)。
