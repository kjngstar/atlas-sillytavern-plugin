# IMPLEMENTATION_STATUS.md — Atlas 修复进度追踪

按《Atlas_地图与推进系统完整修复计划》R00–R15 逐项记录。基线：v0.9.51，commit `682191af778be2e956e1e944806f59470f35c3d4`。

## R00 — 故障基线（2026-09-23）

- [x] 实际 commit：`682191af778be2e956e1e944806f59470f35c3d4`（工作区干净，无未提交改动）
- [x] 版本：0.9.51；文件哈希：`index.js=193c333f`、`style.css=ed3c3c4e`、`manifest.json=da632283`
- [x] `atlas-audit-repro.mjs` 实跑结果（保存于 `tests/fixtures/audit/baseline-v0.9.51.json`）：

| 缺陷 | 基线复现结果 | 状态 |
|---|---|---|
| D03 提示词漏材料 | `injectionText/lastTurnSummary/recentContextText` 哨兵均 false | ✅ 复现 |
| D04 新地点引用失败 | `〔裁定〕忽略未知地点「new-ruins」的移动`，locationChange 被置 null | ✅ 复现 |
| D05 NPC 投影脱节 | 账本 `_pointId:"2"` vs 目录 `pointId:null/source:"legacy"`，characterStates 空 | ✅ 复现 |
| D07 新建预设只读 | `nameReadOnly:true`、insertButtons 0、readOnlySegments 8 | ✅ 复现 |
| D08 网格单块 | `gridRepeat:"no-repeat"`、gridSize 20px | ✅ 复现 |
| D10 地图工具隐藏 | `toolsDisplay:"none"`；hint `pointer-events:auto` 全屏遮挡 | ✅ 复现 |
| D12 fit 下限挤点 | cellPx=20，全图 2320px，两点落在 -680 / 1320 | ✅ 复现 |
| 反证：程序化点击 | panelDisplay 空但有内容 → 交互代码在，问题是命中遮挡 | ✅ 记录 |

- [x] 门禁基线：typecheck / pack / test 结果见下方 R00 门禁记录
- [x] 夹具：`tests/fixtures/audit/` 四套（空世界、废墟相遇、多 NPC、多层子图）

## R00 门禁记录

| 门禁 | 结果 |
|---|---|
| typecheck | 通过（0 errors） |
| pack | 通过（ATLAS-FIX-01 自包含安装包） |
| test | 391/391 通过，与计划基线一致 |

## 任务总览

| 阶段 | 状态 | 说明 |
|---|---|---|
| R00 | ✅ 完成 | 7 缺陷全复现，门禁 391/391，夹具 4 套就绪 |
| R01 | ✅ 完成（DOM 层） | 图层拆分 + 工具显示 + hint 修复；真实浏览器命中验收归 R14 |
| R02 | 未开始 | |
| R03 | 未开始 | |
| R04 | 未开始 | |
| R05 | 未开始 | |
| R06 | 未开始 | |
| R07 | 未开始 | |
| R08 | 未开始 | |
| R09 | 未开始 | |
| R10 | 未开始 | |
| R11 | 未开始 | |
| R12 | 未开始 | |
| R13 | 未开始 | |
| R14 | 未开始 | |
| R15 | 未开始 | |

> 纪律：每阶段记录「做了什么 + 证据 + 残留」。未实际验证的写「未验证」。

## R01 — 地图可见性、网格与覆盖层（2026-09-23）

- [x] mapTools 按 ready/页面状态显式显示：renderMap 挂 `is-visible`；按钮禁用逻辑独立于可见性
- [x] hint 覆盖层修复：CSS `pointer-events:none` + `:empty{display:none}`；JS 空文字时 display:none
- [x] 图层拆分：viewport > `.aw-stage`（zoom/pan 变换层）> `.aw-image` / `.aw-grid` / `.aw-layer`（标点路线）——底图与网格不再抢同一 backgroundImage
- [x] 网格 repeat 平铺（D08 消失）；有底图时网格仍绘制（M02 叠加默认）
- [x] 快捷视图切换：叠加 / 网格 / 底图（`aw-mapview` 按钮组，只改可见性）
- [x] 底图缓存键 = `worldId|mapImageRevision`（服务端新增 `mapImageRevision=world.updatedAt`）；拉取失败删键可重试；删图/换图清空旧图层
- [x] 网格改消费 `--am-grid-minor` 皮肤令牌（R11 契约，JS 不再硬编码 --aw-teal-wash）
- [x] 比例尺详情改独立浮层（z-index 7，向上弹出），不再被图例遮挡（D14）
- [x] 地图页渲染 `aw-status` 行：提炼/标定/纠偏的成败反馈直接可见

证据：
- 新增 `tests/atlas-r01-map-visibility.test.mjs` 2 项通过（断言方向与基线相反）
- 审计脚本复跑：`toolsDisplay:"flex"`、`hintPointerEvents:"none"`、`gridRepeat:"repeat"`（基线为 none/auto/no-repeat）
- 门禁：typecheck 0 errors；pack 通过；test 393/393

残留：
- 真实浏览器鼠标命中（中心+四边）未验证 → R14
- fit 20px 下限（D12）、平移手势（D13）属 R08，本阶段未动

## R02 — 推进编辑器状态模型（2026-09-23）

- [x] 草稿 kind 状态模型：`builtin`（只读展示）/ `new`（未保存新草稿）/ `saved`（已存预设工作副本）；删除 `!id => 内置只读` 推断（D07 根因）
- [x] 新建草稿立即可编辑：名称可写、插入按钮存在、无只读分段误挂
- [x] 保存新预设后绑定 createdId（id 差集定位，不再猜「列表最后一项」）；再次保存 = 覆盖命令带 id，不重复新建
- [x] 另存为完整保留 role/name/mainSlot/content + contextTurnCount（D15）；内置默认另存为复制全套分段；保存后载入新副本可继续编辑
- [x] 复制内置默认改差集定位 + 载入 kind=saved
- [x] 草稿状态显式化：名称下方提示当前是「内置只读 / 未保存新预设 / 编辑已存预设（覆盖语义）」
- [x] D16：连接级 systemPrompt 覆盖推进预设时，推进页顶部红色警告 + 一键「清空连接级提示词（恢复推进预设生效）」
- [x] 内置原件保护在存储层不变（prompt.save 拒绝 builtin id）；放弃修改按 kind 回到对应来源

证据：
- 新增 `tests/atlas-r02-prompt-editor.test.mjs` 2 项通过（新建可编辑 + createdId 覆盖语义 + 另存为字段保真）
- 门禁：typecheck 0 errors；pack 通过；test 395/395

残留：
- 导入导出提示词 JSON 包（独立文件、不含 key）→ 并入 R15 交付；shujuku 适配器暂缓（计划允许）
- 未保存切换保护已有 confirmDiscard；异步 settings 加载覆盖输入的回归测试归 R03 预览链路
