// Operator script: the passkey-recovery REQUEST of an Admin who has lost their passkey.
//   node scripts/admin-recovery.js request --email "admin@example.com" --reason "Lost laptop"
//   node scripts/admin-recovery.js status  --id 12          (or: status --email "admin@example.com")
//   node scripts/admin-recovery.js cancel  --id 12 --reason "Raised in error"
//   node scripts/admin-recovery.js resend  --id 12
//   node scripts/admin-recovery.js break-glass --email "admin@example.com" --reason "Why the emergency path is needed"
// A request starts the two-person approval process (two other active superadmins must approve);
// it does not give anyone access by itself. The target is told by email, without any link. Nothing
// secret is read, printed or sent. The Admin is found by exact email; requests by their own id.
// "resend" replaces the invitation of an APPROVED request (expired, revoked, used or never delivered).
// "break-glass" is the emergency path for when fewer than two other active superadmins exist: it
// asks you to type a confirmation, and it still needs the target's link, password and new passkey.
// Raw invitation links and tokens are never printed.
const readline = require('readline');
const { prisma } = require('../src/db/prisma');
const { ProvisioningError, normalizeAdminEmail } = require('../src/modules/admin/auth/admin-provisioning.service');
const {
  resendRecoveryInvitation,
  breakGlassRecovery,
  breakGlassConfirmation,
  normalizeBreakGlassReason,
} = require('../src/modules/admin/auth/admin-recovery-decision.service');
const {
  createRecoveryRequest,
  cancelRecoveryRequest,
  getRecoveryRequestStatus,
  normalizeRecoveryReason,
  parseRequestId,
} = require('../src/modules/admin/auth/admin-recovery-request.service');

const USAGE = [
  'Usage: node scripts/admin-recovery.js request --email "admin@example.com" --reason "Reason"',
  '       node scripts/admin-recovery.js status --id <request id>',
  '       node scripts/admin-recovery.js status --email "admin@example.com"',
  '       node scripts/admin-recovery.js cancel --id <request id> --reason "Reason"',
  '       node scripts/admin-recovery.js resend --id <request id>',
  '       node scripts/admin-recovery.js break-glass --email "admin@example.com" --reason "Reason"',
].join('\n');

// required: every one must be given. oneOf: exactly one must be given.
const COMMANDS = {
  request: { required: ['email', 'reason'], oneOf: [] },
  cancel: { required: ['id', 'reason'], oneOf: [] },
  status: { required: [], oneOf: ['id', 'email'] },
  resend: { required: ['id'], oneOf: [] },
  'break-glass': { required: ['email', 'reason'], oneOf: [] },
};

// Accepts "--email value" and "--email=value". Unknown commands, unknown or repeated options,
// options the command does not take, missing values and missing or conflicting options are all
// errors, so a typo (or a --password, --token ...) is never silently ignored.
function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, command)) {
    throw new ProvisioningError('bad_arguments', 'The first argument must be "request", "status", "cancel", "resend" or "break-glass".');
  }
  const spec = COMMANDS[command];
  const allowed = [...spec.required, ...spec.oneOf];
  const values = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const match = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
    if (!match || !allowed.includes(match[1])) throw new ProvisioningError('bad_arguments', `Unexpected argument "${arg}".`);
    const key = match[1];
    if (key in values) throw new ProvisioningError('bad_arguments', `--${key} was given more than once.`);
    let value = match[2];
    if (value === undefined) {
      i += 1;
      value = rest[i];
      if (value === undefined || value.startsWith('--')) throw new ProvisioningError('bad_arguments', `--${key} needs a value.`);
    }
    values[key] = value;
  }
  for (const key of spec.required) {
    if (!(key in values)) throw new ProvisioningError('bad_arguments', `--${key} is required.`);
  }
  if (spec.oneOf.length > 0 && spec.oneOf.filter((key) => key in values).length !== 1) {
    throw new ProvisioningError('bad_arguments', `Give exactly one of ${spec.oneOf.map((key) => `--${key}`).join(' or ')}.`);
  }

  const parsed = { command };
  if ('email' in values) parsed.email = normalizeAdminEmail(values.email);
  if ('id' in values) parsed.id = parseRequestId(values.id);
  if ('reason' in values) parsed.reason = command === 'break-glass' ? normalizeBreakGlassReason(values.reason) : normalizeRecoveryReason(values.reason);
  return parsed;
}

const iso = (date) => (date instanceof Date ? date.toISOString() : null);

function printStatus(info) {
  console.log(`Recovery request ${info.id}: ${info.status}${info.pastDeadline ? ' (past its deadline: treated as expired)' : ''}`);
  console.log(`  Admin:      ${info.admin.email ?? `#${info.admin.id}`}${info.admin.name ? ` (${info.admin.name})` : ''}${info.admin.status ? `, account ${info.admin.status}` : ''}`);
  console.log(`  Reason:     ${info.reason ?? '(none)'}`);
  console.log(`  Created:    ${iso(info.createdAt)}`);
  console.log(`  Expires:    ${iso(info.expiresAt)}`);
  console.log(`  Approvals:  ${info.approvals.approved} of ${info.approvalsRequired} required (${info.approvals.rejected} rejection(s))`);
  console.log(`  Channel:    ${info.requestedVia}${info.requestedByAdminId ? `, filed by admin #${info.requestedByAdminId}` : ''}`);
  const who = (op) => (op ? `${op.username ?? 'unknown user'}@${op.hostname ?? 'unknown host'}` : 'not recorded');
  console.log(`  Filed by:   ${who(info.filedBy)}`);
  if (info.status === 'cancelled') console.log(`  Cancelled by: ${who(info.cancelledBy)}`);
  if (info.approvedAt) console.log(`  Approved:   ${iso(info.approvedAt)}`);
  if (info.completedAt) console.log(`  Completed:  ${iso(info.completedAt)}`);
  console.log(`  Notice to the admin: ${info.notification}`);
  if (info.requestedVia === 'break_glass') console.log('  BREAK-GLASS: approved by an operator, without the two-person approval.');
  const inv = info.invitation;
  if (!inv) {
    console.log('  Invitation: none');
  } else {
    console.log(`  Invitation: #${inv.id} ${inv.state}, expires ${iso(inv.expiresAt)}, email ${inv.delivery}`);
    console.log(`  Invitations issued: ${inv.total}${inv.replacements > 0 ? ` (${inv.replacements} replacement(s))` : ''}; live now: ${inv.liveCount}`);
  }
}

// Reads one line from the terminal. Refuses to run without one: a break-glass must be typed by a
// person, not piped in.
function promptLine(question, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY) {
    throw new ProvisioningError('confirmation_required', 'Break-glass needs an interactive terminal to type the confirmation.');
  }
  const rl = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

// The mail provider's own error text can name hosts, addresses or other internals, so it is never
// printed. The (redacted) failure is in the audit trail and `status` shows it as "failed".
const DELIVERY_FAILURE_NOTE = 'Reason: the mail provider could not send the message (details withheld).';

// Shared by resend and break-glass. The invitation is committed either way; a failed email is
// reported (never the link) and the exit code says so. "resend" fixes it.
function reportDelivery(result) {
  if (result.emailDelivered) {
    console.log('The admin was sent the invitation by email.');
    return;
  }
  console.error('The invitation was CREATED but the email could not be sent.');
  console.error(DELIVERY_FAILURE_NOTE);
  console.error(`Run "resend --id ${result.request.id}" to issue a replacement and try again.`);
  process.exitCode = 3;
}

async function main() {
  const input = parseArgs(process.argv.slice(2));

  if (input.command === 'request') {
    const result = await createRecoveryRequest({ email: input.email, reason: input.reason });
    console.log('Recovery request created:', { id: result.request.id, admin: result.admin.email, status: result.request.status });
    console.log(`It expires ${result.request.expiresAt.toISOString()} and needs two approvals from active superadmins other than ${result.admin.email}.`);
    if (result.eligibleApprovers < 2) {
      console.error(`WARNING: only ${result.eligibleApprovers} other active superadmin(s) exist, so this request cannot be approved.`);
      console.error('A break-glass recovery will be needed ("break-glass" command); cancel this request if you prefer.');
    }
    if (result.emailDelivered) {
      console.log('The admin was notified by email.');
    } else {
      console.error('The request was CREATED but the notification email could not be sent.');
      console.error(DELIVERY_FAILURE_NOTE);
      console.error('The request was kept. "status" shows the notice as "failed". It carries no link, so nothing needs resending.');
      process.exitCode = 3;
    }
    return;
  }

  if (input.command === 'cancel') {
    const result = await cancelRecoveryRequest({ id: input.id, reason: input.reason });
    console.log(`Recovery request ${result.request.id} cancelled${result.admin.email ? ` for ${result.admin.email}` : ''}.`);
    if (result.revokedInvitations > 0) console.log(`${result.revokedInvitations} live invitation(s) revoked.`);
    return;
  }

  if (input.command === 'resend') {
    const result = await resendRecoveryInvitation({ id: input.id });
    console.log(`Replacement invitation #${result.invitation.id} issued for request ${result.request.id} (${result.admin.email}).`);
    console.log(`It expires ${result.invitation.expiresAt.toISOString()} (never later than the request's own deadline, ${result.request.expiresAt.toISOString()}). ${result.revokedCount} earlier live invitation(s) revoked.`);
    reportDelivery(result);
    return;
  }

  if (input.command === 'break-glass') {
    const expected = breakGlassConfirmation(input.email);
    console.log(`BREAK-GLASS recovery for ${input.email}`);
    console.log(`Reason: ${input.reason}`);
    console.log('This skips the two-person approval. It is allowed only if fewer than two other active superadmins exist.');
    console.log('The admin still needs the emailed link, their current password and a new passkey.');
    const typed = await promptLine(`Type exactly "${expected}" to continue: `);
    const result = await breakGlassRecovery({ email: input.email, reason: input.reason, confirmation: typed });
    console.log(`Break-glass recovery request ${result.request.id} created and approved for ${result.admin.email}; invitation #${result.invitation.id}.`);
    console.log(`Eligible superadmin approvers besides the admin: ${result.eligibleApprovers}. The request expires ${result.request.expiresAt.toISOString()}; the invitation ${result.invitation.expiresAt.toISOString()}.`);
    reportDelivery(result);
    return;
  }

  const found = await getRecoveryRequestStatus(input.id !== undefined ? { id: input.id } : { email: input.email });
  if (found.length === 0) {
    console.log('That admin has no recovery requests.');
    return;
  }
  found.forEach((info, index) => {
    if (index > 0) console.log('');
    printStatus(info);
  });
}

if (require.main === module) {
  main()
    .catch((err) => {
      if (err instanceof ProvisioningError) {
        console.error(err.message);
        if (err.code === 'bad_arguments') console.error(USAGE);
      } else {
        console.error('Recovery operation failed; nothing was changed.');
        // Not err.message: Prisma errors can echo the data being written.
        console.error(`Error: ${err.code || err.name}`);
      }
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = { parseArgs, printStatus, promptLine, reportDelivery, DELIVERY_FAILURE_NOTE };
