// What a Bitrix24 lead built from the app/portal contains. Pure functions: no network,
// no database. Field codes are this Bitrix account's own (see bitrix-lead.js).
const { buildLeadFields, leadInputFromRequest, leadInputFromCase } = require('../src/modules/bitrix/bitrix-lead');

const request = {
  referenceNumber: 'REQ-1042',
  serviceType: 'Commercial Airlines — Stretcher (CAS)',
  serviceKey: 'commercialair_stretcher',
  patientName: 'Gouri Patil',
  patientAge: 64,
  patientGender: 'Female',
  patientContact: '+91 9876543210',
  origin: 'Mumbai',
  destination: 'Delhi',
  country: 'India',
  preferredDate: new Date('2026-11-02T00:00:00Z'),
  careLevel: 'Basic',
  description: 'Needs oxygen on board',
};
const user = { name: 'Rohan Patil', mobile: '+919000000000', email: 'rohan@example.com' };

describe('Bitrix lead from a patient request', () => {
  const fields = buildLeadFields(leadInputFromRequest(request, user));

  it('looks like the leads Operations make by hand', () => {
    expect(fields.TITLE).toBe('Mumbai to Delhi');
    expect(fields.STATUS_ID).toBe('IN_PROCESS'); // Case in Progress
    expect(fields.SOURCE_ID).toBe('UC_8HLHOF'); // Other
    expect(fields.UF_CRM_1775717843808).toBe(712); // Industry: B2C
    expect(fields.UF_CRM_1781505417891).toEqual([2824]); // Commercial Airline Stretcher (CAS)
  });

  it('puts the account holder as the contact and the patient in the patient fields', () => {
    expect(fields.NAME).toBe('Rohan Patil');
    expect(fields.EMAIL).toEqual([{ VALUE: 'rohan@example.com', VALUE_TYPE: 'WORK' }]);
    expect(fields.PHONE).toEqual([{ VALUE: '+91 9876543210', VALUE_TYPE: 'WORK' }]);
    expect(fields.UF_CRM_1775637387862).toBe('Gouri Patil'); // Patient Name
    expect(fields.UF_CRM_1768195253912).toBe(64); // Patient Age
    expect(fields.UF_CRM_1775637565398).toBe(364); // Gender: Female
    expect(fields.UF_CRM_1768195061660).toBe('REQ-1042'); // Reference No.
    expect(fields.UF_CRM_1775637683789).toBe('2026-11-02'); // Date Of Service
    expect(fields.UF_CRM_1775637732390).toBe('Mumbai'); // Current Location
    expect(fields.UF_CRM_1775637753105).toBe('Delhi'); // Destination Location
    expect(fields.UF_CRM_1768812307305).toBe('Mumbai'); // Pickup City
    expect(fields.UF_CRM_1768812329423).toBe('Delhi'); // Drop City
  });

  it('leaves Current Medical Conditions empty for a patient request: the condition goes in the comment', () => {
    expect(fields.UF_CRM_1784283904).toBeUndefined();
    expect(fields.COMMENTS).toContain('Needs oxygen on board');
  });

  it('keeps the comment to the requirement and care level', () => {
    expect(fields.COMMENTS).toBe('Requirement: Needs oxygen on board\nCare level: Basic');
  });

  it('names the service in the comment only when Required Service cannot', () => {
    const hospital = buildLeadFields(leadInputFromRequest({ ...request, serviceKey: 'hospital', serviceType: 'Hospitalization Assistance' }, user));
    expect(hospital.COMMENTS).toBe('Requirement: Needs oxygen on board\nCare level: Basic\nService: Hospitalization Assistance');
  });

  it.each([['marine', 'Marine Medical Safety'], ['medvalue', 'Medical Value Travel']])('sends %s with no Required Service and names it in the comment, for Operations to pick', (serviceKey, serviceType) => {
    const fields = buildLeadFields(leadInputFromRequest({ ...request, serviceKey, serviceType }, user));
    expect(fields.UF_CRM_1781505417891).toBeUndefined();
    expect(fields.COMMENTS).toBe(`Requirement: Needs oxygen on board\nCare level: Basic\nService: ${serviceType}`);
  });

  it.each([
    ['privatecharter', 2820], ['commercialair_wheelchair', 2826], ['ground', 2830], ['mortal', 2828],
    ['homecare', 2834], ['tele', 2836], ['corporate', 2930],
  ])('maps the app service %s to Bitrix service %i', (serviceKey, id) => {
    expect(buildLeadFields(leadInputFromRequest({ ...request, serviceKey }, user)).UF_CRM_1781505417891).toEqual([id]);
  });

  it('sends no Required Service (and no empty fields) when there is nothing to map', () => {
    const bare = buildLeadFields(leadInputFromRequest({ referenceNumber: 'REQ-1', patientName: 'A B', origin: 'X', destination: 'Y', serviceKey: 'hospital' }, null));
    expect(bare.UF_CRM_1781505417891).toBeUndefined();
    expect(bare.UF_CRM_1775637565398).toBeUndefined();
    expect(bare.EMAIL).toBeUndefined();
    expect(Object.values(bare)).not.toContain(null);
  });
});

describe('Bitrix lead: medical page details', () => {
  const medical = { ...request, serviceKey: 'privatecharter', mobility: 'bedridden', equipOxygen: true, equipCardiacMonitor: true, equipVentilator: false, urgency: 'critical_6h' };

  it('adds mobility, equipment on board and urgency to the comment, and urgency to Transfer Urgency', () => {
    const fields = buildLeadFields(leadInputFromRequest(medical, user));
    expect(fields.COMMENTS).toBe(
      'Requirement: Needs oxygen on board\nCare level: Basic\nMobility: Bedridden\nOn board: Oxygen, Cardiac monitor\nUrgency: Critical (within 6h)',
    );
    expect(fields.UF_CRM_1775637825406).toBe(380); // Transfer Urgency: Urgent
  });

  it('maps a planned request to Transfer Urgency: Planned', () => {
    expect(buildLeadFields(leadInputFromRequest({ ...medical, urgency: 'planned' }, user)).UF_CRM_1775637825406).toBe(382);
  });

  it('says nothing about equipment when none was asked for, and sends no urgency when there is none', () => {
    const fields = buildLeadFields(leadInputFromRequest({ ...medical, equipOxygen: false, equipCardiacMonitor: false, urgency: null }, user));
    expect(fields.COMMENTS).not.toContain('On board');
    expect(fields.COMMENTS).not.toContain('Urgency');
    expect(fields.UF_CRM_1775637825406).toBeUndefined();
  });

  it('adds the report names to the comment', () => {
    const { commentWithReports } = require('../src/modules/bitrix/bitrix-lead');
    expect(commentWithReports('Requirement: x', ['a.pdf', 'b.jpg'])).toBe('Requirement: x\nMedical reports (2): a.pdf, b.jpg');
    expect(commentWithReports('-', ['a.pdf'])).toBe('Medical reports (1): a.pdf');
    expect(commentWithReports('Requirement: x', [])).toBe('Requirement: x');
  });
});

describe('Bitrix lead from a corporate case', () => {
  it('is B2B, carries the urgency, and says it came from the portal', () => {
    const fields = buildLeadFields(leadInputFromCase({
      referenceNumber: 'CASE-7', patientName: 'Asha Rao', patientGender: 'male', origin: 'Pune', destination: 'Dubai',
      urgency: 'critical', serviceType: 'Air Ambulance',
    }));
    expect(fields.TITLE).toBe('Pune to Dubai');
    expect(fields.UF_CRM_1775717843808).toBe(710); // Industry: B2B
    expect(fields.UF_CRM_1775637825406).toBe(380); // Transfer Urgency: Urgent
    expect(fields.UF_CRM_1775637565398).toBe(362); // Gender: Male
    expect(fields.COMMENTS).toBe('Service: Air Ambulance');
  });
});

describe('Bitrix lead from a corporate case: special requirements', () => {
  it('still puts them in Current Medical Conditions', () => {
    const fields = buildLeadFields(leadInputFromCase({
      referenceNumber: 'CASE-9', patientName: 'Asha Rao', origin: 'Pune', destination: 'Dubai', serviceType: 'Air Ambulance',
      specialRequirements: 'Oxygen support',
    }));
    expect(fields.UF_CRM_1784283904).toBe('Oxygen support');
  });
});

describe('Bitrix lead comment with nothing to say', () => {
  it('shows "-" when there is no requirement or care level', () => {
    const fields = buildLeadFields(leadInputFromRequest({ referenceNumber: 'REQ-2', patientName: 'A B', origin: 'X', destination: 'Y', serviceKey: 'mortal' }, null));
    expect(fields.COMMENTS).toBe('-');
  });
});

describe('Bitrix lead from a Mortal Remains request', () => {
  const mortal = {
    referenceNumber: 'REQ-1050',
    serviceType: 'Mortal Remains Transportation — International',
    serviceKey: 'mortal_international',
    patientName: 'Late Ramesh Iyer',
    patientAge: 71,
    patientGender: 'Male',
    patientContact: '+971 501234567',
    origin: 'Dubai',
    destination: 'Chennai',
    preferredDate: new Date('2026-11-01T00:00:00Z'),
    description: 'Transfer to hometown for last rites',
    deceasedRelation: 'Son',
    placeOfDeath: 'Rashid Hospital, Dubai',
    dateOfDeath: new Date('2026-10-27T00:00:00Z'),
  };
  const fields = buildLeadFields(leadInputFromRequest(mortal, user));

  it('puts the name in both Deceased Name and Patient Name, and the account holder as the contact', () => {
    expect(fields.UF_CRM_1780912350541).toBe('Late Ramesh Iyer'); // Deceased Name
    expect(fields.UF_CRM_1775637387862).toBe('Late Ramesh Iyer'); // Patient Name (the deal's "Deceased Name")
    expect(fields.NAME).toBe('Rohan Patil');
    expect(fields.UF_CRM_1781505417891).toEqual([2828]); // Human Mortal Remains (HMR)
    expect(fields.UF_CRM_1775637683789).toBe('2026-11-01'); // Date Of Service = preferred transfer date
  });

  it('notes the transfer type, place and date of death, and a relation Bitrix has no item for', () => {
    expect(fields.UF_CRM_1775637464857).toBeUndefined();
    expect(fields.COMMENTS).toBe([
      'Requirement: Transfer to hometown for last rites',
      'Transfer: International',
      'Relation to the deceased: Son',
      'Place of death: Rashid Hospital, Dubai',
      'Date of death: 2026-10-27',
    ].join('\n'));
  });

  it('uses the Relation list when Bitrix has the relation, and leaves it out of the comment', () => {
    const spouse = buildLeadFields(leadInputFromRequest({ ...mortal, serviceKey: 'mortal_domestic', deceasedRelation: 'Spouse' }, user));
    expect(spouse.UF_CRM_1775637464857).toBe(358); // Spouse
    expect(spouse.COMMENTS).toContain('Transfer: Within India');
    expect(spouse.COMMENTS).not.toContain('Relation');
  });

  it('never makes the deceased the contact when the account has no name', () => {
    expect(buildLeadFields(leadInputFromRequest(mortal, null)).NAME).toBeUndefined();
  });
});
