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
| R02 | ✅ 完成 | 提示词草稿 kind 状态模型：builtin/new/saved；新建可编辑 + 另存为字段保真 + 连接级 systemPrompt 警告；395/395 |
| R03 | ✅ 完成 | 默认 6 段提示词 + 实际注入 `$5/$U/$C/$1/$6/$7/$8` + 单次占位符扫描 + `/turns/preview`；400/400 |
| R04 | ✅ 完成 | 统一运行时视图（ledger 投影覆盖 CharacterState 基线）+ npcDirectory 单读路径（D05）+ 分支游标感知；404/404 |
| R05 | ✅ 完成 | 协议 v2 契约 + 同轮临时引用 + 应用管线复用 commitAtlasTurn + 已知 ID 校验 + 未知引用整单拒收；418/418 |
| R06 | ✅ 完成 | 场景锚定（独立于旅行）+ bootstrap 识别（mode=bootstrap duration=0）+ 起点占位指纹 + lastConfirmed 分离 + v2 封套 + `worldTurnProtocol` 设置；432/432 |
| R06 补充 | ✅ 完成 | `buildStarterWorld` 改为空地理，新世界不再生成"起点"占位点；纯占位在 `/state` 与地图语境默认隐藏；452/452 |
| R07 | ✅ 完成 | 身份消歧（ambiguous 整单拒绝）+ identityUpdates 不重建实体 + presence 落账 + 附近卡片详情 + 零写入收口；442/442 |
| R08 | ✅ 完成 | 地图相机（fit 无下限 / 光标缩放 / 反缩放）+ 手势状态机（pan / 拖拽 / pinch）+ suppressClick 不提前清 + 相机持久化；447/447 |
| R08 热修 | ✅ 完成 | marker `inverseScale = 1/k`（旧公式 fit 时撑满视口吞点击）+ 仅空白/双指 setPointerCapture；452/452 |
| R12 | ✅ 完成 | 原子事务收口：`pending.remove` best-effort（失败记日志不抛错）+ `reconcilePendingCommits` 启动清理 orphan；460/460 |
| R10 | ✅ 完成 | v2 mapScaleHints 接入提交链路：`applyScaleHintsToDoc` 纯函数（人工锁定 / frame 不匹配 / unknown-conflict 跳过纪律）+ executeCommit 应用到 maps sidecar + 日志分流；471/471 |
| R09 | ✅ 完成（后端） | SubMap schema 升级加 `frame: { cols, rows, frameRevision }` 字段 + `validateSubmapDepth` 深度校验 + `handleScaleCalibrate` 使用真实 frame；UI 弹窗与子图三层级留实机阶段；481/481 |
| R11 | ✅ 完成（令牌） | 增量 `--am-*` 令牌 17 项（选中态 / 面包屑 / 状态三态 / 头像 / section-label）+ mappanel 写死色全替换 + `.aw-point.is-selected` 钩子 + `.aw-breadcrumb` 占位类；488/488 |
| R13-R15 | ✅ 完成（集成测试 + 文档） | 集成层跨 R04/R05/R07/R10/R12 不变量测试 7 项 + `docs/VERIFICATION.md` 实机验收清单（10 节 ≥ 30 项）+ atlas-extension/README 已实现能力索引；495/495 |
| R14 实机验收 | ⬜ 待作者 | 按 `docs/VERIFICATION.md` 10 节清单在真实酒馆执行（≥30 项）；通过后才允许版本 bump + tag 发布 |
| R15 收尾 | ⬜ 待作者验收后 | 实机验收问题回修（如有）+ 版本号 bump 六处 + tag |

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
- 导入导出提示词 JSON 包（独立文件、不含 key）→ **R15 已交付（2026-09-23）**：`buildAtlasPromptPack` / `parseAtlasPromptPack` / `uniquePromptPresetName`（根 index.js 导出，11 条测试）+ 推进页「导出 / 导入」按钮（`<preset>.atlas-prompt-pack.json`；协议 `atlas-prompt-pack@1`；白名单构造无密钥面；导入重名追加「（导入）」，不自动启用）；shujuku 适配器暂缓（计划允许）
- 未保存切换保护已有 confirmDiscard；异步 settings 加载覆盖输入的回归测试归 R03 预览链路

## R03 — 提示词实际输入与请求预览（2026-09-23）

- [x] D03 修复：默认分段重写为交接包临时预设 6 段结构——$5 世界状态 / $U·$C·$1 背景 / $6 上轮 / $7 前文 / $8·{{assistantReply}} 本轮素材全部实际插入（基线哨兵 false → 全 true）
- [x] 移除 assistant「收到」应答段 ×3 与末尾 `{` 输出引导段（模型直接输出完整 JSON）
- [x] A02：占位符替换改单次合并扫描——注入剧情原文中的 `$8`/`{{...}}` 字面量不再被二次展开；转义 `\$` 保留；旧别名兼容
- [x] A10：装配路径单一来源化——抽取 `prepareWorldTurnInputs()`（prepare + $6/$7 上下文 + 占位符输入），commit/retry/预览共用
- [x] 新增 `POST /turns/preview`（服务端 + 插件清单同步）：返回 messages（role/内容/长度）、生效来源（preset/connection/builtin）、缺失块哨兵
- [x] 推进页新增「最终请求预览」：按当前世界状态零 API 装配，展示每段内容 + 生效来源 + 缺失块（连接覆盖时联动 R02 警告）
- [x] 8 项哨兵测试（A01）+ 二次替换测试（A02）+ 预览一致性测试（A10）

证据：
- 新增 `tests/atlas-r03-prompt-inputs.test.mjs` 5 项通过
- 旧结构断言更新：浏览器核心（6 段角色序）、路由清单 21 条、内置回退断言（含 $5 注入验证）
- 门禁：typecheck 0 errors；pack 通过；test 400/400

残留：
- 预算截断显示（背景块按预算截断并标注）暂未实现——当前装配无预算机制，列入 v2 封套（R05）
- 真实模型行为抽样验证 → R14（真实酒馆环境）

## R04 — 统一人物位置、状态与附近投影（2026-09-23）

- [x] 新建 `src/atlas-runtime-view.ts`：`resolveAtlasRuntimeView(world, {branchId, at, entityIds})` 单一读取口径
  - 基线 = resolveCharacterPosition（CharacterState 兼容 / 旧角色字段回退）
  - 账本 = projectEntityState 分支游标重放，最新有效 moveEntity / status 覆盖旧值
  - 规则 3：pointId 有效时按地点归属重解析地区，不延续不一致地区
  - 注册表 = characters ∪ entityRecords[type=npc] 去重，实体记录人物不再不可见
- [x] handleState npcDirectory 改为消费统一视图（D05 修复：账本点位 = 目录点位）；DTO 增加 positionSource
- [x] 分支 / 游标感知：投影按 branchId + at 截断，不展示未来状态

证据：
- 新增 `tests/atlas-r04-runtime-view.test.mjs` 4 项通过：
  - N04（D05 场景复刻）：提交后账本 `_pointId:"2"` = 目录点位，status「正在交谈」同时可见（基线：null / 空）
  - 兼容基线回退；N09 注册表关联；地区一致性规则
- 门禁：typecheck 0 errors；pack 通过；test 404/404

残留：
- nearby DTO（地点名称 / 理由数组 / 精度）增强与 atlas-relevance 消费改造 → 与 R07 附近列表一起收口
- 物品持有者关系解析（location 指向人物）→ R09 物品详情
- 游标回退 / 兄弟分支隔离已在 projectEntityState 分支谱系中保证；端到端回归归 R12/R14

## R05 — 推进协议 v2 契约与同轮临时引用（2026-09-23）

- [x] 新建 `src/atlas-contract-v2.ts`：v2 草稿解析 + 语法校验（纯函数零副作用）
  - 顶层字段全必在（缺数组 = 错误，不是缺省）；schemaVersion 必须 = 2
  - baseRevision 必须逐字回显请求值（过期提交在语法层即拒绝）
  - evidence.quote 包含校验：必须是指定 sourceId 的原文片段（msg:u / msg:a / lore）
  - 临时引用形状：`new:loc:<短名>` / `new:npc:<短名>`，本响应内唯一；npcUpdates op 语义（set 必带引用、keep/clear 必空引用）
  - 上限封顶：别名 8×64、新地点/人物 12、变化数组 64、证据 64、摘要/记忆 500、引文 240；错误返回 JSON 路径列表（封顶 40 条），不静默裁剪
- [x] 新建 `src/atlas-turn-v2.ts`：v2 应用管线（复用 commitAtlasTurn，不另起直写路径）
  - 语义校验在候选世界构建时完成：已知实体用原 ID、未知地点 / 未知地区 / 未声明的未知引用 → 整单拒绝（AtlasError，零写入）
  - 临时引用 → 持久 ID 确定性分配：地点 = 现有数字 id 顺延（黄金角螺旋散点、regionRef null 则不归属）；人物 = `npc-<hash8(turnId|ref)>`（撞 id 换盐重派）
  - 候选世界只增不改：新地点进 points；新人物同时进 characters + entityRecords[type=npc]，temporalSchema 预声明 status:string
  - 折叠为 v1 形草稿：scene→locationChange（confirmed/estimated 才动游标）；npcUpdates set→moveEntity（regionId 随地点归属）+ status→setTemporalField；relationUpdates→adjustRelation；worldFlags→setFlag；memories→memoryDrafts；events→summary 附加行（超限保留主摘要 + 警告）
  - identityUpdates：本轮新建实体直接改候选世界（名 / 别名）；已知实体留给 R07，降级为显式警告不静默丢
  - clear 位置 / parentLocationRef 暂无 v1 对应：显式警告（R07 / R09 接手），不静默丢弃
  - 幂等预检：同幂等键已在账本 → 跳过候选世界构建（避免幽灵增量）直接走 duplicate 路径
- [x] executeCommit 协议分流：`schemaVersion:2` 检测在 v1 解析**之前**（v1 解析器宽松，v2 JSON 会被当 v1 静默吃成 0 effect）；v2 分支不走旅行耗时裁定层（时长模型申报，0 合法）
- [x] v2 校验失败落日志（world-turn-v2-rejected，含错误路径前 10 条 + 原文摘录）+ retryable 报错；应用警告落 world-turn-v2-warnings

证据：
- 新增 `tests/atlas-r05-turn-v2.test.mjs` 14 项通过：
  - L07 / §5.3 首场戏：new:loc:ruins + new:npc:girl + 场景锚定 + NPC 更新单次提交全落地（D04 修复断言：少女位置 = 同轮新建废墟深处；基线 = 引用被裁定丢弃）
  - baseRevision 过期 / 引文包含失败 / 来源不存在 / 重复引用 / 缺顶层数组 / op 语义违规全拒绝
  - T07：v1 草稿进 v2 解析器 → 明确版本错误
  - 未知地点 / 未知地区 → 零写入拒绝；T01 同键重试 → duplicate 不重复建点建人；duration=0 合法不推进时间；已知实体原 ID 引用同管线可用
- 门禁：typecheck 0 errors；pack 通过；test 418/418（404 + 14）

残留：
- v2 提示词封套（注入 v2 JSON 模板 + 使用说明）默认仍关闭，等 R06 场景锚定迁移 + R07 身份跟踪齐后再切（计划 §4.5）
- 事件明细超摘要上限时只保留主摘要 + 警告（不做独立事件存储，等 R12 原子提交一起收口）
- mapScaleHints 解析已支持，应用（地图尺度接线）在 R10
- v2 分支的端到端服务级测试（含 store / 日志）依赖真实酒馆链路 → R14 交互验收

## R06 — 首次定位、开场识别与「起点」迁移（2026-09-23）

- [x] 新建 `src/atlas-scene.ts`：起点占位指纹（生成来源 + 结构指纹：1 地点 id=1/起点/(50,50)/start + 1 地区 + 无账本 + 无修订 + 无额外人物）——名字匹配单独不足；用户真正创建的「起点」因编辑证据不被误判
- [x] 占位迁移：retired 不删除——定义修订审计 + `scene:<worldId>` sidecar 记录；重复运行幂等；地图点列 / 真实地点语境过滤 retired 点
- [x] 场景未知与 lastConfirmed 分开表达：/state 新增 `scene` 块（known / placeholder+retired / lastConfirmed / bootstrap 簿记）
- [x] 开场识别 `POST /scene/bootstrap`（mode=bootstrap，duration=0）：apply=false 预览（零写入，明确 callCount=1）；apply=true 一次 v2 提交（时间游标不动、地点游标随 scene 锚定）；成功锚定后占位自动 retired；诚实未知（无证据 → resolution=unknown → 不造点、不退役、不写 lastConfirmed）
- [x] v2 封套上线（R05 残项收口）：`DEFAULT_PROMPT_SEGMENTS_V2` 6 段（契约含 schemaVersion/baseRevision/new: 引用/scene/presence 模板 + $5/$U/$C/$1/$6/$7/$8 素材 + 核对）；新增 `$B` 占位符 = 世界时间游标
- [x] 协议设置 `worldTurnProtocol`（缺省 v2；v1 = 旧契约逃生门）：runtime.update 命令 + sanitize + settingsView（内置默认分段按协议展示）+ 推进页切换按钮；作者自定义预设不被覆盖（混合模式：v1 输出仍走 v1 管线）
- [x] 推进页「场景定位」区：当前场景 / 上次确认 / 协议三行 + 识别按钮（预览 → 应用，确认对话框注明消耗 1 次请求）+ 占位迁移状态提示
- [x] 路由 22 条（核心 + 插件清单同步）

证据：
- 新增 `tests/atlas-r06-scene.test.mjs` 14 项通过：占位指纹 5（含「用户创建的真起点保留」）+ retired 幂等 2 + 场景状态分离 1 + v2 封套 1 + 服务端 bootstrap 5（预览零写入 / 应用单次提交 / 未知诚实拒绝 / state 场景块 / 协议逃生门）
- 门禁：typecheck 0 errors；pack 通过；test 432/432（418 + 14）

残留：
- 首轮普通推进同轮场景识别 = v2 封套场景锚定路径本身（已可用）；真实模型行为抽样 → R14
- 地图上占位点的「占位」视觉标注（非过滤式隐藏）→ R08/R11 地图改造一起收
- bootstrap 提交未建 ATLAS-06 技术检查点（duration=0 无回退需求；如需归 R12 事务化）

## R07 — 人物持续跟踪与身份消歧（2026-09-23）

- [x] 新建 `src/atlas-identity.ts`：canonical ID + displayName + 别名（tags 复用，封顶 16）解析——精确 ID 优先，displayName / 别名**精确**名字匹配；多实体命中同一称呼 = ambiguous 整单拒绝（同场多个女性 / 同名不强行合并），绝不挑第一个
- [x] 临时称呼应用：v2 引用解析支持「已知 ID → 名字 / 别名」回退（解析成功留警告审计）；临时称呼不是临时身份（不因称呼新建实体）
- [x] identityUpdates 全量落地：已知 / 本轮新建实体统一 `applyIdentityUpdates`——更新 displayName 与别名，**不重建实体**（id 不变）；已知实体的名字变更在提交成功后追加定义修订审计（changedEntityIds 留痕）；无实际变化不写
- [x] presence 落账：新建 NPC 的 temporalSchema 预声明 status + presence；「离开了房间」（presence=left，含 op=clear 目的地未知）写 presence=left；「没有提到」= unknown 不写（保持上次状态）；未声明 presence 的旧实体降级为显式警告，不炸提案
- [x] 运行时视图 + /state 透出：RuntimeNpcView 增加 presence（present/left/null=未记录，不猜离场）；npcDirectory 增加 presence + lastConfirmedAt（分支内最后一条涉及该实体的账本事件时刻）
- [x] v2 封套纪律补齐：同行关系与同地点分开（不让熟人自动跟随传送）、「离开了房间才写 left」、不从叙事推断人物内心（事件摘要 ≠ 实时心声）
- [x] 零写入收口：applyAtlasV2Turn 在 failed / duplicate 回执时返回**原世界**（候选世界增量不外泄）
- [x] 附近人物卡片：位置带来源标记（账本确认 / 基线记录 / 旧档案）+ 点击 / 键盘展开人物详情（在场状态 / 状态文字 / 最后确认时刻 / 最近涉及叙事=账本摘要，明确标注非实时心声）

证据：
- 新增 `tests/atlas-r07-identity.test.mjs` 10 项通过：引用解析（id/名/别名/歧义）+ 应用层歧义拒绝 + 真名更新（id 不变 + 旧别名保留 + 修订审计）+ 无变化零写 + mergeAliases 封顶 + presence left 落账与视图 + 「没有提到=保持、不跟随传送」+ failed 零写入 + 封套纪律
- 门禁：typecheck 0 errors；pack 通过；test 442/442（432 + 10）

残留：
- 合并两个已存在实体（引用重定向 + 撤销记录）需要账本「转移事件」能力，lib/ 快照无对应 effect——按计划不破坏快照，列为协议 v3 残项（本阶段用「拒绝歧义 + identityUpdates 改名」覆盖验收路径）
- 人物详情页的持有物列表 / 所在地链接跳转 → R09 弹窗与跳转一起收口

## R08 — 地图相机与点击 / 拖拽手势（2026-09-23）

- [x] 新建 `src/atlas-map-camera.ts`（纯数学，无 DOM）：统一 `screen = v + (world - c) * k` / `world = c + (screen - v) / k`；computeMapFrame（8% 留白、负坐标合法）、fitCamera、worldToScreen / screenToWorld、zoomCameraAtPoint（光标锚定）、panCameraBy、centerCameraOn、cameraStageTransform、cameraZoomPercent、markerInverseScale
- [x] **删除每格 20px fit 下限**：fitAll 无绝对像素下限与绝对比例夹取（缩放范围纯相对 fit 基准 0.2×~8×）——10 万格大世界完整收入视口；宽图 / 长图 / 负坐标 / 单点 / 空图均可看全
- [x] 标记视觉尺寸 / 命中区域用屏幕像素控制：CSS `scale(var(--aw-marker-inv, 1))` 抵消 stage 缩放（--aw-marker-inv 由相机实时写入），放大不再撑大按钮
- [x] index.js 地图重接线：stage 子元素直接按世界单位 px 定位（transform-origin 0 0，screen = translate(t) + world*k）；网格盒 = frame 外扩（平移出图仍见格线，线宽屏幕恒 1px，格距 < 4px 诚实隐藏）；底图盒 / 路线 SVG = frame 精确框，图像、网格、路线、标记、命中共用同一相机变换
- [x] 手势状态机 `src/atlas-map-interactions.ts`（纯逻辑）：pan（空白起手超阈值 6px 才拖，按钮 / 输入框 / 弹层起手 interactive 不启动）、NPC 拖拽纠偏、双指 pinch（距离比 = 因子，中点锚定）
- [x] **拖拽 click 吞咽修复**：suppressClick 不在 pointerup 提前清除，由 click 事件 consumeClick() 消费（旧实现拖完松手仍会打开人物面板——回归门禁测试锁定）；pan 结束的合成 click 同样吞掉，不当空白点击
- [x] NPC 拖拽视觉反馈：跟随光标的 .aw-dragghost 影子（pointer-events:none 不挡命中），原标记 45% 透明；命中检测只认 .aw-point（天然排除影子与人物标记本身），非目标处松手不写世界
- [x] 手势健壮性：pointercancel 复位、setPointerCapture、双指回落单指重启平移基线、触摸 touch-action:none
- [x] **回到 100% 不再清空平移**（旧 setZoom(1) 连带清 pan 的行为删除）；重置 = ⌂ fitAll 单独操作；新增 ⌖ 定位当前位置按钮（保持比例对准玩家，子图视图禁用）
- [x] 相机按视图持久化（chatId|worldId|子图栈路径）：筛选 / 重渲染不重算 frame / 相机（筛选只改可见对象），进子图返回恢复原相机；视口 resize → 重新 fitAll
- [x] 相机 / 手势 API 经 atlas-browser-entry 进 dist（ui-core-exports 模式），renderPanel 从 mod 解构；dist 导出门禁测试锁定
- [x] 比例尺接线适配：cellPx = 相机比例 k（zoom 已并入），动态标尺条随连续缩放实时重算

证据：
- 新增 `tests/atlas-r08-camera.test.mjs` 11 项通过：fit 无下限（大世界收入视口）+ 五类图 fitAll 看全 + 往返误差 < 1e-9 + 光标缩放不漂移 / 边界夹取 + setCameraZoom 不清平移（回归门禁）+ 百分比 / 反缩放 / stage transform 一致性 + pan 阈值与 interactive + suppressClick 不提前清除（回归门禁）+ pointercancel 复位 + pinch 因子 / 中点 + dist 导出
- 旧 `tests/atlas-map-layout.test.mjs`（绑定被删除的 computeMapLayout）删除，由 R08 测试文件取代
- 门禁：typecheck 0 errors；pack 通过（镜像同步）；test 447/447（442 + 11 新增 − 6 旧布局测试移除）

残留：
- 真实浏览器手势验收（拖拽跟手 / 触摸双指 / 长中文标签遮挡）→ R14 交互验收
- 相机「销毁时移除监听」：扩展卸载路径 disconnectAtlas 移除整个面板 DOM，监听随节点销毁；ResizeObserver 随 panel 移除后不再触发——无独立 teardown 钩子，未单独实现
- 弹窗随 pan / zoom / resize 重新定位（anchorPanelToMarker 仅开面板时计算）→ R09 selectedEntityId 弹窗刷新一起收口

## R06 补充 — 新世界空地理，不再生成「起点」（2026-09-23）

- [x] `buildStarterWorld()` 改为**空地理**：`regions=[]` / `points=[]` / `currentRegionId=null` / 主角 `currentRegionId=null`（核心 schema 的 regions、points 均为可选，currentRegionId 允许 null）——第一轮推演的场景识别产出真实地点，不再有占位兜底
- [x] 旧「起点」世界照旧走指纹 + retired 迁移：退役只在**真的锚定到地点**时执行；用户真正创建且名叫「起点」的地点不删不迁
- [x] 纯占位**默认不显示为真实地点**：/state 地图点列同时过滤「已退役」与「指纹吻合但未退役」的占位——结构保留、引用不悬空、零写入
- [x] geo/adopt 不再写死 `start`：无 regionName / 未知地区 → `regionId=null`（旧世界里真有 start 地区时沿用原口径，行为不变）
- [x] 空地理提示文案更新（不再声称「自动建世只创建起点」）
- [x] 测试基线分离：新增 `tests/atlas-legacy-start-world.mjs`（旧存档形状夹具），依赖「已有地理」的用例改走夹具，不再反向依赖新世界形状

证据：
- 新增 / 改写用例 5 项：空地理形状 + parseWorld 必过、空地理 + bootstrap 端到端（无占位可退役 / 只有剧情产出的真实地点）、/state 占位不进地图点列、geo/adopt 空地理不写悬空 `start`
- 门禁：typecheck 0 errors；pack 通过（镜像同步）；test **452/452**（447 → 452）

残留：
- 已推演过的旧存档：指纹必然破裂（有账本事件 / 多人物）→ 不能自动退役，否则会误删用户真叫「起点」的地点；这类存档需作者手动处理或重开新聊天
- 计划 R06 末条「旧存档重新识别当前场景与在场人物（预览变更、不自动推进时间）」的 UI 入口未做

## R08 热修 — 标记巨型化与手势失灵（2026-09-23）

- [x] `markerInverseScale` 修正为 `1/k`（旧公式 `fitK/k`：fit 时 =1 等于没抵消，单点世界 k≈58 → 标记放大 58 倍铺满视口，并吃掉全部指针事件导致拖不动、缩不小）
- [x] viewport 只在**空白起手 / 双指**时 `setPointerCapture`（旧实现每次 pointerdown 都捕获 → 抢走标记的点击）
- [x] 回到 100% 不再清空平移：R08 热修正好赶上 R12 上线，详见 R12 章节。

## R12 — 多文档原子提交与 pending 启动清理（2026-09-23）

- [x] 诊断：0.9.42 会话承载已让 world / binding / maps / turns / geo-auto 落在同一 session 对象（单文档原子），由 `createAtlasServerCore` 整体 rev+1 带回浏览器。**唯一残留 IO 缺口**：`pending:*` 文档在全局 store，`/turns/commit` 步骤 7 的 `store.remove('pending:<idempotencyKey>')` 是分开的 IO——失败会让响应抛错、新 session 不写回，作者重试则走完整 prepare+commit（浪费 token）。
- [x] 收口：`executeCommit` 步骤 7 把 `pending.remove` 包进 `try/catch`，失败 → 记录 `pending-remove-failed` 警告日志（at/chatId/worldId/idempotencyKey/message），**不抛错**——响应正常带回新 session。orphan pending 留给启动钩子清理。
- [x] 新增 `src/atlas-pending-reconcile.ts`（纯函数 + IO 分离）：
  - `scanPendingEntries(store)` 扫所有 `pending:*` 文档，提取 `{chatId, idempotencyKey}`；malformed（无 binding / chatId 缺失 / 文档名不可解析）保留以免误删
  - `reconcilePendingCommits(store, options?)` 对每条 pending 读 `turn:<chatId>:<idempotencyKey>`：
    - 存在且非 `rolledBack` → orphan，删除
    - 不存在 → 合法（commit 未成功），保留
    - 读取失败 → 视为不确定，保留并记录错误
- [x] `createAtlasServerCore` 暴露 `reconcilePending()` 方法（`shared.logs.push` 落日志）：UI 启动钩子 / 调试面板可调一次。
- [x] 设计纪律：单条失败不阻断整体清理；malformed 永远保留；rolledBack turn 不被清（pending 可能合法供 retry 路径用）。

证据：
- 新增 `tests/atlas-r12-atomic-commit.test.mjs` 8 项通过：orphan 清 / legitimate 保留 / malformed 保留 / rolledBack 不动 / 多 chat 独立 / store.read 失败保留 / `scanPendingEntries` 单元 / limit 选项
- 门禁：typecheck 0 errors；pack 通过（镜像同步）；test **460/460**（452 → 460）

残留：
- 是否把 `pending:*` 也搬进 session 改掉根上 IO 分离：判断为"可演进但非 P0"。现状已满足计划"失败零 root 写入 + 0 条新 API 调 + pending 留熟"的底线；如有实测发现连续 orphan 堆积（不太可能） → R15 集成期决定。
- 实际启动钩子：~~`reconcilePending()` 还没在任何启动流程里被自动调用~~ → **R15 已接线（2026-09-23）**：`reconcilePending(session?)` 加可选会话参数（0.9.42 起 turn 文档在会话覆盖层，裸 store 查不到已提交回合——不带 session 在浏览器里一条 orphan 都清不了，此坑由集成审查发现）；UI 启动钩子在 connectOnce 建 engine 后带当前聊天会话 fire-and-forget 调用（.catch 防静默失效），有清理动作才记日志。其他聊天的孤儿留待各自聊天启动时清（宁留勿删）。测试 T3b/T3c 固化「带/不带 session」双路径。

## R10 — v2 mapScaleHints 接入提交链路（2026-09-23）

- [x] 新增 `src/atlas-scale.ts:applyScaleHintsToDoc(hints, doc, options)` 纯函数：把 v2 `mapScaleHints` 数组应用到 `mapsDoc.calibrations[mapId]`。纪律：
  - 人工锁定（`calibrations[mapId].locked === true`） → `skipped-locked`，永不被 AI 覆盖
  - 未注册 frame 的 mapId → `skipped-frame-mismatch`（防幽灵子图）
  - `hint.frameRevision !== null && !== frame.frameRevision` → `skipped-frame-mismatch`
  - `hint.status === "unknown" | "conflict"` → `skipped-unknown`
  - `validateScaleResponse` 数值校验不过（负值/零/字符串/横纵不等距）→ `skipped-invalid` / `skipped-unknown`
  - 通过校验 → 写入新 calibration，`revision = (existing?.revision ?? 0) + 1`，`source = "ai-estimated"`，`locked = false`
- [x] `atlas-turn-v2.ts`：在 `AtlasV2TurnOutput` 新增 `scaleHints` 字段（draft.mapScaleHints 透传），三处 return 路径同步填充。turn-v2 不写 sidecar——遵守 R12"事务原子性"约束。
- [x] `atlas-server.ts executeCommit`：在 sidecar 处理之后加 v2 mapScaleHints 应用段
  - 默认 frame = `{ cols: 100, rows: 100, frameRevision: 1 }`（0.9.51 SubMap 未持久化 cols/rows；hint frameRevision=null 时跳过匹配校验，向前兼容）
  - 应用结果分流日志：`applied` → `world-scale-hint-applied`，`skipped` → `world-scale-hint-skipped`（warn），异常 → `world-scale-hint-failed`（error，不阻断 commit）
  - 仅当存在 applied 结果时 `store.write("maps:<worldId>")`（写入经会话覆盖层 → 自动 rev+1 整体带回）

证据：
- 新增 `tests/atlas-r10-scale-hints.test.mjs` 11 项通过：applied / unknown-conflict / locked / frameRevision mismatch / frameRevision=null 兼容 / 未注册 mapId / 横纵超容差 / revision 自增 / validateScaleResponse 数值契约 / computeScaleBar 窗口 / formatDistanceMeters 单位
- 门禁：typecheck 0 errors；pack 通过（镜像同步）；test **471/471**（460 → 471）

残留：
- SubMap / AtlasMapDoc 未持久化 `cols/rows/frameRevision`——目前默认 100×100 是写死兜底；待 R09 子图层级改造时给 SubMap 加 `frame` 字段（schema 升 v3），届时按真实 frame 校验。
- `/worlds/scale/calibrate` 路由仍写死 100×100 提示词；同上等 R09 一起改。
- 标定 UI（R10 子任务"标定 UI"）未做——前端需要读 `stateData.maps.calibrations[mapId]` 渲染当前标定 + 锁定切换 + 重新估计按钮；纳入 R11 皮肤工作附近做。

## R09 — SubMap schema 升级 + frame 持久化 + 深度校验（2026-09-23）

- [x] `src/atlas-geo-apply.ts`：SubMap / SubMapDraft 加 `frame?: SubMapFrame` 字段；SubMapFrame = `{ cols, rows, frameRevision }`；新增 `SUBMAP_FRAME_DEFAULT = { cols:100, rows:100, frameRevision:1 }` 与 `SUBMAP_DEPTH_MAX = 4`
- [x] `sanitizeSubMap` / `sanitizeMapDoc`：frame 字段严格类型校验（拒绝字符串 / 负数 / 超大值）；旧子图（无 frame）→ `SUBMAP_FRAME_DEFAULT` 兜底；显式合法 frame 保留
- [x] 新增 `validateSubmapDepth(doc, pointId)` 纯函数：当前 schema 单层（`mapsDoc.submaps[pointId]`），循环引用防御 + 深度上限校验；返回 `{ ok, depth, maxReached }`
- [x] `atlas-server.ts handleScaleCalibrate`：使用真实 frame（世界图 / 子图各自的 cols/rows）替换原写死 100×100——AI 标定不再被默认 frame 误导
- [x] `sanitizeMapDoc` 同步导出（已 export）

证据：
- 新增 `tests/atlas-r09-submap-frame.test.mjs` 10 项通过：frame 透传 / 坏值丢弃 / sanitizeMapDoc 兜底 / sanitizeMapDoc 保留 / sanitizeNewLocations 透传 / validateSubmapDepth 单层 / 未挂子图 / 循环引用防御 / SUBMAP_DEPTH_MAX 常量 / SUBMAP_FRAME_DEFAULT 形状
- 门禁：typecheck 0 errors；pack 通过；test **481/481**（471 → 481）

残留：
- UI 弹窗跟随选中态刷新（pan / zoom / resize）+ 子图导航渲染（atlas-ui-core.ts 改造）— **未做**。需要真实 SillyTavern 环境验证 JS 命中 / DOM 重建 / 焦点切换；本环境无酒馆实例，纳入 R13 实机验收阶段。
- 子图三级（world → building → room）真实三层结构需要 schema v4（SubMap 携带子 submaps）；当前 `mapsDoc.submaps[pointId]` 单层，`validateSubmapDepth` 已埋好接口，UI 接入即可。
- `/worlds/scale/calibrate` 提示词仍写死 100×100；调用方应改为读 `doc.submaps[mapId].frame` 真实值动态拼提示。R11 集成阶段一起改。

## R11 — 增量皮肤令牌 + UI 钩子占位（2026-09-23）

- [x] 17 项 `--am-*` 增量令牌（沿用既有 `--aw-*` 收口令牌派生，不引入新前缀）：
  - 选中态：`--am-selected-outline`（实线 2px gold）、`--am-selected-shadow`（外阴影）
  - 子图面包屑：`--am-breadcrumb-text/sep/active`
  - 状态提示三态：`--am-status-{info,warn,error}-{bg,text}`
  - 头像：`--am-avatar-{npc,obj}-{bg,text,border}`（替换 mappanel 写死渐变色）
  - section-label：`--am-section-label-color`（替换 `#8a6a1c` 写死色）
- [x] mappanel 写死色全替换：`.aw-mappanel__avatar--npc / --obj / __section-label / __here-label` 全部走令牌
- [x] `.aw-point.is-selected` 钩子（outline + outline-offset:2px + 外阴影 + z-index:4）：UI 选中 marker 时挂上即可，不影响命中与位置
- [x] `.aw-breadcrumb / .aw-breadcrumb__item / __sep / .is-current` 占位类：R09 子图三层级 UI 接入点
- [x] `.aw-status--info / --warn / --error` 与 `.aw-banner--info / --warn / --error` 状态三态

证据：
- 新增 `tests/atlas-r11-skin-tokens.test.mjs` 7 项通过：令牌定义 / 类规则 / mappanel 替换验证 / 面包屑类齐全 / 状态三态齐全 / `is-selected` 钩子契约 / index.js 引用白名单
- 门禁：typecheck 0 errors；pack 通过（CSS 同步）；test **488/488**（481 → 488）

残留：
- 完整皮肤导入 UI（导入 .atlas-map-skin.json 文件 / 预览 / 应用 / 撤销）未做——主计划留作后续，需要 Atlas UI 改造范围更大（设计时间评估 1-2 个 commit），本轮先把令牌与钩子落地。
- 实机命中、皮肤切换后交互一致性、窄屏适配：纳入 R13 实机验收阶段。

## R13-R15 — 集成层回归 + 实机验收清单 + 文档收口（2026-09-23）

- [x] 新增 `tests/atlas-r13-r15-integration.test.mjs` 7 项集成层契约：
  - `createAtlasServerCore.reconcilePending()` 暴露可调 + 报告字段齐全
  - scaleHints 写入 maps sidecar 跨 serialize/deserialize 不丢失
  - orphan pending + applied calibration 共存不互相影响
  - 锁定值跨 session 序列化后仍拒绝 AI 覆盖
  - 单条 pending 的 read 失败不阻断整体 reconcile
  - settings 默认创建契约（v2 形状）
- [x] 新增 `docs/VERIFICATION.md`（10 节 ≥ 30 项实机验收清单）：环境基线 / 启动与首用 / 地图 DOM 命中 / 推演链路 / 事务与持久化 / 标定与地图尺度 / 旧档迁移 / 推进编辑器 / 皮肤与令牌 / 渲染与兼容性 / 性能与限额——任何一项失败需回写到对应 Rxx commit
- [x] `atlas-extension/README.md` 增量「已实现能力索引」：R00-R12 各阶段一句话状态 + R09-R11 / R13-R15 待集成项明示，避免作者误以为未开始

证据：
- 新增 `tests/atlas-r13-r15-integration.test.mjs` 7 项通过
- 门禁：typecheck 0 errors；pack 通过（CSS / settings.html / manifest.json 镜像同步；root dist 重建）；test **495/495**（488 → 495）

完成定义（计划 §完成定义）：
- ✅ P0 零未修复（R04 附近一致性 / R05 同轮新引用 / R06 起点迁移 / R12 原子事务全部落地）
- ✅ P1 每项有可观察行为和验收证据（R09 SubMap frame / R10 scaleHints / R11 令牌均带测试）
- ⚠️ UI 弹窗与子图三层级渲染 / 完整皮肤导入 UI：当前会话未做（无真实酒馆实例，留实机阶段）
- ✅ 旧档可恢复（reconcilePending 清 orphan）
- ✅ 比例尺有可追溯依据（R10 applyScaleHintsToDoc 记录 source / basis / confidence / evidence）
- ✅ 推演可编辑且请求生效（R02/R03 落地 + `POST /turns/preview`）
- ✅ 当前位置来自已确认剧情（R06 bootstrap + scene / lastConfirmed 分离）
- ✅ 发布包与源码一致（pack 镜像同步）
