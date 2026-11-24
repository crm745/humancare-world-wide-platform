// Read-only resolution of an existing admin account to cite as the marker's initiating admin.
// Reads ONLY the numeric id (the Prisma `select` clause below never fetches passwordHash, email, or
// any other field) — no login, no session, no credential is ever read or used.
const ELIGIBLE_ROLES = ['admin', 'superadmin'];

class NoEligibleAdminError extends Error {
  constructor() {
    super('no eligible admin account exists (status=active, disabledAt=null, role in admin/superadmin) — refusing to proceed');
    this.name = 'NoEligibleAdminError';
    this.code = 'no_eligible_admin';
  }
}

// Deterministic ascending-id order; the lowest-id eligible row is used every time.
async function resolveEligibleAdminId(prisma) {
  const row = await prisma.adminUser.findFirst({
    where: { status: 'active', disabledAt: null, role: { in: ELIGIBLE_ROLES } },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  if (!row) throw new NoEligibleAdminError();
  return row.id;
}

module.exports = { resolveEligibleAdminId, NoEligibleAdminError, ELIGIBLE_ROLES };
