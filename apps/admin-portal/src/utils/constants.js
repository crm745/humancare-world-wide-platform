// Mirrors the backend's admin roles (backend/src/modules/admin). The server is the
// authority on access; these only decide what the UI offers.
export const ADMIN_ROLES = { ADMIN: 'admin', SUPERADMIN: 'superadmin' };

// Backend error codes the UI branches on.
export const ERROR_CODES = {
  CORPORATE_REVIEW_REQUIRED: 'corporate_review_required',
  SUPERADMIN_REQUIRED: 'superadmin_required',
  INITIAL_OWNER_REQUIRED: 'initial_owner_required',
};

export const CASE_STATUSES = ['submitted', 'scheduled', 'in_progress', 'completed', 'cancelled'];
export const BILLING_STATUSES = ['pending', 'invoiced', 'paid', 'overdue'];
export const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
export const BILLING_CURRENCIES = ['INR', 'USD', 'AED', 'GBP', 'OMR', 'BDT'];
