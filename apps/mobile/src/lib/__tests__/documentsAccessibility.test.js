/* global describe, test, expect, jest, __dirname */
// My Documents, Group 1: what a screen reader is told about a card (Fix 4) and the one-download-at-a-time guard (Fix 5).
const fs = require('fs');
const path = require('path');
const { createDownloadGuard, documentAccessibilityLabel, downloadAnnouncement } = require('../documentsView');
const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/i18n.json'), 'utf8'));

const NL = String.fromCharCode(10);
const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');
const codeOf = (source) => source.split(NL).filter((l) => !l.trim().startsWith('//')).join(NL);
const cardSource = read('../../components/documents/DocumentCard.js');
const screenSource = read('../../app/my-documents.js');

const tIn = (lang) => (key) => i18n[lang][key] ?? i18n.EN[key] ?? key;
const t = tIn('EN');
const DOC = { id: 5, name: 'Blood test.pdf', fileSizeBytes: 43008, uploadedAt: '2026-11-03T08:00:00.000Z', case: { referenceNumber: 'CASE-1005' } };

// ---- Fix 5 --------------------------------------------------------------------------------------------------------
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

describe('createDownloadGuard: one download at a time for each document', () => {
  test('rapid repeated taps in the same moment start the download once', async () => {
    const guard = createDownloadGuard();
    const gate = deferred();
    const task = jest.fn(() => gate.promise);
    // five taps, all before any await: nothing has re-rendered yet
    const taps = [1, 2, 3, 4, 5].map(() => guard.run(5, task));
    expect(task).toHaveBeenCalledTimes(1);
    gate.resolve();
    expect(await Promise.all(taps)).toEqual([true, false, false, false, false]);
  });
  test('the guard is set synchronously, before the first await of the task', () => {
    const guard = createDownloadGuard();
    guard.run(1, () => deferred().promise);
    expect(guard.isActive(1)).toBe(true);
  });
  test('a tap while it is running is ignored and does not queue a second download for later', async () => {
    const guard = createDownloadGuard();
    const gate = deferred();
    const task = jest.fn(() => gate.promise);
    const first = guard.run(5, task);
    expect(await guard.run(5, task)).toBe(false);
    gate.resolve();
    await first;
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);
  });
  test('after a success the same document can be downloaded again', async () => {
    const guard = createDownloadGuard();
    const task = jest.fn().mockResolvedValue();
    expect(await guard.run(5, task)).toBe(true);
    expect(guard.isActive(5)).toBe(false);
    expect(await guard.run(5, task)).toBe(true);
    expect(task).toHaveBeenCalledTimes(2);
  });
  test('after a failure the same document can be tried again, and the failure is not swallowed', async () => {
    const guard = createDownloadGuard();
    await expect(guard.run(5, () => Promise.reject(new Error('network')))).rejects.toThrow('network');
    expect(guard.isActive(5)).toBe(false);
    expect(await guard.run(5, jest.fn().mockResolvedValue())).toBe(true);
  });
  test('a task that throws synchronously also releases the document', async () => {
    const guard = createDownloadGuard();
    await expect(guard.run(5, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(guard.isActive(5)).toBe(false);
  });
  test('different documents download independently, at the same time', async () => {
    const guard = createDownloadGuard();
    const a = deferred();
    const b = deferred();
    const taskA = jest.fn(() => a.promise);
    const taskB = jest.fn(() => b.promise);
    const runA = guard.run(1, taskA);
    const runB = guard.run(2, taskB);
    expect(taskA).toHaveBeenCalledTimes(1);
    expect(taskB).toHaveBeenCalledTimes(1);
    expect(guard.isActive(1) && guard.isActive(2)).toBe(true);
    a.resolve();
    await runA;
    expect(guard.isActive(1)).toBe(false);
    expect(guard.isActive(2)).toBe(true);
    b.resolve();
    await runB;
  });
  test('ids of different kinds do not collide', async () => {
    const guard = createDownloadGuard();
    const gate = deferred();
    guard.run(1, () => gate.promise);
    expect(guard.isActive('1')).toBe(false);
    gate.resolve();
  });
});

describe('the screen opens the preview, once per tap (the guard is lib/documentPreview.js)', () => {
  const screen = codeOf(screenSource);
  test('only one place opens a document, and it is the preview (no download and no share sheet from the list)', () => {
    expect(screen.split('openDocumentPreview(').length - 1).toBe(1);
    expect(screen).not.toMatch(/downloadDocument|openDocument\(|Sharing|shareAsync|Share\.share/);
  });
  test('the failure message is always one of ours (the preview screen maps the error with downloadErrorInfo)', () => {
    const preview = codeOf(read('../../app/document-preview.js'));
    expect(preview).toContain('t(downloadErrorInfo(file.error).key)');
    expect(preview).not.toContain('serverMessage');
  });
});

// ---- Fix 4 --------------------------------------------------------------------------------------------------------
describe('documentAccessibilityLabel: one label with everything', () => {
  test('idle: the action and the name, type and size, case reference and date', () => {
    expect(documentAccessibilityLabel(DOC, { status: 'idle' }, t)).toBe('Download Blood test.pdf. PDF · 42 KB. CASE-1005. 03 Nov 2026');
  });
  test('no state at all reads as idle', () => {
    expect(documentAccessibilityLabel(DOC, undefined, t)).toBe(documentAccessibilityLabel(DOC, { status: 'idle' }, t));
  });
  test('downloading: the progress is in the label, rounded to a whole percent', () => {
    expect(documentAccessibilityLabel(DOC, { status: 'downloading', progress: 0.456 }, t)).toBe('Download Blood test.pdf. PDF · 42 KB. CASE-1005. 03 Nov 2026. Downloading 46%');
  });
  test('downloading before any progress is known says only "Downloading"', () => {
    expect(documentAccessibilityLabel(DOC, { status: 'downloading', progress: 0 }, t)).toMatch(/\. Downloading$/);
    expect(documentAccessibilityLabel(DOC, { status: 'downloading' }, t)).toMatch(/\. Downloading$/);
  });
  test('an error: what went wrong, then how to try again', () => {
    const label = documentAccessibilityLabel(DOC, { status: 'error', message: 'Your session expired. Please log in again.' }, t);
    expect(label).toBe('Download Blood test.pdf. PDF · 42 KB. CASE-1005. 03 Nov 2026. Your session expired. Please log in again.. Tap to try again');
    expect(label.endsWith(t('docs_tap_retry'))).toBe(true);
  });
  test('an error state without a message does not announce an empty sentence', () => {
    expect(documentAccessibilityLabel(DOC, { status: 'error' }, t)).toBe(documentAccessibilityLabel(DOC, { status: 'idle' }, t));
  });
  test('missing details are left out, never "undefined" or an empty gap', () => {
    const label = documentAccessibilityLabel({ id: 1, name: 'scan' }, { status: 'idle' }, t);
    expect(label).toBe('Download scan');
    expect(documentAccessibilityLabel({ id: 1, name: 'scan.png', uploadedAt: 'garbage', case: {} }, undefined, t)).toBe('Download scan.png. PNG');
    for (const text of [label, documentAccessibilityLabel({ id: 1, name: 'x', fileSizeBytes: null }, undefined, t)]) expect(text).not.toMatch(/undefined|null|\.\.\s|\. \./);
  });
  test('it is said in the language the app shows', () => {
    const hindi = documentAccessibilityLabel(DOC, { status: 'downloading', progress: 0.5 }, tIn('HI'));
    expect(hindi.startsWith(`${i18n.HI.docs_download} Blood test.pdf`)).toBe(true);
    expect(hindi.endsWith(`${i18n.HI.docs_downloading} 50%`)).toBe(true);
    const arabic = documentAccessibilityLabel(DOC, { status: 'error', message: i18n.AR.docs_err_network }, tIn('AR'));
    expect(arabic.endsWith(i18n.AR.docs_tap_retry)).toBe(true);
  });
});

describe('downloadAnnouncement: told once when the state changes, not on every tick', () => {
  const idle = { status: 'idle' };
  test('starting is announced with the document name', () => {
    expect(downloadAnnouncement(idle, { status: 'downloading', progress: 0 }, DOC, t)).toBe('Downloading Blood test.pdf');
    expect(downloadAnnouncement(undefined, { status: 'downloading', progress: 0 }, DOC, t)).toBe('Downloading Blood test.pdf');
  });
  test('progress ticks are not announced', () => {
    for (const progress of [0.1, 0.5, 0.99]) {
      expect(downloadAnnouncement({ status: 'downloading', progress: 0 }, { status: 'downloading', progress }, DOC, t)).toBe('');
    }
  });
  test('finishing is announced', () => {
    expect(downloadAnnouncement({ status: 'downloading', progress: 1 }, idle, DOC, t)).toBe('Downloaded Blood test.pdf');
  });
  test('a failure is announced with the reason and how to try again', () => {
    const failed = { status: 'error', message: 'Download failed. Please try again.' };
    expect(downloadAnnouncement({ status: 'downloading', progress: 0.3 }, failed, DOC, t)).toBe('Download failed. Please try again.. Tap to try again');
  });
  test('the same error is not announced twice, a different one is', () => {
    const a = { status: 'error', message: 'A' };
    expect(downloadAnnouncement(a, { status: 'error', message: 'A' }, DOC, t)).toBe('');
    expect(downloadAnnouncement(a, { status: 'error', message: 'B' }, DOC, t)).toMatch(/^B\./);
  });
  test('trying again after a failure is announced as starting', () => {
    expect(downloadAnnouncement({ status: 'error', message: 'A' }, { status: 'downloading', progress: 0 }, DOC, t)).toBe('Downloading Blood test.pdf');
  });
  test('nothing changed, or an empty message, is silent', () => {
    expect(downloadAnnouncement(idle, idle, DOC, t)).toBe('');
    expect(downloadAnnouncement(undefined, undefined, DOC, t)).toBe('');
    expect(downloadAnnouncement(idle, { status: 'error' }, DOC, t)).toBe('');
  });
  test('it is said in the language the app shows', () => {
    expect(downloadAnnouncement(idle, { status: 'downloading', progress: 0 }, DOC, tIn('HI'))).toBe(`${i18n.HI.docs_downloading} Blood test.pdf`);
    expect(downloadAnnouncement({ status: 'downloading' }, idle, DOC, tIn('AR'))).toBe(i18n.AR.docs_downloaded.replace('{name}', 'Blood test.pdf'));
  });
});

describe('DocumentCard: how it hands this to the screen reader', () => {
  const card = codeOf(cardSource);
  test('the button carries the single label and its busy and disabled state', () => {
    expect(card).toContain('accessibilityRole="button"');
    expect(card).toContain('accessibilityLabel={documentAccessibilityLabel(doc, state, t)}');
    expect(card).toContain('accessibilityState={{ busy: downloading, disabled: downloading }}');
  });
  test('the visible parts are hidden from the reader, so nothing is said twice', () => {
    expect(card).toContain("const HIDDEN_FROM_READER = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' };");
    expect(card.split('{...HIDDEN_FROM_READER}').length - 1).toBe(3); // the row, the progress bar, the error block
    expect(card).not.toMatch(/accessible\s+accessibilityLabel/); // the old second label on the progress bar
  });
  test('a change of state is announced once through the platform, not on progress', () => {
    expect(card).toContain("import { AccessibilityInfo, Pressable, View } from 'react-native';");
    expect(card).toContain('downloadAnnouncement(previous.current, state, doc, t)');
    expect(card).toContain('AccessibilityInfo.announceForAccessibility(text)');
    expect(card).toContain('previous.current = state;');
  });
  test('the visual design is as it was: the same icon, size and colours, and a 44-point target', () => {
    expect(card).toContain('h-11 w-11');
    expect(card).toContain('h-10 w-10');
    expect(card).toContain('ICON[fileTypeOf(doc.name).kind]');
    expect(card).toContain('rounded-2xl border border-line bg-white');
  });
  test('the retry hint is still visible, and still translated', () => {
    expect(card).toContain("t('docs_tap_retry')");
    expect(card).toContain('{state.message}');
  });
});

describe('the language of the accessibility texts', () => {
  test('the words used in labels and announcements exist in all six languages', () => {
    for (const lang of Object.keys(i18n)) {
      for (const key of ['docs_download', 'docs_downloading', 'docs_downloaded', 'docs_tap_retry']) expect(i18n[lang][key]).toBeTruthy();
      expect(i18n[lang].docs_downloaded).toContain('{name}');
    }
  });
});
