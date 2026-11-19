// What Bitrix24 receives for a NEW-format Home Healthcare request, through its existing, UNCHANGED lead builder (a pure function: no network, no database, and no
// live lead is ever created here). The builder reads the stored request as it always did; this only pins what that produces for the composed description.
const { buildLeadFields, leadInputFromRequest, commentWithReports, REQUIRED_SERVICE_BY_KEY } = require('../src/modules/bitrix/bitrix-lead');
const { validateHomeRequest, HOME_SERVICE_TYPE } = require('../src/modules/requests/home-healthcare.validation');

const FIELD = {
  REQUIRED_SERVICE: 'UF_CRM_1781505417891', DATE_OF_SERVICE: 'UF_CRM_1775637683789', PICKUP_CITY: 'UF_CRM_1768812307305', DROP_CITY: 'UF_CRM_1768812329423',
  CURRENT_LOCATION: 'UF_CRM_1775637732390', DESTINATION_LOCATION: 'UF_CRM_1775637753105', TRANSFER_URGENCY: 'UF_CRM_1775637825406', INDUSTRY: 'UF_CRM_1775717843808',
};
const NOW = new Date('2026-11-17T12:00:00.000Z');
const body = (extra = {}) => ({
  serviceType: HOME_SERVICE_TYPE, serviceKey: 'homecare', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', country: 'India', patientContact: '+91 98765 43210',
  homeAddress: 'Flat 4B, Rose Villa  \r\nMG Road, Pune 411001\n', preferredDate: '2026-11-20', utcOffsetMinutes: 330, ...extra,
});
// A stored request as createRequest would store it: what the validator returned, plus the columns the database adds.
const stored = (extra = {}) => {
  const { data, error } = validateHomeRequest(body(extra), { now: NOW });
  expect(error).toBeUndefined();
  return { referenceNumber: 'REQ-1100', urgency: null, mobility: null, equipCardiacMonitor: null, equipVentilator: null, ...data, preferredDate: new Date(`${data.preferredDate}T00:00:00Z`) };
};
const lead = (row) => buildLeadFields(leadInputFromRequest(row, { name: 'Asha Nair', mobile: '+919876543210', email: 'asha@example.com' }));

describe('the existing integration is what it was', () => {
  it('Home Healthcare is still service 2834 under the key "homecare"', () => {
    expect(REQUIRED_SERVICE_BY_KEY.homecare).toBe(2834);
    expect(lead(stored())[FIELD.REQUIRED_SERVICE]).toEqual([2834]);
  });
  it('the lead is the generic one: the title is "<origin> to <destination>" (so "<address> to " with no destination), B2C, no urgency, no destination fields', () => {
    const row = stored();
    const fields = lead(row);
    expect(fields.TITLE).toBe('Flat 4B, Rose Villa, MG Road, Pune 411001 to ');
    expect(fields[FIELD.INDUSTRY]).toBe(712);
    expect(fields[FIELD.PICKUP_CITY]).toBe(row.origin);
    expect(fields[FIELD.CURRENT_LOCATION]).toBe(row.origin);
    expect(fields[FIELD.DATE_OF_SERVICE]).toBe('2026-11-20');
    for (const key of [FIELD.DROP_CITY, FIELD.DESTINATION_LOCATION, FIELD.TRANSFER_URGENCY]) expect(fields).not.toHaveProperty(key);
    expect(fields.COMMENTS).not.toMatch(/Urgency:/);
    expect(fields.COMMENTS).not.toMatch(/Service:/); // the service is mapped, so it is not spelled out
  });
});

describe('the Requirement line carries the composed description, unchanged', () => {
  it('forwards it exactly, header first, patient text byte for byte', () => {
    const row = stored({ caretakerTypes: ['nurse', 'caretaker'], careRequirement: '12_hours', careLevel: 'full_icu', equipOxygen: true, equipOxygenLpm: 4, medicalHistory: 'Post-op.\n\nNeeds wound care \u{1F3E5}' });
    const fields = lead(row);
    expect(fields.COMMENTS.startsWith(`Requirement: ${row.description}`)).toBe(true);
    expect(fields.COMMENTS.startsWith('Requirement: Home Healthcare v1 (address 44, history 29)\n')).toBe(true);
    expect(fields.COMMENTS).toContain('Complete home address:\nFlat 4B, Rose Villa  \r\nMG Road, Pune 411001\n\nMedical History:\nPost-op.\n\nNeeds wound care \u{1F3E5}');
    // the description no longer carries the care lines (they are in columns); the builder's own fixed lines still say the care level and the oxygen. NOTE: the
    // caretaker types and the care requirement are therefore no longer in the lead's comments (the builder does not read those two columns).
    expect(fields.COMMENTS).not.toMatch(/Nurse|Care Requirement/);
    expect(fields.COMMENTS.endsWith('\nCare level: Full ICU\nOn board: Oxygen')).toBe(true);
  });
  it('Oxygen No: no "On board" line; nothing answered: only the header and the address', () => {
    const no = lead(stored({ equipOxygen: false, careLevel: 'semi_icu' }));
    expect(no.COMMENTS).toContain('\nCare level: Semi ICU');
    expect(no.COMMENTS).not.toContain('On board');
    const none = lead(stored());
    expect(none.COMMENTS).toBe(`Requirement: ${stored().description}`);
    expect(none.COMMENTS).not.toMatch(/Care level|On board|Nurse|Oxygen/);
  });
  it('the header line is the first line of the Requirement (Operations see it; the note tells them to ignore it)', () => {
    const firstLine = lead(stored()).COMMENTS.split('\n')[0];
    expect(firstLine).toMatch(/^Requirement: Home Healthcare v1 \(address \d+, history \d+\)$/);
  });
  it('a retry rebuilds exactly the same lead from the stored request', () => {
    const row = stored({ caretakerTypes: ['nurse'], medicalHistory: 'x' });
    expect(lead({ ...row })).toEqual(lead(row));
  });
  it('the medical reports still go through the existing comment helper', () => {
    const fields = lead(stored());
    expect(commentWithReports(fields.COMMENTS, ['discharge.pdf', 'rx.pdf'])).toBe(`${fields.COMMENTS}\nMedical reports (2): discharge.pdf, rx.pdf`);
  });
});

describe('other services are not affected by the new format', () => {
  it('the same builder still gives a Ground Ambulance request its own lines', () => {
    const fields = buildLeadFields(leadInputFromRequest({
      referenceNumber: 'REQ-9', patientName: 'A B', origin: 'Pune', destination: 'Mumbai', serviceKey: 'ground', description: 'Needs oxygen', urgency: 'planned', preferredDate: new Date('2026-11-20T00:00:00Z'),
    }, { name: 'A' }));
    expect(fields.TITLE).toBe('Pune to Mumbai');
    expect(fields.COMMENTS).toBe('Requirement: Needs oxygen\nUrgency: Planned');
    expect(fields[FIELD.REQUIRED_SERVICE]).toEqual([2830]);
  });
});
