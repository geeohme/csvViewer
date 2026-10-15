import { parseNum, parseDate, formatDate } from './types.js';

export const AGG_LABELS = {
  '': 'value',
  count: 'count',
  count_distinct: 'count distinct',
  sum: 'sum',
  avg: 'average',
  min: 'min',
  max: 'max',
};

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const isAgg = (f) => f.kind === 'count' || !!f.agg;

function colType(schema, table, col) {
  return schema.find((t) => t.name === table)?.columns.find((c) => c.name === col)?.type || 'text';
}

export function fieldExpr(f) {
  if (f.kind === 'count') return 'COUNT(*)';
  let e = `${f.table}.${f.col}`;
  if (f.gran === 'year') e = `strftime('%Y', ${e})`;
  else if (f.gran === 'month') e = `strftime('%Y-%m', ${e})`;
  else if (f.gran === 'day') e = `date(${e})`;
  switch (f.agg) {
    case 'count':
      return `COUNT(${e})`;
    case 'count_distinct':
      return `COUNT(DISTINCT ${e})`;
    case 'sum':
      return `SUM(${e})`;
    case 'avg':
      return `ROUND(AVG(${e}), 4)`;
    case 'min':
      return `MIN(${e})`;
    case 'max':
      return `MAX(${e})`;
    default:
      return e;
  }
}

function aliases(fields) {
  const colCount = new Map();
  for (const f of fields) if (f.col) colCount.set(f.col, (colCount.get(f.col) || 0) + 1);
  const used = new Set();
  return fields.map((f) => {
    let a;
    if (f.kind === 'count') a = 'row_count';
    else {
      const base = colCount.get(f.col) > 1 ? `${f.table}_${f.col}` : f.col;
      a = [f.agg || null, f.gran || null, base].filter(Boolean).join('_');
    }
    let out = a;
    for (let i = 2; used.has(out); i++) out = `${a}_${i}`;
    used.add(out);
    return out;
  });
}

/** Shortest join path (breadth-first over relationships) from the base table to every other table used. */
export function resolveJoins(base, needed, rels) {
  const adj = new Map();
  const link = (a, b, on, type) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ to: b, on, type });
  };
  for (const r of rels) {
    if (r.from.table === r.to.table) continue;
    link(r.from.table, r.to.table, [r.from, r.to], r.type);
    link(r.to.table, r.from.table, [r.to, r.from], r.type);
  }
  const parent = new Map([[base, null]]);
  const queue = [base];
  while (queue.length) {
    const t = queue.shift();
    for (const e of adj.get(t) || []) {
      if (parent.has(e.to)) continue;
      parent.set(e.to, { from: t, ...e });
      queue.push(e.to);
    }
  }
  const joins = [];
  const joined = new Set([base]);
  for (const t of needed) {
    if (t === base) continue;
    if (!parent.has(t)) throw new Error(`No relationship connects ${base} to ${t}. Add one in the Data model tab, or change the From table.`);
    const path = [];
    for (let cur = t; cur !== base; cur = parent.get(cur).from) path.unshift(parent.get(cur));
    for (const step of path) {
      if (joined.has(step.to)) continue;
      joined.add(step.to);
      const [a, b] = step.on;
      joins.push(`${step.type === 'inner' ? 'INNER' : 'LEFT'} JOIN ${step.to} ON ${a.table}.${a.col} = ${b.table}.${b.col}`);
    }
  }
  return joins;
}

export function filterSQL(f, type) {
  const e = `${f.table}.${f.col}`;
  const v = String(f.value ?? '').trim();
  const asDate = type === 'date' ? parseDate(v) : NaN;
  const dateOnly = !Number.isNaN(asDate) && !/\d:\d/.test(v);
  const value = (raw) => {
    const t = raw.trim();
    if (type === 'number' && !Number.isNaN(parseNum(t))) return String(parseNum(t));
    if (type === 'date') {
      const d = parseDate(t);
      if (!Number.isNaN(d)) return lit(dateOnly ? formatDate(d).slice(0, 10) : formatDate(d));
    }
    return lit(t);
  };
  const lhs = dateOnly ? `date(${e})` : e;
  const nocase = type === 'text' ? ' COLLATE NOCASE' : '';
  switch (f.op) {
    case 'empty':
      return `${e} IS NULL`;
    case 'notempty':
      return `${e} IS NOT NULL`;
    case 'contains':
      return `${e} LIKE ${lit(`%${v}%`)}`;
    case 'notcontains':
      return `(${e} IS NULL OR ${e} NOT LIKE ${lit(`%${v}%`)})`;
    case 'starts':
      return `${e} LIKE ${lit(`${v}%`)}`;
    case 'eq':
      return `${lhs}${nocase} = ${value(v)}`;
    case 'neq':
      return `(${e} IS NULL OR ${lhs}${nocase} <> ${value(v)})`;
    case 'gt':
      return `${lhs} > ${value(v)}`;
    case 'gte':
      return `${lhs} >= ${value(v)}`;
    case 'lt':
      return `${lhs} < ${value(v)}`;
    case 'lte':
      return `${lhs} <= ${value(v)}`;
    case 'in':
      return `${e}${nocase} IN (${v.split(',').filter((x) => x.trim()).map(value).join(', ')})`;
    default:
      throw new Error(`Unknown operator ${f.op}`);
  }
}

const NO_VALUE = new Set(['empty', 'notempty']);

/**
 * spec: { base, fields: [{kind?:'count', table, col, agg, gran}], filters: [{table, col, op, value}],
 *         sort: [{field: index, dir}], limit }
 */
export function buildSQL(spec, schema, rels) {
  if (!spec.base) throw new Error('Pick a table to start from.');
  const filters = (spec.filters || []).filter((f) => f.table && (NO_VALUE.has(f.op) || String(f.value ?? '').trim() !== ''));
  const fields = spec.fields || [];
  const needed = new Set([...fields.filter((f) => f.table).map((f) => f.table), ...filters.map((f) => f.table)]);
  const joins = resolveJoins(spec.base, needed, rels);
  const lines = [];
  if (!fields.length) lines.push(`SELECT ${spec.base}.*`);
  else {
    const names = aliases(fields);
    lines.push('SELECT ' + fields.map((f, i) => `${fieldExpr(f)} AS ${names[i]}`).join(',\n       '));
  }
  lines.push(`FROM ${spec.base}`);
  for (const j of joins) lines.push(`  ${j}`);
  if (filters.length) lines.push('WHERE ' + filters.map((f) => filterSQL(f, colType(schema, f.table, f.col))).join('\n  AND '));
  if (fields.some(isAgg)) {
    const groupPos = fields.map((f, i) => (isAgg(f) ? null : i + 1)).filter(Boolean);
    if (groupPos.length) lines.push(`GROUP BY ${groupPos.join(', ')}`);
  }
  const sort = (spec.sort || []).filter((s) => s.field != null && s.field < fields.length);
  if (sort.length) lines.push('ORDER BY ' + sort.map((s) => `${s.field + 1} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`).join(', '));
  const limit = parseInt(spec.limit, 10);
  if (limit > 0) lines.push(`LIMIT ${limit}`);
  return lines.join('\n') + ';';
}

export function fieldLabel(f) {
  if (f.kind === 'count') return 'Count of rows';
  const g = f.gran ? ` by ${f.gran}` : '';
  return f.agg ? `${AGG_LABELS[f.agg]} of ${f.table}.${f.col}${g}` : `${f.table}.${f.col}${g}`;
}
