/* global describe, test, expect, beforeEach, afterEach */
// Local quotation storage: conditional create, hash verification, private location, no overwrite, no escape from the root.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLocalStorage, keyFor, sha256Of, StorageError } = require('../../src/modules/bitrix/quotation-storage');

let root; let storage;
const bytes = Buffer.from('%PDF-1.7\nhello\n%%EOF\n');
const sha = sha256Of(bytes);
const key = keyFor(3037, 464, sha);
const onDisk = (k) => path.join(root, ...k.split('/'));

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-qstore-')); storage = createLocalStorage({ root }); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('putIfAbsent', () => {
  test('writes a new object, verified, under quotations/case-<id>/, and leaves no temporary file', async () => {
    expect(await storage.putIfAbsent(key, bytes, sha)).toEqual({ created: true });
    expect(key).toBe(`quotations/case-3037/ev464-${sha}.pdf`);
    expect(fs.readFileSync(onDisk(key))).toEqual(bytes);
    expect(fs.readdirSync(path.join(root, 'quotations', 'case-3037'))).toEqual([`ev464-${sha}.pdf`]);
    expect(await storage.hashOf(key)).toBe(sha);
  });

  test('a second put of the same content (a retry of the same event) reuses the object: created false, one file', async () => {
    await storage.putIfAbsent(key, bytes, sha);
    expect(await storage.putIfAbsent(key, bytes, sha)).toEqual({ created: false });
    expect(fs.readdirSync(path.join(root, 'quotations', 'case-3037'))).toHaveLength(1);
  });

  test('an existing object with OTHER content is never overwritten: it is a conflict', async () => {
    await storage.putIfAbsent(key, bytes, sha);
    fs.writeFileSync(onDisk(key), 'tampered');
    await expect(storage.putIfAbsent(key, bytes, sha)).rejects.toMatchObject({ code: 'conflict' });
    expect(fs.readFileSync(onDisk(key), 'utf8')).toBe('tampered');
  });

  test('refuses bytes that do not match the stated hash, and empty files', async () => {
    await expect(storage.putIfAbsent(key, Buffer.from('other'), sha)).rejects.toMatchObject({ code: 'hash_mismatch' });
    await expect(storage.putIfAbsent(key, Buffer.alloc(0), sha)).rejects.toMatchObject({ code: 'empty_file' });
    expect(fs.existsSync(path.join(root, 'quotations'))).toBe(false);
  });

  test.each(['../evil.pdf', 'quotations/../x.pdf', '/etc/passwd', 'quotations/case-1/../../x.pdf', 'quotations/case-1/a.exe', 'quotations/case-x/a.pdf', 'uploads/a.pdf', 'quotations/case-1/.hidden.pdf', ''])('refuses the key %p', async (bad) => {
    await expect(storage.putIfAbsent(bad, bytes, sha)).rejects.toBeInstanceOf(StorageError);
    expect(() => storage.pathOf(bad)).toThrow(StorageError);
  });

  if (process.platform !== 'win32') {
    test('files are private to their owner (0600) and folders 0700', async () => {
      await storage.putIfAbsent(key, bytes, sha);
      expect(fs.statSync(onDisk(key)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(root, 'quotations')).mode & 0o777).toBe(0o700);
    });
  }
});

describe('read, remove, quarantine', () => {
  test('readVerified returns the bytes only while they still match the hash', async () => {
    await storage.putIfAbsent(key, bytes, sha);
    expect(await storage.readVerified(key, sha)).toEqual(bytes);
    fs.writeFileSync(onDisk(key), 'changed');
    await expect(storage.readVerified(key, sha)).rejects.toMatchObject({ code: 'file_changed' });
  });

  test('quarantine moves the object out of quotations/ into quarantine/quotations/', async () => {
    await storage.putIfAbsent(key, bytes, sha);
    const moved = await storage.quarantine(key);
    expect(moved).toBe(`quarantine/${key}`);
    expect(fs.existsSync(onDisk(key))).toBe(false);
    expect(fs.existsSync(path.join(root, ...moved.split('/')))).toBe(true);
  });

  test('remove deletes one object and tolerates a missing one', async () => {
    await storage.putIfAbsent(key, bytes, sha);
    await storage.remove(key);
    await storage.remove(key);
    expect(fs.existsSync(onDisk(key))).toBe(false);
  });
});
