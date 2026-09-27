# Z01 / Z02 实机验收手册（未执行的自动化替代说明）

> **状态：两者均未执行。** 本文件是可逐步执行的验收手册，不是验收结果。
> 自动化测试无法替代本文件中的任何一项：真实宿主的保存语义、真实酒馆的生命周期、
> 真实模型的首次成功率都必须在目标环境里实测。**不得把本文件当成「已验收」。**

先说清楚为什么必须人工：

| 项 | 自动化已经覆盖的 | 自动化**不能**覆盖的 |
| --- | --- | --- |
| Z01 宿主保存 | `tests/atlas-db-host-port.test.mjs` 10 项（含 `HOST_SAVE_UNAVAILABLE`、`requested` 保留候选、`CHAT_CHANGED` 不污染） | 真实酒馆 `saveMetadata` 的返回形态、是否可等待完成、失败如何暴露、是否可读回 |
| Z02 生命周期 | `tests/atlas-sql-ui-wiring.test.mjs` 8 项（jsdom + 桩） | 真实 DOM 布局、长按拖拽命中、切聊天时迟到请求、删楼后世界书同步 |
| §20 成功率 | `tools/atlas-input-format-benchmark.mjs` 的离线回放与解析结果 | 真实模型的首次/修复后成功率（离线模式下所有成功率字段必须为 `null`） |

---

## Z01：宿主保存能力实测

**目标**：区分「可等待完成」与「仅排队」，并固定适配器的分支行为。结果记入
`docs/atlas-host-capabilities.md` §3 表格（把「未执行」改成实测结论）。

### 准备

1. 记录宿主版本：酒馆版本号、`manifest.json` 的 `minimum_client_version`、Node 版本。
2. 在一个**一次性测试聊天**里操作，不要用正在用的存档。
3. 打开浏览器 DevTools Console，确认能访问 `SillyTavern.getContext()`。

### Z01-1 保存函数形态

```js
const ctx = SillyTavern.getContext();
typeof ctx.saveMetadata;              // 期望 "function"；记录实际类型
ctx.saveMetadata.length;              // 形参个数（推断是否接受回调）
Object.getOwnPropertyNames(ctx).filter(n => /save/i.test(n));  // 记录所有保存相关入口
```

- 记录：函数名、是否返回 Promise、返回值的实际形态（`undefined` / `true` / 对象）。
- 判定：`typeof !== "function"` → 适配器必须走 `HOST_SAVE_UNAVAILABLE`（这是自动化已验证的分支）。

### Z01-2 耐久性核验（区分"内存对象"与"真的落盘"）

1. 写入一个合成标记：

```js
const meta = SillyTavern.getContext().chatMetadata;
meta.__atlas_z01_probe = { at: Date.now(), nonce: Math.random().toString(36).slice(2) };
await SillyTavern.getContext().saveMetadata();
meta.__atlas_z01_probe;   // 记录 nonce
```

2. **刷新页面**（不是重新打开标签），再切回该聊天，读回标记：

```js
SillyTavern.getContext().chatMetadata.__atlas_z01_probe;  // 必须仍是同一个 nonce
```

3. 关掉酒馆进程、重开、再读一次。
- 判定：两次都还在 → 耐久保存成立；只有第一次在 → **只是内存/队列**，适配器必须报 `HOST_SAVE_UNCONFIRMED`。
- 收尾：删除探针 `delete chatMetadata.__atlas_z01_probe` 并再次保存。

### Z01-3 失败如何暴露

对每个场景记录**返回形态**与**是否有明确错误**：

| 场景 | 做法 | 记录 |
| --- | --- | --- |
| 权限/磁盘失败 | 只读挂载点或写满的临时盘 | 抛异常？返回 false？静默成功？ |
| 保存中切聊天 | `saveMetadata()` 未 await 时切换聊天 | 是否覆盖了 B 的 metadata |
| 超大 metadata | 塞 5–10 MB 字符串后保存 | 是否截断/拒绝/静默丢 |

- 判定：任何「静默成功但实际没写」都要记成 `HOST_SAVE_UNCONFIRMED`，**不能**在适配器里判 `saved`。

### Z01-4 是否可读回（决定能否按 hash 核对）

```js
// 保存后能否从宿主侧拿到耐久内容并计算 sha256？
// 能 → 适配器可在确认丢失时按 snapshotSha256 核对（reconcileUnknownSave 返回 saved/not_saved）
// 不能 → 必须保持 requested + HOST_SAVE_UNCONFIRMED，禁止假设未保存而重复推进一步
```

### Z01-5 多标签/多设备

1. 同一聊天开两个标签，各写一个不同探针，交替保存。
2. 记录：是否互相覆盖、是否有版本冲突提示、`chatMetadata` 对象标识是否跨标签相同。
- 判定：无条件写入能力时，**必须限制单一写入者**，其他窗口刷新后只读；
  不得声称 SQLite 事务能解决宿主跨窗口覆盖（§7.3）。

### Z01 完成定义

把 5 项结论写进 `docs/atlas-host-capabilities.md` §3，并同步适配器分支：
- `canConfirm` 的真实取值；
- 是否存在读回能力（决定 `reconcileUnknownSave` 的可用性）；
- 失败是「明确失败」还是「结果未知」。

---

## Z02：真实 SillyTavern 实机安装验收

**目标**：安装刚打出的包，走完用户真实路径。逐项记录结果与日志 trace，
**缺任一项就不能写「实机全部验收完成」**。

### 准备

```text
npm ci
npm run typecheck      # 期望 0 errors
npm test               # 记录实际 pass/fail 数字
npm run build
npm run pack
```

- 记录 `release/atlas-ui-extension/dist/*` 与 `release/atlas-server-plugin/dist/*` 的 sha256 与字节数。
- 把 `release/atlas-ui-extension` 整体复制到 `scripts/extensions/third-party/`；
  `release/atlas-server-plugin` 复制到 `plugins/atlas/`。
- 确认安装目录**不含**对上级 `src/` 的依赖（发布副本应只加载组件内 `./dist/`）。

### 步骤与逐项记录表

| # | 操作 | 必须记录 |
| --- | --- | --- |
| 1 | 新建聊天，发一楼正文 | 首楼是否建立地点与人物；`chatMetadata.atlas` 的三表与 `database` 字段是否出现；日志页有无 `SQL_*` 具名诊断 |
| 2 | 打开设置页，打开「SQL 世界数据」开关 | 开关是否可见、默认是否关闭；开启后是否加载 `atlas-sql.mjs`（Network 面板确认）；是否出现 `SQL_CORE_LOADED` |
| 3 | 重开地图页 | 城市图是否只出**地点点位 + 粗定位名单**（不叠人物图标）；教室子图是否有精点；估计路线是否虚线 + 「估计」标注 |
| 4 | 左下角检查 | **只有一条比例尺**；缩放时读数变化而米/格不变（对照 `data-meters-per-cell`） |
| 5 | 生成正文，中途点「停止」 | 是否取消 pending；未出现卡死；日志有无 `SQL_PREPARE_STALE_DROPPED` |
| 6 | 重新生成（swipe） | 是否以新 variantKey 起新候选；旧结果是否被丢弃而不是叠加 |
| 7 | 生成期间切到另一个聊天 | 迟到响应是否被丢弃、**B 的 metadata 是否未被污染**（对照切走前的快照 hash） |
| 8 | 切回原聊天，删掉中间一楼 | 地图/认知/世界书是否一致回退；是否有「已回退」诊断摘要；位置是否跟着回退（角色不能留在未来位置） |
| 9 | 打开日志页 | **单条可筛选时间线**；回执里的错误能跳到同一 log id；分页不截断导出 |
| 10 | 世界书同步 | 断网/使世界书不可用时：核心数据仍保存 + 回执写明「世界已更新，世界书待同步」；恢复后是否补同步；**用户原有条目未被覆盖** |
| 11 | 全部关闭再重开酒馆 | 切回该聊天：世界数据是否完整（不是空世界、不是重复导入） |

### 必须留存的证据

- 每一步的**截图或录屏**（地图、日志、设置页、世界书条目列表）。
- 一份导出的诊断日志（脱敏后），能在其中定位到 turn/group/operation/field。
- 三处版本的 sha256：源 `src/`、构建产物 `dist/`、发布包 `release/`。
- 失败项的完整 trace（不要只写「报错了」）。

### 明确不可声称的事

- 「工作台/桩测试通过」≠「真实酒馆通过」。
- 「构建成功」≠「已保存到聊天」。
- 「HTTP 200」≠「世界已提交」。
- 「离线回放的成功率」≠「真实模型成功率」（离线模式下该字段必须为 `null`）。

---

## §20 真实模型对照（与 Z01/Z02 并列的第三项）

- 命令：`node tools/atlas-input-format-benchmark.mjs --format ops --live --runs 3`
  （B 组 `--format sql`；两组必须相同模型/版本/正文/输出预算/修复次数/功能范围）。
- 固定 20 场景 × 3 次 = 每组 60 次初次请求，A/B 合计 120 次；修复另计。
- 报告必含：模型名与版本、提示词 hash、输出预算、修复次数、实际运行次数。
- **人工注入的损坏样例与真实自然输出必须分开统计**：前者只验证故障恢复，
  **不能**用来计算模型本身的生成正确率。
- §20.4 的门槛（60 例中首次 ≥57、一次修复后 ≥59）是**发布目标值，不是已达成的结果**；
  报告里必须这样标注。
