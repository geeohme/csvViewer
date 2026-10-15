import { el, n, toast, download, safeName, createGrid, hideOverlay } from './ui.js';
import { call } from './rpc.js';
import { buildSQL, fieldLabel, AGG_LABELS } from './sqlbuild.js';

const CARD_W = 220;
const HEAD_H = 36;
const ROW_H = 22;
const TYPE_SHORT = { number: '#', date: 'date', text: 'abc', empty: '∅' };
const OPS = [
  ['eq', '='],
  ['neq', '≠'],
  ['gt', '>'],
  ['gte', '≥'],
  ['lt', '<'],
  ['lte', '≤'],
  ['contains', 'contains'],
  ['notcontains', 'does not contain'],
  ['starts', 'starts with'],
  ['in', 'is one of (a, b, c)'],
  ['empty', 'is empty'],
  ['notempty', 'is not empty'],
];

let X = null;
let grids = [];
let host = null;

export function resetSqlExplorer() {
  X = null;
}

export function destroySqlExplorer() {
  for (const g of grids) g.destroy();
  grids = [];
}

const relKey = (r) => `${r.from.table}.${r.from.col}>${r.to.table}.${r.to.col}`;

function save() {
  try {
    localStorage.setItem(X.key, JSON.stringify({ rels: X.rels, pos: X.pos, spec: X.spec, sql: X.sql, sub: X.sub }));
  } catch {
    /* storage unavailable */
  }
}

function hasCol(table, col) {
  return !!X.schema.find((t) => t.name === table)?.columns.some((c) => c.name === col);
}

function colInfo(table, col) {
  return X.schema.find((t) => t.name === table)?.columns.find((c) => c.name === col);
}

function sanitize() {
  X.rels = X.rels.filter((r) => hasCol(r.from.table, r.from.col) && hasCol(r.to.table, r.to.col));
  const s = X.spec;
  if (s.base && !X.schema.some((t) => t.name === s.base)) s.base = '';
  s.fields = s.fields.filter((f) => f.kind === 'count' || hasCol(f.table, f.col));
  s.filters = s.filters.filter((f) => !f.table || hasCol(f.table, f.col));
  s.sort = s.sort.filter((x) => x.field < s.fields.length);
}

export async function renderSqlExplorer(target, { fileKey, baseName }) {
  host = target;
  destroySqlExplorer();
  host.replaceChildren(el('div', { class: 'loading' }, 'Loading tables into SQLite…'));
  let init;
  try {
    init = await call('sqlInit');
  } catch (e) {
    host.replaceChildren(el('div', { class: 'loading' }, 'Could not start SQLite: ' + e.message));
    return;
  } finally {
    hideOverlay();
  }
  const key = `csvx:sql:${fileKey}`;
  if (!X || X.key !== key || init.fresh) {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(key) || 'null');
    } catch {
      saved = null;
    }
    X = {
      key,
      baseName,
      schema: init.schema,
      autoRels: init.autoRels,
      ms: init.ms,
      rels: saved?.rels ?? init.autoRels.map((r) => ({ ...r })),
      pos: saved?.pos ?? {},
      spec: saved?.spec ?? { base: '', fields: [], filters: [], sort: [], limit: 1000 },
      sql: saved?.sql ?? '',
      sub: saved?.sub ?? 'model',
      results: {},
    };
    sanitize();
    if (!X.sql && X.schema[0]) X.sql = `SELECT *\nFROM ${X.schema[0].name}\nLIMIT 100;`;
  }
  X.schema = init.schema;
  X.autoRels = init.autoRels;
  renderShell();
}

function renderShell() {
  destroySqlExplorer();
  const tabs = [
    ['model', 'Data model'],
    ['builder', 'Query builder'],
    ['sql', 'SQL editor'],
  ];
  const bar = el(
    'div',
    { class: 'sx-bar' },
    el('b', {}, 'SQL Explorer'),
    el(
      'div',
      { class: 'sx-tabs' },
      tabs.map(([k, label]) =>
        el(
          'button',
          {
            class: 'tab' + (X.sub === k ? ' active' : ''),
            onclick: () => {
              X.sub = k;
              save();
              renderShell();
            },
          },
          label,
        ),
      ),
    ),
    el('div', { class: 'spacer' }),
    el('span', { class: 'hint', style: { margin: 0 } }, `${X.schema.length} tables in SQLite (in this browser) · loaded in ${n(X.ms)} ms`),
    el(
      'button',
      {
        class: 'btn small',
        title: 'Rebuild the SQLite copy from the parsed tables (discards any tables or views you created)',
        onclick: async () => {
          await call('sqlInit', { force: true });
          hideOverlay();
          X.results = {};
          renderShell();
          toast('SQLite data reloaded.');
        },
      },
      'Reload data',
    ),
  );
  const body = el('div', { class: 'sx-body' });
  host.replaceChildren(bar, body);
  if (X.sub === 'builder') renderBuilder(body);
  else if (X.sub === 'sql') renderEditor(body);
  else renderModel(body);
}

// ---------- shared pieces ----------

function schemaPanel(onColumn, onTable) {
  return el(
    'div',
    { class: 'sx-schema' },
    el('div', { class: 'sb-title' }, 'Tables & columns'),
    X.schema.map((t) =>
      el(
        'details',
        { class: 'sx-t', open: true },
        el(
          'summary',
          {},
          el('span', { class: 'sx-tname', title: `Table “${t.label}” — click to insert`, onclick: onTable ? (e) => (e.preventDefault(), onTable(t)) : null }, t.name),
          el('span', { class: 'sx-rows' }, n(t.rowCount)),
        ),
        t.columns.map((c) =>
          el(
            'button',
            { class: 'sx-col', title: `${t.name}.${c.name}${c.source !== c.name ? ` (CSV column “${c.source}”)` : ''} — ${c.type}`, onclick: () => onColumn(t, c) },
            el('span', {}, c.name),
            el('span', { class: `tag ${c.type}` }, TYPE_SHORT[c.type] || c.type),
          ),
        ),
      ),
    ),
  );
}

function columnOptions(selected) {
  return X.schema.map((t) =>
    el(
      'optgroup',
      { label: t.name },
      t.columns.map((c) => {
        const v = `${t.name}.${c.name}`;
        return el('option', { value: v, selected: v === selected }, `${t.name}.${c.name}`);
      }),
    ),
  );
}

const cellText = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : String(v));

function showResults(box, slot, res) {
  for (const g of grids.splice(0)) g.destroy();
  if (!res) {
    box.replaceChildren(el('div', { class: 'loading' }, 'Run the query to see results here.'));
    return;
  }
  if (res.error) {
    box.replaceChildren(el('div', { class: 'sx-error' }, res.error));
    return;
  }
  if (!res.columns.length) {
    box.replaceChildren(el('div', { class: 'loading' }, `Statement ran in ${res.ms} ms. ${n(res.changes || 0)} row(s) changed.`));
    return;
  }
  const head = el(
    'div',
    { class: 'sx-reshead' },
    el('span', {}, el('b', {}, n(res.total)), res.total === 1 ? ' row' : ' rows', res.truncated ? ' (stopped at 1,000,000 — add a LIMIT or aggregate)' : '', ` · ${n(res.ms)} ms`),
    el(
      'button',
      {
        class: 'btn small',
        onclick: async () => {
          try {
            download(`${safeName(X.baseName)}_query.csv`, await call('sqlExport', { slot }));
          } catch (e) {
            toast(e.message);
          }
        },
      },
      'Export results (CSV)',
    ),
  );
  const gridHost = el('div', { class: 'panel' });
  box.replaceChildren(head, gridHost);
  const sample = res.rows;
  const columns = [
    { label: '#', width: Math.max(48, String(res.total).length * 8 + 20), cls: 'gutter', get: (r) => String(r.i + 1) },
    ...res.columns.map((name, ci) => {
      let len = name.length + 2;
      let numeric = false;
      for (const r of sample.slice(0, 200)) {
        const v = r[ci];
        if (typeof v === 'number') numeric = true;
        const l = cellText(v).length;
        if (l > len) len = l;
      }
      return { label: name, title: name, width: Math.round(Math.min(340, Math.max(70, len * 7.4 + 22))), cls: numeric ? 'num' : '', get: (r) => cellText(r.cells[ci]) };
    }),
  ];
  const wrap = (rows, offset) => rows.map((cells, i) => ({ i: offset + i, cells }));
  grids.push(
    createGrid(gridHost, {
      columns,
      total: res.total,
      firstPage: wrap(res.rows, 0),
      fetchPage: (offset, limit) => call('sqlRows', { slot, offset, limit }).then((rows) => wrap(rows, offset)),
      rowCls: () => '',
    }),
  );
}

async function run(slot, sql, box) {
  box.replaceChildren(el('div', { class: 'loading' }, 'Running…'));
  try {
    X.results[slot] = await call('runSql', { sql, slot, rels: X.rels });
  } catch (e) {
    X.results[slot] = { error: e.message };
  }
  showResults(box, slot, X.results[slot]);
}

// ---------- query builder ----------

function renderBuilder(body) {
  const s = X.spec;
  const form = el('div', { class: 'sx-form' });
  const resultsBox = el('div', { class: 'sx-results' });
  const preview = el('pre', { class: 'sx-sql' });
  const err = el('div', { class: 'sx-error', hidden: true });
  let currentSQL = null;

  const refreshPreview = () => {
    save();
    try {
      currentSQL = buildSQL(s, X.schema, X.rels);
      preview.textContent = currentSQL;
      preview.hidden = false;
      err.hidden = true;
    } catch (e) {
      currentSQL = null;
      preview.hidden = true;
      err.hidden = false;
      err.textContent = e.message;
    }
  };
  const rerender = () => {
    renderForm();
    refreshPreview();
  };

  const addColumn = (t, c) => {
    if (!s.base) s.base = t.name;
    s.fields.push({ table: t.name, col: c.name, agg: '', gran: '' });
    rerender();
  };

  const sel = (value, options, onchange, label) =>
    el('select', { 'aria-label': label, onchange: (e) => onchange(e.target.value) }, options.map(([v, l]) => el('option', { value: v, selected: String(v) === String(value) }, l)));

  function renderForm() {
    const fieldRows = s.fields.map((f, i) => {
      const info = f.kind === 'count' ? null : colInfo(f.table, f.col);
      const isDate = info?.type === 'date';
      return el(
        'div',
        { class: 'sx-row' },
        el('span', { class: 'sx-pos' }, String(i + 1)),
        el('span', { class: 'sx-fname' }, f.kind === 'count' ? 'COUNT(*) — rows' : `${f.table}.${f.col}`),
        f.kind === 'count'
          ? null
          : sel(f.agg, Object.entries(AGG_LABELS), (v) => ((f.agg = v), rerender()), 'Aggregate'),
        isDate ? sel(f.gran, [['', 'exact'], ['year', 'year'], ['month', 'month'], ['day', 'day']], (v) => ((f.gran = v), rerender()), 'Date bucket') : null,
        i > 0
          ? el(
              'button',
              {
                class: 'x',
                title: 'Move up',
                onclick: () => {
                  [s.fields[i - 1], s.fields[i]] = [s.fields[i], s.fields[i - 1]];
                  s.sort = [];
                  rerender();
                },
              },
              '↑',
            )
          : null,
        el(
          'button',
          {
            class: 'x',
            title: 'Remove',
            onclick: () => {
              s.fields.splice(i, 1);
              s.sort = s.sort.filter((x) => x.field !== i).map((x) => ({ ...x, field: x.field > i ? x.field - 1 : x.field }));
              rerender();
            },
          },
          '×',
        ),
      );
    });

    const filterRows = s.filters.map((f, i) => {
      const info = colInfo(f.table, f.col);
      return el(
        'div',
        { class: 'sx-row' },
        el(
          'select',
          {
            'aria-label': 'Filter column',
            onchange: (e) => {
              const [t, c] = e.target.value.split('.');
              f.table = t;
              f.col = c;
              rerender();
            },
          },
          columnOptions(`${f.table}.${f.col}`),
        ),
        sel(f.op, OPS, (v) => ((f.op = v), rerender()), 'Operator'),
        f.op === 'empty' || f.op === 'notempty'
          ? null
          : el('input', {
              'aria-label': 'Filter value',
              value: f.value ?? '',
              placeholder: info?.type === 'date' ? 'YYYY-MM-DD' : info?.type === 'number' ? 'e.g. 100' : 'value',
              oninput: (e) => {
                f.value = e.target.value;
                refreshPreview();
              },
            }),
        el('button', { class: 'x', title: 'Remove', onclick: () => (s.filters.splice(i, 1), rerender()) }, '×'),
      );
    });

    const sortRows = s.sort.map((x, i) =>
      el(
        'div',
        { class: 'sx-row' },
        sel(x.field, s.fields.map((f, fi) => [fi, `${fi + 1}. ${fieldLabel(f)}`]), (v) => ((x.field = +v), rerender()), 'Sort column'),
        sel(x.dir, [['asc', 'ascending'], ['desc', 'descending']], (v) => ((x.dir = v), rerender()), 'Direction'),
        el('button', { class: 'x', title: 'Remove', onclick: () => (s.sort.splice(i, 1), rerender()) }, '×'),
      ),
    );

    const section = (title, hint, rows, ...actions) =>
      el('div', { class: 'sx-sec' }, el('div', { class: 'sx-sec-h' }, el('span', { class: 'sx-sec-t' }, title), ...actions), rows.length ? rows : el('div', { class: 'hint', style: { margin: '2px 0' } }, hint));

    form.replaceChildren(
      el(
        'div',
        { class: 'sx-sec' },
        el(
          'div',
          { class: 'sx-sec-h' },
          el('span', { class: 'sx-sec-t' }, 'From'),
          sel(s.base, [['', '— choose a table —'], ...X.schema.map((t) => [t.name, `${t.name} (${n(t.rowCount)} rows)`])], (v) => ((s.base = v), rerender()), 'From table'),
          el('span', { class: 'hint', style: { margin: 0 } }, 'Other tables are joined automatically using the Data model relationships.'),
        ),
      ),
      section(
        'Columns',
        'Click columns on the left to add them. With no columns, all columns of the From table are returned. Adding an aggregate (count, sum…) groups by the other columns.',
        fieldRows,
        el('button', { class: 'btn small', onclick: () => (s.fields.push({ kind: 'count' }), rerender()) }, '+ Count rows'),
      ),
      section(
        'Filters (WHERE)',
        'No filters.',
        filterRows,
        el(
          'button',
          {
            class: 'btn small',
            onclick: () => {
              const t = X.schema.find((x) => x.name === s.base) || X.schema[0];
              s.filters.push({ table: t.name, col: t.columns[1]?.name || t.columns[0].name, op: 'eq', value: '' });
              rerender();
            },
          },
          '+ Filter',
        ),
      ),
      section(
        'Sort (ORDER BY)',
        s.fields.length ? 'Unsorted.' : 'Add columns to sort by them.',
        sortRows,
        s.fields.length ? el('button', { class: 'btn small', onclick: () => (s.sort.push({ field: 0, dir: 'desc' }), rerender()) }, '+ Sort') : null,
      ),
      el(
        'div',
        { class: 'sx-sec' },
        el(
          'div',
          { class: 'sx-sec-h' },
          el('span', { class: 'sx-sec-t' }, 'Limit'),
          el('input', {
            type: 'number',
            min: 0,
            value: s.limit ?? '',
            placeholder: 'no limit',
            'aria-label': 'Row limit',
            style: { width: '100px' },
            oninput: (e) => {
              s.limit = e.target.value;
              refreshPreview();
            },
          }),
          el('div', { class: 'spacer' }),
          el(
            'button',
            {
              class: 'btn',
              onclick: () => {
                s.base = '';
                s.fields = [];
                s.filters = [];
                s.sort = [];
                s.limit = 1000;
                rerender();
              },
            },
            'Clear',
          ),
          el(
            'button',
            {
              class: 'btn',
              title: 'Copy this SQL into the SQL editor to change it by hand',
              onclick: () => {
                if (!currentSQL) return toast('Fix the query first.');
                X.sql = currentSQL;
                X.sub = 'sql';
                save();
                renderShell();
              },
            },
            'Edit as SQL',
          ),
          el('button', { class: 'btn primary', onclick: () => (currentSQL ? run('builder', currentSQL, resultsBox) : toast('Fix the query first.')) }, 'Run query'),
        ),
      ),
      el('div', { class: 'sx-sec' }, el('div', { class: 'sx-sec-t' }, 'Generated SQL'), preview, err),
    );
  }

  rerender();
  body.replaceChildren(
    el('div', { class: 'sx-split' }, schemaPanel(addColumn), el('div', { class: 'sx-right' }, form, resultsBox)),
  );
  showResults(resultsBox, 'builder', X.results.builder);
}

// ---------- SQL editor ----------

function renderEditor(body) {
  const ta = el('textarea', {
    class: 'sx-editor',
    spellcheck: 'false',
    'aria-label': 'SQL',
    value: X.sql,
    oninput: (e) => {
      X.sql = e.target.value;
      save();
    },
  });
  const resultsBox = el('div', { class: 'sx-results' });
  const insert = (text) => {
    const { selectionStart: a, selectionEnd: b, value } = ta;
    ta.value = value.slice(0, a) + text + value.slice(b);
    ta.selectionStart = ta.selectionEnd = a + text.length;
    ta.focus();
    X.sql = ta.value;
    save();
  };
  const doRun = () => {
    const a = ta.selectionStart;
    const b = ta.selectionEnd;
    const sql = b > a ? ta.value.slice(a, b) : ta.value;
    run('sql', sql, resultsBox);
  };
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      doRun();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      insert('  ');
    }
  });

  const examples = exampleQueries();
  const exampleSel = el(
    'select',
    {
      'aria-label': 'Example queries',
      onchange: (e) => {
        const ex = examples[+e.target.value];
        if (ex) {
          ta.value = ex.sql;
          X.sql = ex.sql;
          save();
        }
        e.target.value = '';
      },
    },
    el('option', { value: '' }, 'Examples…'),
    examples.map((ex, i) => el('option', { value: i }, ex.label)),
  );

  body.replaceChildren(
    el(
      'div',
      { class: 'sx-split' },
      schemaPanel(
        (t, c) => insert(`${t.name}.${c.name}`),
        (t) => insert(t.name),
      ),
      el(
        'div',
        { class: 'sx-right' },
        el(
          'div',
          { class: 'sx-form' },
          ta,
          el(
            'div',
            { class: 'sx-sec-h', style: { marginTop: '8px' } },
            el('button', { class: 'btn primary', onclick: doRun }, 'Run  ⌘↵'),
            exampleSel,
            el(
              'span',
              { class: 'hint', style: { margin: 0 } },
              'SQLite dialect. Dates are ISO text: use date(), strftime(\'%Y-%m\', col). Each table has a _line column with the source file line. Select text to run only that part.',
            ),
          ),
        ),
        resultsBox,
      ),
    ),
  );
  showResults(resultsBox, 'sql', X.results.sql);
}

function exampleQueries() {
  const t0 = X.schema[0];
  const out = [];
  if (t0) out.push({ label: `First 100 rows of ${t0.name}`, sql: `SELECT *\nFROM ${t0.name}\nLIMIT 100;` });
  out.push({
    label: 'Row count of every table',
    sql: X.schema.map((t) => `SELECT '${t.name}' AS table_name, COUNT(*) AS row_count FROM ${t.name}`).join('\nUNION ALL\n') + ';',
  });
  const dateTable = X.schema.find((t) => t.columns.some((c) => c.type === 'date'));
  if (dateTable) {
    const c = dateTable.columns.find((x) => x.type === 'date').name;
    out.push({
      label: `${dateTable.name} per month`,
      sql: `SELECT strftime('%Y-%m', ${c}) AS month, COUNT(*) AS rows\nFROM ${dateTable.name}\nGROUP BY 1\nORDER BY 1;`,
    });
    out.push({
      label: `Date range of ${dateTable.name}.${c}`,
      sql: `SELECT MIN(${c}) AS first, MAX(${c}) AS last,\n       julianday(MAX(${c})) - julianday(MIN(${c})) AS span_days\nFROM ${dateTable.name};`,
    });
  }
  const r = X.rels[0];
  if (r) {
    out.push({
      label: `Join ${r.from.table} → ${r.to.table}`,
      sql: `SELECT ${r.to.table}.${r.to.col}, COUNT(${r.from.table}.${r.from.col}) AS ${r.from.table}_count\nFROM ${r.to.table}\n  LEFT JOIN ${r.from.table} ON ${r.from.table}.${r.from.col} = ${r.to.table}.${r.to.col}\nGROUP BY 1\nORDER BY 2 DESC\nLIMIT 50;`,
    });
    out.push({
      label: `${r.from.table} rows with no matching ${r.to.table} (orphans)`,
      sql: `SELECT ${r.from.table}.*\nFROM ${r.from.table}\n  LEFT JOIN ${r.to.table} ON ${r.from.table}.${r.from.col} = ${r.to.table}.${r.to.col}\nWHERE ${r.from.table}.${r.from.col} IS NOT NULL\n  AND ${r.to.table}.${r.to.col} IS NULL;`,
    });
  }
  return out;
}

// ---------- data model ----------

function defaultPositions() {
  let y = 30;
  let rowH = 0;
  X.schema.forEach((t, i) => {
    if (X.pos[t.name]) return;
    const col = i % 3;
    if (col === 0 && i > 0) {
      y += rowH + 50;
      rowH = 0;
    }
    X.pos[t.name] = { x: 30 + col * (CARD_W + 110), y };
    rowH = Math.max(rowH, HEAD_H + t.columns.length * ROW_H + 2);
  });
}

function renderModel(body) {
  defaultPositions();
  const canvas = el('div', { class: 'dm-canvas' });
  const inner = el('div', { class: 'dm-inner' });
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'dm-svg');
  svg.innerHTML =
    '<defs><marker id="dm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="dm-arrowhead"/></marker></defs>';
  const lines = document.createElementNS(svgNS, 'g');
  const temp = document.createElementNS(svgNS, 'path');
  temp.setAttribute('class', 'dm-temp');
  svg.append(lines, temp);
  inner.append(svg);
  canvas.append(inner);
  let selected = null;

  const cards = new Map();
  const linked = () => {
    const set = new Set();
    for (const r of X.rels) {
      set.add(`${r.from.table}.${r.from.col}`);
      set.add(`${r.to.table}.${r.to.col}`);
    }
    return set;
  };
  const anchor = (table, col, side) => {
    const t = X.schema.find((x) => x.name === table);
    const p = X.pos[table];
    const i = t.columns.findIndex((c) => c.name === col);
    return { x: p.x + (side === 'right' ? CARD_W : 0), y: p.y + 1 + HEAD_H + i * ROW_H + ROW_H / 2 };
  };

  function sizeCanvas() {
    let w = 0;
    let h = 0;
    for (const t of X.schema) {
      const p = X.pos[t.name];
      w = Math.max(w, p.x + CARD_W);
      h = Math.max(h, p.y + HEAD_H + t.columns.length * ROW_H);
    }
    inner.style.width = w + 200 + 'px';
    inner.style.height = h + 160 + 'px';
    svg.setAttribute('width', w + 200);
    svg.setAttribute('height', h + 160);
  }

  function drawLines() {
    lines.replaceChildren();
    const linkedSet = linked();
    for (const [name, card] of cards) {
      for (const row of card.querySelectorAll('.dm-col')) row.classList.toggle('linked', linkedSet.has(`${name}.${row.dataset.col}`));
    }
    for (const r of X.rels) {
      const pa = X.pos[r.from.table];
      const pb = X.pos[r.to.table];
      if (!pa || !pb) continue;
      const leftToRight = pa.x + CARD_W / 2 <= pb.x + CARD_W / 2;
      const a = anchor(r.from.table, r.from.col, leftToRight ? 'right' : 'left');
      const b = anchor(r.to.table, r.to.col, leftToRight ? 'left' : 'right');
      const dx = Math.max(50, Math.abs(b.x - a.x) / 2) * (leftToRight ? 1 : -1);
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`);
      path.setAttribute('class', 'dm-line' + (r.type === 'inner' ? ' inner' : '') + (selected === relKey(r) ? ' sel' : ''));
      path.setAttribute('marker-end', 'url(#dm-arrow)');
      const title = document.createElementNS(svgNS, 'title');
      title.textContent = `${r.from.table}.${r.from.col} → ${r.to.table}.${r.to.col} (${r.type === 'inner' ? 'INNER' : 'LEFT'} JOIN)`;
      path.append(title);
      path.addEventListener('click', () => {
        selected = relKey(r);
        drawLines();
        renderSide();
      });
      lines.append(path);
    }
  }

  const toCanvas = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left + canvas.scrollLeft, y: e.clientY - rect.top + canvas.scrollTop };
  };

  function addRel(from, to) {
    if (from.table === to.table) return toast('Pick a column in a different table.');
    const r = { from, to, type: 'left' };
    if (X.rels.some((x) => relKey(x) === relKey(r) || (relKey({ from: x.to, to: x.from }) === relKey(r)))) return toast('That relationship already exists.');
    X.rels.push(r);
    selected = relKey(r);
    save();
    drawLines();
    renderSide();
    toast(`Related ${from.table}.${from.col} → ${to.table}.${to.col}.`);
  }

  for (const t of X.schema) {
    const p = X.pos[t.name];
    const head = el('div', { class: 'dm-head', title: 'Drag to move' }, el('span', { class: 'dm-name' }, t.name), el('span', { class: 'dm-count' }, `${n(t.rowCount)} rows`));
    const card = el(
      'div',
      { class: 'dm-card', style: { left: p.x + 'px', top: p.y + 'px', width: CARD_W + 'px' } },
      head,
      t.columns.map((c) =>
        el(
          'div',
          { class: 'dm-col', 'data-table': t.name, 'data-col': c.name, title: `Drag onto a column in another table to relate ${t.name}.${c.name} to it` },
          el('span', {}, c.name),
          el('span', { class: `tag ${c.type}` }, TYPE_SHORT[c.type] || c.type),
        ),
      ),
    );
    cards.set(t.name, card);
    inner.append(card);

    head.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      head.setPointerCapture(e.pointerId);
      const start = { px: e.clientX, py: e.clientY, x: p.x, y: p.y };
      const move = (ev) => {
        p.x = Math.max(0, start.x + ev.clientX - start.px);
        p.y = Math.max(0, start.y + ev.clientY - start.py);
        card.style.left = p.x + 'px';
        card.style.top = p.y + 'px';
        drawLines();
      };
      const up = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        sizeCanvas();
        save();
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });
  }

  inner.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.dm-col');
    if (!row) return;
    e.preventDefault();
    row.setPointerCapture(e.pointerId);
    const from = { table: row.dataset.table, col: row.dataset.col };
    const move = (ev) => {
      const a = anchor(from.table, from.col, 'right');
      const b = toCanvas(ev);
      temp.setAttribute('d', `M${a.x},${a.y} L${b.x},${b.y}`);
      for (const r of inner.querySelectorAll('.dm-col.drop')) r.classList.remove('drop');
      document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.dm-col')?.classList.add('drop');
    };
    const up = (ev) => {
      row.removeEventListener('pointermove', move);
      row.removeEventListener('pointerup', up);
      temp.setAttribute('d', '');
      for (const r of inner.querySelectorAll('.dm-col.drop')) r.classList.remove('drop');
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.dm-col');
      if (target && target !== row) addRel(from, { table: target.dataset.table, col: target.dataset.col });
    };
    row.addEventListener('pointermove', move);
    row.addEventListener('pointerup', up);
  });

  const side = el('div', { class: 'dm-side' });
  function renderSide() {
    const fromSel = el('select', { 'aria-label': 'Foreign key column' }, columnOptions(''));
    const toSel = el('select', { 'aria-label': 'Referenced column' }, columnOptions(''));
    side.replaceChildren(
      ...[
      el('div', { class: 'sb-title' }, `Relationships (${X.rels.length})`),
      el('p', { class: 'hint' }, 'Drag from a column to the matching column in another table — e.g. orders.customer_id onto customer.customer_id. The query builder uses these to join tables.'),
      el(
        'div',
        { class: 'sb-actions', style: { margin: '0 0 10px' } },
        el(
          'button',
          {
            class: 'btn small',
            title: 'Add relationships between columns with matching names where one side is a unique key',
            onclick: () => {
              const have = new Set(X.rels.map(relKey));
              const add = X.autoRels.filter((r) => !have.has(relKey(r)));
              X.rels.push(...add.map((r) => ({ ...r })));
              save();
              drawLines();
              renderSide();
              toast(add.length ? `Added ${add.length} detected relationship(s).` : 'No new relationships detected.');
            },
          },
          'Auto-detect',
        ),
        el(
          'button',
          {
            class: 'btn small',
            onclick: () => {
              X.pos = {};
              save();
              renderShell();
            },
          },
          'Reset layout',
        ),
      ),
      X.rels.length ? null : el('div', { class: 'sb-note' }, 'No relationships yet. Without them the builder can only query one table at a time.'),
      X.rels.map((r, i) =>
        el(
          'div',
          {
            class: 'dm-rel' + (selected === relKey(r) ? ' sel' : ''),
            onclick: () => {
              selected = relKey(r);
              drawLines();
              renderSide();
            },
          },
          el('div', { class: 'dm-rel-t' }, el('span', {}, `${r.from.table}.${r.from.col}`), ' → ', el('span', {}, `${r.to.table}.${r.to.col}`)),
          el(
            'div',
            { class: 'sx-sec-h' },
            el(
              'select',
              {
                'aria-label': 'Join type',
                onchange: (e) => {
                  r.type = e.target.value;
                  save();
                  drawLines();
                },
              },
              el('option', { value: 'left', selected: r.type !== 'inner' }, 'LEFT JOIN (keep unmatched)'),
              el('option', { value: 'inner', selected: r.type === 'inner' }, 'INNER JOIN (matches only)'),
            ),
            r.auto ? el('span', { class: 'tag' }, 'detected') : null,
            el(
              'button',
              {
                class: 'x',
                title: 'Delete relationship',
                onclick: (e) => {
                  e.stopPropagation();
                  X.rels.splice(i, 1);
                  save();
                  drawLines();
                  renderSide();
                },
              },
              '×',
            ),
          ),
        ),
      ),
      el('div', { class: 'sb-title' }, 'Add by hand'),
      el('div', { class: 'dm-add' }, fromSel, el('span', { class: 'hint', style: { margin: 0 } }, 'references'), toSel),
      el(
        'button',
        {
          class: 'btn small',
          onclick: () => {
            const [ft, fc] = fromSel.value.split('.');
            const [tt, tc] = toSel.value.split('.');
            addRel({ table: ft, col: fc }, { table: tt, col: tc });
          },
        },
        'Add relationship',
      ),
      ]
        .flat()
        .filter(Boolean),
    );
  }

  sizeCanvas();
  drawLines();
  renderSide();
  body.replaceChildren(el('div', { class: 'sx-split' }, canvas, side));
}
