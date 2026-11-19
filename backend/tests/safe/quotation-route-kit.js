/* global jest */
// The shared in-memory database for the HTTP-level quotation tests (the application holds a reference to it, so it is reset IN PLACE).
const kit = require('./quotation-test-kit');

const world = kit.makeWorld();
const db = kit.attachInvoices(kit.makePrisma(world), world); // the HTTP world includes the invoice table: an acceptance now creates the invoice
db.adminUser.findUnique = jest.fn(async ({ where }) => { const a = world.admins.find((x) => x.id === where.id); return a ? { ...a } : null; });
db.adminPasskey = { count: jest.fn(async () => 0) };

const reset = () => { for (const key of Object.keys(world)) delete world[key]; Object.assign(world, kit.makeWorld()); };

module.exports = { world, db, reset, kit };
