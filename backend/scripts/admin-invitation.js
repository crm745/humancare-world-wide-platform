// Operator script: manage the invitations of an Admin who is not fully set up yet.
//   node scripts/admin-invitation.js resend --email "admin@example.com"              new activation link (Admin still "invited")
//   node scripts/admin-invitation.js revoke --email "admin@example.com"              cancel outstanding activation links
//   node scripts/admin-invitation.js resend-enrollment --email "admin@example.com"   new passkey-setup link (Admin accepted but has no passkey)
// Links are only ever emailed, never printed, and no password is ever given on the command line.
// Account creation is scripts/admin-create.js.
const { prisma } = require('../src/db/prisma');
const { ProvisioningError, normalizeAdminEmail } = require('../src/modules/admin/auth/admin-provisioning.service');
const {
  resendActivationInvitation,
  resendPasskeyEnrollmentInvitation,
  revokeActivationInvitation,
  InvitationOperatorError,
} = require('../src/modules/admin/auth/admin-invitation-operator.service');

const USAGE = 'Usage: node scripts/admin-invitation.js <resend|revoke|resend-enrollment> --email "admin@example.com"';
const COMMANDS = ['resend', 'revoke', 'resend-enrollment'];

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new ProvisioningError('bad_arguments', 'The first argument must be "resend", "revoke" or "resend-enrollment".');
  let email;
  for (let i = 0; i < rest.length; i += 1) {
    const match = /^--email(?:=(.*))?$/.exec(rest[i]);
    if (!match) throw new ProvisioningError('bad_arguments', `Unknown argument "${rest[i]}".`);
    if (email !== undefined) throw new ProvisioningError('bad_arguments', '--email was given more than once.');
    email = match[1];
    if (email === undefined) {
      i += 1;
      email = rest[i];
      if (email === undefined || email.startsWith('--')) throw new ProvisioningError('bad_arguments', '--email needs a value.');
    }
  }
  if (email === undefined) throw new ProvisioningError('bad_arguments', '--email is required.');
  return { command, email: normalizeAdminEmail(email) };
}

async function main() {
  const { command, email } = parseArgs(process.argv.slice(2));

  if (command === 'revoke') {
    const { admin, revokedCount } = await revokeActivationInvitation({ email });
    console.log(`Revoked ${revokedCount} outstanding activation invitation(s) for`, { id: admin.id, email: admin.email });
    console.log('The account was kept. Run "resend" to send a new invitation.');
    return;
  }

  if (command === 'resend-enrollment') {
    const outcome = await resendPasskeyEnrollmentInvitation({ email });
    console.log(`Previous passkey-setup invitations revoked: ${outcome.revokedCount}`);
    console.log(`New passkey-setup invitation created for ${outcome.admin.email}; expires ${outcome.invitation.expiresAt.toISOString()}`);
    if (outcome.emailDelivered) {
      console.log('Invitation email sent. The admin will also need their current password to use it.');
    } else {
      console.error('The new invitation was created but the email could not be sent.');
      console.error(`Reason: ${outcome.emailError}`);
      console.error('The invitation was kept and earlier ones stay revoked. Fix email delivery, then run "resend-enrollment" again.');
      process.exitCode = 3;
    }
    return;
  }

  const result = await resendActivationInvitation({ email });
  console.log(`Previous invitations revoked: ${result.revokedCount}`);
  console.log(`New invitation created for ${result.admin.email}; expires ${result.invitation.expiresAt.toISOString()}`);
  if (result.emailDelivered) {
    console.log('Invitation email sent.');
  } else {
    console.error('The new invitation was created but the email could not be sent.');
    console.error(`Reason: ${result.emailError}`);
    console.error('The invitation was kept and earlier ones stay revoked. Fix email delivery, then run "resend" again.');
    process.exitCode = 3;
  }
}

if (require.main === module) {
  main()
    .catch((err) => {
      if (err instanceof ProvisioningError || err instanceof InvitationOperatorError) {
        console.error(err.message);
        if (err.code === 'bad_arguments') console.error(USAGE);
      } else {
        console.error('Invitation operation failed; nothing was changed.');
        // Not err.message: Prisma errors can echo the data being written.
        console.error(`Error: ${err.code || err.name}`);
      }
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = { parseArgs };
