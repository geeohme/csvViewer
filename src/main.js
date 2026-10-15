import './styles.css';
import { $, el, n, fmtNum, bytes, DELIMS, toast, setOverlay, hideOverlay, download, safeName, csvField, createGrid } from './ui.js';
import { call } from './rpc.js';
import { renderSqlExplorer, destroySqlExplorer, resetSqlExplorer } from './sqlui.js';

// ---------- state ----------
const st = {
  s: null,
  key: null,
  sel: null,
  tab: 'data',
  filters: [],
  sort: null,
  group: null,
  grid: null,
  token: 0,
  rawJump: null,
};

const currentTable = () => st.s?.tables.find((t) => t.headerRow === st.sel) || null;

const baseName = () => (st.s?.file.name || 'export').replace(/\.[^.]+$/, '');
function readSaved() {
  try {
    return JSON.parse(localStorage.getItem(st.key) || 'null');
  } catch {
    return null;
  }
}
function persist() {
  try {
    if (!st.s.edited) localStorage.removeItem(st.key);
    else {
      const starts = st.s.tables.map((t) => ({ headerRow: t.headerRow, titleRow: t.titleRow, name: t.customName }));
      localStorage.setItem(st.key, JSON.stringify({ savedAt: Date.now(), starts }));
    }
  } catch {
    /* storage unavailable: the index still works for this session */
  }
}

// ---------- loading ----------
async function openFile(file) {
  if (!file) return;
  setOverlay('Reading file', 0);
  try {
    let s = await call('load', { file });
    st.key = `csvx:index:${file.name}:${file.size}:${file.lastModified}`;
    const saved = readSaved();
    if (saved?.starts?.length) {
      s = await call('setStarts', { starts: saved.starts });
      toast('Restored your saved parser index for this file. Use “Re-detect” to start over.');
    }
    st.s = s;
    resetSqlExplorer();
    st.sel = s.tables[0]?.headerRow ?? 'raw';
    resetTableState();
    render();
  } catch (e) {
    toast('Could not load file: ' + e.message);
  } finally {
    hideOverlay();
  }
}

function resetTableState() {
  st.filters = [];
  st.sort = null;
  st.group = null;
  st.tab = st.tab === 'raw' ? 'data' : st.tab;
}

function applySummary(s, { keepView = false } = {}) {
  st.s = s;
  persist();
  if (st.sel !== 'raw' && st.sel !== 'sql' && !currentTable()) {
    const prev = [...s.tables].reverse().find((t) => t.headerRow <= st.sel);
    st.sel = (prev || s.tables[0])?.headerRow ?? 'raw';
    resetTableState();
  }
  renderSidebar();
  renderTopbar();
  if (keepView && st.sel === 'raw') st.grid?.reload();
  else renderMain();
}

async function act(cmd, args, opts) {
  try {
    applySummary(await call(cmd, args), opts);
  } catch (e) {
    toast(e.message);
  }
}

// ---------- rendering ----------
function render() {
  renderTopbar();
  renderSidebar();
  renderMain();
}

function renderTopbar() {
  const s = st.s;
  $('#fileinfo').replaceChildren(...(s ? [el('b', {}, s.file.name), ` · ${bytes(s.file.size)}`] : []));
}

function badge(t) {
  const kind = t.manual ? 'manual' : t.confidence;
  const label = t.manual ? 'manual' : t.confidence === 'high' ? 'high confidence' : 'check this';
  return el('span', { class: `badge ${kind}`, title: t.reasons.join('\n') }, label);
}

function renderSidebar() {
  const sb = $('#sidebar');
  const s = st.s;
  if (!s) {
    sb.replaceChildren(
      el('div', { class: 'sb-empty' }, 'Open a CSV dump to build its parser index. The file is processed entirely inside this browser tab — nothing is uploaded.'),
    );
    return;
  }
  const importInput = el('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: (e) => importIndex(e.target.files[0]) });
  const out = [
    el('div', { class: 'sb-title' }, 'Parser index'),
    el('div', { class: 'sb-meta' }, `${s.tables.length} tables · ${n(s.totalRecords)} records · ${n(s.totalLines)} lines · ${DELIMS[s.delimiter] || s.delimiter}-delimited`),
    el(
      'div',
      { class: 'sb-actions' },
      el('button', { class: 'btn small', onclick: exportIndexJSON, title: 'Download the index (table start lines, columns) as JSON — can be re-imported later' }, 'Export JSON'),
      el('button', { class: 'btn small', onclick: exportIndexCSV }, 'Export CSV'),
      el('button', { class: 'btn small', onclick: () => importInput.click() }, 'Import…'),
      s.edited ? el('button', { class: 'btn small', onclick: () => act('resetAuto'), title: 'Discard manual edits and use automatic detection' }, 'Re-detect') : null,
      importInput,
    ),
  ];
  if (s.edited) out.push(el('div', { class: 'sb-note' }, 'Index edited by hand — your edits are saved in this browser for this file.'));
  if (s.preamble) out.push(el('div', { class: 'sb-note' }, `${n(s.preamble)} non-blank row(s) before the first table are not part of any table.`));

  out.push(
    el(
      'button',
      { class: 'tbl-item' + (st.sel === 'raw' ? ' active' : ''), onclick: () => select('raw') },
      el('div', { class: 'tbl-row1' }, el('span', { class: 'tbl-num' }, '≡'), el('span', { class: 'tbl-name' }, 'Raw rows (whole file)')),
      el('div', { class: 'tbl-row2' }, 'Inspect boundaries, split or merge tables'),
    ),
  );
  out.push(
    el(
      'button',
      { class: 'tbl-item' + (st.sel === 'sql' ? ' active' : ''), onclick: () => select('sql') },
      el('div', { class: 'tbl-row1' }, el('span', { class: 'tbl-num' }, '⋈'), el('span', { class: 'tbl-name' }, 'SQL Explorer')),
      el('div', { class: 'tbl-row2' }, 'Relate tables, build queries, write SQL'),
    ),
  );
  out.push(el('div', { class: 'sb-title' }, 'Tables'));
  for (const t of s.tables) {
    out.push(
      el(
        'button',
        { class: 'tbl-item' + (st.sel === t.headerRow ? ' active' : ''), onclick: () => select(t.headerRow) },
        el('div', { class: 'tbl-row1' }, el('span', { class: 'tbl-num' }, `#${t.id + 1}`), el('span', { class: 'tbl-name' }, t.name), badge(t)),
        el('div', { class: 'tbl-row2' }, `starts line ${n(t.titleLine ?? t.headerLine)} · ${n(t.rowCount)} rows · ${t.columns.length} cols`),
      ),
    );
  }
  if (s.suspects.length) {
    const det = el('details', { open: s.suspects.length <= 5 }, el('summary', { class: 'sb-title' }, `Possible headers not split (${s.suspects.length})`));
    det.append(el('div', { class: 'sb-meta' }, 'Rows that look like a header but scored too low to start a table automatically.'));
    for (const x of s.suspects.slice(0, 200)) {
      det.append(
        el(
          'div',
          { class: 'suspect' },
          el(
            'div',
            { class: 's-head' },
            el('span', { class: 's-line' }, `line ${n(x.line)}`),
            el('button', { class: 'btn link', onclick: () => gotoRaw(x.row) }, 'Show'),
            el('button', { class: 'btn small', onclick: () => act('addStart', { row: x.row }) }, 'Split here'),
          ),
          el('div', { class: 's-prev', title: x.preview }, x.preview),
          el('div', { class: 's-why' }, x.reasons.join('; ')),
        ),
      );
    }
    out.push(det);
  }
  sb.replaceChildren(...out);
}

function select(sel) {
  if (st.sel === sel) return;
  st.sel = sel;
  resetTableState();
  renderSidebar();
  renderMain();
}

function gotoRaw(rec) {
  st.rawJump = rec;
  st.sel = 'raw';
  renderSidebar();
  renderMain();
}

function renderMain() {
  st.token++;
  st.grid?.destroy();
  st.grid = null;
  destroySqlExplorer();
  const main = $('#main');
  if (!st.s) return main.replaceChildren(emptyState());
  if (st.sel === 'raw') return renderRaw();
  if (st.sel === 'sql') return renderSqlExplorer(main, { fileKey: st.key, baseName: baseName() });
  const t = currentTable();
  if (!t) return main.replaceChildren(el('div', { class: 'empty' }, el('h2', {}, 'No tables'), el('p', {}, 'Use Raw rows to mark where tables start.')));
  renderTable(t);
}

function emptyState() {
  return el(
    'div',
    { class: 'empty' },
    el('h2', {}, 'Open a CSV dump'),
    el('p', {}, 'Drag a .csv file anywhere onto this window, or use “Open CSV…”.'),
    el('p', {}, 'The file is split into tables wherever a new header row appears, and you get a parser index of where each table starts.'),
    el('p', {}, el('button', { class: 'btn', onclick: loadSample }, 'Try the generated sample dump')),
  );
}

async function loadSample() {
  try {
    const res = await fetch('/sample-data/customer-dump.csv');
    if (!res.ok || (res.headers.get('content-type') || '').includes('html')) throw new Error();
    const blob = await res.blob();
    openFile(new File([blob], 'customer-dump.csv', { type: 'text/csv', lastModified: 1 }));
  } catch {
    toast('No sample found. Run “npm run sample” in the project folder first.');
  }
}

// ---------- table view ----------
const OPS = [
  ['contains', 'contains'],
  ['eq', '='],
  ['neq', '≠'],
  ['gt', '>'],
  ['gte', '≥'],
  ['lt', '<'],
  ['lte', '≤'],
  ['starts', 'starts with'],
  ['notcontains', 'does not contain'],
  ['in', 'is one of (a, b, c)'],
  ['empty', 'is empty'],
  ['notempty', 'is not empty'],
];
const NO_VALUE = new Set(['empty', 'notempty']);
const TYPE_SHORT = { number: '#', date: 'date', text: 'abc', empty: '∅' };

const activeFilters = () =>
  st.filters.filter((f) => NO_VALUE.has(f.op) || String(f.value).trim() !== '').map(({ col, op, value }) => ({ col, op, value }));

function renderTable(t) {
  const fact = (k, v) => el('span', {}, `${k} `, el('b', {}, v));
  const nameInput = el('input', {
    class: 'name-input',
    value: t.name,
    title: 'Rename table',
    size: Math.max(8, t.name.length + 2),
    onchange: (e) => act('rename', { row: t.headerRow, name: e.target.value }),
    onkeydown: (e) => e.key === 'Enter' && e.target.blur(),
  });
  const head = el(
    'div',
    { class: 'thead' },
    el(
      'div',
      { class: 'thead-row' },
      nameInput,
      badge(t),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn small', onclick: () => gotoRaw(t.titleRow ?? t.headerRow) }, 'Show in raw rows'),
      t.id > 0
        ? el(
            'button',
            { class: 'btn small danger', title: 'Treat this header row as an ordinary row of the previous table', onclick: () => act('removeStart', { row: t.headerRow }) },
            'Merge into previous',
          )
        : null,
    ),
    el(
      'div',
      { class: 'facts' },
      t.titleLine ? fact('Title line', n(t.titleLine)) : null,
      fact('Header line', n(t.headerLine)),
      fact('Data lines', t.firstLine ? `${n(t.firstLine)} – ${n(t.lastLine)}` : '—'),
      fact('Rows', n(t.rowCount)),
      fact('Columns', String(t.columns.length)),
    ),
    el('div', { class: 'why' }, t.manual ? 'Table start added by hand.' : `Detected because: ${t.reasons.join('; ')}.`),
  );
  const tabs = el(
    'div',
    { class: 'tabs' },
    ...[
      ['data', 'Data'],
      ['columns', 'Column stats'],
      ['group', 'Group by / counts'],
    ].map(([k, label]) =>
      el(
        'button',
        {
          class: 'tab' + (st.tab === k ? ' active' : ''),
          onclick: (e) => {
            st.tab = k;
            for (const b of tabs.querySelectorAll('.tab')) b.classList.toggle('active', b === e.currentTarget);
            refreshPanel();
          },
        },
        label,
      ),
    ),
    el('div', { class: 'tab-actions' }, el('button', { class: 'btn small', onclick: () => exportTable(t), title: 'Download the rows that match the current filters and sort' }, 'Export rows (CSV)')),
  );
  $('#main').replaceChildren(head, el('div', { class: 'filterbar', id: 'filterbar' }), tabs, el('div', { class: 'panel', id: 'panel' }));
  renderFilterBar(t);
  refreshPanel();
}

let filterTimer;
function onFiltersChanged(debounce) {
  clearTimeout(filterTimer);
  if (debounce) filterTimer = setTimeout(refreshPanel, 280);
  else refreshPanel();
}

function renderFilterBar(t) {
  const fb = $('#filterbar');
  const placeholder = (type) => (type === 'number' ? 'e.g. 100' : type === 'date' ? 'YYYY-MM-DD' : 'value');
  const kids = st.filters.map((f, i) =>
    el(
      'div',
      { class: 'filter' },
      el(
        'select',
        {
          'aria-label': 'Column',
          onchange: (e) => {
            f.col = +e.target.value;
            renderFilterBar(t);
            onFiltersChanged();
          },
        },
        t.columns.map((c, ci) => el('option', { value: ci, selected: ci === f.col }, c.name)),
      ),
      el(
        'select',
        {
          'aria-label': 'Operator',
          onchange: (e) => {
            f.op = e.target.value;
            renderFilterBar(t);
            onFiltersChanged();
          },
        },
        OPS.map(([v, l]) => el('option', { value: v, selected: v === f.op }, l)),
      ),
      NO_VALUE.has(f.op)
        ? null
        : el('input', {
            'aria-label': 'Value',
            value: f.value,
            placeholder: placeholder(t.columns[f.col].type),
            oninput: (e) => {
              f.value = e.target.value;
              onFiltersChanged(true);
            },
          }),
      el(
        'button',
        {
          class: 'x',
          title: 'Remove filter',
          onclick: () => {
            st.filters.splice(i, 1);
            renderFilterBar(t);
            onFiltersChanged();
          },
        },
        '×',
      ),
    ),
  );
  const parts = [
    ...kids,
    el(
      'button',
      {
        class: 'btn small',
        onclick: () => {
          st.filters.push({ col: 0, op: 'contains', value: '' });
          renderFilterBar(t);
          fb.querySelector('.filter:last-of-type input')?.focus();
        },
      },
      '+ Filter',
    ),
    st.filters.length
      ? el(
          'button',
          {
            class: 'btn link',
            onclick: () => {
              st.filters = [];
              renderFilterBar(t);
              onFiltersChanged();
            },
          },
          'Clear filters',
        )
      : null,
    el('div', { class: 'match', id: 'match' }),
  ];
  fb.replaceChildren(...parts.filter(Boolean));
}

function setMatch(total, t) {
  const m = $('#match');
  if (!m) return;
  m.replaceChildren(el('b', {}, n(total)), total === t.rowCount ? ' rows' : ` of ${n(t.rowCount)} rows match`);
}

function refreshPanel() {
  const t = currentTable();
  if (!t) return;
  st.token++;
  st.grid?.destroy();
  st.grid = null;
  if (st.tab === 'columns') renderStats(t);
  else if (st.tab === 'group') renderGroup(t);
  else renderData(t);
}

async function renderData(t) {
  const my = st.token;
  const filters = activeFilters();
  const sort = st.sort;
  let first;
  try {
    first = await call('getRows', { table: t.id, filters, sort, offset: 0, limit: 200 });
  } catch (e) {
    return toast(e.message);
  }
  if (my !== st.token) return;
  setMatch(first.total, t);
  const panel = $('#panel');
  const lineW = Math.max(56, String(st.s.totalLines).length * 8 + 20);
  const columns = [
    { label: 'Line', width: lineW, cls: 'gutter', title: 'File line number', get: (r) => String(r.line) },
    ...t.columns.map((c, ci) => ({
      head: el(
        'span',
        {},
        c.name,
        el('span', { class: 'ty' }, TYPE_SHORT[c.type]),
        sort?.col === ci ? el('span', { class: 'arrow' }, sort.dir === 'asc' ? ' ▲' : ' ▼') : null,
      ),
      title: `${c.name} (${c.type}) — click to sort`,
      width: c.width,
      cls: c.type === 'number' ? 'num' : '',
      get: (r) => r.cells[ci],
    })),
  ];
  st.grid = createGrid(panel, {
    columns,
    total: first.total,
    firstPage: first.rows,
    fetchPage: (offset, limit) => call('getRows', { table: t.id, filters, sort, offset, limit }).then((r) => r.rows),
    onHeaderClick: (i) => {
      if (i === 0) return;
      const col = i - 1;
      st.sort = st.sort?.col !== col ? { col, dir: 'asc' } : st.sort.dir === 'asc' ? { col, dir: 'desc' } : null;
      refreshPanel();
    },
  });
  if (!first.total) panel.append(el('div', { class: 'loading' }, 'No rows match the current filters.'));
}

async function renderStats(t) {
  const my = st.token;
  const panel = $('#panel');
  panel.replaceChildren(el('div', { class: 'loading' }, 'Computing column statistics…'));
  let res;
  try {
    res = await call('stats', { table: t.id, filters: activeFilters() });
  } catch (e) {
    return toast(e.message);
  }
  if (my !== st.token) return;
  setMatch(res.total, t);

  const dateCols = res.columns.filter((c) => c.type === 'date' && c.min);
  const cards = el(
    'div',
    { class: 'summary-cards' },
    el('div', { class: 'card' }, el('div', { class: 'k' }, 'Rows (count)'), el('div', { class: 'val' }, n(res.total))),
    el('div', { class: 'card' }, el('div', { class: 'k' }, 'Columns'), el('div', { class: 'val' }, String(res.columns.length))),
    ...dateCols.slice(0, 3).map((c) =>
      el('div', { class: 'card' }, el('div', { class: 'k' }, `${c.name} range`), el('div', { class: 'val', style: { fontSize: '14px' } }, `${c.min.slice(0, 10)} → ${c.max.slice(0, 10)}`)),
    ),
  );

  const range = (c) => {
    if (c.type === 'date' && c.spanDays != null) return `${n(c.spanDays)} days${c.spanDays > 365 ? ` (${(c.spanDays / 365.25).toFixed(1)} yrs)` : ''}`;
    if (c.type === 'number' && c.min != null) return fmtNum(c.max - c.min);
    if (c.minLen != null) return `length ${c.minLen}–${c.maxLen}`;
    return '';
  };
  const mm = (c, v) => (c.type === 'number' ? fmtNum(v) : v ?? '');
  const head = ['Column', 'Type', 'Filled', 'Empty', 'Distinct', 'Min', 'Max', 'Range', 'Mean', 'Median', 'Sum', 'Most common values'];
  const tbl = el(
    'table',
    { class: 'stbl' },
    el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))),
    el(
      'tbody',
      {},
      res.columns.map((c, ci) =>
        el(
          'tr',
          {},
          el(
            'td',
            {},
            el(
              'button',
              {
                class: 'btn link',
                title: 'Count rows by this column',
                onclick: () => {
                  st.group = { ...defaultGroup(t), keys: [{ col: ci, gran: 'month' }] };
                  st.tab = 'group';
                  renderTable(t);
                },
              },
              c.name,
            ),
          ),
          el('td', {}, el('span', { class: `tag ${c.type}` }, c.type), c.invalid ? el('div', { class: 'hint' }, `${n(c.invalid)} unparseable`) : null),
          el('td', { class: 'n' }, n(c.filled)),
          el('td', { class: 'n' }, n(c.empty)),
          el('td', { class: 'n' }, n(c.distinct)),
          el('td', { class: c.type === 'number' ? 'n' : 'v', title: String(c.min ?? '') }, mm(c, c.min)),
          el('td', { class: c.type === 'number' ? 'n' : 'v', title: String(c.max ?? '') }, mm(c, c.max)),
          el('td', { class: 'n' }, range(c)),
          el('td', { class: 'n' }, fmtNum(c.mean)),
          el('td', { class: 'n' }, fmtNum(c.median)),
          el('td', { class: 'n' }, fmtNum(c.sum)),
          el(
            'td',
            { class: 'top' },
            c.distinct === c.filled && c.filled > 5
              ? 'all values unique'
              : c.top.map((x, i) => [i ? ', ' : '', el('span', {}, x.value.length > 40 ? x.value.slice(0, 40) + '…' : x.value), ` (${n(x.count)})`]),
          ),
        ),
      ),
    ),
  );
  panel.replaceChildren(
    el(
      'div',
      { class: 'panel-scroll' },
      cards,
      tbl,
      el('p', { class: 'hint' }, 'Stats reflect the current filters. Empty includes blank, NULL, \\N and N/A. Text min/max are alphabetical. Slashed dates are read as month/day/year. Click a column name to count rows by its values.'),
    ),
  );
}

function defaultGroup(t) {
  const cols = t.columns;
  const dateCol = cols.findIndex((c) => c.type === 'date');
  const textCol = cols.findIndex((c, i) => c.type === 'text' && i > 0);
  const isNum = (c) => c.type === 'number';
  let numCol = cols.findIndex((c) => isNum(c) && !/(^|_|\b)(id|key)$/i.test(c.name));
  if (numCol < 0) numCol = cols.findIndex((c, i) => isNum(c) && i > 0);
  return {
    keys: [{ col: textCol >= 0 ? textCol : dateCol >= 0 ? dateCol : 0, gran: 'month' }],
    aggFn: '',
    aggCol: numCol >= 0 ? numCol : null,
    order: 'count',
  };
}

const GRANS = [['year', 'year'], ['month', 'month'], ['day', 'day'], ['exact', 'exact value']];

async function renderGroup(t) {
  const my = st.token;
  const g = (st.group ||= defaultGroup(t));
  const panel = $('#panel');
  const measurable = t.columns.map((c, i) => [c, i]).filter(([c]) => c.type === 'number' || c.type === 'date');
  if (g.aggCol == null || !measurable.some(([, i]) => i === g.aggCol)) g.aggCol = measurable[0]?.[1] ?? null;
  const upd = (patch) => {
    Object.assign(g, patch);
    refreshPanel();
  };
  const select = (value, options, onchange, label) =>
    el('select', { 'aria-label': label, onchange: (e) => onchange(e.target.value) }, options.map(([v, l]) => el('option', { value: v, selected: String(v) === String(value) }, l)));
  const sel = (label, value, options, onchange) => el('label', {}, label + ' ', select(value, options, onchange, label));
  const colOptions = t.columns.map((c, i) => [i, c.name]);
  const isDateKey = (k) => t.columns[k.col]?.type === 'date';

  const keyChips = g.keys.map((k, ki) =>
    el(
      'span',
      { class: 'filter' },
      ki ? el('span', { class: 'then' }, 'then') : null,
      select(k.col, colOptions, (v) => {
        k.col = +v;
        refreshPanel();
      }, `Group field ${ki + 1}`),
      isDateKey(k) ? select(k.gran, GRANS, (v) => {
        k.gran = v;
        refreshPanel();
      }, `Date grouping ${ki + 1}`) : null,
      g.keys.length > 1
        ? el('button', { class: 'x', title: 'Remove this field', onclick: () => upd({ keys: g.keys.filter((_, j) => j !== ki) }) }, '×')
        : null,
    ),
  );
  const unused = t.columns.findIndex((_, i) => !g.keys.some((k) => k.col === i));
  const controls = el(
    'div',
    { class: 'ctl-stack' },
    el(
      'div',
      { class: 'ctl' },
      el('label', {}, 'Group by'),
      ...keyChips,
      unused >= 0 && g.keys.length < 6
        ? el('button', { class: 'btn small', title: 'Break each group down by another field', onclick: () => upd({ keys: [...g.keys, { col: unused, gran: 'month' }] }) }, '+ Add field')
        : null,
    ),
    el(
      'div',
      { class: 'ctl' },
      sel('Measure', g.aggFn, [['', 'count only'], ['sum', 'sum of'], ['avg', 'average of'], ['min', 'min of'], ['max', 'max of']], (v) => upd({ aggFn: v })),
      g.aggFn && measurable.length ? select(g.aggCol, measurable.map(([c, i]) => [i, c.name]), (v) => upd({ aggCol: +v }), 'Measure column') : null,
      sel('Sort', g.order, [['count', 'by count ↓'], ['key', 'by value ↑'], ...(g.aggFn ? [['agg', 'by measure ↓']] : [])], (v) => upd({ order: v })),
    ),
  );
  panel.replaceChildren(el('div', { class: 'panel-scroll' }, controls, el('div', { class: 'loading' }, 'Counting…')));

  let res;
  try {
    res = await call('groupBy', {
      table: t.id,
      filters: activeFilters(),
      keys: g.keys.map((k) => ({ col: k.col, gran: isDateKey(k) ? k.gran : null })),
      aggFn: g.aggFn || null,
      aggCol: g.aggFn ? g.aggCol : null,
      order: g.order,
    });
  } catch (e) {
    return toast(e.message);
  }
  if (my !== st.token) return;
  setMatch(res.total, t);
  const maxCount = res.groups.reduce((m, x) => Math.max(m, x.count), 1);
  const aggLabel = g.aggFn ? `${{ sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max' }[g.aggFn]} of ${t.columns[g.aggCol]?.name}` : null;
  const keyLabels = g.keys.map((k) => t.columns[k.col].name + (isDateKey(k) && k.gran !== 'exact' ? ` (${k.gran})` : ''));
  const exportBtn = el(
    'button',
    {
      class: 'btn small',
      onclick: () => {
        const lines = [[...keyLabels, 'count', 'percent', ...(aggLabel ? [aggLabel] : [])].map(csvField).join(',')];
        for (const x of res.groups) lines.push([...x.keys, x.count, ((x.count / res.total) * 100).toFixed(2), ...(aggLabel ? [x.agg ?? ''] : [])].map(csvField).join(','));
        const by = g.keys.map((k) => safeName(t.columns[k.col].name)).join('_');
        download(`${safeName(baseName())}_${safeName(t.name)}_by_${by}.csv`, lines.join('\n') + '\n');
      },
    },
    'Export counts (CSV)',
  );
  // When sorted by value, repeated leading values are dimmed so nested groups read as a tree.
  const dimRepeats = g.order === 'key' && g.keys.length > 1;
  const tbl = el(
    'table',
    { class: 'stbl' },
    el('thead', {}, el('tr', {}, keyLabels.map((l) => el('th', {}, l)), el('th', {}, 'Count'), el('th', {}, '% of rows'), aggLabel ? el('th', {}, aggLabel) : null)),
    el(
      'tbody',
      {},
      res.groups.map((x, gi) => {
        const prev = res.groups[gi - 1];
        let same = dimRepeats && !!prev;
        return el(
          'tr',
          {},
          x.keys.map((v, k) => {
            same = same && k < x.keys.length - 1 && prev.keys[k] === v;
            return el('td', { class: 'v' + (same ? ' dim' : ''), title: v }, v);
          }),
          el('td', { class: 'n' }, n(x.count)),
          el('td', {}, el('div', { class: 'barcell' }, el('div', { class: 'b', style: { width: `${Math.max(1, (x.count / maxCount) * 160)}px` } }), `${((x.count / res.total) * 100).toFixed(1)}%`)),
          aggLabel ? el('td', { class: 'n' }, typeof x.agg === 'number' ? fmtNum(x.agg) : x.agg ?? '') : null,
        );
      }),
    ),
  );
  panel.replaceChildren(
    el(
      'div',
      { class: 'panel-scroll' },
      controls,
      el('div', { class: 'ctl' }, el('span', {}, el('b', {}, n(res.totalGroups)), g.keys.length > 1 ? ' distinct combinations' : ' distinct values'), exportBtn),
      res.totalGroups > res.groups.length ? el('p', { class: 'hint' }, `Showing the first ${n(res.groups.length)} groups. Export includes the same rows.`) : null,
      tbl,
    ),
  );
}

async function exportTable(t) {
  try {
    const csv = await call('exportTable', { table: t.id, filters: activeFilters(), sort: st.sort });
    download(`${safeName(baseName())}_${safeName(t.name)}.csv`, csv);
  } catch (e) {
    toast(e.message);
  }
}

// ---------- raw view ----------
function renderRaw() {
  const s = st.s;
  const lineInput = el('input', { type: 'number', min: 1, max: s.totalLines, placeholder: 'line #', 'aria-label': 'Line number' });
  const go = async () => {
    const line = parseInt(lineInput.value, 10);
    if (!line) return;
    const rec = await call('lineToRecord', { line });
    st.grid?.scrollToRow(rec, true);
  };
  lineInput.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  const tools = el(
    'div',
    { class: 'raw-tools' },
    el('b', {}, 'Raw rows'),
    el('span', { class: 'hint', style: { margin: 0 } }, 'Click the “Table” cell of a row to start a new table there; click a table marker to merge it into the table above.'),
    el('span', {}, 'Go to line ', lineInput, ' ', el('button', { class: 'btn small', onclick: go }, 'Go')),
    el('div', { class: 'legend' }, el('span', { class: 'l-h' }, 'header row'), el('span', { class: 'l-t' }, 'title row'), el('span', { class: 'l-s' }, 'possible header')),
  );
  const panel = el('div', { class: 'panel' });
  $('#main').replaceChildren(tools, panel);
  const lineW = Math.max(56, String(s.totalLines).length * 8 + 20);
  const columns = [
    { label: 'Line', width: lineW, cls: 'gutter', get: (r) => String(r.line) },
    {
      label: 'Table',
      width: 86,
      cls: 'marker',
      get: (r) => (r.mark?.kind === 'header' ? `▶ #${r.mark.table + 1}` : r.mark?.kind === 'title' ? 'title' : r.mark?.kind === 'blank' ? '' : '+ split'),
    },
    ...Array.from({ length: s.maxWidth }, (_, c) => ({ label: String(c + 1), width: 130, get: (r) => r.cells[c] })),
  ];
  const rowCls = (r) => ({ header: 'r-header', title: 'r-title', suspect: 'r-suspect' })[r.mark?.kind] || '';
  st.grid = createGrid(panel, {
    columns,
    total: s.totalRecords,
    fetchPage: (offset, limit) => call('getRaw', { offset, limit }).then((r) => r.rows),
    rowCls,
    onCellClick: (r, ci) => {
      if (ci !== 1) return;
      const kind = r.mark?.kind;
      if (kind === 'blank') return toast('A blank row can’t be a header.');
      if (kind === 'title') return toast('This is the title row of the table below it.');
      if (kind === 'header') {
        act('removeStart', { row: r.rec }, { keepView: true });
        toast(`Table at line ${n(r.line)} merged into the table above. Click “+ split” on that row to undo.`);
      } else {
        act('addStart', { row: r.rec }, { keepView: true });
        toast(`New table starts at line ${n(r.line)}.`);
      }
    },
  });
  if (st.rawJump != null) {
    const rec = st.rawJump;
    st.rawJump = null;
    requestAnimationFrame(() => st.grid?.scrollToRow(rec, true));
  }
}

// ---------- index import / export ----------
async function exportIndexJSON() {
  const idx = await call('exportIndex');
  download(`${safeName(baseName())}.index.json`, JSON.stringify(idx, null, 2), 'application/json');
}

async function exportIndexCSV() {
  const idx = await call('exportIndex');
  const head = ['table', 'name', 'title_line', 'header_line', 'first_data_line', 'last_data_line', 'header_record', 'row_count', 'column_count', 'detection', 'columns'];
  const lines = [head.join(',')];
  for (const t of idx.tables) {
    lines.push(
      [t.table, t.name, t.titleLine ?? '', t.headerLine, t.firstDataLine ?? '', t.lastDataLine ?? '', t.headerRecord, t.rowCount, t.columnCount, t.detection, t.columns.map((c) => c.name).join(' | ')]
        .map(csvField)
        .join(','),
    );
  }
  download(`${safeName(baseName())}.index.csv`, lines.join('\n') + '\n');
}

async function importIndex(file) {
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    if (!Array.isArray(obj.tables)) throw new Error('not a parser index file');
    const starts = obj.tables
      .filter((t) => Number.isInteger(t.headerRecord))
      .map((t) => ({ headerRow: t.headerRecord - 1, titleRow: Number.isInteger(t.titleRecord) ? t.titleRecord - 1 : null, name: t.name }));
    if (!starts.length) throw new Error('index has no tables');
    await act('setStarts', { starts });
    const note = obj.file?.name && obj.file.name !== st.s.file.name ? ` (it was made for “${obj.file.name}”)` : '';
    toast(`Imported index with ${starts.length} tables${note}.`);
  } catch (e) {
    toast('Could not import index: ' + e.message);
  }
}

// ---------- wiring ----------
$('#btn-open').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => {
  openFile(e.target.files[0]);
  e.target.value = '';
});
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth++;
  $('#drop-hint').hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('#drop-hint').hidden = true;
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-hint').hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});

render();
