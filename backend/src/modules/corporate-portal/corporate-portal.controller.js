const path = require('path');
const { prisma } = require('../../db/prisma');
const { UPLOAD_DIR } = require('../../middleware/upload.middleware');
const {
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
} = require('./corporate-portal.service');

const VALID_RANGES = ['today', 'week', 'month', 'year', 'all'];

// We don't have a "contact name" field on CorporateUser — their login email is the best
// available stand-in for attributing something they wrote (a note, a ticket message).
async function getAuthorName(req) {
  const corporateUser = await prisma.corporateUser.findUnique({ where: { id: req.user.id } });
  return corporateUser?.email;
}

async function getDashboard(req, res, next) {
  try {
    const range = VALID_RANGES.includes(req.query.range) ? req.query.range : 'month';
    const data = await getDashboardStats(req.user.corporateId, range);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

async function listNotifications(req, res, next) {
  try {
    const notifications = await listCorporateNotifications(req.user.id);
    res.json(notifications);
  } catch (err) {
    next(err);
  }
}

async function patchNotificationRead(req, res, next) {
  try {
    const read = req.body.read !== false; // defaults to true, matching the frontend's usual call shape
    const notification = await setCorporateNotificationRead(req.user.id, req.params.id, read);
    res.json(notification);
  } catch (err) {
    next(err);
  }
}

async function markAllNotificationsRead(req, res, next) {
  try {
    await markAllCorporateNotificationsRead(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function deleteNotificationRoute(req, res, next) {
  try {
    await deleteCorporateNotification(req.user.id, req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

async function listPatients(req, res, next) {
  try {
    const patients = await listCorporatePatients(req.user.corporateId);
    res.json(patients);
  } catch (err) {
    next(err);
  }
}

async function getPatient(req, res, next) {
  try {
    const patient = await getCorporatePatient(req.user.corporateId, req.params.id);
    res.json(patient);
  } catch (err) {
    next(err);
  }
}

async function postPatientCommunication(req, res, next) {
  try {
    const { summary, channel } = req.body;
    if (!summary || !channel) return res.status(400).json({ error: 'summary and channel are required' });
    const authorName = await getAuthorName(req);
    const entry = await addPatientCommunication(req.user.corporateId, req.params.id, { summary, channel, authorName });
    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
}

async function listTickets(req, res, next) {
  try {
    const tickets = await listCorporateTickets(req.user.corporateId);
    res.json(tickets);
  } catch (err) {
    next(err);
  }
}

async function postTicket(req, res, next) {
  try {
    const { subject, category, priority, description } = req.body;
    if (!subject || !category || !description) {
      return res.status(400).json({ error: 'subject, category and description are required' });
    }
    const authorName = await getAuthorName(req);
    const ticket = await createCorporateTicket(req.user.corporateId, authorName, { subject, category, priority, description });
    res.status(201).json(ticket);
  } catch (err) {
    next(err);
  }
}

async function postTicketMessage(req, res, next) {
  try {
    const { body } = req.body;
    if (!body) return res.status(400).json({ error: 'body is required' });
    const authorName = await getAuthorName(req);
    const ticket = await addTicketMessage(req.user.corporateId, req.params.id, authorName, body);
    res.status(201).json(ticket);
  } catch (err) {
    next(err);
  }
}

async function getProfile(req, res, next) {
  try {
    res.json(await getCorporateProfile(req.user.corporateId));
  } catch (err) {
    next(err);
  }
}

async function putCompany(req, res, next) {
  try {
    res.json(await updateCorporateCompany(req.user.corporateId, req.body));
  } catch (err) {
    next(err);
  }
}

async function getSettings(req, res, next) {
  try {
    res.json(await getCorporateSettings(req.user.id));
  } catch (err) {
    next(err);
  }
}

async function putSettings(req, res, next) {
  try {
    res.json(await updateCorporateSettings(req.user.id, req.body));
  } catch (err) {
    next(err);
  }
}

async function search(req, res, next) {
  try {
    res.json(await searchCorporate(req.user.corporateId, req.query.q));
  } catch (err) {
    next(err);
  }
}

async function listDocuments(req, res, next) {
  try {
    res.json(await listCorporateDocuments(req.user.corporateId));
  } catch (err) {
    next(err);
  }
}

async function postDocument(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    if (!req.body.type) return res.status(400).json({ error: 'type is required' });
    const doc = await addCorporateDocument(req.user.corporateId, {
      type: req.body.type,
      name: req.body.name?.trim() || req.file.originalname,
      fileUrl: `/uploads/${req.file.filename}`,
      fileSizeBytes: req.file.size,
    });
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
}

async function downloadDocument(req, res, next) {
  try {
    const doc = await getCorporateDocumentForDownload(req.user.corporateId, req.params.id);
    res.download(path.join(UPLOAD_DIR, path.basename(doc.fileUrl)), doc.name, { dotfiles: 'allow' });
  } catch (err) {
    next(err);
  }
}

async function deleteDocumentRoute(req, res, next) {
  try {
    await deleteCorporateDocument(req.user.corporateId, req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getDashboard,
  listNotifications,
  patchNotificationRead,
  markAllNotificationsRead,
  deleteNotificationRoute,
  listPatients,
  getPatient,
  postPatientCommunication,
  listTickets,
  postTicket,
  postTicketMessage,
  getProfile,
  putCompany,
  getSettings,
  putSettings,
  search,
  listDocuments,
  postDocument,
  downloadDocument,
  deleteDocumentRoute,
};
