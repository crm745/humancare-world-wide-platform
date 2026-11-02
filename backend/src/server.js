require('dotenv').config();
const { app } = require('./app');
const { prisma } = require('./db/prisma');

// This process only serves HTTP. Scheduled jobs (Bitrix retry, security-log cleanup) run in
// the separate worker — see worker.js and src/jobs.
const port = process.env.PORT ? Number(process.env.PORT) : 4000;
const server = app.listen(port, () => {
  console.log(`HumanCare backend listening on http://localhost:${port}`);
});

server.on('error', (err) => {
  console.error(`HumanCare backend could not listen on port ${port}:`, err.message);
  process.exit(1);
});

// Long enough for an ordinary request (an upload, the summary PDF) to finish, short enough
// that a deploy never hangs on a stuck connection.
const SHUTDOWN_TIMEOUT_MS = 30 * 1000;
let shuttingDown = false;

// SIGTERM (process manager) and SIGINT (Ctrl+C): stop accepting connections, let requests
// already in progress finish, then close the database connection. A second signal exits
// immediately.
function shutdown(signal) {
  if (shuttingDown) {
    console.error(`${signal} received again, exiting without waiting.`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`${signal} received, closing the HTTP server.`);

  setTimeout(() => {
    console.error(`Requests still open after ${SHUTDOWN_TIMEOUT_MS / 1000}s, forcing shutdown.`);
    server.closeAllConnections();
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  server.close(async (closeErr) => {
    let exitCode = 0;
    if (closeErr) {
      exitCode = 1;
      console.error('Error while closing the HTTP server:', closeErr.message);
    }
    try {
      await prisma.$disconnect();
    } catch (err) {
      exitCode = 1;
      console.error('Error while closing the database connection:', err.message);
    }
    console.log('HumanCare backend stopped.');
    process.exit(exitCode);
  });
  server.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
