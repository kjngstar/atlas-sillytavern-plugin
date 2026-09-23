/**
 * atlas-r-s9-person-drag.test.mjs — 0.9.55 S9：人物纠偏拖拽的**起拖状态机**纯函数验收。
 *
 * S9 把纠偏入口从地图人物标点搬到面板名单里的头像，起拖门槛从「位移超阈值」换成
 * 「长按」。这条状态机是新增逻辑（src/atlas-map-interactions.ts createHoldDragGesture），
 * 必须单独锁住——否则「长按没成立就起拖」「长按松手顺手打开详情」这类回归
 * 只有真机上摸出来。DOM 交互断言归 S10（施工单把该文件的断言排在 S10）。
 *
 * 覆盖：
 * 1) 短按 = 点击（不吞 click）；
 * 2) 长按成立 = 拖拽意图（原地松手也吞 click，不误开详情）；
 * 3) 长按未成立就移动超阈值 = 本次按下作废（列表滚动不误起拖）；
 * 4) 长按成立后的第一段位移立即起拖（不再要求第二次阈值）；
 * 5) cancel / 重复 hold / 位移累计 / click 只吞一次。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  createHoldDragGesture,
  MAP_GESTURE_THRESHOLD_PX,
  MAP_LONGPRESS_HOLD_MS,
} from "../src/atlas-map-interactions.ts";

test("S9：等待时长为正且在人能接受的长按区间", () => {
  assert.equal(typeof MAP_LONGPRESS_HOLD_MS, "number");
  assert.ok(
    MAP_LONGPRESS_HOLD_MS >= 200 && MAP_LONGPRESS_HOLD_MS <= 600,
    `长按等待应在 200~600ms，实际 ${MAP_LONGPRESS_HOLD_MS}`,
  );
});

test("S9：短按 = 点击——不 arm、不吞 click", () => {
  const g = createHoldDragGesture();
  g.down(100, 100);
  const up = g.up();
  assert.equal(up.dragged, false, "没有拖拽");
  assert.equal(up.armed, false, "没有长按成立");
  assert.equal(g.consumeClick(), false, "短按的 click 必须放行（打开详情）");
});

test("S9：长按成立 = 拖拽意图——原地松手也吞 click，不误开详情", () => {
  const g = createHoldDragGesture();
  g.down(100, 100);
  assert.equal(g.hold(), true, "计时到点：成立");
  assert.equal(g.armed, true);
  assert.equal(g.hold(), false, "重复计时不得二次成立");
  const up = g.up();
  assert.equal(up.armed, true, "up 如实报告长按成立过");
  assert.equal(up.dragged, false, "没移动过就不是拖拽");
  assert.equal(g.consumeClick(), true, "长按后松手的合成 click 必须吞掉");
  assert.equal(g.consumeClick(), false, "只吞一次");
});

test("S9：长按未成立就移动超阈值 → 本次按下作废（滚动 / 选择不误起拖）", () => {
  const g = createHoldDragGesture();
  g.down(100, 100);
  assert.equal(g.move(100 + MAP_GESTURE_THRESHOLD_PX + 4, 100), null, "未 arm 前移动不产生拖拽");
  assert.equal(g.hold(), false, "已作废：计时到点也不成立");
  assert.equal(g.armed, false);
  assert.equal(g.move(200, 100), null, "作废后移动继续无效");
  const up = g.up();
  assert.equal(up.dragged, false);
  assert.equal(up.armed, false);
  assert.equal(g.consumeClick(), false, "作废的按下不吞 click");
});

test("S9：阈值内抖动不作废长按（手指按压天然会抖）", () => {
  const g = createHoldDragGesture();
  g.down(100, 100);
  g.move(101, 102); // 位移约 2.2px < 阈值
  assert.equal(g.hold(), true, "轻微抖动后长按仍成立");
});

test("S9：长按成立后的第一段位移立即起拖，位移累计正确", () => {
  const g = createHoldDragGesture();
  g.down(100, 100);
  g.hold();
  const first = g.move(101, 103);
  assert.ok(first, "arm 之后立即进入拖拽");
  assert.equal(first.dragging, true);
  assert.equal(first.totalDx, 1);
  assert.equal(first.totalDy, 3);
  assert.equal(first.dx, 1, "首帧增量 = 相对按下点");
  assert.equal(g.isDragging, true);
  const second = g.move(120, 100);
  assert.equal(second.dx, 19, "第二帧增量 = 相对上一帧");
  assert.equal(second.dy, -3);
  assert.equal(second.totalDx, 20, "累计位移相对按下点");
  assert.equal(second.totalDy, 0);
});

test("S9：拖拽过的 click 被吞，且拖拽结束后状态归零", () => {
  const g = createHoldDragGesture();
  g.down(100, 100);
  g.hold();
  g.move(160, 100);
  g.move(200, 140);
  const up = g.up();
  assert.equal(up.dragged, true, "如实报告拖拽发生过");
  assert.equal(up.armed, true);
  assert.equal(g.isDragging, false, "up 之后不再拖拽");
  assert.equal(g.consumeClick(), true, "拖拽结束的合成 click 吞掉");
});

test("S9：cancel 全清（含 click 吞咽）——手势取消不得留下吞点击的残留", () => {
  const g = createHoldDragGesture();
  g.down(100, 100);
  g.hold();
  g.move(150, 150);
  g.cancel();
  assert.equal(g.isDragging, false);
  assert.equal(g.armed, false);
  assert.equal(g.move(200, 200), null, "取消后不再响应移动");
  const up = g.up();
  assert.equal(up.dragged, false);
  assert.equal(g.consumeClick(), false, "取消过的按下不吞 click");
});

test("S9：新一轮按下重置上一轮状态（同一个人头像可连续拖两次）", () => {
  const g = createHoldDragGesture();
  g.down(100, 100);
  g.hold();
  g.move(150, 100);
  g.up();
  assert.equal(g.consumeClick(), true, "第一轮吞掉自己的 click");
  g.down(300, 300);
  assert.equal(g.armed, false, "新按下必须回到未 arm");
  assert.equal(g.hold(), true);
  g.move(301, 300);
  const up = g.up();
  assert.equal(up.dragged, true, "第二轮照常拖拽");
  assert.equal(g.consumeClick(), true);
});
