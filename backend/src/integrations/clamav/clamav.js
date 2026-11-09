// ClamAV client (clamd INSTREAM protocol over TCP). Used to scan every document a patient uploads
// in the request-first review workflow before anyone can open it.
//
// FAILS CLOSED. scanFile never resolves "clean" unless clamd answers exactly "stream: OK". A
// refused connection, a timeout, a malformed answer, a size-limit error or an unreadable file all
// resolve { status: 'error' }, and a document in that state stays unavailable to everyone (the
// scan job tries it again later). It never rejects, so callers cannot forget to handle a failure.
//
// Settings (environment): CLAMAV_HOST (default 127.0.0.1), CLAMAV_PORT (default 3310),
// CLAMAV_TIMEOUT_MS (default 20000): the TOTAL time one scan may take, from connecting to the verdict.
// A scanner that keeps the connection busy but never answers (a drip of bytes resets an idle timer
// forever) is cut off by this deadline; a silent one is also cut off by the idle timeout.
const fs = require('fs');
const net = require('net');

const ENGINE = 'clamav';
const CHUNK_BYTES = 64 * 1024;

function settings() {
  const port = Number(process.env.CLAMAV_PORT);
  const timeoutMs = Number(process.env.CLAMAV_TIMEOUT_MS);
  return {
    host: process.env.CLAMAV_HOST || '127.0.0.1',
    port: Number.isInteger(port) && port > 0 ? port : 3310,
    timeoutMs: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000,
  };
}

const failure = (detail) => ({ status: 'error', detail: String(detail).slice(0, 200) });

// clamd's answer to INSTREAM: "stream: OK", "stream: <signature> FOUND" or "<message> ERROR".
function readVerdict(raw) {
  const text = String(raw).replace(/\0/g, '').trim();
  if (text === 'stream: OK') return { status: 'clean' };
  const found = /^stream: (.{1,200}) FOUND$/.exec(text);
  if (found) return { status: 'infected', signature: found[1] };
  return failure(text ? `unexpected answer: ${text}` : 'no answer');
}

function scanFile(filePath, options = {}) {
  const { host, port, timeoutMs } = { ...settings(), ...options };
  return new Promise((resolve) => {
    let settled = false;
    let answer = '';
    const socket = net.createConnection({ host, port });
    // One timer for the whole scan: it does not restart when bytes arrive.
    const deadline = setTimeout(() => finish(failure('scan deadline exceeded')), timeoutMs);
    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(verdict);
    };

    socket.setTimeout(timeoutMs, () => finish(failure('scan timed out')));
    socket.on('error', (err) => finish(failure(`cannot reach the scanner (${err.code || err.message})`)));
    socket.on('data', (data) => { answer += data.toString('utf8'); });
    // clamd closes the connection after its verdict, so the whole answer has arrived by now.
    socket.on('close', () => finish(readVerdict(answer)));

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      const file = fs.createReadStream(filePath, { highWaterMark: CHUNK_BYTES });
      file.on('data', (chunk) => {
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length);
        if (!socket.write(Buffer.concat([size, chunk]))) {
          file.pause();
          socket.once('drain', () => file.resume());
        }
      });
      file.on('end', () => socket.write(Buffer.alloc(4))); // a zero-length chunk ends the stream
      file.on('error', (err) => finish({ ...failure(`cannot read the file (${err.code || err.message})`), fsCode: err.code }));
    });
  });
}

// Is clamd answering? Sends PING and expects exactly PONG. Resolves true or false, never rejects, and never takes
// longer than min(timeoutMs, 5 s). The scan worker asks this before a sweep, so an outage uses up no retry attempts.
function ping(options = {}) {
  const { host, port, timeoutMs } = { ...settings(), ...options };
  return new Promise((resolve) => {
    let settled = false;
    let answer = '';
    const socket = net.createConnection({ host, port });
    const isPong = () => answer.replace(/\0/g, '').trim() === 'PONG';
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(ok);
    };
    const deadline = setTimeout(() => finish(false), Math.min(timeoutMs, 5000));
    socket.on('error', () => finish(false));
    socket.on('connect', () => socket.write('zPING\0'));
    socket.on('data', (data) => {
      answer += data.toString('utf8');
      if (answer.includes('\0') || answer.includes('\n')) finish(isPong());
    });
    socket.on('close', () => finish(isPong()));
  });
}

module.exports = { scanFile, ping, ENGINE, settings };
