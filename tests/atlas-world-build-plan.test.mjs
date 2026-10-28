/**
 * atlas-world-build-plan.test.mjs — P03 §9.2 清单与延后分类 + §9.1 覆盖账本。
 *
 * 只调纯函数：`classifyBuildRequirement` / `computeSourceCoverage`。
 * §9.3 设施方案在 atlas-settlement-plan.test.mjs，§9.5 重要性在 atlas-location-detail-policy.test.mjs。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILD_REQUIREMENT_REASONS,
  INTERIOR_POLICIES,
  classifyBuildRequirement,
  computeSourceCoverage,
} from '../src/atlas-world-build-plan.ts';

function fact(overrides = {}) {
  return {
    version: 1,
    id: 'F1',
    subjectId: 'L1',
    predicate: 'exists',
    layer: 'baseline',
    origin: 'lorebook',
    producer: 'program',
    sourceKey: 'W1',
    sourceHash: 'h1',
    sourceSpan: null,
    quality: 'confirmed',
    effectiveTurnId: 'T1',
    effectiveClockS: null,
    supersedesFactId: null,
    value: true,
    ...overrides,
  };
}

function location(overrides = {}) {
  return { id: 'L1', kind: 'building', name: '某处', existence_quality: 'confirmed', status: 'active', ...overrides };
}

// ---------------------------------------------------------------------------
// §9.2 清单与延后分类
// ---------------------------------------------------------------------------

test('P03 §9.2: 区域 / 城镇 / 城区只要壳，不需要额外室内', () => {
  for (const kind of ['region', 'city', 'district']) {
    const result = classifyBuildRequirement({ location: location({ kind }), facts: [], origin: 'source', canEnter: true });
    assert.equal(result.shellRequired, true, `${kind} 必须登记实体`);
    assert.equal(result.interiorPolicy, 'not-applicable', `${kind} 的「内部」就是它自己那张图`);
    assert.equal(result.reasonCode, 'CONTAINER_SHELL');
  }
});

test('P03 §9.2: 世界书可进入建筑即使内部细节少，内部也是 required-at-start', () => {
  const result = classifyBuildRequirement({ location: location({ kind: 'building' }), facts: [], origin: 'source', canEnter: true });
  assert.equal(result.shellRequired, true);
  assert.equal(result.interiorPolicy, 'required-at-start', '「细节少」不能当延期借口');
  assert.equal(result.reasonCode, 'SOURCE_ENTERABLE_LOW_DETAIL');
});

test('P03 §9.2: 世界书明确写了内部结构 → SOURCE_EXPLICIT_INTERIOR', () => {
  const result = classifyBuildRequirement({
    location: location({ kind: 'building' }),
    facts: [fact({ predicate: 'contains', value: ['大厅', '后厨'] })],
    origin: 'source',
    canEnter: true,
  });
  assert.equal(result.interiorPolicy, 'required-at-start');
  assert.equal(result.reasonCode, 'SOURCE_EXPLICIT_INTERIOR');
});

test('P03 §9.2: 房间本身就是内部，存在即覆盖，不能因「非当前位置」延期', () => {
  const result = classifyBuildRequirement({ location: location({ kind: 'room' }), facts: [], origin: 'source', canEnter: true });
  assert.equal(result.interiorPolicy, 'required-at-start');
  assert.equal(result.reasonCode, 'SOURCE_EXPLICIT_INTERIOR');
});

test('P03 §9.2: 道路 / 河流按线性地物表示，不强行造室内', () => {
  const result = classifyBuildRequirement({
    location: location({ kind: 'natural', terrain: 'river' }),
    facts: [],
    origin: 'source',
    canEnter: false,
  });
  assert.equal(result.shellRequired, true);
  assert.equal(result.interiorPolicy, 'not-applicable');
  assert.equal(result.reasonCode, 'SOURCE_LINEAR_FEATURE');
});

test('P03 §9.2: 世界书里的自然物登记实体，不给它造室内', () => {
  const result = classifyBuildRequirement({
    location: location({ kind: 'natural', terrain: 'mountain' }),
    facts: [],
    origin: 'source',
    canEnter: false,
  });
  assert.equal(result.shellRequired, true);
  assert.equal(result.reasonCode, 'SOURCE_NATURAL_FEATURE');
});

test('P03 §9.2: 推测的装饰性地形不生成可进入地点', () => {
  const result = classifyBuildRequirement({
    location: location({ kind: 'natural', terrain: 'hill' }),
    facts: [],
    origin: 'inferred',
    canEnter: false,
  });
  assert.equal(result.shellRequired, false, '不具备独立互动身份就不建，不为凑数生成地点');
  assert.equal(result.interiorPolicy, 'not-applicable');
  assert.equal(result.reasonCode, 'DECORATIVE_NOT_INTERACTIVE');
});

test('P03 §9.2: 推测地形带结构断言 → 进事实层的真实结构', () => {
  const result = classifyBuildRequirement({
    location: location({ kind: 'natural', terrain: 'hill' }),
    facts: [fact({ predicate: 'entrance', origin: 'inferred', quality: 'estimated', value: 'north' })],
    origin: 'inferred',
    canEnter: true,
  });
  assert.equal(result.shellRequired, true);
  assert.equal(result.interiorPolicy, 'not-applicable');
  assert.equal(result.reasonCode, 'INFERRED_TERRAIN_STRUCTURE');
});

test('P03 §9.2: 常识补的普通设施内部延后到确认进入', () => {
  const result = classifyBuildRequirement({ location: location({ kind: 'building' }), facts: [], origin: 'inferred', canEnter: true });
  assert.equal(result.shellRequired, true);
  assert.equal(result.interiorPolicy, 'on-confirmed-entry');
  assert.equal(result.reasonCode, 'INFERRED_FACILITY_INTERIOR_DEFERRED');
});

test('P03 §9.2: 推测设施后来拿到明确内部资料 → 升为必建增量，不等主角进入', () => {
  const result = classifyBuildRequirement({
    location: location({ kind: 'building' }),
    facts: [fact({ predicate: 'contains', value: ['二楼客房'] })],
    origin: 'inferred',
    canEnter: true,
  });
  assert.equal(result.interiorPolicy, 'required-at-start');
  assert.equal(result.reasonCode, 'INFERRED_FACILITY_INTERIOR_PROMOTED');
});

test('P03 §9.2: 推测断言不足以把设施内部升级为必建', () => {
  const result = classifyBuildRequirement({
    location: location({ kind: 'building' }),
    facts: [fact({ predicate: 'contains', origin: 'inferred', quality: 'estimated', value: ['猜的隔间'] })],
    origin: 'inferred',
    canEnter: true,
  });
  assert.equal(result.interiorPolicy, 'on-confirmed-entry');
  assert.equal(result.reasonCode, 'INFERRED_FACILITY_INTERIOR_DEFERRED');
});

test('P03 §9.2: 世界书明确但不可进入的建筑只建壳', () => {
  const result = classifyBuildRequirement({ location: location({ kind: 'building' }), facts: [], origin: 'source', canEnter: false });
  assert.equal(result.shellRequired, true, '玩家在地图上看得见它');
  assert.equal(result.interiorPolicy, 'not-applicable');
  assert.equal(result.reasonCode, 'NON_ENTERABLE_STRUCTURE');
});

test('P03 §9.2: 推测且不可进入的建筑不建壳', () => {
  const result = classifyBuildRequirement({ location: location({ kind: 'building' }), facts: [], origin: 'inferred', canEnter: false });
  assert.equal(result.shellRequired, false);
  assert.equal(result.reasonCode, 'NON_ENTERABLE_STRUCTURE');
});

test('P03 §9.2: 假设性存在不建，等明确资料', () => {
  const result = classifyBuildRequirement({
    location: location({ kind: 'building', existence_quality: 'hypothetical' }),
    facts: [],
    origin: 'source',
    canEnter: true,
  });
  assert.equal(result.shellRequired, false);
  assert.equal(result.reasonCode, 'HYPOTHETICAL_NOT_BUILT');
});

test('P03 §9.2: 无法归类对象不冒充空间对象', () => {
  const source = classifyBuildRequirement({ location: location({ kind: 'other' }), facts: [], origin: 'source', canEnter: true });
  assert.equal(source.shellRequired, true);
  assert.equal(source.interiorPolicy, 'not-applicable');
  assert.equal(source.reasonCode, 'OTHER_NON_SPATIAL');

  const inferred = classifyBuildRequirement({ location: location({ kind: 'other' }), facts: [], origin: 'inferred', canEnter: true });
  assert.equal(inferred.shellRequired, false);
});

test('P03 §9.2: 判定与断言顺序无关（不按数组顺序取第一条）', () => {
  const facts = [
    fact({ id: 'F3', predicate: 'contains', value: ['甲'] }),
    fact({ id: 'F1', predicate: 'exists' }),
    fact({ id: 'F2', predicate: 'entrance', value: 'south' }),
  ];
  const forward = classifyBuildRequirement({ location: location(), facts, origin: 'source', canEnter: true });
  const reversed = classifyBuildRequirement({ location: location(), facts: [...facts].reverse(), origin: 'source', canEnter: true });
  assert.deepEqual(forward, reversed);
});

test('P03 §9.2: 返回的理由码与内部策略都在白名单内', () => {
  const kinds = ['region', 'city', 'district', 'building', 'room', 'floor', 'vehicle', 'natural', 'other', 'unknown-kind'];
  for (const kind of kinds) {
    for (const origin of ['source', 'inferred']) {
      for (const canEnter of [true, false]) {
        const result = classifyBuildRequirement({ location: location({ kind }), facts: [], origin, canEnter });
        assert.ok((BUILD_REQUIREMENT_REASONS).includes(result.reasonCode), `${kind}/${origin}/${canEnter} 理由码越界：${result.reasonCode}`);
        assert.ok((INTERIOR_POLICIES).includes(result.interiorPolicy), `${kind}/${origin}/${canEnter} 内部策略越界`);
        if (result.interiorPolicy !== 'not-applicable') {
          assert.equal(result.shellRequired, true, '有内部责任就必须先有壳');
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// §9.1 覆盖账本
// ---------------------------------------------------------------------------

const sourceOf = (overrides = {}) => ({
  sourceKey: 'W1',
  contentHash: 'h1',
  kind: 'lorebook',
  chars: 4000,
  hostTruncated: false,
  chunkCount: 2,
  ...overrides,
});

test('P03 §9.1: 全部块 processed 才算来源扫描完成', () => {
  const coverage = computeSourceCoverage({
    known: [sourceOf()],
    processedChunkKeys: ['W1@h1@1#0', 'W1@h1@1#1'],
    knownChunkKeys: ['W1@h1@1#0', 'W1@h1@1#1'],
  });
  assert.equal(coverage.sourceScanComplete, true);
  assert.deepEqual(coverage.issues, []);
  assert.equal(coverage.totalChunks, 2);
  assert.equal(coverage.processedChunks, 2);
  assert.equal(coverage.uncheckedChunks, 0);
});

test('P03 §9.1: 有未检查的块就不算读完，并报出缺口数量', () => {
  const coverage = computeSourceCoverage({
    known: [sourceOf()],
    processedChunkKeys: ['W1@h1@1#0'],
    knownChunkKeys: ['W1@h1@1#0', 'W1@h1@1#1'],
  });
  assert.equal(coverage.sourceScanComplete, false);
  assert.equal(coverage.uncheckedChunks, 1);
  const incomplete = coverage.issues.find((item) => item.code === 'SOURCE_COVERAGE_INCOMPLETE');
  assert.ok(incomplete, '必须明确报 SOURCE_COVERAGE_INCOMPLETE');
  assert.equal(incomplete.retryable, true);
  assert.ok(incomplete.message.includes('1 / 2'));
});

test('P03 §9.1: 显式延期的块不算读过', () => {
  const coverage = computeSourceCoverage({
    known: [sourceOf()],
    processedChunkKeys: ['W1@h1@1#0'],
    knownChunkKeys: ['W1@h1@1#0', 'W1@h1@1#1'],
    deferred: [{ chunkKey: 'W1@h1@1#1', sourceKey: 'W1' }],
  });
  assert.equal(coverage.sourceScanComplete, false);
  assert.equal(coverage.deferredChunks, 1);
  assert.equal(coverage.uncheckedChunks, 0);
  assert.ok(coverage.issues.some((item) => item.code === 'SOURCE_COVERAGE_DEFERRED'));
});

test('P03 §9.1: 宿主截断的来源不能声称读完', () => {
  const coverage = computeSourceCoverage({
    known: [sourceOf({ hostTruncated: true })],
    processedChunkKeys: ['W1@h1@1#0', 'W1@h1@1#1'],
    knownChunkKeys: ['W1@h1@1#0', 'W1@h1@1#1'],
  });
  assert.equal(coverage.sourceScanComplete, false);
  assert.equal(coverage.hostTruncatedSources, 1);
  const truncated = coverage.issues.find((item) => item.code === 'SOURCE_COVERAGE_HOST_TRUNCATED');
  assert.ok(truncated);
  assert.ok(truncated.message.includes('W1'));
});

test('P03 §9.1: 有来源但全是空文本，不是「读完了」', () => {
  const coverage = computeSourceCoverage({ known: [sourceOf({ chunkCount: 0, chars: 0 })] });
  assert.equal(coverage.allowedSources, 0);
  assert.equal(coverage.emptySources, 1);
  assert.equal(coverage.sourceScanComplete, false);
  assert.ok(coverage.issues.some((item) => item.code === 'SOURCE_COVERAGE_EMPTY'));
});

test('P03 §9.1: 零来源同样是未完成，不是完成', () => {
  const coverage = computeSourceCoverage({ known: [] });
  assert.equal(coverage.knownSources, 0);
  assert.equal(coverage.sourceScanComplete, false, '什么都没读到不能算读完');
});

test('P03 §9.1: 历史 hash 遗留的 processed 块不撑高覆盖数', () => {
  const coverage = computeSourceCoverage({
    known: [sourceOf({ contentHash: 'h2' })],
    processedChunkKeys: ['W1@h1@1#0', 'W1@h1@1#1', 'W1@h2@1#0'],
    knownChunkKeys: ['W1@h2@1#0', 'W1@h2@1#1'],
  });
  assert.equal(coverage.processedChunks, 1, '旧 hash 的两个块不属于当前账本');
  assert.equal(coverage.uncheckedChunks, 1);
  assert.equal(coverage.sourceScanComplete, false);
});

test('P03 §9.1: 多来源混合时逐项统计，complete 要全部满足', () => {
  const coverage = computeSourceCoverage({
    known: [
      sourceOf({ sourceKey: 'W1', contentHash: 'h1', chunkCount: 2 }),
      sourceOf({ sourceKey: 'W2', contentHash: 'h2', chunkCount: 1 }),
      sourceOf({ sourceKey: 'W3', contentHash: 'h3', chunkCount: 0, chars: 0 }),
    ],
    processedChunkKeys: ['W1@h1@1#0', 'W1@h1@1#1', 'W2@h2@1#0'],
    knownChunkKeys: ['W1@h1@1#0', 'W1@h1@1#1', 'W2@h2@1#0'],
  });
  assert.equal(coverage.knownSources, 3);
  assert.equal(coverage.allowedSources, 2);
  assert.equal(coverage.emptySources, 1);
  assert.equal(coverage.totalChunks, 3);
  assert.equal(coverage.processedChunks, 3);
  assert.equal(coverage.sourceScanComplete, true, '空文本来源不阻塞「已检查过的允许块」');
});
