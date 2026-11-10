// Runs a snippet of Node code in a CHILD process whose TZ really is the given zone.
//
// Why a child: Jest runs tests in a sandbox whose process.env is a copy, so setting
// process.env.TZ inside a test does not change the timezone Date uses; a test that "tries four
// timezones" that way tests nothing. A child process started with TZ in its environment does.
//
// The code runs with the backend folder as its working directory and should print one line of
// JSON; the parsed value is returned.
const path = require('path');
const { spawnSync } = require('child_process');

const BACKEND = path.join(__dirname, '..', '..');

function inTimeZone(zone, code, args = []) {
  const result = spawnSync(process.execPath, ['-e', code, '--', ...args], {
    cwd: BACKEND, encoding: 'utf8', timeout: 60000, env: { ...process.env, TZ: zone, NODE_ENV: 'test' },
  });
  if (result.status !== 0) throw new Error(`child (${zone}) failed: ${result.stderr || result.stdout}`);
  const lastLine = result.stdout.trim().split('\n').pop();
  return JSON.parse(lastLine);
}

module.exports = { inTimeZone };
