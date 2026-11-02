function ticketIdFor(id) {
  return `HCW-TKT-${String(id).padStart(5, '0')}`;
}
function ticketDbIdFrom(ticketId) {
  const match = /^HCW-TKT-(\d+)$/.exec(String(ticketId));
  return match ? Number(match[1]) : null;
}

module.exports = { ticketIdFor, ticketDbIdFrom };
