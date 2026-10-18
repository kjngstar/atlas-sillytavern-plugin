/**
 * atlas-world-source-ledger.test.mjs — P10 / R02：长来源续读与部分成功（SRC01–SRC09）。
 *
 * 覆盖（交接稿 §17）：
 * - SRC01 28k+ 原文尾部放唯一事实标记：后续请求含该标记，并**真的产生**预期实体及其父关系；
 * - SRC02 每块偏移与 JS slice 一致；连续拼接无遗漏/无重叠（多段落 + emoji 代理对）；
 * - SRC03 A/B 双来源公平轮转：B 不会被 A 的开头永远挡住；
 * - SRC04 一组成功一组失败：成功业务保存、整个单元来源留 retry；重试复用已绑定真实 ID，不再建第二个；
 * - SRC05 空文本 / 格式错误 / protected drop / 重试额度耗尽 / 候选未保存 都不推进来源；
 * - SRC06 早块失败、后块成功：cursor 不越过缺口；下一次跳过已成功尾块，只处理缺口；
 * - SRC07 改 A 的 hash：B 的 processed 区间不丢；关闭来源不进请求但账本保留；
 * - SRC08 rollback 同时撤销来源账本与业务；重复 saved ACK 不推进游标、不额外建对象；
 * - SRC09 布局/repair 复查走 context-only：看得到已处理块，但不改变来源消费进度。
 *
 * 全程走真实路径：createSqlRepository.prepareTurn + 真实 compileOperations/applyGroups。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { createRow } from '../src/atlas-db-defaults.ts';
import { makeSeedWith, IDS, insertRows } from './fixtures/atlas-sql/seed.mjs';
import { forkBranch } from '../src/atlas-db-branches.ts';
import {
  MAX_UNIT_ATTEMPTS,
  scopeKeyFor,
} from '../src/atlas-construction-progress.ts';
import {
  chunkOffsetsValid,
  chunkSourceText,
  contentIdentity,
  parseChunkKey,
  selectWorldConstructionSources,
  looksHostTruncated,
  WORLD_SOURCE_CHUNKING_VERSION,
} from '../src/atlas-sql-world-sources.ts';
import {
  canConfirmUnit,
  contiguousProcessedPrefix,
  processedRanges,
  readSourceLedger,
  sourceSubjectKey,
  summarizeSources,
} from '../src/atlas-construction-sources.ts';
import { normalizeConstructionOps } from '../src/atlas-sql-world-completion.ts';
import { readProgressRows } from '../src/atlas-construction-progress.ts';
import { createTableReadPort } from '../src/atlas-db-readport.ts';

const SQL = await (await import('sql.js')).default();
const BRANCH = IDS.branchMain;
const CHAT = IDS.chatA;
const noop = '{"op":"noop"}';

const model = (fn) => ({
  calls: [],
  async request(req) {
    this.calls.push(req);
    return { batchId: req.batchId, text: fn(req, this.calls.length, req), httpStatus: 200, durationMs: 1 };
  },
});

const constructionCalls = (port) => port.calls.filter((call) => call.batchId.startsWith('construction_'));

const promptFoci = (req) => {
  const match = req.messages[1].content.match(/focus=([^\n]*?)、maxNewLocations=/);
  return match ? match[1].split('、').map((item) => item.trim()).filter((item) => item.length > 0 && item !== '（无）') : [];
};

const PATCH_OPS_PER_BATCH = 4;

async function seeded(port, setup) {
  const seed = await makeSeedWith(SQL);
  setup?.(seed.db);
  const bytes = seed.exportBytes();
  seed.close();
  const repo = createSqlRepository({ chatUid: CHAT, branchId: BRANCH, modelPort: port });
  await repo.open({ bytes });
  return repo;
}

let round = 0;
const turnInput = (repo, extra = {}) => {
  round += 1;
  return {
    anchor: {
      chatUid: CHAT,
      branchId: BRANCH,
      parentTurnId: repo.internal.currentHeadTurnId() ?? IDS.seedTurn,
      hostMessageUid: `src-round-${round}`,
      variantKey: 'author',
      inputHash: `src-round-${round}`,
      baseRevision: repo.internal.currentRevision(),
      baseStorageRevision: repo.storageRevision,
    },
    userText: '合成来源', assistantText: '合成来源', sourceSnapshot: [],
    phaseBatches: ['observe'], manual: false, sceneOnly: true,
    worldCompletion: { mode: 'local', focusLocationIds: [IDS.L2] },
    ...extra,
  };
};

const queuedIds = (count, prefix = 'queued_') => Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(4, '0')}`);

const equip = (db, ids, parent = IDS.L2) => {
  db.run('BEGIN');
  insertRows(db, 'entity_keys', ids.map((id) => ({ branch_id: BRANCH, id, kind: 'location' })));
  insertRows(db, 'locations', ids.map((id) => createRow('locations', { name: id, kind: 'room', parent_location_id: parent, map_id: null }, { branchId: BRANCH, id, turnId: IDS.seedTurn, clockS: 0, nowWallMs: 1, rulesetVersion: 'atlas-1' })));
  db.run('COMMIT');
};

const progressRows = (db) => queryBound(db, 'SELECT * FROM construction_progress WHERE branch_id = ? ORDER BY kind, id', [BRANCH]);
const chunkRows = (db) => progressRows(db).filter((row) => row.kind === 'chunk');
const sourceRows = (db) => progressRows(db).filter((row) => row.kind === 'source');
const unitRows = (db) => progressRows(db).filter((row) => row.kind === 'unit');
const save = (repo, prepared) => repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });

/* ------------------------------------------------------------------ *
 * 夹具：可预测的原文
 * ------------------------------------------------------------------ */

const TAIL_MARK = 'TAILMARK_QIAO_0421';
/** 300 字 + 尾部唯一标记 + 60 字尾巴；chunkChars=100 → 4 块，标记在第 4 块。 */
const LONG_TEXT = `${'甲'.repeat(300)}${TAIL_MARK}${'乙'.repeat(60)}`;

const sourceEntry = (key, text, hash = `h_${key}`) => ({ key, kind: 'lorebook', text, hash });

const sourceSnapshotOf = (entries) => entries;

/* ------------------------------------------------------------------ *
 * SRC02：块偏移与 JS slice 一致、连续拼接无遗漏/无重叠
 * ------------------------------------------------------------------ */

test('SRC02 块身份与偏移：slice 恒等、无缝铺满、硬切不切开代理对', () => {
  // 多段落 + emoji（4 字节码点 → JS 里是代理对）。
  const text = [
    '第一段：这是普通的多段落资料。',
    '',
    '第二段：带 emoji 的家族 👨‍👩‍👧‍👦 与旗帜 🇨🇳，还有补充平面字符 𠮷野家。',
    '',
    `第三段：${'长'.repeat(240)}`,
    '',
    '第四段：结尾。',
  ].join('\n');

  const list = chunkSourceText(text, 60, 'chunk_probe', 'h_probe', 'lorebook', WORLD_SOURCE_CHUNKING_VERSION);
  assert.equal(chunkOffsetsValid(text, list), true, '每块 slice 恒等 + 无缝铺满 + 末尾对齐原文长度');
  assert.ok(list.length > 1, '长文本必须被切成多块');
  // 逐块复核（独立于 chunkOffsetsValid 的整链断言）。
  for (const chunk of list) {
    assert.equal(text.slice(chunk.start, chunk.end), chunk.text, `块 ${chunk.index} 的 slice 必须恒等`);
    assert.equal(chunk.chunkingVersion, WORLD_SOURCE_CHUNKING_VERSION, '块必须带切分规则版本');
    assert.equal(parseChunkKey(chunk.chunkKey)?.index, chunk.index, '块键必须能解析回身份');
    assert.equal(parseChunkKey(chunk.chunkKey)?.chunkingVersion, WORLD_SOURCE_CHUNKING_VERSION, '块键必须含切分版本');
  }
  // 拼接 == 原文（无遗漏、无重叠）。
  assert.equal(list.map((chunk) => chunk.text).join(''), text, '连续拼接必须等于原文');
  // 没有半个代理对。
  for (const chunk of list) {
    const first = chunk.text.charCodeAt(0);
    const last = chunk.text.charCodeAt(chunk.text.length - 1);
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), `块 ${chunk.index} 不得以孤立低位代理开头`);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), `块 ${chunk.index} 不得以孤立高位代理结尾`);
  }

  // 硬切边界：整段超限时按上限切，但绝不切开一对代理。
  const dense = '😀'.repeat(50); // 每个 😀 占 2 个 code unit
  const hard = chunkSourceText(dense, 7, 'dense_probe', 'h_dense', 'lorebook', WORLD_SOURCE_CHUNKING_VERSION); // 7 是奇数 → 朴素切法必然切出半个代理
  assert.equal(chunkOffsetsValid(dense, hard), true, '密集 emoji 硬切后仍必须无缝且 slice 恒等');
  for (const chunk of hard) {
    const last = chunk.text.charCodeAt(chunk.text.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), '硬切不得以孤立高位代理结尾');
  }

  // 身份：宿主没给合法 hash → 从**实际原文**派生稳定摘要，不留空 hash。
  const derived = contentIdentity({ key: 'k', kind: 'lorebook', text: 'abc' });
  assert.equal(derived.derived, true);
  assert.ok(derived.contentHash.startsWith('derived:'), '缺失 hash 必须派生稳定摘要');
  assert.equal(contentIdentity({ key: 'k', kind: 'lorebook', text: 'abc' }).contentHash, derived.contentHash, '同一原文派生同一摘要');
  assert.equal(contentIdentity({ key: 'k', kind: 'lorebook', text: 'abc', hash: 'host_hash_1' }).contentHash, 'host_hash_1', '宿主合法 hash 优先');
  assert.equal(looksHostTruncated('正文……'), true, '尾部省略号必须被识别为疑似截断');
});

/* ------------------------------------------------------------------ *
 * SRC03：双来源公平轮转
 * ------------------------------------------------------------------ */

test('SRC03 多来源逐轮轮转：B 不会被 A 的开头永远挡住', () => {
  const textA = `${'A'.repeat(900)}`;
  const textB = `${'B'.repeat(900)}`;
  const selection = selectWorldConstructionSources({
    snapshot: [sourceEntry('alpha', textA), sourceEntry('beta', textB)],
    chatId: CHAT,
    branchId: BRANCH,
    chunkChars: 100,
    maxChars: 300,
  });
  const keys = selection.chunks.map((chunk) => chunk.sourceKey);
  assert.ok(keys.includes('alpha') && keys.includes('beta'), '两个来源都必须在同一批里被服务到');
  assert.equal(selection.usedChars, 300);
  // 轮转：第一轮 A 一块、B 一块；第二轮 A 一块（预算刚好用完）。
  assert.deepEqual(keys, ['alpha', 'beta', 'alpha'], '逐轮轮转的顺序必须是 A、B、A（不是 A、A、A）');
  assert.ok(selection.deferred.length > 0, '装不下的块必须显式延期');

  // 已处理的块（consume）不再重复装入；只剩尾部时也必须能轮到。
  const consumed = new Set(selection.chunks.map((chunk) => chunk.chunkKey));
  const next = selectWorldConstructionSources({
    snapshot: [sourceEntry('alpha', textA), sourceEntry('beta', textB)],
    chatId: CHAT,
    branchId: BRANCH,
    chunkChars: 100,
    maxChars: 300,
    skipChunkKeys: consumed,
  });
  assert.ok(next.chunks.length > 0, '还有未处理块时必须继续选取');
  assert.ok(next.chunks.every((chunk) => !consumed.has(chunk.chunkKey)), '已处理块不得重复装入「新来源」');
  assert.ok(next.chunks.some((chunk) => chunk.index > 0), '必须能推进到来源的后段，不是永远重放开头');
  assert.equal(next.skippedProcessed, consumed.size, '跳过计数必须如实');

  // context-only：看得到已处理块，且不做跳过。
  const contextOnly = selectWorldConstructionSources({
    snapshot: [sourceEntry('alpha', textA), sourceEntry('beta', textB)],
    chatId: CHAT,
    branchId: BRANCH,
    chunkChars: 100,
    maxChars: 300,
    mode: 'context-only',
    skipChunkKeys: consumed,
  });
  assert.equal(contextOnly.skippedProcessed, 0, 'context-only 不得把已处理块当作已消费');
  assert.ok(contextOnly.chunks.length > 0);
  assert.equal(contextOnly.mode, 'context-only');

  // 关闭的来源不进请求，但仍在 known 清单里（账本保留）。
  const disabled = selectWorldConstructionSources({
    snapshot: [{ ...sourceEntry('alpha', textA), enabled: false }, sourceEntry('beta', textB)],
    chatId: CHAT, branchId: BRANCH, chunkChars: 100, maxChars: 300,
  });
  assert.ok(disabled.chunks.every((chunk) => chunk.sourceKey !== 'alpha'), '关闭来源不得进请求');
  assert.ok(disabled.known.some((item) => item.sourceKey === 'alpha'), '关闭来源必须保留在清单里（不当作永久删除）');
  assert.ok(disabled.remaining.some((item) => item.sourceKey === 'alpha'), '关闭来源必须显式记入 remaining');
});

/* ------------------------------------------------------------------ *
 * SRC01：长原文续读——尾部唯一事实标记真的产生实体
 * ------------------------------------------------------------------ */

test('SRC01 长原文分块续读：尾部标记进入后续请求并产生真实实体与其父关系', async () => {
  const rooms = queuedIds(140, 'src1_');
  const port = model((req) => {
    if (!req.batchId.startsWith('construction_')) return noop;
    const content = req.messages[1].content;
    const foci = promptFoci(req).slice(0, PATCH_OPS_PER_BATCH);
    const ops = foci.map((focus) => JSON.stringify({ op: 'location.upsert', ref: focus, data: { description: '来源核对' } }));
    if (content.includes(TAIL_MARK)) {
      ops.push(JSON.stringify({ op: 'location.upsert', ref: 'new:tail_hall', data: { name: '石桥大厅', kind: 'room', parent_ref: 'L2' } }));
    }
    return ops.join('\n');
  });
  const repo = await seeded(port, (db) => equip(db, rooms));
  try {
    const extra = {
      worldCompletion: { mode: 'local', focusLocationIds: [IDS.L2], sourceMaxChars: 250, sourceChunkChars: 100 },
      sourceSnapshot: [sourceEntry('long_lore', LONG_TEXT)],
    };
    // 多批次推进：第一批只吃前两块，尾块必须在后续批次里被真正读到。
    let tailSeen = false;
    let tailEntity = null;
    for (let batch = 0; batch < 6; batch += 1) {
      const prepared = await repo.prepareTurn(turnInput(repo, extra));
      const request = constructionCalls(port).at(-1);
      if (request && request.messages[1].content.includes(TAIL_MARK)) {
        tailSeen = true;
        assert.ok(batch > 0, '尾部不得在第一批就被读到（那说明预算口径失效）');
      }
      await save(repo, prepared);
      const found = queryBound(repo.db, 'SELECT * FROM locations WHERE branch_id = ? AND name = ?', [BRANCH, '石桥大厅']);
      if (found.length > 0) { tailEntity = found[0]; break; }
      if (unitRows(repo.db).filter((row) => row.status === 'pending' || row.status === 'retry').length === 0
        && queryBound(repo.db, 'SELECT id FROM construction_progress WHERE branch_id = ? AND kind = ? AND status = ?', [BRANCH, 'target', 'pending']).length === 0) break;
    }
    assert.equal(tailSeen, true, '尾部内容必须进入过某个建设请求（不是只看 remainingChars 变小）');
    assert.ok(tailEntity, '尾部唯一事实必须产生真实实体');
    assert.equal(tailEntity.parent_location_id, IDS.L2, '实体必须挂在真实父地点上');

    // 来源账本：已成功块有持久区间，且游标是「连续成功前缀」。
    const ledger = readSourceLedger(readProgressRows(createTableReadPort(repo.db), BRANCH), scopeKeyFor('local', [IDS.L2]));
    const chunks = [...ledger.chunks.values()];
    assert.ok(chunks.length >= 4, '长原文必须登记了全部块（含尚未消费的）');
    const firstSource = [...ledger.sources.values()][0];
    assert.ok(firstSource, '必须有来源行');
    assert.equal(firstSource.contentHash, 'h_long_lore');
    const ranges = processedRanges(ledger.chunksBySource.get(firstSource.subjectKey) ?? []);
    assert.ok(ranges.length > 0, '成功块必须形成持久成功区间');
    assert.equal(contiguousProcessedPrefix(ledger.chunksBySource.get(firstSource.subjectKey) ?? []), LONG_TEXT.length, '全部块成功后连续前缀必须到原文末尾');
    const summary = summarizeSources(readProgressRows(createTableReadPort(repo.db), BRANCH), scopeKeyFor('local', [IDS.L2]));
    assert.equal(summary.processedChars, LONG_TEXT.length, '回执必须报出已处理字符数');

    // 建设阶段仍不允许非空间操作（relation.upsert 等一律剔除）。
    const forbidden = normalizeConstructionOps({ operations: [{ op: 'relation.upsert', ref: 'L2', data: {} }], knownIds: [IDS.L2] });
    assert.equal(forbidden.operations.length, 0, '关系操作不得进入建设阶段');
    assert.ok(forbidden.protectedDrops.includes('L2'), '被剔除的非空间操作必须显式记录');
  } finally { await repo.close(); }
});

/* ------------------------------------------------------------------ *
 * SRC04：部分成功 + 重试复用已绑定 ID
 * ------------------------------------------------------------------ */

test('SRC04 一组成功一组失败：业务保存但单元与来源留 retry；重试复用已绑定 ID 不建第二个', async () => {
  const rooms = queuedIds(8, 'src4_');
  let batch = 0;
  const port = model((req) => {
    if (!req.batchId.startsWith('construction_')) return noop;
    batch += 1;
    const foci = promptFoci(req).slice(0, 1);
    return [
      // 合法：新父地点（第一次会真的建立，之后必须被绑定复用）
      JSON.stringify({ op: 'location.upsert', ref: 'new:parent_x', data: { name: 'PARENTX', kind: 'district' } }),
      // 非法：挂在未声明的父地点上（依赖组被拒 → 单元不确认）
      JSON.stringify({ op: 'location.upsert', ref: 'new:child_y', data: { name: 'CHILDY', kind: 'room', parent_ref: 'new:missing_z' } }),
      ...foci.map((focus) => JSON.stringify({ op: 'location.upsert', ref: focus, data: { description: '部分成功核对' } })),
    ].join('\n');
  });
  const repo = await seeded(port, (db) => equip(db, rooms));
  try {
    const extra = {
      worldCompletion: { mode: 'local', focusLocationIds: rooms, sourceMaxChars: 250, sourceChunkChars: 100 },
      sourceSnapshot: [sourceEntry('src4_lore', LONG_TEXT)],
    };
    const first = await repo.prepareTurn(turnInput(repo, extra));
    await save(repo, first);

    const parentsAfterFirst = queryBound(repo.db, 'SELECT * FROM locations WHERE branch_id = ? AND name = ?', [BRANCH, 'PARENTX']);
    assert.equal(parentsAfterFirst.length, 1, '合法的成功业务必须被保存');
    const unitAfterFirst = unitRows(repo.db)[0];
    assert.equal(unitAfterFirst.status, 'retry', '部分成功 → 整个单元留 retry');
    const chunksAfterFirst = chunkRows(repo.db);
    assert.ok(chunksAfterFirst.length > 0, '本批必须登记来源块');
    assert.ok(chunksAfterFirst.every((row) => row.status === 'retry'), '部分成功 → 涉及块留 retry，不推进来源游标');
    const binding = JSON.parse(String(unitAfterFirst.payload_json)).bindings ?? {};
    assert.equal(binding['new:parent_x'], parentsAfterFirst[0].id, '已接受的新实体必须登记 new: → 真实 ID 绑定');

    // 重试：同一份输出再来一次 → 必须复用已绑定 ID，不得建第二个 PARENTX。
    const second = await repo.prepareTurn(turnInput(repo, extra));
    await save(repo, second);
    const parentsAfterSecond = queryBound(repo.db, 'SELECT * FROM locations WHERE branch_id = ? AND name = ?', [BRANCH, 'PARENTX']);
    assert.equal(parentsAfterSecond.length, 1, '重试必须先做绑定转换：不得重新创建同一地点');
    assert.equal(parentsAfterSecond[0].id, parentsAfterFirst[0].id, '复用的必须是同一个真实 ID');
    assert.equal(queryBound(repo.db, 'SELECT id FROM locations WHERE branch_id = ? AND name = ?', [BRANCH, 'CHILDY']).length, 0, '被拒的非法操作不得留下半截实体');
  } finally { await repo.close(); }
});

/* ------------------------------------------------------------------ *
 * SRC05：五种「不算成功」都不推进来源
 * ------------------------------------------------------------------ */

test('SRC05 空文本 / 截断 JSON / protected drop / 额度耗尽 / 候选未保存 都不推进来源', async () => {
  // 1) 空文本来源：不产生块，显式记 remaining。
  const empty = selectWorldConstructionSources({
    snapshot: [sourceEntry('empty_src', '')], chatId: CHAT, branchId: BRANCH, chunkChars: 100,
  });
  assert.equal(empty.chunks.length, 0);
  assert.ok(empty.remaining.some((item) => item.sourceKey === 'empty_src' && item.reason.includes('空文本')));

  // 2) 截断的 JSON：payload 不完整 → 不能确认。
  assert.equal(canConfirmUnit({ requestCompleted: true, payloadComplete: false, normalizedClean: true, appliedClean: true, identityResolved: true, savedAck: true }).ok, false);
  // 3) protected drop → 不能确认。
  assert.equal(canConfirmUnit({ requestCompleted: true, payloadComplete: true, normalizedClean: false, appliedClean: true, identityResolved: true, savedAck: true }).ok, false);
  // 4) 有组被拒 → 不能确认。
  assert.equal(canConfirmUnit({ requestCompleted: true, payloadComplete: true, normalizedClean: true, appliedClean: false, identityResolved: true, savedAck: true }).ok, false);
  // 5) 身份未解决 / 缺 ACK → 都不能确认。
  assert.deepEqual(canConfirmUnit({ requestCompleted: true, payloadComplete: true, normalizedClean: true, appliedClean: true, identityResolved: false, savedAck: true }).reasons, ['IDENTITY_UNRESOLVED']);
  assert.deepEqual(canConfirmUnit({ requestCompleted: true, payloadComplete: true, normalizedClean: true, appliedClean: true, identityResolved: true, savedAck: false }).reasons, ['ACK_MISSING']);
  // 只有六条全满足才算「一次有效结构处理」。
  assert.equal(canConfirmUnit({ requestCompleted: true, payloadComplete: true, normalizedClean: true, appliedClean: true, identityResolved: true, savedAck: true }).ok, true);

  // 6) 端到端：截断 JSON + 宿主拒存。
  const rooms = queuedIds(8, 'src5_');
  const port = model((req) => (req.batchId.startsWith('construction_') ? '{"op":' : noop));
  const repo = await seeded(port, (db) => equip(db, rooms));
  try {
    const extra = {
      worldCompletion: { mode: 'local', focusLocationIds: rooms, sourceMaxChars: 250, sourceChunkChars: 100 },
      sourceSnapshot: [sourceEntry('src5_lore', LONG_TEXT)],
    };
    // 宿主拒存（用户取消 / 保存失败）→ 正式库一个字节都不动。
    const draft = await repo.prepareTurn(turnInput(repo, extra));
    assert.ok(chunkRows(repo.getCandidate(draft.token).db).length > 0, '候选里必须有来源块账本');
    await repo.discardPrepared(draft.token);
    assert.equal(progressRows(repo.db).length, 0, '未保存的批次不得推进来源账本');

    // 保存但响应截断 → 块转 retry，游标停在 0。
    const saved = await repo.prepareTurn(turnInput(repo, extra));
    await save(repo, saved);
    const chunks = chunkRows(repo.db);
    assert.ok(chunks.length > 0, '必须登记块');
    assert.ok(chunks.every((row) => row.status === 'retry'), '截断响应不得把块标成 processed');
    const source = sourceRows(repo.db)[0];
    assert.equal(JSON.parse(String(source.payload_json)).contiguousPrefixEnd, 0, '响应不完整时连续成功前缀必须停在 0');
    assert.ok(Number(JSON.parse(String(chunks[0].payload_json)).attempts) >= 1, '重试次数必须记账');

    // protected drop：改动已确认父关系 → 剔除且不确认。
    const locked = queryBound(repo.db, 'SELECT * FROM locations WHERE branch_id = ? AND existence_quality = ? LIMIT 1', [BRANCH, 'confirmed']);
    if (locked.length > 0) {
      const guarded = normalizeConstructionOps({
        operations: [{ op: 'location.upsert', ref: String(locked[0].id), data: { parent_ref: 'L1' } }],
        knownIds: [String(locked[0].id)],
        lockedLocationIds: [String(locked[0].id)],
      });
      assert.ok(guarded.protectedDrops.includes(String(locked[0].id)), '受保护的父关系改动必须被剔除并记录');
    }
  } finally { await repo.close(); }
});

/* ------------------------------------------------------------------ *
 * SRC06：缺口不越过 + 只补缺口
 * ------------------------------------------------------------------ */

test('SRC06 早块失败后块成功：cursor 不越过缺口；下一次跳过已成功尾块只处理缺口', async () => {
  const rooms = queuedIds(8, 'src6_');
  let constructionCount = 0;
  let newRoomAdded = false;
  const port = model((req) => {
    if (!req.batchId.startsWith('construction_')) return noop;
    constructionCount += 1;
    // 前 MAX_UNIT_ATTEMPTS 次一律失败 → 该单元停牌，缺口留在前面。
    if (constructionCount <= MAX_UNIT_ATTEMPTS) return '{"op":';
    return [...promptFoci(req).slice(0, 1).map((focus) => JSON.stringify({ op: 'location.upsert', ref: focus, data: { description: '后块成功' } })),
      JSON.stringify({ op: 'location.upsert', ref: 'new:later_hall', data: { name: '后段大厅', kind: 'room', parent_ref: 'L2' } })].join('\n');
  });
  const repo = await seeded(port, (db) => equip(db, rooms));
  try {
    const extra = {
      worldCompletion: { mode: 'local', focusLocationIds: rooms, sourceMaxChars: 250, sourceChunkChars: 100 },
      sourceSnapshot: [sourceEntry('src6_lore', LONG_TEXT)],
    };
    for (let i = 0; i < MAX_UNIT_ATTEMPTS; i += 1) {
      const prepared = await repo.prepareTurn(turnInput(repo, extra));
      await save(repo, prepared);
      if (!newRoomAdded && i === 0) {
        // 失败单元停牌后需要新的工作单元，才能推进到后段块。
        equip(repo.db, queuedIds(4, `src6_late_${i}_`));
        newRoomAdded = true;
      }
    }
    const scopeKey = scopeKeyFor('local', rooms);
    const ledgerBefore = readSourceLedger(readProgressRows(createTableReadPort(repo.db), BRANCH), scopeKey);
    const subject = sourceSubjectKey('src6_lore', 'h_src6_lore');
    const beforeChunks = ledgerBefore.chunksBySource.get(subject) ?? [];
    const retryOrSuspended = beforeChunks.filter((chunk) => chunk.status === 'retry' || chunk.status === 'suspended');
    assert.ok(retryOrSuspended.length > 0, '早段块必须停在未完成状态');
    assert.ok(beforeChunks.some((chunk) => chunk.index > 0) === false || beforeChunks.every((chunk) => chunk.status !== 'processed' || chunk.index < 2), '缺口必须在前面');

    // 推进到后段（新单元拿到缺口之外的块）。
    for (let i = 0; i < 4; i += 1) {
      const prepared = await repo.prepareTurn(turnInput(repo, extra));
      await save(repo, prepared);
      const ledger = readSourceLedger(readProgressRows(createTableReadPort(repo.db), BRANCH), scopeKey);
      const list = ledger.chunksBySource.get(subject) ?? [];
      if (list.some((chunk) => chunk.status === 'processed')) break;
    }
    const ledger = readSourceLedger(readProgressRows(createTableReadPort(repo.db), BRANCH), scopeKey);
    const list = ledger.chunksBySource.get(subject) ?? [];
    const done = list.filter((chunk) => chunk.status === 'processed');
    const notDone = list.filter((chunk) => chunk.status !== 'processed');
    if (done.length > 0 && notDone.length > 0) {
      const minDone = Math.min(...done.map((chunk) => chunk.start));
      const maxNotDone = Math.max(...notDone.map((chunk) => chunk.end));
      assert.ok(notDone.some((chunk) => chunk.start < minDone), '必须有「早块未完成、后块已完成」的真实缺口');
      assert.equal(
        contiguousProcessedPrefix(list),
        Math.min(...notDone.map((chunk) => chunk.start)),
        '连续成功前缀必须停在第一个缺口处，不得越过',
      );
      // 「下一次跳过已成功尾块，只处理缺口」：把成功尾块放进跳过集合后，选出的必须只有缺口。
      const tailKeys = new Set(done.map((chunk) => chunk.chunkKey));
      const gapOnly = selectWorldConstructionSources({
        snapshot: [sourceEntry('src6_lore', LONG_TEXT)],
        chatId: CHAT, branchId: BRANCH, chunkChars: 100, maxChars: 250,
        skipChunkKeys: tailKeys,
      });
      assert.ok(gapOnly.chunks.length > 0, '缺口必须还能被选中');
      assert.ok(gapOnly.chunks.every((chunk) => chunk.start < minDone), '选出的必须全部是缺口块，不得重放已成功的尾块');
    }
  } finally { await repo.close(); }
});

/* ------------------------------------------------------------------ *
 * SRC07：hash 变更与关闭来源
 * ------------------------------------------------------------------ */

test('SRC07 来源 hash 变更只重建该来源；另一来源的 processed 区间不丢', () => {
  const textA = 'A'.repeat(300);
  const textB = 'B'.repeat(300);
  const first = selectWorldConstructionSources({
    snapshot: [sourceEntry('src_a', textA, 'hash_a1'), sourceEntry('src_b', textB, 'hash_b1')],
    chatId: CHAT, branchId: BRANCH, chunkChars: 100, maxChars: 400,
  });
  const processed = new Set(first.chunks.map((chunk) => chunk.chunkKey));
  const bKeys = first.chunks.filter((chunk) => chunk.sourceKey === 'src_b').map((chunk) => chunk.chunkKey);
  assert.ok(bKeys.length > 0, 'B 必须先被处理过一部分');

  // A 的原文变了（hash 变）→ A 的行身份整体换新；B 的成功区间键不变。
  const second = selectWorldConstructionSources({
    snapshot: [sourceEntry('src_a', `${textA}追加了新的一节。`, 'hash_a2'), sourceEntry('src_b', textB, 'hash_b1')],
    chatId: CHAT, branchId: BRANCH, chunkChars: 100, maxChars: 400,
    skipChunkKeys: processed,
  });
  const aKeys2 = new Set(second.chunks.filter((chunk) => chunk.sourceKey === 'src_a').map((chunk) => chunk.chunkKey));
  assert.ok([...aKeys2].every((key) => !processed.has(key)), 'A 的新 hash 块必须是新身份，不得复用旧 hash 的块键');
  assert.ok(second.chunks.every((chunk) => !processed.has(chunk.chunkKey)), '已处理的块（含 B 的）不得被重复装入');
  // 旧 hash 的块键仍在 processed 里可见（停止使用 ≠ 删除）。
  assert.ok([...processed].some((key) => key.includes('hash_a1')), '旧 hash 的块身份必须保留（只停止使用，不删账本）');

  // 关闭来源不进请求但账本保留；重新启用后仍按原身份继续。
  const disabled = selectWorldConstructionSources({
    snapshot: [{ ...sourceEntry('src_a', textA, 'hash_a1'), enabled: false }, sourceEntry('src_b', textB, 'hash_b1')],
    chatId: CHAT, branchId: BRANCH, chunkChars: 100, maxChars: 400, skipChunkKeys: processed,
  });
  assert.ok(disabled.chunks.every((chunk) => chunk.sourceKey !== 'src_a'), '关闭来源不得发送');
  assert.ok(disabled.remaining.some((item) => item.sourceKey === 'src_a'), '关闭来源必须留在账本/回执里');
  const reenabled = selectWorldConstructionSources({
    snapshot: [sourceEntry('src_a', textA, 'hash_a1'), sourceEntry('src_b', textB, 'hash_b1')],
    chatId: CHAT, branchId: BRANCH, chunkChars: 100, maxChars: 400, skipChunkKeys: processed,
  });
  assert.ok(reenabled.chunks.length > 0, '重新启用后必须恢复合法进度');
});

/* ------------------------------------------------------------------ *
 * SRC08：rollback 与重复 ACK
 * ------------------------------------------------------------------ */

test('SRC08 rollback 同时撤销来源账本与业务；重复 saved ACK 不推进游标也不额外建对象', async () => {
  const rooms = queuedIds(8, 'src8_');
  const port = model((req) => {
    if (!req.batchId.startsWith('construction_')) return noop;
    return [...promptFoci(req).slice(0, 1).map((focus) => JSON.stringify({ op: 'location.upsert', ref: focus, data: { description: '来源核对' } })),
      JSON.stringify({ op: 'location.upsert', ref: 'new:src8_hall', data: { name: 'SRC8大厅', kind: 'room', parent_ref: 'L2' } })].join('\n');
  });
  const repo = await seeded(port, (db) => equip(db, rooms));
  try {
    const extra = {
      worldCompletion: { mode: 'local', focusLocationIds: rooms, sourceMaxChars: 250, sourceChunkChars: 100 },
      sourceSnapshot: [sourceEntry('src8_lore', LONG_TEXT)],
    };
    const first = await repo.prepareTurn(turnInput(repo, extra));
    await save(repo, first);
    const savedRows = progressRows(repo.db);
    assert.ok(savedRows.some((row) => row.kind === 'chunk'), '必须有块行');
    const sourceBefore = sourceRows(repo.db)[0];
    const prefixBefore = JSON.parse(String(sourceBefore.payload_json)).contiguousPrefixEnd;
    assert.ok(prefixBefore > 0, '成功批次必须推进连续前缀');
    const hallBefore = queryBound(repo.db, 'SELECT id FROM locations WHERE branch_id = ? AND name = ?', [BRANCH, 'SRC8大厅']);
    assert.equal(hallBefore.length, 1);

    // 重复 saved ACK：**必须被识别为重复**（拒绝二次应用），而不是悄悄再写一遍。
    await assert.rejects(
      () => repo.confirmSaved({ token: first.token, snapshotSha256: first.snapshotSha256, result: 'saved' }),
      /候选不存在或已丢弃/,
      '同一 token 的第二次确认必须被拒绝（幂等靠「已应用」判定，不靠重复写入）',
    );
    assert.equal(queryBound(repo.db, 'SELECT id FROM locations WHERE branch_id = ? AND name = ?', [BRANCH, 'SRC8大厅']).length, 1, '重复确认不得再建第二个对象');
    const sourceAfterRepeat = sourceRows(repo.db)[0];
    assert.equal(JSON.parse(String(sourceAfterRepeat.payload_json)).contiguousPrefixEnd, prefixBefore, '重复确认不得推进游标');
    assert.deepEqual(progressRows(repo.db).map((row) => [row.id, row.row_rev]), savedRows.map((row) => [row.id, row.row_rev]), '重复确认不得改写账本行版本');
    // 该回合的 journal 里，每个来源/块行只有一条记录（没有重复应用）。
    const journalRows = queryBound(repo.db, 'SELECT target_row_id, operation FROM turn_changes WHERE turn_id = ? AND target_table = ?', [first.receipt.turnId, 'construction_progress']);
    const seenJournal = new Map();
    for (const row of journalRows) {
      const key = String(row.target_row_id);
      assert.equal(seenJournal.has(key), false, `同一行不得在 journal 里出现两次：${key}`);
      seenJournal.set(key, String(row.operation));
    }
    assert.ok(journalRows.length >= chunkRows(repo.db).length, 'journal 必须覆盖本批全部来源块行');

    // fork 继承同一份来源账本。
    const forked = forkBranch({ parentBranchId: BRANCH, newBranchId: 'main-src-fork', name: '来源分叉', forkTurnId: first.receipt.turnId, makeId: (_k, opId, alias) => `fork_${opId}_${alias}`, nowWallMs: 2, rulesetVersion: 'atlas-1' }, repo.db);
    assert.ok(forked.copiedRows > 0);
    const childChunks = queryBound(repo.db, 'SELECT * FROM construction_progress WHERE branch_id = ? AND kind = ?', ['main-src-fork', 'chunk']);
    assert.equal(childChunks.length, chunkRows(repo.db).length, 'fork 必须复制来源块账本');

    // rollback：来源账本与业务实体一起回到该楼之前。
    const rollback = await repo.prepareRollback({ chatUid: CHAT, branchId: BRANCH, targetParentTurnId: first.receipt.turnId, expectedRevision: 1 });
    await save(repo, rollback);
    assert.equal(progressRows(repo.db).length, 0, 'rollback 必须把来源账本一并撤销');
    assert.equal(queryBound(repo.db, 'SELECT id FROM locations WHERE branch_id = ? AND name = ?', [BRANCH, 'SRC8大厅']).length, 0, 'rollback 必须把业务实体一并撤销');
  } finally { await repo.close(); }
});

/* ------------------------------------------------------------------ *
 * SRC09：context-only 复查不改来源进度
 * ------------------------------------------------------------------ */

test('SRC09 布局/repair 复查走 context-only：看得到已处理块，但不改变来源消费进度', async () => {
  const rooms = queuedIds(8, 'src9_');
  let layoutPayload = '';
  let layoutRecovered = false;
  const port = model((req, n) => {
    if (req.batchId.startsWith('layout_')) {
      layoutPayload = req.messages[1].content;
      if (req.messages[1].content.includes(TAIL_MARK)) layoutRecovered = true;
      return '{"op":"noop"}';
    }
    if (!req.batchId.startsWith('construction_')) return noop;
    return promptFoci(req).slice(0, 1).map((focus) => JSON.stringify({ op: 'location.upsert', ref: focus, data: { description: '来源核对' } })).join('\n');
  });
  const repo = await seeded(port, (db) => equip(db, rooms));
  try {
    const extra = {
      worldCompletion: { mode: 'local', focusLocationIds: rooms, sourceMaxChars: 250, sourceChunkChars: 100 },
      sourceSnapshot: [sourceEntry('src9_lore', LONG_TEXT)],
      layoutMaps: 'active',
    };
    // 先把整份来源消费完（多批次）。
    for (let i = 0; i < 5; i += 1) {
      const prepared = await repo.prepareTurn(turnInput(repo, extra));
      await save(repo, prepared);
      const scopeKey = scopeKeyFor('local', rooms);
      const ledger = readSourceLedger(readProgressRows(createTableReadPort(repo.db), BRANCH), scopeKey);
      const subject = sourceSubjectKey('src9_lore', 'h_src9_lore');
      const list = ledger.chunksBySource.get(subject) ?? [];
      if (contiguousProcessedPrefix(list) === LONG_TEXT.length) break;
    }
    const scopeKey = scopeKeyFor('local', rooms);
    // 只看**来源账本行**（scope 行的扫描游标本来就会随发现推进，那不是来源消费进度）。
    const ledgerSnapshot = (db) => progressRows(db)
      .filter((row) => row.kind === 'source' || row.kind === 'chunk')
      .map((row) => [row.id, row.status, row.row_rev, String(row.payload_json)]);
    const rowsBefore = ledgerSnapshot(repo.db);
    const summaryBefore = summarizeSources(readProgressRows(createTableReadPort(repo.db), BRANCH), scopeKey);
    assert.equal(summaryBefore.processedChars, LONG_TEXT.length, '前置条件必须覆盖原文尾部，不能只检查已经登记的块');
    const chunksBefore = chunkRows(repo.db);
    assert.ok(chunksBefore.length > 0 && chunksBefore.every((row) => row.status === 'processed'), '前置条件：全部块已处理');

    // 再来一次（布局 Map 仍 active → 会走 context-only 复查）。
    const prepared = await repo.prepareTurn(turnInput(repo, extra));
    await save(repo, prepared);
    const rowsAfter = ledgerSnapshot(repo.db);
    assert.ok(rowsBefore.length > 0, '必须有来源账本行可比对');
    assert.deepEqual(rowsAfter, rowsBefore, 'context-only 复查不得改变任何来源账本行');
    const summaryAfter = summarizeSources(readProgressRows(createTableReadPort(repo.db), BRANCH), scopeKey);
    assert.deepEqual(summaryAfter, summaryBefore, 'context-only 复查不得改变来源回执数字');
    if (layoutPayload.length > 0) {
      // 已处理过的块在复查里**照样**可读（否则布局会因为「来源已消费」读不到资料）。
      assert.ok(layoutPayload.includes('甲'), 'context-only 复查仍必须能看到已处理块的内容');
    }
  } finally { await repo.close(); }
});
