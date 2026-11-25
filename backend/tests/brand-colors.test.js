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
    // The PDF is drawn by pdf/summary-render.js (the heading, the rules, the section bars and the page header use the brand blue).
    const dir = path.join(__dirname, '../src/modules/requests');
    const pdf = fs.readFileSync(path.join(dir, 'pdf/summary-render.js'), 'utf8');
    expect(pdf).toContain("const { BRAND_PRIMARY } = require('../../../common/constants/brand');");
    expect(pdf).toContain('brand: BRAND_PRIMARY');
    expect(pdf).toContain(".text('HumanCare Worldwide'");
    for (const file of ['request-summary.pdf.js', 'pdf/summary-render.js', 'pdf/summary-model.js']) expect(fs.readFileSync(path.join(dir, file), 'utf8')).not.toMatch(/#1A73E8/i);
  });
});
