/* global describe, it, expect */
const { applyFilters, DEFAULT_FILTERS } = require('../filters');

const TODAY = '2026-09-25';
const ITEMS = [
  { id: 1, service: 'air', date: '2026-09-25' }, // today
  { id: 2, service: 'ground', date: '2026-09-20' }, // this week
  { id: 3, service: 'air', date: '2026-08-10' }, // this month? no — different month
  { id: 4, service: 'air', date: '2026-09-01' }, // this month
  { id: 5, service: 'air', date: '2025-09-25' }, // last year
];

describe('applyFilters', () => {
  it('returns everything with default filters', () => {
    expect(applyFilters(ITEMS, DEFAULT_FILTERS, TODAY)).toHaveLength(5);
  });

  it('filters by service', () => {
    const out = applyFilters(ITEMS, { service: 'ground', date: 'all', sort: 'newest' }, TODAY);
    expect(out.map((i) => i.id)).toEqual([2]);
  });

  it('filters to just today', () => {
    const out = applyFilters(ITEMS, { service: 'all', date: 'today', sort: 'newest' }, TODAY);
    expect(out.map((i) => i.id)).toEqual([1]);
  });

  it('filters to this week (last 7 days)', () => {
    const out = applyFilters(ITEMS, { service: 'all', date: 'week', sort: 'newest' }, TODAY);
    expect(out.map((i) => i.id).sort()).toEqual([1, 2]);
  });

  it('filters to this month', () => {
    const out = applyFilters(ITEMS, { service: 'all', date: 'month', sort: 'newest' }, TODAY);
    expect(out.map((i) => i.id).sort()).toEqual([1, 2, 4]);
  });

  it('filters by a custom date range', () => {
    const out = applyFilters(ITEMS, { service: 'all', date: 'custom', from: '2026-09-01', to: '2026-09-21', sort: 'newest' }, TODAY);
    expect(out.map((i) => i.id).sort()).toEqual([2, 4]);
  });

  it('sorts newest-first by default and oldest-first when asked', () => {
    const newest = applyFilters(ITEMS, { service: 'all', date: 'all', sort: 'newest' }, TODAY);
    expect(newest[0].id).toBe(1);
    const oldest = applyFilters(ITEMS, { service: 'all', date: 'all', sort: 'oldest' }, TODAY);
    expect(oldest[0].id).toBe(5);
  });
});
