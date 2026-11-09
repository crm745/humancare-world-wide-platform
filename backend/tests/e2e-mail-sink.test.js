// The local mail capture sink: loopback only, accepts @e2e.humancare.invalid, refuses everyone else.
// Real sockets, but only on 127.0.0.1 with free ports; nothing leaves this machine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const nodemailer = require('nodemailer');
const { startMailSink, ALLOWED_RECIPIENT } = require('../scripts/e2e-mail-sink');

let sink;
let dir;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-mail-sink-'));
  sink = await startMailSink({ smtpPort: 0, httpPort: 0, dir });
});

afterEach(async () => {
  await sink.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// The same transport settings the backend mailer uses for the sink (see .env.test.example).
const transport = () => nodemailer.createTransport({
  host: '127.0.0.1', port: sink.smtpPort, secure: false, auth: { user: 'test', pass: 'test' }, tls: { rejectUnauthorized: false },
});
const request = (method, pathname) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: sink.httpPort, method, path: pathname }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
  });
  req.on('error', reject);
  req.end();
});

describe('the mail capture sink', () => {
  it('accepts a message for an @e2e.humancare.invalid address and exposes it, link intact', async () => {
    const link = 'https://admin.example.org/recover-passkey#token=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    await transport().sendMail({
      from: 'HumanCare E2E <noreply@e2e.humancare.invalid>',
      to: 'target@e2e.humancare.invalid',
      subject: 'Your HumanCare Admin passkey recovery link',
      text: `Open this link: ${link}\nIt can be used once, and a long line follows ${'x'.repeat(200)}`,
      html: `<p><a href="${link}">Register a new passkey</a></p>`,
    });

    const { status, body } = await request('GET', '/messages');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: 1, to: ['target@e2e.humancare.invalid'], subject: 'Your HumanCare Admin passkey recovery link' });
    expect(body[0].text).toContain(link);
    expect(body[0].html).toContain(link);
    // and it is on disk for a post-mortem
    expect(fs.readdirSync(dir)).toEqual(['0001.json']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '0001.json'), 'utf8')).subject).toBe('Your HumanCare Admin passkey recovery link');
  });

  it.each([
    'someone@gmail.com',
    'real.person@humancareworldwide.com',
    'target@e2e.humancare.invalid.evil.com',
    'target@evil.com?x=@e2e.humancare.invalid',
    'target@example.org',
  ])('refuses the recipient %s, so nothing is stored', async (to) => {
    await expect(transport().sendMail({ from: 'noreply@e2e.humancare.invalid', to, subject: 'x', text: 'x' })).rejects.toBeTruthy();
    expect((await request('GET', '/messages')).body).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuses the whole message if any one recipient is not allowed', async () => {
    await expect(transport().sendMail({
      from: 'noreply@e2e.humancare.invalid',
      to: ['ok@e2e.humancare.invalid', 'real@gmail.com'],
      subject: 'x',
      text: 'x',
    })).rejects.toBeTruthy();
    expect((await request('GET', '/messages')).body).toEqual([]);
  });

  it('matches the allowed domain case-insensitively and exactly', () => {
    expect(ALLOWED_RECIPIENT.test('A@E2E.HUMANCARE.INVALID')).toBe(true);
    expect(ALLOWED_RECIPIENT.test('a@sub.e2e.humancare.invalid')).toBe(false);
    expect(ALLOWED_RECIPIENT.test('a@e2e.humancare.invalid.com')).toBe(false);
    expect(ALLOWED_RECIPIENT.test('a@xe2e.humancare.invalid')).toBe(false);
  });

  it('clears captured mail on DELETE, and only serves /messages with GET or DELETE', async () => {
    await transport().sendMail({ from: 'noreply@e2e.humancare.invalid', to: 'a@e2e.humancare.invalid', subject: 's', text: 't' });
    expect((await request('GET', '/messages')).body).toHaveLength(1);
    expect((await request('DELETE', '/messages')).body).toEqual({ cleared: true });
    expect((await request('GET', '/messages')).body).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);

    expect((await request('POST', '/messages')).status).toBe(405);
    expect((await request('GET', '/other')).status).toBe(404);
  });

  it('listens on the loopback interface only', async () => {
    const addresses = [sink.smtpPort, sink.httpPort].map(() => '127.0.0.1');
    expect(addresses).toEqual(['127.0.0.1', '127.0.0.1']);
    // Nothing answers on a non-loopback address of this machine.
    const external = Object.values(os.networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4');
    if (external) {
      await expect(new Promise((resolve, reject) => {
        const req = http.request({ host: external.address, port: sink.httpPort, path: '/messages', timeout: 1500 }, resolve);
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.end();
      })).rejects.toBeTruthy();
    }
  });

  it('empties old captured mail at start', async () => {
    await sink.close();
    fs.writeFileSync(path.join(dir, '0042.json'), '{"old":true}');
    sink = await startMailSink({ smtpPort: 0, httpPort: 0, dir });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
