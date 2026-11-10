const {
  loginAdmin,
  listAdmins,
  listCorporates,
  createCorporate,
  createCorporateUser,
  listAllCases,
  reassignCase,
  listBillableCases,
  updateCaseBilling,
  searchPatients,
  VALID_TICKET_STATUSES,
  listAllTickets,
  getTicketById,
  replyToTicket,
  updateTicketStatus,
} = require('./admin.service');
const {
  listPendingRegistrations,
  getRegistrationForAdmin,
  approveRegistration,
  rejectRegistration,
  provisionOwner,
  sendMobileVerificationLink,
  reviewContactEmail,
  getRegistrationDocument,
} = require('../corporate-registration/registration-review.service');
const { passwordProblem } = require('../auth/auth.service');
const { recordAuditEvent, ACTOR } = require('../../common/audit/audit-log');
const { updateCaseStage, getCaseById, VALID_CASE_STATUSES } = require('../cases/cases.service');
const { prisma } = require('../../db/prisma');
const path = require('path');
const { UPLOAD_DIR } = require('../../middleware/upload.middleware');

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
    const result = await loginAdmin(email, password);
    if (!result) return res.status(401).json({ error: 'Invalid credentials' });
    // The admin portal (admin.html) never reads result.token — it relies on this
    // httpOnly cookie instead, so a compromised script on the page can't read the
    // session out of localStorage. The token is still returned in the body too, for
    // the test suite and any other API client that authenticates via header instead.
    res.cookie('hc_admin_token', result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 15 * 60 * 1000, // matches the access token's own 15-minute lifetime
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function me(req, res, next) {
  try {
    // adminRole and corporateReview are re-read from the admin's current DB record, not
    // the JWT, so a deleted admin loses access immediately and a changed role or grant
    // applies without a fresh login. Superadmins are always corporate reviewers.
    const record = await prisma.adminUser.findUnique({
      where: { id: Number(req.user.id) },
      select: { role: true, corporateReview: true },
    });
    if (!record) return res.status(401).json({ error: 'Invalid token' });
    const corporateReview = record.role === 'superadmin' || record.corporateReview === true;
    // An explicit allowlist, not the whole of req.user: the session id is never sent to the client.
    res.json({
      ok: true,
      admin: { id: req.user.id, role: req.user.role, corporateId: req.user.corporateId, adminRole: record.role, corporateReview },
    });
  } catch (err) {
    next(err);
  }
}

async function getAdmins(req, res, next) {
  try {
    const admins = await listAdmins();
    res.json({ admins });
  } catch (err) {
    next(err);
  }
}

// ---- corporate registrations ----
// All of these run behind requireCorporateReviewer, which puts the verified Admin
// ({ id, role }) on req.admin. Every change below is recorded against that individual Admin.
const auditAdmin = (req, event, registrationId, detail) =>
  recordAuditEvent(req, event, { actorType: ACTOR.ADMIN, actorId: req.admin.id, subject: `registration:${registrationId}`, detail });

async function getPendingRegistrations(req, res, next) {
  try {
    const registrations = await listPendingRegistrations(req.admin);
    res.json({ registrations });
  } catch (err) {
    next(err);
  }
}

async function getRegistration(req, res, next) {
  try {
    res.json({ registration: await getRegistrationForAdmin(req.params.id, req.admin) });
  } catch (err) {
    next(err);
  }
}

async function postApproveRegistration(req, res, next) {
  try {
    const registration = await approveRegistration(req.params.id, req.admin);
    auditAdmin(req, 'registration_approved', registration.id);
    res.json({ registration });
  } catch (err) {
    next(err);
  }
}

async function postRejectRegistration(req, res, next) {
  try {
    const registration = await rejectRegistration(req.params.id, req.admin, req.body?.reason);
    auditAdmin(req, 'registration_rejected', registration.id);
    res.json({ registration });
  } catch (err) {
    next(err);
  }
}

// Creates the company and its initial Owner from an approved registration. The temporary
// password is in this response only — it is never stored in clear or written to a log.
async function postProvisionRegistration(req, res, next) {
  try {
    const { registration, email, temporaryPassword } = await provisionOwner(req.params.id, req.admin);
    auditAdmin(req, 'registration_provisioned', registration.id, { corporateId: registration.corporateDbId });
    res.status(201).json({ registration, credentials: { email, temporaryPassword } });
  } catch (err) {
    next(err);
  }
}

async function postSendMobileLink(req, res, next) {
  try {
    const result = await sendMobileVerificationLink(req.params.id, req.admin);
    auditAdmin(req, 'registration_mobile_link_sent', Number(req.params.id));
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function postReviewContactEmail(req, res, next) {
  try {
    const { action, email, reason } = req.body || {};
    const registration = await reviewContactEmail(req.params.id, req.admin, { action, email, reason });
    auditAdmin(req, 'registration_email_reviewed', registration.id, { action, reason: String(reason).trim().slice(0, 500) });
    res.json({ registration });
  } catch (err) {
    next(err);
  }
}

// Registration documents are never served as static files (same reasoning as every
// other upload in this app) — a reviewer has to be authenticated to open one, the bank
// proof only a superadmin, and each download is recorded against the Admin who made it.
async function downloadRegistrationDocument(req, res, next) {
  try {
    const doc = await getRegistrationDocument(req.params.id, req.params.key, req.admin);
    auditAdmin(req, 'registration_document_downloaded', Number(req.params.id), { key: req.params.key });
    res.download(path.join(UPLOAD_DIR, path.basename(doc.fileUrl)), doc.fileName, { dotfiles: 'allow' });
  } catch (err) {
    next(err);
  }
}

async function getCorporates(req, res, next) {
  try {
    const corporates = await listCorporates();
    res.json({ corporates });
  } catch (err) {
    next(err);
  }
}

async function postCorporate(req, res, next) {
  try {
    const { companyName, type } = req.body;
    if (!companyName || !type) return res.status(400).json({ error: 'companyName and type are required' });
    const corporate = await createCorporate({ companyName, type });
    res.status(201).json({ corporate });
  } catch (err) {
    next(err);
  }
}

async function postCorporateUser(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    const corporateUser = await createCorporateUser(req.params.id, { email, password });
    recordAuditEvent(req, 'corporate_login_added', {
      actorType: ACTOR.ADMIN,
      actorId: req.user.id,
      subject: `corporate:${req.params.id}`,
      detail: { corporateUserId: corporateUser.id },
    });
    res.status(201).json({ corporateUser });
  } catch (err) {
    next(err);
  }
}

async function getCases(req, res, next) {
  try {
    const cases = await listAllCases({ status: req.query.status, corporateId: req.query.corporateId });
    res.json({ cases });
  } catch (err) {
    next(err);
  }
}

// Unlike the corporate-facing getCase, admin can view any case regardless of which
// corporate it belongs to — no ownership check.
async function getCase(req, res, next) {
  try {
    const caseRecord = await getCaseById(req.params.id);
    res.json({ case: caseRecord });
  } catch (err) {
    next(err);
  }
}

async function patchCaseAssign(req, res, next) {
  try {
    const { corporateId } = req.body;
    if (!corporateId) return res.status(400).json({ error: 'corporateId is required' });
    const caseRecord = await reassignCase(req.params.id, corporateId);
    res.json({ case: caseRecord });
  } catch (err) {
    next(err);
  }
}

async function getBilling(req, res, next) {
  try {
    const cases = await listBillableCases({ status: req.query.status });
    res.json({ cases });
  } catch (err) {
    next(err);
  }
}

async function patchCaseBilling(req, res, next) {
  try {
    const { amount, currency, status, notes } = req.body;
    const caseRecord = await updateCaseBilling(req.params.id, { amount, currency, status, notes });
    res.json({ case: caseRecord });
  } catch (err) {
    next(err);
  }
}

async function getPatients(req, res, next) {
  try {
    const patients = await searchPatients(req.query.search);
    res.json({ patients });
  } catch (err) {
    next(err);
  }
}

// Manual stand-in for the Bitrix24 stage-change webhook until that's wired up —
// lets admin/ops move a case's stage from here in the meantime. See cases.service.js.
async function patchCaseStage(req, res, next) {
  try {
    const { stage, note } = req.body;
    if (!stage) return res.status(400).json({ error: `stage is required. Use one of: ${VALID_CASE_STATUSES.join(', ')}` });
    const caseRecord = await updateCaseStage(req.params.id, stage, note);
    res.json({ case: caseRecord });
  } catch (err) {
    next(err);
  }
}
//the function for getting the ticket with the help of the middleware
async function getTickets(req, res, next) {
  try {
    const tickets = await listAllTickets({ status: req.query.status });
    res.json({ tickets });
  } catch (err) {
    next(err);
  }
}

async function getTicket(req, res, next) {
  try {
    const ticket = await getTicketById(req.params.id);
    res.json({ ticket });
  } catch (err) {
    next(err);
  }
}

async function postTicketReply(req, res, next) {
  try {
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'body is required' });
    const admin = await prisma.adminUser.findUnique({ where: { id: req.user.id }, select: { name: true } });
    const ticket = await replyToTicket(req.params.id, admin?.name || 'HumanCare Support', body.trim());
    res.json({ ticket });
  } catch (err) {
    next(err);
  }
}
//the function
async function patchTicketStatus(req, res, next) {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: `status is required. Use one of: ${VALID_TICKET_STATUSES.join(', ')}` });
    const ticket = await updateTicketStatus(req.params.id, status);
    res.json({ ticket });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  login,
  me,
  getAdmins,
  getPendingRegistrations,
  getRegistration,
  postApproveRegistration,
  postRejectRegistration,
  postProvisionRegistration,
  postSendMobileLink,
  postReviewContactEmail,
  downloadRegistrationDocument,
  getCorporates,
  postCorporate,
  postCorporateUser,
  getCases,
  getCase,
  patchCaseAssign,
  getBilling,
  patchCaseBilling,
  getPatients,
  patchCaseStage,
  getTickets,
  getTicket,
  postTicketReply,
  patchTicketStatus,
};
