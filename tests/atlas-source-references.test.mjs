import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditSourceReferences } from '../tools/audit-source-references.mjs';

test('reference audit distinguishes runtime, type, test, experiment and unknown dynamic dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'atlas-reference-audit-'));
  try {
    for (const directory of ['src', 'tests', 'tools/map-lab']) mkdirSync(join(root, directory), { recursive: true });
    const files = {
      'index.js': `import './src/runtime.ts'; import type { T } from './src/types.ts'; const x = import(candidate);`,
      'src/runtime.ts': `export { leaf } from './leaf.ts'; const lazy = import('./lazy.ts');`,
      'src/leaf.ts': 'export const leaf = 1;', 'src/lazy.ts': 'export const lazy = 1;',
      'src/types.ts': 'export type T = string;', 'src/test-only.ts': 'export const x = 1;',
      'src/lab-only.ts': 'export const x = 1;', 'src/unused.ts': 'export const x = 1;',
      'src/atlas-sim-time.ts': 'export const x = 1;',
      'tests/example.mjs': `import '../src/test-only.ts';`,
      'tools/map-lab/example.mjs': `import '../../src/lab-only.ts';`,
    };
    for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
    const result = auditSourceReferences(root, { productionRoots: ['index.js'], generatedEntries: {} });
    const row = file => result.modules.find(module => module.file === `src/${file}.ts`);
    assert.deepEqual(row('leaf').uses, ['production']);
    assert.deepEqual(row('lazy').uses, ['production']);
    assert.deepEqual(row('types').uses, ['production-type']);
    assert.deepEqual(row('test-only').uses, ['test']);
    assert.deepEqual(row('lab-only').uses, ['experiment']);
    assert.equal(row('unused').status, 'unreferenced-candidate');
    assert.equal(row('atlas-sim-time').status, 'pending-hook');
    assert.ok(result.unknown.some(row => row.reason === 'computed-reference' && row.expression === 'candidate'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
