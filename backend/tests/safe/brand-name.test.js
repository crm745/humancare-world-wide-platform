/* global describe, test, expect */
// Patient-visible backend text names the company exactly "Humancare World Wide": the request summary PDF, the OTP email wording and the
// patient-visible refusal messages. Source-text checks only: no database, no network, nothing is sent.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');
const FILES = [
  'modules/requests/pdf/summary-render.js',
  'modules/requests/pdf/summary-model.js',
  'modules/auth/otp-delivery.service.js',
  'common/middleware/rate-limit.middleware.js',
  'modules/requests/upload-policy.js',
  'modules/request-review/request-review.service.js',
];
const code = (file) => fs.readFileSync(path.join(SRC, file), 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('the company name in patient-visible backend text', () => {
  test.each(FILES)('%s has no misspelt company name', (file) => {
    expect(code(file)).not.toMatch(/Human[Cc]are(?! World Wide)|Humancare World ?[Ww]ide(?<! World Wide)|HUMANCARE|Human Care/);
  });
  test('the PDF names the company in its header, title, author and creator', () => {
    const pdf = code('modules/requests/pdf/summary-render.js');
    expect(pdf).toContain("Title: `Humancare World Wide - Request Summary ${model.reference}`");
    expect(pdf).toContain("Author: 'Humancare World Wide'");
    expect(pdf).toContain("Creator: 'Humancare World Wide'");
    expect(pdf).toContain(".text('Humancare World Wide'");
  });
});
