// Local email capture for the test environment. Nothing here can send mail anywhere.
//
//   node scripts/e2e-mail-sink.js
//
// A tiny SMTP server on 127.0.0.1:1025 that the backend's own mailer (EMAIL_PROVIDER=smtp,
// SMTP_HOST=127.0.0.1, SMTP_PORT=1025) delivers to during real-browser tests. It
//   - listens on the loopback interface only (SMTP and HTTP);
//   - REFUSES every recipient outside @e2e.humancare.invalid (a reserved, undeliverable domain), and
//     refuses the WHOLE message if any recipient is outside it, so a stray real address makes the
//     send fail visibly;
//   - never relays: accepted messages are only stored, as JSON, in backend/.e2e-mail/ (Git-ignored);
//   - serves them at http://127.0.0.1:1080/messages (GET) and clears them with DELETE /messages,
//     so tests can read the invitation or recovery link. Captured mail holds live one-time tokens:
//     the folder is emptied at start and should be removed after a run.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');

const HOST = '127.0.0.1';
const DEFAULT_SMTP_PORT = 1025;
const DEFAULT_HTTP_PORT = 1080;
const ALLOWED_RECIPIENT = /@e2e\.humancare\.invalid$/i;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_DIR = path.resolve(__dirname, '..', '.e2e-mail');

function emptyDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.json')) fs.rmSync(path.join(dir, name), { force: true });
  }
}

/**
 * Starts the sink. Resolves with { smtpPort, httpPort, messages(), clear(), close() }.
 * Pass 0 for a port to take any free one (tests do).
 */
async function startMailSink({ smtpPort = DEFAULT_SMTP_PORT, httpPort = DEFAULT_HTTP_PORT, dir = DEFAULT_DIR } = {}) {
  emptyDir(dir);
  const messages = [];
  let counter = 0;

  const smtp = new SMTPServer({
    name: 'e2e-mail-sink',
    authOptional: true,
    allowInsecureAuth: true, // the mailer sends test credentials; there is no TLS on loopback
    disabledCommands: ['STARTTLS'],
    size: MAX_MESSAGE_BYTES,
    onAuth: (_auth, _session, callback) => callback(null, { user: 'sink' }), // any login, it is a sink
    onMailFrom(_address, session, callback) {
      session.hadDisallowedRecipient = false; // a new message on this connection starts clean
      return callback();
    },
    onRcptTo(address, session, callback) {
      if (!ALLOWED_RECIPIENT.test(address.address)) {
        // Remembered so the whole message is refused at DATA: a mixed list must fail visibly, not
        // quietly deliver to the allowed addresses and leave the stray one unnoticed.
        session.hadDisallowedRecipient = true;
        const error = new Error('Recipient not allowed: only @e2e.humancare.invalid is accepted by the test mail sink');
        error.responseCode = 550;
        return callback(error);
      }
      return callback();
    },
    onData(stream, session, callback) {
      if (session.hadDisallowedRecipient) {
        stream.resume(); // drain and discard
        const error = new Error('Message refused: it names a recipient outside @e2e.humancare.invalid');
        error.responseCode = 550;
        return stream.on('end', () => callback(error));
      }
      return simpleParser(stream)
        .then((parsed) => {
          counter += 1;
          const message = {
            id: counter,
            receivedAt: new Date().toISOString(),
            from: parsed.from ? parsed.from.text : null,
            to: parsed.to ? [].concat(parsed.to).flatMap((t) => t.value.map((v) => v.address)) : [],
            subject: parsed.subject || '',
            text: parsed.text || '',
            html: parsed.html || '',
          };
          messages.push(message);
          fs.writeFileSync(path.join(dir, `${String(counter).padStart(4, '0')}.json`), JSON.stringify(message, null, 2));
          callback();
        })
        .catch(callback);
    },
  });
  smtp.on('error', () => {}); // a client dropping mid-message must not crash the sink

  const web = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.url !== '/messages') return send(404, { error: 'not found' });
    if (req.method === 'GET') return send(200, messages);
    if (req.method === 'DELETE') {
      messages.length = 0;
      emptyDir(dir);
      return send(200, { cleared: true });
    }
    return send(405, { error: 'method not allowed' });
  });

  const listen = (server, port) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => resolve(server.address().port));
  });
  const actualSmtpPort = await listen(smtp.server, smtpPort);
  const actualHttpPort = await listen(web, httpPort);

  return {
    smtpPort: actualSmtpPort,
    httpPort: actualHttpPort,
    messages: () => [...messages],
    clear: () => { messages.length = 0; emptyDir(dir); },
    close: () => Promise.all([new Promise((r) => smtp.close(r)), new Promise((r) => web.close(r))]).then(() => undefined),
  };
}

if (require.main === module) {
  startMailSink()
    .then((sink) => {
      console.log(`Test mail sink: SMTP ${HOST}:${sink.smtpPort}, messages at http://${HOST}:${sink.httpPort}/messages`);
      console.log('Accepts only @e2e.humancare.invalid recipients. Nothing is relayed. Ctrl+C to stop.');
    })
    .catch((err) => {
      console.error(`Could not start the test mail sink: ${err.code || err.name}`);
      process.exit(1);
    });
}

module.exports = { startMailSink, ALLOWED_RECIPIENT, DEFAULT_DIR };
