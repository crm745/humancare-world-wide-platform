// Runs before the test framework loads, in every scoped test worker. The environment is the one the global setup built
// (the .env.test values only, Bitrix off, this run's uploads folder); this file validates it again, so a worker can never
// run against anything else, and blocks Bitrix calls as a second line of defence.
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const scoped = require('../../src/common/safety/scoped-test-run');
const { BACKEND_ROOT } = require('../../src/common/safety/test-database-guard');

{
  const runId = process.env[scoped.RUN_ID_ENV];
  const parsed = dotenv.parse(fs.readFileSync(path.join(BACKEND_ROOT, '.env.test')));
  const env = scoped.buildScopedEnv(parsed, runId); // validates everything, throws on any problem
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}

delete process.env.BITRIX24_WEBHOOK_URL;
const realFetch = global.fetch;
global.fetch = (url, ...rest) => {
  if (/bitrix24\./i.test(String(url))) {
    return Promise.reject(new Error(`Blocked Bitrix24 call during tests: ${String(url).split('/rest/')[0]}`));
  }
  return realFetch(url, ...rest);
};
