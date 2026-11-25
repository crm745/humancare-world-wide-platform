// A TEMPORARY, PRIVATE copy of one stored object, so a scanner that reads a path (ClamAV) can judge it (documents/legacy-backfill.js scans documents that live in the storage service, S3 included).
//
//   stageObject(adapter, key, { tempDir, maxBytes })  streams the object into a new folder made here (0700) as one file (0600, size-capped, hashed while it is written), and resolves
//                                                     { file, dir, sha256 }. A failed or oversized copy removes its own folder before the error leaves.
//   releaseStaged(staged)                             removes that folder. It removes ONLY a folder this module made (its name starts with the prefix, directly inside tempDir, and the
//                                                     staged object holds its own marker), never a stored document, never anything else.
//
// The stored object itself is only read. Nothing here writes to, moves or deletes an object in the storage service.
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { createMeter } = require('../../storage/meter');

const PREFIX = 'hc-staged-';
const MADE = new WeakSet(); // the staged results this module itself produced

async function stageObject(adapter, key, { tempDir, maxBytes }) {
  const object = await adapter.download(key); // throws a StorageError: not_found, download_failed, ...
  const dir = await fs.promises.mkdtemp(path.join(tempDir, PREFIX)); // mkdtemp creates it 0700
  const file = path.join(dir, 'object');
  const meter = createMeter(maxBytes);
  try {
    await pipeline(object.stream, meter, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  } catch (err) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  const staged = { file, dir, tempDir, sha256: meter.sha256() };
  MADE.add(staged);
  return staged;
}

async function releaseStaged(staged) {
  if (!staged || !MADE.has(staged)) return false; // not made here: never touched
  if (path.resolve(path.dirname(staged.dir)) !== path.resolve(staged.tempDir) || !path.basename(staged.dir).startsWith(PREFIX)) return false;
  await fs.promises.rm(staged.dir, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

module.exports = { stageObject, releaseStaged, PREFIX };
