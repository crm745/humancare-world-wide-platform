// Reconciles ONE Razorpay payment whose webhook never reached this backend, through the existing payment pipeline.
//
//   node scripts/reconcile-razorpay-payment.js --payment-id pay_XXXX --internal-payment-id 1 [--order-id order_XXXX] [--invoice-id 1]
//        DRY RUN (the default): reads HumanCare (development database) and asks Razorpay (GET /payments/<id>, GET /orders/<id>), verifies everything and
//        prints what WOULD happen. Writes nothing.
//   ... --apply
//        the same checks, then stores the verified `payment.captured` event in the integration inbox (deterministic id "reconcile:<payment id>"), claims
//        THAT ONE row and runs it through the existing processor and payment store (locks, guards, audit, overpayment flags).
//
// Refuses unless: NODE_ENV is not test/production, DATABASE_URL is a local mysql URL naming humancare_dev AND the server confirms DATABASE() is humancare_dev,
// payments are enabled with Test Mode credentials. It starts no job runner or worker, creates no order and no payment, charges and refunds nothing, and
// never prints a key, secret, signature or Razorpay text: only fixed codes and the ids you passed. It reads backend/.env (the file is never written).
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const lib = require('./lib/reconcile-razorpay-payment');

const out = (line) => console.log(line);

async function main(argv) {
  let options;
  try { options = lib.parseArgs(argv); } catch (err) { out(`Refused: ${err.code || 'arguments_invalid'}.`); return 1; }

  // Checked BEFORE the Prisma client exists, so a wrong DATABASE_URL never connects.
  const problem = lib.environmentProblem(process.env);
  if (problem) { out(`Refused: ${problem}. Nothing was read or written.`); return 1; }

  const { prisma } = require('../src/db/prisma');
  try {
    out(`Mode: ${options.apply ? 'APPLY (writes through the existing pipeline)' : 'DRY RUN (no writes)'}`);
    const result = await lib.reconcile(options, { db: prisma, env: process.env });
    for (const code of result.passed || []) out(`  ok  ${code}`);
    if (result.status === 'refused') { out(`REFUSED: ${result.code}${result.reason ? ` (${result.reason})` : ''}. Nothing was written.`); return 2; }
    const s = result.summary;
    out(`Payment ${s.internalPaymentId} / invoice ${s.invoiceId} (${s.invoiceNumber || 'no number'}) / case id ${s.caseId}`);
    out(`Razorpay ${s.razorpayPaymentId} for ${s.razorpayOrderId}: ${s.amountMinor} minor units ${s.currency}, method ${s.method || 'unknown'}, order notes verified: ${s.orderNotesVerified}`);
    out(`Inbox event id: ${s.externalEventId}${result.inbox ? ` (row ${result.inbox.id} already exists, status ${result.inbox.status})` : ' (not stored yet)'}`);
    if (result.status === 'dry_run') { out('DRY RUN complete: every check passed. Nothing was written.'); return 0; }
    if (result.paymentAfter) out(`Payment after: ${result.paymentAfter.status}, reference ${result.paymentAfter.externalReference || 'none'}`);
    if (result.status === 'applied') { out(`APPLIED: outcome ${result.outcome}, inbox ${result.inbox.status}.`); return 0; }
    out(`NOT APPLIED: ${result.code || result.outcome || 'unknown'} (inbox ${result.inbox && result.inbox.status}).`);
    return 3;
  } finally {
    await prisma.$disconnect();
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
  console.error(`Failed: ${(err && (err.code || err.name)) || 'error'}.`); // never the message: it could carry a connection string or a query
  process.exitCode = 1;
});
