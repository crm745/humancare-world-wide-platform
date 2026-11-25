// The Notifications screen's list state, as pure functions. The list a screen shows is what the server sent plus the changes the
// patient made that the server has CONFIRMED (a read, a delete): `edits` only ever holds those, so the screen never shows a read or
// a delete that did not happen.
//
// edits: { read: { [id]: ISO time }, deleted: { [id]: true } }
export const EMPTY_EDITS = Object.freeze({ read: Object.freeze({}), deleted: Object.freeze({}) });

export function applyEdits(list, edits = EMPTY_EDITS) {
  return list
    .filter((n) => !edits.deleted[n.id])
    .map((n) => (!n.readAt && edits.read[n.id] ? { ...n, readAt: edits.read[n.id] } : n));
}

export const isUnread = (n) => !n.readAt;
export const unreadIds = (list) => list.filter(isUnread).map((n) => n.id);
export const hasUnread = (list) => list.some(isUnread);

export function withRead(edits, ids, at) {
  const read = { ...edits.read };
  for (const id of ids) read[id] = at;
  return { ...edits, read };
}

export function withDeleted(edits, id) {
  return { ...edits, deleted: { ...edits.deleted, [id]: true } };
}
