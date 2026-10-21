import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const COLUMNS = ['valid_from', 'valid_to', 'payment_method', 'value_exc_vat', 'value_inc_vat'];
const NUMERIC = new Set(['value_exc_vat', 'value_inc_vat']);
const HEADER = COLUMNS.join(',');

/** One row as a CSV line: values verbatim, null as an empty field. */
function toLine(row) {
  return COLUMNS.map((c) => String(row[c] ?? '')).join(',');
}

/** One CSV line as a row: empty fields back to null, value columns to numbers. */
function fromLine(line) {
  const cells = line.split(',');
  if (cells.length !== COLUMNS.length) throw new Error(`${cells.length} fields in line: ${line}`);
  return Object.fromEntries(
    COLUMNS.map((c, i) => [c, cells[i] === '' ? null : NUMERIC.has(c) ? Number(cells[i]) : cells[i]]),
  );
}

/** Writes the header and `rows` to `path` (creating its directory) via a temp file and rename, so a crash never leaves half a file. */
function writeRows(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${[HEADER, ...rows.map(toLine)].join('\n')}\n`);
  renameSync(tmp, path);
}

/** Reads a rate CSV into rows, nulls restored and values as numbers. */
export function readCsv(path) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  if (lines[0] !== HEADER) throw new Error(`${path}: unexpected header ${lines[0]}`);
  return lines.slice(1).map((l) => {
    try {
      return fromLine(l);
    } catch (e) {
      throw new Error(`${path}: ${e.message}`);
    }
  });
}

/** Appends `rows` to `path`, creating it with its header when missing. */
export function appendCsv(path, rows) {
  writeRows(path, [...(existsSync(path) ? readCsv(path) : []), ...rows]);
}

/** Replaces the row whose (valid_from, payment_method) equals `key` with `row`; throws when none does. */
export function rewriteRow(path, key, row) {
  const rows = readCsv(path);
  const same = (r) =>
    (r.valid_from ?? null) === (key.valid_from ?? null) && (r.payment_method ?? null) === (key.payment_method ?? null);
  const i = rows.findIndex(same);
  if (i < 0) throw new Error(`${path}: no row for ${JSON.stringify(key)}`);
  rows[i] = row;
  writeRows(path, rows);
}
