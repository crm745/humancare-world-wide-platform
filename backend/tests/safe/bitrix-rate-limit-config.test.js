/* global describe, test, expect, jest */
// The configurable, shared Bitrix24 rate limit: defaults, valid overrides, invalid values (refused at start-up, never silently replaced), and the fact that
// there is exactly ONE limiter and ONE breaker for every worker. No database, no network, no .env.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const fs = require('fs');
const path = require('path');
const { bitrixRateLimitSettings, RATE_LIMIT_DEFAULTS, bitrixConfigurationProblems, assertBitrixConfiguration } = require('../../src/modules/bitrix/bitrix-config');
const { sharedDispatcher, sharedLimiter, gatewayFor, gatewayForPass } = require('../../src/modules/bitrix/queue/dispatcher');
const { createRateLimiter } = require('../../src/modules/bitrix/queue/rate-limiter');

const NAMES = ['BITRIX_RATE_LIMIT_PER_SECOND', 'BITRIX_RATE_LIMIT_BURST', 'BITRIX_MAX_CONCURRENT_REQUESTS'];

describe('defaults', () => {
  test('are 2 per second, burst 10, concurrency 1', () => {
    expect(RATE_LIMIT_DEFAULTS).toEqual({ ratePerSecond: 2, burst: 10, maxConcurrent: 1 });
    expect(Object.isFrozen(RATE_LIMIT_DEFAULTS)).toBe(true);
  });

  test.each([
    ['nothing set', {}],
    ['empty values', { BITRIX_RATE_LIMIT_PER_SECOND: '', BITRIX_RATE_LIMIT_BURST: '', BITRIX_MAX_CONCURRENT_REQUESTS: '' }],
    ['blank values', { BITRIX_RATE_LIMIT_PER_SECOND: '   ', BITRIX_RATE_LIMIT_BURST: ' ' }],
  ])('%s -> the defaults, no problems', (_n, env) => {
    expect(bitrixRateLimitSettings(env)).toEqual({ settings: { ratePerSecond: 2, burst: 10, maxConcurrent: 1 }, problems: [] });
    expect(bitrixConfigurationProblems(env)).toEqual([]);
  });

  test('the shared limiter built from an empty environment is the default one', () => {
    expect(sharedLimiter({}).snapshot()).toMatchObject({ ratePerSecond: 2, burst: 10, maxConcurrent: 1 });
  });
});

describe('valid overrides', () => {
  test.each([
    [{ BITRIX_RATE_LIMIT_PER_SECOND: '5' }, { ratePerSecond: 5, burst: 10, maxConcurrent: 1 }],
    [{ BITRIX_RATE_LIMIT_PER_SECOND: '0.5' }, { ratePerSecond: 0.5, burst: 10, maxConcurrent: 1 }],
    [{ BITRIX_RATE_LIMIT_BURST: '25' }, { ratePerSecond: 2, burst: 25, maxConcurrent: 1 }],
    [{ BITRIX_MAX_CONCURRENT_REQUESTS: '3' }, { ratePerSecond: 2, burst: 10, maxConcurrent: 3 }],
    [{ BITRIX_RATE_LIMIT_PER_SECOND: ' 4 ', BITRIX_RATE_LIMIT_BURST: ' 8 ', BITRIX_MAX_CONCURRENT_REQUESTS: ' 2 ' }, { ratePerSecond: 4, burst: 8, maxConcurrent: 2 }],
    [{ BITRIX_RATE_LIMIT_PER_SECOND: '50', BITRIX_RATE_LIMIT_BURST: '1000', BITRIX_MAX_CONCURRENT_REQUESTS: '20' }, { ratePerSecond: 50, burst: 1000, maxConcurrent: 20 }], // the bounds themselves
    [{ BITRIX_RATE_LIMIT_BURST: '1', BITRIX_MAX_CONCURRENT_REQUESTS: '1' }, { ratePerSecond: 2, burst: 1, maxConcurrent: 1 }],
  ])('%j', (env, expected) => {
    expect(bitrixRateLimitSettings(env)).toEqual({ settings: expected, problems: [] });
    expect(bitrixConfigurationProblems(env)).toEqual([]);
    expect(() => assertBitrixConfiguration(env)).not.toThrow();
  });

  test('the shared limiter really takes the overrides', () => {
    expect(sharedLimiter({ BITRIX_RATE_LIMIT_PER_SECOND: '4', BITRIX_RATE_LIMIT_BURST: '7', BITRIX_MAX_CONCURRENT_REQUESTS: '2' }).snapshot())
      .toMatchObject({ ratePerSecond: 4, burst: 7, maxConcurrent: 2, tokens: 7 });
  });

  test('a larger concurrency lets that many calls run at once, and no more; a smaller burst paces sooner', async () => {
    const clock = { t: 0 };
    const sleep = async (ms) => { clock.t += ms; };
    const two = createRateLimiter({ ...bitrixRateLimitSettings({ BITRIX_MAX_CONCURRENT_REQUESTS: '2' }).settings, now: () => clock.t, sleep });
    const a = await two.acquire();
    const b = await two.acquire();
    expect(two.snapshot().inFlight).toBe(2);
    expect(await two.acquire({ timeoutMs: 200 })).toBeNull(); // the third waits for a slot
    a();
    b();
    const tight = createRateLimiter({ ...bitrixRateLimitSettings({ BITRIX_RATE_LIMIT_BURST: '1', BITRIX_RATE_LIMIT_PER_SECOND: '1', BITRIX_MAX_CONCURRENT_REQUESTS: '5' }).settings, now: () => clock.t, sleep });
    (await tight.acquire())();
    const before = clock.t;
    (await tight.acquire({ timeoutMs: 5000 }))();
    expect(clock.t - before).toBeGreaterThanOrEqual(900); // burst 1 at 1 per second: the second call waits about a second
  });
});

describe('invalid values are never silently accepted', () => {
  test.each([
    ['BITRIX_RATE_LIMIT_PER_SECOND', '0'],
    ['BITRIX_RATE_LIMIT_PER_SECOND', '0.0'],
    ['BITRIX_RATE_LIMIT_PER_SECOND', '-1'],
    ['BITRIX_RATE_LIMIT_PER_SECOND', 'abc'],
    ['BITRIX_RATE_LIMIT_PER_SECOND', '2x'],
    ['BITRIX_RATE_LIMIT_PER_SECOND', '1e3'],
    ['BITRIX_RATE_LIMIT_PER_SECOND', '0x10'],
    ['BITRIX_RATE_LIMIT_PER_SECOND', 'NaN'],
    ['BITRIX_RATE_LIMIT_PER_SECOND', 'Infinity'],
    ['BITRIX_RATE_LIMIT_PER_SECOND', '1,5'],
    ['BITRIX_RATE_LIMIT_PER_SECOND', '50.1'],
    ['BITRIX_RATE_LIMIT_PER_SECOND', '99999'],
    ['BITRIX_RATE_LIMIT_BURST', '0'],
    ['BITRIX_RATE_LIMIT_BURST', '-5'],
    ['BITRIX_RATE_LIMIT_BURST', '2.5'],
    ['BITRIX_RATE_LIMIT_BURST', 'ten'],
    ['BITRIX_RATE_LIMIT_BURST', '1001'],
    ['BITRIX_MAX_CONCURRENT_REQUESTS', '0'],
    ['BITRIX_MAX_CONCURRENT_REQUESTS', '1.5'],
    ['BITRIX_MAX_CONCURRENT_REQUESTS', '-1'],
    ['BITRIX_MAX_CONCURRENT_REQUESTS', 'many'],
    ['BITRIX_MAX_CONCURRENT_REQUESTS', '21'],
  ])('%s=%s is refused, naming the variable, and the default is NOT quietly substituted at start-up', (name, value) => {
    const env = { [name]: value };
    const { problems } = bitrixRateLimitSettings(env);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(name);
    expect(bitrixConfigurationProblems(env)).toEqual(problems);
    expect(() => assertBitrixConfiguration(env)).toThrow(new RegExp(`Bitrix24 settings are not valid:.*${name}`));
    expect(() => sharedLimiter(env)).toThrow(new RegExp(`rate-limit settings are not valid:.*${name}`));
  });

  test('every bad variable is named at once, and a good one next to a bad one is still reported correctly', () => {
    const env = { BITRIX_RATE_LIMIT_PER_SECOND: '0', BITRIX_RATE_LIMIT_BURST: 'x', BITRIX_MAX_CONCURRENT_REQUESTS: '2' };
    const { settings, problems } = bitrixRateLimitSettings(env);
    expect(problems).toHaveLength(2);
    expect(problems.join(' ')).toContain('BITRIX_RATE_LIMIT_PER_SECOND');
    expect(problems.join(' ')).toContain('BITRIX_RATE_LIMIT_BURST');
    expect(problems.join(' ')).not.toContain('BITRIX_MAX_CONCURRENT_REQUESTS');
    expect(settings.maxConcurrent).toBe(2);
  });

  test('refused whether or not any Bitrix switch is on, and a long junk value is not echoed in full', () => {
    expect(() => assertBitrixConfiguration({ BITRIX_RATE_LIMIT_BURST: '0' })).toThrow(/BITRIX_RATE_LIMIT_BURST/);
    const [message] = bitrixRateLimitSettings({ BITRIX_RATE_LIMIT_BURST: 'x'.repeat(200) }).problems;
    expect(message.length).toBeLessThan(150);
  });

  test('the rate-limit rules do not disturb the existing combination checks', () => {
    const env = { BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', BITRIX_RATE_LIMIT_BURST: '5' };
    const problems = bitrixConfigurationProblems(env);
    expect(problems.some((p) => p.includes('needs BITRIX_SYNC_ENABLED'))).toBe(true);
    expect(problems.some((p) => p.includes('BITRIX_RATE_LIMIT'))).toBe(false);
  });
});

describe('one limiter and one breaker for every worker', () => {
  test('the Deal, document, quotation, inbox, reconciliation and legacy Lead paths all resolve to the very same shared gateway', () => {
    const shared = sharedDispatcher();
    expect(sharedDispatcher()).toBe(shared);
    expect(gatewayFor({})).toBe(shared); // the API layer, used by every worker's calls and by the file download
    expect(gatewayForPass({})).toBe(shared); // the pass-level check of every worker
    expect(gatewayFor({ fetchImpl: () => {} })).toBeNull(); // a stand-in fetch makes no real call
  });

  test('the shared gateway is sized from the environment once, at first use', async () => {
    await jest.isolateModulesAsync(async () => {
      process.env.BITRIX_RATE_LIMIT_PER_SECOND = '3';
      process.env.BITRIX_RATE_LIMIT_BURST = '6';
      process.env.BITRIX_MAX_CONCURRENT_REQUESTS = '2';
      try {
        const { sharedDispatcher: fresh } = require('../../src/modules/bitrix/queue/dispatcher');
        expect(fresh().snapshot().limiter).toMatchObject({ ratePerSecond: 3, burst: 6, maxConcurrent: 2 });
      } finally {
        for (const name of NAMES) delete process.env[name];
      }
    });
  });

  test('an invalid value stops even a script that never ran the start-up check, instead of running with a different limit', async () => {
    await jest.isolateModulesAsync(async () => {
      process.env.BITRIX_RATE_LIMIT_BURST = '0';
      try {
        const { sharedDispatcher: fresh } = require('../../src/modules/bitrix/queue/dispatcher');
        expect(() => fresh()).toThrow(/BITRIX_RATE_LIMIT_BURST/);
      } finally {
        delete process.env.BITRIX_RATE_LIMIT_BURST;
      }
    });
  });

  test('no other rate limiter exists: createRateLimiter() is called in the dispatcher and nowhere else in src', () => {
    const root = path.join(__dirname, '../../src');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const users = walk(root).filter((f) => f.endsWith('.js') && /createRateLimiter\s*\(/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f).replace(/\\/g, '/')).sort();
    expect(users).toEqual(['modules/bitrix/queue/dispatcher.js', 'modules/bitrix/queue/rate-limiter.js']);
  });

  test('the example configuration documents all three variables and holds no secret', () => {
    const text = fs.readFileSync(path.join(__dirname, '../../.env.example'), 'utf8');
    for (const name of NAMES) expect(text).toMatch(new RegExp(`^${name}=`, 'm'));
    expect(text).toMatch(/BITRIX_RATE_LIMIT_PER_SECOND=2\b/);
    expect(text).toMatch(/BITRIX_RATE_LIMIT_BURST=10\b/);
    expect(text).toMatch(/BITRIX_MAX_CONCURRENT_REQUESTS=1\b/);
    // The two push-delivery settings share the file; they are documented and checked (empty token, switch OFF) in push-delivery-monitor.test.js.
    const PUSH_VARIABLES = ['PUSH_DELIVERY_ENABLED', 'EXPO_PUSH_ACCESS_TOKEN'];
    const assignments = text.split(/\r?\n/).filter((line) => /^[A-Z0-9_]+=/.test(line) && !PUSH_VARIABLES.includes(line.split('=')[0]));
    expect(assignments.map((line) => line.split('=')[0]).sort()).toEqual([...NAMES].sort()); // exactly these three, nothing else
    for (const line of assignments) expect(line).toMatch(/^[A-Z0-9_]+=\d+$/); // numbers only: no secret, URL or token can be in here
  });
});
