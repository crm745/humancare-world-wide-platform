// Date formatting shared by the request pages. Missing or invalid values read as an em dash.
const date = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
const dateTime = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
// A calendar day stored at 00:00 UTC (preferredDate): show that day, never a timezone-shifted one.
const calendarDay = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

function format(formatter, value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : formatter.format(d);
}

export const formatDate = (value) => format(date, value);
export const formatDateTime = (value) => format(dateTime, value);
export const formatCalendarDay = (value) => format(calendarDay, value);
