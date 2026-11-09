// Operator script: creates an Admin account in the "invited" state and emails an activation
// link. The Admin chooses their own password later; none is accepted or generated here. The
// invitation link is never printed - it goes only to the Admin's email.
// Run from backend/ with:
//   node scripts/admin-create.js --name "Admin Name" --email "admin@example.com" --role admin
// Roles: admin | superadmin. A superadmin also needs a typed confirmation.
// Needs ADMIN_PORTAL_URL (see .env.example) and a working email provider.
const readline = require('readline');
const { prisma } = require('../src/db/prisma');
const {
  provisionAdmin,
  ProvisioningError,
  normalizeAdminEmail,
  normalizeAdminName,
  validateAdminRole,
  superadminConfirmationPhrase,
} = require('../src/modules/admin/auth/admin-provisioning.service');

const USAGE = 'Usage: node scripts/admin-create.js --name "Admin Name" --email "admin@example.com" --role <admin|superadmin>';
const OPTIONS = ['name', 'email', 'role'];

// Accepts "--name value" and "--name=value". Anything else is an error, so a typo such as
// --password never gets silently ignored.
function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const match = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
    if (!match || !OPTIONS.includes(match[1])) throw new ProvisioningError('bad_arguments', `Unknown argument "${arg}".`);
    const key = match[1];
    if (key in values) throw new ProvisioningError('bad_arguments', `--${key} was given more than once.`);
    let value = match[2];
    if (value === undefined) {
      i += 1;
      value = argv[i];
      if (value === undefined || value.startsWith('--')) throw new ProvisioningError('bad_arguments', `--${key} needs a value.`);
    }
    values[key] = value;
  }
  for (const key of OPTIONS) {
    if (!(key in values)) throw new ProvisioningError('bad_arguments', `--${key} is required.`);
  }
  return {
    name: normalizeAdminName(values.name),
    email: normalizeAdminEmail(values.email),
    role: validateAdminRole(values.role),
  };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function main() {
  const input = parseArgs(process.argv.slice(2));

  let superadminConfirmation;
  if (input.role === 'superadmin') {
    if (!process.stdin.isTTY) {
      throw new ProvisioningError('superadmin_not_confirmed', 'Creating a superadmin needs an interactive terminal for the typed confirmation.');
    }
    const phrase = superadminConfirmationPhrase(input.email);
    console.log('A superadmin can manage other admins and sensitive settings.');
    superadminConfirmation = (await ask(`Type exactly "${phrase}" to continue: `)).trim();
  }

  const result = await provisionAdmin({ ...input, superadminConfirmation });

  console.log('Admin created:', { id: result.admin.id, email: result.admin.email, role: result.admin.role, status: result.admin.status });
  console.log(`Invitation expires: ${result.invitation.expiresAt.toISOString()}`);
  if (result.emailDelivered) {
    console.log('Invitation email sent.');
  } else {
    console.error('Provisioning SUCCEEDED but the invitation email could not be sent.');
    console.error(`Reason: ${result.emailError}`);
    console.error('The account and invitation were kept. Re-sending an invitation will need a resend');
    console.error('operation that does not exist yet (a later activity); do not run this script again for');
    console.error('the same email - it will be rejected as a duplicate.');
    process.exitCode = 3;
  }
}

if (require.main === module) {
  main()
    .catch((err) => {
      if (err instanceof ProvisioningError) {
        console.error(err.message);
        if (err.code === 'bad_arguments') console.error(USAGE);
      } else {
        console.error('Admin provisioning failed; nothing was created.');
        // Not err.message: Prisma errors can echo the data being written.
        console.error(`Error: ${err.code || err.name}`);
      }
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = { parseArgs };
