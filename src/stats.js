import { clean, parseNum, parseDate, classify, K, formatDate } from './types.js';

export function inferType(rows, idx, c, sample = 4000) {
  let num = 0;
  let date = 0;
  let filled = 0;
  const step = Math.max(1, Math.floor(idx.length / sample));
  for (let i = 0; i < idx.length; i += step) {
    const k = classify(rows[idx[i]][c]);
    if (k === K.EMPTY) continue;
    filled++;
    if (k === K.NUMBER) num++;
    else if (k === K.DATE) date++;
  }
  if (!filled) return 'empty';
  if (num / filled >= 0.95) return 'number';
  if (date / filled >= 0.95) return 'date';
  return 'text';
}

export function widthHint(name, rows, idx, c) {
  let len = name.length + 3;
  const lim = Math.min(idx.length, 300);
  for (let i = 0; i < lim; i++) {
    const v = rows[idx[i]][c];
    if (v && v.length > len) len = v.length;
  }
  return Math.round(Math.min(340, Math.max(72, len * 7.4 + 22)));
}

const MS_DAY = 86_400_000;

export function columnStats(rows, idx, c, name, type) {
  let filled = 0;
  let empty = 0;
  let invalid = 0;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let minLen = Infinity;
  let maxLen = 0;
  let minText = null;
  let maxText = null;
  const counts = new Map();
  const values = type === 'number' ? new Float64Array(idx.length) : null;
  let nv = 0;

  for (let i = 0; i < idx.length; i++) {
    const t = clean(rows[idx[i]][c]);
    if (t === '') {
      empty++;
      continue;
    }
    filled++;
    counts.set(t, (counts.get(t) || 0) + 1);
    if (t.length < minLen) minLen = t.length;
    if (t.length > maxLen) maxLen = t.length;
    if (type === 'number' || type === 'date') {
      const x = type === 'number' ? parseNum(t) : parseDate(t);
      if (Number.isNaN(x)) {
        invalid++;
        continue;
      }
      if (x < min) min = x;
      if (x > max) max = x;
      if (values) {
        sum += x;
        values[nv++] = x;
      }
    } else {
      const low = t.toLowerCase();
      if (minText === null || low < minText.toLowerCase()) minText = t;
      if (maxText === null || low > maxText.toLowerCase()) maxText = t;
    }
  }

  const top = [];
  for (const [value, count] of counts) {
    if (top.length < 5 || count > top[top.length - 1].count) {
      top.push({ value, count });
      top.sort((a, b) => b.count - a.count);
      if (top.length > 5) top.pop();
    }
  }

  const out = {
    name,
    type,
    rows: idx.length,
    filled,
    empty,
    distinct: counts.size,
    invalid,
    minLen: filled ? minLen : null,
    maxLen: filled ? maxLen : null,
    top,
  };
  if (type === 'number' && nv) {
    const v = values.subarray(0, nv).sort();
    out.min = min;
    out.max = max;
    out.sum = sum;
    out.mean = sum / nv;
    out.median = nv % 2 ? v[(nv - 1) / 2] : (v[nv / 2 - 1] + v[nv / 2]) / 2;
  } else if (type === 'date' && min !== Infinity) {
    out.min = formatDate(min);
    out.max = formatDate(max);
    out.spanDays = Math.round((max - min) / MS_DAY);
  } else if (type !== 'number' && type !== 'date') {
    out.min = minText;
    out.max = maxText;
  }
  return out;
}

function compileOne(f, type) {
  const c = f.col;
  const raw = String(f.value ?? '').trim();
  const low = raw.toLowerCase();
  const get = (row) => clean(row[c]);
  const parse = type === 'number' ? parseNum : type === 'date' ? parseDate : null;

  switch (f.op) {
    case 'empty':
      return (row) => get(row) === '';
    case 'notempty':
      return (row) => get(row) !== '';
    case 'contains':
      return (row) => get(row).toLowerCase().includes(low);
    case 'notcontains':
      return (row) => !get(row).toLowerCase().includes(low);
    case 'starts':
      return (row) => get(row).toLowerCase().startsWith(low);
    case 'in': {
      const set = new Set(low.split(',').map((s) => s.trim()).filter(Boolean));
      return (row) => set.has(get(row).toLowerCase());
    }
    case 'eq':
    case 'neq': {
      let test;
      if (parse && !Number.isNaN(parse(raw))) {
        const x = parse(raw);
        const dateOnly = type === 'date' && !/\d:\d/.test(raw);
        test = dateOnly
          ? (row) => {
              const y = parse(get(row));
              return y >= x && y < x + MS_DAY;
            }
          : (row) => parse(get(row)) === x;
      } else test = (row) => get(row).toLowerCase() === low;
      return f.op === 'eq' ? test : (row) => !test(row);
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (parse && !Number.isNaN(parse(raw))) {
        const x = parse(raw);
        // A date-only bound like "<= 2024-01-31" should include that whole day.
        const dayEnd = type === 'date' && !/\d:\d/.test(raw) ? x + MS_DAY : null;
        const cmp = {
          gt: dayEnd != null ? (y) => y >= dayEnd : (y) => y > x,
          gte: (y) => y >= x,
          lt: (y) => y < x,
          lte: dayEnd != null ? (y) => y < dayEnd : (y) => y <= x,
        }[f.op];
        return (row) => {
          const y = parse(get(row));
          return !Number.isNaN(y) && cmp(y);
        };
      }
      const cmp = { gt: (s) => s > low, gte: (s) => s >= low, lt: (s) => s < low, lte: (s) => s <= low }[f.op];
      return (row) => {
        const s = get(row);
        return s !== '' && cmp(s.toLowerCase());
      };
    }
    default:
      throw new Error(`Unknown filter operator: ${f.op}`);
  }
}

export function compileFilters(filters, types) {
  const preds = filters.map((f) => compileOne(f, types[f.col]));
  if (!preds.length) return null;
  return (row) => {
    for (const p of preds) if (!p(row)) return false;
    return true;
  };
}

export function sortKey(type) {
  if (type === 'number') return (v) => {
    const x = parseNum(clean(v));
    return Number.isNaN(x) ? null : x;
  };
  if (type === 'date') return (v) => {
    const x = parseDate(clean(v));
    return Number.isNaN(x) ? null : x;
  };
  return (v) => {
    const t = clean(v);
    return t === '' ? null : t.toLowerCase();
  };
}

export function groupKey(type, gran) {
  if (type === 'date' && gran && gran !== 'exact') {
    const len = { year: 4, month: 7, day: 10 }[gran];
    return (v) => {
      const x = parseDate(clean(v));
      return Number.isNaN(x) ? '(empty)' : formatDate(x).slice(0, len);
    };
  }
  return (v) => clean(v) || '(empty)';
}
