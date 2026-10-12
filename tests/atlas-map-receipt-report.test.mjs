/**
 * atlas-map-receipt-report.test.mjs — P14/§21.3 回执分层
 *
 * 纪律：
 *  - 输入是**真实结果字段**（宿主 recordMapReceipt 实际记录的那份：operation / coreSaved /
 *    build.sceneSummary / build.queue / sceneSaved / issues），不是为测试现编的形状；
 *  - 「布局完成」必须由真实场景证据支撑：coreSaved=true 但没有 scene（官道这类 other 容器）
 *    只能报「更新失败」；
 *  - 缺漏行只报计数与分类，不许夹带实体 ID（POV 泄密的常见出口）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {projectReferenceData, referenceReceiptReport, referenceReceipts} from '../ui/atlas-reference-data.mjs';

const view = items => ({branchId: 'main', revision: 1, items});
const reportOf = detail => referenceReceiptReport(detail);

test('RPT07 · 同一路径上不同陈设的失败各计一次，双通道重复不翻倍且摘要不泄露实体',()=>{
  const issues=Array.from({length:12},(_,i)=>({code:'DETAIL_NO_SPACE',path:'$.layout.contents',severity:'error',message:`陈设 hidden_${i} 无法放入`}));
  const report=reportOf({operation:'layout',coreSaved:true,sceneSaved:true,issues,receipt:{issues:JSON.parse(JSON.stringify(issues))}});
  assert.equal(report.layout.state,'partial');assert.equal(report.gaps.count,12);
  assert.doesNotMatch(report.gaps.label,/hidden_/);
});

/** 真实 `/sql/chat/map/build` 回执形状：coreSaved + status + build(逐图/队列/来源) + receipt。 */
const buildReceipt = (sceneSummary, {queue = null, coreSaved = true, issues = [], status = 'committed'} = {}) => ({
  operation: 'build', status, coreSaved,
  receipt: {status, issues},
  issues,
  build: {mode: 'local', sceneSummary, ...(queue ? {queue} : {})},
});

test('RPT01 · 世界保存 / 布局完成 / 缺漏三行分开报，且完成只由真实场景证据支撑', () => {
  const r = reportOf(buildReceipt({ready: 2, partial: 0, missing: 0}));
  assert.equal(r.core.label, '世界数据已保存');
  assert.equal(r.layout.state, 'ready');
  assert.equal(r.layout.label, '布局：生成完成');
  assert.equal(r.gaps.count, 0);
  assert.equal(r.gaps.label, '缺漏与语义：暂无可见缺项');
});

test('RPT02 · 官道这类没有 scene 的图：即便 coreSaved=true 也不许报「生成完成」', () => {
  const none = reportOf(buildReceipt({ready: 0, partial: 0, missing: 1}));
  assert.equal(none.core.state, 'saved', '世界数据确实保存了');
  assert.notEqual(none.layout.state, 'ready');
  assert.equal(none.layout.label, '布局：更新失败');
  assert.equal(none.gaps.count, 1, '缺场景要计入可见缺项');
  // 布局动作路径：coreSaved=true 但场景没产出 → 同样不能算完成
  const layoutAction = reportOf({operation: 'layout', coreSaved: true, sceneSaved: false,
    receipt: {status: 'committed', issues: []}, issues: []});
  assert.equal(layoutAction.layout.label, '布局：更新失败');
  const layoutOk = reportOf({operation: 'layout', coreSaved: true, sceneSaved: true,
    receipt: {status: 'committed', issues: []}, issues: []});
  assert.equal(layoutOk.layout.label, '布局：生成完成');
});

test('RPT03 · 部分完成 / 暂不支持 / 保存失败各自归位，不合成一句「已完成」', () => {
  const partial = reportOf(buildReceipt({ready: 1, partial: 1, missing: 0}));
  assert.equal(partial.layout.label, '布局：部分完成');
  const unsupported = reportOf(buildReceipt({ready: 0, partial: 0, missing: 2},
    {issues: [{code: 'LAYOUT_UNSUPPORTED', severity: 'warning', path: '$.maps.m9', message: '本图暂不支持该画法'}]}));
  assert.equal(unsupported.layout.label, '布局：暂不支持');
  const failed = reportOf(buildReceipt({ready: 2, partial: 0, missing: 0}, {coreSaved: false}));
  assert.equal(failed.core.label, '世界数据未保存（候选已丢弃）');
  assert.equal(failed.layout.label, '布局：更新失败');
});

test('RPT04 · 缺漏行只报计数与分类：不出现实体 ID / 秘密成员', () => {
  const r = reportOf(buildReceipt({ready: 1, partial: 0, missing: 1}, {queue: {pendingTargets: 3},
    issues: [{code: 'MAP_ROUTE_ENDPOINT_UNKNOWN', severity: 'warning', path: '$.maps.m1', message: '端点未知', relatedIds: ['L_SECRET']},
      {code: 'SOURCE_IDENTITY_INVALID', severity: 'error', path: '$.sources', message: '身份不合法'},
      {code: 'MAP_SCALE_UNCALIBRATED', severity: 'warning', path: '$.maps.m1', message: '未标定'}]}));
  assert.equal(r.gaps.count, 4, '缺场景 1 + 可见问题 3');
  assert.match(r.gaps.label, /缺漏与语义：可见缺项 4 个/);
  assert.match(r.gaps.label, /未标定/);
  assert.match(r.gaps.label, /来源不足/);
  assert.match(r.gaps.label, /待处理 3 项/);
  assert.doesNotMatch(r.gaps.label, /L_SECRET/, '缺漏行不许夹带实体 ID');
});

test('RPT05 · 非地图回执不背「布局失败」的锅', () => {
  assert.equal(reportOf(null), null);
  assert.equal(reportOf({}), null);
  assert.equal(reportOf({coreSaved: true, receipt: {status: 'committed'}}), null, '普通推演回执没有 operation');
});

test('RPT06 · 真实回执投影把报告挂在回执卡上，普通推演回执不带 report', () => {
  const receipts = [
    {receiptId: 'r-map', chatId: 'chat-A', status: 'committed', recordedAt: 1,
      detail: {operation: 'build', coreSaved: true, receipt: {status: 'committed', issues: []},
        issues: [], build: {sceneSummary: {ready: 1, partial: 0, missing: 0}}}},
    {receiptId: 'r-turn', chatId: 'chat-A', status: 'committed', recordedAt: 2, detail: {coreSaved: true}},
  ];
  const data = projectReferenceData({state: {chatId: 'chat-A', receipts}, mapView: view([]), viewMode: 'author'});
  const map = data.RECEIPTS.find(r => r.id === 'r-map'), turn = data.RECEIPTS.find(r => r.id === 'r-turn');
  assert.ok(map.report, '地图回执必须带分层报告');
  assert.equal(map.report.layout.label, '布局：生成完成');
  assert.equal(turn.report, null, '普通推演回执不画布局行');
  // referenceReceipts 直接调用也要同源（不能只在 projectReferenceData 里打补丁）
  const direct = referenceReceipts({chatId: 'chat-A', receipts})[0];
  assert.equal(direct.report.layout.label, '布局：生成完成');
});
