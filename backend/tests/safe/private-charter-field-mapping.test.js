/* global describe, test, expect */
// Private Charter field mapping, end to end without a database or network: a validated request body -> the stored row -> the
// Bitrix24 Deal payload. Plus the schema/migration agreement for the widened Mobility column, the label helper used by the Lead
// comment and the PDF, and the guarantee that the Documents file field is not written at Deal creation.
const fs = require('fs');
const path = require('path');
const { validatePrivateCharterRequest } = require('../../src/modules/requests/private-charter.validation');
const { requestRecordData } = require('../../src/modules/requests/request-record');
const deal = require('../../src/modules/bitrix/bitrix-deal');
const constants = require('../../src/common/constants/request.constants');

const BACKEND = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(BACKEND, ...parts), 'utf8');

const city = (geonameId, name, label, countryCode, timezone) => ({ geonameId, name, label, countryCode, timezone });
const CITIES = { origin: city(1275339, 'Mumbai', 'Mumbai, Maharashtra, India', 'IN', 'Asia/Kolkata'), destination: city(292223, 'Dubai', 'Dubai, United Arab Emirates', 'AE', 'Asia/Dubai') };
const body = (over = {}) => ({
  serviceKey: 'privatecharter', patientName: 'Maria Fernandez', patientAge: 61, patientGender: 'female', country: 'AE',
  origin: { geonameId: 1275339 }, destination: { geonameId: 292223 }, patientContact: '+971501234567', preferredDate: '2099-01-01',
  careLevel: ['care_icu'], description: 'Medical text that must never reach Bitrix', mobility: ['bedridden'], urgency: 'urgent_24h', ...over,
});

// validate -> store -> map
function toDeal(over) {
  const { fields, data } = validatePrivateCharterRequest(body(over), { cities: CITIES });
  expect(fields).toEqual({});
  const row = requestRecordData(7, data);
  return { row, payload: deal.buildDealFields({ referenceNumber: 'CASE-1234', patientName: row.patientName }, row) };
}

describe('from the app request to the Deal payload', () => {
  test('several care levels, several mobility options and equipment all arrive as arrays of the right option ids', () => {
    const { row, payload } = toDeal({ careLevel: ['care_stable', 'care_icu'], mobility: ['walking', 'bedridden'], equipOxygen: true, equipCardiacMonitor: false, equipVentilator: true, urgency: 'critical_6h' });
    expect(row).toMatchObject({ careLevel: 'care_icu,care_stable', mobility: 'bedridden,walking', equipOxygen: true, equipCardiacMonitor: false, equipVentilator: true });
    expect(payload).toMatchObject({
      UF_CRM_1794548015097: [5880, 5882],
      UF_CRM_1794830631: [6012, 6016],
      UF_CRM_1794830302: [6006, 6010],
      UF_CRM_1794831027: 6018,
      UF_CRM_1768195253912: 61,
      UF_CRM_1779270456180: 'Mumbai, Maharashtra, India',
      UF_CRM_69EB460B79B1D: 'Dubai, United Arab Emirates',
    });
  });

  test('an older app build (one mobility string, one care level) still maps, as arrays of one', () => {
    const { payload } = toDeal({ mobility: 'wheelchair', careLevel: ['care_ambulatory'], equipOxygen: false, equipCardiacMonitor: false, equipVentilator: false });
    expect(payload.UF_CRM_1794830631).toEqual([6014]);
    expect(payload.UF_CRM_1794548015097).toEqual([5884]);
    expect(payload).not.toHaveProperty('UF_CRM_1794830302'); // no equipment: optional, left out
  });

  test('Not Applicable alone maps; combined with another it never gets this far (the validator refuses it)', () => {
    expect(toDeal({ careLevel: ['care_na'] }).payload.UF_CRM_1794548015097).toEqual([5886]);
    expect(validatePrivateCharterRequest(body({ careLevel: ['care_na', 'care_icu'] }), { cities: CITIES }).fields.careLevel).toMatch(/Not Applicable/);
  });

  test('Urgency is exactly one value: the three options are separate', () => {
    expect(['critical_6h', 'urgent_24h', 'planned'].map((urgency) => toDeal({ urgency }).payload.UF_CRM_1794831027)).toEqual([6018, 6020, 6022]);
    expect(validatePrivateCharterRequest(body({ urgency: ['critical_6h', 'planned'] }), { cities: CITIES }).fields.urgency).toBeDefined();
  });

  test('the medical description and the Documents field are never in the payload', () => {
    const { payload } = toDeal({});
    const sent = JSON.stringify(payload);
    expect(sent).not.toContain('Medical text that must never reach Bitrix');
    expect(payload).not.toHaveProperty(deal.DOCUMENTS_FIELD);
    expect(deal.DOCUMENTS_FIELD).toBe('UF_CRM_1794832401');
  });

  test('the unchanged mappings are still there: category, stage, source, service, industry, gender, date, mobile, reference', () => {
    const { payload } = toDeal({});
    expect(payload).toMatchObject({
      CATEGORY_ID: 38, STAGE_ID: 'C38:NEW', SOURCE_ID: 'UC_0AYN3R', TITLE: 'CASE-1234', UF_CRM_1794548440549: 'CASE-1234',
      UF_CRM_6A2FB92FE1881: [2844], UF_CRM_69EB460B879E4: 1726, UF_CRM_1775637288921: 'Maria Fernandez', UF_CRM_1775813710026: 1292,
      UF_CRM_1775813920874: '2099-01-01', UF_CRM_PHONE_MOBILE: '+971501234567',
    });
  });
});

describe('the Deal option tables agree with what the app and the backend can send', () => {
  test('every care level, mobility, equipment flag and urgency value has an option, and nothing else does', () => {
    expect(Object.keys(deal.CARE_LEVEL_OPTION)).toEqual(constants.CARE_LEVEL_KEYS);
    expect(Object.keys(deal.MOBILITY_OPTION)).toEqual(constants.MOBILITY);
    expect(Object.keys(deal.URGENCY_OPTION)).toEqual(constants.URGENCY);
    expect(Object.keys(deal.EQUIPMENT_OPTION)).toEqual(constants.EQUIPMENT.map(([flag]) => flag));
    expect(deal.CARE_LEVEL_EXCLUSIVE).toBe(constants.CARE_LEVEL_EXCLUSIVE);
  });

  test('no two options of one field share an id, and the new fields use their own ids', () => {
    for (const table of [deal.CARE_LEVEL_OPTION, deal.MOBILITY_OPTION, deal.EQUIPMENT_OPTION, deal.URGENCY_OPTION]) {
      const ids = Object.values(table);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test('only the Deal mapper defines the Documents field code (every other file uses its DOCUMENTS_FIELD constant)', () => {
    const holders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && /['"]UF_CRM_1794832401['"]/.test(fs.readFileSync(full, 'utf8'))) holders.push(path.relative(BACKEND, full).replace(/\\/g, '/'));
      }
    };
    walk(path.join(BACKEND, 'src'));
    expect(holders).toEqual(['src/modules/bitrix/bitrix-deal.js']);
  });
});

describe('the mobility label helper (Lead comment and PDF)', () => {
  test.each([
    ['walking', 'Walking'],
    ['bedridden,wheelchair', 'Bedridden, Wheelchair'],
    ['bedridden,wheelchair,walking', 'Bedridden, Wheelchair, Walking'],
    ['wheelchair, walking', 'Wheelchair, Walking'],
    ['flying', undefined],
    ['__proto__', undefined],
    ['constructor,walking', 'Walking'],
    ['', undefined],
    [null, undefined],
    [undefined, undefined],
    [5, undefined],
  ])('%p -> %p', (value, label) => {
    expect(constants.mobilityText(value)).toBe(label);
  });
});

describe('the widened Mobility column (migration prepared, not applied)', () => {
  const folder = '20261116100000_widen_service_request_mobility';

  test('schema.prisma and the migration agree: VARCHAR(191), nullable', () => {
    expect(read('prisma', 'schema.prisma')).toMatch(/mobility\s+String\?\s+@db\.VarChar\(191\)/);
    const sql = read('prisma', 'migrations', folder, 'migration.sql');
    expect(sql).toMatch(/ALTER TABLE `service_requests` MODIFY `mobility` VARCHAR\(191\) NULL;/);
    expect(sql).not.toMatch(/DROP|DELETE|UPDATE |TRUNCATE/i);
  });

  test('comes after the existing migrations, has a hand-run rollback with its precondition, and says it is not applied by the code change', () => {
    const names = fs.readdirSync(path.join(BACKEND, 'prisma', 'migrations')).filter((n) => /^\d{14}_/.test(n)).sort();
    expect(names).toContain(folder);
    expect(names.indexOf(folder)).toBeGreaterThan(names.indexOf('20261113000800_private_charter_m9_case_service_request_fk')); // after the last applied one
    const down = read('prisma', 'migrations', folder, 'down.sql');
    expect(down).toMatch(/MODIFY `mobility` VARCHAR\(16\) NULL;/);
    expect(down).toMatch(/CHAR_LENGTH\(mobility\) > 16/);
    expect(read('prisma', 'migrations', folder, 'migration.sql')).toMatch(/NOT applied/);
  });

  test('the longest value the validator can produce does not fit the old column and fits the new one', () => {
    const { data } = validatePrivateCharterRequest(body({ mobility: ['walking', 'wheelchair', 'bedridden'] }), { cities: CITIES });
    expect(data.mobility).toBe('bedridden,wheelchair,walking');
    expect(data.mobility.length).toBeGreaterThan(16);
    expect(data.mobility.length).toBeLessThanOrEqual(191);
  });
});
