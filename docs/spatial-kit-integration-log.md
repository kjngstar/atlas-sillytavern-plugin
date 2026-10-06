# ATLAS 空间接入包施工日志（spatial-kit-integration-log）

依据：`ATLAS-UI-Spatial-Integration-20261005.zip`（接入包）+ `ATLAS-UI-Spatial-审查补充-20261006.md`（审查补充）。
施工单：`docs/spatial-kit-tasks.json`（89 任务，V01–V17 已完成，M2 起待续）。

## 基线与工作分支

- 基线：0.9.75 / a0fa40a（与接入包固定基线一致）。
- 工作分支：`codex/starmap-ui` = main + checkpoint 提交 44dd3bc（此前未提交的新 UI 外壳修改：atlas-starmap-shell 等 12 文件 +1424 行，已完整保留）。
- 原包解压与 SHA 记录：`.tmp/spatial-kit/`（本地，不入库）。

## M1 完成情况（V01–V17）

- 16 个模块 + index.d.mts + LICENSE 复制至 `vendor/atlas-spatial/`，保留相对 import。
- 14 个文件与原包 SHA256 一致；2 个文件**有意偏离**（见下），符合审查补充"不能被原样复制 SHA 必须相同限制"的授权。
- 验证：Node import `vendor/atlas-spatial/index.mjs` 导出 41 个符号，无 DOM/Buffer 异常；kit 原 100 条测试（geometry + integration-kit）对修改后 vendor 副本 100/100，退出码 0。
- 第三方清单：vendor/atlas-spatial/ 为 ATLAS-UI-Spatial-Integration-20261005 包内 src 的衍生（MIT，见 vendor/atlas-spatial/LICENSE）；其改动为本仓库按审查补充所做的修正，不属于上游内容。

## 审查必修项落实

### 必修1：增量约束合并（vendor/atlas-spatial/generation.mjs，偏离原包）

- 新增受控约束字段：场景落盘时保存 `scene.constraints`（floor: corridorWidth/rooms/contents/actors/items；city: riverWidth/seed/blocksPerDistrict/districts/buildings）。
- 增量语义：默认按 ID 合并已保存约束（省略=保持）；删除必须经 `deletes:{rooms:[id],...}` 显式表达；`rebuild:true` 才是整图重建。
- 旧格式场景（无 constraints）按整图重建处理并给出 `CONSTRAINTS_LEGACY` 警告，语义明确。
- 失败路径统一带 `kept`（含 catch 路径，从 context.previousScene 取），满足"失败保留旧图"验收。
- POV 过滤剥离 constraints/inputSignature（见必修2），私密约束不下发 POV。
- actors/items 最终 SQL 归属重算属宿主层 W04 职责，vendor 层通过约束保留防止"模型省略=丢失"。

### 必修2：嵌套可见性清洗 + 隐藏路线过滤（vendor/atlas-spatial/view-adapter.mjs，偏离原包）

- `filterSceneForView` POV 分支新增 `stripLayoutForPov`：对 floor/city/overview 的每个集合按嵌套字段白名单逐层重建（含 bodies/polygon/path/a/b 点对象），privateExtension 等未登记字段在服务端被剥掉。
- overview 路线过滤：`hidden:true` 不下发；路线必须具备端点引用（fromLocationId/toLocationId，来自 routes 表真实列）作可见性依据；**全部端点可见才下发**（任一端点隐藏即整条路线视为隐藏路线，不泄露 ID 与路径）；无依据路线不下发 POV。
- `projectMapView` 路线 DTO 附带 fromLocationId/toLocationId/hidden。
- `publicMapFrame` 已剥离 atlasScene 与 atlasLayoutRequest（原包已实现，测试补断言）。
- author→pov 切换清旧数据、迟到响应不恢复作者信息：属 Q10（scopeGate epoch）宿主层职责，M4 实施时落实。

### 必修3：楼层建模决策（决策记录，不改 schema）

- **不动 `idx_maps_container_unique`**（同一分支、同一非空 container_location_id 只能一张 active 地图）。
- 表示法：建筑地点 → 各楼层地点 → 各楼层独立地图；每张楼层地图的 container_location_id 指向对应楼层地点，天然满足唯一索引。
- 地点 kind 无 floor 枚举：用现有 kind，楼层语义在展示层（U05 map tree 按 container 层级展开）表达。
- W06/W07 分支复制按此结构；不为符合包内文档"同容器多子图"字面语义做 schema 迁移。

### 必修4：路线 DTO 几何转换（vendor/atlas-spatial/view-adapter.mjs）

- `projectMapView` 同时接受两种几何：
  - 插件 `compileRoutePropose` 存储格式 `{kind,coordinates:[[x,y],...]}` —— 仅 `kind:'line'` 转换为路线；`polygon` 不当作行走路线（ROUTE_GEOMETRY_KIND 单项诊断）。
  - 原包格式 `{mapId,points:[{x,y},...]}` 向后兼容。
- 校验：地图归属（r.mapId 不符则跳过）、坐标数量≥2、坐标必须为有限数字（**null 也判非法**——JSON 序列化会把 NaN 变 null，原检查 `Number(null)=0` 会洗白成合法坐标，已堵）；坏路径单项诊断（ROUTE_COORDS_INVALID）不影响其他路线。
- cells → meters 按 metersPerCell 转换（k 乘子）。

## 新增测试

- `tests/atlas-spatial-vendor.test.mjs`：18 条用例覆盖上述必修验收（6+1=7 房间、省略保留、显式删除、rebuild、旧场景警告、失败 kept、privateExtension 剥离、POV 路线过滤、几何转换、坏路径单项诊断）。
- kit 原测试对修改后 vendor 100/100 无回归。

## 门禁（本轮实跑）

- `node --test tests/atlas-spatial-vendor.test.mjs`：18/18，退出码 0。
- kit 回归（.tmp/spatial-kit/t）：100/100，退出码 0。
- 全量 npm test / typecheck / build / pack：见提交信息与验收报告（门禁未过不算完成）。

## M2 · 小约束协议（P01–P07）已完成

### P01 操作注册（src/atlas-ops-contract.ts）

- `ATLAS_SEMANTIC_OPS` 追加 `map.layout.request`（14 → 15）；`PHASE_ALLOWED_OPS.geography` 放行。

### P02 字段校验（src/atlas-ops-normalize.ts）

- `OP_KNOWN_FIELDS['map.layout.request'] = ['kind','spec']`；`OP_ENUM_DICTS` 限定 kind ∈ {floor,city}。
- 新增 `normalizeLayoutSpec`：spec 必须是 plain object、UTF-8 ≤ 64KiB（超限 OPERATION_TOO_LARGE）、
  程序独占字段（seed/locks/metersPerCell/requestId/...）警告后剥离、六个集合逐条 id 非空且 ≤160 字符、deletes 形状校验。
- 新增运行时上限 `ATLAS_RUNTIME_LIMITS.layoutSpecUtf8Bytes = 64*1024`。

### P03 嵌套引用（src/atlas-ops-refs.ts）

- `OP_REF_KINDS['map.layout.request'] = 'map'`。
- `LAYOUT_SPEC_REF_FIELDS`：rooms.id→location、actors.id→character、actors.roomId→location、
  items.id→item、districts.id→location、buildings.id/districtId→location。
- `contents` 是家具**局部视觉 ID**池：`actors.near` / `items.on` 只在池内匹配，不建 entity_keys、不进依赖。
- 解析策略：`new:` 严格（未知→REF_UNKNOWN，类型不符→REF_TYPE_MISMATCH）；
  裸 ID 尽力规范化（命中短引用就转规范 ID），解析不到原样保留（省略即保持，绝不按名字猜）。
- `description` 等自由文本里的 `new:` 不当引用，不解析也不改写。

### P04 编译器（src/atlas-spatial-request.ts · 新增）

- 只产一条普通 `maps` RowMutation：写 `frame_json.atlasLayoutRequest`
  （requestId/operationId/createdTurnId/kind/mapId/rebuild/spec/inputSignature 由程序生成），
  原 frame 字段与 row_rev+1 保持不变；无 SQL、无网络。
- 增量合并：省略=保持、`deletes` 才删除、同 id 逐键合并。
- **同批累积在已编译候选态进行**：以 CompileContext 对象为 WeakMap 键，同批第二个请求并入第一个的结果
  （journal 同行合并是后写覆盖，所以必须在编译层累积，否则会抹掉前一个独立房间）。
- 幂等：`inputSignature` 与已保存一致时不产生变更，只回报读集与依赖。
- LAYOUT_REQUEST_CONFLICT（已登记进 ATLAS_ERROR_CODES）四种情形：
  spec.mapId 与 ref 不一致 / 同图 kind 冲突 / 同批同 id 同键不同值 / 引用了别图的实体（父图子图不可混用）。

### P05 编译注册（src/atlas-ops-compile.ts）

- `COMPILERS['map.layout.request'] = compileMapLayoutRequest`；走现有 normalize/ref/source/group 流程，
  未开任何直接提交分支。compilerTable() 15 项。

### P06 提示词（src/atlas-ops-prompts.ts）

- `MINIMUM_HELP['map.layout.request']`：只给当前地图 constraints，不输出完整 scene/几何/seed/比例尺。
- geography 任务段新增三条纪律：已存在结构不每轮重写、删除必须显式、无河流资料不选 city 模板的水系。
- 新增 `mapLayoutIds` / `mapLayoutFrame` / `mapLayoutLocks` 注入（程序提供 ID、尺寸、确认锁摘要）。
- 同步修 `tests/atlas-ops-prompts.test.mjs`：T23-02 的 14→15、帮助清单正则改三段式操作名、geography 允许集合加新操作。

### P07 回归测试（tests/atlas-spatial-ops.test.mjs · 新增 14 用例）

走真实编译入口（parseOperations → compileOperations），断言变更行、依赖、原 frame 与 row_rev、原数据未被改写。

## 门禁（M2 实跑）

- `node --test tests/atlas-spatial-ops.test.mjs`：14/14，退出码 0。
- 全量 `npm test`：1506/1506，退出码 0。
- `npm run typecheck`：0 errors。
- `npm run build` / `npm run pack`：退出码 0。

## M3 候选提交与回退（W00–W09）

- W00 `src/atlas-spatial-frame.ts`（新增）：包 vendor `prepareInitialFrame` / `readSceneFrame`；
  新空图 30×24m → 100×80 格、mpp=0.3、尺度 estimated、calibration_rev 递增；已有 scene / 已定位地点 / 已确认或锁定尺度一律 retained；
  缺尺寸走概览并记 `INITIAL_EXTENT_MISSING` warning（传 NaN，不拿 0 去算零跨度框架）。
- W01 `src/atlas-spatial-candidate.ts`（新增）：`applyPendingSpatialRequests`，只在宿主已有候选事务内同步执行，
  按 requestId 稳定排序，默认 maxJobs=2，每张图一个 `atlas_spatial_component` savepoint，前后都查 `isCurrent()`，
  内部生成传 `viewMode: 'author'`（后续 POV 仍过滤）；不 COMMIT、不保存聊天、不调模型。
- W02 同文件 `recordFailedSpatialRequest`：只改 frame 的请求状态为 failed 并存完整 Issue 列表，
  保留 atlasScene 与地点坐标；写不进去抛 `SPATIAL_FAILURE_RECORD_FAILED`。
- W03 `src/atlas-db-repository.ts`：钩子落在 `settleSqlTurn` → 重开事务 → `foreignKeyCheck`/`validateCandidate` 之间，
  追加 groupResults/allIssues；模型 await 期间不持事务；不移动保存确认边界。
- W04 `src/atlas-spatial-occupants.ts`（新增）：`reconcileOccupantsSpec` 以最后 SQL 归属重建 actors/items，
  迁出/被持有/跨房间一律移除；无支撑家具组的地面物品进 `looseItemMarkers`（不删数据库行、不造桌子）。
  **生成器语义是「省略=保持」，所以移除必须走 `deletes`** —— 输出里多了 `deleted` 字段就是这个原因。
- W05 同文件 `placeLooseItems` + candidate 内 `applyLooseItemMarkers`：用 vendor `placeMarkers` 在房间可通行区补视觉点，
  只追加 `scene.layout.items`，不改 SQL 归属；走自己的 savepoint。
- W06 `src/atlas-spatial-branch.ts`（新增）：`copySceneForBranch` 纯函数，重写 branchId/sourceRevision、
  保留 provenance 与几何，删掉父 pending 请求；不可用场景保留但标 `atlasSceneUnavailable`，坏帧给 `FRAME_JSON_INVALID`。
- W07 `src/atlas-db-branches.ts`：`copyTableRows` 在 table=maps / column=frame_json 时调用 W06，revision 用父分支的 revision。
- W08 `src/atlas-sql-chat.ts` + `src/atlas-db-repository.ts`：新增 `layout-retry` 受控动作与 `TurnInput.layoutRetry`，
  只对指定地图的 failed 请求开新 ticket/opID，走 manual turn（不重放事件、不推进时间），回执原样给 UI。
  **坑**：重新武装的写入必须用独立 opID（`…:arm`），否则同 turn 同表同行会被幂等记账判成 duplicate，把场景那一组整组吞掉。
- W09 `tests/atlas-spatial-storage.test.mjs`（新增 22 用例）：真实 schema/codec/applyGroups/journal/rollback，
  含 prepareTurn 钩子、失败 request、迁入迁出、fork、延迟外键在 COMMIT 处失败后 maps/locations 一起回原值。

### 门禁（M3 实跑）

- `node --test tests/atlas-spatial-storage.test.mjs`：22/22，退出码 0。
- 全量 `npm test`：1528/1528，退出码 0。
- `npm run typecheck`：0 errors。
- `npm run build` / `npm run pack`：退出码 0。

## M4（Q01–Q13）只读数据口

- Q01 `src/atlas-ops-contract.ts`：新增 `VIEW_KINDS`（11 种，补 scene/catalog/flows/tasks）、`CATALOG_ENTITY_KINDS`、
  `asViewKind`、`normalizeViewLimit`（默认 50、上限 200）；`src/atlas-runtime-limits.ts` 补 `catalogViewDefaultLimit` / `catalogViewMaxLimit`。
- Q02 `src/atlas-db-views.ts`：导出 `projectRouteGeometry`（只认 `kind==='line'` + ≥2 有限点，坏几何给 null + 逐路由 issue）；
  routes 补 `geometry`/`mapId`/`fromLocationId`/`toLocationId`；`frames.frame` 改走 `publicMapFrame`（同时删 `atlasScene` 与 `atlasLayoutRequest`）；
  地面物品 `at_grid` 补 `locationId`；`metadata.routeIssues`。
- Q03 `src/atlas-spatial-views.ts`（新增）：`querySpatialScene` 严格按包内顺序
  readSceneFrame → `filterSceneForView`（当前 SQL 可见集合 + POV 白名单）→ `hydrateScene`（同 revision 投影）→ 固定 DTO；
  `sceneStatus` = `ready` / `missing`（合法旧档）/ `invalid`；POV 拿不到 `inputSignature` 与隐藏实体。
- Q04 `src/atlas-catalog-views.ts`（新增）：`queryCatalog` 五种实体统一别名 `l`，风声走 `information` 子查询取 title/content；
  keyset 游标 `{v:1,scope,k,name,id}`，游标自带 queryScope 校验，多种类模式用 `k` 记录种类进度续页；**POV 不返回任何总数**。
- Q05 `src/atlas-spatial-flow-views.ts`（新增）：`querySpatialFlows` 三类（journey / relation / propagation）；
  行程进度只按已提交 segment 的标称耗时/距离，缺依据给 `progress:null` + `progressQuality:'unknown'`；
  **只读，绝不调 `scheduleDeliveries`**，`metadata.readOnly: true`。
- Q06 `src/atlas-task-views.ts`（新增）：`queryTasks` 读 actions/journeys/events 实际表，
  `planned`（意图）与 `occurredAtS`（已发生）分开，无时间给 null + `timeQuality:'unknown'`。
- Q07 `src/atlas-db-repository.ts`：`queryView` 注册 `scene`/`catalog`/`flows`/`tasks` 四个 case，ctx 补 `chatId`；
  注释写明「绝不把 writer / saveSession 交给读口」。
- Q08 `src/atlas-sql-view-state.ts`：`sqlViews` 增 scene/flows/tasks，目录走 `catalogBase` 不预取；`focusMapId` 取主角所在图。
- Q09 `src/atlas-sql-browser-entry.ts`：导出四个只读口 + `projectRouteGeometry` + vendor 渲染器侧
  （`projectMapView`/`unwrapViewResult`/`filterSceneForView`/`publicMapFrame`/`buildMapTree`/`createSpatialRenderer`/`buildOverlays`/`ATLAS_SPATIAL_LIMITS`）；
  **写侧 `applySceneGroup`/`compileSceneGroup`/`applyPendingSpatialRequests` 一个都不导出**。
- Q10 `ui/atlas-sql-view-controller.mjs` + `index.js`：新增 `sqlScopeTicket(d)`（scope key + 视角）、`SQL_READONLY_KINDS`、
  `sqlClearReadViews()`（清视图/选择 + 关旧只读会话）；`sqlSyncViewScope` 改用 ticket 判定；`sqlWarmViews` 加 scene/flows/tasks。
- Q11 `src/atlas-db-views.ts`：`queryEntityDetail` 人物分支补 `heldItems`（含 POV 的 `povHeld`），
  地点分支补 `groundItems`（`holder_character_id IS NULL AND container_item_id IS NULL`）、`childMaps`、`coarsePresent`。
- Q12 同文件：`queryDiagnostics` 重写——双游标命名空间（`ch:<turn_id>|<sequence>` / `ft:<created_wall_ms>|<id>`）、
  回执 groups/issues 摊平、`redactForLog` 脱敏（`sk-…`/Bearer/32+hex/敏感 key 名/response/headers → `[redacted]`）、
  `coreCommitted` 取真实回执；`remainingChanges`/`remainingFailedTurns` 表「未取回」，`droppedCount:0`、`exportComplete:true` 表「没丢」。
- Q13 `tests/atlas-spatial-views.test.mjs`（新增 8 用例，全绿）：Q13-01 POV 序列化扫秘密、Q13-02 同 revision、Q13-02b 旧档 missing、
  Q13-03 父子地图/多楼层/地面物品、Q13-04 routes·items·frame、Q13-05 catalog 2001 条翻到末页、Q13-06 diagnostics 60 条失败轮翻完、Q13-07 纯查询无写。
  `tests/atlas-build-artifacts-p0.browser.test.mjs` 追加 P0-04d（无 Buffer 环境下 import 只读口 + 断言写侧未泄漏）。

### 门禁（M4 实跑）

- `node --test tests/atlas-spatial-views.test.mjs`：8/8，退出码 0。
- `node --test tests/atlas-build-artifacts-p0.browser.test.mjs`：4/4，退出码 0。
- 全量 `npm test`：1537/1537，退出码 0。
- `npm run typecheck`：0 errors。
- `npm run build` / `npm run pack`：退出码 0（pack 前按二进制同步 `atlas-extension/index.js` 镜像并恢复 dev 回退行）。

## M5（U01–U16）新 UI 连接

- U01 `ui/atlas-workbench-model.mjs`（新增）：`createWorkbenchModel(ports)` —— 唯一 UI 状态
  `{scope,mapId,selected,page,views,settings,cameraByMap}`；ports 由宿主注入，数据只走 Q 系列只读口。
  相机 key 含 chat/branch/map/viewMode（**不拿全局 currentScene 跨聊复用**）；每次查询开新 ticket，
  过期回包拒绝落地；empty/stale 清空视图与选中；状态里**没有时钟字段**，切页不可能推进世界时间。
- U02 `ui/atlas-workbench-shell.mjs`（新增）：`mountWorkbench(host, ports)` 组合出 05 号文档的六个区域
  （导航 / 地图树 / 中央地图 / 右详情 / 底部事件带 / 左下读者侧栏）。同一 root 用 WeakMap 保持单例，
  **重复 mount 先销毁旧实例**；全部文本走 textContent。
- U03 `ui/atlas-workbench.css`（新增）：作用域限定 `.atlas-starmap`，不 reset body/button；
  canvas 容器 `min-width:0`；比例尺固定 96 CSS px（窄屏 64）；图例在标尺上方；900px 断点侧栏抽屉；
  `prefers-reduced-motion` 停动效。
- U04 `ui/atlas-map-controller.mjs`（续）：新增 `createWorkbenchMapController(ports)`——
  一个手势 owner；同 scope 并行取 map/scene/flows，**确认同一 revision 快照**后才投影；
  过期 response 不 setScene；缺 scene 报 `SPATIAL_SCENE_EMPTY` 走 SQL 概览；坏 scene 不清掉已有效的旧图。
- U05 `ui/atlas-map-tree.mjs`（新增）：`renderMapTree` / `mapsForLocation` / `mapPath` / `parentMapOf`，
  层级最多 9 层、自环不死循环；多个楼层全部渲染，**不自动挑第一项**。
- U06 `ui/atlas-entity-panel.mjs`（新增）：地点 / 人物 / 物品三类卡，子地点、在场、地面/持有物品、
  thought/action/journey/knowledge 分块；未选中显示「未选中」；author 隐藏内容标「后台」。
- U07 同上文件（续）：`enterSelectedLocation` + `handleClick` —— 默认单击只开详情；
  `singleClickEnter=true` 且**唯一**子图才直接进；多子图交 `onChoose` 选层；双击 / Enter 与按钮共用 `force` 分支；
  拖拽 >4 CSS px 不算点击。
- U08 `ui/atlas-catalog-panel.mjs`（新增）：Q04 分页对接 + 紧凑搜索（上限 20）。
  debounce + 代次：q 变化时上一代**显式 resolve(null)**（不是让它悬着），旧 cursor 一并作废；POV 不显示总数。
- U09 `ui/atlas-world-timeline.mjs`（新增）：底部本轮 事件/到达/经过/风声/任务；
  blocked 标「等待条件」**不标已发生**；秘密条目只 author；跨地图事件带 mapId 交给宿主播切图再定位。
- U10 `src/atlas-world-summary.ts`（新增）：`buildVisibleWorldSummary` / `…Sync` —— 1–3 条读者动向，
  技术串（`TABLE_MIGRATED` / 「应用 N 行」/「第 0→0 时段」/ `WORLD_TURN`）一律过滤；
  可选模型摘要只收到可见小集合，失败回退程序模板；无公开变化给正常空说明。
- U11 `ui/atlas-world-summary.mjs`（新增）：绑定 turnId / revision / 视角，
  **stale 不沿用上一聊天摘要**，显示等待说明。
- U12 `ui/atlas-unified-log-panel.mjs`（新增）：一条时间线合并 host/model/storage/map/receipt，
  按 trace/attempt/turn/group 分组展开；code / path / dependency / message 完整显示；
  默认脱敏（sk- / Bearer / 32+hex），敏感键（`api_key`/`headers`/`response`…）不进日志页与导出。
- U13 `src/atlas-diagnostics.ts`：新增 5 个 `SPATIAL_*` 具名诊断，允许键
  `mapRef/entityRef/operationRef`（指纹形）+ `module/function/phase/sceneStatus/bytes`；
  sanitize 侧同步加白名单与取值校验（`module|function|phase` 只收标识符，`sceneStatus` 收 4 个枚举，`bytes` 收 0..64MiB 整数）。
- U14 `src/atlas-ui-core.ts`：**单一权威** `ATLAS_UI_PAGES` 扩到 13 页，新增 人物 / 物品 / 事件 / 提示词，
  原 9 页一个不少；提示词与「推进」共用同一套草稿（只给独立路由，不建第二份状态）。
- U15 `index.js`：`createStarmapShell` 换成 `mountWorkbench`（内部仍是同一份 starmap 布局 + 新面板），
  ports 注入 `queryView = sqlQueryView` / `emitDiagnostic`；新增 characters / items / events / prompts 四个渲染分支；
  同 root 单例 → 不会有两个地图实例或重复监听。源 index.js 为权威，镜像由 pack 同步。
- U16 `tests/atlas-workbench.e2e.test.mjs`（新增 12 用例）+ `tests/atlas-workbench.test.mjs`（新增 18 用例）。
  **U16 明确为 harness**：jsdom 派发真实 DOM 事件；320px 与 96px 标尺改为 CSS 契约断言。
  ⚠️ **更正（2026-10-06）**：本节原先写「本环境 node_modules 内没有 playwright，也没有浏览器二进制，未做真实浏览器验收」——
  该判断是错的：`import('playwright')` 可用，`C:/Program Files/Google/Chrome/Application/chrome.exe` 也在。
  真实浏览器验收已补（见下「M5 返工」章节与 `tools/verify-workbench-browser.mjs`）。
  教训：**「源文件已存在」不是接线完成的证据**。jsdom 拿不到 canvas 2D、真实样式表与真实手势，
  验收报告里的四类故障（正式地图没挂渲染器 / 目录被滤空 / 双树并存 / CSS 从未加载）它一条都看不见。

### 门禁（M5 实跑）

- `node --test tests/atlas-workbench.test.mjs`：18/18，退出码 0。
- `node --test tests/atlas-workbench.e2e.test.mjs`：12/12，退出码 0。
- `node --test tests/atlas-diagnostics.test.mjs`：31/31，退出码 0。
- 全量 `npm test`：**1566/1566**，退出码 0。
- `npm run typecheck`：0 errors。
- `npm run build` / `npm run pack`：退出码 0（pack 前按二进制同步 `atlas-extension/index.js` 镜像并恢复 dev 回退行）。

## M5 返工（2026-10-06，触发：`ATLAS-UI-Spatial-进度验收-20261006.md` 判定 M5 不通过）

验收结论：M5 的**源文件与单测都在**，但正式 UI 根本没接上——真实浏览器里 canvas 数量为 0。
返工只做一件事：把「文件已存在」换成「真实浏览器里跑得起来」。逐项如下。

| 验收项 | 现象（验收报告） | 根因 | 返工 |
| --- | --- | --- | --- |
| P1 / U04 | 新控制器查了 scene 却不消费，合法 floor 场景被画成 overview 还回报 ready | `showMap` 只 `setScene(projection.scene)` | 新增 `resolveScene(snapshot)`：`sceneStatus=ready` 且有 `scene` 载荷 → 直接 `setScene(entry.scene)`，**不走 projectMapView**；missing/invalid 才退概览并记诊断 |
| P1 / U08 | 真实浏览器目录为空，同库 author 查询有 4 人 | `atlas-sql-view-controller` 用 `{kind, ...query}`，调用方的 `kind:'character'` 把视图类型覆盖掉；面板把实体种类塞进了 `kind` | 改 `{ ...query, kind }`（视图类型最后写入）；面板改传契约字段 `entityKind` |
| P1 / U08（另一半） | 同上 | 工作台 model 的查询口径被 `shell.sync` 从 `/state` 的 `sqlViewMode` 字段反推成固定 `pov`，主角知识为空的世界目录整体被滤掉 | `sync` 改用宿主单一权威口径（renderPage 把当前 `sqlViewMode` 放进 snapshot），与地图同一口径 |
| P1 / U15 | index.js 仍用旧 `createMapController` + 旧 `mountViewport`，`createWorkbenchMapController` 从未实例化 → canvas 0 | 新渲染器只是「文件在」，没有生产调用点 | index.js 新增真 canvas（`.aw-spatial-canvas`）+ `ensureSpatialMapController()`；渲染器可用时旧绘制整段 `return`（旧标点归零、`camera=null` 防双 owner）；jsdom 拿不到 2D 上下文时回退旧路径 |
| P2 / U05 | 旧树 7 项 + 新树「当前世界还没有可进入的地图」双树并存 | 宿主把旧行数组喂进 `renderMapTree` 的 `tree.nodes`；回调行形状也不匹配 | 宿主另算 `spatialTree = buildMapTree(...)` 单独传；**旧 shell 在权威模式下不再绘制旧列表**（不是画完再隐藏） |
| P2 / U03 | Chrome `document.styleSheets` 里没有 atlas-workbench.css | 该 CSS 没有任何加载入口 | `ensureWorkbenchStylesheet()` 按 `import.meta.url` 解析真实路径插 `<link id="atlas-workbench-css">` |
| P2 / U01/U06/U09/U11/U12 | `sync` 没设 model scope；`showEntity/showTimeline/showSummary/showLog` 从未被调 | 面板槽位是空壳 | `showEntity`（渲染器 onSelect 双路）、`showTimeline` + 摘要（地图页 `renderSpatialPanels`）、`showLog`（日志页带游标）全部接线；目录页头部文案跟随当前口径，不再硬写 POV |
| P2 / U16 | 验收只 `readFileSync` 断言 CSS 文本 | jsdom 看不见真实接线 | 新增真实 Chrome 门禁 `tools/verify-workbench-browser.mjs`（12 项断言，不过就非零退出） |

### 返工后门禁（实跑）

- `npm test`：**1574/1574**，退出码 0（含 3 条返工回归 + 2 条**发布镜像一致性**门禁）。
- `npm run typecheck`：0 errors。
- `node tools/sync-mirror.mjs && npm run pack`：退出码 0。
- `npm run verify:workbench`（真实 Chrome + dev-preview 的 SQL 宿主页）：**12/12 通过**。
  证据：`docs/atlas-m5-rework-evidence-20261006.json`（含截图 `docs/atlas-m5-rework-{map,mobile}.png`）。
  实测值：canvas `940×683` 且真在画（546 色）、旧标点 `0`、新树 `7` / 旧树 `0`、
  `atlas-workbench.css` 进 `document.styleSheets`、人物目录 UI 名单与后端查询**逐条相等（4×4）**、
  日志页记录 `19 条`、点画布标点出详情卡 `awb-card--location / loc:4101`、
  320px 无横向溢出、无 pageerror、无 4xx。
- `node --test tests/atlas-workbench.test.mjs tests/atlas-workbench.e2e.test.mjs`：37/37。

### 两条新门禁（防止同类返工再发生）

1. **发布镜像一致性**（`tests/atlas-extension-harness.test.mjs`）：`atlas-extension/` 是发布镜像，
   必须与仓库根逐字节一致（只有 index.js 的 dev 回退行不同）。浏览器验收跑镜像、单测跑根源码，
   镜像一落后两边就不是同一份代码——本次排查被这个假象误导过一次。
2. **真实浏览器验收**（`tools/verify-workbench-browser.mjs` / `npm run verify:workbench`）：
   断言 canvas 已挂且在画、单一绘制 owner、单棵权威树、CSS 真进样式表、目录与后端同口径、
   日志有记录、详情卡拿到实体、窄屏不溢出、无 JS 错误与 4xx。

### 尚未覆盖（诚实记录）

- `sceneStatus=ready` 的浏览器路径没有实测样例：demo 世界的 7 张地图全部是 `sceneStatus=missing`
  （无已保存 floor 场景），浏览器里走的都是概览回退。该分支目前只有单测覆盖
  （`scene ready 优先画已保存 floor 场景`，断言 `mode==='scene'` 且投影器零调用）。
- 真实酒馆（SillyTavern）内的验收、在线模型请求、发布仍未执行。

## 待办（M5 返工后，共 26 项 pending）

阶段命名以 `docs/spatial-kit-tasks.json` 的 `stage` 字段为准（验收报告点名过本节此前把 S/T/X 的阶段名写串了，
已按任务表更正：S = 预设管理、T = 皮肤接口、X = 扩展生成器、R = 完整交付验收）。

- M1（V01–V17）：已完成。
- M2（P01–P07）：已完成。
- M3（W00–W09）：已完成。
- M4（Q01–Q13）：已完成。
- M5（U01–U16）：已完成，并已按验收报告返工 + 通过真实浏览器门禁（见上）。
- M6 预设管理（S01–S08，8 项）：`src/atlas-settings.ts` 起——`ui={singleClickEnter,viewMode,lastPage}`、
  `taskBindings={layout,simulation,summary}` 与迁移。
- M7 皮肤接口（T01–T05，5 项）：`src/atlas-ui-skin.ts`（新增）——固定 skin schema、资源限额与清洗、
  旧 `atlas-map-skin` 迁移映射、用户包不执行 JS。
- M8 扩展生成器（X01–X06，6 项）：`src/atlas-spatial-templates.ts`（新增）——按地图 kind/约束选
  floor/city/overview/generic，unsupported 明确回退，不编造河流/走廊。
- M9 完整交付验收（R01–R07，7 项）：`tools/build.mjs` 起——新增 JS/CSS 进构建、browser entry 自动打包
  vendor、无 Node-only 依赖、保留 SQL worker/WASM 路径；含真实酒馆内验收（浏览器门禁不能替代）。
- 未执行：真实酒馆聊天保存、在线模型请求、发布（按纪律不推送不打 tag）。

## M5 功能修复（2026-10-06，Codex 独立复验后）

按《ATLAS-UI-Spatial-返工复验》修复：视角残留、子地图导航、相机控件、目录详情、地点卡子图入口。
目录和地图共用正式 entity 查询；scope 失效同步清画布和详情；POV 不复用作者 DTO；地图导航重建完整父链；
新相机接缩放/适配/定位与百分比；子地图按钮、双击和 Enter 均接到实际导航。

最终实跑：全量测试 1581/1581、类型检查与 pack 退出码 0；真实 Chrome 门禁扩至 25/25，
包括已保存 floor/city 经隔离 SQL 进入正式 Canvas。说明见 `docs/atlas-workbench-functional-fix-20261006.md`。
Git 远端对象和当前缺失 vendor 目录对象已恢复；未上传的部分本地历史与旧 stash 对象仍缺失，引用保留。
