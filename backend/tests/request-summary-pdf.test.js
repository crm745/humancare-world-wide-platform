// A date-only value (preferred date, date of death) must print as its own calendar day in the
// request summary PDF whatever timezone the server runs in. Before the fix the PDF used
// toDateString(), which reads the server's local time: on a server west of UTC a request for
// 10 November printed "Mon Nov 09 2026". No database needed.
//
// Every timezone-sensitive check runs in a child process that really has that TZ (Jest cannot
// change the timezone from inside a test: see helpers/in-timezone.js).
const { inTimeZone } = require('./helpers/in-timezone');
const { renderPdfLines, valueAfter } = require('./helpers/pdf-text');
const { formatDateOnly } = require('../src/modules/requests/request-summary.pdf');

const ZONES = ['UTC', 'America/Los_Angeles', 'Pacific/Pago_Pago', 'Pacific/Auckland', 'Pacific/Kiritimati', 'Asia/Kolkata'];

const baseRequest = {
  referenceNumber: 'REQ-1001', serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter',
  patientName: 'Maria Fernandez', origin: 'Mumbai, Maharashtra, India', destination: 'Dubai, United Arab Emirates',
  status: 'submitted', createdAt: '2031-01-01T10:00:00.000Z', case: null,
};

const renderIn = (zone, request) => inTimeZone(
  zone,
  "require('./tests/helpers/pdf-text').renderPdfLines(JSON.parse(process.argv[1])).then((lines) => console.log(JSON.stringify(lines)))",
  [JSON.stringify(request)],
);

describe('formatDateOnly', () => {
  it.each(ZONES)('prints the stored calendar day in the old layout when the server runs in %s', (zone) => {
    const out = inTimeZone(zone, "const { formatDateOnly } = require('./src/modules/requests/request-summary.pdf'); console.log(JSON.stringify(formatDateOnly(new Date('2026-11-10T00:00:00.000Z'))))");
    expect(out).toBe('Tue Nov 10 2026');
  });

  it('is what the old code got wrong: toDateString() moves the day on a server west of UTC', () => {
    const out = inTimeZone('America/Los_Angeles', "const d = new Date('2026-11-10T00:00:00.000Z'); console.log(JSON.stringify({ old: d.toDateString(), offset: d.getTimezoneOffset() }))");
    expect(out.offset).toBeGreaterThan(0); // the child really is west of UTC
    expect(out.old).toBe('Mon Nov 09 2026');
  });

  it('pads the day, handles month and year ends, and a leap day', () => {
    expect(formatDateOnly(new Date('2026-12-03T00:00:00.000Z'))).toBe('Thu Dec 03 2026');
    expect(formatDateOnly(new Date('2026-12-31T00:00:00.000Z'))).toBe('Thu Dec 31 2026');
    expect(formatDateOnly(new Date('2027-01-01T00:00:00.000Z'))).toBe('Fri Jan 01 2027');
    expect(formatDateOnly(new Date('2028-02-29T00:00:00.000Z'))).toBe('Tue Feb 29 2028');
  });

  it('accepts an ISO string too, and gives null for nonsense', () => {
    expect(formatDateOnly('2026-11-10T00:00:00.000Z')).toBe('Tue Nov 10 2026');
    expect(formatDateOnly('not a date')).toBeNull();
  });
});

describe('the request summary PDF', () => {
  it.each(ZONES)('prints the preferred date as the day that was chosen when the server runs in %s', (zone) => {
    const lines = renderIn(zone, { ...baseRequest, preferredDate: '2026-11-10T00:00:00.000Z' });
    expect(valueAfter(lines, 'Date Of Service:')).toBe('Tue Nov 10 2026');
  });

  it('prints the date of death and the transfer date of a mortal remains request as the stored days', () => {
    const lines = renderIn('America/Los_Angeles', {
      ...baseRequest, serviceKey: 'mortal_domestic', dateOfDeath: '2026-10-20T00:00:00.000Z', preferredDate: '2026-10-25T00:00:00.000Z',
    });
    expect(valueAfter(lines, 'Date of death:')).toBe('Tue Oct 20 2026');
    expect(valueAfter(lines, 'Preferred transfer date:')).toBe('Sun Oct 25 2026');
  });

  it('leaves the other lines as they were, and leaves the date line out when there is no date', () => {
    const lines = renderIn('UTC', { ...baseRequest, preferredDate: null });
    expect(lines).not.toContain('Date Of Service:');
    expect(valueAfter(lines, 'From:')).toBe('Mumbai, Maharashtra, India');
    expect(valueAfter(lines, 'To:')).toBe('Dubai, United Arab Emirates');
    expect(valueAfter(lines, 'Patient Name:')).toBe('Maria Fernandez');
  });

  it('renders in this process too (the helper itself works)', async () => {
    const lines = await renderPdfLines({ ...baseRequest, preferredDate: new Date('2026-11-10T00:00:00.000Z') });
    expect(valueAfter(lines, 'Date Of Service:')).toBe('Tue Nov 10 2026');
  });
});
