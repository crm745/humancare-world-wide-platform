/* global describe, it, expect, jest, __dirname */
const fs = require('fs');
const path = require('path');
const { pendingFiles, runSubmission } = require('../requestUploads');
const { draftForService } = require('../requestForm');

const file = (name) => ({ uri: `file:///${name}`, name, mimeType: 'application/pdf', size: 69 });
const OK = file('report-ok.pdf');
const BAD = file('report-bad.pdf');
const OK2 = file('report-ok-2.pdf');
const SAVED = { id: 7, referenceNumber: 'REQ-1007', title: 'Private Charter Air Ambulance Service' };

// An upload function that fails for the named files until told otherwise.
function server(failing = []) {
  const failNames = new Set(failing);
  const calls = [];
  const upload = jest.fn(async (f, onProgress, sent) => {
    calls.push({ name: f.name, requestId: sent && sent.id });
    onProgress(0.5);
    if (failNames.has(f.name)) throw new Error(`The server could not store ${f.name}.`);
  });
  return { upload, calls, fix: (name) => failNames.delete(name), breakFile: (name) => failNames.add(name) };
}
const first = (extra = {}) => ({ sentRequest: null, uploaded: [], uploadErrors: {}, files: [OK, BAD], createRequest: jest.fn(async () => SAVED), ...extra });
// What the screen does between attempts: it keeps the returned state in the draft.
const next = (state, result, extra = {}) => ({ ...state, ...result, ...extra });

describe('one file uploads and one fails', () => {
  it('saves the request, keeps the good file, and reports the failed one', async () => {
    const s = server([BAD.name]);
    const result = await runSubmission({ ...first(), upload: s.upload });
    expect(result.sentRequest).toEqual(SAVED);
    expect(result.uploaded).toEqual([OK.uri]);
    expect(result.uploadErrors).toEqual({ [BAD.uri]: 'The server could not store report-bad.pdf.' });
    expect(pendingFiles([OK, BAD], result.uploaded)).toEqual([BAD]);
  });

  it('a failed file does not stop the files after it', async () => {
    const s = server([BAD.name]);
    const result = await runSubmission({ ...first({ files: [OK, BAD, OK2] }), upload: s.upload });
    expect(s.calls.map((c) => c.name)).toEqual(['report-ok.pdf', 'report-bad.pdf', 'report-ok-2.pdf']);
    expect(result.uploaded).toEqual([OK.uri, OK2.uri]);
  });

  it('an upload that fails with no message still gets one to show', async () => {
    const result = await runSubmission({ ...first(), upload: jest.fn(async (f) => { if (f === BAD) throw new Error(''); }) });
    expect(result.uploadErrors[BAD.uri]).toBe('Upload failed. Please try again.');
  });

  it('with no files there is nothing pending and the request is still saved once', async () => {
    const create = jest.fn(async () => SAVED);
    const result = await runSubmission({ ...first({ files: [], createRequest: create }), upload: jest.fn() });
    expect(create).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sentRequest: SAVED, uploaded: [], uploadErrors: {} });
  });
});

describe('the failure stays visible until the file is accepted', () => {
  it('the same file is pending, with its message, after every failed attempt', async () => {
    const s = server([BAD.name]);
    let state = first();
    state = next(state, await runSubmission({ ...state, upload: s.upload }));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(pendingFiles(state.files, state.uploaded).map((f) => f.name)).toEqual([BAD.name]);
      expect(state.uploadErrors[BAD.uri]).toMatch(/could not store/);
      state = next(state, await runSubmission({ ...state, upload: s.upload }));
    }
  });

  it('the chosen files are never removed or changed by an attempt', async () => {
    const files = [{ ...OK }, { ...BAD }];
    const before = JSON.stringify(files);
    const uploaded = [];
    const s = server([BAD.name]);
    await runSubmission({ ...first({ files, uploaded }), upload: s.upload });
    expect(JSON.stringify(files)).toBe(before);
    expect(uploaded).toEqual([]); // the input state is not edited in place either
  });

  it('the screens use this state, not a toast, to say what happened', () => {
    const src = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'request', p), 'utf8');
    const submitted = src('submitted.js');
    expect(submitted).toMatch(/pendingFiles\(draft\.files, draft\.uploaded\)/);
    expect(submitted).toContain('Documents not uploaded');
    expect(submitted).toContain('Retry failed uploads');
    expect(submitted).toMatch(/\{!incomplete && \(\s*<Card/); // no "Next Steps" while documents are missing
    const review = src('review.js');
    expect(review).toMatch(/isPrivateCharter\(d\.service\)\) \{[\s\S]*runSubmission\(/);
  });
});

describe('retrying only the failed documents', () => {
  it('uploads just the file that failed, to the request already saved', async () => {
    const s = server([BAD.name]);
    let state = first({ files: [OK, BAD, OK2] });
    state = next(state, await runSubmission({ ...state, upload: s.upload }));
    s.calls.length = 0;
    s.fix(BAD.name);
    await runSubmission({ ...state, upload: s.upload });
    expect(s.calls).toEqual([{ name: 'report-bad.pdf', requestId: 7 }]);
  });

  it('a retry reports progress only for the files it sends', async () => {
    const s = server([BAD.name]);
    let state = first({ files: [OK, BAD, OK2] });
    state = next(state, await runSubmission({ ...state, upload: s.upload }));
    const progress = [];
    s.fix(BAD.name);
    await runSubmission({ ...state, upload: s.upload, onProgress: (p) => progress.push([p.index, p.total]) });
    expect(new Set(progress.map(([, total]) => total))).toEqual(new Set([1]));
    expect(progress[0]).toEqual([1, 1]);
  });
});

describe('a successful retry', () => {
  it('accepts the file, clears its error, and leaves nothing pending', async () => {
    const s = server([BAD.name]);
    let state = first();
    state = next(state, await runSubmission({ ...state, upload: s.upload }));
    s.fix(BAD.name);
    state = next(state, await runSubmission({ ...state, upload: s.upload }));
    expect(state.uploaded.sort()).toEqual([OK.uri, BAD.uri].sort());
    expect(state.uploadErrors).toEqual({});
    expect(pendingFiles(state.files, state.uploaded)).toEqual([]);
  });

  it('a file accepted earlier is never sent a second time', async () => {
    const s = server([BAD.name]);
    let state = first();
    state = next(state, await runSubmission({ ...state, upload: s.upload }));
    s.fix(BAD.name);
    state = next(state, await runSubmission({ ...state, upload: s.upload }));
    await runSubmission({ ...state, upload: s.upload });
    expect(s.calls.filter((c) => c.name === OK.name)).toHaveLength(1);
    expect(s.calls.filter((c) => c.name === BAD.name)).toHaveLength(2); // the failed try and the retry
  });
});

describe('a retry that fails again', () => {
  it('keeps the file pending with the newest message, and keeps what already went through', async () => {
    const s = server([BAD.name]);
    let state = first();
    state = next(state, await runSubmission({ ...state, upload: s.upload }));
    s.upload.mockImplementationOnce(async () => { throw new Error('Still too busy. Try later.'); });
    state = next(state, await runSubmission({ ...state, upload: s.upload }));
    expect(state.uploaded).toEqual([OK.uri]);
    expect(state.uploadErrors).toEqual({ [BAD.uri]: 'Still too busy. Try later.' });
    expect(state.sentRequest).toEqual(SAVED);
  });

  it('can fail more than once and still succeed on a later try', async () => {
    const s = server([BAD.name]);
    let state = first();
    for (let i = 0; i < 3; i += 1) state = next(state, await runSubmission({ ...state, upload: s.upload }));
    expect(pendingFiles(state.files, state.uploaded)).toEqual([BAD]);
    s.fix(BAD.name);
    state = next(state, await runSubmission({ ...state, upload: s.upload }));
    expect(pendingFiles(state.files, state.uploaded)).toEqual([]);
  });

  it('a retry that loses the network is reported per file and does not throw', async () => {
    let state = first();
    state = next(state, await runSubmission({ ...state, upload: server([BAD.name]).upload }));
    const offline = jest.fn(async () => { throw new TypeError('Network request failed'); });
    const result = await runSubmission({ ...state, upload: offline });
    expect(result.uploadErrors).toEqual({ [BAD.uri]: 'Network request failed' });
    expect(result.sentRequest).toEqual(SAVED);
  });
});

describe('no duplicate request', () => {
  it('the request is created once, however many retries follow', async () => {
    const s = server([BAD.name]);
    const create = jest.fn(async () => SAVED);
    let state = first({ createRequest: create });
    for (let i = 0; i < 4; i += 1) state = next(state, await runSubmission({ ...state, upload: s.upload }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(s.calls.every((c) => c.requestId === 7)).toBe(true);
  });

  it('pressing submit again after the request is saved only uploads: it never creates another', async () => {
    const create = jest.fn(async () => SAVED);
    const state = first({ sentRequest: SAVED, uploaded: [OK.uri], createRequest: create });
    await runSubmission({ ...state, upload: server().upload });
    expect(create).not.toHaveBeenCalled();
  });

  it('is saved before any file is sent, so leaving mid-upload cannot lose it', async () => {
    const order = [];
    await runSubmission({
      ...first(), createRequest: async () => { order.push('create'); return SAVED; },
      onSent: (s) => order.push(`saved:${s.sentRequest.id}`), upload: async (f) => { order.push(`upload:${f.name}`); },
    });
    expect(order).toEqual(['create', 'saved:7', 'upload:report-ok.pdf', 'upload:report-bad.pdf']);
  });

  it('a request that could not be saved marks nothing as sent, uploads nothing, and can be tried again', async () => {
    const s = server();
    const create = jest.fn().mockRejectedValueOnce(new Error('Please correct the highlighted fields.')).mockResolvedValueOnce(SAVED);
    await expect(runSubmission({ ...first({ createRequest: create }), upload: s.upload })).rejects.toThrow('highlighted');
    expect(s.upload).not.toHaveBeenCalled();
    const result = await runSubmission({ ...first({ createRequest: create }), upload: s.upload });
    expect(create).toHaveBeenCalledTimes(2); // the first never saved anything, so a second attempt is correct
    expect(result.sentRequest).toEqual(SAVED);
    expect(result.uploaded).toEqual([OK.uri, BAD.uri]);
  });
});

describe('a new request starts clean', () => {
  const INITIAL = { service: 'air', files: [], sentRequest: null, uploaded: [], uploadErrors: {}, changingService: false };

  it('a fresh draft has no saved request or upload state', () => {
    const previous = { ...INITIAL, sentRequest: SAVED, uploaded: [OK.uri], uploadErrors: { [BAD.uri]: 'x' } };
    expect(draftForService(previous, 'ground', INITIAL)).toEqual({ ...INITIAL, service: 'ground' });
  });

  it('swapping the service inside the form does not carry a saved request into another one', () => {
    const previous = { ...INITIAL, service: 'privatecharter', changingService: true, name: 'A B', sentRequest: SAVED, uploaded: [OK.uri], uploadErrors: { [BAD.uri]: 'x' } };
    const swapped = draftForService(previous, 'ground', INITIAL);
    expect(swapped).toMatchObject({ name: 'A B', sentRequest: null, uploaded: [], uploadErrors: {} });
  });
});

describe('a request needs at least one document to be submitted', () => {
  const { submissionState } = require('../requestUploads');
  const { needsDocument } = require('../privateCharter');
  const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8');

  it('a Private Charter form with no file chosen is not ready to send, and other services are not affected', () => {
    expect(needsDocument({ service: 'privatecharter', files: [] })).toBe(true);
    expect(needsDocument({ service: 'air', files: [] })).toBe(true); // the generic "air" tile is Private Charter
    expect(needsDocument({ service: 'privatecharter', files: [{ uri: 'a' }] })).toBe(false);
    for (const service of ['ground', 'hospital', 'commercialair', 'mortal', 'homecare', 'tele']) expect(needsDocument({ service, files: [] })).toBe(false);
  });

  it('a saved request with no accepted document is only a draft, however many files were chosen', () => {
    expect(submissionState({ sentRequest: SAVED, files: [OK, BAD], uploaded: [] })).toBe('draft');
    expect(submissionState({ sentRequest: SAVED, files: [], uploaded: [] })).toBe('draft');
  });

  it('is submitted once one document is accepted: partial while others are missing, complete when all are in', () => {
    expect(submissionState({ sentRequest: SAVED, files: [OK, BAD], uploaded: [OK.uri] })).toBe('partial');
    expect(submissionState({ sentRequest: SAVED, files: [OK, BAD], uploaded: [OK.uri, BAD.uri] })).toBe('complete');
    expect(submissionState({ sentRequest: null, files: [OK], uploaded: [] })).toBe('none');
  });

  it('a retry that gets the first document in turns the draft into a submission', async () => {
    const s = server();
    let state = first({ files: [OK, BAD] });
    state = next(state, await runSubmission({ ...state, upload: server([OK.name, BAD.name]).upload }));
    expect(submissionState(state)).toBe('draft');
    state = next(state, await runSubmission({ ...state, upload: s.upload }));
    expect(submissionState(state)).toBe('complete');
  });

  it('the form blocks Continue without a file, and the review screen never sends without one', () => {
    const step2 = read('app', 'request', 'step2.js');
    expect(step2).toMatch(/\['files', needsDocument\(draft\)\]/);
    expect(step2).toContain('Upload at least one document to submit this request.');
    const review = read('app', 'request', 'review.js');
    expect(review).toMatch(/if \(needsDocument\(d\)\) \{[\s\S]*goToStep\(2\);\s*return;/);
    // ...and it is checked before the request is created.
    expect(review.indexOf('needsDocument(d)')).toBeLessThan(review.indexOf('runSubmission('));
  });

  it('the success screen says "not submitted" while no document is accepted, instead of "Thank You"', () => {
    const submitted = read('app', 'request', 'submitted.js');
    expect(submitted).toContain('Request not submitted yet');
    expect(submitted).toContain("submissionState(draft) === 'draft'");
    expect(submitted).toContain("isDraft ? 'Not submitted'");
  });
});
