/* global describe, test, expect, jest, beforeEach, afterEach, __dirname */
// Phase 5: document upload recovery, mobile side. The REAL stamping, state, check-before-retry and runSubmission/recoverUploads code run against a fake server that keeps the documents
// it was sent (by upload id, like the real backend) and can lose an answer. Plus source checks on the screens (every document-taking service, none for the others, offline, no drafts).
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'ABCDEF01-2345-4678-89AB-CDEF01234567') }));

const fs = require('fs');
const path = require('path');
const { stampUploadIds, uploadIdOf, uploadStateOf, uploadSummary, sendableFiles, classifyUploadFailure, checkUploads, checkMessageKey, UPLOAD_STATES } = require('../uploadRecovery');
const { runSubmission, recoverUploads, pendingFiles } = require('../requestUploads');
const { isClientRequestId } = require('../submissionKey');
const { createNetworkStore } = require('../network');
const { pickAnswers, DRAFT_SERVICES } = require('../draftSchema');
const I18N = require('../../data/i18n.json');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').split('\r\n').join('\n');
const file = (name) => ({ uri: `file:///cache/${name}`, name, mimeType: 'application/pdf', size: 69 });
const A = file('a.pdf');
const B = file('b.pdf');
const C = file('c.pdf');
const SAVED = { id: 7, referenceNumber: 'REQ-1007', title: 'Ground Ambulance' };
const sequence = () => { let n = 0; return jest.fn(() => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`); };
const lost = () => Object.assign(new Error('We could not confirm that this file went through.'), { code: 'network', failure: 'network', outcomeUnknown: true });
const refusal = (message = 'Unsupported file type.') => Object.assign(new Error(message), { status: 422 });

// A fake server: every upload that reaches it is kept under its upload id, whether or not the answer is then "lost". GET /requests/me/:id lists them.
function fakeServer({ supportsIds = true, loseAnswerFor = [], refuse = [] } = {}) {
  const server = { docs: [], uploads: [], gets: 0, supportsIds, loseAnswerFor: new Set(loseAnswerFor), refuse: new Set(refuse), neverArrives: new Set(), unreachable: false };
  server.upload = jest.fn(async (f, onProgress, sent) => {
    server.uploads.push({ name: f.name, requestId: sent.id, id: f.clientUploadId });
    if (server.neverArrives.has(f.name)) throw lost(); // the connection dropped before the file got there
    if (server.refuse.has(f.name)) throw refusal();
    if (!server.docs.some((d) => d.clientUploadId === f.clientUploadId)) server.docs.push({ id: server.docs.length + 1, originalName: f.name, sizeBytes: f.size, clientUploadId: f.clientUploadId });
    if (server.loseAnswerFor.has(f.name)) throw lost(); // saved, but the answer was lost
    return { document: { id: server.docs.length } };
  });
  server.fetchRequest = jest.fn(async () => {
    server.gets += 1;
    if (server.unreachable) throw Object.assign(new Error('offline'), { code: 'network' });
    const docs = server.docs.map((d) => (supportsIds ? d : { id: d.id, originalName: d.originalName, sizeBytes: d.sizeBytes }));
    return { request: { id: SAVED.id, requestDocuments: docs, ...(supportsIds ? { clientUploadIdSupported: true } : {}) } };
  });
  return server;
}
const first = (files, extra = {}) => ({ sentRequest: null, uploaded: [], uploadErrors: {}, uploadUnknown: {}, files, createRequest: jest.fn(async () => SAVED), ...extra });
const keep = (state, result) => { const { note, check, ...rest } = result; return { ...state, ...rest }; }; // what a screen does between attempts

describe('a stable id for every file', () => {
  test('each file gets its own valid random UUID; a file that has one keeps it', () => {
    const stamped = stampUploadIds([A, B, C]);
    expect(stamped.every((f) => isClientRequestId(f.clientUploadId))).toBe(true);
    expect(new Set(stamped.map((f) => f.clientUploadId)).size).toBe(3);
    const again = stampUploadIds(stamped);
    expect(again).toBe(stamped); // nothing missing: the very same array, so the form's state does not change
    const added = stampUploadIds([...stamped, file('d.pdf')]);
    expect(added.slice(0, 3).map(uploadIdOf)).toEqual(stamped.map(uploadIdOf));
    expect(uploadIdOf(added[3])).toBeTruthy();
  });

  test('the generator is injectable (the screens pass the phone\'s secure one) and a repeated value is never given to two files', () => {
    const generate = jest.fn().mockReturnValueOnce('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA').mockReturnValueOnce('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').mockReturnValue('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const stamped = stampUploadIds([A, B], generate);
    expect(stamped.map((f) => f.clientUploadId)).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
  });

  test('a file taken off the list and chosen again is a NEW upload with a new id', () => {
    const generate = sequence();
    const [a1] = stampUploadIds([A], generate);
    const [a2] = stampUploadIds([A], generate); // the form dropped the entry; the picker made a new one for the same uri
    expect(a2.clientUploadId).not.toBe(a1.clientUploadId);
  });

  test('the same id is sent on every retry of a file, and different files never share one', async () => {
    const server = fakeServer({ loseAnswerFor: ['b.pdf'] });
    let state = first([A, B, C]);
    const generateId = sequence();
    state = keep(state, await runSubmission({ ...state, upload: server.upload, generateId }));
    const idsAfterFirst = Object.fromEntries(state.files.map((f) => [f.name, f.clientUploadId]));
    server.loseAnswerFor.clear();
    state = keep(state, await recoverUploads({ requestId: SAVED.id, ...state, fetchRequest: server.fetchRequest, upload: server.upload, generateId }));
    expect(Object.fromEntries(state.files.map((f) => [f.name, f.clientUploadId]))).toEqual(idsAfterFirst); // never regenerated
    expect(new Set(Object.values(idsAfterFirst)).size).toBe(3);
    const sentIds = server.uploads.map((u) => u.id);
    for (const name of ['a.pdf', 'b.pdf', 'c.pdf']) expect(new Set(server.uploads.filter((u) => u.name === name).map((u) => u.id)).size).toBe(1);
    expect(sentIds.length).toBeGreaterThanOrEqual(3);
  });

  test('ids are given and kept BEFORE the first file is sent (so a crash mid-upload cannot lose them)', async () => {
    const order = [];
    const server = fakeServer();
    await runSubmission({ ...first([A, B]), upload: server.upload, generateId: sequence(), onSent: (s) => order.push(['sent', s.files.map(uploadIdOf).filter(Boolean).length]), onFile: (f) => f && order.push(['file', f.name]) });
    expect(order[0]).toEqual(['sent', 2]);
    expect(order[1][0]).toBe('file');
  });

  test('without an injected generator the pure fallback still makes a valid UUID; the secure source is expo-crypto and shared with the Phase 4 keys', () => {
    expect(isClientRequestId(stampUploadIds([A])[0].clientUploadId)).toBe(true);
    const { secureUuid } = require('../secureRandom');
    expect(secureUuid()).toBe('abcdef01-2345-4678-89ab-cdef01234567'); // lower-case, v4 format: the format keys already stored on a phone have
    expect(read('lib/secureRandom.js')).toContain("from 'expo-crypto'");
    expect(read('lib/pendingSubmissionStore.js')).toContain('generate: secureUuid');
    for (const screen of ['app/request/review.js', 'app/request/submitted.js', 'components/request/AdditionalDocuments.js']) expect(read(screen)).toContain('secureUuid');
  });
});

describe('the five states', () => {
  test('are exactly pending, sending, unconfirmed, accepted and refused, and are read from the three collections', () => {
    expect(UPLOAD_STATES).toEqual(['pending', 'sending', 'unconfirmed', 'accepted', 'refused']);
    const s = { uploaded: [A.uri], unknown: { [B.uri]: 'm' }, errors: { [C.uri]: 'no' } };
    expect(uploadStateOf(A, s)).toBe('accepted');
    expect(uploadStateOf(B, s)).toBe('unconfirmed');
    expect(uploadStateOf(C, s)).toBe('refused');
    expect(uploadStateOf(file('d.pdf'), s)).toBe('pending');
    expect(uploadStateOf(file('d.pdf'), s, file('d.pdf').uri)).toBe('sending');
    const summary = uploadSummary([A, B, C, file('d.pdf')], s);
    expect(summary.needsCheck).toBe(true);
    expect(summary.sendable.map((f) => f.name)).toEqual(['c.pdf', 'd.pdf']); // refused and pending, never the unconfirmed one
    expect(summary.outstanding).toBe(3);
    expect(summary.complete).toBe(false);
    expect(uploadSummary([A], { uploaded: [A.uri], unknown: {}, errors: {} }).complete).toBe(true);
  });

  test('a failure is classified by what is KNOWN: no answer, a 5xx, a cancel after the start and anything unrecognised are unconfirmed; a 4xx is refused; certain non-delivery is not-sent', () => {
    expect(classifyUploadFailure(lost())).toBe('unconfirmed');
    expect(classifyUploadFailure(Object.assign(new Error('x'), { code: 'timeout', outcomeUnknown: true }))).toBe('unconfirmed');
    expect(classifyUploadFailure(Object.assign(new Error('x'), { status: 502 }))).toBe('unconfirmed');
    expect(classifyUploadFailure(Object.assign(new Error('x'), { cancelled: true, outcomeUnknown: true }))).toBe('unconfirmed');
    expect(classifyUploadFailure(new Error('???'))).toBe('unconfirmed');
    expect(classifyUploadFailure(refusal())).toBe('refused');
    expect(classifyUploadFailure(Object.assign(new Error('x'), { cancelled: true, notProcessed: true }))).toBe('notSent');
    expect(classifyUploadFailure(Object.assign(new Error('x'), { status: 401, notProcessed: true }))).toBe('notSent');
  });
});

describe('an unknown outcome is never a failure and is never sent again blindly', () => {
  test('a lost connection keeps that file as unconfirmed, stops the run (the rest stay pending), and reports no failure', async () => {
    const server = fakeServer();
    server.neverArrives.add('b.pdf');
    const result = await runSubmission({ ...first([A, B, C]), upload: server.upload, generateId: sequence() });
    expect(result.uploaded).toEqual([A.uri]);
    expect(result.uploadUnknown).toEqual({ [B.uri]: expect.any(String) });
    expect(result.uploadErrors).toEqual({}); // NOT a failure
    expect(result.note).toMatchObject({ stopped: 'unconfirmed' });
    expect(server.uploads.map((u) => u.name)).toEqual(['a.pdf', 'b.pdf']); // c.pdf was not even tried
    expect(pendingFiles(result.files, result.uploaded).map((f) => f.name)).toEqual(['b.pdf', 'c.pdf']);
  });

  test('a refused file is a refusal and the others carry on; a certain non-delivery leaves the file simply pending', async () => {
    const server = fakeServer({ refuse: ['b.pdf'] });
    const refused = await runSubmission({ ...first([A, B, C]), upload: server.upload, generateId: sequence() });
    expect(refused.uploaded).toEqual([A.uri, C.uri]);
    expect(refused.uploadErrors).toEqual({ [B.uri]: 'Unsupported file type.' });
    expect(refused.uploadUnknown).toEqual({});
    const notSent = await runSubmission({ ...first([A, B]), upload: jest.fn(async (f) => { if (f.name === 'b.pdf') throw Object.assign(new Error('cancelled'), { cancelled: true, notProcessed: true }); }), generateId: sequence() });
    expect(notSent.uploaded).toEqual([A.uri]);
    expect(notSent.uploadErrors).toEqual({});
    expect(notSent.uploadUnknown).toEqual({});
    expect(notSent.note).toMatchObject({ stopped: 'notSent' });
  });

  test('running again does NOT send the unconfirmed file: only the files that may be sent', async () => {
    const server = fakeServer();
    server.neverArrives.add('b.pdf');
    let state = first([A, B, C]);
    state = keep(state, await runSubmission({ ...state, upload: server.upload, generateId: sequence() }));
    server.uploads.length = 0;
    server.neverArrives.clear();
    state = keep(state, await runSubmission({ ...state, upload: server.upload, generateId: sequence() }));
    expect(server.uploads.map((u) => u.name)).toEqual(['c.pdf']); // b.pdf waits to be checked
    expect(state.uploadUnknown).toHaveProperty([B.uri]);
  });

  test('the request is created once, however many runs follow', async () => {
    const server = fakeServer();
    server.neverArrives.add('a.pdf');
    let state = first([A]);
    for (let i = 0; i < 3; i += 1) state = keep(state, await runSubmission({ ...state, upload: server.upload, generateId: sequence() }));
    expect(state.createRequest).toHaveBeenCalledTimes(1);
  });
});

describe('Check status: the server\'s own document list, matched by upload id', () => {
  test('a file the server has is accepted by its id, whether or not its answer was lost', async () => {
    const server = fakeServer({ loseAnswerFor: ['b.pdf'] });
    const state = await runSubmission({ ...first([A, B]), upload: server.upload, generateId: sequence() });
    expect(state.uploadUnknown).toHaveProperty([B.uri]);
    const checked = await checkUploads({ requestId: SAVED.id, files: state.files, uploaded: state.uploaded, unknown: state.uploadUnknown, fetchRequest: server.fetchRequest });
    expect(checked).toMatchObject({ result: 'checked', matched: 1, missing: 0, unverifiable: 0 });
    expect(checked.uploaded).toEqual([A.uri, B.uri]);
    expect(checked.unknown).toEqual({});
    expect(checkMessageKey(checked)).toBe('allFound');
  });

  test('a file the server certainly does not have (it keeps ids and gave the list) becomes retryable', async () => {
    const server = fakeServer();
    server.neverArrives.add('b.pdf');
    const state = await runSubmission({ ...first([A, B]), upload: server.upload, generateId: sequence() });
    const checked = await checkUploads({ requestId: SAVED.id, files: state.files, uploaded: state.uploaded, unknown: state.uploadUnknown, fetchRequest: server.fetchRequest });
    expect(checked).toMatchObject({ matched: 0, missing: 1, unverifiable: 0 });
    expect(checked.unknown).toEqual({});
    expect(sendableFiles(state.files, checked.uploaded, checked.unknown).map((f) => f.name)).toEqual(['b.pdf']);
    expect(checkMessageKey(checked)).toBe('someMissing');
  });

  test('an OLDER server (no upload ids in its answer) proves nothing: the file stays unconfirmed, is not called missing, and the person is asked to look', async () => {
    const server = fakeServer({ supportsIds: false, loseAnswerFor: ['b.pdf'] });
    const state = await runSubmission({ ...first([A, B]), upload: server.upload, generateId: sequence() });
    const checked = await checkUploads({ requestId: SAVED.id, files: state.files, uploaded: state.uploaded, unknown: state.uploadUnknown, fetchRequest: server.fetchRequest });
    expect(checked).toMatchObject({ result: 'checked', matched: 0, missing: 0, unverifiable: 1 });
    expect(checked.unknown).toHaveProperty([B.uri]);
    expect(sendableFiles(state.files, checked.uploaded, checked.unknown).map((f) => f.name)).toEqual([]);
    expect(checkMessageKey(checked)).toBe('cannotConfirm');
  });

  test('an incomplete answer (no document list), a file without an id, and an unreachable server are never turned into "missing"', async () => {
    const waiting = { [B.uri]: 'm' };
    const stamped = stampUploadIds([A, B], sequence());
    const noList = await checkUploads({ requestId: 7, files: stamped, uploaded: [], unknown: waiting, fetchRequest: async () => ({ request: { id: 7, clientUploadIdSupported: true } }) });
    expect(noList).toMatchObject({ missing: 0, unverifiable: 1 });
    const noId = await checkUploads({ requestId: 7, files: [A, B], uploaded: [], unknown: waiting, fetchRequest: async () => ({ request: { id: 7, requestDocuments: [], clientUploadIdSupported: true } }) });
    expect(noId).toMatchObject({ missing: 0, unverifiable: 1 });
    const down = fakeServer();
    down.unreachable = true;
    const unreachable = await checkUploads({ requestId: 7, files: stamped, uploaded: [], unknown: waiting, fetchRequest: down.fetchRequest });
    expect(unreachable).toMatchObject({ result: 'unreachable' });
    expect(unreachable.unknown).toEqual(waiting);
    expect(checkMessageKey(unreachable)).toBe('unreachable');
    expect(checkMessageKey(await checkUploads({ requestId: 7, files: stamped, uploaded: [A.uri], unknown: {}, fetchRequest: down.fetchRequest }))).toBe('nothing');
  });

  test('a document is matched by upload id ONLY: the same name and size under another id is a different file', async () => {
    const stamped = stampUploadIds([A], sequence());
    const lookalike = { id: 1, originalName: A.name, sizeBytes: A.size, clientUploadId: '99999999-9999-4999-8999-999999999999' };
    const checked = await checkUploads({ requestId: 7, files: stamped, uploaded: [], unknown: { [A.uri]: 'm' }, fetchRequest: async () => ({ request: { requestDocuments: [lookalike], clientUploadIdSupported: true } }) });
    expect(checked).toMatchObject({ matched: 0, missing: 1 });
    // ...and an id that IS listed matches even on a server that did not say it supports ids (a match is proof), in either document list
    const found = await checkUploads({ requestId: 7, files: stamped, uploaded: [], unknown: { [A.uri]: 'm' }, fetchRequest: async () => ({ request: { case: { documents: [{ id: 3, clientUploadId: stamped[0].clientUploadId.toUpperCase() }] } } }) });
    expect(found).toMatchObject({ matched: 1, unverifiable: 0 });
  });
});

describe('Retry missing: refresh first, then send only what is confirmed missing', () => {
  test('the server list is read BEFORE any upload; found files are accepted and never sent again; missing, pending and refused files are sent, with their original ids', async () => {
    const server = fakeServer();
    const generateId = sequence();
    // a.pdf arrived but its answer was lost; b.pdf never arrived and the run stopped; c.pdf was never tried
    server.loseAnswerFor.add('a.pdf');
    let state = first([A, B, C]);
    state = keep(state, await runSubmission({ ...state, upload: server.upload, generateId })); // a.pdf: answer lost -> run stops
    expect(state.uploadUnknown).toHaveProperty([A.uri]);
    const idOfA = state.files.find((f) => f.name === 'a.pdf').clientUploadId;
    server.loseAnswerFor.clear();
    const order = [];
    const spyGet = server.fetchRequest;
    server.fetchRequest = jest.fn(async (...args) => { order.push('get'); return spyGet(...args); });
    const spyUpload = server.upload;
    server.upload = jest.fn(async (f, ...rest) => { order.push(`up:${f.name}`); return spyUpload(f, ...rest); });
    server.uploads.length = 0;
    const result = await recoverUploads({ requestId: SAVED.id, ...state, fetchRequest: server.fetchRequest, upload: server.upload, generateId });
    expect(order).toEqual(['get', 'up:b.pdf', 'up:c.pdf']); // refreshed first; a.pdf is NOT resent
    expect(result.check).toMatchObject({ matched: 1 });
    expect(result.uploaded.sort()).toEqual([A.uri, B.uri, C.uri].sort());
    expect(result.uploadUnknown).toEqual({});
    expect(server.docs.filter((d) => d.clientUploadId === idOfA)).toHaveLength(1);
    expect(pendingFiles(result.files, result.uploaded)).toEqual([]);
  });

  test('a file confirmed missing is sent again with the SAME id it was first sent with', async () => {
    const server = fakeServer();
    server.neverArrives.add('b.pdf');
    let state = first([A, B]);
    state = keep(state, await runSubmission({ ...state, upload: server.upload, generateId: sequence() }));
    const idOfB = state.files.find((f) => f.name === 'b.pdf').clientUploadId;
    server.neverArrives.clear();
    server.uploads.length = 0;
    const result = await recoverUploads({ requestId: SAVED.id, ...state, fetchRequest: server.fetchRequest, upload: server.upload });
    expect(server.uploads).toEqual([{ name: 'b.pdf', requestId: 7, id: idOfB }]);
    expect(result.uploaded).toContain(B.uri);
  });

  test('if the document list cannot be read, NOTHING is sent', async () => {
    const server = fakeServer();
    server.neverArrives.add('b.pdf');
    let state = first([A, B, C]);
    state = keep(state, await runSubmission({ ...state, upload: server.upload, generateId: sequence() }));
    server.uploads.length = 0;
    server.unreachable = true;
    const result = await recoverUploads({ requestId: SAVED.id, ...state, fetchRequest: server.fetchRequest, upload: server.upload });
    expect(server.uploads).toEqual([]);
    expect(result.check.result).toBe('unreachable');
    expect(result.uploadUnknown).toEqual(state.uploadUnknown);
  });

  test('on an older server the unconfirmed file is left for the person, while the files that were simply never sent still go', async () => {
    const server = fakeServer({ supportsIds: false });
    server.loseAnswerFor.add('b.pdf');
    let state = first([A, B, C]);
    state = keep(state, await runSubmission({ ...state, upload: server.upload, generateId: sequence() }));
    server.loseAnswerFor.clear();
    server.uploads.length = 0;
    const result = await recoverUploads({ requestId: SAVED.id, ...state, fetchRequest: server.fetchRequest, upload: server.upload });
    expect(server.uploads.map((u) => u.name)).toEqual(['c.pdf']); // b.pdf may be on the server: never assumed missing
    expect(result.uploadUnknown).toHaveProperty([B.uri]);
    expect(result.check.unverifiable).toBe(1);
    expect(checkMessageKey(result.check)).toBe('cannotConfirm');
  });
});

describe('nothing replays by itself', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('the connection coming back sends nothing: an unconfirmed upload waits for a person', async () => {
    const server = fakeServer();
    server.neverArrives.add('a.pdf');
    await runSubmission({ ...first([A]), upload: server.upload, generateId: sequence() });
    expect(server.uploads).toHaveLength(1);
    const linkSubs = new Set();
    const net = createNetworkStore({ probe: async () => ({ ok: true, status: 200, ms: 20 }), subscribeLink: (cb) => { linkSubs.add(cb); return () => linkSubs.delete(cb); } });
    const restored = jest.fn();
    net.onRestored(restored);
    net.start();
    const link = (s) => linkSubs.forEach((cb) => cb(s));
    link({ isConnected: true, isInternetReachable: true, type: 'wifi' });
    await jest.advanceTimersByTimeAsync(0);
    link({ isConnected: false, isInternetReachable: false, type: 'none' });
    await jest.advanceTimersByTimeAsync(0);
    link({ isConnected: true, isInternetReachable: true, type: 'wifi' });
    await jest.advanceTimersByTimeAsync(0);
    expect(restored).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(server.uploads).toHaveLength(1);
    expect(server.gets).toBe(0); // not even a status check
  });

  test('no upload module listens for the network or the app state', () => {
    for (const rel of ['lib/uploadRecovery.js', 'lib/requestUploads.js', 'lib/additionalUploads.js', 'lib/uploadErrors.js', 'components/request/UploadStatusList.js']) {
      expect(read(rel)).not.toMatch(/onRestored|restoredCount|NetInfo|AppState|useNetwork|addEventListener\('change'/);
    }
  });
});

describe('every service that takes documents has the recovery list; the others have no upload controls', () => {
  const review = read('app/request/review.js');
  test('Review sends the documents of every document-taking service through the one recovery path', () => {
    expect(review).toMatch(/const sendWithDocuments = async \(buildBody\) => \{[\s\S]*runSubmission\(\{[\s\S]*uploadUnknown: d\.uploadUnknown/);
    expect(review).toContain('await sendWithDocuments(() => buildPrivateCharterPayload(charterDraft));'); // Private Charter / Air Ambulance
    // Ground, Commercial Air, Mortal Remains, Home Healthcare, Medical Value Travel and Marine all come through the one body builder
    const builder = review.slice(review.indexOf('const buildBody = () =>'), review.indexOf('await sendWithDocuments(buildBody);'));
    for (const piece of ['buildMortalPayload(d)', 'buildHomePayload(d)', 'buildMvtPayload(d)', 'buildMarinePayload(d)', 'serviceKey,']) expect(builder).toContain(piece);
    expect(review).toContain('await sendWithDocuments(buildBody);');
  });

  test('Teleconsultation and Corporate Medical Solutions send no documents and never touch the upload path', () => {
    const tele = review.slice(review.indexOf('if (isTeleService(d.service)) {'), review.indexOf('if (isCorporateService(d.service)) {'));
    const corporate = review.slice(review.indexOf('if (isCorporateService(d.service)) {'), review.indexOf('if (isPrivateCharter(d.service)) {'));
    for (const branch of [tele, corporate]) {
      expect(branch).not.toMatch(/sendWithDocuments|apiUpload|runSubmission|ReportTiles/);
      expect(branch).toContain('await guardedSend(');
    }
    for (const step2 of ['components/request/TeleStep2.js', 'components/request/CorporateStep2.js']) expect(read(step2)).not.toMatch(/ReportTiles|apiUpload|UploadStatusList/);
  });

  test('the services that take documents all offer the file picker on their form', () => {
    for (const step2 of ['app/request/step2.js', 'components/request/MortalStep2.js', 'components/request/HomeStep2.js', 'components/request/MvtStep2.js', 'components/request/MarineStep2.js']) expect(read(step2)).toContain('ReportTiles');
  });

  test('the Submitted screen and the Add / Replace documents panel both show every file with its status and ONE "Try again" (which checks first), switched off offline', () => {
    for (const rel of ['app/request/submitted.js', 'components/request/AdditionalDocuments.js']) {
      const source = read(rel);
      expect(source).toContain('<UploadStatusList');
      expect(source).toContain('recover');
      expect(source).toContain("t('sk_try_again')");
      expect(source).toMatch(/needsNetwork/);
      expect(source).not.toMatch(/AbortController|up_check_status|up_cancel|checkMessageKey/);
    }
    const list = read('components/request/UploadStatusList.js');
    for (const key of ['up_state_accepted', 'up_state_pending', 'up_state_sending']) expect(list).toContain(key);
    expect(list).not.toMatch(/Button|onCheck|onCancel|up_check|up_cancel|up_reattach/);
  });

  test('the list uses plain words and never alarming colours: an unconfirmed file reads "Not sent yet", only a server refusal is red', () => {
    const list = read('components/request/UploadStatusList.js');
    expect(list).toContain("t('up_state_pending')");
    expect(list).toContain('#A3AEC2'); // a grey dot, not an alarming colour
    expect(list.match(/#B42828/g)).toHaveLength(2); // the refusal's own reason (its icon and its text)
    expect(read('app/request/submitted.js')).not.toMatch(/up_heading_unconfirmed|unconfirmedCount/);
  });

  test('no screen starts a cancel: leaving a screen never aborts or fails a running upload, and there is no Cancel button', () => {
    for (const rel of ['app/request/review.js', 'app/request/submitted.js', 'components/request/AdditionalDocuments.js']) {
      const source = read(rel);
      expect(source).not.toMatch(/\.abort\(\)|AbortController/);
    }
  });

  test('after a restart only what the server already holds remains: the screen says to attach the files again', () => {
    expect(I18N.EN.up_reattach_note).toMatch(/Files stay on this phone only while the app is open/);
    expect(I18N.EN.up_reattach_note).toMatch(/attach them again/);
    // no file, uri or upload id is written to any storage by these modules
    for (const rel of ['lib/uploadRecovery.js', 'lib/requestUploads.js', 'lib/additionalUploads.js', 'lib/uploadErrors.js', 'lib/secureRandom.js']) expect(read(rel)).not.toMatch(/SecureStore|AsyncStorage|localStorage|writeAsStringAsync/);
  });
});

describe('the Phase 6 encrypted draft never holds a file, a file uri, an upload id or an upload state', () => {
  test.each(DRAFT_SERVICES)('%s', (service) => {
    const dirty = {
      service, name: 'Asha', desc: 'a note',
      files: [{ uri: 'file:///cache/report.pdf', name: 'report.pdf', mimeType: 'application/pdf', size: 9, clientUploadId: '11111111-1111-4111-8111-111111111111' }],
      uploaded: ['file:///cache/report.pdf'], uploadErrors: { 'file:///cache/report.pdf': 'no' }, uploadUnknown: { 'file:///cache/report.pdf': 'unknown' }, sentRequest: { id: 7 },
      clientUploadId: '11111111-1111-4111-8111-111111111111',
    };
    const saved = JSON.stringify(pickAnswers(service, dirty));
    for (const banned of ['files', 'uploaded', 'uploadErrors', 'uploadUnknown', 'sentRequest', 'clientUploadId', 'file:///', 'report.pdf', '11111111']) expect(saved).not.toContain(banned);
  });

  test('the draft store and its schema never mention uploads', () => {
    for (const rel of ['lib/draftSchema.js', 'lib/draftStore.js', 'lib/draftManager.js']) expect(read(rel).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')).not.toMatch(/clientUploadId|uploadUnknown|uploadErrors|\buploaded\b/);
  });
});

describe('document previews and downloads while offline', () => {
  test('every entry point stops before starting a fetch while offline (the bottom message says why), and nothing is cached or retried by itself', () => {
    for (const rel of ['app/my-documents.js', 'app/request-details.js', 'app/document-preview.js']) {
      const source = read(rel);
      expect(source).toContain('useNetwork');
      expect(source).toContain('isOffline');
      expect(source).not.toContain("t('net_action_offline')");
    }
    expect(read('app/my-documents.js')).toContain('if (isOffline) return; openDocumentPreview');
    expect(read('app/request-details.js')).toMatch(/downloadSummary = async \(\) => \{\n\s+if \(isOffline\) \{ toast\(t\('net_offline_text'\)\); return; \}/);
    expect(read('app/document-preview.js')).toContain("if (isOffline && !file.file) { toast(t('net_offline_text')); return; }");
    for (const rel of ['lib/documentFile.js', 'lib/useDocumentFile.js', 'lib/download.js']) expect(read(rel)).not.toMatch(/AsyncStorage|SecureStore|documentDirectory|cacheDirectory.*persist/);
  });

  test('the Try again buttons that ask the server are switched off offline', () => {
    expect(read('app/request/submitted.js')).toMatch(/title=\{retryLabel\}[^\n]*needsNetwork/);
    expect(read('components/request/AdditionalDocuments.js')).toMatch(/title=\{buttonLabel\}[^\n]*needsNetwork/);
    expect(read('components/request/PendingUploadsNotice.js')).toMatch(/title=\{state\.checking \? t\('up_checking'\) : t\('sk_try_again'\)\}[^\n]*needsNetwork/);
  });
});

describe('the translations', () => {
  const KEYS = ['up_state_accepted', 'up_state_pending', 'up_state_sending', 'up_state_unconfirmed', 'up_unconfirmed_note', 'up_check_status', 'up_checking', 'up_retry_missing', 'up_cancel',
    'up_check_allFound', 'up_check_someMissing', 'up_check_cannotConfirm', 'up_check_unreachable', 'up_reattach_note', 'up_stopped_unknown', 'up_stopped_unsent', 'up_heading_unconfirmed', 'up_body_unconfirmed'];
  test('all 18 strings exist in all six languages, translated, with their placeholders', () => {
    for (const lang of Object.keys(I18N)) {
      for (const key of KEYS) {
        expect(typeof I18N[lang][key]).toBe('string');
        expect(I18N[lang][key].trim().length).toBeGreaterThan(0);
        if (lang !== 'EN') expect(I18N[lang][key]).not.toBe(I18N.EN[key]);
      }
      expect(I18N[lang].up_state_sending).toContain('{p}');
      expect(I18N[lang].up_unconfirmed_note).toContain('{n}');
      expect(I18N[lang].up_retry_missing).toContain('{n}');
      expect(I18N[lang].up_body_unconfirmed).toContain('{n}');
    }
  });
});
