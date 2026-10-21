import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { appendCsv, readCsv, rewriteRow } from '../src/csv.js';

const dir = mkdtempSync(join(tmpdir(), 'csv-'));
after(() => rmSync(dir, { recursive: true }));
const row = (valid_from, valid_to, payment_method, exc, inc) => ({
  valid_from,
  valid_to,
  payment_method,
  value_exc_vat: exc,
  value_inc_vat: inc,
});

test('appendCsv creates the header, then appends; readCsv restores nulls and numbers verbatim', () => {
  const p = join(dir, 'a.csv');
  appendCsv(p, [row('2026-09-10T23:00:00Z', null, null, 25.7963, 25.7963)]);
  appendCsv(p, [row('2026-10-10T23:00:00Z', null, null, 8.450085, 8.4500851)]);
  assert.equal(
    readFileSync(p, 'utf8').split('\n')[0],
    'valid_from,valid_to,payment_method,value_exc_vat,value_inc_vat',
  );
  assert.equal(readFileSync(p, 'utf8').split('\n')[1], '2026-09-10T23:00:00Z,,,25.7963,25.7963');
  assert.deepEqual(readCsv(p), [
    row('2026-09-10T23:00:00Z', null, null, 25.7963, 25.7963),
    row('2026-10-10T23:00:00Z', null, null, 8.450085, 8.4500851),
  ]);
});

test('a row with null valid_from round-trips and can be rewritten by its key', () => {
  const p = join(dir, 'b.csv');
  appendCsv(p, [row(null, null, null, 1.5, 1.5), row('2026-01-01T00:00:00Z', null, null, 2, 2)]);
  assert.deepEqual(readCsv(p)[0], row(null, null, null, 1.5, 1.5));
  rewriteRow(p, { valid_from: null, payment_method: null }, row(null, '2026-01-01T00:00:00Z', null, 1.5, 1.5));
  assert.deepEqual(readCsv(p), [
    row(null, '2026-01-01T00:00:00Z', null, 1.5, 1.5),
    row('2026-01-01T00:00:00Z', null, null, 2, 2),
  ]);
});

test('rewriteRow matches by (valid_from, payment_method), not position, and throws when absent', () => {
  const p = join(dir, 'c.csv');
  const t = '2026-03-31T23:00:00Z';
  appendCsv(p, [
    row(t, null, 'DIRECT_DEBIT', 10, 10.5),
    row(t, null, 'NON_DIRECT_DEBIT', 11, 11.5),
    row('2026-06-30T23:00:00Z', null, 'DIRECT_DEBIT', 12, 12.5),
    row('2026-06-30T23:00:00Z', null, 'NON_DIRECT_DEBIT', 13, 13.5),
  ]);
  const closed = row(t, '2026-06-30T23:00:00Z', 'DIRECT_DEBIT', 10, 10.5);
  rewriteRow(p, { valid_from: t, payment_method: 'DIRECT_DEBIT' }, closed);
  const rows = readCsv(p);
  assert.deepEqual(rows[0], closed);
  assert.equal(rows[1].valid_to, null);
  assert.equal(rows.length, 4);
  assert.throws(() => rewriteRow(p, { valid_from: t, payment_method: 'PREPAY' }, closed), /no row/);
});

test('appendCsv creates missing parent directories', () => {
  const p = join(dir, 'E-1R-X-C', 'standing_charges.csv');
  appendCsv(p, [row('2026-09-10T23:00:00Z', null, null, 1, 1)]);
  assert.equal(readCsv(p).length, 1);
});

test('readCsv throws on a line with the wrong number of fields', () => {
  const p = join(dir, 'short.csv');
  writeFileSync(p, 'valid_from,valid_to,payment_method,value_exc_vat,value_inc_vat\n2026-09-10T23:00:00Z,,\n');
  assert.throws(() => readCsv(p), /3 fields/);
});

test('writes leave no temp file behind', () => {
  assert.deepEqual(
    readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.tmp')),
    [],
  );
});
