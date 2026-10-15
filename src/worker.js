import { detectDelimiter, parseCSV, toCSVLine } from './csv.js';
import { detectTables, buildTables, rowWidth } from './segment.js';
import { inferType, widthHint, columnStats, compileFilters, sortKey, groupKey } from './stats.js';
import { clean, parseNum, parseDate, formatDate } from './types.js';
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { buildDatabase, detectRelationships, runQuery, ensureIndex } from './sqldb.js';

let S = null;
let cache = { key: null, idx: null };
let sqlModule = null;
let D = null;
let results = {};

const cellOut = (v) => (v instanceof Uint8Array ? `[blob ${v.length} bytes]` : v);

const progress = (stage, frac) => self.postMessage({ progress: { stage, frac } });

function rebuild() {
  S.tables = buildTables(S.rows, S.starts);
  for (const t of S.tables) {
    t.types = t.names.map((_, c) => inferType(S.rows, t.idx, c));
    t.widths = t.names.map((n, c) => widthHint(n, S.rows, t.idx, c));
  }
  S.version++;
  cache = { key: null, idx: null };
}

const lastLineOf = (rec) => (rec + 1 < S.rows.length ? S.lines[rec + 1] - 1 : S.totalLines);

function summary() {
  const startSet = new Set(S.starts.map((s) => s.headerRow));
  const first = S.tables[0];
  let preamble = 0;
  if (first) {
    const lim = first.titleRow ?? first.headerRow;
    for (let r = 0; r < lim; r++) if (rowWidth(S.rows[r]) > 0) preamble++;
  }
  return {
    file: S.file,
    delimiter: S.delimiter,
    totalRecords: S.rows.length,
    totalLines: S.totalLines,
    maxWidth: S.maxWidth,
    preamble,
    edited: S.edited,
    tables: S.tables.map((t, id) => ({
      id,
      name: t.displayName,
      customName: t.name || null,
      headerRow: t.headerRow,
      titleRow: t.titleRow,
      headerLine: S.lines[t.headerRow],
      titleLine: t.titleRow != null ? S.lines[t.titleRow] : null,
      firstLine: t.idx.length ? S.lines[t.idx[0]] : null,
      lastLine: t.idx.length ? lastLineOf(t.idx[t.idx.length - 1]) : null,
      rowCount: t.idx.length,
      columns: t.names.map((name, c) => ({ name, type: t.types[c], width: t.widths[c] })),
      confidence: t.confidence,
      score: t.score,
      reasons: t.reasons,
      manual: !!t.manual,
    })),
    suspects: S.auto.suspects
      .filter((s) => !startSet.has(s.row))
      .map((s) => ({
        row: s.row,
        line: S.lines[s.row],
        score: s.score,
        reasons: s.reasons,
        preview: S.rows[s.row].filter((v) => v.trim()).slice(0, 6).join(', '),
      })),
  };
}

function table(id) {
  const t = S.tables[id];
  if (!t) throw new Error('Table not found — the index may have changed. Pick the table again.');
  return t;
}

function query(t, filters = [], sort = null) {
  const key = JSON.stringify([S.version, t.headerRow, filters, sort]);
  if (cache.key === key) return cache.idx;
  let idx = t.idx;
  const pred = compileFilters(filters, t.types);
  if (pred) {
    const out = [];
    for (let i = 0; i < idx.length; i++) if (pred(S.rows[idx[i]])) out.push(idx[i]);
    idx = Int32Array.from(out);
  }
  if (sort) {
    const kf = sortKey(t.types[sort.col]);
    const keys = new Array(idx.length);
    for (let i = 0; i < idx.length; i++) keys[i] = kf(S.rows[idx[i]][sort.col]);
    const order = Array.from(idx.keys());
    const dir = sort.dir === 'desc' ? -1 : 1;
    order.sort((a, b) => {
      const x = keys[a];
      const y = keys[b];
      if (x === null) return y === null ? a - b : 1;
      if (y === null) return -1;
      return x < y ? -dir : x > y ? dir : a - b;
    });
    idx = Int32Array.from(order, (i) => idx[i]);
  }
  cache = { key, idx };
  return idx;
}

function applyStarts(list) {
  const auto = new Map(S.auto.starts.map((s) => [s.headerRow, s]));
  const seen = new Set();
  S.starts = [];
  for (const s of list) {
    const r = s.headerRow;
    if (!Number.isInteger(r) || r < 0 || r >= S.rows.length || seen.has(r)) continue;
    if (rowWidth(S.rows[r]) === 0) continue;
    seen.add(r);
    const a = auto.get(r);
    const titleRow = Number.isInteger(s.titleRow) && s.titleRow < r && s.titleRow >= 0 ? s.titleRow : null;
    S.starts.push({
      headerRow: r,
      titleRow,
      name: s.name || (titleRow != null ? S.rows[titleRow][0].trim() : null),
      score: a?.score ?? null,
      confidence: a ? a.confidence : 'manual',
      reasons: a ? a.reasons : ['added manually'],
      manual: !a,
    });
  }
  S.starts.sort((a, b) => a.headerRow - b.headerRow);
  rebuild();
}

const H = {
  async load({ file }) {
    progress('Reading file', 0);
    const text = await file.text();
    const delimiter = detectDelimiter(text);
    progress('Parsing rows', 0);
    const parsed = parseCSV(text, delimiter, (f) => progress('Parsing rows', f));
    progress('Detecting tables', 1);
    const auto = detectTables(parsed.rows);
    let maxWidth = 0;
    for (const r of parsed.rows) {
      const w = rowWidth(r);
      if (w > maxWidth) maxWidth = w;
    }
    S = {
      file: { name: file.name, size: file.size, lastModified: file.lastModified },
      delimiter,
      rows: parsed.rows,
      lines: Int32Array.from(parsed.lines),
      totalLines: parsed.totalLines,
      maxWidth: Math.min(maxWidth, 100),
      auto,
      starts: auto.starts.map((s) => ({ ...s })),
      edited: false,
      version: 0,
    };
    progress('Profiling columns', 1);
    rebuild();
    return summary();
  },

  setStarts({ starts, edited = true }) {
    applyStarts(starts);
    S.edited = edited;
    return summary();
  },

  addStart({ row }) {
    if (S.starts.some((s) => s.headerRow === row)) return summary();
    const list = S.starts.map((s) => (s.titleRow === row ? { ...s, titleRow: null, name: null } : s));
    list.push({ headerRow: row });
    applyStarts(list);
    S.edited = true;
    return summary();
  },

  removeStart({ row }) {
    applyStarts(S.starts.filter((s) => s.headerRow !== row));
    S.edited = true;
    return summary();
  },

  rename({ row, name }) {
    const s = S.starts.find((x) => x.headerRow === row);
    if (s) s.name = name.trim() || null;
    applyStarts(S.starts);
    S.edited = true;
    return summary();
  },

  resetAuto() {
    S.starts = S.auto.starts.map((s) => ({ ...s }));
    S.edited = false;
    rebuild();
    return summary();
  },

  getRows({ table: id, filters, sort, offset, limit }) {
    const t = table(id);
    const idx = query(t, filters, sort);
    const n = t.names.length;
    const rows = [];
    for (let i = offset; i < Math.min(idx.length, offset + limit); i++) {
      const r = idx[i];
      const src = S.rows[r];
      const cells = new Array(n);
      for (let c = 0; c < n; c++) cells[c] = src[c] ?? '';
      rows.push({ rec: r, line: S.lines[r], cells });
    }
    return { total: idx.length, rows };
  },

  getRaw({ offset, limit }) {
    const starts = new Map(S.tables.map((t, i) => [t.headerRow, i]));
    const titles = new Map(S.tables.filter((t) => t.titleRow != null).map((t) => [t.titleRow, t]));
    const suspects = new Set(S.auto.suspects.map((s) => s.row));
    const rows = [];
    for (let r = offset; r < Math.min(S.rows.length, offset + limit); r++) {
      const src = S.rows[r];
      const cells = new Array(S.maxWidth);
      for (let c = 0; c < S.maxWidth; c++) cells[c] = src[c] ?? '';
      let mark = null;
      if (starts.has(r)) mark = { kind: 'header', table: starts.get(r) };
      else if (titles.has(r)) mark = { kind: 'title' };
      else if (suspects.has(r)) mark = { kind: 'suspect' };
      else if (rowWidth(src) === 0) mark = { kind: 'blank' };
      rows.push({ rec: r, line: S.lines[r], cells, mark });
    }
    return { total: S.rows.length, rows };
  },

  lineToRecord({ line }) {
    let lo = 0;
    let hi = S.lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (S.lines[mid] <= line) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  },

  stats({ table: id, filters }) {
    const t = table(id);
    const idx = query(t, filters, null);
    return {
      total: idx.length,
      columns: t.names.map((name, c) => columnStats(S.rows, idx, c, name, t.types[c])),
    };
  },

  groupBy({ table: id, filters, keys, aggFn, aggCol, order }) {
    const t = table(id);
    const idx = query(t, filters, null);
    const kfs = keys.map((k) => ({ col: k.col, f: groupKey(t.types[k.col], k.gran) }));
    const aggType = aggCol != null ? t.types[aggCol] : null;
    const parse = aggType === 'date' ? parseDate : parseNum;
    const groups = new Map();
    const parts = new Array(kfs.length);
    for (let i = 0; i < idx.length; i++) {
      const row = S.rows[idx[i]];
      for (let k = 0; k < kfs.length; k++) parts[k] = kfs[k].f(row[kfs[k].col]);
      const key = parts.join('\u0001');
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { keys: parts.slice(), count: 0, n: 0, sum: 0, min: Infinity, max: -Infinity }));
      g.count++;
      if (aggFn && aggCol != null) {
        const x = parse(clean(row[aggCol]));
        if (!Number.isNaN(x)) {
          g.n++;
          g.sum += x;
          if (x < g.min) g.min = x;
          if (x > g.max) g.max = x;
        }
      }
    }
    let list = [...groups.values()];
    for (const g of list) {
      if (!aggFn) continue;
      let v = null;
      if (g.n) v = aggFn === 'sum' ? g.sum : aggFn === 'avg' ? g.sum / g.n : aggFn === 'min' ? g.min : g.max;
      g.agg = v != null && aggType === 'date' ? formatDate(v) : v;
    }
    const cmpKeys = (a, b) => {
      for (let k = 0; k < a.keys.length; k++) {
        const x = a.keys[k];
        const y = b.keys[k];
        if (x === y) continue;
        if (x === '(empty)') return 1;
        if (y === '(empty)') return -1;
        return x < y ? -1 : 1;
      }
      return 0;
    };
    if (order === 'key') list.sort(cmpKeys);
    else if (order === 'agg') {
      list.sort((a, b) => {
        if (a.agg == null) return b.agg == null ? 0 : 1;
        if (b.agg == null) return -1;
        return a.agg < b.agg ? 1 : a.agg > b.agg ? -1 : 0;
      });
    } else list.sort((a, b) => b.count - a.count || cmpKeys(a, b));
    const totalGroups = list.length;
    list = list.slice(0, 5000).map(({ keys: k, count, agg }) => ({ keys: k, count, agg }));
    return { total: idx.length, totalGroups, groups: list };
  },

  exportTable({ table: id, filters, sort }) {
    const t = table(id);
    const idx = query(t, filters, sort);
    const out = [toCSVLine(t.names)];
    for (let i = 0; i < idx.length; i++) {
      const src = S.rows[idx[i]];
      out.push(toCSVLine(t.names.map((_, c) => src[c] ?? '')));
    }
    return out.join('\n') + '\n';
  },

  async sqlInit({ force = false } = {}) {
    let fresh = false;
    if (!D || D.version !== S.version || force) {
      sqlModule ||= initSqlJs({ locateFile: () => wasmUrl });
      const SQL = await sqlModule;
      progress('Loading tables into SQLite', 0.3);
      D?.db.close();
      const t0 = performance.now();
      const { db, schema } = buildDatabase(SQL, S.tables, S.rows, S.lines);
      progress('Detecting relationships', 0.9);
      const autoRels = detectRelationships(db, schema);
      D = { db, schema, autoRels, version: S.version, ms: Math.round(performance.now() - t0) };
      results = {};
      fresh = true;
    }
    return { schema: D.schema, autoRels: D.autoRels, ms: D.ms, fresh };
  },

  runSql({ sql, slot, rels = [] }) {
    if (!D) throw new Error('SQL database not loaded yet.');
    for (const r of rels) {
      for (const side of [r.from, r.to]) {
        try {
          ensureIndex(D.db, side.table, side.col);
        } catch {
          /* table or column no longer exists; the query will report it */
        }
      }
    }
    const t0 = performance.now();
    const res = runQuery(D.db, sql);
    res.ms = Math.round(performance.now() - t0);
    results[slot] = res;
    return { columns: res.columns, total: res.rows.length, truncated: res.truncated, changes: res.changes, ms: res.ms, rows: res.rows.slice(0, 200).map((r) => r.map(cellOut)) };
  },

  sqlRows({ slot, offset, limit }) {
    const res = results[slot];
    if (!res) return [];
    return res.rows.slice(offset, offset + limit).map((r) => r.map(cellOut));
  },

  sqlExport({ slot }) {
    const res = results[slot];
    if (!res) throw new Error('Run a query first.');
    const out = [toCSVLine(res.columns)];
    for (const r of res.rows) out.push(toCSVLine(r.map(cellOut)));
    return out.join('\n') + '\n';
  },

  exportIndex() {
    const s = summary();
    return {
      generatedBy: 'CSV Dump Explorer',
      generatedAt: new Date().toISOString(),
      file: s.file,
      delimiter: s.delimiter,
      totalRecords: s.totalRecords,
      totalLines: s.totalLines,
      note: 'Lines are 1-based physical file lines. Records are 1-based CSV records (a quoted value can span several lines).',
      tables: s.tables.map((t) => ({
        table: t.id + 1,
        name: t.name,
        titleLine: t.titleLine,
        headerLine: t.headerLine,
        firstDataLine: t.firstLine,
        lastDataLine: t.lastLine,
        headerRecord: t.headerRow + 1,
        titleRecord: t.titleRow != null ? t.titleRow + 1 : null,
        rowCount: t.rowCount,
        columnCount: t.columns.length,
        columns: t.columns.map((c) => ({ name: c.name, type: c.type })),
        detection: t.manual ? 'manual' : t.confidence,
        reasons: t.reasons,
      })),
    };
  },
};

self.onmessage = async (e) => {
  const { id, cmd, args } = e.data;
  try {
    if (!S && cmd !== 'load') throw new Error('No file loaded');
    const result = await H[cmd](args || {});
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
