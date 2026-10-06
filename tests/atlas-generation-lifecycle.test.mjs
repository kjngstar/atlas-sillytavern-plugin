import test from 'node:test';
import assert from 'node:assert/strict';
import { createAtlasGenerationLifecycle } from '../src/atlas-generation-lifecycle.ts';

test('nested preprocessing and its completion aliases restore the foreground before MESSAGE_SENT', () => {
  const g = createAtlasGenerationLifecycle();
  const main = g.start(false, { generationType: 'normal' });
  g.start(true, { generationType: 'quiet', quietPromptPresent: true });
  assert.equal(g.message().gated, true);
  assert.equal(g.complete('ended').gated, true);
  assert.equal(g.complete('after-commands').duplicate, true);
  assert.equal(g.message().details.generationSequence, main.details.generationSequence);
  assert.equal(g.complete('received', true).gated, false);
  assert.equal(g.complete('ended').duplicate, false);
  assert.equal(g.complete('after-commands').duplicate, true);
});

test('multiple nested requests unwind individually without consuming their parent', () => {
  const g = createAtlasGenerationLifecycle();
  g.start(false);
  g.start(true, { generationType: 'quiet' });
  g.start(true, { generationType: 'normal', dryRun: true });
  assert.equal(g.complete('ended').details.dryRun, true);
  assert.equal(g.complete('after-commands').duplicate, true);
  assert.equal(g.complete('ended').details.generationType, 'quiet');
  assert.equal(g.complete('after-commands').duplicate, true);
  assert.equal(g.message().gated, false);
});

test('a background stop and subsequent end aliases leave the foreground alive', () => {
  const g = createAtlasGenerationLifecycle();
  const main = g.start(false);
  g.start(true);
  assert.equal(g.stop().gated, true);
  assert.equal(g.complete('ended').duplicate, true);
  assert.equal(g.complete('after-commands').duplicate, true);
  assert.equal(g.message().details.generationSequence, main.details.generationSequence);
  assert.equal(g.complete('ended').gated, false);
});

test('hosts with only AFTER_COMMANDS close nested requests and allow a new send', () => {
  const g = createAtlasGenerationLifecycle();
  g.start(false);
  g.start(true);
  assert.equal(g.complete('after-commands').gated, true);
  assert.equal(g.message().gated, false);
  assert.equal(g.complete('after-commands').gated, false);
  assert.equal(g.complete('after-commands').duplicate, true);
});

test('a visible received floor observes the foreground without popping a background request', () => {
  const g = createAtlasGenerationLifecycle();
  g.start(false);
  g.start(true);
  assert.equal(g.complete('received', true).gated, false);
  assert.equal(g.message().gated, true);
  assert.equal(g.complete('ended').gated, true);
  assert.equal(g.complete('after-commands').duplicate, true);
  assert.equal(g.complete('ended').gated, false);
});

test('chat switch resets gating and expired requests cannot gate future messages', () => {
  let time = 0;
  const g = createAtlasGenerationLifecycle(() => time);
  g.start(true);
  g.reset();
  assert.equal(g.message().gated, false);
  g.start(true);
  time = 31 * 60_000;
  assert.equal(g.message().gated, false);
});
