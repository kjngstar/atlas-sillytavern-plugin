# 地图实验与验收

`npm run map:lab` 生成离线 Leaflet 原型；`npm run map:verify` 验证坐标、动态网格、
层级、人物聚合与默认 Atlas 地图的区域交互。输出位于忽略提交的 `artifacts/map-lab/`。
`live-verify.mjs` 使用现有本地酒馆与专用验收聊天检查正式默认地图。

`src/atlas-map-render-model.ts` 当前只服务实验台和测试。
Leaflet、markercluster 是原型依赖，Playwright 是验收依赖；均为开发依赖。
正式地图仍使用原渲染器，不能把原型演示或模拟接口验收当作完整替换成功。
原型保留许可证，人物展开偏移只用于显示，不写回业务坐标。
