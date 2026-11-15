/* global describe, it, expect, afterAll */
// The first integration check: the test process really is connected to humancare_test as a confined account, and the
// migration history exists. READ-ONLY. Not run by the ordinary test commands.
const { prisma } = require('../../src/db/prisma');
const guard = require('../../src/common/safety/integration-runner-guard');

afterAll(() => prisma.$disconnect());

describe('integration database', () => {
  it('is humancare_test, confined to that database', async () => {
    const live = await guard.verifyLiveIdentity(prisma);
    expect(live.database).toBe('humancare_test');
  });
  it('has the migration history table', async () => {
    const rows = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM _prisma_migrations');
    expect(Number(rows[0].n)).toBeGreaterThan(0);
  });
});
