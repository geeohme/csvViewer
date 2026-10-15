const CANDIDATES = [',', '\t', ';', '|'];

function countOutsideQuotes(line, d) {
  let inQ = false;
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQ = !inQ;
    else if (ch === d && !inQ) count++;
  }
  return count;
}

export function detectDelimiter(text) {
  const lines = text.slice(0, 200_000).split(/\r\n|\n|\r/, 300).filter((l) => l.trim() !== '');
  let best = ',';
  let bestScore = -1;
  for (const d of CANDIDATES) {
    let hits = 0;
    let total = 0;
    for (const l of lines) {
      const c = countOutsideQuotes(l, d);
      if (c > 0) hits++;
      total += c;
    }
    const score = hits * 1e7 + total;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/**
 * RFC-4180 style parser. Returns every record (blank lines included, as [''])
 * plus the 1-based file line on which each record starts, so quoted fields
 * containing newlines don't throw off line numbers.
 */
export function parseCSV(text, delimiter = ',', onProgress) {
  const D = delimiter.charCodeAt(0);
  const rows = [];
  const lines = [];
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let nextReport = 0;

  while (i < n) {
    const startLine = line;
    const row = [];
    for (;;) {
      let val;
      if (text.charCodeAt(i) === 34) {
        i++;
        let start = i;
        val = '';
        for (;;) {
          const q = text.indexOf('"', i);
          const end = q === -1 ? n : q;
          for (let j = start; j < end; j++) if (text.charCodeAt(j) === 10) line++;
          if (q === -1) {
            val += text.slice(start);
            i = n;
            break;
          }
          if (text.charCodeAt(q + 1) === 34) {
            val += text.slice(start, q + 1);
            i = q + 2;
            start = i;
            continue;
          }
          val += text.slice(start, q);
          i = q + 1;
          break;
        }
        // Tolerate stray characters between a closing quote and the delimiter.
        if (i < n) {
          const s = i;
          while (i < n) {
            const c = text.charCodeAt(i);
            if (c === D || c === 10 || c === 13) break;
            i++;
          }
          if (i > s) val += text.slice(s, i);
        }
      } else {
        const s = i;
        while (i < n) {
          const c = text.charCodeAt(i);
          if (c === D || c === 10 || c === 13) break;
          i++;
        }
        val = text.slice(s, i);
      }
      row.push(val);
      if (i >= n) break;
      const c = text.charCodeAt(i);
      if (c === D) {
        i++;
        if (i >= n) {
          row.push('');
          break;
        }
        continue;
      }
      i += c === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
      line++;
      break;
    }
    rows.push(row);
    lines.push(startLine);
    if (onProgress && i >= nextReport) {
      onProgress(i / n, rows.length);
      nextReport = i + 2_000_000;
    }
  }

  const endsWithNewline = n > 0 && (text[n - 1] === '\n' || text[n - 1] === '\r');
  return { rows, lines, totalLines: endsWithNewline ? line - 1 : line };
}

export function toCSVField(v, delimiter = ',') {
  if (v == null) return '';
  const s = String(v);
  if (s.includes('"') || s.includes(delimiter) || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function toCSVLine(cells, delimiter = ',') {
  return cells.map((c) => toCSVField(c, delimiter)).join(delimiter);
}
