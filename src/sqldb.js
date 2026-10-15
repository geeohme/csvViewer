import { clean, parseNum, parseDate, formatDate } from './types.js';

const RESERVED = new Set(
  ('abort action add after all alter analyze and as asc attach autoincrement before begin between by cascade case cast check ' +
    'collate column commit conflict constraint create cross current current_date current_time current_timestamp database default ' +
    'deferrable deferred delete desc detach distinct do drop each else end escape except exclude exclusive exists explain fail filter ' +
    'first following for foreign from full generated glob group groups having if ignore immediate in index indexed initially inner insert ' +
    'instead intersect into is isnull join key last left like limit match natural no not nothing notnull null nulls of offset on or order ' +
    'others outer over partition plan pragma preceding primary query raise range recursive references regexp reindex release rename replace ' +
    'restrict right rollback row rows savepoint select set table temp temporary then ties to transaction trigger unbounded union unique ' +
    'update using vacuum values view virtual when where window with without').split(' '),
);

/** A lowercase, unquoted-safe SQL identifier, unique within `used`. */
export function sqlIdent(name, used, reservedSuffix = '_') {
  let s = String(name).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'col';
  if (/^\d/.test(s)) s = 't_' + s;
  if (RESERVED.has(s)) s += reservedSuffix;
  let out = s;
  for (let i = 2; used.has(out); i++) out = `${s}_${i}`;
  used.add(out);
  return out;
}

/**
 * Loads every table into an in-memory SQLite database. Numbers become REAL,
 * dates become ISO text (so they sort and work with date()/strftime()), and
 * empty/NULL tokens become NULL. Each table also gets a _line column holding
 * the source file line.
 */
export function buildDatabase(SQL, tables, rows, lines) {
  const db = new SQL.Database();
  const usedT = new Set();
  const schema = [];
  db.run('BEGIN');
  tables.forEach((t, tableId) => {
    const name = sqlIdent(t.displayName, usedT, 's');
    const usedC = new Set(['_line']);
    const cols = t.names.map((n, c) => ({ name: sqlIdent(n, usedC), source: n, type: t.types[c], c }));
    const decl = cols.map((c) => `${c.name} ${c.type === 'number' ? 'REAL' : 'TEXT'}`);
    db.run(`CREATE TABLE ${name} (_line INTEGER, ${decl.join(', ')})`);
    const stmt = db.prepare(`INSERT INTO ${name} VALUES (${new Array(cols.length + 1).fill('?').join(',')})`);
    const vals = new Array(cols.length + 1);
    for (let i = 0; i < t.idx.length; i++) {
      const r = t.idx[i];
      const src = rows[r];
      vals[0] = lines[r];
      for (const col of cols) {
        const v = clean(src[col.c]);
        let out = v === '' ? null : v;
        if (out !== null && col.type === 'number') {
          const x = parseNum(v);
          out = Number.isNaN(x) ? null : x;
        } else if (out !== null && col.type === 'date') {
          const x = parseDate(v);
          out = Number.isNaN(x) ? null : formatDate(x);
        }
        vals[col.c + 1] = out;
      }
      stmt.run(vals);
    }
    stmt.free();
    schema.push({
      name,
      tableId,
      label: t.displayName,
      rowCount: t.idx.length,
      columns: [
        { name: '_line', source: 'source file line', type: 'number' },
        ...cols.map(({ name: cn, source, type }) => ({ name: cn, source, type })),
      ],
    });
  });
  db.run('COMMIT');
  return { db, schema };
}

const one = (db, sql) => db.exec(sql)[0]?.values[0] ?? [];
const singular = (s) => s.replace(/ies$/, 'y').replace(/s$/, '');

export function ensureIndex(db, table, col) {
  db.run(`CREATE INDEX IF NOT EXISTS ix_${table}__${col} ON ${table}(${col})`);
}

/**
 * Suggests many-to-one relationships: a column in table B whose name matches
 * a unique key column in table A (A's first column, or A.id for B.<a>_id), and
 * whose values mostly exist in A.
 */
export function detectRelationships(db, schema) {
  const rels = [];
  for (const A of schema) {
    const keys = A.columns.filter((c, i) => (i === 1 || c.name === 'id') && c.name !== '_line');
    for (const pk of keys) {
      const [n, d] = one(db, `SELECT COUNT(${pk.name}), COUNT(DISTINCT ${pk.name}) FROM ${A.name}`);
      if (!n || n !== d) continue;
      let indexed = false;
      for (const B of schema) {
        if (B === A) continue;
        for (const fk of B.columns) {
          if (fk.name === '_line') continue;
          const match = fk.name === pk.name || (pk.name === 'id' && (fk.name === `${A.name}_id` || fk.name === `${singular(A.name)}_id`));
          if (!match) continue;
          if (!indexed) {
            ensureIndex(db, A.name, pk.name);
            indexed = true;
          }
          const [cnt, hit] = one(
            db,
            `SELECT COUNT(*), COALESCE(SUM(EXISTS(SELECT 1 FROM ${A.name} a WHERE a.${pk.name} = s.v)), 0) FROM (SELECT ${fk.name} AS v FROM ${B.name} WHERE ${fk.name} IS NOT NULL LIMIT 500) s`,
          );
          if (!cnt || hit / cnt < 0.5) continue;
          rels.push({ from: { table: B.name, col: fk.name }, to: { table: A.name, col: pk.name }, type: 'left', auto: true });
        }
      }
    }
  }
  return rels;
}

/** Runs one or more statements; returns the rows of the last statement that produced columns. */
export function runQuery(db, sql, cap = 1_000_000) {
  let last = null;
  let statements = 0;
  for (const stmt of db.iterateStatements(sql)) {
    statements++;
    const columns = stmt.getColumnNames();
    if (!columns.length) {
      while (stmt.step());
      continue;
    }
    const rows = [];
    let truncated = false;
    while (stmt.step()) {
      if (rows.length >= cap) {
        truncated = true;
        break;
      }
      rows.push(stmt.get());
    }
    last = { columns, rows, truncated };
  }
  if (!statements) throw new Error('Nothing to run — the SQL is empty.');
  return last || { columns: [], rows: [], truncated: false, changes: db.getRowsModified() };
}
