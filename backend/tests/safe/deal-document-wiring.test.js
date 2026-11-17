/* global describe, test, expect, jest */
// How the document-sharing pieces are wired: the Admin routes, the scheduled job, the schema/migration agreement for the new table,
// and the in-memory fake of the Documents field. No database, no network.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const fs = require('fs');
const path = require('path');
const harness = require('../../src/modules/bitrix/deal-worker-harness');

const BACKEND = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(BACKEND, ...parts), 'utf8');

describe('the Admin routes', () => {
  const routes = read('src', 'modules', 'admin', 'admin.routes.js');

  test.each([
    ['get', '/requests/:id/shares', 'getShares'],
    ['post', '/requests/:id/documents/:docId/share', 'postShare'],
    ['post', '/requests/:id/shares/:shareId/revoke', 'postRevokeShare'],
    ['post', '/requests/:id/shares/:shareId/retry', 'postRetryShare'],
    ['post', '/requests/:id/document-requests', 'postDocumentRequest'],
  ])('%s %s is mounted under /admin (behind the Admin login) with %s', (method, route, handler) => {
    expect(routes).toContain(`adminRouter.${method}('${route}', ${handler});`);
  });

  test('sharing routes are mounted AFTER the Admin authentication middleware (they are not among the public routes)', () => {
    const authenticated = routes.indexOf("adminRouter.get('/requests', getRequests)");
    expect(authenticated).toBeGreaterThan(routes.indexOf('adminAuthRouter'));
    expect(routes.indexOf("'/requests/:id/documents/:docId/share'")).toBeGreaterThan(authenticated);
  });

  test('the controller exposes exactly these handlers and takes the Admin id from the session, never from the request body', () => {
    const controller = require('../../src/modules/bitrix/deal-document.controller');
    expect(Object.keys(controller).sort()).toEqual(['getShares', 'postDocumentRequest', 'postRetryShare', 'postRevokeShare', 'postShare']);
    const source = read('src', 'modules', 'bitrix', 'deal-document.controller.js');
    expect(source).toMatch(/adminId: req\.user\.id/);
    expect(source).not.toMatch(/adminId: req\.body/);
  });
});

describe('the scheduled job', () => {
  const jobs = require('../../src/jobs');

  test('is registered, runs every 30 seconds and does not run at start-up', () => {
    const job = jobs.jobs.find((j) => j.name === 'bitrix-deal-document');
    expect(job).toMatchObject({ intervalMs: 30 * 1000, runOnStart: false });
    expect(typeof job.run).toBe('function');
    expect(new Set(jobs.jobs.map((j) => j.name)).size).toBe(jobs.jobs.length);
  });

  test('is idle while the Bitrix switches are off: it touches neither the database nor Bitrix', async () => {
    const job = jobs.jobs.find((j) => j.name === 'bitrix-deal-document');
    const saved = { sync: process.env.BITRIX_SYNC_ENABLED, deal: process.env.BITRIX_PRIVATE_CHARTER_DEAL_ENABLED };
    delete process.env.BITRIX_SYNC_ENABLED;
    delete process.env.BITRIX_PRIVATE_CHARTER_DEAL_ENABLED;
    try {
      await expect(job.run()).resolves.toEqual({ active: false, claimed: 0 });
    } finally {
      if (saved.sync !== undefined) process.env.BITRIX_SYNC_ENABLED = saved.sync;
      if (saved.deal !== undefined) process.env.BITRIX_PRIVATE_CHARTER_DEAL_ENABLED = saved.deal;
    }
  });
});

describe('the schema and the prepared migration agree (not applied)', () => {
  const folder = '20261116110000_bitrix_deal_documents';
  const sql = read('prisma', 'migrations', folder, 'migration.sql');
  const schema = read('prisma', 'schema.prisma');
  const model = schema.slice(schema.indexOf('model BitrixDealDocument {'), schema.indexOf('}', schema.indexOf('model BitrixDealDocument {')));

  test('every column of the model is in the migration, with its mapped name', () => {
    const columns = [...model.matchAll(/@map\("([a-z_]+)"\)/g)].map((m) => m[1]);
    expect(columns.length).toBeGreaterThan(15);
    for (const column of columns) expect(sql).toContain(`\`${column}\``);
    for (const column of ['id', 'generation', 'status', 'attempts']) expect(sql).toContain(`\`${column}\``);
  });

  test('the uniqueness rules that prevent duplicate attachments exist: per (Deal, document, generation), per (Deal, Bitrix file) and the token', () => {
    expect(sql).toMatch(/UNIQUE INDEX `bitrix_deal_documents_share_token_key`/);
    expect(sql).toMatch(/UNIQUE INDEX `[a-z_]+`\(`deal_link_id`, `request_document_id`, `generation`\)/);
    expect(sql).toMatch(/UNIQUE INDEX `[a-z_]+`\(`deal_link_id`, `bitrix_file_id`\)/);
    expect(model).toMatch(/@@unique\(\[dealLinkId, requestDocumentId, generation\](, map: "[a-z_]+")?\)/); // the optional map names the index (MySQL's 64-character limit)
    expect(model).toMatch(/@@unique\(\[dealLinkId, bitrixFileId\]\)/);
    expect(model).toMatch(/shareToken\s+String\s+@unique/);
  });

  test('foreign keys RESTRICT deletion: a HumanCare document or Deal link with a share can never be deleted', () => {
    expect(sql).toMatch(/FOREIGN KEY \(`deal_link_id`\) REFERENCES `bitrix_deal_links`\(`id`\) ON DELETE RESTRICT/);
    expect(sql).toMatch(/FOREIGN KEY \(`request_document_id`\) REFERENCES `request_documents`\(`id`\) ON DELETE RESTRICT/);
    expect(model).toMatch(/onDelete: Restrict/);
  });

  test('the per-Deal file lease columns are added to bitrix_deal_links, nullable, in the migration and the model', () => {
    expect(sql).toMatch(/ALTER TABLE `bitrix_deal_links` ADD COLUMN `file_locked_by` VARCHAR\(64\) NULL, ADD COLUMN `file_locked_until` DATETIME\(3\) NULL;/);
    expect(schema).toMatch(/fileLockedBy\s+String\?\s+@db\.VarChar\(64\)\s+@map\("file_locked_by"\)/);
    expect(schema).toMatch(/fileLockedUntil\s+DateTime\?\s+@map\("file_locked_until"\)/);
  });

  test('the migration only adds: nothing existing is dropped, changed or deleted; the rollback is by hand and says what it deletes', () => {
    const statements = sql.replace(/^--.*$/gm, '').replace(/ON (DELETE|UPDATE) (RESTRICT|CASCADE)/g, '');
    expect(statements).not.toMatch(/DROP |DELETE |UPDATE |TRUNCATE|MODIFY|RENAME/i);
    expect([...statements.matchAll(/^(CREATE TABLE|ALTER TABLE) `([a-z_]+)`/gm)].map((m) => `${m[1]} ${m[2]}`)).toEqual(['CREATE TABLE bitrix_deal_documents', 'ALTER TABLE bitrix_deal_documents', 'ALTER TABLE bitrix_deal_documents', 'ALTER TABLE bitrix_deal_links']);
    const down = read('prisma', 'migrations', folder, 'down.sql');
    expect(down).toMatch(/DROP TABLE `bitrix_deal_documents`;/);
    expect(down).toMatch(/DROP COLUMN `file_locked_by`/);
    expect(down).toMatch(/ONLY while/);
    expect(sql).toMatch(/NOT applied/);
  });

  test('it comes after the earlier prepared migration and is the newest one', () => {
    const names = fs.readdirSync(path.join(BACKEND, 'prisma', 'migrations')).filter((n) => /^\d{14}_/.test(n)).sort();
    expect(names[names.length - 1]).toBe(folder);
    expect(names).toContain('20261116100000_widen_service_request_mobility');
  });
});

describe('the in-memory fake of the Documents field (used by the guarded worker and the tests)', () => {
  test('behaves like Bitrix: an update REPLACES the whole list, { id } keeps a file, { fileData } adds one with a fake id', async () => {
    const fake = harness.makeFakeBitrixApi();
    fake.dealFiles.set('44', ['1', '2']);
    expect(await fake.getDealFiles('44')).toEqual({ status: 'ok', ids: ['1', '2'] });
    await fake.updateDealFiles('44', [{ id: '1' }, { id: '2' }, { fileData: ['a.pdf', 'JVBER'] }]);
    expect(fake.dealFiles.get('44')).toEqual(['1', '2', '7000000001']);
    await fake.updateDealFiles('44', [{ id: '2' }]); // omitting a file removes it
    expect(fake.dealFiles.get('44')).toEqual(['2']);
    expect(await fake.getDealFiles('999')).toEqual({ status: 'ok', ids: [] });
    expect(fake.calls.map((c) => c.method)).toEqual(['crm.item.get', 'crm.item.update', 'crm.item.update', 'crm.item.get']);
  });

  test('never touches the network and returns ids in a range no real file has', async () => {
    const fake = harness.makeFakeBitrixApi();
    await fake.updateDealFiles('44', [{ fileData: ['a.pdf', 'JVBER'] }]);
    expect(Number(fake.dealFiles.get('44')[0])).toBeGreaterThanOrEqual(harness.FIRST_FAKE_DEAL_ID - 2000000000);
    expect(fake.isFake).toBe(true);
  });
});

describe('storage', () => {
  test('the document worker and service read files only through the checksum-verified reader (local filesystem; no S3 anywhere)', () => {
    const worker = read('src', 'modules', 'bitrix', 'deal-document-worker.service.js');
    const service = read('src', 'modules', 'bitrix', 'deal-document.service.js');
    expect(worker).toMatch(/readVerifiedFile/);
    expect(service).toMatch(/readVerifiedFile/);
    for (const source of [worker, service]) {
      expect(source).not.toMatch(/require\('fs'\)|require\("fs"\)|aws-sdk|@aws-sdk|S3Client|createReadStream/);
    }
    const pkg = JSON.parse(read('package.json'));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) => /aws|s3/i.test(name))).toEqual([]);
  });
});
