import { test } from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { parseCSV } from '../src/csv.js';
import { detectTables, buildTables } from '../src/segment.js';
import { inferType } from '../src/stats.js';
import { buildDatabase, detectRelationships, runQuery, sqlIdent } from '../src/sqldb.js';
import { buildSQL, resolveJoins } from '../src/sqlbuild.js';

const CSV = [
  'customer_id,name,joined',
  '1,Ann,2020-01-01',
  '2,Bo,1/15/2021',
  '3,Cy,2022-07-09',
  'order_id,customer_id,amount,placed',
  '10,1,"$1,000.50",1/2/2023',
  '11,1,5.00,1/3/2023',
  '12,3,NULL,2/4/2023',
  'payment_id,order_id,paid',
  '100,10,1000.5',
  '101,12,7',
].join('\n');

async function setup() {
  const SQL = await initSqlJs();
  const { rows, lines } = parseCSV(CSV, ',');
  const tables = buildTables(rows, detectTables(rows).starts);
  for (const t of tables) t.types = t.names.map((_, c) => inferType(rows, t.idx, c));
  return buildDatabase(SQL, tables, rows, lines);
}

test('identifiers are sanitised and reserved words avoided', () => {
  const used = new Set();
  assert.equal(sqlIdent('order', used, 's'), 'orders');
  assert.equal(sqlIdent('AUDIT LOG', used), 'audit_log');
  assert.equal(sqlIdent('2nd col', used), 't_2nd_col');
  assert.equal(sqlIdent('audit log', used), 'audit_log_2');
});

test('tables load with typed values and source lines; relationships are detected', async () => {
  const { db, schema } = await setup();
  assert.deepEqual(schema.map((t) => t.name), ['customer', 'orders', 'payment']);
  const r = runQuery(db, 'SELECT _line, joined FROM customer ORDER BY joined');
  assert.deepEqual(r.rows, [[2, '2020-01-01'], [3, '2021-01-15'], [4, '2022-07-09']]);
  assert.deepEqual(runQuery(db, 'SELECT SUM(amount), COUNT(amount) FROM orders').rows, [[1005.5, 2]]);
  const rels = detectRelationships(db, schema);
  const fmt = rels.map((x) => `${x.from.table}.${x.from.col}->${x.to.table}.${x.to.col}`).sort();
  assert.deepEqual(fmt, ['orders.customer_id->customer.customer_id', 'payment.order_id->orders.order_id']);
});

test('builder joins through intermediate tables and groups aggregates', async () => {
  const { db, schema } = await setup();
  const rels = detectRelationships(db, schema);
  assert.deepEqual(resolveJoins('payment', ['customer'], rels), [
    'LEFT JOIN orders ON payment.order_id = orders.order_id',
    'LEFT JOIN customer ON orders.customer_id = customer.customer_id',
  ]);
  const sql = buildSQL(
    {
      base: 'customer',
      fields: [
        { table: 'customer', col: 'name' },
        { kind: 'count' },
        { table: 'orders', col: 'amount', agg: 'sum' },
      ],
      filters: [{ table: 'orders', col: 'placed', op: 'gte', value: '1/1/2023' }],
      sort: [{ field: 1, dir: 'desc' }],
      limit: 10,
    },
    schema,
    rels,
  );
  assert.match(sql, /GROUP BY 1/);
  assert.match(sql, /WHERE date\(orders\.placed\) >= '2023-01-01'/);
  assert.deepEqual(runQuery(db, sql).rows, [['Ann', 2, 1005.5], ['Cy', 1, null]]);
  assert.throws(() => buildSQL({ base: 'customer', fields: [{ table: 'payment', col: 'paid' }] }, schema, []), /No relationship/);
});
