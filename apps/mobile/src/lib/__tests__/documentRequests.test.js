const { openDocumentRequests, documentRequestFields } = require('../documentRequests');
const { sendAdditionalDocuments } = require('../additionalUploads');

const request = (documentRequests) => ({ id: 7, reviewStatus: 'approved', case: { documentRequests } });

describe('openDocumentRequests', () => {
  it('lists the open requests oldest first with only the display fields', () => {
    const list = openDocumentRequests(request([
      { id: 9, description: ' Passport copy ', reason: ' Needed for the airline ', createdAt: '2026-11-02T10:00:00Z', storageKey: 'secret' },
      { id: 4, description: 'Latest ECG', reason: null, createdAt: '2026-11-01T10:00:00Z' },
    ]));
    expect(list).toEqual([
      { id: 4, description: 'Latest ECG', reason: null, createdAt: '2026-11-01T10:00:00Z' },
      { id: 9, description: 'Passport copy', reason: 'Needed for the airline', createdAt: '2026-11-02T10:00:00Z' },
    ]);
  });

  it('ignores malformed entries and requests without a Case', () => {
    expect(openDocumentRequests(request([null, { id: 'x', description: 'a' }, { id: 3, description: '  ' }, { description: 'no id' }]))).toEqual([]);
    expect(openDocumentRequests({ id: 1 })).toEqual([]);
    expect(openDocumentRequests(null)).toEqual([]);
  });
});

describe('sending documents for a document request', () => {
  it('carries documentRequestId on every upload and never replaces anything', async () => {
    const calls = [];
    const result = await sendAdditionalDocuments({
      requestId: 7, target: null, documentRequest: { id: 4 }, files: [{ uri: 'a', name: 'a.pdf' }, { uri: 'b', name: 'b.pdf' }],
      uploaded: [], uploadErrors: {}, send: async (path, file, _p, fields) => { calls.push([path, file.uri, fields]); },
    });
    // each file also carries its own upload id (Phase 5: the server recognises a retry of the same file by it)
    expect(calls).toEqual([['/requests/me/7/documents', 'a', { documentRequestId: 4, clientUploadId: expect.stringMatching(/^[0-9a-f-]{36}$/) }], ['/requests/me/7/documents', 'b', { documentRequestId: 4, clientUploadId: expect.stringMatching(/^[0-9a-f-]{36}$/) }]]);
    expect(result.uploaded).toEqual(['a', 'b']);
  });

  it('sends no extra fields for an ordinary additional upload', async () => {
    const seen = [];
    await sendAdditionalDocuments({ requestId: 7, target: null, files: [{ uri: 'a' }], uploaded: [], uploadErrors: {}, send: async (_p, _f, _r, fields) => { seen.push(fields); } });
    // an ordinary upload carries only its own upload id: no document request id, nothing replaced
    expect(seen).toEqual([{ clientUploadId: expect.stringMatching(/^[0-9a-f-]{36}$/) }]);
    expect(documentRequestFields(null)).toBeUndefined();
  });
});
