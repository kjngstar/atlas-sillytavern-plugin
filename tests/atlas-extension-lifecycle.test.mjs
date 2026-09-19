/**
 * atlas-extension-lifecycle.test.mjs — ATLAS-FIX-02 生命周期收口（可执行测试）。
 *
 * 验收要求（AR-ATLAS-13）：「需要真实 disable→普通生成→activate 的可执行测试，
 * 不应只做源码字符串断言」。
 *
 * 口径：
 * - 宿主（酒馆）按名字在 window 上查找 generate_interceptor（ATLAS_INTERCEPTOR_GLOBAL）。
 * - disable → atlasUninstallGlobals() 必须让宿主**查不到** → 普通生成零注入；
 * - activate → installGenerateInterceptor() 重新安装，且只有一套实例；
 * - 旧版实现（0.9.1）停用后残留全局闭包，宿主会继续调用已 dispose 的核心——本测试锁死该回归。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createGenerateInterceptor,
  installGenerateInterceptor,
  atlasUninstallGlobals,
  ATLAS_INTERCEPTOR_GLOBAL,
} from "../atlas-extension/index.js";

// Node 无 window；本文件用受控 stub 模拟宿主全局（文件级隔离，node --test 每文件独立进程）。
const windowStub = {};
Reflect.set(globalThis, "window", windowStub);

/** 宿主行为：按名字查找拦截器（与酒馆 generate_interceptor 机制一致）。 */
function hostFindInterceptor() {
  const fn = windowStub[ATLAS_INTERCEPTOR_GLOBAL];
  return typeof fn === "function" ? fn : null;
}

function makeCoreStub({ pendingTurn = null } = {}) {
  return {
    waitPendingTurn: async () => {},
    getState: () => ({ pendingTurn }),
  };
}

function makePromptRecorder() {
  const calls = [];
  const setExtensionPrompt = (key, value) => {
    calls.push({ key, value: String(value ?? "") });
  };
  setExtensionPrompt.calls = calls;
  return setExtensionPrompt;
}

test("生命周期：activate 挂载 → 宿主可查到；disable 卸载 → 宿主查不到（零注入）", async () => {
  const setPrompt = makePromptRecorder();
  const core = makeCoreStub();

  // activate（与生产同路径：installGenerateInterceptor；io 仅注入录音器）
  installGenerateInterceptor(core, { setExtensionPrompt: setPrompt });
  const found = hostFindInterceptor();
  assert.ok(found, "activate 后宿主能查到拦截器");

  // 宿主普通生成：调用拦截器（无 pending → 清空注入，仍是一次 setExtensionPrompt 调用）
  /** 模拟宿主一次普通生成：查名字 → 找到才调用。 */
  const hostGenerate = async () => {
    const fn = hostFindInterceptor();
    if (fn) await fn([], 0, () => {}, "normal");
  };
  await hostGenerate();
  const before = setPrompt.calls.length;
  assert.ok(before >= 1, "拦截器工作（注入通道被调用）");

  // disable
  atlasUninstallGlobals();
  assert.equal(hostFindInterceptor(), null, "disable 后宿主查不到拦截器");
  assert.equal(windowStub[ATLAS_INTERCEPTOR_GLOBAL], undefined, "全局键被删除，不留死闭包");

  // 宿主继续普通生成：查不到拦截器 → 注入通道不再被调用（零注入）
  await hostGenerate();
  assert.equal(setPrompt.calls.length, before, "disable 后普通生成零注入");
});

test("生命周期：再次 activate 只有一套实例（重复安装 = 覆盖，不残留）", () => {
  const coreA = makeCoreStub();
  const coreB = makeCoreStub();
  installGenerateInterceptor(coreA);
  const first = windowStub[ATLAS_INTERCEPTOR_GLOBAL];
  assert.ok(typeof first === "function");

  installGenerateInterceptor(coreB);
  const second = windowStub[ATLAS_INTERCEPTOR_GLOBAL];
  assert.ok(typeof second === "function");
  assert.notEqual(first, second, "重复安装覆盖为最新闭包");
  assert.equal(Object.keys(windowStub).filter((k) => k === ATLAS_INTERCEPTOR_GLOBAL).length, 1, "全局只有一个键");

  atlasUninstallGlobals();
  assert.equal(windowStub[ATLAS_INTERCEPTOR_GLOBAL], undefined, "卸载彻底");
});

test("生命周期：uninstall 幂等（未安装时调用不抛错）", () => {
  assert.doesNotThrow(() => atlasUninstallGlobals());
  assert.doesNotThrow(() => atlasUninstallGlobals());
});

test("生命周期：disable 后旧闭包不可达（0.9.1 残留闭包缺陷回归锁）", async () => {
  // 0.9.1 缺陷：停用只 dispose core / 删 DOM，全局闭包残留 → 宿主继续调用旧闭包，
  // 闭包内引用已死核心。修复口径：uninstall 与 dispose 同步发生，宿主侧查不到。
  const setPrompt = makePromptRecorder();
  const coreStub = {
    waitPendingTurn: async () => {},
    getState: () => ({ pendingTurn: { injectionText: "这段注入永远不该被发送" } }),
  };
  windowStub[ATLAS_INTERCEPTOR_GLOBAL] = createGenerateInterceptor(coreStub, { setExtensionPrompt: setPrompt });

  // 宿主拿到的是「活」的拦截器 → 若不卸载，下一次普通生成会注入 pending 文本
  const leaked = hostFindInterceptor();
  assert.ok(leaked, "前置：安装成功（缺陷复现的前提）");

  atlasUninstallGlobals();
  assert.equal(hostFindInterceptor(), null, "卸载后宿主查不到旧闭包");
  assert.equal(setPrompt.calls.filter((c) => c.value.includes("永远不该被发送")).length, 0, "残留注入文本从未进入注入通道");
});
