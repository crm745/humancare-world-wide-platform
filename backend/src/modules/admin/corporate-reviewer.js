// Who may work corporate registrations (list, approve, reject, provision, ...): a
// superadmin, or a regular admin that was explicitly granted `corporate_review`. Not every
// authenticated admin.
//
// The signed token only says WHO is calling; whether they may do this is read from the
// database on each call, so a revoked flag or a deleted admin stops working immediately
// and a refreshed token (which does not carry the admin role) cannot lose or gain access.
// Chain after requireAuth(['admin']). Puts the verified admin on req.admin.
const { prisma } = require('../../db/prisma');

async function requireCorporateReviewer(req, res, next) {
  try {
    const admin = await prisma.adminUser.findUnique({
      where: { id: Number(req.user.id) },
      select: { id: true, name: true, role: true, corporateReview: true },
    });
    if (!admin || !(admin.role === 'superadmin' || admin.corporateReview === true)) {
      return res.status(403).json({ error: 'Corporate registration review access required.', code: 'corporate_review_required' });
    }
    req.admin = { id: admin.id, name: admin.name, role: admin.role };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireCorporateReviewer };
