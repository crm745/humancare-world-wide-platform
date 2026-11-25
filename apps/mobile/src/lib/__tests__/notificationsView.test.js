/* global describe, test, expect */
// The Notifications screen's list state: the server's list plus only the changes the server confirmed.
const { applyEdits, EMPTY_EDITS, hasUnread, unreadIds, withDeleted, withRead } = require('../notificationsView');

const LIST = () => [
  { id: 1, title: 'a', readAt: null },
  { id: 2, title: 'b', readAt: '2026-01-01T00:00:00.000Z' },
  { id: 3, title: 'c', readAt: null },
];

describe('applyEdits', () => {
  test('with no edits the list is what the server sent', () => {
    expect(applyEdits(LIST(), EMPTY_EDITS)).toEqual(LIST());
    expect(applyEdits(LIST())).toEqual(LIST());
  });

  test('a confirmed read shows as read; others stay unread; the server\'s own read time is kept', () => {
    const edits = withRead(EMPTY_EDITS, [1, 2], '2026-02-02T00:00:00.000Z');
    const out = applyEdits(LIST(), edits);
    expect(out.find((n) => n.id === 1).readAt).toBe('2026-02-02T00:00:00.000Z');
    expect(out.find((n) => n.id === 2).readAt).toBe('2026-01-01T00:00:00.000Z');
    expect(out.find((n) => n.id === 3).readAt).toBeNull();
  });

  test('a confirmed delete removes the row', () => {
    expect(applyEdits(LIST(), withDeleted(EMPTY_EDITS, 3)).map((n) => n.id)).toEqual([1, 2]);
  });

  test('edits accumulate and never change the inputs', () => {
    const e1 = withRead(EMPTY_EDITS, [1], 't1');
    const e2 = withDeleted(e1, 2);
    expect(applyEdits(LIST(), e2).map((n) => [n.id, n.readAt])).toEqual([[1, 't1'], [3, null]]);
    expect(EMPTY_EDITS).toEqual({ read: {}, deleted: {} });
    expect(e1.deleted).toEqual({});
    const list = LIST();
    applyEdits(list, e2);
    expect(list).toEqual(LIST());
  });

  test('a notification that arrives later is not marked read by an earlier read-all', () => {
    const edits = withRead(EMPTY_EDITS, unreadIds(LIST()), 't'); // read-all over ids 1 and 3
    const later = [...LIST(), { id: 4, title: 'new', readAt: null }];
    expect(applyEdits(later, edits).find((n) => n.id === 4).readAt).toBeNull();
  });
});

describe('unread helpers', () => {
  test('unreadIds and hasUnread', () => {
    expect(unreadIds(LIST())).toEqual([1, 3]);
    expect(hasUnread(LIST())).toBe(true);
    expect(hasUnread(applyEdits(LIST(), withRead(EMPTY_EDITS, [1, 3], 't')))).toBe(false);
    expect(hasUnread([])).toBe(false);
  });
});
