// Operations / Admin notices for Bitrix Deal document sharing: a failed attach or removal that needs a person, and the removal
// of a document that was previously shared. The notification system has only patient and corporate recipients, so (like
// deal-failure-alerts.js) the alert itself is an AuditLog row plus an "[ALERT]" log line written by the worker; this adds an
// OPTIONAL e-mail to OPERATIONS_ALERT_EMAIL. Unset = no e-mail, never an error. A mail problem never affects the work.
// The text holds identifiers and short codes only: never a patient name, a file name, a document, a URL or a token.
function makeNotifier({ env = process.env, loadMailer = () => require('../../lib/mailer') } = {}) {
  const to = String(env.OPERATIONS_ALERT_EMAIL || '').trim();
  return async function notify({ subject, text }) {
    if (!to) return false;
    try {
      await loadMailer().sendMail({ to, subject: String(subject).slice(0, 200), text: String(text).slice(0, 2000) });
      return true;
    } catch {
      return false;
    }
  };
}

module.exports = { makeNotifier };
