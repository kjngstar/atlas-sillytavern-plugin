/**
 * atlas-time-intent.test.mjs — 0.9.1 时间意图抽取 + 裁决层时间下限。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { extractAtlasTimeIntent, renderAtlasTimeHint, deriveElapsedPeriods } from "../src/atlas-time-intent.ts";
test("抽取：显式时间词 → 时段下限（取最大）", () => {
  const intent = extractAtlasTimeIntent("我花了半天整理仓库，之后又待了一会儿。");
  assert.ok(intent.timeWords.includes("半天"), "命中 半天");
  assert.ok(intent.timeWords.includes("一会儿"), "命中 一会儿");
  assert.equal(intent.suggestedPeriods, 3, "取最大（半天=3）");
});

test("抽取：动作连接词计数（软参考）", () => {
  const intent = extractAtlasTimeIntent("起身穿衣，然后洗漱，接着出门，最后锁门。");
  assert.equal(intent.actionMarkers.length, 3, "然后/接着/最后");
  assert.equal(intent.estimatedActions, 4, "动作数 = 连接词 + 1");
});

test("抽取：无时间线索 → 零结果；模糊词不参与", () => {
  const none = extractAtlasTimeIntent("我看看窗外。");
  assert.equal(none.suggestedPeriods, null, "无时间词");
  assert.equal(none.actionMarkers.length, 0, "无连接词");
  const vague = extractAtlasTimeIntent("过了很久很久，一段时间之后。");
  assert.equal(vague.suggestedPeriods, null, "「很久」「一段时间」是模糊词，不入硬表");
});

test("提示行：有线索才渲染，无线索为 null", () => {
  const hint = renderAtlasTimeHint("坐下来喝了一会儿茶，然后翻账本。");
  assert.ok(hint && hint.startsWith("〔时间估计〕"), "提示行格式");
  assert.ok(hint.includes("一会儿"), "含命中的时间词");
  assert.equal(renderAtlasTimeHint("我看看窗外。"), null, "无线索 → null");
});

/* ------------------------------------------------------------------------- *
 * D03：deriveElapsedPeriods（计划 §2.3 定时语义 / 阶段 D03）
 *   规则口径：只认**完成态**助手行为词；用户显式时间词与既有引擎的旅行耗时只作下限
 *   （三来源取最大、不叠加）；没有任何时间推进依据一律 0 时段；开场识别恒 0。
 * ------------------------------------------------------------------------- */

test("D03：助手完成态「吃完饭」→ 1 时段（source=assistant-event）", () => {
  const out = deriveElapsedPeriods({ assistantText: "他吃完饭，把碗筷放下。" });
  assert.equal(out.periods, 1, "一餐 = 保守 1 时段");
  assert.equal(out.source, "assistant-event");
  assert.ok(out.reason.includes("吃完饭"), `reason 说明完成行为：${out.reason}`);
});

test("D03：助手完成态「睡到翌日」→ 4 时段（跨日界）", () => {
  const out = deriveElapsedPeriods({ assistantText: "他睡到翌日清晨，窗外天光初亮。" });
  assert.equal(out.periods, 4, "过夜 / 翌日 = 一天 4 时段（与「一整天」同口径）");
  assert.equal(out.source, "assistant-event");
  assert.ok(out.reason.includes("过夜/翌日"), `reason 标出日界行为：${out.reason}`);
});

test("D03：助手完成态「赶了半天路」→ 3 时段", () => {
  const out = deriveElapsedPeriods({ assistantText: "他赶了半天路，才看见城门。" });
  assert.equal(out.periods, 3, "半天 = 3 时段");
  assert.equal(out.source, "assistant-event");
  assert.ok(out.reason.includes("半天赶路"), `reason 标出半天级行为：${out.reason}`);
});

test("D03 负例：「准备吃饭」是未完成态 → 0 时段", () => {
  const out = deriveElapsedPeriods({ assistantText: "他准备吃饭，先把碗筷摆好。" });
  assert.equal(out.periods, 0, "没有完成态就不推进时间");
  assert.equal(out.source, "none", "无推进 → source=none，不冒充任一来源");
  assert.ok(out.reason.includes("0 时段"), `reason 写清 0 时段：${out.reason}`);
  assert.ok(out.reason.includes("未完成"), `reason 说明是被未完成态挡下的：${out.reason}`);
});

test("D03 负例：「我要宣战」→ 时间不推进（0 时段）", () => {
  const out = deriveElapsedPeriods({
    userText: "我要向远方宣战。",
    assistantText: "他握紧拳头，转身离去，没有再说话。",
  });
  assert.equal(out.periods, 0, "宣战意图不是时间流逝（T03：允许意图，不许推进）");
  assert.equal(out.source, "none");
  assert.ok(out.reason.includes("0 时段"), `reason 写清 0 时段：${out.reason}`);
});

test("D03 负例：一段普通对话 → 0 时段（数分钟不算流逝）", () => {
  const chat = deriveElapsedPeriods({
    userText: "你好。",
    assistantText: "「你好。」她点了点头，把茶推过来。",
  });
  assert.equal(chat.periods, 0, "普通对话不推进");
  assert.equal(chat.source, "none");
  const tea = deriveElapsedPeriods({ assistantText: "他喝了口茶，等着对方开口。" });
  assert.equal(tea.periods, 0, "分钟级动作（喝茶）不入时段表");
  assert.equal(tea.source, "none");
});

test("D03 负例：开场识别恒 0 时段（用户时间词也不推翻）", () => {
  const out = deriveElapsedPeriods({
    sceneBootstrap: true,
    userText: "我花了半天赶路。",
    assistantText: "他睡到翌日清晨。",
  });
  assert.equal(out.periods, 0, "E06：开场禁止时间流逝");
  assert.equal(out.source, "none");
  assert.ok(out.reason.includes("开场"), `reason 标明开场识别：${out.reason}`);
});

test("D03：用户显式时间词作下限（source=user-explicit）", () => {
  const out = deriveElapsedPeriods({
    userText: "我花了半天清点货物。",
    assistantText: "他把最后一箱搬上马车。",
  });
  assert.equal(out.periods, 3, "半天 → 至少 3 时段");
  assert.equal(out.source, "user-explicit");
  assert.ok(out.reason.includes("半天"), `reason 标出用户时间词：${out.reason}`);
});

test("D03：旅行耗时作下限，但本函数不自己算距离", () => {
  const out = deriveElapsedPeriods({ travelPeriods: 5 });
  assert.equal(out.periods, 5, "既有引擎估计的路线耗时直接作下限");
  assert.equal(out.source, "travel");
  assert.ok(out.reason.includes("地图路线耗时 5 时段"), `reason 标出来源：${out.reason}`);
  // 「抵达某地」本身不产生时段——耗时必须由旅行引擎算好传入
  const arrived = deriveElapsedPeriods({ assistantText: "他抵达了城门，抬头看了看旗号。" });
  assert.equal(arrived.periods, 0, "抵达不算时段（不猜距离）");
  assert.equal(arrived.source, "none");
  // 非法旅行值：不猜，按「没有该来源」处理
  assert.equal(deriveElapsedPeriods({ travelPeriods: Number.NaN }).periods, 0, "NaN 不作下限");
  assert.equal(deriveElapsedPeriods({ travelPeriods: -3 }).periods, 0, "负数不作下限");
});

test("D03：三来源取最大、不叠加（同值按 用户 > 助手 > 旅行 归属）", () => {
  const maxed = deriveElapsedPeriods({
    userText: "我先坐一会儿。",
    assistantText: "他吃完饭，起身出门。",
    travelPeriods: 4,
  });
  assert.equal(maxed.periods, 4, "1/1/4 → 取 4，不是相加的 6");
  assert.equal(maxed.source, "travel");
  const tied = deriveElapsedPeriods({
    userText: "我花了半天清点货物。",
    assistantText: "他赶了半天路。",
  });
  assert.equal(tied.periods, 3, "同值仍是 3");
  assert.equal(tied.source, "user-explicit", "同值归用户显式时间词");
});

test("D03：计划态压过长得像完成的词；准备态不跨分句误杀", () => {
  const planned = deriveElapsedPeriods({ assistantText: "他打算睡到翌日再赶路。" });
  assert.equal(planned.periods, 0, "打算 ≠ 已完成");
  assert.equal(planned.source, "none");
  assert.ok(planned.reason.includes("未完成"), `reason 说明计划态：${planned.reason}`);
  const afterMeal = deriveElapsedPeriods({ assistantText: "他吃完饭，准备出门。" });
  assert.equal(afterMeal.periods, 1, "「吃完饭」与「准备出门」不同分句 → 饭照算");
  assert.equal(afterMeal.source, "assistant-event");
});

test("D03：劳作与「一觉醒来」两类完成行为各自计时段", () => {
  const labor = deriveElapsedPeriods({ assistantText: "忙了一整天，他终于把货清点完。" });
  assert.equal(labor.periods, 4, "整日劳作 = 4 时段");
  assert.equal(labor.source, "assistant-event");
  assert.ok(labor.reason.includes("整日劳作"), `reason 区分劳作与赶路：${labor.reason}`);
  const woke = deriveElapsedPeriods({ assistantText: "一觉醒来，已是午后。" });
  assert.equal(woke.periods, 3, "一觉醒来取更保守的 3 时段（未必到日界）");
  assert.equal(woke.source, "assistant-event");
});

test("D03：可复用旧抽取结果，且纯函数不改入参 / 同输入同输出", () => {
  const intent = extractAtlasTimeIntent("我用了许久才醒过来。");
  const input = Object.freeze({ userText: "我看看窗外。", intent, travelPeriods: 0 });
  const first = deriveElapsedPeriods(input);
  const second = deriveElapsedPeriods({ userText: "我看看窗外。", intent, travelPeriods: 0 });
  assert.equal(first.periods, 2, "复用旧抽取结果：许久 → 2 时段");
  assert.equal(first.source, "user-explicit");
  assert.deepEqual(first, second, "同输入 → 同输出");
  assert.deepEqual({ ...input }, { userText: "我看看窗外。", intent, travelPeriods: 0 }, "入参不被改写");
  assert.equal(deriveElapsedPeriods().periods, 0, "空输入 → 0 时段");
  assert.equal(deriveElapsedPeriods().source, "none");
});
