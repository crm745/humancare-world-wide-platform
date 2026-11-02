// Sent to a corporate login that still has a temporary password (see CorporateUser.
// mustChangePassword). The mobile app shows `error` as-is, so it says where to go.
const PASSWORD_CHANGE_REQUIRED = {
  error: 'You must set a new password before continuing. Please sign in to the HumanCare Corporate Portal to complete this first-time password change.',
  code: 'password_change_required',
};

module.exports = { PASSWORD_CHANGE_REQUIRED };
