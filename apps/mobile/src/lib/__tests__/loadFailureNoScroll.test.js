/* global describe, test, expect, __dirname */
// A "Couldn't load ..." view does not scroll when it fits (lib/useFitScroll.js): My Requests, Notifications, My Documents and Personal Details. Source checks and the pure rule.
const fs = require('fs');
const path = require('path');
const { scrollNeeded } = require('../useFitScroll');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8').replace(/\r\n/g, '\n');

describe('the rule', () => {
  test('content that fits (equal, or a pixel over from rounding) needs no scroll; taller content does', () => {
    expect(scrollNeeded({ viewHeight: 500, contentHeight: 500 })).toBe(false);
    expect(scrollNeeded({ viewHeight: 500, contentHeight: 501 })).toBe(false);
    expect(scrollNeeded({ viewHeight: 500, contentHeight: 540 })).toBe(true); // a tiny phone or a huge font: the Try again button must stay reachable
    expect(scrollNeeded({ viewHeight: 0, contentHeight: 0 })).toBe(false);
  });
  test('when no failure is shown the screen scrolls as before', () => {
    const hook = read('lib', 'useFitScroll.js');
    expect(hook).toContain('scrollEnabled: !active || scrollNeeded(');
  });
});

describe('the screens', () => {
  test('My Requests switches scrolling off while its failure view shows and fits', () => {
    const s = read('app', 'my-requests.js');
    expect(s).toContain('const fit = useFitScroll(!!error && !rows);');
    expect(s).toContain('scrollEnabled={fit.scrollEnabled} onLayout={fit.onLayout} onContentSizeChange={fit.onContentSizeChange}');
  });
  test('Body takes noScrollWhenFits; Notifications, My Documents and Personal Details pass it while their failure view shows', () => {
    const layout = read('components', 'layout.js');
    expect(layout).toContain('noScrollWhenFits = false');
    expect(layout).toContain('scrollEnabled={fit.scrollEnabled}');
    expect(read('app', 'notifications.js')).toContain('noScrollWhenFits={!ALERTS_PREVIEW && !!error && !data}');
    expect(read('app', 'my-documents.js')).toContain('noScrollWhenFits={!loading && !!failed}');
    expect(read('app', 'personal-details.js')).toContain('noScrollWhenFits={!loading && !!failed}');
  });
  test('the failure view is tighter (28 px above and below, it was 56) so it fits more often', () => {
    expect(read('components', 'LoadFailure.js')).toContain('style={{ paddingVertical: 28 }}');
  });
});
