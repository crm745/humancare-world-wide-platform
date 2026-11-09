// Operator script: disable or re-enable an Admin account. Accounts are never deleted.
//   node scripts/admin-account.js disable --email "admin@example.com" --reason "Left the company"
//   node scripts/admin-account.js enable  --email "admin@example.com"
// Disabling ends every session of the Admin at once; registered passkeys are kept, and enabling
// does not bring any session back (the Admin signs in again with password and passkey). No
// password, token or link is read, printed or sent. The account is found by its exact email.
const { prisma } = require('../src/db/prisma');
const { ProvisioningError, normalizeAdminEmail } = require('../src/modules/admin/auth/admin-provisioning.service');
const {
  disableAdminAccount,
  enableAdminAccount,
  normalizeDisableReason,
} = require('../src/modules/admin/auth/admin-account.service');

const USAGE = [
  'Usage: node scripts/admin-account.js disable --email "admin@example.com" --reason "Reason"',
  '       node scripts/admin-account.js enable --email "admin@example.com"',
].join('\n');
const ALLOWED = { disable: ['email', 'reason'], enable: ['email'] };

// Accepts "--email value" and "--email=value". Unknown commands, unknown or repeated options,
// options the command does not take, and missing values are all errors, so a typo (or a
// --password, --id ...) is never silently ignored.
function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, command)) {
    throw new ProvisioningError('bad_arguments', 'The first argument must be "disable" or "enable".');
  }
  const allowed = ALLOWED[command];
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
  for (const key of allowed) {
    if (!(key in values)) throw new ProvisioningError('bad_arguments', `--${key} is required.`);
  }
  return {
    command,
    email: normalizeAdminEmail(values.email),
    ...(command === 'disable' ? { reason: normalizeDisableReason(values.reason) } : {}),
  };
}

async function main() {
  const input = parseArgs(process.argv.slice(2));

  if (input.command === 'disable') {
    const result = await disableAdminAccount({ email: input.email, reason: input.reason });
    console.log('Admin disabled:', { id: result.admin.id, email: result.admin.email, status: result.admin.status });
    console.log(`Sessions ended: ${result.revokedSessions}; refresh tokens revoked: ${result.revokedRefreshTokens}.`);
    if (result.cancelledRecoveryRequests > 0 || result.revokedRecoveryInvitations > 0) {
      console.log(`Recovery requests cancelled: ${result.cancelledRecoveryRequests}; recovery invitations revoked: ${result.revokedRecoveryInvitations}.`);
    }
    console.log('Registered passkeys were kept. Run "enable" to allow this admin to sign in again.');
    return;
  }

  const result = await enableAdminAccount({ email: input.email });
  console.log('Admin enabled:', { id: result.admin.id, email: result.admin.email, status: result.admin.status });
  if (result.admin.status === 'invited') {
    console.log('This admin has not chosen a password yet. Use scripts/admin-invitation.js "resend" to send a new activation link.');
  } else if (result.admin.status === 'pending_passkey') {
    console.log('This admin has not registered a passkey yet. Use scripts/admin-invitation.js "resend-enrollment" to send a new passkey-setup link.');
  } else {
    console.log('No session was created; the admin must sign in again.');
  }
}

if (require.main === module) {
  main()
    .catch((err) => {
      if (err instanceof ProvisioningError) {
        console.error(err.message);
        if (err.code === 'bad_arguments') console.error(USAGE);
      } else {
        console.error('Admin account operation failed; nothing was changed.');
        // Not err.message: Prisma errors can echo the data being written.
        console.error(`Error: ${err.code || err.name}`);
      }
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = { parseArgs };
