# 阿特拉斯 / Atlas 待办计划

> 本文件是阿特拉斯插件的**当前执行入口与进度表**。
>
> 完整产品边界、接口、数据结构、安全要求和逐包验收标准见 [`README.md`](./README.md)。执行者必须先读完整开发计划，再按本文件顶部的当前工作包行动。
>
> 更新时间：2026-09-17

## 当前结论

- **项目状态：ATLAS-00 ～ 05 + ATLAS-FIX-01 自动测试通过；作者决定转向纯浏览器形态**（2026-09-17：不再要求安装 Server Plugin，目标 = shujuku 式一个 GitHub 链接装完即玩）。Server Plugin 版保留为进阶形态（文件级数据安全），不再作为发布必需品。
- **当前唯一工作包：ATLAS-09｜纯浏览器模式（P0）——自动化侧已完成（AR-ATLAS-09，143/143），待作者真实酒馆人工验收**（安装 → 悬浮窗 → 绑定 → 回合 → 世界书条目 → 重试 → 刷新恢复 → 卸载）；验收通过即关闭，回到 ATLAS-06。剩余作者侧动作：真实酒馆人工验收、GitHub 建仓发布、深色主题观感确认、（可选）真实付费 API。
- Atlasia 主平台位于上级目录 `E:\地图\`；阿特拉斯位于 `E:\地图\阿特拉斯\`。
- **阿特拉斯与 Atlasia 是两个独立项目**（作者 2026-09-18 拍板）：仓库独立、可单独发布、脱离 Atlasia 工作区也能 `npm install && npm test`；世界核心以**逐字节快照**内嵌在本仓库 `lib/`（来源、日期与同步纪律见 `lib/VENDORED.md`，2026-09-18 快照，14 文件）。与 Atlasia 的"联系"= 同源同逻辑：核心演进先改 Atlasia 上游，再整体重新快照同步，**不在快照里做 Atlas 私有修改**，不建立第二套距离、时间、NPC、触发、账本和分支逻辑。
- 本轮不得接真实付费 API，不得修改或迁移用户世界。

## 当前工作包：ATLAS-09｜纯浏览器模式（P0）

### 目标

把 ATLAS-00～05 + ATLAS-FIX-01 已建成的世界引擎整体搬进浏览器：UI 扩展单件交付，安装后零配置、零服务端依赖。发布形态 = shujuku 式：一个 GitHub 链接，链接装完即玩。

### 架构决策（本包前提）

- **【UI】世界工作台（悬浮窗形态）**（作者 2026-09-17 拍板，09-16 修订形态）：不是 300px 角落挂件，而是 Atlasia 正传式布局——**左侧功能栏（概览 / 地图 / 附近 / 变化 / 设置）+ 中央页面区 + 右侧世界变化简览**；**形态是居中悬浮窗（可拖动，不铺满屏幕）**，不是全屏覆盖层；中央区**随左栏栏位切换页面**，地图只属于「地图」页。视觉沿用 Atlasia 设计语言（纸质米色 / 深青 / 金 / 衬线）。
- **【注入】推演结果落世界书**（作者 2026-09-17 拍板）：commit 完成后，把「NPC 动向」「近期可能触发的任务 / 活动」写成 Atlas 专属世界书条目（关键词 = NPC 名 / 地点名），让主模型经酒馆正常世界书激活管线看到推演结果；当轮注入（setExtensionPrompt）保留作为"本轮即时上下文"。**开工前必须核实扩展写世界书的公开接口**（getContext 的 lorebook / world_info 能力），不得凭印象写。
- **世界引擎（prepare / commit / 相关性 / 账本事务）原样复用**：`atlas-server.ts` 纯 dispatch 核心无 Node 依赖，直接打进 UI 扩展在浏览器运行；Atlas 端点零网络。
- **世界存储** → 浏览器侧 `AtlasDocumentStore` 实现（extensionSettings / 酒馆设置持久化），保持 store 契约与严格解析不变。
- **推演模型调用** → 复用酒馆自带后端代理（`/api/backends/chat-completions/generate`），规避浏览器 CORS；**同样必须先核实请求契约**。
- **密钥**：浏览器形态下密钥由用户在设置页自填（存浏览器侧）；设置页明示与 Server Plugin 版的差异。Server Plugin 版保留为进阶形态。

### 实施清单

- [x] **核实两个上游契约**（2026-09-17，官方 release 源码逐行核实，非摘要推断；核对文件已删，行号即证据）：① 世界书写入 = `public/scripts/world-info.js` 导出 `createWorldInfoEntry(_name, data)`（分配 uid + 模板，写回 `data.entries[uid]`）、`saveWorldInfo(name, data, immediately=false)`（内部 POST `/api/worldinfo/edit` + `getRequestHeaders()` 自带 CSRF；缓存不深拷贝 → 保存后不得再改对象）、`loadWorldInfo(name)`（返回深拷贝）、`createNewWorldInfo(name)`、`deleteWorldInfoEntry(data, uid)`；聊天绑定 = `METADATA_KEY='world_info'` + `getContext().chatMetadata / saveMetadata / saveSettingsDebounced`（st-context.js 已确认导出）。② 后端代理 = `src/endpoints/backends/chat-completions.js` `/generate` CUSTOM 分支（L2394-2410）：`chat_completion_source:"custom"` + `custom_url` + `custom_include_headers`（mergeObjectWithYaml 并入上游请求头）+ `custom_include_body`/`custom_exclude_body`；CUSTOM 豁免服务端密钥检查（L2615）→ 密钥经 `custom_include_headers:{Authorization:"Bearer <key>"}` 由浏览器侧随请求传入，不写服务端 secret；非流式响应 = 上游 JSON 原样透传，流式 = SSE 原样转发；上游错误一律包成 HTTP 500 + 上游 JSON。
- [x] **工作台 UI**：左功能栏 + 中央页面区 + 右侧世界变化简览；`style.css` 全量重写为 Atlasia 令牌（纸质米色 #f2efe7 / 深青 #255f5b / 金 #c4a363 / 衬线 / 45° 菱形 brand-mark，以作者批准的《Atlas全屏工作台方案.html》为基准）；五页内容迁入工作台分区。**浅色单主题（方案即浅色纸面），深色主题对比度实测随打包前走查补。**顺带修复旧面板潜在 bug：STATUS_LABELS 从未定义（回执渲染即 ReferenceError）。
- [x] **UI 形态修订**（作者 2026-09-16 反馈，四条一次做完）：① **悬浮窗**取代全屏——`inset:0 + margin:auto + width:min(1180px,94vw) + height:min(780px,88vh) + 14px 圆角 + 大投影`；**刻意不用 `translate` 居中**，把 `translate` 留给顶栏拖拽（`root.style.translate`），窄屏三档（980 / 720）逐级收窄而非铺满；② **中区随栏位切页**——`renderCenter` 按 `state().page` 分支，地图只在「地图」页构建；③ **右栏 = 世界变化简览**（最近 4 条 + 状态圆点 + 「查看全部变化」跳转），**预览控制从左下角浮条迁入右栏 `.aw-dev` 槽**（宿主提供 `window.__atlasDevSlot` 才出现，生产不渲染）；④ **API 管理照抄 shujuku 范式**——预设槽（世界推演 / 重大事件）分段切换 + 名称 / 端点 / 密钥(type=password，占位显示尾号) / 模型名 + 「加载模型」（经酒馆代理打 `/api/backends/chat-completions/status`）+ 模型列表下拉 + 最大回复长度 / 温度两列 + 保存 / 清空。**本轮修掉 3 个真实缺陷**：(a) `renderCenter()` 有 12 处无参调用点但函数体直接读 `d.worldId` → 切页即 TypeError（补缺省 `d = data()`）；(b) 地区下拉只调 `renderCenter()` 不重算点位 → 筛选无效（改走 `renderPage()`）；(c) `connectAtlas` 无并发闸门 → 模块自初始化与 `hooks.activate` 并发时双重挂载（补在途 Promise `connecting`）。**并把 CSS/DOM 类名一致性做成核对**（发现重写时漏掉 `.aw-list` / `.aw-list__item` / `.aw-world-list-panel` → 世界列表裸奔，已补；清掉 `aw-world-list*` / `aw-empty` / `aw-hint` 三条死规则）。
- [x] **地图展示增强**（作者 2026-09-17 提问后增补）：① 区域钻取 = /state 新增 `regions`，地图左上「全部地区 ▾」下拉按 regionId 过滤点位 / NPC / 物件（纯 UI 层，不改共享 schema）；② NPC 标记 = /state 新增 `npcDirectory`（resolveCharacterPosition 动态状态优先、旧档案回退，坐标取锚点地点），地图渲染金色圆点 + 名牌（reason 标签）；③ 物件标记 = /state 新增 `objectDirectory`（world.entityRecords 带 mapAnchor 的非 npc 实体），渲染深青小菱形。网格背景 + 1x–3x 缩放保留。
- [x] **世界书注入层**（2026-09-17，`src/atlas-lorebook.ts` 红后绿 14 用例）：commit 成功后由引擎**纯派生**条目规划（`buildLorebookPlans(world, receipt)`，duplicate / failed / 空轮 → null），随 commit 响应返回 `data.lorebook`；UI 核心解析（`parseAtlasLorebookPlans` 严格拒绝超限 / 形状非法）后经注入钩子 `onLorebookSync` 交给扩展端，**扩展端经酒馆 world-info 公开 API**（动态 import `../../../world-info.js`，预览 / 测试可用 `window.__atlasWorldInfoModule` 注入 stub）写入 **Atlas 专属世界书**。条目规则：每轮最多 2 条——「Atlas 动向 ·」关键词 = 本轮被 effect 触及的 **NPC 名**（含记忆 / 叙事明细行），「Atlas 事件 ·」关键词 = 回执落点**地点名**；内容有界（≤480 字）且尾部带来源行（时段区间 + 回执号截断）可追溯；按 comment upsert（重复同步不重复条目）、按类目滚动修剪（新 → 旧各留 12 条）；**聊天绑定槽 chatMetadata.world_info 只在为空时绑定，已有绑定 → conflict 上报 UI 提示，绝不静默覆盖**；目标书存在但形状非法 → 拒绝写入（不覆盖非 Atlas 的书）；保存后不再触碰 data（酒馆缓存不深拷贝）。世界书写入失败 / 冲突只记 `lorebookHint` 展示在「变化」页，**绝不影响回合成功**（世界已原子落库）。变化页新增「世界书条目」面板（快照持久化在 store 的 `lorebook` 文档）；预览夹具注入同形 stub，无真实酒馆也能看到完整链路。
- [x] 浏览器侧 `AtlasDocumentStore`（extensionSettings 持久化；有界；严格解析）+ 单测。**已完成**：`src/atlas-browser-store.ts` = `{schemaVersion:1, docs:{}}` 整包进宿主 KV；单文档 4M / 总量 16M / 256 文档三重上限（超限 `FIELD_LIMIT_EXCEEDED`，失败写入不落盘）；宿主载荷损坏 / 版本不符 → 按空存储处理，不抛不破坏；5 用例红后绿。index.js 接线随工作台迁移完成。
- [x] UI 扩展进程内 dispatch：`createLocalAtlasApi(core)` 实现 `AtlasUiApi`，替换 HTTP createApi。**已完成**：打包入口改为 `src/atlas-browser-entry.ts`（一个 dist 产物同时携带 UI 核心 + 引擎核心 + 浏览器三件套，导出实测齐全）；`connectAtlas` 已改为 extensionSettings 浏览器存储 → 引擎核心 → 本地 API（零网络）；设置页新增世界 JSON 文件导入；"服务端暂无世界"文案已本地化。**剩：`modeHintFor` 里"Server Plugin 离线"等文案清退（见清退项）+ 全屏工作台。**
- [x] 推演预设 → 后端代理适配层 + mock 代理单测。**已完成**：`src/atlas-proxy-fetch.ts` = 注入式 fetchFn，把引擎的直连请求改写为 `/api/backends/chat-completions/generate` custom 请求（`custom_url` + `custom_include_headers.Authorization` 转交密钥，外层请求头不含明文密钥；CSRF 经 `getRequestHeaders()` 合并；`signal` 透传；非 chat-completions 载荷原样透传不改写）+ 4 用例红后绿。CORS / 代理拒绝的用户可见提示随工作台 UI 落地。
- [x] 本地预览服务（开发工具，ATLAS-09）：`预览.bat`（纯 ASCII，Node 缺失 / dist 缺失时自动构建并提示）+ `dev-preview/serve.mjs`（零依赖 Node 静态服务、显式 MIME 含 .mjs、**默认 4173 起自增避让占用端口**、file:// 守卫提示）。**为什么必须用服务而不是双击 HTML**：SillyTavern 扩展是 ES module，file:// 下被 CORS 拦截 → 插件不启动、CSS 也看不到。CSS 保持外链不内联，用户可自行覆盖 style.css。夹具 = 酒馆 stub 宿主（含 extensionSettings / chatMetadata / saveMetadata）+ 固定推演草稿 mock + **首次自动绑定演示世界**（省去手动绑定）+ **预览控制经 `window.__atlasDevSlot` 注入右栏**（不再有左下角浮条）。**预览页只显示插件本身，不模拟聊天栏。**
- [x] 服务端依赖清退（2026-09-17）：`modeHintFor` offline 不再引导安装 Server Plugin / enableServerPlugins（纯浏览器模式下 offline = 扩展内部异常 → "刷新页面或重进聊天即可恢复"）；protocol-incompatible 改为"安装包可能不完整，请重装"。UI 面向文案已无 Server Plugin 字样（代码注释中的模块名说明保留，属事实描述）。harness 契约同步更新。
- [x] 打包（2026-09-18 独立化）：发布单元 = `release/atlas-ui-extension/`（manifest 在包根、dist 自包含、index.js 剥离 `../src` 开发回退）；`tests/atlas-integration.test.mjs` P0-01 每次 `npm test` 都执行 `tools/pack.mjs` 重建并验证两包（smoke 自动同步）。**世界核心已内嵌快照**（`lib/` 14 文件逐字节复制 + VENDORED.md 来源纪律；Atlas 源码 28 处 `../../lib/` 引用改指快照，全库零父引用，`tools/build.mjs` esbuild 本仓库 node_modules 优先 / 上级兜底，package.json 声明 devDependencies.esbuild ^0.28.0）。**GitHub 发布仓库（仓库根有 manifest.json）待作者建仓后推送，见下条。**
- [ ] GitHub 发布仓库：作者在 GitHub 建空仓库（Public），把 `release/atlas-ui-extension/` 内容推到仓库根；安装 = ST「Install extension」贴链接。发布后删除 / 归档 Server Plugin 版是否同仓，发布时再定。
- [x] 版本 0.7.0 五处一致（package.json / UI manifest / ATLAS_EXTENSION_VERSION / server package / ATLAS_PLUGIN_VERSION，实测全 0.7.0）+ 两个 README 重写（atlas-extension/README.md = 纯浏览器单步安装 + 0.7.0 changelog；根 README.md 顶部加"当前形态"声明框，声明与历史章节冲突时以排期为准）。
- [x] 全套门禁 + AR-ATLAS-09 验收记录（2026-09-17）：node --check OK、build 双产物 ✓、tsc 0 errors、全套单测 **143/143**、五处版本一致性实测、release 同步实测；AR-ATLAS-09 已追加到验收报告。**自动化侧完成；真实酒馆人工验收（含深色主题观感、真实付费 API、GitHub 发布）待作者，通过后 ATLAS-09 关闭。**

### 本包禁止事项

- 不改共享世界核心（`lib/world-*.ts` / `context-plan.ts`）；引擎复用只许打包路径变化。
- 不删 Server Plugin 版代码（保留为进阶形态）；不迁移用户世界。
- 不在未核实代理契约前动手写模型调用层。

### 完成后才能进行

ATLAS-09 自动测试通过 + 作者真实酒馆人工验收（链接安装 → 绑定 → 正常回合）通过后，回到 ATLAS-06｜swipe、编辑、删除与分支一致性。

## 当前工作包：ATLAS-FIX-01｜真实 SillyTavern 集成阻断修复（P0）

> 状态：自动化侧已全部完成（AR-ATLAS-08）；下列 P0 清单已勾选项 = 集成测试证明，未勾选项 = 需作者在真实酒馆人工验收。

### 目标

把已经通过纯核心测试的 ATLAS-00 ～ 05 接到真实 SillyTavern 公共扩展接口上，并生成可独立安装的发布包。修复必须由真实适配层测试和干净安装旅程证明，不能只增加 mock 断言。

### P0 实施清单

- [x] **生成真正自包含的两个安装包。** UI Extension 与 Server Plugin 各自携带运行所需的构建产物；安装后不得依赖组件目录之外的 `../src` 或 `../dist`。`npm run pack` 不再输出"骨架副本，非发布包"。（tools/build.mjs esbuild 双产物 + pack 剥离开发回退）
- [x] **修复 UI Extension 生命周期。** manifest 声明 `hooks.activate` / `hooks.disable` 指向实际导出；模块加载幂等自初始化兜底旧版；重复 activate 不重复监听（connectAtlas 单例）。
- [x] **按 SillyTavern 真实签名修复生成拦截器。** `(chat, contextSize, abort, type)`；有 pending 时经 setExtensionPrompt 注入、无 pending 清理、不改 chat、不 abort；集成测试覆盖顺序（先等 prepare 再读状态）。
- [x] **消除 prepare 与生成之间的竞态。** 核心新增 `waitPendingTurn(timeoutMs)`，拦截器注入前等待同一条 prepare Promise；无在途 prepare 立即返回，不阻断未启用 / 离线的普通聊天；挂起按超时返回。
- [x] **修复 UI HTTP 请求头。** 每请求从 `SillyTavern.getContext().getRequestHeaders()` 取当前 CSRF 头再合并 `Content-Type`；不缓存 token。
- [x] **修复 Server Plugin 路由适配。** 动态路由传真实请求路径（originalUrl / baseUrl+path，去查询串）；补注册 `/map/image/:chatId`。
- [x] **修复写操作身份判断。** 默认策略 = `req.user.profile.handle` 非空（已认证）且（本机回环或管理员）；可用 `isLocal` 覆盖；允许 / 拒绝两路径均有适配层测试。
- [x] **让文档存储键编码保持一一映射。** 文档名统一 base64url 规范编码（可逆）；旧编码文件按原规则兼容读取，不迁移不静默覆盖；remove 同时清理新旧文件。
- [x] **补真实适配层测试。** `tests/atlas-integration.test.mjs`（13 用例，先红后绿）：真实执行 `node tools/pack.mjs`、逐文件校验 release 形态、release Server `init(fakeRouter)` 端到端、manifest hooks、官方四参数拦截器、fire-and-forget 竞态、CSRF 头、动态路由、身份策略、存储编码。
- [x] **同步版本与安装文档。** 根包 / UI manifest / UI 常量 / Server 常量 / Server package 统一 0.6.0（有专项测试断言）；两个 README 写清最低 SillyTavern（≥1.12.0）/ Node（≥18）版本、安装目录、更新与卸载方式。

### 本包验收要求

- [ ] `release/atlas-ui-extension/` 单独复制到干净 SillyTavern 扩展目录后能自动激活，面板可打开，停用后监听与 DOM 清理。（自动侧已验：release 加载器形态 + dist 导出；人工项待作者）
- [ ] `release/atlas-server-plugin/` 单独复制到 `plugins/atlas/` 后，使用 SillyTavern 标准启动命令可加载；不得要求用户额外复制上级 `src/` 或使用实验性 TypeScript 启动参数。（自动侧已验：release init 端到端 + 组件内路径断言；人工项待作者）
- [x] 通过真实路由绑定 `chat-a` 后，`GET /state/chat-a` 返回该聊天状态；`GET /map/image/chat-a` 已注册且返回契约响应。（fakeRouter 真实接线实测）
- [ ] 真实生成拦截器收到 prepare 文本；正常回复只 commit 一次；停止、空回复、断网均零推进。（拦截器 / 竞态自动已验；完整回合待真实酒馆人工）
- [x] 当前账号可保存设置与导入世界；未授权请求明确拒绝；POST / PUT 无 CSRF 失败。（req.user 策略允许 / 拒绝路径实测；CSRF 头实测）
- [x] 两个不同合法 ID 不会读写同一存储文件。（base64url 一一映射 + 兼容读取实测）
- [x] Atlas 专项门禁与 Atlasia 全套回归继续通过，并新增至少一组打包后安装形态 smoke / integration 测试。（AR-ATLAS-08 全量数字）
- [ ] 作者在真实 SillyTavern 完成安装、绑定、刷新、停用、卸载和一次正常回合；结果单独记录为"人工验收"，不能用自动测试替代。

### 完成后才能进行

ATLAS-FIX-01 真实 SillyTavern 人工验收通过后，恢复执行 **ATLAS-06｜swipe、编辑、删除与分支一致性**，之后才进入 ATLAS-07 正式发布验收。

## 已完成工作包：ATLAS-00｜基线冻结与契约（P0）

### 目标

先固定 UI Extension、Server Plugin 与 Atlasia 世界核心之间的协议，使后续 AI 可以在不猜字段、不暴露密钥、不破坏 Atlasia 的前提下继续开发。

### 实施清单

- [x] 完整阅读 `阿特拉斯/README.md`，确认产品范围和非目标。
- [x] 盘点并记录 Atlasia 当前自动化基线、失败项和环境限制；不得引用旧报告数字冒充本轮实测。（本轮实测：单测 813/813、lint 0、双 tsc 0、e2e 78/78、e2e:v4 227/227、ui000 53、r3 50+1 blocked（构建项已带权限真实复核通过）、build `Build complete.`）
- [x] 新建 `阿特拉斯/package.json`，只包含阿特拉斯专项测试、类型检查和打包入口；不得替换上级 Atlasia 的 `package.json`。
- [x] 新建 `阿特拉斯/src/atlas-contract.ts`。
- [x] 定义 `ATLAS_PROTOCOL_VERSION`，第一版固定为 `1`。
- [x] 定义并严格解析 `AtlasChatBinding`。
- [x] 定义并严格解析 `AtlasTurnPrepareRequest` / `AtlasTurnPrepareResponse`。
- [x] 定义并严格解析 `AtlasTurnCommitRequest` / `AtlasTurnReceipt`。
- [x] 定义稳定错误码：协议不兼容、未绑定、世界不存在、字段超限、服务离线、API 未配置、API 限流、API 超时、响应损坏、重复提交、写入失败。
- [x] 为字符串、消息数量、NPC 数量、事件数量、上下文总字符数和响应体设置硬上限。
- [x] 建立 `阿特拉斯/atlas-extension/` 最小目录及 `manifest.json`；显示名必须是「阿特拉斯 / Atlas」，本包不接真实事件。
- [x] 建立 `阿特拉斯/atlas-server-plugin/` 最小目录及插件信息；本包只允许健康检查骨架，不接真实模型。
- [x] 新建 `阿特拉斯/tests/atlas-contract.test.mjs`，覆盖合法往返和所有主要非法边界。
- [x] 证明所有错误序列化结果不包含 `apiKey`、`Authorization` 或用户本地绝对路径。
- [x] 在验收报告中记录实际改动、命令、断言数、失败和下一步；不得只在聊天回复中口头宣称完成。（见 `验收报告README.md` AR-ATLAS-01）

### 本包禁止事项

- 不实现地图 UI、NPC 面板或完整设置页。
- 不调用真实模型，不要求用户填写 Key。
- 不在 UI Extension 的 `extensionSettings` 或 `chatMetadata` 保存 Key。
- 不修改 `app/WorldStudio.tsx` 来展示插件原型。
- 不大规模移动 `lib/world-*.ts`。
- 不在 `阿特拉斯/` 下建立嵌套 `.git`。
- 不因为契约文件存在就宣称插件已经能够安装或游玩。

### ATLAS-00 验收要求

- [ ] 所有契约均有显式协议版本和严格解析函数。
- [ ] 缺少必填字段、空 ID、非法状态、超长正文和超量数组会被拒绝，并返回稳定错误码。
- [ ] 合法对象 JSON 往返后语义一致。
- [ ] UI Extension 和 Server Plugin 骨架可以被各自测试加载，但没有伪造功能按钮。
- [ ] 阿特拉斯专项测试、类型检查和打包通过。
- [ ] Atlasia 上级项目的测试、e2e、V4 e2e、lint、两套 TypeScript、`ui000`、`r3` 和 build 没有新增失败。
- [ ] 没有用户世界、聊天内容、明文 Key、绝对路径或临时产物进入提交范围。

### 完成后才能进行

ATLAS-00 自动测试和复核通过后，下一工作包为 **ATLAS-01｜共享相关性与回合核心**。不得跳到 ATLAS-04 先画地图面板，也不得跳到 ATLAS-05 先接模型。

## 总体工作包进度

| 工作包 | 内容 | 优先级 | 当前状态 | 前置条件 |
| --- | --- | --- | --- | --- |
| ATLAS-00 | 基线冻结与契约 | P0 | 🟩 自动测试通过 | 无 |
| ATLAS-01 | 共享相关性与回合核心 | P0 | 🟩 自动测试通过 | ATLAS-00 通过 |
| ATLAS-02 | Server Plugin 与独立 API | P0 | 🟩 自动测试通过 | ATLAS-01 通过 |
| ATLAS-03 | UI Extension 外壳与聊天绑定 | P0 | 🟩 自动测试通过 | ATLAS-00；建议 ATLAS-02 健康端点可用 |
| ATLAS-04 | 地图、时间与相关 NPC 面板 | P1 | 🟩 自动测试通过 | ATLAS-01、ATLAS-03 通过 |
| ATLAS-05 | 生成前注入与回复后世界推演 | P0 | 🟩 自动测试通过 | ATLAS-01～04 通过 |
| ATLAS-FIX-01 | 真实 SillyTavern 集成阻断修复 | P0 | 🟨 已编码待验收（自动集成测试通过） | ATLAS-00～05 自动测试通过 |
| ATLAS-09 | 纯浏览器模式（单链接即玩） | P0 | 🟨 自动测试通过，待作者人工验收 | AR-ATLAS-09（143/143 + tsc 0 + 0.7.0 五处一致） |
| ATLAS-06 | swipe、编辑、删除与分支一致性 | P0 | ⬜ 未开始 | ATLAS-05 通过 |
| ATLAS-07 | 打包、安装与完整验收 | P1 | ⬜ 未开始 | ATLAS-00～06 通过 |
| ATLAS-08 | Atlasia 联动 | 后续 | ⬜ 未开始 | 第一版稳定且另行确认 |

状态只能使用：

- ⬜ 未开始
- 🟦 编码中
- 🟨 已编码待验收
- 🟩 自动测试通过
- ✅ 人工验收通过
- 🟥 阻塞

“已编码”“自动测试通过”“真实 SillyTavern 人工验收通过”必须分开记录。

## 后续工作包摘要

### ATLAS-01｜共享相关性与回合核心

- 组合上级 `world-engine`、`world-npc`、`world-ledger`、`world-projection` 与 `context-plan`。
- 完成地点 / 时间 / NPC / 触发筛选、稳定种子、prepare 和 commit 的纯函数事务。
- 重复 commit 不得重复推进世界；未来正史和兄弟 IF 不得泄漏。

### ATLAS-02｜Server Plugin 与独立 API

- 实现同源 `/api/plugins/atlas/` 端点。
- 密钥只在服务端保存和使用，响应与日志只能脱敏。
- prepare 默认零模型请求；一条最终回复的 commit 至多一次请求。
- 增加串行队列、幂等、限流、超时、重试和原子存储。

### ATLAS-03｜UI Extension 外壳与聊天绑定

- 使用 `SillyTavern.getContext()` 和公开事件。
- 在当前聊天 `chatMetadata` 只保存小型绑定信息。
- 提供概览、地图、附近、变化和设置五个入口的真实空状态。
- 多聊天绑定不得串世界。

### ATLAS-04｜地图、时间与相关 NPC 面板

- 小地图、当前位置、相邻地点、路线和旅行预览。
- 显示当前世界时间和最近推进原因。
- 附近 NPC 必须显示命中原因。
- 点击地点 / NPC 只填入酒馆输入框，默认不自动发送。

### ATLAS-05｜生成前注入与回复后世界推演

- 用户消息后 prepare；公开生成拦截器注入有界上下文。
- 最终助手回复完成后才 commit。
- 停止、失败和空回复不得推进世界。
- receipt 以用户可理解的形式展示变化和来源。

### ATLAS-06｜swipe、编辑、删除与分支一致性

- committed assistant message 与 receipt / 检查点建立稳定映射。
- swipe 建立同级结果，不能累计推进时间或递归生成 `IF: IF:`。
- 编辑 / 删除必须恢复对应世界状态，默认保留可返回历史。

### ATLAS-07｜打包、安装与完整验收

- 在干净 SillyTavern 实例按文档安装 UI Extension 与 Server Plugin。
- 使用模拟 API 走完整地图、聊天、推演、刷新、失败、swipe 和多聊天旅程。
- 发布包不得包含用户数据、Key、日志、绝对路径和临时文件。

### ATLAS-08｜Atlasia 联动

- 后续决定显式导入导出还是共享存储。
- 第一版不允许 Atlasia 与酒馆双端同时写同一世界。
- 未明确冲突处理、锁和恢复方案前不得开工。

## 文件所有权与并行纪律

### 阿特拉斯任务可以直接修改

- `E:\地图\阿特拉斯\**`

### 共享核心，修改前必须说明原因和影响范围

- `E:\地图\lib\world-*.ts`
- `E:\地图\lib\context-plan.ts`
- `E:\地图\app\lib\ai-gateway.ts`
- `E:\地图\app\lib\ai-connections.ts`
- 上述文件对应的现有测试

### 默认不得修改

- `app/WorldStudio.tsx`
- `app/globals.css`
- Atlasia 现有页面结构
- 用户世界数据、API 预设和验收截图

同一时间只能有一个任务修改共享核心。另一个 AI 可以并行处理阿特拉斯内部 UI 或测试，但不得同时改同一个文件。

## 每次交接必须填写

```text
工作包：ATLAS-XX
状态：
本轮修改文件：
共享核心修改及原因：
已完成：
未完成：
实际运行命令与退出码：
测试断言数量：
发现的真实缺陷：
用户数据是否修改：否 / 是（说明恢复方式）
真实 API 是否调用：否 / 是（说明授权的预设）
下一步唯一任务：
```

## 给下一个 AI 的直接指令

> 先完整阅读 `E:\地图\阿特拉斯\验收报告README.md` 的 AR-ATLAS-07，再只执行本文件顶部的 **ATLAS-FIX-01**。不要开始 ATLAS-06，不要调用真实付费 API，不要修改用户世界。必须先用失败测试复现 AR-ATLAS-07 的每个 P0，再修复打包、生命周期、拦截器、CSRF / 身份、动态路由和存储键；测试必须覆盖打包后的真实入口与 `init(fakeRouter)`，不能继续只测纯核心。完成后分别记录“已编码”“自动集成测试通过”和“真实 SillyTavern 人工验收通过”，不能互相冒充。
