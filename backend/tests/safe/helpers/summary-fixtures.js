// Synthetic requests for the request summary PDF tests: one for each of the eight patient services (Private Charter and Commercial Air are two of the services' key variants, so ten rows in all),
// shaped exactly as the database stores them. The five services with their own validators are built BY those validators (the real stored shape, descriptions and columns included); the rest are
// written out. Nothing here is real: names, numbers and addresses are invented. Every request also carries SENTINEL values in the columns a patient must never see printed, so a test can prove they
// never reach a PDF.
const R = (file) => require(`../../../src/modules/requests/${file}`);

const NOW = new Date('2026-11-18T12:00:00.000Z');
const CREATED = '2026-11-20T09:15:00.000Z';

// Values that must NEVER appear in a document (internal columns and private paths).
const SECRETS = Object.freeze({
  userId: 98765431,
  bitrixLeadId: 7766554,
  bitrixLastError: 'SECRET-CRM-ERROR-TEXT',
  bitrixSyncAttempts: 4,
  clientRequestId: '3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c',
  fileUrl: '/uploads/PRIVATE-STORAGE-PATH.pdf',
  storageKey: 'STORAGE-KEY-ABC123',
  sha256: 'f00dfeedf00dfeedf00dfeedf00dfeedf00dfeedf00dfeedf00dfeedf00dfeed',
  scanDetail: 'SECRET-SCAN-DETAIL',
  uploadedByUserId: 98765432,
});
const SECRET_TEXTS = ['SECRET-CRM-ERROR-TEXT', 'PRIVATE-STORAGE-PATH', 'STORAGE-KEY-ABC123', 'f00dfeedf00dfeed', 'SECRET-SCAN-DETAIL', '3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c', '7766554', '98765431', '98765432'];

const documents = (names = ['discharge-summary.pdf', 'ct-scan.jpg']) => names.map((name, i) => ({
  id: 10 + i, type: 'Medical Report', name, fileSizeBytes: 480000 + i * 1900000, uploadedAt: '2026-11-20T09:20:00.000Z',
  fileUrl: SECRETS.fileUrl, sha256: SECRETS.sha256, scanDetail: SECRETS.scanDetail, storageKey: SECRETS.storageKey,
}));

function wrap(data, extra = {}) {
  return {
    id: 1,
    referenceNumber: 'REQ-1042',
    status: 'in_progress',
    createdAt: CREATED,
    userId: SECRETS.userId,
    bitrixLeadId: SECRETS.bitrixLeadId,
    bitrixLastError: SECRETS.bitrixLastError,
    bitrixSyncAttempts: SECRETS.bitrixSyncAttempts,
    clientRequestId: SECRETS.clientRequestId,
    ...data,
    case: {
      id: 5, referenceNumber: 'REQ-1042', status: 'in_progress', documents: documents(),
      stageEvents: [
        { stage: 'submitted', note: 'Request received from patient app.', occurredAt: CREATED },
        { stage: 'in_progress', note: null, occurredAt: '2026-11-21T08:00:00.000Z' },
      ],
    },
    requestDocuments: [],
    ...extra,
  };
}

function built(validated, label) {
  if (validated.error) throw new Error(`the ${label} fixture is not valid any more: ${validated.error}`);
  return validated.data;
}

function services() {
  const out = {};
  out.privatecharter = wrap({
    serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', patientName: 'Maria Fernandez', patientAge: 61, patientGender: 'Female', patientContact: '+971 50 123 4567',
    country: 'AE', origin: 'Mumbai, Maharashtra, India', destination: 'Dubai, United Arab Emirates', preferredDate: new Date('2026-12-05T00:00:00.000Z'), urgency: 'urgent_24h', careLevel: 'care_icu',
    mobility: 'bedridden', description: 'Post-surgical patient, needs ICU level transfer with a physician on board.', equipOxygen: true, equipOxygenLpm: 4,
  });
  out.commercialair = wrap({
    serviceType: 'Medical Escort (Commercial Airlines) — Stretcher (CAS)', serviceKey: 'commercialair_stretcher', patientName: 'John Doe', patientAge: 70, patientGender: 'Male',
    patientContact: '+91 98765 43210', origin: 'Mumbai', destination: 'Dubai', preferredDate: new Date('2026-12-01T00:00:00.000Z'), careLevel: 'crit_ventilated', equipOxygen: true, equipOxygenLpm: 3,
    equipCardiacMonitor: true, urgency: 'planned', description: 'Needs a medical escort on the flight.',
  });
  out.ground = wrap({
    serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: 'Ravi Kumar', patientAge: 55, patientGender: 'Male', patientContact: '+91 98765 11111', origin: 'Flat 4B, Rose Villa, Pune',
    destination: 'Ruby Hall Clinic, Pune', preferredDate: new Date('2026-11-25T00:00:00.000Z'), careLevel: 'crit_icu', equipOxygen: true, equipOxygenLpm: 3, urgency: 'critical_6h',
    description: 'Present medical issue: chest pain since morning.',
  });
  out.tele = wrap(built(R('tele-consultation.validation').validateTeleRequest({
    serviceType: 'Tele Consultation & House Call', serviceKey: 'tele', consultationScope: 'domestic', consultationType: 'house_call', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female',
    country: 'India', patientContact: '+91 98765 43210', currentAddress: 'Flat 4B, Rose Villa\nMG Road, Pune', presentMedicalIssue: 'Fever and cough for three days.', allergyDetails: 'Penicillin.',
    preferredDate: '2026-12-01', utcOffsetMinutes: 330,
  }, { now: NOW }), 'Teleconsultation'), { case: { id: 5, status: 'in_progress', documents: [], stageEvents: [] } });
  out.homecare = wrap(built(R('home-healthcare.validation').validateHomeRequest({
    serviceType: 'Home Healthcare Services', serviceKey: 'homecare', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', country: 'India', patientContact: '+91 98765 43210',
    homeAddress: 'Flat 4B, Rose Villa\nMG Road, Pune 411001', preferredDate: '2026-12-01', utcOffsetMinutes: 330, caretakerTypes: ['nurse'], careRequirement: '12_hours', careLevel: 'full_icu',
    equipOxygen: true, equipOxygenLpm: 3, medicalHistory: 'Diabetes and hypertension.',
  }, { now: NOW }), 'Home Healthcare'));
  out.mortal = wrap(built(R('mortal-remains.validation').validateMortalRequest({
    serviceType: 'Mortal Remains Transportation', serviceKey: 'mortal', transferScope: 'international', transportMode: 'private_charter', patientName: 'Suresh Kale', patientAge: 70, patientGender: 'Male',
    deceasedRelation: 'Brother', placeOfDeath: 'Rashid Hospital, Dubai', dateOfDeath: '2026-11-15', country: 'India', origin: 'Dubai, United Arab Emirates', destination: 'Pune, India',
    patientContact: '+91 98765 43210', preferredDate: '2026-11-20', urgency: 'urgent_24h', utcOffsetMinutes: 330, details: 'Family travels along.',
  }, { now: NOW }), 'Mortal Remains'));
  out.corporate = wrap(built(R('corporate-medical.validation').validateCorporateRequest({
    serviceType: 'Corporate Medical Solutions', serviceKey: 'corporate', companyName: 'Acme Industries Pvt Ltd', employeeCount: 250, patientName: 'Asha Nair', patientGender: 'Female',
    programmes: ['doctor', 'nurse'], patientContact: '+91 98765 43210', preferredDate: '2026-12-01', utcOffsetMinutes: 330, officeAddress: 'Plot 14, Andheri East,\nMumbai 400069', officeCountry: 'IN',
    anyRequirement: 'Annual checkups.', specialRequirement: 'Weekend slots.',
  }, { now: NOW }), 'Corporate Medical Solutions'), { case: { id: 5, status: 'in_progress', documents: [], stageEvents: [] } });
  out.marine = wrap(built(R('marine-medical-safety.validation').validateMarineRequest({
    serviceType: 'Marine Medical Safety', serviceKey: 'marine', serviceScope: 'international', patientName: 'Kiran Patel', patientAge: 38, patientGender: 'Male', country: 'IN',
    patientContact: '+91 98765 22222', originCity: { text: 'Port of Mumbai' }, destinationCity: { text: 'Port of Singapore' }, preferredDate: '2026-12-10', utcOffsetMinutes: 330, careLevel: 'crit_icu',
    equipOxygen: true, equipOxygenLpm: 4, medicalHistory: 'Crew member with a deck injury.',
  }, { now: NOW, cities: {} }), 'Marine Medical Safety'));
  out.medvalue = wrap(built(R('medical-value-travel.validation').validateMvtRequest({
    serviceType: 'Medical Value Travel', serviceKey: 'medvalue', treatmentScope: 'international', patientName: 'Sunita Rao', patientAge: 52, patientGender: 'Female', country: 'IN',
    patientContact: '+91 98765 33333', currentCity: { text: 'Hyderabad' }, destinationCity: { text: 'Singapore' }, specialty: 'Oncology', preferredDate: '2026-12-10', utcOffsetMinutes: 330,
    medicalHistory: 'Needs a second opinion on the treatment plan.',
  }, { now: NOW, cities: {} }), 'Medical Value Travel'));
  return out;
}

// The services by the name used in the task: the eight patient services (Air Ambulance is Private Charter and Commercial Air).
const EIGHT = Object.freeze({
  'Air Ambulance (Private Charter)': 'privatecharter',
  'Air Ambulance (Commercial Air)': 'commercialair',
  Teleconsultation: 'tele',
  'Home Healthcare': 'homecare',
  'Ground Ambulance': 'ground',
  'Mortal Remains': 'mortal',
  'Corporate Medical Solutions': 'corporate',
  'Marine Medical Safety': 'marine',
  'Medical Value Travel': 'medvalue',
});

module.exports = { NOW, CREATED, SECRETS, SECRET_TEXTS, EIGHT, services, wrap, documents };
