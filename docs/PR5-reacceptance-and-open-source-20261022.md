# PR5 新版本复验与开源方案调研

日期：2026-10-22。基线：PR5 `481a24c`，manifest `0.9.96`。本轮以验收和调研为范围，不替换生成器或安装新的运行依赖。

结论：**不通过整体验收**。已有厨房案例和皮肤切换通过部分复验；新世界生成仍有阻断性问题。

## 已完成的复验

- 重新运行全量自动测试：2384/2384 通过，约 130 秒。自动测试通过不等于新世界生成成功。
- 真实酒馆、Codex 内置浏览器：完整界面 → 地图专注 → 纯地图 → 完整界面，往返成功；纯地图保留返回入口。
- 星幕 → 纸面预览 → 星幕，切换成功；厨房照明标签没有复现。
- 完整皮肤包实际下载成功，ZIP 中可读 `manifest.json`，`kind=atlas-skin-pack`、版本 1、`id=user.exported`，当前内置星幕无外部贴图。SHA256：`8e936155776d7eb172fb967fa5896b545861f413c7b3af1e107740a4eb81bf95`。本轮未人为制造配额失败、未导入外部贴图包，也未做多用户切换。
- 作者 → 主角所知：未知厨房从地图树隐藏，自动转入已知大厅。旧 tooltip 文本仍在 DOM 中，但 opacity=0，截图不可见，本轮不将它误判为可见信息泄漏。
- 创建独立验收聊天，原聊天保留。使用新的青石驿站场景：8×6 大厅、4×3 厨房、3×3 储藏室、6×6 露天院子；明确东西/南北门连接、两个独立货架及 1+2 分钟耗时。实际调用模型，结果另记。

## 本轮真实新世界生成结果

独立聊天：`Atlas 中性验收 20261012 - 2026-10-22@18h58m39s685ms`。2026-10-22 11:06:29–11:15:29 UTC，5 次实际请求（观察、一次修复、建设、空间依据、布局），约 540.7 秒。每次请求都返回 HTTP 200，最终世界已保存到 revision 1，但原生回执为 `partial`，7 项问题，不能记为生成成功。

实际从 UI 导出 9 张地图：**大厅 1 张 ready，其余 8 张 missing**；青石驿站父图的持久化布局请求为 `failed`，失败码 `ROOM_CONNECTION_UNSATISFIED`。当前建筑页只显示散点，没有生成应有的完整平面。厨房、储藏室和南院未形成可验收场景。

引用和物品关系也未完全通过：模型将茶壶的 `holder_ref` 指向长桌（item），而该字段要求 character，触发 `REF_TYPE_MISMATCH`，茶壶未成功落表；布局又尝试将厨房操作台锚定到大厅长桌，触发 `ITEM_LOCATION_MISMATCH`，程序已移除错误锚点，不能把这种拦截算作语义正确。两个独立货架的 SQL 身份都有保留，但储藏室地图尚未完成，无法宣布其最终摆放通过。

此外，正文明确“步行 1 分钟，随后交谈 2 分钟”，持久化结算却为 120 秒，依据含 `SAME_INTERVAL_INFERRED`。两个事件均保留了 60/120 秒提示，但顺序没有落为前后依赖，导致按同一时间段合并；应为此补顺序抽取与结算回归，而不是再添加未知时间默认值。

证据：[实际父建筑](pr5-reacceptance-20261022/new-building.png)、[可用大厅与部分成功回执](pr5-reacceptance-20261022/new-hall-partial.png)、[地图导出](pr5-reacceptance-20261022/new-map-analysis.json)、[回执](pr5-reacceptance-20261022/new-generation-receipt.json)、[本轮诊断](pr5-reacceptance-20261022/new-generation-diagnostics.jsonl)、[持久化事件与物品事实](pr5-reacceptance-20261022/new-persisted-facts.json)。完整聊天文件仅在本机分析，不提交。

## 问题与优先级

### P1：多房间分叉拓扑不受支持

离线直接调用当前真实生成器：40×24 米内，8×8 大厅分别与三间 4×4 房间有门相连，返回 `ROOM_CONNECTION_UNSATISFIED`。已提供一个无重叠、全在边界内、每条连接都有共墙的合法反例，因此不是幅面确实不足。

原因：`vendor/atlas-spatial/foundation.mjs` 将连接分量按遍历次序排成一行；其开门检查只接受左右共墙，不能处理上下共墙与一般分叉图。只修通两间房不足以覆盖普通旅舍、学校等平面。

复现命令：`node docs/pr5-reacceptance-20261022/reproduce-branching.mjs`。输入与反例见 [branching-topology.json](pr5-reacceptance-20261022/branching-topology.json)。这是一例离线故障复现，不是模型成功率统计。

### P2：纸面皮肤尚未完成地图笔触适配

实机可见墙体、家具轮廓较淡，楼层图签仍是深蓝底，与纸面框体不一致。`ui/atlas-reference/js/map.js` 图签直接写入 `rgba(8,14,24,.82)` 等颜色，没有读取皮肤 token。需按语义补齐图签、墙、窗、家具、估计/确认状态的颜色和线宽；当前纸面仍标明预览。

证据：[纸面厨房](pr5-reacceptance-20261022/paper-kitchen.png)、[纯地图](pr5-reacceptance-20261022/pure-map.png)。

### P2：普通书桌的实体高度仍被缩为声明值的 68%

真实生成器离线输入单间 8×6 米、普通 `desk` 2×1 米：group 仍为 2×1，但实际绘制和碰撞使用的实体 body 为 2×0.68，且没有独立椅子。`layout-core.mjs` 的旧组合画法仍将 `f.h` 乘以 `.68`；在普通桌台不再隐式附赠椅子后，这会让画面尺寸和碰撞体与声明尺寸不一致。应统一“实体尺寸”与“交互净空”的契约，不能为了放下家具静默缩小实体。

证据：[输入与实际 body](pr5-reacceptance-20261022/desk-body-size.json)。这是离线尺寸核对，不是本轮新模型结果。

### P2：旧档仍可显示早期错误大厅布局

原错误样本的厨房已修复，但大厅已有的成功场景仍把“茶桌区”画成 8×2.5 米小房间，并保留 12×2 米辅助走廊；整幅 bounds 虽是 12×8，却没有呈现完整的 12×8 大厅。实机主角视角可见窄条布局。经此前真实 UI 导出的 revision 9 数据复核确认，不能据厨房局部修复声称全旧档已升级。

应列出旧策略场景、明确待更新状态，并提供按父子依赖顺序更新的操作。旧版本缓存命中或 `ready` 状态不应被误当成本版语义验收通过。

证据：[主角大厅截图](pr5-reacceptance-20261022/pov-switch.png)。

### P2：部分成功在诊断中被记为失败

`ui/atlas-reference-host.mjs` 的 `recordMapReceipt` 将 `partial` 与 `failed` 都映射为 `outcome:'failed'`；`src/atlas-ui-core.ts` 也将部分提交记作 `COMMIT_FAILED`。因此可以同时出现 `sceneSaved=true`、`issueCount=0` 与失败结论。需分别展示数据保存、布局完成和世界剩余问题，保留原回执而不误导用户重试。

本轮真实新世界回执又表现为外层 `status=committed`、`ok=true`、日志 `COMMIT_SUCCEEDED`，内部原生回执 `partial`，建筑布局失败。页脚正确显示了“部分成功”，但诊断状态与语义仍混杂。导出地图中 missing 图的 `issues=[]`，父图失败原因需要另查完整回执/原档；建议随图导出待处理请求的错误与状态。

## 开源项目评估

以下能力与许可均查阅项目自身仓库或官方文档。适配判断是本项目的工程建议，不代表已经集成或验证兼容。

| 项目 | 能帮助什么 | 采用判断 |
| --- | --- | --- |
| [fast-check](https://github.com/dubzzz/fast-check)，MIT | 随机组合房间尺寸、连接图、门宽、家具数量；失败用例缩减，保留 seed 重放 | 最先引入为开发依赖。对当前 SQL/生成器纯函数做属性测试，检查连通、碰撞、父子恒等和身份不增殖；无需改运行时渲染。官方[入门文档](https://fast-check.dev/docs/introduction/getting-started/)说明与现有测试运行器兼容及失败缩减。 |
| [highs-js](https://github.com/lovasoa/highs-js)，MIT | 在浏览器/Node 中本地运行 HiGHS；混合整数变量可表达房间相对侧向选择、矩形不重叠等离散决策 | 比单纯线性 UI 求解器更值得优先做房间布局原型。需要我们定义约束、设时间/规模上限，并在 Web Worker 运行；结果仍需现有碰撞、门和通行验证，不是导入即完成。官方[API 文档](https://lovasoa.github.io/highs-js/docs/)及[许可](https://github.com/lovasoa/highs-js/blob/main/LICENSE)。 |
| [LUME Kiwi](https://github.com/lume/kiwi)，Modified BSD / BSD-3-Clause | 用线性约束表达房间边界、尺寸、共墙和相对位置 | 先做独立求解原型，不直接替换现有生成器。离散的房间朝向、相邻关系、矩形不重叠分支仍需我们枚举或规划；Cassowary 不会自动解决所有平面拓扑。[许可](https://github.com/lume/kiwi/blob/main/COPYING.txt)。旧 [IjzerenHein/kiwi.js](https://github.com/IjzerenHein/kiwi.js) 已归档，原作者引导到 LUME。 |
| [rot.js](https://github.com/ondras/rot.js)，BSD-3-Clause | 地图生成算法、随机种子、寻路、视野与光照 | 可参考寻路与生成校验，适合随机地下城；不能把通用地下城生成器直接用于有作者明确尺寸和方位的旅舍。[官方手册](https://ondras.github.io/rot.js/manual/)列出这些模块。 |
| [PixiJS](https://github.com/pixijs/pixijs)，MIT | 场景分层、纹理与图集、资源生命周期、九宫格框体 | 适合后续有真实地图素材的渲染原型，不作为本轮布局问题的修复。官方 [Container](https://pixijs.com/8.x/guides/components/scene-objects/container)、[Assets](https://pixijs.com/8.x/guides/components/assets)、[NineSliceSprite](https://pixijs.com/8.x/guides/components/scene-objects/nine-slice-sprite) 可参考；当前 Canvas 也可继续实现同类能力，避免一次性重写。 |
| [Tiled](https://github.com/mapeditor/tiled)，编辑器 GPL、libtiled BSD-2-Clause | 人工制作楼层、家具、碰撞与对象图层；通过 JSON/TMX 导入模板或修正图 | 作为外部地图编辑工具优先于复制编辑器源码。先做 Atlas 场景与其 [JSON 格式](https://docs.mapeditor.org/en/stable/reference/json-map-format/) 的转换，稳定实体 ID 仍由 Atlas 管理。[官方许可分表](https://github.com/mapeditor/tiled/blob/master/COPYING)。 |

建议顺序：先补分叉/上下相邻的拓扑契约和回归 → 用 fast-check 扩展样例覆盖 → 以 highs-js 试验房间拓扑与矩形布局，LUME Kiwi 作为固定拓扑后的连续尺寸/对齐备选 → 统一皮肤语义 token 与资源角色 → 再评估 Tiled 素材工作流及 PixiJS 渲染原型。换渲染库不会自动修复房间连接或陈设身份错误。

求解原型应继续由模型提供事实和稳定 ID，由程序处理几何。例如厨房在大厅东侧需要 `x厨房=x大厅+w大厅`，储藏室在厨房北侧需要 `y储藏室+h储藏室=y厨房`，门的位置必须落在两侧墙面重叠段；作者尺寸作为硬约束，不能为求解成功偷偷缩小。离散朝向/不重叠选择可用整数变量；求解后还要独立检查所有门可达、物件数量及父子投影一致。皮肤只消费通过校验的同一份场景。
