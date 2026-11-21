/* global describe, test, expect */
// The GENERATED Prisma client knows clientRequestId and its composite unique key (Phase 4 follow-up). A schema change is not live until `prisma generate` has been run: before it,
// every create that carries the key would be refused by the client ("Unknown argument") even though the database has the column.
// What this file proves WITHOUT a database: the generated model, its type declarations, its embedded schema and its field enum all carry the field and the composite key, and that
// the generated schema is the source schema (the client is not stale). What it cannot prove offline is that the ENGINE accepts the field in a query: Prisma validates query
// arguments only after it connects, so that check is made against humancare_dev (read-only) by scripts/verify-request-idempotency-db.js (checks A6 to A8).
const fs = require('fs');
const path = require('path');
const { Prisma } = require('@prisma/client');

const model = Prisma.dmmf.datamodel.models.find((m) => m.name === 'ServiceRequest');
const field = model.fields.find((f) => f.name === 'clientRequestId');

describe('the generated client exposes clientRequestId', () => {
  test('the model has the field: an optional String, stored as client_request_id VARCHAR(36)', () => {
    expect(field).toBeDefined();
    expect(field.type).toBe('String');
    expect(field.isRequired).toBe(false);
    expect(field.dbName).toBe('client_request_id');
    expect(field.nativeType).toEqual(['VarChar', ['36']]);
  });
  test('the composite unique key is (userId, clientRequestId), under the migration\'s index name', () => {
    expect(model.uniqueFields).toContainEqual(['userId', 'clientRequestId']);
    const generatedSchema = fs.readFileSync(path.join(path.dirname(require.resolve('@prisma/client')), '..', '..', '.prisma', 'client', 'schema.prisma'), 'utf8');
    expect(generatedSchema).toMatch(/@@unique\(\[userId, clientRequestId\], map: "uq_service_requests_user_client_request"\)/);
    expect(generatedSchema).toMatch(/clientRequestId\s+String\?\s+@map\("client_request_id"\)\s+@db\.VarChar\(36\)/);
  });
  test('the scalar field enum and the type declarations carry it', () => {
    expect(Prisma.ServiceRequestScalarFieldEnum.clientRequestId).toBe('clientRequestId');
    const declarations = fs.readFileSync(path.join(path.dirname(require.resolve('@prisma/client')), '..', '..', '.prisma', 'client', 'index.d.ts'), 'utf8');
    expect(declarations).toMatch(/clientRequestId: string \| null/);
    expect(declarations).toMatch(/userId_clientRequestId\?: ServiceRequestUserIdClientRequestIdCompoundUniqueInput/);
    expect(declarations).toMatch(/export type ServiceRequestUserIdClientRequestIdCompoundUniqueInput = \{\s+userId: number\s+clientRequestId: string\s+\}/);
  });
  test('the client is not stale: every field the source declares for ServiceRequest is in the generated model, in the same order', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf('model ServiceRequest {');
    // The model ends at the first line that is only a closing brace (a "}" inside a comment or an attribute is not the end).
    const block = source.slice(start, source.indexOf('\n}', start));
    const declared = block.split('\n').map((line) => line.trim())
      .filter((line) => line && !line.startsWith('//') && !line.startsWith('@@') && !line.startsWith('model '))
      .map((line) => line.split(/\s+/)[0]);
    expect(declared).toContain('clientRequestId');
    expect(model.fields.map((f) => f.name)).toEqual(declared);
  });
});
