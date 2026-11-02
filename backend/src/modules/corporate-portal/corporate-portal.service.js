const path = require('path');
const fs = require('fs');
const { prisma } = require('../../db/prisma');
const { UPLOAD_DIR } = require('../../middleware/upload.middleware');
const {
  listNotificationsFor,
  setReadStatus,
  markAllRead,
  deleteNotification,
} = require('../notifications/notifications.service');
const { TICKET_STATUS_LABEL } = require('../../common/constants/ticket.constants');
const { ticketIdFor, ticketDbIdFrom } = require('../../common/utils/ticket-reference');

// Our Notification.kind values don't map 1:1 onto the portal's icon/colour "type"
// categories — this is a reasonable best-effort mapping, not an exact one.
const KIND_TO_TYPE = {
  stage_update: 'case',
  quotation_ready: 'invoice',
  document: 'info',
  system: 'info',
};

function toPortalNotification(n) {
  return {
    id: n.id,
    title: n.title,
    message: n.body,
    type: KIND_TO_TYPE[n.kind] || 'info',
    // We don't store a deep-link target on notifications today, so there's nothing
    // real to put here — the frontend should treat a missing link as "not clickable".
    link: null,
    date: n.createdAt,
    read: !!n.readAt,
  };
}

const DAY_MS = 86400000;
const ALL_STATUSES = ['submitted', 'scheduled', 'in_progress', 'completed', 'cancelled'];
// The web dashboard's labels use its own casing/wording; map our stored values onto them.
const STATUS_LABEL = {
  submitted: 'Submitted',
  scheduled: 'Scheduled',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
const isActive = (status) => status === 'scheduled' || status === 'in_progress';

function rangeStart(range) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  switch (range) {
    case 'today':
      return d;
    case 'week': {
      const day = (d.getDay() + 6) % 7; // Monday-based week
      d.setDate(d.getDate() - day);
      return d;
    }
    case 'month':
      d.setDate(1);
      return d;
    case 'year':
      return new Date(d.getFullYear(), 0, 1);
    case 'all':
      return new Date(0);
    default:
      d.setDate(1);
      return d; // unrecognized range falls back to "month"
  }
}

// Time buckets for the Completed-vs-Pending chart — matches the corporate-portal
// frontend's own bucketing (see corporate-portal/src/services/corporateService.js) so its
// chart components don't need any changes.
function buckets(range) {
  const out = [];
  const start = rangeStart(range);
  const now = Date.now();
  if (range === 'today') {
    for (let h = 0; h < 24; h += 4) {
      const s = new Date(start);
      s.setHours(h);
      out.push({ label: `${String(h).padStart(2, '0')}:00`, start: s.getTime(), end: s.getTime() + 4 * 3600000 });
    }
  } else if (range === 'week' || range === 'month') {
    for (let t = start.getTime(); t <= now; t += DAY_MS) {
      const d = new Date(t);
      out.push({ label: range === 'week' ? d.toLocaleDateString('en-GB', { weekday: 'short' }) : String(d.getDate()), start: t, end: t + DAY_MS });
    }
  } else {
    // 'year' and 'all' both land here — 'all' shows the current year's monthly
    // breakdown rather than every year since inception, matching the "Monthly Cases"
    // trend chart above (which is always a fixed last-12-months view regardless of range).
    const thisYear = new Date().getFullYear();
    for (let m = 0; m <= new Date().getMonth(); m++) {
      const s = new Date(thisYear, m, 1);
      const e = new Date(thisYear, m + 1, 1);
      out.push({ label: s.toLocaleDateString('en-GB', { month: 'short' }), start: s.getTime(), end: e.getTime() });
    }
  }
  return out;
}

// Powers the corporate-portal web dashboard's landing page. Two of the mock-era fields
// (pendingDocuments, outstandingAmount) always come back 0 here — we don't yet track
// a per-document verification status, and there's no Invoice model until the payment
// gateway work happens, so there's nothing real to compute them from.
async function getDashboardStats(corporateId, range) {
  const allCases = await prisma.case.findMany({
    where: { corporateId },
    select: { id: true, status: true, serviceType: true, patientContact: true, patientName: true, createdAt: true, referenceNumber: true, destination: true, origin: true },
    orderBy: { createdAt: 'desc' },
  });

  const from = rangeStart(range).getTime();
  const inRange = allCases.filter((c) => c.createdAt.getTime() >= from);
  const countIn = (status) => inRange.filter((c) => c.status === status).length;

  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const s = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const e = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    months.push({
      label: s.toLocaleDateString('en-GB', { month: 'short' }),
      cases: allCases.filter((c) => c.createdAt.getTime() >= s.getTime() && c.createdAt.getTime() < e.getTime()).length,
    });
  }

  return {
    stats: {
      totalCases: inRange.length,
      activeCases: inRange.filter((c) => isActive(c.status)).length,
      completedCases: countIn('completed'),
      pendingCases: countIn('submitted'),
      // No patient-id foreign key on Case (patientName/patientContact are free text),
      // so this counts distinct non-empty contacts as a reasonable stand-in.
      totalPatients: new Set(inRange.map((c) => c.patientContact).filter(Boolean)).size,
      pendingDocuments: 0,
      outstandingAmount: 0,
    },
    statusBreakdown: ALL_STATUSES.map((status) => ({ status: STATUS_LABEL[status], count: countIn(status) })),
    monthly: months,
    completedVsPending: buckets(range).map((b) => {
      const inBucket = allCases.filter((c) => c.createdAt.getTime() >= b.start && c.createdAt.getTime() < b.end);
      return {
        label: b.label,
        completed: inBucket.filter((c) => c.status === 'completed').length,
        pending: inBucket.filter((c) => c.status === 'submitted' || isActive(c.status)).length,
      };
    }),
    serviceWise: [...new Set(allCases.map((c) => c.serviceType))].map((service) => ({
      service,
      count: inRange.filter((c) => c.serviceType === service).length,
    })),
    recentCases: allCases.slice(0, 6).map((c) => ({
      id: c.referenceNumber,
      patientName: c.patientName,
      service: c.serviceType,
      status: STATUS_LABEL[c.status],
      requestDate: c.createdAt,
      origin: c.origin,
      destination: c.destination,
    })),
  };
}

async function listCorporateNotifications(corporateUserId) {
  const notifications = await listNotificationsFor('corporate_user', corporateUserId);
  return notifications.map(toPortalNotification);
}

async function setCorporateNotificationRead(corporateUserId, id, read) {
  const notification = await setReadStatus('corporate_user', corporateUserId, id, read);
  return toPortalNotification(notification);
}

async function markAllCorporateNotificationsRead(corporateUserId) {
  await markAllRead('corporate_user', corporateUserId);
}

async function deleteCorporateNotification(corporateUserId, id) {
  await deleteNotification('corporate_user', corporateUserId, id);
}

// ---------- patients ----------
// The corporate-portal web app's "patients" are really just the patient-facing view of
// one Case each (confirmed from its own mock data generator, which mints a brand-new
// patient id per case rather than deduplicating by contact) — so there's no separate
// Patient table; the id below is just the Case id wrapped in the display format it
// expects, and is reversible back to a caseId.
function patientIdFor(caseId) {
  return `HCW-PAT-${String(caseId).padStart(5, '0')}`;
}
function caseIdFromPatientId(patientId) {
  const match = /^HCW-PAT-(\d+)$/.exec(String(patientId));
  return match ? Number(match[1]) : null;
}

const URGENCY_TO_CONDITION = { routine: 'Stable', urgent: 'Serious', critical: 'Critical' };

function toPortalPatientSummary(c) {
  return {
    id: patientIdFor(c.id),
    name: c.patientName,
    age: c.patientAge,
    gender: c.patientGender,
    caseId: c.referenceNumber,
    status: STATUS_LABEL[c.status] || c.status,
    service: c.serviceType,
    country: c.country || '—',
  };
}

async function listCorporatePatients(corporateId) {
  const cases = await prisma.case.findMany({ where: { corporateId }, orderBy: { createdAt: 'desc' } });
  return cases.map(toPortalPatientSummary);
}

async function findCaseForPatientId(corporateId, patientId) {
  const caseId = caseIdFromPatientId(patientId);
  if (caseId == null) return null;
  return prisma.case.findFirst({ where: { id: caseId, corporateId } });
}

async function getCorporatePatient(corporateId, patientId) {
  const caseRecord = await findCaseForPatientId(corporateId, patientId);
  if (!caseRecord) {
    const err = new Error('Patient not found.');
    err.statusCode = 404;
    throw err;
  }
  const [documents, communications] = await Promise.all([
    prisma.document.findMany({ where: { caseId: caseRecord.id }, orderBy: { uploadedAt: 'desc' } }),
    prisma.caseCommunication.findMany({ where: { caseId: caseRecord.id }, orderBy: { occurredAt: 'desc' } }),
  ]);

  return {
    id: patientId,
    name: caseRecord.patientName,
    contact: caseRecord.patientContact,
    age: caseRecord.patientAge,
    gender: caseRecord.patientGender,
    caseId: caseRecord.referenceNumber,
    status: STATUS_LABEL[caseRecord.status] || caseRecord.status,
    service: caseRecord.serviceType,
    origin: caseRecord.origin,
    destination: caseRecord.destination,
    country: caseRecord.country,
    condition: URGENCY_TO_CONDITION[caseRecord.urgency] || 'Stable',
    documents: documents.map((d) => ({ id: d.id, type: d.type, name: d.name, uploadedAt: d.uploadedAt, fileSizeBytes: d.fileSizeBytes })),
    communications: communications.map((c) => ({ id: c.id, date: c.occurredAt, channel: c.channel, by: c.authorName, summary: c.summary })),
  };
}

async function addPatientCommunication(corporateId, patientId, { summary, channel, authorName }) {
  const caseRecord = await findCaseForPatientId(corporateId, patientId);
  if (!caseRecord) {
    const err = new Error('Patient not found.');
    err.statusCode = 404;
    throw err;
  }
  const comm = await prisma.caseCommunication.create({
    data: { caseId: caseRecord.id, channel, summary, authorName: authorName || null },
  });
  return { id: comm.id, date: comm.occurredAt, channel: comm.channel, by: comm.authorName, summary: comm.summary };
}

// ---------- support tickets ----------
function toPortalTicket(t) {
  return {
    id: ticketIdFor(t.id),
    subject: t.subject,
    category: t.category,
    priority: t.priority,
    status: TICKET_STATUS_LABEL[t.status] || t.status,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    messages: (t.messages || []).map((m) => ({ id: m.id, from: m.authorRole || 'corporate', author: m.authorName, date: m.createdAt, body: m.body })),
  };
}

async function listCorporateTickets(corporateId) {
  const tickets = await prisma.supportTicket.findMany({
    where: { corporateId },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
    orderBy: { updatedAt: 'desc' },
  });
  return tickets.map(toPortalTicket);
}

async function createCorporateTicket(corporateId, authorName, { subject, category, priority, description }) {
  const ticket = await prisma.supportTicket.create({
    data: {
      corporateId,
      subject,
      category: category || null,
      priority: priority || 'Medium',
      messages: { create: [{ authorName, authorRole: 'corporate', body: description }] },
    },
    include: { messages: true },
  });
  return toPortalTicket(ticket);
}

async function addTicketMessage(corporateId, ticketId, authorName, body) {
  const dbId = ticketDbIdFrom(ticketId);
  const ticket = dbId != null ? await prisma.supportTicket.findFirst({ where: { id: dbId, corporateId } }) : null;
  if (!ticket) {
    const err = new Error('Ticket not found.');
    err.statusCode = 404;
    throw err;
  }
  // Replying to a resolved/closed ticket reopens it — same as the corporate-portal's own mock.
  const nextStatus = ticket.status === 'resolved' || ticket.status === 'closed' ? 'open' : ticket.status;
  const updated = await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: { status: nextStatus, messages: { create: [{ authorName, authorRole: 'corporate', body }] } },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  return toPortalTicket(updated);
}

// ---------- profile & settings ----------
const COMPANY_FIELDS = [
  'companyName', 'registrationNumber', 'companyType', 'country', 'state', 'city', 'address', 'pincode',
  'officialEmail', 'officialPhone', 'website', 'contactName', 'contactDesignation', 'contactEmail', 'contactPhone',
];

function toPortalCompany(v) {
  const out = {};
  for (const key of COMPANY_FIELDS) out[key] = v[key];
  return out;
}

// Matches the corporate-portal's own DEFAULT_SETTINGS (src/data/constants.js) exactly —
// notifications is keyed by category (cases/invoices/documents/account), each with
// its own email/sms/inApp toggles, not a single flat set of channels.
const DEFAULT_SETTINGS = {
  notifications: {
    cases: { email: true, sms: true, inApp: true },
    invoices: { email: true, sms: false, inApp: true },
    documents: { email: true, sms: false, inApp: true },
    account: { email: true, sms: true, inApp: true },
  },
  language: 'English',
  timezone: 'Asia/Kolkata',
  dateFormat: 'DD MMM YYYY',
  twoFactor: false,
};

// Same reference-id style as patientIdFor/ticketIdFor above — a real, deterministic
// formatting of the row's own id, not a fabricated value.
function corporateRefId(id) {
  return `HCW-COR-${String(id).padStart(5, '0')}`;
}

async function getCorporateProfile(corporateId) {
  const corporate = await prisma.corporate.findUnique({ where: { id: corporateId } });
  // Bank details and the verification workflow are deferred along with the
  // self-registration/payments work — no `bank`/`verificationStatus`/`verification` keys
  // at all here rather than fake ones; the frontend treats their absence as "not available yet".
  return {
    corporateId: corporateRefId(corporate.id),
    memberSince: corporate.createdAt,
    company: toPortalCompany(corporate),
  };
}

async function updateCorporateCompany(corporateId, company) {
  const data = {};
  for (const key of COMPANY_FIELDS) if (company[key] !== undefined) data[key] = company[key];
  const corporate = await prisma.corporate.update({ where: { id: corporateId }, data });
  return { company: toPortalCompany(corporate) };
}

async function getCorporateSettings(corporateUserId) {
  const corporateUser = await prisma.corporateUser.findUnique({ where: { id: corporateUserId } });
  return corporateUser?.settings || DEFAULT_SETTINGS;
}

async function updateCorporateSettings(corporateUserId, settings) {
  const updated = await prisma.corporateUser.update({ where: { id: corporateUserId }, data: { settings } });
  return updated.settings;
}

// ---------- search ----------
// Invoices are left out — that collection doesn't exist until the payment gateway
// work happens (see the deferred items noted throughout this file).
async function searchCorporate(corporateId, query) {
  const q = (query || '').trim();
  if (q.length < 2) return [];

  const cases = await prisma.case.findMany({
    where: { corporateId, OR: [{ referenceNumber: { contains: q } }, { patientName: { contains: q } }] },
    take: 6,
  });

  const caseResults = cases.slice(0, 5).map((c) => ({
    kind: 'case', id: c.referenceNumber, title: c.referenceNumber,
    subtitle: `${c.patientName} · ${c.serviceType}`, to: `/cases/${c.referenceNumber}`,
  }));
  const patientResults = cases.slice(0, 4).map((c) => ({
    kind: 'patient', id: patientIdFor(c.id), title: c.patientName,
    subtitle: `${patientIdFor(c.id)} · ${c.serviceType}`, to: `/patients/${patientIdFor(c.id)}`,
  }));
  return [...caseResults, ...patientResults];
}

// Company-level compliance documents (registration cert, GST, PAN, etc.) — see
// CorporateDocument in schema.prisma for why there's no status/verification field.
async function listCorporateDocuments(corporateId) {
  return prisma.corporateDocument.findMany({ where: { corporateId }, orderBy: { uploadedAt: 'desc' } });
}

async function addCorporateDocument(corporateId, { type, name, fileUrl, fileSizeBytes }) {
  return prisma.corporateDocument.create({
    data: { corporateId, type, name, fileUrl, fileSizeBytes: fileSizeBytes || null },
  });
}

async function getCorporateDocumentForDownload(corporateId, documentId) {
  const doc = await prisma.corporateDocument.findUnique({ where: { id: Number(documentId) } });
  if (!doc || doc.corporateId !== corporateId) {
    const err = new Error('Document not found');
    err.statusCode = 404;
    throw err;
  }
  return doc;
}

async function deleteCorporateDocument(corporateId, documentId) {
  const doc = await getCorporateDocumentForDownload(corporateId, documentId);
  await prisma.corporateDocument.delete({ where: { id: doc.id } });
  // Best-effort — a file already missing from disk shouldn't block the DB delete.
  fs.unlink(path.join(UPLOAD_DIR, path.basename(doc.fileUrl)), () => {});
}

module.exports = {
  getDashboardStats,
  listCorporateNotifications,
  setCorporateNotificationRead,
  markAllCorporateNotificationsRead,
  deleteCorporateNotification,
  listCorporatePatients,
  getCorporatePatient,
  addPatientCommunication,
  listCorporateTickets,
  createCorporateTicket,
  addTicketMessage,
  getCorporateProfile,
  updateCorporateCompany,
  getCorporateSettings,
  updateCorporateSettings,
  searchCorporate,
  listCorporateDocuments,
  addCorporateDocument,
  getCorporateDocumentForDownload,
  deleteCorporateDocument,
};
