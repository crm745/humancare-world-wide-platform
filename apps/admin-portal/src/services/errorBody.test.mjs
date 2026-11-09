import test from 'node:test';
import assert from 'node:assert/strict';
import { readErrorBody, errorMessage } from './errorBody.mjs';

test('keeps a JSON object body, including extra fields like blockers', async () => {
  const body = { error: 'This request cannot be approved yet.', code: 'approval_blocked', blockers: [{ code: 'unscanned', documentId: 4 }] };
  assert.deepEqual(await readErrorBody(body), body);
});

test('parses a JSON error delivered as a Blob (failed document download)', async () => {
  const blob = new Blob([JSON.stringify({ error: 'This document cannot be opened.', code: 'document_not_clean' })], { type: 'application/json' });
  const body = await readErrorBody(blob);
  assert.equal(body.code, 'document_not_clean');
  assert.equal(errorMessage(body, 409), 'This document cannot be opened.');
});

test('parses a JSON string body', async () => {
  assert.deepEqual(await readErrorBody('{"error":"nope"}'), { error: 'nope' });
});

test('returns undefined for HTML, non-object JSON, arrays, empty and missing bodies', async () => {
  assert.equal(await readErrorBody(new Blob(['<html>502</html>'])), undefined);
  assert.equal(await readErrorBody('<html>'), undefined);
  assert.equal(await readErrorBody('"just a string"'), undefined);
  assert.equal(await readErrorBody(new Blob(['[1,2]'])), undefined);
  assert.equal(await readErrorBody([1, 2]), undefined);
  assert.equal(await readErrorBody(null), undefined);
  assert.equal(await readErrorBody(undefined), undefined);
});

test('falls back to a generic message, distinguishing "no response" from a server error', () => {
  assert.match(errorMessage(undefined, 0), /Unable to reach the server/);
  assert.match(errorMessage(undefined, 500), /Something went wrong/);
  assert.match(errorMessage({ error: '' }, 500), /Something went wrong/);
  assert.match(errorMessage({ error: 42 }, 500), /Something went wrong/);
});
