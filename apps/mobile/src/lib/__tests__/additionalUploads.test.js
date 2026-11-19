/* global describe, test, expect, jest, __dirname */
const fs = require('fs');
const path = require('path');
const { uploadPath, remainingSlots, filesToSend, fieldsFor, sendAdditionalDocuments } = require('../additionalUploads');
const { pendingFiles } = require('../requestUploads');
const { canUploadMore } = require('../requestDocuments');

const A = { uri: 'file:///a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 10 };
const B = { uri: 'file:///b.png', name: 'b.png', mimeType: 'image/png', size: 20 };
const C = { uri: 'file:///c.jpg', name: 'c.jpg', mimeType: 'image/jpeg', size: 30 };

// A fake server: records every call; names listed in `reject` fail with a message.
function server(reject = []) {
  const calls = [];
  const send = jest.fn(async (p, file, onProgress, fields) => {
    calls.push({ path: p, uri: file.uri, fields });
    onProgress?.(0.5);
    if (reject.includes(file.uri)) throw new Error(`${file.name} was refused`);
  });
  return { send, calls };
}
const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');

describe('uploadPath / remainingSlots', () => {
  test('uses the existing endpoint of the request', () => {
    expect(uploadPath(5)).toBe('/requests/me/5/documents');
  });
  test('counts every version against the 30 limit', () => {
    expect(remainingSlots([])).toBe(30);
    expect(remainingSlots(new Array(12).fill({}))).toBe(18);
    expect(remainingSlots(new Array(30).fill({}))).toBe(0);
    expect(remainingSlots(new Array(35).fill({}))).toBe(0);
    expect(remainingSlots(undefined)).toBe(30);
  });
  test('agrees with canUploadMore at the limit', () => {
    const request = { reviewStatus: 'in_review' };
    expect(remainingSlots(new Array(29).fill({}))).toBe(1);
    expect(canUploadMore(request, new Array(29).fill({}))).toBe(true);
    expect(canUploadMore(request, new Array(30).fill({}))).toBe(false);
  });
});

describe('filesToSend', () => {
  test('additional documents carry no replacement id, even if a file had one', () => {
    const out = filesToSend(null, [A, { ...B, replacesDocumentId: 7 }]);
    expect(out).toHaveLength(2);
    expect(out.every((f) => !('replacesDocumentId' in f))).toBe(true);
    expect(out.map((f) => f.uri)).toEqual([A.uri, B.uri]);
  });
  test('a replacement is one file carrying the target id', () => {
    expect(filesToSend({ id: 7, name: 'x.pdf' }, [A, B])).toEqual([{ ...A, replacesDocumentId: 7 }]);
    expect(filesToSend({ id: 7 }, [])).toEqual([]);
  });
  test('does not change the files it is given', () => {
    const input = [{ ...A }];
    filesToSend({ id: 7 }, input);
    filesToSend(null, [{ ...A, replacesDocumentId: 1 }]);
    expect(input[0]).toEqual(A);
  });
  test('copes with no files', () => {
    expect(filesToSend(null, undefined)).toEqual([]);
  });
});

describe('fieldsFor', () => {
  test('only a file with a replacement id has fields', () => {
    expect(fieldsFor({ ...A, replacesDocumentId: 12 })).toEqual({ replacesDocumentId: 12 });
    expect(fieldsFor(A)).toBeUndefined();
    expect(fieldsFor({ ...A, replacesDocumentId: null })).toBeUndefined();
    expect(fieldsFor({ ...A, replacesDocumentId: '' })).toBeUndefined();
    expect(fieldsFor(undefined)).toBeUndefined();
  });
});

describe('sendAdditionalDocuments: additional documents', () => {
  test('sends each file, one at a time and in order, to the existing request, with no fields', async () => {
    const s = server();
    const order = [];
    const send = jest.fn(async (...args) => { order.push(args[1].uri); return s.send(...args); });
    const result = await sendAdditionalDocuments({ requestId: 5, target: null, files: [A, B, C], uploaded: [], uploadErrors: {}, send });
    expect(order).toEqual([A.uri, B.uri, C.uri]);
    expect(s.calls.map((c) => c.path)).toEqual(new Array(3).fill('/requests/me/5/documents'));
    expect(s.calls.every((c) => c.fields === undefined)).toBe(true);
    expect(result.uploaded).toEqual([A.uri, B.uri, C.uri]);
    expect(result.uploadErrors).toEqual({});
    expect(result.sentRequest).toEqual({ id: 5 });
  });

  test('reports per-file progress as index of total', async () => {
    const seen = [];
    await sendAdditionalDocuments({ requestId: 5, files: [A, B], uploaded: [], uploadErrors: {}, send: server().send, onProgress: (p) => seen.push([p.index, p.total, p.progress]) });
    expect(seen).toEqual([[1, 2, 0], [1, 2, 0.5], [2, 2, 0], [2, 2, 0.5]]);
  });

  test('a failed file does not stop the others, and says why', async () => {
    const s = server([B.uri]);
    const result = await sendAdditionalDocuments({ requestId: 5, files: [A, B, C], uploaded: [], uploadErrors: {}, send: s.send });
    expect(result.uploaded).toEqual([A.uri, C.uri]);
    expect(result.uploadErrors).toEqual({ [B.uri]: 'b.png was refused' });
  });

  test('a retry sends only the failed file, to the same request, and never a file already accepted', async () => {
    const first = await sendAdditionalDocuments({ requestId: 5, files: [A, B, C], uploaded: [], uploadErrors: {}, send: server([B.uri]).send });
    const s = server();
    const retry = await sendAdditionalDocuments({ requestId: 5, files: [A, B, C], uploaded: first.uploaded, uploadErrors: first.uploadErrors, send: s.send });
    expect(s.calls).toEqual([{ path: '/requests/me/5/documents', uri: B.uri, fields: undefined }]);
    expect(retry.uploaded.sort()).toEqual([A.uri, B.uri, C.uri].sort());
    expect(retry.uploadErrors).toEqual({});
    expect(pendingFiles([A, B, C], retry.uploaded)).toEqual([]);
  });

  test('a failure that repeats stays pending and keeps its latest message', async () => {
    const first = await sendAdditionalDocuments({ requestId: 5, files: [A], uploaded: [], uploadErrors: {}, send: server([A.uri]).send });
    const again = await sendAdditionalDocuments({ requestId: 5, files: [A], uploaded: first.uploaded, uploadErrors: first.uploadErrors, send: server([A.uri]).send });
    expect(again.uploaded).toEqual([]);
    expect(again.uploadErrors).toEqual({ [A.uri]: 'a.pdf was refused' });
  });

  test('never creates a request: only the document endpoint of this request is called', async () => {
    const s = server();
    await sendAdditionalDocuments({ requestId: 5, files: [A, B], uploaded: [], uploadErrors: {}, send: s.send });
    expect(s.send).toHaveBeenCalledTimes(2);
    for (const call of s.calls) expect(call.path).toMatch(/^\/requests\/me\/5\/documents$/);
  });

  test('refuses to run without a request', () => {
    expect(() => sendAdditionalDocuments({ requestId: undefined, files: [A], send: jest.fn() })).toThrow('No request');
    expect(() => sendAdditionalDocuments({ requestId: null, files: [A], send: jest.fn() })).toThrow('No request');
  });
});

describe('sendAdditionalDocuments: replacement', () => {
  test('sends replacesDocumentId with the file, to the same endpoint', async () => {
    const s = server();
    const result = await sendAdditionalDocuments({ requestId: 5, target: { id: 12, name: 'old.pdf' }, files: [A], uploaded: [], uploadErrors: {}, send: s.send });
    expect(s.calls).toEqual([{ path: '/requests/me/5/documents', uri: A.uri, fields: { replacesDocumentId: 12 } }]);
    expect(result.uploaded).toEqual([A.uri]);
  });

  test('sends only one file, however many are given', async () => {
    const s = server();
    await sendAdditionalDocuments({ requestId: 5, target: { id: 12 }, files: [A, B], uploaded: [], uploadErrors: {}, send: s.send });
    expect(s.calls).toHaveLength(1);
  });

  test('a failed replacement can be retried with the same target id, without a second request', async () => {
    const first = await sendAdditionalDocuments({ requestId: 5, target: { id: 12 }, files: [A], uploaded: [], uploadErrors: {}, send: server([A.uri]).send });
    expect(first.uploaded).toEqual([]);
    const s = server();
    const retry = await sendAdditionalDocuments({ requestId: 5, target: { id: 12 }, files: [A], uploaded: first.uploaded, uploadErrors: first.uploadErrors, send: s.send });
    expect(s.calls).toEqual([{ path: '/requests/me/5/documents', uri: A.uri, fields: { replacesDocumentId: 12 } }]);
    expect(retry.uploaded).toEqual([A.uri]);
  });

  test('a refused replacement (server says the target is invalid) is reported on the file', async () => {
    const send = jest.fn(async () => { throw new Error('The document to replace was not found on this request, or was already replaced.'); });
    const result = await sendAdditionalDocuments({ requestId: 5, target: { id: 99 }, files: [A], uploaded: [], uploadErrors: {}, send });
    expect(result.uploaded).toEqual([]);
    expect(result.uploadErrors[A.uri]).toMatch(/already replaced/);
  });
});

describe('wiring (source checks)', () => {
  const component = read('../../components/request/AdditionalDocuments.js');

  test('the request details screen shows the upload card and reloads after a run', () => {
    const screen = read('../../app/request-details.js');
    expect(screen).toMatch(/import AdditionalDocuments from '\.\.\/components\/request\/AdditionalDocuments'/);
    expect(screen).toMatch(/<AdditionalDocuments request=\{request\} onUploaded=\{reload\} \/>/);
    expect(screen).toContain("fetcher: () => apiGet(`/requests/me/${id}`).then(({ request: r }) => r),"); // the reload after an upload is useResource's quiet refetch
  });

  test('the card appears only for requests in the review workflow, and respects approval and the limit', () => {
    expect(component).toMatch(/if \(reviewState\(request\) === null\) return null;/);
    expect(component).toMatch(/uploadBlockReason\(request, documents\)/);
    expect(component).toMatch(/documentHistory\(documents\)\.filter\(\(d\) => d\.canReplace\)/);
  });

  test('the card never creates a request or a Case', () => {
    expect(component).not.toMatch(/apiPost|runSubmission\(|createRequest|'\/requests'/);
    expect(component).toMatch(/requestId: request\.id/);
  });

  test('the card reloads once per run, after the run has finished', () => {
    expect(component.match(/onUploaded\?\.\(\)/g)).toHaveLength(1);
    expect(component.indexOf('finally')).toBeLessThan(component.indexOf('onUploaded?.()'));
  });

  test('the request form and its retry screen are not changed to use any of this', () => {
    for (const file of ['../../app/request/review.js', '../../app/request/submitted.js']) {
      const source = read(file);
      expect(source).not.toMatch(/additionalUploads|AdditionalDocuments|replacesDocumentId/);
    }
  });

  test('the shared file tiles keep the request form behaviour by default', () => {
    const fields = read('../../components/request/fields.js');
    expect(fields).toMatch(/maxFiles = MAX_REPORT_FILES, multiple = true/);
    expect(fields).toMatch(/multiple, copyToCacheDirectory: true/);
  });
});
