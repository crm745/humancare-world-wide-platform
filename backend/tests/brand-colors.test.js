// The brand blue is one colour everywhere: the mobile app's tokens, its Tailwind classes, its app.json notification colour,
// and the patient-facing PDF the server makes.
const fs = require('fs');
const path = require('path');
const { BRAND_PRIMARY } = require('../src/common/constants/brand');
const { COLORS } = require('../../apps/mobile/src/theme/colors');

describe('the brand blue', () => {
  it('is the logo blue #303A8F on the server and in the mobile app', () => {
    expect(BRAND_PRIMARY).toBe('#303A8F');
    expect(COLORS.primary).toBe(BRAND_PRIMARY);
  });

  it('colours the heading of the request summary PDF, and no old blue is left in it', () => {
    const pdf = fs.readFileSync(path.join(__dirname, '../src/modules/requests/request-summary.pdf.js'), 'utf8');
    expect(pdf).toContain('fillColor(BRAND_PRIMARY).text(\'HumanCare World Wide\')');
    expect(pdf).not.toMatch(/#1A73E8/i);
  });
});
