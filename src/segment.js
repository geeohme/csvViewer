import { classify, K } from './types.js';

export function rowWidth(row) {
  for (let c = row.length - 1; c >= 0; c--) if (row[c].trim() !== '') return c + 1;
  return 0;
}

function nonEmptyCount(row) {
  let n = 0;
  for (const v of row) if (v.trim() !== '') n++;
  return n;
}

/** All non-empty cells are short, unique text (no numbers, dates or NULLs). */
export function isHeaderish(row) {
  let filled = 0;
  const seen = new Set();
  for (const raw of row) {
    const v = raw.trim();
    if (!v) continue;
    filled++;
    if (v.length > 80) return false;
    if (classify(v) !== K.TEXT) return false;
    const low = v.toLowerCase();
    if (seen.has(low)) return false;
    seen.add(low);
  }
  return filled >= 2;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEYWORD = /\b(id|key|date|dt|time|timestamp|name|code|type|status|amount|amt|qty|quantity|number|num|no|desc|description|created|updated|email|phone|addr|address|city|state|zip|count|total|price)\b/i;

function looksLikeColumnNames(row) {
  let n = 0;
  let hit = 0;
  for (const raw of row) {
    const v = raw.trim();
    if (!v) continue;
    n++;
    const ident = IDENT.test(v) && (v.includes('_') || /[a-z][A-Z]/.test(v) || (/^[A-Z0-9_]+$/.test(v) && v.length > 1));
    if (ident || KEYWORD.test(v.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'))) hit++;
  }
  return n > 0 && hit / n >= 0.6;
}

function isTitleRow(row) {
  return rowWidth(row) === 1 && nonEmptyCount(row) === 1 && classify(row[0]) === K.TEXT;
}

const PROFILE_CAP = 2000;

function newProfile(r, row) {
  return {
    headerRow: r,
    header: row.map((s) => s.trim().toLowerCase()),
    width: rowWidth(row),
    n: 0,
    filled: [],
    typed: [],
  };
}

function profileRow(cur, row) {
  if (cur.n >= PROFILE_CAP) return;
  cur.n++;
  for (let c = 0; c < row.length; c++) {
    const k = classify(row[c]);
    if (k === K.EMPTY) continue;
    cur.filled[c] = (cur.filled[c] || 0) + 1;
    if (k === K.NUMBER || k === K.DATE) cur.typed[c] = (cur.typed[c] || 0) + 1;
  }
}

function typeConflicts(row, cur) {
  let typedCols = 0;
  let conflicts = 0;
  for (let c = 0; c < cur.filled.length; c++) {
    const f = cur.filled[c] || 0;
    if (f < 3 || (cur.typed[c] || 0) / f < 0.9) continue;
    typedCols++;
    if (classify(row[c]) === K.TEXT) conflicts++;
  }
  return { typedCols, conflicts };
}

function typedValuesBelow(row, next) {
  let n = 0;
  for (let c = 0; c < row.length; c++) {
    if (classify(row[c]) !== K.TEXT) continue;
    const k = classify(next[c]);
    if (k === K.NUMBER || k === K.DATE) n++;
  }
  return n;
}

function sameHeader(row, header) {
  const w = Math.max(rowWidth(row), header.length);
  for (let c = 0; c < w; c++) {
    if ((row[c] ?? '').trim().toLowerCase() !== (header[c] ?? '')) return false;
  }
  return true;
}

export const START_THRESHOLD = 3;

/**
 * Walks every record and decides which ones begin a new table.
 * Returns { starts, suspects }: starts are accepted header rows; suspects are
 * header-like rows that scored too low to split on, for manual review.
 */
export function detectTables(rows) {
  const starts = [];
  const suspects = [];
  let cur = null;
  let prevBlank = false;
  let lastNonBlank = -1;
  let pendingTitle = null;

  const nextNonBlank = (r) => {
    for (let j = r + 1; j < rows.length && j < r + 50; j++) if (rowWidth(rows[j]) > 0) return j;
    return -1;
  };

  const begin = (r, score, reasons) => {
    let titleRow = pendingTitle;
    if (titleRow == null && cur && lastNonBlank > cur.headerRow && isTitleRow(rows[lastNonBlank])) {
      titleRow = lastNonBlank;
    }
    pendingTitle = null;
    starts.push({
      headerRow: r,
      titleRow,
      name: titleRow != null ? rows[titleRow][0].trim() : null,
      score,
      confidence: score >= 4 ? 'high' : 'medium',
      reasons,
    });
    cur = newProfile(r, rows[r]);
  };

  const score = (r, row) => {
    const reasons = [];
    let s = 0;
    if (sameHeader(row, cur.header)) {
      return { score: 4, reasons: ['repeats the previous header exactly'] };
    }
    const w = rowWidth(row);
    if (w > cur.width) {
      s += 2;
      reasons.push(`wider than current table (${cur.width} → ${w} columns)`);
    } else if (w < cur.width) {
      s += 1;
      reasons.push(`narrower than current table (${cur.width} → ${w} columns)`);
    }
    const { typedCols, conflicts } = typeConflicts(row, cur);
    if (conflicts > 0) {
      const strong = conflicts >= Math.ceil(typedCols / 2);
      s += strong ? 3 : 1;
      reasons.push(`text in ${conflicts} of ${typedCols} numeric/date columns`);
    }
    if (prevBlank) {
      s += 2;
      reasons.push('follows a blank line');
    }
    if (lastNonBlank > cur.headerRow && isTitleRow(rows[lastNonBlank])) {
      s += 1;
      reasons.push('preceded by a one-cell title row');
    }
    const nx = nextNonBlank(r);
    if (nx >= 0 && typedValuesBelow(row, rows[nx]) > 0) {
      s += 1;
      reasons.push('next row has numbers/dates under these labels');
    }
    if (looksLikeColumnNames(row)) {
      s += 1;
      reasons.push('values look like column names');
    }
    return { score: s, reasons };
  };

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const w = rowWidth(row);
    if (w === 0) {
      prevBlank = true;
      continue;
    }
    if (!cur) {
      const nx = nextNonBlank(r);
      if (isTitleRow(row) && nx >= 0 && isHeaderish(rows[nx])) {
        pendingTitle = r;
      } else {
        begin(r, 5, ['first row of the file']);
      }
    } else if (isHeaderish(row)) {
      const res = score(r, row);
      if (res.score >= START_THRESHOLD) begin(r, res.score, res.reasons);
      else {
        if (res.score >= 1) suspects.push({ row: r, score: res.score, reasons: res.reasons });
        profileRow(cur, row);
      }
    } else {
      profileRow(cur, row);
    }
    // A blank line followed by a title row still counts as "after a blank line" for the header below it.
    if (!(prevBlank && isTitleRow(row))) prevBlank = false;
    lastNonBlank = r;
  }
  return { starts, suspects };
}

function guessName(names, i) {
  const m = /^(.*?)[\s_-]*(id|key|code|no|num|number)$/i.exec(names[0] || '');
  if (m && m[1] && m[1].length > 1) return m[1];
  return `Table ${i + 1}`;
}

/** Materialises tables from start markers. Data rows exclude blank lines and the next table's title row. */
export function buildTables(rows, starts) {
  const sorted = [...starts].sort((a, b) => a.headerRow - b.headerRow);
  return sorted.map((s, i) => {
    const next = sorted[i + 1];
    const end = next ? (next.titleRow ?? next.headerRow) : rows.length;
    const header = rows[s.headerRow];
    let maxW = rowWidth(header);
    const idx = [];
    for (let r = s.headerRow + 1; r < end; r++) {
      const w = rowWidth(rows[r]);
      if (w === 0) continue;
      idx.push(r);
      if (w > maxW) maxW = w;
    }
    const names = [];
    const used = new Map();
    for (let c = 0; c < maxW; c++) {
      let nm = (header[c] ?? '').trim() || `column_${c + 1}`;
      const k = nm.toLowerCase();
      if (used.has(k)) {
        used.set(k, used.get(k) + 1);
        nm = `${nm}_${used.get(k)}`;
      } else used.set(k, 1);
      names.push(nm);
    }
    return {
      ...s,
      end,
      idx: Int32Array.from(idx),
      names,
      displayName: s.name || guessName(names, i),
    };
  });
}
