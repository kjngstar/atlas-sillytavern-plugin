# Atlas 实机验收清单（R13）

> 本文档记录 Atlas 在真实 SillyTavern 环境中需要验证的全部行为。自动化测试通过——但**自动化测试不能证明真实酒馆命中、触摸、模型输出、刷新与旧档升级**。本清单是 R13 实机验收的最低门槛；任何一项失败都需在对应 Rxx 阶段补回。

## 0. 环境基线

| 维度 | 要求 |
|---|---|
| SillyTavern | ≥ 1.12.0（依赖 manifest hooks / generate_interceptor / setExtensionPrompt） |
| 浏览器 | Chrome / Edge / Firefox / Safari 近两年版本 |
| 角色卡 | 任意主控卡（首用流程会按角色名建最小世界） |
| 推演 API | 至少配置一个独立 API 预设（"API" 页） |
| 默认浏览器形态 | 直接装 `release/atlas-ui-extension/`（零服务端依赖） |
| 可选 Server Plugin | `release/atlas-server-plugin/`（独立数据文件存储）——默认形态无需 |

## 1. 启动与首用

- [ ] 扩展激活后，左栏导航六项（概览 / 地图 / 附近 / 变化 / 推进 / API）齐全
- [ ] 发出第一条消息后自动建世（首条 AI 回复中识别场景；首轮**只**触发 1 次推演）
- [ ] /state 透出 `scene` 块：`{ resolution: confirmed/estimated/unknown, locationId, lastConfirmedLocationId, lastConfirmedAt }`
- [ ] 首条消息后 1 次推演内识别出场景锚定地点（地图标记出现）
- [ ] 自动建世不会与已有 `start` 地区冲突（新世界空地理，老世界按 fingerprint 退役）

## 2. 地图（DOM 真实命中）

- [ ] 视口 ≥ 1212×809：点击画布中心 + 四角 + 边缘 0px 处的标点都能命中
- [ ] 窄屏（≤ 640px）：弹窗可关闭、可拖动、不溢出
- [ ] 鼠标滚轮缩放以光标为锚点（缩放后该点坐标不变）
- [ ] 双指 pinch 缩放以中点为锚点
- [ ] 空白处拖动平移（>6px 才算 pan；点击和拖拽明确分离）
- [ ] 鼠标拖拽 NPC 到地点 = 一次写；中途松手不写
- [ ] 标记尺寸恒定（marker 反向缩放 1/k）——放大不撑满视口
- [ ] 底图与网格可同时显示；快捷视图切换（叠加 / 网格 / 底图）
- [ ] 三层子图（world → building → room）进入 / 返回正常；面包屑可点击回到任意上层
- [ ] 弹窗（mappanel）随 pan / zoom / resize 重新定位；对象消失则关闭
- [ ] 弹窗选中态：点击 marker 给该 marker 挂 `.aw-point.is-selected` 类（CSS 钩子）
- [ ] ESC / 点击空白 / 关闭按钮均能关闭弹窗

## 3. 推演链路

- [ ] 默认 6 段提示词：`$5` 世界状态 / `$U·$C·$1` 背景 / `$6` 上轮 / `$7` 前文 / `$8·{{assistantReply}}` 本轮素材 **全部**实际注入
- [ ] 「最终请求预览」按当前世界状态零 API 装配，展示每段内容 + 生效来源 + 缺失块
- [ ] 连接级 systemPrompt 非空时，推进页顶部红色警告出现；可一键「清空连接级提示词」恢复推进预设
- [ ] v2 协议：baseRevision 过期 / 引文包含失败 / 来源不存在 → 整单拒绝，不写世界
- [ ] v2 协议：同轮新地点 `new:loc:*` 与新人 `new:npc:*` 临时引用同响应内解析
- [ ] v2 协议：durations=0 合法（bootstrap 识别不强行推进时间）
- [ ] v2 协议：identityUpdates 不重建实体（id 不变，仅 displayName / 别名）
- [ ] duplicate 同 idempotencyKey 重试：零额外 API 调用，回执含 `status: "duplicate"`
- [ ] 失败响应（解析失败 / API 错误）：不写回新 session，session.rev 不自增

## 4. 事务与持久化（R12）

- [ ] 浏览器关闭中途 commit：下次启动不出现世界已变但游标未变 / 回执缺失 / 上一聊天结果串写
- [ ] 启动时自动清理 orphan pending（R15 已接线，带会话判定）：人为留一个 orphan pending（devtools 删掉对应 turn）→ 下次启动日志出现「启动清理 orphan 挂单：扫 1 / 清 1」；无 orphan 时静默（不记日志）
- [ ] 多聊天同时打开同一 chatMetadata（双开）：后写抛 409 SESSION_STALE，绝不互相冲账
- [ ] commit 一次成功 = session 整体 rev+1；下次请求带新 session 进；旧 session 不再生效

## 5. 标定与地图尺度（R10）

- [ ] AI 估计的 extentMeters 通过 1% 横纵相对容差校验；不通过 → 不落标定
- [ ] 人工锁定值（`source="user", locked=true`）不被 AI 估计覆盖
- [ ] 同一房间图与大陆图可以产生不同 metersPerCell
- [ ] 标尺条按当前 zoom 实时重算；显示窗口 80-160 px 内

## 6. 旧档迁移（R06 + R12）

- [ ] 旧「起点」形状（1 地区 + 1 地点 + 无账本）：自动退役
- [ ] 用户真正创建且名叫「起点」的地点：不被误判、不退役
- [ ] 旧纯账本可恢复的世界：UI 提示「需作者手动处理」
- [ ] 已推演过的旧存档：占位指纹破裂，不自动重试
- [ ] 重复执行 reconcilePending 无变化（幂等）

## 7. 推进编辑器

- [ ] 内置默认：进入可编辑工作副本（首次改动标「未保存副本」）
- [ ] 「新建」立即得到可命名、可写正文、可插入栏目的新草稿
- [ ] 每段稳定 ID + 名称 + 角色 + 启用 + A/B 槽 + 正文；插入、复制、移动、删除
- [ ] 「另存为」完整保留 name / mainSlot / deletable / contextTurnCount
- [ ] 「保存并启用」明确改变生效预设；「保存副本」明确是否启用
- [ ] 「导出」当前预设 → `.atlas-prompt-pack.json`（只含语义字段，无 API 配置/密钥）；改回该文件后「导入」→ 新预设出现在下拉且**未**自动启用，选中后分段/栏位/上下文条数完全一致
- [ ] 导入重名预设：既有预设不被覆盖，新预设名为「原名（导入）」
- [ ] 网络失败时草稿不丢失

## 8. 皮肤与令牌（R11）

- [ ] 选中态 `.aw-point.is-selected` 视觉钩子出现（outline + 外阴影 + z-index:4）
- [ ] 子图面包屑 `.aw-breadcrumb` 文字色 / 间隔色 / 当前色全部走令牌
- [ ] 状态提示三态：info / warn / error 三色分明
- [ ] 切换深 / 亮皮肤：mappanel 头像 / section-label / here-label 跟着变
- [ ] 皮肤令牌不改变命中 / 位置 / 尺度（不会被 JS 注入执行）

## 9. 渲染与兼容性

- [ ] 1212×809 视口：三套布局都跑通；窄屏可关闭弹窗
- [ ] 1280×800 视口：底部 tab 不溢出
- [ ] 触摸端（iPad Safari）：单指拖地图、双指缩放不触发浏览器手势
- [ ] 图片加载失败：底图替换为干净网格；不报 500
- [ ] 刷新重入：session / calibrations / submaps 全部还原
- [ ] 两套皮肤切换后再切回：弹窗、地图、状态全部恢复

## 10. 性能与限额

- [ ] 200 楼长线世界（200+ stateEvents）：最近楼滚动渲染不卡
- [ ] 100 个地点的世界：地图 fitAll < 200ms
- [ ] 1000 个 NPC 的账本：附近列表渲染 < 100ms

## 验收记录

实机验收由作者在 SillyTavern 环境中逐项打勾；任何一项失败需回写到对应 Rxx commit 并修复。文档与 IMPLEMENTATION_STATUS.md 同步。

## 本轮新增手工验收（待在真实 SillyTavern 执行）

- [ ] 内置及旧式预设首次打开即显示段内容；保存失败后草稿仍在，刷新后可恢复已保存内容。
- [ ] 停止一次生成，再从菜单重新生成；日志可看到两次尝试，最终回复只提交一次。
- [ ] 开启日志本地归档，刷新后仍能看到脱敏警告；关闭归档后本地副本消失。
- [ ] 世界图进入建筑、房间和更深一层，返回面包屑正常；子图显示各自的 frame 和标定。
- [ ] 用真实模型走一次 v2 回合与一次故意失败，保存日志 JSONL 并检查无密钥、原文和世界书正文。
