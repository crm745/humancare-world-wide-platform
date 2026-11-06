// scripts/geonames-status.js: the freshness check a scheduler can run. 0 = ok, 1 = refresh due (90
// days or more), 2 = stale (over 180 days) or empty, 3 = could not be read. Runs against the test
// database (humancare_test) with real ages counted back from now.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { prisma } = require('../src/db/prisma');
const { ROWS } = require('./fixtures/geo-cities');

const DAY = 24 * 60 * 60 * 1000;
const run = (...args) => spawnSync(process.execPath, ['scripts/geonames-status.js', '--env-file', '.env.test', ...args], {
  cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000,
});

// The newest import happened `days` ago (the status counts from the newest record).
async function importedDaysAgo(days) {
  await prisma.geonamesCityName.deleteMany();
  await prisma.geonamesCity.deleteMany();
  const stamp = (offsetDays) => new Date(Date.now() - (days + offsetDays) * DAY - 60 * 1000);
  await prisma.geonamesCity.createMany({ data: [
    { ...ROWS[0], verifiedAt: stamp(0) },
    { ...ROWS[1], verifiedAt: stamp(300) }, // an old leftover must not make the data look old
  ] });
}

afterAll(async () => {
  await prisma.geonamesCityName.deleteMany();
  await prisma.geonamesCity.deleteMany();
  await prisma.$disconnect();
});

describe('geonames-status.js', () => {
  it.each([
    [10, 0, 'ok'],
    [89, 0, 'ok'],
    [91, 1, 'refresh_due'],
    [150, 1, 'refresh_due'],
    [179, 1, 'refresh_due'],
    [181, 2, 'stale'],
    [400, 2, 'stale'],
  ])('imported %s days ago: exit %s (%s)', async (days, code, state) => {
    await importedDaysAgo(days);
    const result = run('--json');
    expect(result.status).toBe(code);
    const status = JSON.parse(result.stdout.trim().split('\n').pop());
    expect(status).toMatchObject({ state, refreshRecommendedAfterDays: 90, maxAgeDays: 180, cities: 2, citiesPastLimit: days > 180 ? 2 : 1 }); // the old leftover is always past the limit; the newest one is once the import itself is
    expect(Math.round(status.ageDays)).toBe(days);
  });

  it('says what to do in plain words', async () => {
    await importedDaysAgo(120);
    const refresh = run();
    expect(refresh.status).toBe(1);
    expect(refresh.stdout).toMatch(/State: refresh_due/);
    expect(refresh.stdout).toMatch(/Last import: .* \(120(\.\d)? days ago\)/);
    expect(refresh.stdout).toMatch(/ACTION: refresh the data now/);

    await importedDaysAgo(200);
    const stale = run();
    expect(stale.status).toBe(2);
    expect(stale.stdout).toMatch(/ACTION: Private Charter requests are failing/);

    await importedDaysAgo(5);
    const ok = run();
    expect(ok.status).toBe(0);
    expect(ok.stdout).not.toMatch(/ACTION/);
  });

  it('exits 2 when nothing is imported', async () => {
    await prisma.geonamesCityName.deleteMany();
    await prisma.geonamesCity.deleteMany();
    const result = run('--json');
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout.trim().split('\n').pop())).toMatchObject({ state: 'empty', lastImportAt: null });
  });

  it('exits 3 when the database cannot be read, without printing the connection details', () => {
    const env = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'geo-status-')), 'bad.env');
    fs.writeFileSync(env, 'DATABASE_URL=mysql://nobody:s3cretpassw0rd@127.0.0.1:1/nowhere?connect_timeout=2\n');
    const result = spawnSync(process.execPath, ['scripts/geonames-status.js', '--env-file', env], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000 });
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/Could not read the city data status/);
    expect(result.stdout + result.stderr).not.toContain('s3cretpassw0rd');
    fs.rmSync(path.dirname(env), { recursive: true, force: true });
  });

  it('a stricter GEONAMES_MAX_AGE_DAYS moves both limits', async () => {
    await importedDaysAgo(70);
    const result = spawnSync(process.execPath, ['scripts/geonames-status.js', '--env-file', '.env.test', '--json'], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000, env: { ...process.env, GEONAMES_MAX_AGE_DAYS: '60' },
    });
    // the env file is read with override, but a value set only in the process stays when the file lacks it
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout.trim().split('\n').pop())).toMatchObject({ state: 'stale', maxAgeDays: 60, refreshRecommendedAfterDays: 60 });
  });
});
