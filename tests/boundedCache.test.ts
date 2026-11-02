import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedCache } from '../src/utils/boundedCache.ts';

test('evicts the least recently used entry when the count limit is reached', () => {
  const cache = new BoundedCache<string, string>(2);

  cache.set('a', 'A');
  cache.set('b', 'B');
  assert.equal(cache.get('a'), 'A'); // refresh a
  cache.set('c', 'C');

  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 'A');
  assert.equal(cache.get('c'), 'C');
  assert.equal(cache.size, 2);
});

test('evicts by total weight and refuses entries larger than the budget', () => {
  const cache = new BoundedCache<string, string>(10, 5, value => value.length);

  cache.set('a', 'aa');
  cache.set('b', 'bb');
  cache.set('c', 'cc'); // 6 > 5, evict a
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 'bb');
  assert.equal(cache.get('c'), 'cc');

  cache.set('huge', 'x'.repeat(6));
  assert.equal(cache.get('huge'), undefined);
  assert.equal(cache.size, 2);
});

test('replacing a key updates its weight without double counting', () => {
  const cache = new BoundedCache<string, string>(10, 4, value => value.length);

  cache.set('a', 'aaa');
  cache.set('a', 'a');
  cache.set('b', 'bbb');

  assert.equal(cache.get('a'), 'a');
  assert.equal(cache.get('b'), 'bbb');
  assert.equal(cache.size, 2);
});

test('clear releases every entry', () => {
  const cache = new BoundedCache<string, string>(4);
  cache.set('a', 'A');
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get('a'), undefined);
});
