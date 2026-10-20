import assert from 'node:assert/strict';
import test from 'node:test';

const policy = await import('../src/utils/wysiwyg/renderBudget.ts').catch(() => ({})) as {
  nextBlockRenderBudget?: (blocks: Array<{ kind: string }>, rendered: number, budget?: number) => number;
};

test('simple paragraphs fill larger follow-up batches without exceeding the document', () => {
  const blocks = Array.from({ length: 260 }, () => ({ kind: 'paragraph' }));
  assert.equal(policy.nextBlockRenderBudget?.(blocks, 0, 60), 60);
  assert.equal(policy.nextBlockRenderBudget?.(blocks, 60), 180);
  assert.equal(policy.nextBlockRenderBudget?.(blocks, 240), 260);
});

test('heavy table and code documents start with a smaller interactive first batch', () => {
  const blocks = Array.from({ length: 100 }, () => ({ kind: 'table' }));
  assert.equal(policy.nextBlockRenderBudget?.(blocks, 0, 60), 7);
  assert.equal(policy.nextBlockRenderBudget?.([{ kind: 'fence' }, { kind: 'table' }], 0, 4), 1);
  assert.equal(policy.nextBlockRenderBudget?.([{ kind: 'table' }], 0, 1), 1);
  assert.equal(policy.nextBlockRenderBudget?.([], 0), 0);
});

test('long documents increase follow-up batches while retaining the small first paint and explicit caller limits', () => {
  const blocks = Array.from({ length: 10_000 }, () => ({ kind: 'paragraph' }));
  assert.equal(policy.nextBlockRenderBudget?.(blocks, 0, 60), 60);
  assert.equal(policy.nextBlockRenderBudget?.(blocks, 4000), 4480);
  assert.equal(policy.nextBlockRenderBudget?.(blocks, 4000, 20), 4020);
  assert.equal(policy.nextBlockRenderBudget?.(blocks, 9900), 10_000);
});
