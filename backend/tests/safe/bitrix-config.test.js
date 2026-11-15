/* global describe, test, expect, afterEach */
// The Bitrix switches and the start-up check. Pure: no database, no network, no environment file.
const {
  isBitrixSyncEnabled, isPrivateCharterDealRequested, isPrivateCharterDealEnabled, bitrixConfigurationProblems, assertBitrixConfiguration,
} = require('../../src/modules/bitrix/bitrix-config');

const env = (over = {}) => ({ ...over });

describe('the master switch is unchanged', () => {
  test.each([[undefined, false], ['', false], ['true', true], ['TRUE', false], ['1', false], ['yes', false], [' true', false], ['false', false]])(
    'BITRIX_SYNC_ENABLED=%p -> %p', (value, expected) => {
      expect(isBitrixSyncEnabled(env({ BITRIX_SYNC_ENABLED: value }))).toBe(expected);
    },
  );
});

describe('BITRIX_PRIVATE_CHARTER_DEAL_ENABLED', () => {
  test.each([[undefined, false], ['', false], ['true', true], ['TRUE', false], ['1', false], ['on', false], ['false', false]])(
    'is on only when it is exactly "true": %p -> %p', (value, expected) => {
      expect(isPrivateCharterDealRequested(env({ BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: value }))).toBe(expected);
    },
  );

  test('the Deal worker may run only when BOTH the Deal switch and the master switch are on', () => {
    const on = 'true';
    expect(isPrivateCharterDealEnabled(env({ BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: on, BITRIX_SYNC_ENABLED: on }))).toBe(true);
    expect(isPrivateCharterDealEnabled(env({ BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: on }))).toBe(false);
    expect(isPrivateCharterDealEnabled(env({ BITRIX_SYNC_ENABLED: on }))).toBe(false);
    expect(isPrivateCharterDealEnabled(env())).toBe(false);
  });

  test('it is off by default, and the default settings are valid', () => {
    expect(isPrivateCharterDealRequested(env())).toBe(false);
    expect(bitrixConfigurationProblems(env())).toEqual([]);
    expect(() => assertBitrixConfiguration(env())).not.toThrow();
  });

  test('turning only the master switch on needs nothing else (Leads work as before)', () => {
    expect(bitrixConfigurationProblems(env({ BITRIX_SYNC_ENABLED: 'true' }))).toEqual([]);
    expect(bitrixConfigurationProblems(env({ BITRIX_SYNC_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' }))).toEqual([]);
  });
});

describe('start-up validation', () => {
  const deal = { BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true' };

  test('the Deal switch needs the master switch', () => {
    const problems = bitrixConfigurationProblems(env({ ...deal, PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' }));
    expect(problems).toEqual(['BITRIX_PRIVATE_CHARTER_DEAL_ENABLED=true needs BITRIX_SYNC_ENABLED=true.']);
  });

  test('the Deal switch needs the review workflow', () => {
    const problems = bitrixConfigurationProblems(env({ ...deal, BITRIX_SYNC_ENABLED: 'true' }));
    expect(problems).toEqual(['BITRIX_PRIVATE_CHARTER_DEAL_ENABLED=true needs PRIVATE_CHARTER_REVIEW_WORKFLOW=true.']);
    expect(bitrixConfigurationProblems(env({ ...deal, BITRIX_SYNC_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'false' }))).toHaveLength(1);
  });

  test('every problem is named when several apply, and the start-up refuses', () => {
    expect(bitrixConfigurationProblems(env(deal))).toHaveLength(2);
    expect(() => assertBitrixConfiguration(env(deal))).toThrow(/BITRIX_SYNC_ENABLED[\s\S]*PRIVATE_CHARTER_REVIEW_WORKFLOW/);
  });

  test('all three switches on is valid', () => {
    const all = env({ ...deal, BITRIX_SYNC_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' });
    expect(bitrixConfigurationProblems(all)).toEqual([]);
    expect(() => assertBitrixConfiguration(all)).not.toThrow();
  });

  test('a misspelled Deal switch keeps it off, so it cannot make a valid setup invalid', () => {
    expect(bitrixConfigurationProblems(env({ BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'TRUE' }))).toEqual([]);
  });
});

describe('the functions read process.env by default', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of ['BITRIX_SYNC_ENABLED', 'BITRIX_PRIVATE_CHARTER_DEAL_ENABLED', 'PRIVATE_CHARTER_REVIEW_WORKFLOW']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  test('without an argument', () => {
    process.env.BITRIX_PRIVATE_CHARTER_DEAL_ENABLED = 'true';
    process.env.BITRIX_SYNC_ENABLED = 'true';
    expect(isPrivateCharterDealEnabled()).toBe(true);
    expect(bitrixConfigurationProblems()).toHaveLength(1);
  });
});
