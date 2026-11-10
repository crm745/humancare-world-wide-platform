// A stand-in for clamd for the tests: speaks the real INSTREAM protocol over TCP, so the real
// client (src/integrations/clamav/clamav.js) is what is under test. Real ClamAV is not needed.
//
// Modes (changeable while running):
//   ok       "stream: OK", or "<signature> FOUND" when the content contains the text EICAR-TEST
//   garbage  an error answer
//   wrongok  an answer that merely starts with the word OK (must not count as clean)
//   hang     reads everything and never answers
//   drip     never finishes an answer but sends a byte every 50 ms (an idle timeout never fires)
//   close    drops the connection without an answer
const net = require('net');

function startFakeClamd(mode = 'ok') {
  const state = { mode, scans: 0, contents: [] };
  const server = net.createServer((socket) => {
    let received = Buffer.alloc(0);
    let commandSeen = false;
    socket.on('error', () => {});
    socket.on('data', (data) => {
      received = Buffer.concat([received, data]);
      if (!commandSeen) {
        const end = received.indexOf(0);
        if (end < 0) return;
        const command = received.subarray(0, end).toString();
        if (command === 'zPING') {
          state.pings = (state.pings || 0) + 1;
          if (state.mode === 'hang' || state.mode === 'drip') return; // never answers
          if (state.mode === 'close') { socket.destroy(); return; }
          socket.end(state.mode === 'garbage' ? 'UNKNOWN COMMAND ERROR\0' : 'PONG\0');
          return;
        }
        if (command !== 'zINSTREAM') { socket.end('UNKNOWN COMMAND ERROR\0'); return; }
        received = received.subarray(end + 1);
        commandSeen = true;
      }
      const chunks = [];
      let offset = 0;
      while (received.length - offset >= 4) {
        const length = received.readUInt32BE(offset);
        if (length === 0) { answer(Buffer.concat(chunks)); return; }
        if (received.length - offset - 4 < length) break;
        chunks.push(received.subarray(offset + 4, offset + 4 + length));
        offset += 4 + length;
      }
    });

    function answer(content) {
      state.scans += 1;
      state.contents.push(content);
      if (state.mode === 'hang') return;
      if (state.mode === 'drip') {
        const timer = setInterval(() => socket.write('s'), 50);
        socket.on('close', () => clearInterval(timer));
        return;
      }
      if (state.mode === 'close') { socket.destroy(); return; }
      if (state.mode === 'garbage') { socket.end('INSTREAM size limit exceeded. ERROR\0'); return; }
      if (state.mode === 'wrongok') { socket.end('stream: OK, probably\0'); return; }
      socket.end(content.includes('EICAR-TEST') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
        setMode: (next) => { state.mode = next; },
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
      });
    });
  });
}

// A port nothing listens on (the scanner is "down").
async function unusedPort() {
  const probe = await startFakeClamd();
  const { port } = probe;
  await probe.close();
  return port;
}

module.exports = { startFakeClamd, unusedPort };
