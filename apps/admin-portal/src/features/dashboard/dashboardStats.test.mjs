import test from 'node:test';
import assert from 'node:assert/strict';
import { STAT_STATUS, buildStats, countFrom, isFailed, totalRequests } from './dashboardStats.mjs';

test('the status names are the backend ones', () => {
  assert.deepEqual(STAT_STATUS, { pending: 'in_review', awaitingPatient: 'changes_requested', approved: 'approved' });
});

test('countFrom accepts only a real count, and keeps zero', () => {
  assert.equal(countFrom({ requests: [], total: 0 }), 0);
  assert.equal(countFrom({ total: 42 }), 42);
  for (const bad of [undefined, null, {}, { total: '5' }, { total: -1 }, { total: 1.5 }]) assert.equal(countFrom(bad), null);
});

test('the total is the sum of the three submitted states, and unknown if any part is', () => {
  assert.equal(totalRequests(2, 3, 4), 9);
  assert.equal(totalRequests(0, 0, 0), 0);
  assert.equal(totalRequests(2, null, 4), null);
});

test('Operational Cases is always unavailable: never derived from Cases, from the Approved count, or from anything else', () => {
  const stats = buildStats({ pending: 1, awaitingPatient: 2, approved: 3, cases: 99, caseList: [{ serviceRequestId: 5 }] });
  const cases = stats.find((s) => s.key === 'cases');
  assert.equal(cases.value, null);
  assert.equal(cases.unsupported, true);
  assert.equal(isFailed(cases), false); // not a load failure, so no "try again" warning
});

test('buildStats lists the five figures in order; the four supported ones keep their calculation', () => {
  const stats = buildStats({ pending: 1, awaitingPatient: 0, approved: 3 });
  assert.deepEqual(stats.map((s) => s.key), ['total', 'pending', 'awaiting', 'approved', 'cases']);
  assert.deepEqual(stats.map((s) => s.value), [4, 1, 0, 3, null]);
});

test('a supported figure that failed to load counts as failed', () => {
  const stats = buildStats({ pending: null, awaitingPatient: 0, approved: 3 });
  assert.deepEqual(stats.filter(isFailed).map((s) => s.key), ['total', 'pending']);
});
