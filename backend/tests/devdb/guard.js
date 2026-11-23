// Loaded before every dev-database test. Refuses to run unless it is explicitly asked to AND the database is `humancare_dev` on this computer.
const path = require('path');
const dotenv = require('dotenv');

if (process.env.HUMANCARE_DEVDB_RUN !== 'true') {
  throw new Error('Refusing to run: set HUMANCARE_DEVDB_RUN=true to run the development-database tests (npm run test:devdb does).');
}
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to run: NODE_ENV must be neither "test" (that guard is for humancare_test) nor "production".');
}
let url;
try { url = new URL(process.env.DATABASE_URL || ''); } catch { throw new Error('Refusing to run: DATABASE_URL is missing or not a URL.'); }
const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname) || database !== 'humancare_dev') {
  throw new Error(`Refusing to run: these tests only run against "humancare_dev" on this computer (got database "${database}" on host "${url.hostname}").`);
}
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'devdb-access-secret-0123456789';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'devdb-refresh-secret-0123456789';
delete process.env.AUTH_ALLOW_LEGACY_TOKENS;
