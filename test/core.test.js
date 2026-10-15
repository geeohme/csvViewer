import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, detectDelimiter } from '../src/csv.js';
import { classify, K, parseDate, parseNum, formatDate } from '../src/types.js';
import { detectTables, buildTables } from '../src/segment.js';
import { columnStats, compileFilters } from '../src/stats.js';

const parse = (s) => parseCSV(s, detectDelimiter(s));

test('parser handles quotes, embedded newlines, CRLF, BOM and tracks start lines', () => {
  const { rows, lines, totalLines } = parse('﻿a,b\r\n1,"x, ""y"""\r\n2,"multi\nline"\n3,z\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', 'x, "y"'], ['2', 'multi\nline'], ['3', 'z']]);
  assert.deepEqual(lines, [1, 2, 3, 5]);
  assert.equal(totalLines, 5);
});

test('parser keeps blank lines as records and trailing empty fields', () => {
  const { rows } = parse('a,b\n1,\n\nc,d');
  assert.deepEqual(rows, [['a', 'b'], ['1', ''], [''], ['c', 'd']]);
});

test('delimiter detection', () => {
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(detectDelimiter('a|b\n1|2'), '|');
  assert.equal(detectDelimiter('a,b;c\n1,2;3\n4,5;6'), ',');
});

test('value classification', () => {
  assert.equal(classify('1,234.50'), K.NUMBER);
  assert.equal(classify('$12'), K.NUMBER);
  assert.equal(classify('-3e4'), K.NUMBER);
  assert.equal(classify('555-123-4567'), K.TEXT);
  assert.equal(classify('NULL'), K.EMPTY);
  assert.equal(classify('2024-02-30'), K.TEXT);
  assert.equal(formatDate(parseDate('2024-01-05 13:04:00')), '2024-01-05 13:04:00');
  assert.equal(formatDate(parseDate('1/5/2024')), '2024-01-05');
  assert.equal(formatDate(parseDate('25/12/2023')), '2023-12-25');
  assert.equal(formatDate(parseDate('5-Jan-2024')), '2024-01-05');
  assert.equal(formatDate(parseDate('Jan 5, 2024 3:15 PM')), '2024-01-05 15:15:00');
  assert.ok(Number.isNaN(parseNum('12abc')));
});

test('detects tables split by type change, width change, blank line and title row', () => {
  const csv = [
    'id,name,joined', '1,Ann,2020-01-01', '2,Bo,2021-05-03', '3,Cy,2022-07-09',
    'order_id,customer_id,amount,placed', '10,1,9.99,1/2/2023', '11,2,5.00,1/3/2023', '12,3,7.25,1/4/2023',
    'code,label', 'A,Alpha', 'B,Beta', 'C,Gamma',
    '',
    'TAGS',
    'tag_id,tag', '1,red', '2,blue', '3,green',
  ].join('\n');
  const { rows, lines } = parse(csv);
  const { starts } = detectTables(rows);
  const tables = buildTables(rows, starts);
  assert.deepEqual(tables.map((t) => lines[t.headerRow]), [1, 5, 9, 15]);
  assert.deepEqual(tables.map((t) => t.idx.length), [3, 3, 3, 3]);
  assert.equal(tables[3].displayName, 'TAGS');
  assert.equal(tables[1].displayName, 'order');
});

test('text-only data rows inside a text table are not split', () => {
  const csv = ['color,shade', 'red,dark', 'blue,light', 'green,mid', 'black,none'].join('\n');
  const { starts } = detectTables(parse(csv).rows);
  assert.equal(starts.length, 1);
});

test('stats and filters', () => {
  const rows = [['n', 'd'], ['5', '2024-01-01'], ['1', '2024-03-10 10:00:00'], ['', '2023-12-31'], ['10', 'NULL']];
  const idx = [1, 2, 3, 4];
  const s = columnStats(rows, idx, 0, 'n', 'number');
  assert.equal(s.filled, 3);
  assert.equal(s.min, 1);
  assert.equal(s.max, 10);
  assert.equal(s.median, 5);
  const d = columnStats(rows, idx, 1, 'd', 'date');
  assert.equal(d.min, '2023-12-31');
  assert.equal(d.max, '2024-03-10 10:00:00');
  assert.equal(d.empty, 1);
  const types = ['number', 'date'];
  const keep = (filters) => idx.filter((r) => compileFilters(filters, types)(rows[r]));
  assert.deepEqual(keep([{ col: 0, op: 'gte', value: '5' }]), [1, 4]);
  assert.deepEqual(keep([{ col: 1, op: 'lte', value: '2024-03-10' }]), [1, 2, 3]);
  assert.deepEqual(keep([{ col: 1, op: 'eq', value: '2024-03-10' }]), [2]);
  assert.deepEqual(keep([{ col: 0, op: 'empty' }]), [3]);
});
