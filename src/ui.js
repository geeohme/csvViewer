export const $ = (s) => document.querySelector(s);

export function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid instanceof Node ? kid : String(kid));
  return e;
}

export const nf = new Intl.NumberFormat();
export const n = (x) => nf.format(x);
export const fmtNum = (x) => (x == null ? '' : Number.isInteger(x) ? n(x) : x.toLocaleString(undefined, { maximumFractionDigits: 2 }));
export const bytes = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.ceil(b / 1e3)} KB`);
export const DELIMS = { ',': 'comma', '\t': 'tab', ';': 'semicolon', '|': 'pipe' };

// ---------- small UI helpers ----------
let toastTimer;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4200);
}
export function setOverlay(stage, frac) {
  $('#overlay').hidden = false;
  $('#overlay-stage').textContent = stage + '…';
  $('#overlay-bar').style.width = `${Math.round((frac || 0) * 100)}%`;
}
export const hideOverlay = () => ($('#overlay').hidden = true);

export function download(name, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export const safeName = (s) => s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'table';
export const csvField = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};


// ---------- virtual grid ----------
export function createGrid(host, { columns, total, firstPage, fetchPage, onHeaderClick, onCellClick, rowCls }) {
  const RH = 26;
  const PAGE = 200;
  const totalW = columns.reduce((a, c) => a + c.width, 0);
  const scroller = el('div', { class: 'grid-scroll' });
  const inner = el('div', { class: 'grid-inner', style: { width: totalW + 'px' } });
  const head = el('div', { class: 'grid-head', style: { width: totalW + 'px' } });
  const body = el('div', { class: 'grid-body', style: { height: total * RH + 'px', width: totalW + 'px' } });
  columns.forEach((c, i) => {
    const h = el('div', { class: `gcell hcell ${c.cls || ''}`, style: { width: c.width + 'px' }, title: c.title || null }, c.head ?? c.label);
    if (onHeaderClick) h.addEventListener('click', () => onHeaderClick(i));
    head.append(h);
  });
  inner.append(head, body);
  scroller.append(inner);
  host.replaceChildren(scroller);

  const pages = new Map();
  if (firstPage) pages.set(0, firstPage);
  let highlight = -1;
  let raf = 0;
  let dead = false;
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(() => ((raf = 0), render()));
  };
  function load(p) {
    pages.set(p, null);
    fetchPage(p * PAGE, PAGE).then(
      (rows) => {
        if (dead) return;
        pages.set(p, rows);
        schedule();
      },
      (err) => !dead && toast(err.message),
    );
  }
  function render() {
    if (dead) return;
    const top = scroller.scrollTop;
    const h = scroller.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / RH) - 8);
    const last = Math.min(total, Math.ceil((top + h) / RH) + 8);
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const p = Math.floor(i / PAGE);
      if (!pages.has(p)) load(p);
      const ro = pages.get(p)?.[i - p * PAGE] || null;
      const r = document.createElement('div');
      let cls = 'grow' + (i % 2 ? ' odd' : '');
      if (!ro) cls += ' loading-row';
      else if (rowCls) cls += ' ' + rowCls(ro);
      if (i === highlight) cls += ' flash';
      r.className = cls;
      r.style.transform = `translateY(${i * RH}px)`;
      r.style.width = totalW + 'px';
      r._ro = ro;
      for (const col of columns) {
        const cell = document.createElement('div');
        cell.className = 'gcell ' + (col.cls || '');
        cell.style.width = col.width + 'px';
        const v = ro ? col.get(ro) : '';
        cell.textContent = v;
        if (v && v.length > 10) cell.title = v;
        r.append(cell);
      }
      frag.append(r);
    }
    body.replaceChildren(frag);
  }
  scroller.addEventListener('scroll', schedule, { passive: true });
  if (onCellClick) {
    body.addEventListener('click', (e) => {
      const cell = e.target.closest('.gcell');
      const row = cell?.parentElement;
      if (row?._ro) onCellClick(row._ro, [...row.children].indexOf(cell));
    });
  }
  new ResizeObserver(schedule).observe(scroller);
  schedule();
  return {
    scrollToRow(i, flash) {
      scroller.scrollTop = Math.max(0, i * RH - scroller.clientHeight / 3);
      highlight = flash ? i : -1;
      schedule();
    },
    reload() {
      pages.clear();
      schedule();
    },
    destroy() {
      dead = true;
    },
  };
}

