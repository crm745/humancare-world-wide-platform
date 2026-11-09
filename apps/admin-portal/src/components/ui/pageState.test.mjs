import test from 'node:test';
import assert from 'node:assert/strict';
import { pageState } from './pageState.mjs';

test('with a total: ranges, pages and next/prev', () => {
  const s = pageState({ total: 120, limit: 50, offset: 50, count: 50 });
  assert.deepEqual([s.from, s.to, s.page, s.pages, s.hasPrev, s.hasNext], [51, 100, 2, 3, true, true]);
  assert.equal(s.prevOffset, 0);
  assert.equal(s.nextOffset, 100);
});

test('with a total: last page has no next', () => {
  const s = pageState({ total: 120, limit: 50, offset: 100, count: 20 });
  assert.deepEqual([s.from, s.to, s.hasNext], [101, 120, false]);
});

test('without a total: a full page may have a next, a short page may not', () => {
  assert.equal(pageState({ limit: 50, offset: 0, count: 50 }).hasNext, true);
  assert.equal(pageState({ limit: 50, offset: 0, count: 12 }).hasNext, false);
  assert.equal(pageState({ limit: 50, offset: 0, count: 12 }).pages, null);
});

test('empty result', () => {
  const s = pageState({ total: 0, limit: 50, offset: 0, count: 0 });
  assert.deepEqual([s.from, s.to, s.hasPrev, s.hasNext, s.pages], [0, 0, false, false, 1]);
});

test('previous offset never goes negative', () => {
  assert.equal(pageState({ total: 10, limit: 50, offset: 20, count: 10 }).prevOffset, 0);
});
