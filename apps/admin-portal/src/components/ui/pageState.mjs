// Paging arithmetic for <Pagination>. `total` is optional: the list API may not report one, in
// which case "is there a next page" is inferred from the page coming back full.
export function pageState({ total, limit, offset, count }) {
  const hasTotal = Number.isInteger(total) && total >= 0;
  const from = count > 0 ? offset + 1 : 0;
  const to = offset + count;
  const hasPrev = offset > 0;
  const hasNext = hasTotal ? to < total : count >= limit;
  return {
    hasTotal, from, to, hasPrev, hasNext,
    prevOffset: Math.max(offset - limit, 0),
    nextOffset: offset + limit,
    page: Math.floor(offset / limit) + 1,
    pages: hasTotal ? Math.max(Math.ceil(total / limit), 1) : null,
  };
}
