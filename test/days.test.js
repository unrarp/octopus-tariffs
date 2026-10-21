import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, addMonths, dayRange, ukDay } from '../src/days.js';

test('ukDay dates an instant by its UK-local calendar day at BST and GMT boundaries', () => {
  assert.equal(ukDay('2026-09-30T23:00:00Z'), '2026-10-01'); // BST: 00:00 local
  assert.equal(ukDay('2026-09-30T22:59:59Z'), '2026-09-30');
  assert.equal(ukDay('2026-01-01T00:00:00Z'), '2026-01-01'); // GMT
  assert.equal(ukDay('2025-12-31T23:59:59Z'), '2025-12-31');
});

test('ukDay around the 2026-03-29 and 2026-10-25 clock changes', () => {
  assert.equal(ukDay('2026-03-28T23:59:59Z'), '2026-03-28');
  assert.equal(ukDay('2026-03-29T00:00:00Z'), '2026-03-29');
  assert.equal(ukDay('2026-03-29T22:59:59Z'), '2026-03-29'); // still BST until 23:00Z
  assert.equal(ukDay('2026-03-29T23:00:00Z'), '2026-03-30');
  assert.equal(ukDay('2026-10-24T22:59:59Z'), '2026-10-24');
  assert.equal(ukDay('2026-10-24T23:00:00Z'), '2026-10-25');
  assert.equal(ukDay('2026-10-25T23:00:00Z'), '2026-10-25'); // GMT again: 23:00Z is 23:00 local
  assert.equal(ukDay('2026-10-25T23:59:59Z'), '2026-10-25');
  assert.equal(ukDay('2026-10-26T00:00:00Z'), '2026-10-26');
});

test('addDays crosses month, year, leap and clock-change boundaries in UTC arithmetic', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-10-25', 1), '2026-10-26');
});

test('addMonths clamps to the end of a shorter month', () => {
  assert.equal(addMonths('2026-10-02', 18), '2028-04-02');
  assert.equal(addMonths('2026-08-31', 6), '2027-02-28');
  assert.equal(addMonths('2026-11-30', 3), '2027-02-28');
  assert.equal(addMonths('2026-10-15', 0), '2026-10-15');
});

test('dayRange is half-open', () => {
  assert.deepEqual(dayRange('2026-10-24', '2026-10-27'), ['2026-10-24', '2026-10-25', '2026-10-26']);
  assert.deepEqual(dayRange('2026-10-24', '2026-10-24'), []);
});
