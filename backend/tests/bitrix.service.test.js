// Unit tests for the Bitrix24 webhook wrapper itself (not the requests/cases flows
// that call it — those already mock this module out, see requests.test.js). This
// file exists specifically to cover the response-handling bug fixed here: a
// malformed/ambiguous response from Bitrix used to be silently treated as success.

const ORIGINAL_ENV = process.env.BITRIX24_WEBHOOK_URL;
const ORIGINAL_FETCH = global.fetch;

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

describe('bitrix.service#createLead', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.BITRIX24_WEBHOOK_URL = 'https://example.bitrix24.com/rest/1/testtoken/';
    process.env.BITRIX_SYNC_ENABLED = 'true';
  });

  afterAll(() => {
    process.env.BITRIX24_WEBHOOK_URL = ORIGINAL_ENV;
    delete process.env.BITRIX_SYNC_ENABLED;
    global.fetch = ORIGINAL_FETCH;
  });

  const call = () => {
    const { createLead } = require('../src/modules/bitrix/bitrix.service');
    return createLead({ contactName: 'Rakesh Sharma', mobile: '9876543210', email: 'a@b.com', origin: 'Mumbai', destination: 'Dubai', referenceNumber: 'REQ-1' });
  };

  it('returns the lead id on a normal successful response', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, { result: 42 }));
    await expect(call()).resolves.toBe(42);
  });

  it.each([undefined, 'false', 'TRUE', '1'])('sends nothing while the switch is %s', async (value) => {
    if (value === undefined) delete process.env.BITRIX_SYNC_ENABLED;
    else process.env.BITRIX_SYNC_ENABLED = value;
    global.fetch = jest.fn();
    await expect(call()).rejects.toThrow(/switched off/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws without calling fetch when the webhook URL is not configured', async () => {
    delete process.env.BITRIX24_WEBHOOK_URL;
    global.fetch = jest.fn();
    await expect(call()).rejects.toThrow('BITRIX24_WEBHOOK_URL is not set');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws on a non-2xx response even when the body has no `error` key (the bug this fixes)', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(429, { someOtherField: 'rate limited' }));
    await expect(call()).rejects.toThrow(/HTTP 429/);
  });

  it('throws on a non-2xx response with a non-JSON body instead of masking it as a parse error', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 502, json: () => Promise.reject(new Error('Unexpected token <')) });
    await expect(call()).rejects.toThrow(/HTTP 502/);
  });

  it('throws on a 2xx response with no `result` field instead of silently returning undefined', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, {}));
    await expect(call()).rejects.toThrow(/returned no result/);
  });

  it('throws Bitrix\'s own error message on a well-formed error response', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, { error: 'INVALID_FIELD', error_description: 'TITLE is required' }));
    await expect(call()).rejects.toThrow(/TITLE is required/);
  });

  it('aborts and throws a timeout error if Bitrix never responds', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn((url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));

    const promise = call();
    const assertion = expect(promise).rejects.toThrow(/timed out/);
    await jest.advanceTimersByTimeAsync(15000);
    await assertion;
    jest.useRealTimers();
  });
});

describe('bitrix.service medical report upload', () => {
  const fs = require('fs');
  const path = require('path');
  let fileName;

  beforeEach(() => {
    jest.resetModules();
    process.env.BITRIX24_WEBHOOK_URL = 'https://example.bitrix24.com/rest/1/testtoken/';
    process.env.BITRIX_SYNC_ENABLED = 'true';
    const { UPLOAD_DIR } = require('../src/middleware/upload.middleware');
    fileName = `test-report-${Date.now()}.pdf`;
    fs.writeFileSync(path.join(UPLOAD_DIR, fileName), 'PDF-BYTES');
  });

  afterEach(() => {
    const { UPLOAD_DIR } = require('../src/middleware/upload.middleware');
    fs.rmSync(path.join(UPLOAD_DIR, fileName), { force: true });
  });

  afterAll(() => {
    process.env.BITRIX24_WEBHOOK_URL = ORIGINAL_ENV;
    delete process.env.BITRIX_SYNC_ENABLED;
    global.fetch = ORIGINAL_FETCH;
  });

  const doc = () => ({ name: 'report.pdf', fileUrl: `/uploads/${fileName}` });

  const FIELD = 'UF_CRM_1768194664955';
  const b64 = Buffer.from('PDF-BYTES').toString('base64');

  it('reads the lead, then puts the file into a single-file Medical Report field with crm.lead.update', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse(200, { result: { ID: '77', [FIELD]: false } }))
      .mockResolvedValueOnce(jsonResponse(200, { result: true }));
    const { sendMedicalReportToBitrix } = require('../src/modules/bitrix/bitrix.service');
    await expect(sendMedicalReportToBitrix(77, doc())).resolves.toBe(true);
    expect(global.fetch.mock.calls[0][0]).toMatch(/crm\.lead\.get\.json$/);
    const [url, init] = global.fetch.mock.calls[1];
    expect(url).toMatch(/crm\.lead\.update\.json$/);
    expect(JSON.parse(init.body)).toEqual({ id: 77, fields: { [FIELD]: { fileData: ['report.pdf', b64] } } });
  });

  it('adds to the files already on a multiple-file Medical Report field instead of replacing them', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse(200, { result: { ID: '77', [FIELD]: [{ id: 501, showUrl: 'x' }, { id: 502, showUrl: 'y' }] } }))
      .mockResolvedValueOnce(jsonResponse(200, { result: true }));
    const { sendMedicalReportToBitrix } = require('../src/modules/bitrix/bitrix.service');
    await expect(sendMedicalReportToBitrix(77, doc())).resolves.toBe(true);
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({
      id: 77,
      fields: { [FIELD]: [{ id: 501 }, { id: 502 }, { fileData: ['report.pdf', b64] }] },
    });
  });

  it('writes the lead comment with every report name in the same update', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse(200, { result: { ID: '77', [FIELD]: false } }))
      .mockResolvedValueOnce(jsonResponse(200, { result: true }));
    const { sendMedicalReportToBitrix } = require('../src/modules/bitrix/bitrix.service');
    await sendMedicalReportToBitrix(77, doc(), { comments: 'Requirement: x\nMedical reports (1): report.pdf' });
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).fields.COMMENTS).toBe('Requirement: x\nMedical reports (1): report.pdf');
  });

  it('does nothing without a lead or while the switch is off', async () => {
    global.fetch = jest.fn();
    let { sendMedicalReportToBitrix } = require('../src/modules/bitrix/bitrix.service');
    await expect(sendMedicalReportToBitrix(null, doc())).resolves.toBe(false);
    process.env.BITRIX_SYNC_ENABLED = 'false';
    jest.resetModules();
    ({ sendMedicalReportToBitrix } = require('../src/modules/bitrix/bitrix.service'));
    await expect(sendMedicalReportToBitrix(77, doc())).resolves.toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('never throws when Bitrix refuses the file (the upload has already been saved)', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, { error: 'ACCESS_DENIED', error_description: 'nope' }));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { sendMedicalReportToBitrix } = require('../src/modules/bitrix/bitrix.service');
    await expect(sendMedicalReportToBitrix(77, doc())).resolves.toBe(false);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
