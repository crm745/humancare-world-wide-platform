/* global describe, test, expect, jest */
// The Quotation PDF field (UF_CRM_1794985313, a SINGLE file field) in the Bitrix24 client: getDealFileField, downloadBitrixFile and
// validatePdf. No network and no database: every transport is a mocked fetch, every host and signature is fake.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
const crypto = require('crypto');
const api = require('../../src/modules/bitrix/bitrix-deal.api');

const FIELD = 'UF_CRM_1794985313';
const ENV_ON = {
  BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true',
  BITRIX24_WEBHOOK_URL: 'https://fake-bitrix.invalid/rest/1/FAKE_TOKEN/',
};
const GOOD_URL = 'https://fake-bitrix.invalid/rest/crm.controller.item.getFile?signature=SECRET_SIGNATURE';

// A minimal but structurally correct PDF: header, one object, a classic xref table, startxref pointing at it, %%EOF.
function makePdf(extra = '') {
  const head = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${extra}`;
  const xrefAt = head.length;
  return Buffer.from(`${head}xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`, 'latin1');
}
const PDF = makePdf();
const pdfResponse = (buffer = PDF, init = {}) => new Response(buffer, { status: 200, headers: { 'content-type': 'application/pdf' }, ...init });
const fileObject = (url = GOOD_URL) => { const f = { id: '65728' }; Object.defineProperty(f, 'urlMachine', { value: url, enumerable: false }); return f; };
const download = (response, { file = fileObject(), env = ENV_ON, ...options } = {}) => api.downloadBitrixFile(file, { env, fetchImpl: jest.fn(async () => response), ...options });
const failure = async (promise) => { try { await promise; } catch (err) { return err; } throw new Error('expected a rejection'); };

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });
const itemAnswer = (over = {}) => reply(200, { result: { item: { id: 4350, ...over } } });
const readField = (value, extra = {}) => api.getDealFileField('4350', FIELD, { env: ENV_ON, fetchImpl: jest.fn(async () => itemAnswer({ [FIELD]: value, ...extra })) });

describe('getDealFileField (crm.item.get, a single file field)', () => {
  test('reads the Deal as an item (entityTypeId 2, numeric id, original field names) and returns the file', async () => {
    const fetchImpl = jest.fn(async () => itemAnswer({ [FIELD]: { id: 65728, url: 'https://fake-bitrix.invalid/bitrix/x', urlMachine: GOOD_URL } }));
    const read = await api.getDealFileField('4350', FIELD, { env: ENV_ON, fetchImpl });
    expect(read.status).toBe('ok');
    expect(read.file.id).toBe('65728'); // the numeric id, as exact text
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${ENV_ON.BITRIX24_WEBHOOK_URL}crm.item.get.json`);
    expect(JSON.parse(init.body)).toEqual({ entityTypeId: 2, id: 4350, useOriginalUfNames: 'Y' });
  });

  test('the signed URL is not enumerable: JSON.stringify, spreading and Object.keys cannot leak it, yet the downloader can read it', async () => {
    const { file } = await readField({ id: 65728, url: 'https://fake-bitrix.invalid/bitrix/x', urlMachine: GOOD_URL });
    expect(JSON.stringify(file)).toBe('{"id":"65728"}');
    expect(Object.keys(file)).toEqual(['id']);
    expect({ ...file }).toEqual({ id: '65728' });
    expect(file.urlMachine).toBe(GOOD_URL);
  });

  test.each([['null', null], ['false', false], ['an empty string', ''], ['an empty list', []]])('an empty field (%s) is "no file", not an error', async (_name, value) => {
    expect(await readField(value)).toEqual({ status: 'ok', file: null });
  });

  test.each([
    ['an object with no id', { urlMachine: GOOD_URL }],
    ['an object with a zero id', { id: 0, urlMachine: GOOD_URL }],
    ['an object with a padded id', { id: '007', urlMachine: GOOD_URL }],
    ['an object with a fractional id', { id: 1.5, urlMachine: GOOD_URL }],
    ['an object with no urlMachine', { id: 65728, url: 'https://fake-bitrix.invalid/x' }],
    ['an object with an empty urlMachine', { id: 65728, urlMachine: '' }],
    ['an object with a non-text urlMachine', { id: 65728, urlMachine: 7 }],
    ['a list with a file in it', [{ id: 65728, urlMachine: GOOD_URL }]],
    ['a plain string', 'file.pdf'],
    ['a number', 65728],
    ['true', true],
  ])('does not guess at %s', async (_name, value) => {
    expect(await readField(value)).toEqual({ status: 'uncertain', reason: 'unexpected_file_shape' });
  });

  test('a field that is missing from the answer is uncertain, never read as "empty"', async () => {
    const fetchImpl = jest.fn(async () => itemAnswer());
    expect(await api.getDealFileField('4350', FIELD, { env: ENV_ON, fetchImpl })).toEqual({ status: 'uncertain', reason: 'field_not_in_answer' });
  });

  test('the answer must be for the requested Deal', async () => {
    const fetchImpl = jest.fn(async () => reply(200, { result: { item: { id: 9999, [FIELD]: null } } }));
    expect(await api.getDealFileField('4350', FIELD, { env: ENV_ON, fetchImpl })).toEqual({ status: 'uncertain', reason: 'wrong_deal' });
  });

  test.each([['a malformed Deal id', 'abc', FIELD, 'deal_id_invalid'], ['a zero Deal id', '0', FIELD, 'deal_id_invalid'], ['a lower-case field name', '4350', 'uf_crm_1', 'field_name_invalid'], ['a field name with a dot', '4350', 'UF_CRM_1.2', 'field_name_invalid']])('%s makes no request', async (_name, dealId, field, reason) => {
    const fetchImpl = jest.fn();
    expect(await api.getDealFileField(dealId, field, { env: ENV_ON, fetchImpl })).toEqual({ status: 'uncertain', reason });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('an unknown Deal is not_found; a switch that is off or an unreachable Bitrix is uncertain', async () => {
    const missing = jest.fn(async () => reply(400, { error: 'NOT_FOUND', error_description: 'Not found' }));
    expect(await api.getDealFileField('4350', FIELD, { env: ENV_ON, fetchImpl: missing })).toEqual({ status: 'not_found' });
    const off = jest.fn();
    expect(await api.getDealFileField('4350', FIELD, { env: { ...ENV_ON, BITRIX_SYNC_ENABLED: 'false' }, fetchImpl: off })).toEqual({ status: 'uncertain', reason: 'switch_off' });
    expect(off).not.toHaveBeenCalled();
    const down = jest.fn(async () => { throw Object.assign(new Error('x'), { code: 'ECONNRESET' }); });
    expect((await api.getDealFileField('4350', FIELD, { env: ENV_ON, fetchImpl: down })).status).toBe('uncertain');
  });
});

describe('downloadBitrixFile: a successful download', () => {
  test('returns the bytes, the content type, the byte count and the SHA-256, and makes ONE GET that rejects redirects', async () => {
    const fetchImpl = jest.fn(async () => pdfResponse());
    const result = await api.downloadBitrixFile(fileObject(), { env: ENV_ON, fetchImpl });
    expect(result.bytes.equals(PDF)).toBe(true);
    expect(result.byteCount).toBe(PDF.length);
    expect(result.contentType).toBe('application/pdf');
    expect(result.sha256).toBe(crypto.createHash('sha256').update(PDF).digest('hex'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(GOOD_URL);
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect(init.headers).toBeUndefined(); // no credentials of its own: only what the URL carries
  });

  test('the type the server claims is recorded, not trusted: a PDF sent as octet-stream is still a PDF', async () => {
    const result = await download(pdfResponse(PDF, { headers: { 'content-type': 'application/octet-stream' } }));
    expect(result.contentType).toBe('application/octet-stream');
    expect(result.sha256).toHaveLength(64);
  });

  test('accepts a plain object that carries urlMachine as an ordinary property', async () => {
    const result = await download(pdfResponse(), { file: { id: 65728, urlMachine: GOOD_URL } });
    expect(result.byteCount).toBe(PDF.length);
  });

  test('a file exactly at the size limit is accepted', async () => {
    const result = await download(pdfResponse(), { maxBytes: PDF.length });
    expect(result.byteCount).toBe(PDF.length);
  });

  test('the default limits are 10 MB and 30 seconds', () => {
    expect(api.MAX_DOWNLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(api.DOWNLOAD_TIMEOUT_MS).toBe(30000);
  });
});

describe('downloadBitrixFile: the URL is checked before any request leaves', () => {
  test.each([
    ['an unexpected host', 'https://evil.example/rest/f?x=1', 'download_host_not_allowed'],
    ['a look-alike host', 'https://fake-bitrix.invalid.evil.example/f', 'download_host_not_allowed'],
    ['a sub-domain of the portal', 'https://a.fake-bitrix.invalid/f', 'download_host_not_allowed'],
    ['plain http', 'http://fake-bitrix.invalid/rest/f', 'download_not_https'],
    ['another port', 'https://fake-bitrix.invalid:8443/rest/f', 'download_port_rejected'],
    ['port 80', 'https://fake-bitrix.invalid:80/rest/f', 'download_port_rejected'],
    ['a user name and password', 'https://user:pass@fake-bitrix.invalid/rest/f', 'download_userinfo_rejected'],
    ['a user name only', 'https://user@fake-bitrix.invalid/rest/f', 'download_userinfo_rejected'],
    ['a relative URL', '/rest/f?x=1', 'download_url_invalid'],
    ['a scheme-relative URL', '//fake-bitrix.invalid/rest/f', 'download_url_invalid'],
    ['a non-URL', 'not a url', 'download_url_invalid'],
    ['a URL with surrounding whitespace', ` ${GOOD_URL}`, 'download_url_invalid'],
    ['a data URL', 'data:application/pdf;base64,JVBERi0=', 'download_not_https'],
    ['a file URL', 'file:///etc/passwd', 'download_not_https'],
  ])('refuses %s without calling fetch', async (_name, url, code) => {
    const fetchImpl = jest.fn();
    const err = await failure(api.downloadBitrixFile(fileObject(url), { env: ENV_ON, fetchImpl }));
    expect(err).toBeInstanceOf(api.BitrixDealCallError);
    expect(err.outcome).toBe('definitive');
    expect(err.code).toBe(code);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(err.message).not.toContain('evil.example'); // nothing from the URL in the message
  });

  test('the explicit default port 443 is fine, and the host comparison ignores case', async () => {
    expect((await download(pdfResponse(), { file: fileObject('https://FAKE-Bitrix.invalid:443/rest/f?x=1') })).byteCount).toBe(PDF.length);
  });

  test.each([['no file object', undefined], ['null', null], ['a list', [{ id: '1' }]], ['an object with no id', { urlMachine: GOOD_URL }], ['an object with a bad id', { id: '0', urlMachine: GOOD_URL }], ['an object with no urlMachine', { id: '1' }]])('refuses %s', async (_name, file) => {
    const fetchImpl = jest.fn();
    const err = await failure(api.downloadBitrixFile(file, { env: ENV_ON, fetchImpl }));
    expect(err.outcome).toBe('definitive');
    expect(['file_object_invalid', 'download_url_invalid']).toContain(err.code);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('the url property (the browser link) is never used: a file with only url is refused', async () => {
    const fetchImpl = jest.fn();
    const err = await failure(api.downloadBitrixFile({ id: '1', url: GOOD_URL }, { env: ENV_ON, fetchImpl }));
    expect(err.code).toBe('download_url_invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('the same switches and portal allowlist as every other call apply', async () => {
    const fetchImpl = jest.fn();
    expect((await failure(api.downloadBitrixFile(fileObject(), { env: { ...ENV_ON, BITRIX_SYNC_ENABLED: 'false' }, fetchImpl }))).code).toBe('switch_off');
    expect((await failure(api.downloadBitrixFile(fileObject(), { env: { ...ENV_ON, BITRIX24_WEBHOOK_URL: '' }, fetchImpl }))).code).toBe('webhook_not_configured');
    const other = await failure(api.downloadBitrixFile(fileObject(), { env: { ...ENV_ON, BITRIX_ALLOWED_PORTAL_HOST: 'another-portal.invalid' }, fetchImpl }));
    expect(other.code).toBe('host_not_allowed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('downloadBitrixFile: what Bitrix or the network does', () => {
  test('a redirect answer is rejected and never followed', async () => {
    const err = await failure(download(new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } })));
    expect(err.code).toBe('redirect_rejected');
    expect(err.outcome).toBe('definitive');
    expect(err.message).not.toContain('evil.example');
  });

  test('a fetch that refuses a redirect by throwing (redirect: "error") is reported as a redirect', async () => {
    const thrown = Object.assign(new TypeError('fetch failed'), { cause: new TypeError('unexpected redirect') });
    const err = await failure(api.downloadBitrixFile(fileObject(), { env: ENV_ON, fetchImpl: jest.fn(async () => { throw thrown; }) }));
    expect(err.code).toBe('redirect_rejected');
  });

  test.each([[401], [403], [404]])('HTTP %i is a definitive http_error', async (status) => {
    const err = await failure(download(new Response('<html>login</html>', { status, headers: { 'content-type': 'text/html' } })));
    expect(err.code).toBe('http_error');
    expect(err.outcome).toBe('definitive');
    expect(err.message).not.toContain('login'); // nothing from the body
  });

  test.each([[500], [502], [503], [408], [429]])('HTTP %i is ambiguous: a later retry may succeed', async (status) => {
    const err = await failure(download(new Response('x', { status })));
    expect(err.code).toBe('server_error');
    expect(err.outcome).toBe('ambiguous');
  });

  test('a network failure is ambiguous and its message (which could name the URL) is not passed on', async () => {
    const lost = jest.fn(async () => { throw Object.assign(new Error(`connect failed for ${GOOD_URL}`), { code: 'ECONNRESET' }); });
    const err = await failure(api.downloadBitrixFile(fileObject(), { env: ENV_ON, fetchImpl: lost }));
    expect(err.code).toBe('network_error');
    expect(err.outcome).toBe('ambiguous');
    expect(err.message).not.toContain('SECRET_SIGNATURE');
    expect(err.message).toContain('ECONNRESET');
  });
});

describe('downloadBitrixFile: size limit', () => {
  test('a body over the limit is refused while it streams, with no Content-Length to warn first', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(500, 0x20)]);
    const err = await failure(download(pdfResponse(big), { maxBytes: 200 }));
    expect(err.code).toBe('file_too_large');
    expect(err.outcome).toBe('definitive');
  });

  test('the streaming read stops early: the reader is cancelled and the rest of the body is never pulled', async () => {
    let pulled = 0;
    const stream = new ReadableStream({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(100)); } });
    const err = await failure(download(new Response(stream, { status: 200 }), { maxBytes: 250 }));
    expect(err.code).toBe('file_too_large');
    expect(pulled).toBeLessThan(10); // an endless body is cut off after a few chunks
  });

  test('a declared Content-Length over the limit is refused before any body is read', async () => {
    const response = pdfResponse(PDF, { headers: { 'content-type': 'application/pdf', 'content-length': String(api.MAX_DOWNLOAD_BYTES + 1) } });
    const err = await failure(download(response));
    expect(err.code).toBe('file_too_large');
  });
});

describe('downloadBitrixFile: timeout', () => {
  test('a request that never answers is aborted at the timeout (ambiguous: a retry may work)', async () => {
    const fetchImpl = jest.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const err = await failure(api.downloadBitrixFile(fileObject(), { env: ENV_ON, fetchImpl, timeoutMs: 30 }));
    expect(err.code).toBe('timeout');
    expect(err.outcome).toBe('ambiguous');
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  });

  test('a body that stalls after the headers is cut off by the same deadline', async () => {
    const stalled = new ReadableStream({ start(controller) { controller.enqueue(PDF.subarray(0, 20)); }, pull() { return new Promise(() => {}); } });
    const err = await failure(download(new Response(stalled, { status: 200, headers: { 'content-type': 'application/pdf' } }), { timeoutMs: 30 }));
    expect(err.code).toBe('timeout');
    expect(err.outcome).toBe('ambiguous');
  });
});

describe('downloadBitrixFile: the content must really be a PDF', () => {
  test.each([
    ['an HTML login page sent as application/pdf', Buffer.from('<html><body>Please sign in</body></html>'), 'not_pdf_header'],
    ['a PNG image', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60)]), 'not_pdf_header'],
    ['an empty body', Buffer.alloc(0), 'empty_file'],
    ['a truncated PDF (no trailer)', PDF.subarray(0, 40), 'missing_eof_marker'],
    ['a PDF with %%EOF but no startxref', Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n'), 'missing_startxref'],
    ['a startxref beyond the end of the file', Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\nstartxref\n99999\n%%EOF\n'), 'startxref_out_of_range'],
    ['a startxref that points at nothing', Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\nstartxref\n12\n%%EOF\n'), 'startxref_target_invalid'],
    ['a wrong PDF version', Buffer.from('%PDF-9.9\nxref\nstartxref\n9\n%%EOF\n'), 'not_pdf_header'],
  ])('rejects %s', async (_name, buffer, reason) => {
    const err = await failure(download(pdfResponse(buffer)));
    expect(err.code).toBe('invalid_pdf');
    expect(err.outcome).toBe('definitive');
    expect(err.message).toContain(reason);
  });

  test('a PDF whose first bytes are right but whose body is cut off is not accepted on the magic bytes alone', async () => {
    const err = await failure(download(pdfResponse(Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2000, 0x41)]))));
    expect(err.code).toBe('invalid_pdf');
  });
});

describe('validatePdf', () => {
  test('accepts a classic xref PDF and a cross-reference-stream PDF', () => {
    expect(api.validatePdf(PDF)).toEqual({ ok: true });
    const head = '%PDF-1.5\n1 0 obj\n<< /Type /Catalog >>\nendobj\n';
    const streamAt = head.length;
    const withStream = Buffer.from(`${head}2 0 obj\n<< /Type /XRef >>\nstream\nendstream\nendobj\nstartxref\n${streamAt + 0}\n%%EOF`, 'latin1');
    expect(api.validatePdf(withStream)).toEqual({ ok: true }); // offset points at "2 0 obj"? it points at the stream object start
  });

  test('accepts CRLF line ends, trailing white space and a PDF 2.0 header', () => {
    const head = '%PDF-2.0\r\n1 0 obj\r\n<< >>\r\nendobj\r\n';
    const pdf = Buffer.from(`${head}xref\r\n0 1\r\ntrailer\r\n<< >>\r\nstartxref\r\n${head.length}\r\n%%EOF\r\n  \r\n`, 'latin1');
    expect(api.validatePdf(pdf)).toEqual({ ok: true });
  });

  test.each([[undefined], [null], ['%PDF-1.4'], [Buffer.alloc(0)]])('rejects %j', (value) => {
    expect(api.validatePdf(value).ok).toBe(false);
  });
});

describe('the signed URL never leaves the module', () => {
  test('no error, in any failure above, contains the URL, its signature or the webhook token', async () => {
    const cases = [
      download(new Response('x', { status: 403 })),
      download(new Response('x', { status: 500 })),
      download(pdfResponse(Buffer.from('<html></html>'))),
      download(new Response(null, { status: 301, headers: { location: GOOD_URL } })),
      api.downloadBitrixFile(fileObject('https://evil.example/f?token=SECRET_SIGNATURE'), { env: ENV_ON, fetchImpl: jest.fn() }),
    ];
    for (const attempt of cases) {
      const err = await failure(attempt);
      const text = `${err.message} ${err.code} ${JSON.stringify(err)}`;
      expect(text).not.toContain('SECRET_SIGNATURE');
      expect(text).not.toContain('FAKE_TOKEN');
      expect(text).not.toMatch(/https?:\/\//);
    }
  });
});
