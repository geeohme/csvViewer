export const K = { EMPTY: 0, NUMBER: 1, DATE: 2, TEXT: 3 };

const NULLS = new Set(['null', 'NULL', 'Null', '\\N', 'N/A', 'n/a', '#N/A']);

export function clean(v) {
  if (v === undefined || v === '') return '';
  const t = v.trim();
  return NULLS.has(t) ? '' : t;
}

const NUM_RE = /^[-+]?\$?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

/** Expects a trimmed string. Accepts 1,234.50 / $12 / -3e4. */
export function parseNum(t) {
  if (t === '' || t.length > 40 || !NUM_RE.test(t)) return NaN;
  const c = t.charCodeAt(t.length - 1);
  if (c < 48 || c > 57) return NaN;
  return Number(t.replace(/[$,]/g, ''));
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const TIME = String.raw`(?:[T ]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?\s*([AaPp][Mm])?\s*(?:Z|[+-]\d{2}:?\d{2})?)?`;
const ISO = new RegExp(String.raw`^(\d{4})[-/](\d{1,2})[-/](\d{1,2})` + TIME + '$');
const MDY = new RegExp(String.raw`^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})` + TIME + '$');
const DMONY = new RegExp(String.raw`^(\d{1,2})[- ]([A-Za-z]{3,9})[- ,]+(\d{4}|\d{2})` + TIME + '$');
const MONDY = new RegExp(String.raw`^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})` + TIME + '$');

function mk(y, mo, d, h, mi, s, ampm) {
  if (y < 100) y += y < 50 ? 2000 : 1900;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return NaN;
  let hh = h ? Number(h) : 0;
  if (ampm) {
    const pm = ampm[0] === 'p' || ampm[0] === 'P';
    if (hh < 1 || hh > 12) return NaN;
    hh = (hh % 12) + (pm ? 12 : 0);
  }
  const mm = mi ? Number(mi) : 0;
  const ss = s ? Number(s) : 0;
  if (hh > 23 || mm > 59 || ss > 59) return NaN;
  const ms = Date.UTC(y, mo - 1, d, hh, mm, ss);
  if (new Date(ms).getUTCDate() !== d) return NaN;
  return ms;
}

/**
 * Expects a trimmed string. Returns a UTC timestamp (wall-clock time, timezone
 * offsets ignored) or NaN. Slashed dates are read as M/D/Y unless the first
 * part is > 12.
 */
export function parseDate(t) {
  const len = t.length;
  if (len < 6 || len > 40) return NaN;
  let m = ISO.exec(t);
  if (m) return mk(+m[1], +m[2], +m[3], m[4], m[5], m[6], m[7]);
  m = MDY.exec(t);
  if (m) {
    let a = +m[1];
    let b = +m[2];
    if (a > 12 && b <= 12) [a, b] = [b, a];
    return mk(+m[3], a, b, m[4], m[5], m[6], m[7]);
  }
  m = DMONY.exec(t);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    return mo ? mk(+m[3], mo, +m[1], m[4], m[5], m[6], m[7]) : NaN;
  }
  m = MONDY.exec(t);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    return mo ? mk(+m[3], mo, +m[2], m[4], m[5], m[6], m[7]) : NaN;
  }
  return NaN;
}

export function classify(v) {
  const t = clean(v);
  if (t === '') return K.EMPTY;
  const c = t.charCodeAt(0);
  if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 36 || c === 46) {
    if (!Number.isNaN(parseNum(t))) return K.NUMBER;
  }
  if (!Number.isNaN(parseDate(t))) return K.DATE;
  return K.TEXT;
}

const pad = (x) => String(x).padStart(2, '0');

export function formatDate(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds()) {
    return `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }
  return day;
}
