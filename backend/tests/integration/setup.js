// Loaded in every integration test worker. Rebuilds the isolated environment from backend/.env.test ONLY, validates it
// with the integration guard, and applies it. Throws (and no test runs) if the opt-in is missing or anything is wrong.
// Prints nothing and changes no data.
const fs = require('fs');
const dotenv = require('dotenv');
const guard = require('../../src/common/safety/integration-runner-guard');

guard.assertOptIn(process.env);
if (!fs.existsSync(guard.ENV_FILE)) throw new Error('backend/.env.test does not exist (see .env.test.example).');
const env = guard.buildIntegrationEnv(dotenv.parse(fs.readFileSync(guard.ENV_FILE)));
// Overwrite, including with empty values: an empty value counts as "already set", so the Prisma client will not
// fill the key in from a development .env.
for (const [key, value] of Object.entries(env)) process.env[key] = value;
