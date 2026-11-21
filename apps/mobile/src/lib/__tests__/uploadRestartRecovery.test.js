/* global describe, test, expect, jest, __dirname */
// Phase 5 (final corrections): an unknown upload across an app restart. The journal keeps only random upload ids (never a file name, uri or content); after a restart they are checked against
// the server before anything is attached again; a re-attached file reuses the id so an original that arrives late is kept once. Nothing is replayed by itself.
const fs = require('fs');
const path = require('path');
const { createUploadJournal, JOURNAL_KEY, JOURNAL_TTL_MS } = require('../uploadJournal');
const { runSubmission, recoverUploads } = require('../requestUploads');
const { stampUploadIds, uploadIdOf, checkStoredUploads, storedCheckKey, classifyUploadFailure, withoutUploadId } = require('../uploadRecovery');
const I18N = require('../../data/i18n.json');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').split('\r\n').join('\n');
const memoryStorage = () => { const map = new Map(); return { map, get: async (k) => (map.has(k) ? map.get(k) : null), set: async (k, v) => { map.set(k, v); }, del: async (k) => { map.delete(k); } }; };
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const SAVED = { id: 7, referenceNumber: 'REQ-1007', title: 'Ground Ambulance' };
const lost = () => Object.assign(new Error('not confirmed'), { code: 'network', outcomeUnknown: true });
const file = (name, content) => ({ uri: `file:///cache/${name}`, name, mimeType: 'application/pdf', size: content.length, content });
const sequence = () => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; };

describe('the journal keeps ids only', () => {
  const make = (storage = memoryStorage(), user = { id: 'patient:7' }, clock = { t: 1_700_000_000_000 }) => ({ storage, user, clock, journal: createUploadJournal({ storage, getUserId: async () => user.id, now: () => clock.t }) });

  test('what is written is { requestId, userId, at, ids }: no file name, uri, size or content, and nothing a person typed', async () => {
    const { journal, storage } = make();
    await journal.begin(7, ID1);
    const text = storage.map.get(JOURNAL_KEY);
    expect(JSON.parse(text)).toEqual({ v: 1, items: [{ requestId: 7, userId: 'patient:7', at: 1_700_000_000_000, ids: [ID1] }] });
    for (const banned of ['file://', '.pdf', 'name', 'uri', 'size', 'mime', 'content']) expect(text).not.toContain(banned);
  });

  test('it survives a restart (a new journal over the same storage), is written once per id, and is lower-cased', async () => {
    const { storage } = make();
    const first = createUploadJournal({ storage, getUserId: async () => 'patient:7' });
    await first.begin(7, ID1.toUpperCase());
    await first.begin(7, ID1);
    await first.begin(7, ID2);
    const afterRestart = createUploadJournal({ storage, getUserId: async () => 'patient:7' });
    expect(await afterRestart.idsFor(7)).toEqual([ID1, ID2]);
    expect(await afterRestart.idsFor('7')).toEqual([ID1, ID2]);
    expect(await afterRestart.idsFor(8)).toEqual([]);
  });

  test('an outcome that is known is forgotten; an unknown one is kept; a refused id is never journalled', async () => {
    const { journal } = make();
    await journal.begin(7, ID1);
    await journal.begin(7, ID2);
    await journal.settle(7, ID1, 'accepted');
    await journal.settle(7, ID2, 'unconfirmed');
    expect(await journal.idsFor(7)).toEqual([ID2]);
    await journal.settle(7, ID2, 'refused');
    expect(await journal.idsFor(7)).toEqual([]);
    expect(await journal.begin(7, 'not-a-uuid')).toBe(false);
  });

  test('another account never sees or removes these ids; entries expire; damaged storage is ignored; account deletion clears everything', async () => {
    const { storage, clock } = make();
    const alice = createUploadJournal({ storage, getUserId: async () => 'patient:7', now: () => clock.t });
    const bob = createUploadJournal({ storage, getUserId: async () => 'patient:8', now: () => clock.t });
    const nobody = createUploadJournal({ storage, getUserId: async () => null, now: () => clock.t });
    await alice.begin(7, ID1);
    expect(await bob.idsFor(7)).toEqual([]);
    await bob.forget(7, [ID1]);
    await bob.forgetRequest(7);
    expect(await alice.idsFor(7)).toEqual([ID1]);
    expect(await nobody.idsFor(7)).toEqual([]);
    expect(await nobody.begin(7, ID2)).toBe(false);
    clock.t += JOURNAL_TTL_MS + 1;
    expect(await alice.idsFor(7)).toEqual([]);
    storage.map.set(JOURNAL_KEY, '{not json');
    expect(await alice.idsFor(7)).toEqual([]);
    storage.map.set(JOURNAL_KEY, JSON.stringify({ v: 9, items: [] }));
    expect(await alice.idsFor(7)).toEqual([]);
    clock.t -= JOURNAL_TTL_MS + 1;
    await alice.begin(7, ID1);
    await alice.clearAll();
    expect(storage.map.has(JOURNAL_KEY)).toBe(false);
  });

  test('a storage that fails never throws into an upload', async () => {
    const broken = { get: async () => { throw new Error('locked'); }, set: async () => { throw new Error('locked'); }, del: async () => { throw new Error('locked'); } };
    const journal = createUploadJournal({ storage: broken, getUserId: async () => 'patient:7' });
    expect(await journal.begin(7, ID1)).toBe(false);
    expect(await journal.idsFor(7)).toEqual([]);
    expect(await journal.clearAll()).toBe(false);
  });
});

describe('uploads write their id BEFORE sending and forget it when the outcome is known', () => {
  test('the id is journalled before the first byte; accepted and refused are forgotten; an unconfirmed one stays', async () => {
    const storage = memoryStorage();
    const journal = createUploadJournal({ storage, getUserId: async () => 'patient:7' });
    const A = file('a.pdf', 'AAAA');
    const B = file('b.pdf', 'BBBB');
    const C = file('c.pdf', 'CCCC');
    const seenAtSend = {};
    const upload = jest.fn(async (f) => {
      seenAtSend[f.name] = await journal.idsFor(SAVED.id); // what a crash at this moment would leave behind
      if (f.name === 'b.pdf') throw Object.assign(new Error('Unsupported file type.'), { status: 422 });
      if (f.name === 'c.pdf') throw lost();
    });
    const result = await runSubmission({ sentRequest: null, uploaded: [], uploadErrors: {}, uploadUnknown: {}, files: [A, B, C], createRequest: async () => SAVED, upload, generateId: sequence(), journal });
    const id = (name) => result.files.find((f) => f.name === name).clientUploadId;
    expect(seenAtSend['a.pdf']).toContain(id('a.pdf'));
    expect(seenAtSend['c.pdf']).toContain(id('c.pdf'));
    expect(await journal.idsFor(SAVED.id)).toEqual([id('c.pdf')]); // only the unknown outcome is left for a restart to check
    expect(result.uploaded).toEqual([A.uri]);
    expect(result.uploadErrors).toHaveProperty([B.uri]);
  });

  test('a certain non-delivery (cancelled before sending, or the scanner refused to store it) is forgotten, so a restart does not worry about it', async () => {
    const journal = createUploadJournal({ storage: memoryStorage(), getUserId: async () => 'patient:7' });
    const A = file('a.pdf', 'AAAA');
    const upload = jest.fn(async () => { throw Object.assign(new Error('could not scan'), { status: 503, code: 'scan_unavailable' }); });
    const result = await runSubmission({ sentRequest: SAVED, uploaded: [], uploadErrors: {}, uploadUnknown: {}, files: [A], upload, generateId: sequence(), journal });
    expect(result.note).toMatchObject({ stopped: 'notSent' });
    expect(result.uploadUnknown).toEqual({});
    expect(await journal.idsFor(SAVED.id)).toEqual([]);
  });

  test('"scanner could not scan" is a certain not-stored (retry the same upload); "infected" is a refusal', () => {
    expect(classifyUploadFailure(Object.assign(new Error('x'), { status: 503, code: 'scan_unavailable' }))).toBe('notSent');
    expect(classifyUploadFailure(Object.assign(new Error('x'), { status: 422, code: 'file_infected' }))).toBe('refused');
    expect(classifyUploadFailure(Object.assign(new Error('x'), { status: 503 }))).toBe('unconfirmed'); // any other 5xx still says nothing
  });
});

// A server that keeps documents by upload id and proves content by SHA-256 (here: the content itself). Deliveries can be held back and released later, like a slow connection.
function lateServer({ supportsIds = true } = {}) {
  const s = { docs: [], held: [], gets: 0, supportsIds };
  const deliver = (f) => {
    const existing = s.docs.find((d) => d.clientUploadId === f.clientUploadId);
    if (existing) {
      if (existing.content !== f.content) throw Object.assign(new Error('That upload id was already used for a different file.'), { status: 409, code: 'client_upload_id_reused' });
      return existing; // a repeat of the same upload: the original, no second document
    }
    const doc = { id: s.docs.length + 1, originalName: f.name, content: f.content, clientUploadId: f.clientUploadId };
    s.docs.push(doc);
    return doc;
  };
  s.upload = jest.fn(async (f) => { if (s.hold) { s.held.push(f); throw lost(); } return { document: deliver(f) }; });
  s.release = () => { for (const f of s.held.splice(0)) { try { deliver(f); } catch { /* refused, like the real server */ } } };
  s.fetchRequest = jest.fn(async () => {
    s.gets += 1;
    if (s.unreachable) throw Object.assign(new Error('offline'), { code: 'network' });
    return { request: { id: SAVED.id, requestDocuments: s.docs.map((d) => (supportsIds ? { id: d.id, originalName: d.originalName, clientUploadId: d.clientUploadId } : { id: d.id, originalName: d.originalName })), ...(supportsIds ? { clientUploadIdSupported: true } : {}) } };
  });
  return s;
}

describe('after a restart: check the stored ids against the server before anything is attached', () => {
  async function killedMidUpload(server, storage) {
    const journal = createUploadJournal({ storage, getUserId: async () => 'patient:7' });
    server.hold = true; // the connection dies mid-transfer: the server may still receive the bytes later
    const A = file('report.pdf', 'THE REPORT');
    const result = await runSubmission({ sentRequest: SAVED, uploaded: [], uploadErrors: {}, uploadUnknown: {}, files: [A], upload: server.upload, generateId: sequence(), journal });
    server.hold = false;
    return { id: result.files[0].clientUploadId, A: result.files[0] };
  }
  const restart = (storage) => createUploadJournal({ storage, getUserId: async () => 'patient:7' }); // a new process: memory is gone, only the storage remains

  test('the id survives the restart; a file the server has is found by its id and forgotten', async () => {
    const storage = memoryStorage();
    const server = lateServer();
    const { id, A } = await killedMidUpload(server, storage);
    server.docs.push({ id: 1, originalName: A.name, content: A.content, clientUploadId: id }); // it had arrived after all
    const journal = restart(storage);
    const ids = await journal.idsFor(SAVED.id);
    expect(ids).toEqual([id]);
    const check = await checkStoredUploads({ requestId: SAVED.id, ids, fetchRequest: server.fetchRequest });
    expect(check).toMatchObject({ result: 'checked', found: [id], missing: [], unverifiable: [] });
    expect(storedCheckKey(check)).toBe('allFound');
    await journal.forget(SAVED.id, check.found);
    expect(await journal.idsFor(SAVED.id)).toEqual([]);
  });

  test('an id the server certainly does not have is "missing" (attach again), and the id is kept', async () => {
    const storage = memoryStorage();
    const server = lateServer();
    const { id } = await killedMidUpload(server, storage);
    const ids = await restart(storage).idsFor(SAVED.id);
    const check = await checkStoredUploads({ requestId: SAVED.id, ids, fetchRequest: server.fetchRequest });
    expect(check).toMatchObject({ found: [], missing: [id], unverifiable: [] });
    expect(storedCheckKey(check)).toBe('someMissing');
    expect(await restart(storage).idsFor(SAVED.id)).toEqual([id]); // nothing was forgotten: the original may still arrive
  });

  test('an OLD server, an incomplete answer and an unreachable server never prove an upload is missing', async () => {
    const storage = memoryStorage();
    const server = lateServer({ supportsIds: false });
    const { id } = await killedMidUpload(server, storage);
    const old = await checkStoredUploads({ requestId: SAVED.id, ids: [id], fetchRequest: server.fetchRequest });
    expect(old).toMatchObject({ missing: [], unverifiable: [id] });
    expect(storedCheckKey(old)).toBe('cannotConfirm');
    const noList = await checkStoredUploads({ requestId: SAVED.id, ids: [id], fetchRequest: async () => ({ request: { id: 7, clientUploadIdSupported: true } }) });
    expect(noList).toMatchObject({ missing: [], unverifiable: [id] });
    const flagOnlyOnList = await checkStoredUploads({ requestId: SAVED.id, ids: [id], fetchRequest: async () => ({ request: { id: 7, requestDocuments: [] } }) });
    expect(flagOnlyOnList).toMatchObject({ missing: [], unverifiable: [id] }); // the list without the server's promise to keep ids proves nothing
    server.unreachable = true;
    const down = await checkStoredUploads({ requestId: SAVED.id, ids: [id], fetchRequest: server.fetchRequest });
    expect(down.result).toBe('unreachable');
    expect(storedCheckKey(down)).toBe('unreachable');
    expect(await restart(storage).idsFor(SAVED.id)).toEqual([id]);
    expect(storedCheckKey(await checkStoredUploads({ requestId: 7, ids: [], fetchRequest: server.fetchRequest }))).toBe('nothing');
  });

  test('a check only ever READS: it asks for the document list and sends no upload', async () => {
    const server = lateServer();
    await checkStoredUploads({ requestId: SAVED.id, ids: [ID1], fetchRequest: server.fetchRequest });
    expect(server.gets).toBe(1);
    expect(server.upload).not.toHaveBeenCalled();
  });

  test('DELAYED ORIGINAL: the file is attached again with the stored id, and when the original then arrives late the server keeps ONE document', async () => {
    const storage = memoryStorage();
    const server = lateServer();
    const { id } = await killedMidUpload(server, storage); // the original is held back on the wire
    expect(server.docs).toHaveLength(0);
    // restart: the check says it is missing (not arrived YET)
    const journal = restart(storage);
    const ids = await journal.idsFor(SAVED.id);
    expect(storedCheckKey(await checkStoredUploads({ requestId: SAVED.id, ids, fetchRequest: server.fetchRequest }))).toBe('someMissing');
    // the person attaches the same file again: a NEW file entry (no id yet) that adopts the stored id
    const reattached = file('report.pdf', 'THE REPORT');
    const stamped = stampUploadIds([reattached], sequence(), ids);
    expect(uploadIdOf(stamped[0])).toBe(id);
    const result = await runSubmission({ sentRequest: SAVED, uploaded: [], uploadErrors: {}, uploadUnknown: {}, files: stamped, upload: server.upload, generateId: sequence(), journal, adoptIds: ids });
    expect(result.uploaded).toEqual([reattached.uri]);
    expect(server.docs).toHaveLength(1);
    server.release(); // ...and now the original finally arrives
    expect(server.docs).toHaveLength(1); // recognised as the same upload: no duplicate
    expect(await journal.idsFor(SAVED.id)).toEqual([]); // accepted: forgotten
  });

  test('a DIFFERENT file given the stored id is refused (409), keeps no stale id, and is not resent by itself; the person\'s next try uses a fresh id', async () => {
    const storage = memoryStorage();
    const server = lateServer();
    const { id } = await killedMidUpload(server, storage);
    server.docs.push({ id: 1, originalName: 'report.pdf', content: 'THE REPORT', clientUploadId: id }); // the original did arrive
    const journal = restart(storage);
    const other = file('other.pdf', 'SOMETHING ELSE');
    const first = await runSubmission({ sentRequest: SAVED, uploaded: [], uploadErrors: {}, uploadUnknown: {}, files: [other], upload: server.upload, generateId: sequence(), journal, adoptIds: [id] });
    expect(server.upload).toHaveBeenCalledTimes(2); // the held original earlier + this one: nothing was resent automatically
    expect(first.uploaded).toEqual([]);
    expect(first.uploadErrors[other.uri]).toMatch(/different file/);
    expect(uploadIdOf(first.files[0])).toBeNull(); // the id that belongs to another file is gone from this one
    expect(server.docs).toHaveLength(1);
    const next = await runSubmission({ sentRequest: SAVED, uploaded: first.uploaded, uploadErrors: first.uploadErrors, uploadUnknown: first.uploadUnknown, files: first.files, upload: server.upload, generateId: () => 'ffffffff-ffff-4fff-8fff-ffffffffffff', journal });
    expect(next.uploaded).toEqual([other.uri]);
    expect(uploadIdOf(next.files[0])).not.toBe(id);
    expect(server.docs).toHaveLength(2);
    expect(withoutUploadId({ uri: 'u', clientUploadId: id })).toEqual({ uri: 'u' });
  });

  test('"Retry missing" in a session that already holds the files still checks first and never resends a file the server has', async () => {
    const server = lateServer();
    server.hold = true;
    const A = file('a.pdf', 'AAAA');
    const first = await runSubmission({ sentRequest: SAVED, uploaded: [], uploadErrors: {}, uploadUnknown: {}, files: [A], upload: server.upload, generateId: sequence() });
    server.hold = false;
    server.release(); // the held upload arrives: the server has it
    server.upload.mockClear();
    const result = await recoverUploads({ requestId: SAVED.id, ...first, fetchRequest: server.fetchRequest, upload: server.upload });
    expect(server.upload).not.toHaveBeenCalled();
    expect(result.uploaded).toEqual([A.uri]);
    expect(server.docs).toHaveLength(1);
  });
});

describe('the screens: gated until checked, explained, never automatic', () => {
  const notice = read('components/request/PendingUploadsNotice.js');
  const panel = read('components/request/AdditionalDocuments.js');
  test('adding files waits for the check; the notice is one line and one Try again (offline-aware)', () => {
    expect(notice).toContain('gated: ids.length > 0 && !checked');
    expect(panel).toContain('disabled={!summary.canRetry || gated}');
    expect(notice).toContain("t('up_restart_missing')");
    expect(notice).toContain("title={t('up_restart_simple')} text={t('up_restart_text')}");
    expect(notice).toMatch(/title=\{state\.checking \? t\('up_checking'\) : t\('sk_try_again'\)\}[^\n]*needsNetwork/);
    expect(notice).not.toMatch(/up_restart_gate|up_restart_body|up_restart_title|up_restart_dismiss|forgetRequest/);
    expect(I18N.EN.up_restart_simple).toBe('Your last upload may not have finished.');
  });

  test('nothing runs by itself: the notice reads the journal on opening but only a tap asks the server, and it can never upload', () => {
    expect(notice).not.toMatch(/apiUpload|runSubmission|recoverUploads|send\(/);
    expect((notice.match(/apiGet/g) || []).length).toBe(2); // the import and the one call inside check()
    expect(notice).toMatch(/const check = async \(\) => \{/);
    expect(notice).not.toMatch(/useEffect\([^)]*check\(/);
    for (const rel of ['lib/uploadJournal.js', 'lib/uploadRecovery.js', 'components/request/PendingUploadsNotice.js']) expect(read(rel)).not.toMatch(/onRestored|restoredCount|NetInfo|AppState/);
  });

  test('re-attached files adopt the stored ids; every upload path journals; account deletion clears the journal; no file data is stored by it', () => {
    expect(panel).toContain('stampUploadIds(files, secureUuid, pendingUploads.ids)');
    expect(panel).toContain('journal: uploadJournal');
    expect(read('app/request/review.js')).toContain('journal: uploadJournal');
    expect(read('app/request/submitted.js')).toContain('journal: uploadJournal');
    expect(read('app/delete-account-otp.js')).toContain('await uploadJournal.clearAll();');
    expect(read('app/request-details.js')).toContain('<PendingUploadsNoticeView state={pendingUploads} />'); // the notice sits at the top of the page
    expect(read('lib/uploadJournal.js').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')).not.toMatch(/\.uri|\.name|\.size|mimeType/);
  });

  test('the five restart strings exist in all six languages, translated, with {n}', () => {
    for (const lang of Object.keys(I18N)) {
      for (const key of ['up_restart_title', 'up_restart_body', 'up_restart_missing', 'up_restart_gate', 'up_restart_dismiss']) {
        expect(typeof I18N[lang][key]).toBe('string');
        if (lang !== 'EN') expect(I18N[lang][key]).not.toBe(I18N.EN[key]);
      }
      expect(I18N[lang].up_restart_body).toContain('{n}');
    }
  });
});
