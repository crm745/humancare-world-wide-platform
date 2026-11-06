// Calendar dates in a given IANA timezone, with no library: Node's built-in Intl knows the zones.

// True for a real IANA zone name that this Node can use ("Asia/Kolkata", not "IST" or "+05:30").
function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim() || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// The calendar date ("YYYY-MM-DD") it is right now, or at `now`, in that timezone. The same
// instant is a different date in different zones: 10 June 03:00 UTC is already 10 June in
// Auckland and still 9 June in Los Angeles, so a country or a UTC offset cannot stand in for the
// city's own zone. Throws for an invalid zone: check isValidTimeZone first.
function todayInTimeZone(timeZone, now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now));
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

module.exports = { isValidTimeZone, todayInTimeZone };
