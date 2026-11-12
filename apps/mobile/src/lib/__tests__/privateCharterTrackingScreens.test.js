/* global describe, test, expect, __dirname */
// Source checks on how the two patient tracking screens use the Private Charter model.
// (There is no component test harness; these keep the wiring from drifting.)
const fs = require('fs');
const path = require('path');

const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');
const requestTracking = read('../../app/request-tracking.js');
const tracking = read('../../app/tracking.js');
const component = read('../../components/tracking/PrivateCharterTracking.js');

describe('request-tracking.js (patient)', () => {
  test('uses the model only for Private Charter, built from the raw request', () => {
    expect(requestTracking).toMatch(/isPrivateCharterTracking\(request\) \? buildPrivateCharterTracking\(request\) : null/);
    expect(requestTracking).toMatch(/if \(model\) \{\s+return \(\s+<Screen bg="bg-white">/);
  });

  test('keeps the generic tracking for every other service', () => {
    expect(requestTracking).toMatch(/const view = request \? trackingView\(request\) : null;/);
    expect(requestTracking).toMatch(/<LinearGradient/);
    expect(requestTracking).toMatch(/view\.steps\.map/);
  });

  test('loads on focus, with no mount effect that could fetch a second time', () => {
    expect(requestTracking).toMatch(/useFocusEffect\(/);
    expect(requestTracking).toMatch(/apiGet\(`\/requests\/me\/\$\{id\}`\)/);
    expect(requestTracking).not.toMatch(/useEffect/);
    expect(requestTracking.match(/apiGet\(/g)).toHaveLength(1);
  });

  test('ignores a response that arrives after blur, keeps shown data, and uses the failed state only before the first load', () => {
    expect(requestTracking).toMatch(/let active = true;/);
    expect(requestTracking).toMatch(/return \(\) => \{ active = false; \};/);
    expect(requestTracking.match(/if \(!active\) return;/g)).toHaveLength(2);
    expect(requestTracking).toMatch(/if \(!loaded\.current\) setFailed\(true\);/);
    expect(requestTracking).toMatch(/loaded\.current = true;/);
  });

  test('every hook runs before the early return', () => {
    const early = requestTracking.indexOf('if (model) {');
    const after = requestTracking.slice(early);
    expect(after).not.toMatch(/\buse(State|Effect|Memo|Callback|Ref|FocusEffect|App|WindowDimensions|SafeAreaInsets|LocalSearchParams)\(/);
  });
});

describe('tracking.js (patient and corporate)', () => {
  test('the corporate Case is still fetched once, by its own path, and never reaches the model', () => {
    expect(tracking).toMatch(/isCase \? `\/corporate\/cases\/\$\{params\.id\}` : `\/requests\/me\/\$\{params\.id\}`/);
    expect(tracking).toMatch(/isCase \? trackingItemFromCase\(data\.case\) : trackingItemFromRequest\(data\.request\)/);
    expect(tracking).toMatch(/if \(!params\.id \|\| !isCase\) return;/);
    expect(tracking).toMatch(/!isCase && item\?\.rawRequest && isPrivateCharterTracking\(item\.rawRequest\)/);
    expect(tracking).not.toMatch(/buildPrivateCharterTracking\(item\)/);
    expect(tracking).not.toMatch(/buildPrivateCharterTracking\(data\./);
  });

  test('the patient request refreshes on focus and the corporate effect is not a focus effect', () => {
    expect(tracking.match(/useFocusEffect\(/g)).toHaveLength(1);
    expect(tracking).toMatch(/if \(!params\.id \|\| isCase\) return undefined;/);
    expect(tracking).toMatch(/apiGet\(`\/requests\/me\/\$\{params\.id\}`\)/);
    expect(tracking).toMatch(/let active = true;/);
    expect(tracking).toMatch(/if \(!loaded\.current\) setFailed\(true\);/);
  });

  test('only the patient Private Charter Timeline tab changes; Overview and Documents are untouched', () => {
    expect(tracking).toMatch(/\{privateCharter \? <PrivateCharterTimelineSection model=\{privateCharter\} \/> : <Timeline rows=\{stageEventsToTimeline\(item\.stageEvents, item\.status\)\} \/>\}/);
    expect(tracking).toMatch(/tab === 'overview' && \(/);
    expect(tracking).toMatch(/tab === 'docs' && \(/);
    expect(tracking).toMatch(/<DocumentHistory request=\{item\.request\} className="" \/>/);
  });
});

describe('PrivateCharterTracking component', () => {
  test('draws only what the model says: no decorative airplane, route arc, green dots or mono type', () => {
    expect(component).not.toMatch(/react-native-svg|Menlo|monospace|Plane|LinearGradient/);
    expect(component).not.toMatch(/#1E8E4A|bg-success/);
  });

  test('uses the approved colours through the view constants and 26px dots', () => {
    expect(component).toMatch(/COLORS\.PRIMARY/);
    expect(component).toMatch(/COLORS\.CANCEL/);
    expect(component).toMatch(/DOT_SIZE/);
    expect(read('../tracking/privateCharterTrackingView.js')).toMatch(/DOT_SIZE = 26/);
  });

  test('does not depend on activeMilestone (every row reads its own state)', () => {
    expect(component).not.toMatch(/activeMilestone/);
  });
});

describe('request id changes (both screens)', () => {
  test('request-tracking shows only a request that belongs to the route id', () => {
    expect(requestTracking).toMatch(/const request = isRequestFor\(loadedRequest, id\) \? loadedRequest : null;/);
    expect(requestTracking).toMatch(/setLoadedRequest\(data\.request\)/);
    expect(requestTracking).not.toMatch(/setRequest\(/);
  });

  test('request-tracking starts over for a new id but keeps its data for the same id', () => {
    expect(requestTracking).toMatch(/if \(loadedForId\.current !== String\(id\)\) \{\s+loadedForId\.current = String\(id\);\s+loaded\.current = false;\s+setFailed\(false\);\s+\}/);
    expect(requestTracking).toMatch(/\}, \[id\]\),/);
    expect(requestTracking.match(/apiGet\(/g)).toHaveLength(1);
  });

  test('tracking shows a patient item only for the route id, and leaves a corporate Case as it was', () => {
    expect(tracking).toMatch(/const item = isCase \|\| !loadedItem \|\| isRequestFor\(loadedItem\.rawRequest, params\.id\) \? loadedItem : null;/);
    expect(tracking).toMatch(/setLoadedItem\(trackingItemFromRequest\(data\.request\)\)/);
    expect(tracking).toMatch(/setLoadedItem\(isCase \? trackingItemFromCase\(data\.case\) : trackingItemFromRequest\(data\.request\)\)/);
    expect(tracking).not.toMatch(/setItem\(/);
  });

  test('tracking starts over for a new id but keeps its data for the same id, with one patient fetch', () => {
    expect(tracking).toMatch(/if \(loadedForId\.current !== String\(params\.id\)\) \{\s+loadedForId\.current = String\(params\.id\);\s+loaded\.current = false;\s+setFailed\(false\);\s+\}/);
    expect(tracking).toMatch(/\}, \[params\.id, isCase\]\),/);
    expect(tracking.match(/apiGet\(/g)).toHaveLength(2); // one corporate, one patient
  });

  test('a response that arrives after the id changed is ignored (the old effect is cleaned up first)', () => {
    [requestTracking, tracking].forEach((source) => {
      expect(source).toMatch(/return \(\) => \{ active = false; \};/);
      expect(source.match(/if \(!active\) return;/g)).toHaveLength(2);
    });
  });
});

describe('tracking.js header status (patient Private Charter only)', () => {
  const chip = '<PrivateCharterStatusChip model={privateCharter} compact />';
  const pill = '<RequestStatusPill pill={item.reviewPill} status={item.status} />';

  test('both status displays (header and Overview) use the model chip for Private Charter and the old pill for everything else', () => {
    expect(tracking.split(`privateCharter ? ${chip} : ${pill}`)).toHaveLength(3); // exactly two places
    expect(tracking.split(pill)).toHaveLength(3); // the old pill is still there, in both, as the other branch
  });

  test('the chip is drawn from the model, never from the collapsed request.status', () => {
    expect(component).toMatch(/toneColors\(model\.status\.tone\)/);
    expect(component).toMatch(/t\(model\.status\.labelKey\)/);
    expect(component).not.toMatch(/request\.status|item\.status/);
  });

  test('a corporate Case never gets the Private Charter chip', () => {
    expect(tracking).toMatch(/!isCase && item\?\.rawRequest && isPrivateCharterTracking/);
  });
});

describe('PrivateCharterTracking component: RTL and accessibility', () => {
  test('the route arrow is mirrored for right-to-left languages, as TopBar does for its chevron', () => {
    expect(component).toMatch(/const \{ t, isRTL \} = useApp\(\);/);
    expect(component).toMatch(/<View style=\{mirrorStyle\(isRTL\)\}><ArrowRight /);
    expect(read('../../components/layout.js')).toMatch(/isRTL \? \{ transform: \[\{ scaleX: -1 \}\] \} : null/);
  });

  test('every timeline row is one accessible element with a label', () => {
    expect(component).toMatch(/<View accessible accessibilityLabel=\{rowAccessibilityLabel\(row, t\)\}/);
  });

  test('the cancelled row title comes from the helper, not from the milestone', () => {
    expect(component).toMatch(/\{t\(row\.titleKey\)\}/);
    expect(read('../tracking/privateCharterTrackingView.js')).toMatch(/titleKey: cancelled \? 'tcp_cancelled_label' : m\.titleKey/);
  });
});

describe('service eligibility: only the canonical privatecharter key uses the new UI', () => {
  const serviceFamily = read('../tracking/serviceFamily.js');
  const { isPrivateCharterTracking } = require('../tracking/serviceFamily');
  const { trackingItemFromRequest, trackingItemFromCase } = require('../trackingItem');
  const patient = (serviceKey) => ({ id: 5, serviceKey, serviceType: 'Air Ambulance', referenceNumber: 'REQ-1', origin: 'A', destination: 'B', patientName: 'P', status: 'submitted', reviewStatus: null, case: null });
  // the same gate both screens use
  const usesNewUi = (item, isCase) => Boolean(!isCase && item?.rawRequest && isPrivateCharterTracking(item.rawRequest));

  test('privatecharter requests get the new UI on both patient routes', () => {
    const item = trackingItemFromRequest(patient('privatecharter'));
    expect(usesNewUi(item, false)).toBe(true);
    expect(isPrivateCharterTracking(patient('privatecharter'))).toBe(true);
  });

  test('legacy air requests keep the existing generic tracking', () => {
    expect(usesNewUi(trackingItemFromRequest(patient('air')), false)).toBe(false);
    expect(isPrivateCharterTracking(patient('air'))).toBe(false);
  });

  test('every other key, and a missing key, keeps the generic tracking', () => {
    ['ground', 'commercialair_stretcher', 'mortal_domestic', 'hospital', 'homecare', 'tele', 'corporate', null, undefined, ''].forEach((key) => {
      expect(usesNewUi(trackingItemFromRequest(patient(key)), false)).toBe(false);
    });
  });

  test('a corporate Case never gets the new UI, even one that looks like Private Charter', () => {
    const caseItem = trackingItemFromCase({ referenceNumber: 'CASE-1', serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', status: 'submitted', patientName: 'P' });
    expect(usesNewUi(caseItem, true)).toBe(false);
    expect(usesNewUi(caseItem, false)).toBe(false); // no raw request to build the model from
  });

  test('the screens decide only through isPrivateCharterTracking, with no alias of their own', () => {
    [requestTracking, tracking].forEach((source) => {
      expect(source).toMatch(/isPrivateCharterTracking\(/);
      expect(source).not.toMatch(/normalizeServiceKey|'air'|"air"/);
    });
    expect(serviceFamily).not.toMatch(/normalizeServiceKey/);
  });
});
