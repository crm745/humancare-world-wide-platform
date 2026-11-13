/* global describe, test, expect, __dirname */
const fs = require('fs');
const path = require('path');
const { trackingRoute, trackingItemFromRequest, trackingItemFromCase, isRequestFor } = require('../trackingItem');

const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');

const EVENTS = [{ stage: 'submitted', occurredAt: '2026-11-05T12:00:00Z', note: 'Case opened after Admin approval of REQ-1.' }];
const CASE_DOCS = [{ id: 11, name: 'report.pdf', fileSizeBytes: 2048 }];
const REQ_DOCS = [
  { id: 1, originalName: 'report.pdf', sizeBytes: 2048, uploadedAt: '2026-11-01T12:00:00Z', replacesId: null, supersededAt: null, scanStatus: 'clean', reviewStatus: 'approved', rejectionReason: null },
];

const base = {
  id: 5, referenceNumber: 'REQ-1005', serviceType: 'Private Charter', serviceKey: 'private_charter', origin: 'Mumbai', destination: 'Dubai',
  patientName: 'A Patient', patientAge: 40, patientGender: 'Female', status: 'submitted', case: null,
};

describe('trackingRoute', () => {
  test('opens the tracking screen with the request id, never a Case id, and no case kind', () => {
    expect(trackingRoute({ id: 5 })).toEqual({ pathname: '/tracking', params: { id: 5 } });
    expect(trackingRoute({ id: 5 }, 'docs')).toEqual({ pathname: '/tracking', params: { id: 5, tab: 'docs' } });
    expect(trackingRoute({ id: 5, case: { id: 77 } })).toEqual({ pathname: '/tracking', params: { id: 5 } });
    expect(trackingRoute({ id: 5 }).params).not.toHaveProperty('kind');
  });
});

describe('trackingItemFromRequest: a request in the review workflow', () => {
  test('before approval there is no Case: no stage events, the review chip and the request documents', () => {
    const request = { ...base, reviewStatus: 'in_review', requestDocuments: REQ_DOCS };
    const item = trackingItemFromRequest(request);
    expect(item.workflow).toBe(true);
    expect(item.request).toBe(request);
    expect(item.reviewPill).toMatchObject({ key: 'in_review', label: 'In review' });
    expect(item.stageEvents).toEqual([]);
    expect(item.documents).toEqual([]);
  });

  test('after approval and Case creation the same route shows the Case timeline, and the chip says Approved', () => {
    const request = { ...base, reviewStatus: 'approved', requestDocuments: REQ_DOCS, case: { id: 77, stageEvents: EVENTS, documents: CASE_DOCS } };
    const item = trackingItemFromRequest(request);
    expect(item.stageEvents).toEqual(EVENTS);
    expect(item.workflow).toBe(true);
    expect(item.reviewPill).toMatchObject({ key: 'approved', label: 'Approved' });
    expect(item.referenceNumber).toBe('REQ-1005');
    // The route is the request id both before and after approval.
    expect(trackingRoute(request).params.id).toBe(5);
  });

  test('once the Case is under way the chip is the stage chip, not a stale review one', () => {
    const item = trackingItemFromRequest({ ...base, status: 'in_progress', reviewStatus: 'approved', requestDocuments: REQ_DOCS, case: { id: 77, stageEvents: EVENTS, documents: CASE_DOCS } });
    expect(item.reviewPill).toBeNull();
    expect(item.status).toBe('in_progress');
    expect(item.workflow).toBe(true);
  });

  test('a cancelled workflow request shows the usual Cancelled chip', () => {
    const item = trackingItemFromRequest({ ...base, status: 'cancelled', reviewStatus: 'in_review', requestDocuments: REQ_DOCS });
    expect(item.reviewPill).toBeNull();
    expect(item.status).toBe('cancelled');
  });
});

describe('trackingItemFromRequest: older requests and other services are unchanged', () => {
  test('keeps the Case documents, the Case timeline and the request status', () => {
    const request = { ...base, serviceType: 'Air Ambulance', serviceKey: 'air', reviewStatus: null, requestDocuments: [], case: { id: 9, stageEvents: EVENTS, documents: CASE_DOCS } };
    const item = trackingItemFromRequest(request);
    expect(item).toMatchObject({
      referenceNumber: 'REQ-1005', serviceType: 'Air Ambulance', origin: 'Mumbai', destination: 'Dubai', status: 'submitted',
      mortal: false, patientLabel: 'A Patient, 40 / Female', stageEvents: EVENTS, documents: CASE_DOCS,
      workflow: false, reviewPill: null, request: null,
    });
  });

  test('a request with no Case and no review status has empty lists', () => {
    const item = trackingItemFromRequest({ ...base, reviewStatus: undefined });
    expect(item).toMatchObject({ stageEvents: [], documents: [], workflow: false, reviewPill: null, request: null });
  });

  test('the patient label and Mortal Remains flag are as before', () => {
    const { patientAge, patientGender, ...bare } = base;
    expect(trackingItemFromRequest({ ...bare, serviceKey: 'mortal_domestic' })).toMatchObject({ mortal: true, patientLabel: 'A Patient' });
  });
});

describe('trackingItemFromRequest: the raw request is kept on every patient item', () => {
  const FULL = {
    ...base, reviewStatus: 'approved', submittedAt: '2026-11-01T09:00:00Z', reviewedAt: '2026-11-02T10:00:00Z', documentsRequestReason: null,
    originCityName: 'Mumbai', originCountryCode: 'IN', destinationCityName: 'Dubai', destinationCountryCode: 'AE', createdAt: '2026-11-01T08:00:00Z',
    case: { id: 77, status: 'scheduled', stageEvents: EVENTS, documents: CASE_DOCS },
  };

  test('a review-workflow request keeps the very same object', () => {
    expect(trackingItemFromRequest(FULL).rawRequest).toBe(FULL);
  });

  test('a legacy request (no review status) keeps it too, although item.request stays null', () => {
    const legacy = { ...base, reviewStatus: null, serviceKey: 'privatecharter', case: { id: 9, status: 'in_progress', stageEvents: EVENTS, documents: [] } };
    const item = trackingItemFromRequest(legacy);
    expect(item.rawRequest).toBe(legacy);
    expect(item.request).toBeNull();
    expect(item.workflow).toBe(false);
  });

  test('a request with no Case and a request of another service keep it as well', () => {
    const noCase = { ...base, reviewStatus: undefined };
    const other = { ...base, serviceType: 'Air Ambulance', serviceKey: 'air', reviewStatus: null };
    expect(trackingItemFromRequest(noCase).rawRequest).toBe(noCase);
    expect(trackingItemFromRequest(other).rawRequest).toBe(other);
  });

  test('the fields a tracking model needs survive, including the ones the flat item drops', () => {
    const { rawRequest } = trackingItemFromRequest(FULL);
    ['serviceKey', 'status', 'reviewStatus', 'submittedAt', 'reviewedAt', 'documentsRequestReason', 'originCityName', 'originCountryCode', 'destinationCityName', 'destinationCountryCode', 'createdAt']
      .forEach((key) => expect(rawRequest).toHaveProperty(key, FULL[key]));
    expect(rawRequest.case).toEqual({ id: 77, status: 'scheduled', stageEvents: EVENTS, documents: CASE_DOCS });
    // the flat item alone has no way to say what the Case status is
    expect(trackingItemFromRequest(FULL)).not.toHaveProperty('serviceKey');
  });

  test('the existing flattened properties are unchanged by keeping the raw request', () => {
    const item = trackingItemFromRequest(FULL);
    const { rawRequest, ...rest } = item;
    expect(Object.keys(rest).sort()).toEqual(['destination', 'documents', 'mortal', 'origin', 'patientLabel', 'referenceNumber', 'request', 'reviewPill', 'serviceType', 'stageEvents', 'status', 'workflow']);
    expect(rawRequest).toBe(FULL);
  });
});

describe('isRequestFor: a loaded request belongs to the id on the route', () => {
  test('the route id is a string and the request id a number, and they still match', () => {
    expect(isRequestFor({ id: 5 }, '5')).toBe(true);
    expect(isRequestFor({ id: 5 }, 5)).toBe(true);
    expect(isRequestFor({ id: '5' }, 5)).toBe(true);
  });

  test('a request for another id is not the one asked for (the id changed while the screen stayed mounted)', () => {
    expect(isRequestFor({ id: 5 }, '6')).toBe(false);
    expect(isRequestFor({ id: 5 }, '05')).toBe(false);
    expect(isRequestFor({ id: 5 }, '')).toBe(false);
  });

  test('nothing loaded, no id, or something that is not a request is never a match', () => {
    [null, undefined, 5, 'x'].forEach((value) => expect(isRequestFor(value, '5')).toBe(false));
    expect(isRequestFor({ id: 5 }, null)).toBe(false);
    expect(isRequestFor({ id: 5 }, undefined)).toBe(false);
    expect(isRequestFor({}, undefined)).toBe(false);
    expect(isRequestFor({ id: undefined }, 'undefined')).toBe(false);
    expect(isRequestFor({ id: null }, 'null')).toBe(false);
  });

  test('a patient item matches through its raw request, and a corporate item never does', () => {
    const item = trackingItemFromRequest({ ...base, id: 12 });
    expect(isRequestFor(item.rawRequest, '12')).toBe(true);
    expect(isRequestFor(item.rawRequest, '13')).toBe(false);
    expect(isRequestFor(trackingItemFromCase({ referenceNumber: 'C', patientName: 'P' }).rawRequest, '12')).toBe(false);
  });
});

describe('trackingItemFromCase (corporate)', () => {
  test('keeps the Case shape and never becomes a workflow item', () => {
    const item = trackingItemFromCase({ referenceNumber: 'CASE-1001', serviceType: 'Air', origin: 'A', destination: 'B', status: 'in_progress', patientName: 'P', stageEvents: EVENTS, documents: CASE_DOCS });
    expect(item).toMatchObject({ referenceNumber: 'CASE-1001', status: 'in_progress', patientLabel: 'P', stageEvents: EVENTS, documents: CASE_DOCS, workflow: false, reviewPill: null, request: null });
    expect(trackingItemFromCase({ referenceNumber: 'C', patientName: 'P' })).toMatchObject({ stageEvents: [], documents: [] });
  });

  test('a corporate item carries no raw request, so it can never reach the patient Private Charter model', () => {
    const item = trackingItemFromCase({ referenceNumber: 'CASE-1001', serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', status: 'in_progress', patientName: 'P' });
    expect(item).not.toHaveProperty('rawRequest');
    expect(Object.keys(item).sort()).toEqual(['destination', 'documents', 'origin', 'patientLabel', 'referenceNumber', 'request', 'reviewPill', 'serviceType', 'stageEvents', 'status', 'workflow']);
  });
});

describe('wiring (source checks)', () => {
  const tracking = read('../../app/tracking.js');
  const details = read('../../app/request-details.js');

  test('request details: "Open live tracking" (only for a live case) opens the Tracking page; each document is listed on the screen itself', () => {
    expect(details).toContain('{view.showTrackingBar ? (');
    expect(details).not.toContain('trackingRoute');
    expect(details).toContain("pathname: '/request-tracking', params: { id: request.id }");
    expect(details).not.toMatch(/router\.push\(trackingRoute\(request\)\)/);
  });

  test('tracking loads a patient request by its request id and a corporate Case by its own path, as before', () => {
    expect(tracking).toMatch(/isCase \? `\/corporate\/cases\/\$\{params\.id\}` : `\/requests\/me\/\$\{params\.id\}`/);
    expect(tracking).toMatch(/isCase \? trackingItemFromCase\(data\.case\) : trackingItemFromRequest\(data\.request\)/);
  });

  test('the request details card and the tracking chips come from the same review rules (reviewBanner / reviewPill)', () => {
    expect(fs.readFileSync(path.join(__dirname, '../requestDetailsView.js'), 'utf8')).toContain('reviewBanner(request)');
    expect(details).toContain('const pill = reviewPill(request);');
    expect(details).not.toMatch(/<Pill /);
    expect(tracking.match(/<RequestStatusPill pill=\{item\.reviewPill\} status=\{item\.status\} \/>/g)).toHaveLength(2);
    expect(tracking).not.toMatch(/<Pill /);
  });

  test('the Documents tab shows the history for workflow requests and keeps Case documents for the rest, with downloads only on the latter', () => {
    expect(tracking).toMatch(/item\.workflow \? \(/);
    expect(tracking).toMatch(/<DocumentHistory request=\{item\.request\} className="" \/>/);
    const workflowBranch = tracking.slice(tracking.indexOf('item.workflow ? ('), tracking.indexOf(') : ('));
    expect(workflowBranch).not.toMatch(/DocRow|downloadAndShare|onPress/);
    const legacyBranch = tracking.slice(tracking.indexOf(') : ('), tracking.indexOf('<Spacer min={14} />'));
    expect(legacyBranch).toMatch(/item\.documents\.map\(\(d\) => \(/);
    expect(legacyBranch).toMatch(/downloadAndShare\(`\/documents\/\$\{d\.id\}\/file`, d\.name\)/);
  });
});
