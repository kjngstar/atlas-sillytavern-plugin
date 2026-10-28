/**
 * atlas-source-catalogue.test.mjs — P02 冻结来源目录与别名解析断言。
 *
 * 覆盖：别名按 key 稳定排序分配（输入顺序无关）；真实 key 叫 SRC1 时别名避开；
 * 完整 key 精确匹配优先于别名；未知/块键/纯 hash/纯数字分别报不同码；
 * 目录冻结不可改；hash 漂移能被 assertSameCatalogue 抓到；
 * 操作层只解析顶层 source，“data.area.source” 这类嵌套枚举不参与。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSourceCatalogue,
  lookupSource,
  resolveOperationSources,
  requestedSourceRefs,
  assertSameCatalogue,
  describeSourceCatalogue,
  SOURCE_ALIAS_PREFIX,
  SOURCE_CATALOGUE_VERSION,
} from '../src/atlas-source-catalogue.ts';

function entry(key, contentHash = `hash-${key}`, kind = 'lorebook') {
  return { key, contentHash, kind };
}

/* ─────────────────────── 构造与冻结 ─────────────────────── */

test('目录：别名为 SRC1 起编号，按 key 字典序分配', () => {
  const catalogue = buildSourceCatalogue([entry('b-key'), entry('a-key'), entry('c-key')]);
  assert.equal(catalogue.version, SOURCE_CATALOGUE_VERSION);
  assert.deepEqual(catalogue.entries.map((item) => item.key), ['a-key', 'b-key', 'c-key']);
  assert.deepEqual(catalogue.entries.map((item) => item.alias), ['SRC1', 'SRC2', 'SRC3']);
  assert.equal(SOURCE_ALIAS_PREFIX, 'SRC');
});

test('目录：输入顺序不影响别名分配（同一来源集得到同一份目录）', () => {
  const forward = buildSourceCatalogue([entry('x'), entry('y'), entry('z')]);
  const backward = buildSourceCatalogue([entry('z'), entry('y'), entry('x')]);
  assert.equal(forward.hash, backward.hash);
  assert.deepEqual(forward.entries, backward.entries);
});

test('目录：真实 key 叫 SRC1 时，别名必须避开它', () => {
  const catalogue = buildSourceCatalogue([entry('SRC1'), entry('a-key')]);
  const aliases = catalogue.entries.map((item) => item.alias);
  assert.ok(!aliases.includes('SRC1'), '别名不能与真实 key 同名');
  // 第一个非冲突别名是 SRC2
  assert.deepEqual(aliases.sort(), ['SRC2', 'SRC3'].sort());
  const real = catalogue.entries.find((item) => item.key === 'SRC1');
  assert.equal(real.alias, 'SRC2');
});

test('目录：重复 key 只保留一条，空 key 被丢弃', () => {
  const catalogue = buildSourceCatalogue([entry('a'), entry('a'), entry(''), { key: '  ', contentHash: 'h', kind: 'k' }]);
  assert.equal(catalogue.entries.length, 1);
  assert.equal(catalogue.entries[0].key, 'a');
});

test('目录：hash 对内容敏感，内容变则指纹变', () => {
  const base = buildSourceCatalogue([entry('a', 'h1')]);
  const changed = buildSourceCatalogue([entry('a', 'h2')]);
  const more = buildSourceCatalogue([entry('a', 'h1'), entry('b', 'h1')]);
  assert.notEqual(base.hash, changed.hash);
  assert.notEqual(base.hash, more.hash);
  assert.equal(base.hash, buildSourceCatalogue([entry('a', 'h1')]).hash);
});

test('目录：冻结后不可被调用方改写', () => {
  const catalogue = buildSourceCatalogue([entry('a')]);
  assert.equal(Object.isFrozen(catalogue), true);
  assert.equal(Object.isFrozen(catalogue.entries), true);
  assert.equal(Object.isFrozen(catalogue.entries[0]), true);

  const originalAlias = catalogue.entries[0].alias;
  try {
    catalogue.entries[0].alias = 'HACKED';
  } catch {
    /* 严格模式下冻结对象赋值会抛错，两种结果都算「改不动」 */
  }
  assert.equal(catalogue.entries[0].alias, originalAlias);
});

test('目录：同一份目录自比为同一份，内容不同则报漂移', () => {
  const left = buildSourceCatalogue([entry('a')]);
  const right = buildSourceCatalogue([entry('a')]);
  const drifted = buildSourceCatalogue([entry('a', 'other-hash')]);

  assert.deepEqual(assertSameCatalogue(left, right), { same: true });
  const verdict = assertSameCatalogue(left, drifted);
  assert.equal(verdict.same, false);
  assert.equal(verdict.code, 'SOURCE_CATALOGUE_DRIFT');
  assert.match(verdict.message, /冻结后发生变化/);
});

/* ─────────────────────── 解析 ─────────────────────── */

test('解析：完整 key 精确匹配', () => {
  const catalogue = buildSourceCatalogue([entry('lore:world#1')]);
  const found = lookupSource(catalogue, 'lore:world#1');
  assert.equal(found.ok, true);
  assert.equal(found.via, 'key');
  assert.equal(found.entry.key, 'lore:world#1');
});

test('解析：别名也能命中', () => {
  const catalogue = buildSourceCatalogue([entry('lore:world#1')]);
  const found = lookupSource(catalogue, 'SRC1');
  assert.equal(found.ok, true);
  assert.equal(found.via, 'alias');
  assert.equal(found.entry.key, 'lore:world#1');
});

test('解析：完整 key 优先于别名（真实 key 与别名重名时不指错对象）', () => {
  // a-key 拿到 SRC2（SRC1 被真实 key 占用）；真实 key 'SRC1' 本身必须解析到自己
  const catalogue = buildSourceCatalogue([entry('SRC1'), entry('a-key')]);
  const byRealKey = lookupSource(catalogue, 'SRC1');
  assert.equal(byRealKey.ok, true);
  assert.equal(byRealKey.via, 'key');
  assert.equal(byRealKey.entry.key, 'SRC1');

  const byAlias = lookupSource(catalogue, 'SRC2');
  assert.equal(byAlias.ok, true);
  assert.equal(byAlias.via, 'alias');
  assert.equal(byAlias.entry.key, 'SRC1', 'SRC2 是 SRC1 这条真实 key 的别名');
});

test('解析：未知来源报 SOURCE_UNKNOWN，不猜不改', () => {
  const catalogue = buildSourceCatalogue([entry('a')]);
  const found = lookupSource(catalogue, 'not-in-catalogue');
  assert.equal(found.ok, false);
  assert.equal(found.code, 'SOURCE_UNKNOWN');
  assert.match(found.message, /冻结目录/);
});

test('解析：块键、内容哈希、纯段编号分别被明确拒绝', () => {
  const catalogue = buildSourceCatalogue([entry('a')]);

  const chunk = lookupSource(catalogue, 'lore:world#1@sha256abc@2#3');
  assert.equal(chunk.ok, false);
  assert.equal(chunk.code, 'SOURCE_REF_SHAPE_INVALID');
  assert.match(chunk.message, /来源块键/);

  const hash = lookupSource(catalogue, 'a'.repeat(32));
  assert.equal(hash.ok, false);
  assert.equal(hash.code, 'SOURCE_REF_SHAPE_INVALID');
  assert.match(hash.message, /内容哈希/);

  const index = lookupSource(catalogue, '7');
  assert.equal(index.ok, false);
  assert.equal(index.code, 'SOURCE_REF_SHAPE_INVALID');
  assert.match(index.message, /段编号/);
});

test('解析：空引用报 SOURCE_UNKNOWN', () => {
  const catalogue = buildSourceCatalogue([entry('a')]);
  const found = lookupSource(catalogue, '   ');
  assert.equal(found.ok, false);
  assert.equal(found.code, 'SOURCE_UNKNOWN');
});

/* ─────────────────────── 操作层 ─────────────────────── */

test('操作层：未声明 source 时保留原绑定，不报错', () => {
  const catalogue = buildSourceCatalogue([entry('a')]);
  const result = resolveOperationSources(catalogue, { op: 'location.upsert', ref: 'L1', data: {} });
  assert.deepEqual(result.keys, []);
  assert.equal(result.issues.length, 0);
});

test('操作层：别名数组解析成完整 key 并去重', () => {
  const catalogue = buildSourceCatalogue([entry('a'), entry('b')]);
  const result = resolveOperationSources(catalogue, {
    op: 'location.upsert',
    ref: 'L1',
    data: {},
    source: ['SRC1', 'SRC2', 'a'],
  });
  assert.deepEqual(result.keys, ['a', 'b']);
  assert.equal(result.issues.length, 0);
});

test('操作层：未知数组成员逐条报错并带 opId', () => {
  const catalogue = buildSourceCatalogue([entry('a')]);
  const result = resolveOperationSources(
    catalogue,
    { op: 'location.upsert', ref: 'L1', data: {}, source: ['SRC1', 'ghost'] },
    { opId: 'op_7_abc' },
  );
  assert.deepEqual(result.keys, ['a']);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'SOURCE_UNKNOWN');
  assert.equal(result.issues[0].opId, 'op_7_abc');
  assert.equal(result.issues[0].severity, 'error');
});

test('操作层：嵌套 data.area.source 不被当成来源引用', () => {
  const catalogue = buildSourceCatalogue([entry('a')]);
  const op = {
    op: 'location.upsert',
    ref: 'L1',
    data: { area: { source: 'SRC1' }, region_source: 'SRC2' },
  };
  assert.deepEqual(requestedSourceRefs(op), [], '只读顶层 source');
  const result = resolveOperationSources(catalogue, op);
  assert.deepEqual(result.keys, []);
  assert.equal(result.issues.length, 0);
});

test('T-C10 操作层：非字符串 source 成员拒绝整个来源声明，不静默过滤', () => {
  const catalogue = buildSourceCatalogue([entry('a')]);
  for (const source of [[1, null, { key: 'a' }, 'SRC1'], 42, null]) {
    const result = resolveOperationSources(catalogue, { op: 'x', source });
    assert.deepEqual(result.keys, []);
    assert.deepEqual(result.issues.map(issue => [issue.code, issue.severity]), [['SOURCE_UNKNOWN', 'error']]);
  }
});

test('describeSourceCatalogue 给出条数与指纹前缀', () => {
  const catalogue = buildSourceCatalogue([entry('a'), entry('b')]);
  const text = describeSourceCatalogue(catalogue);
  assert.match(text, /sources 2/);
  assert.match(text, new RegExp(catalogue.hash.slice(0, 12)));
});
