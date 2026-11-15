// POST /admin/cases/:id/deal-recovery  (superadmin only; see admin.routes.js)
// body: { eventId, mode: "requeue" | "confirm_no_deal" | "adopt_deal", reasonCode, dealId? }
const { prisma } = require('../../db/prisma');
const api = require('./bitrix-deal.api');
const { recoverDealEvent, RecoveryError } = require('./deal-recovery.service');

async function postDealRecovery(req, res, next) {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const result = await recoverDealEvent({
      prisma, api, actor: { id: req.user && req.user.id, role: req.user && req.user.adminRole },
      caseId: Number(req.params.id), eventId: Number(body.eventId), mode: body.mode, reasonCode: body.reasonCode, dealId: body.dealId,
    });
    return res.status(201).json(result);
  } catch (err) {
    if (err instanceof RecoveryError) return res.status(err.status).json({ error: err.message, code: err.code });
    return next(err);
  }
}

module.exports = { postDealRecovery };
