// Quality indicators (KPIs) and the accreditation readiness report.
import { render } from '../app.js';
import { kpiRow } from './assets.js';
import { S, h, icon, t } from './core.js';
import { isAdminRole, link, navigate } from './layout.js';
import { api, errText, errorBox, field, input, openDialog, select, toast } from './offline.js';
import { meter, scoreChip } from './quality.js';
import { pick, simpleDelete } from './tickets.js';

const UNITS = ['pct', 'per1000', 'value'];
const SOURCES = ['manual', 'rounds', 'capa', 'docs', 'meetings'];

/* --------------------------------- helpers -------------------------------- */

const num = (v) => (v === null || v === undefined ? '-' : String(Math.round(v * 100) / 100));
export const fmtVal = (k, v) => (v === null || v === undefined ? '-' : k.unit === 'pct' ? num(v) + '%' : num(v));
const unitNote = (k) => (k.unit === 'per1000' ? t('kpi.per1000') : '');
// "2026-11" → "نوفمبر 2026"; "2026-Q4" → "الربع 4 2026".
export function periodLabel(p, short) {
  if (p[5] === 'Q') return t('kpi.quarter', { q: p[6], y: p.slice(0, 4) });
  const d = new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)) - 1, 1));
  return new Intl.DateTimeFormat(S.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { month: short ? 'short' : 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}
function prevPeriod(p) {
  const y = Number(p.slice(0, 4));
  if (p[5] === 'Q') return Number(p[6]) === 1 ? `${y - 1}-Q4` : `${y}-Q${Number(p[6]) - 1}`;
  const m = Number(p.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
const lastPeriods = (cur, n) => {
  const out = [cur];
  while (out.length < n) out.push(prevPeriod(out[out.length - 1]));
  return out;
};
const metChip = (met) =>
  met === null || met === undefined
    ? h('span', { class: 'muted' }, '-')
    : h('span', { class: 'chip ' + (met ? 'chip-valid' : 'chip-expired') }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t(met ? 'kpi.met' : 'kpi.below'));
const arrow = (k) => (k.direction === 'down' ? '↓' : '↑');
const targetText = (k) => (k.target === null || k.target === undefined ? '-' : arrow(k) + ' ' + fmtVal(k, k.target));

// SVG elements (h() makes HTML ones).
const panelHead = (title, note) => h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, title), note ? h('span', { class: 'muted small' }, note) : ''));
const canCapa = () => isAdminRole(S.user) || S.user.quality === 'manager' || S.user.quality === 'assessor';
const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) el.setAttribute(k, v);
  for (const kid of kids.flat(2)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

// A small trend line for the table: the last values, the target dashed.
function spark(k) {
  const pts = k.values.filter((v) => v.value !== null);
  if (pts.length < 2) return h('span', { class: 'muted small' }, '-');
  const W = 96, H = 26, P = 3;
  const vals = pts.map((v) => v.value).concat(k.target ?? []);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const y = (v) => (hi === lo ? H / 2 : H - P - ((v - lo) / (hi - lo)) * (H - 2 * P));
  const x = (i) => P + (i / (pts.length - 1)) * (W - 2 * P);
  const last = pts[pts.length - 1];
  return s(
    'svg',
    { class: 'kpi-spark', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': t('kpi.trend') },
    k.target !== null && k.target !== undefined ? s('line', { x1: 0, x2: W, y1: y(k.target), y2: y(k.target), class: 'kpi-target' }) : null,
    s('polyline', { points: pts.map((v, i) => `${x(i)},${y(v.value)}`).join(' '), class: 'kpi-line' }),
    s('circle', { cx: x(pts.length - 1), cy: y(last.value), r: 3, class: last.met === false ? 'kpi-dot is-below' : 'kpi-dot' }),
  );
}

// The detail chart: one line, a dashed target, a marker per period (green met, red below), hover shows the value.
function trendChart(points, opts) {
  const pts = points.filter((p) => p.value !== null);
  if (pts.length < 2) return h('p', { class: 'muted kpi-body' }, t('kpi.chart_few'));
  const W = 640, H = 220, L = 44, R = 16, T = 14, B = 30;
  const vals = pts.map((p) => p.value).concat(opts.target ?? []);
  let lo = Math.min(0, ...vals), hi = Math.max(...vals);
  if (opts.pct) hi = Math.max(hi, 100) > 100 ? hi : Math.min(100, hi * 1.1 || 1);
  else hi = hi * 1.1 || 1;
  const y = (v) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const x = (i) => L + (pts.length === 1 ? 0 : (i / (pts.length - 1)) * (W - L - R));
  const ticks = [lo, (lo + hi) / 2, hi];
  const tip = h('div', { class: 'kpi-tip', hidden: true });
  const svg = s(
    'svg',
    { class: 'kpi-chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label },
    ticks.map((v) => [s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'kpi-grid' }), s('text', { x: L - 6, y: y(v) + 4, class: 'kpi-axis', 'text-anchor': 'end' }, opts.fmt(v))]),
    opts.target !== null && opts.target !== undefined
      ? [s('line', { x1: L, x2: W - R, y1: y(opts.target), y2: y(opts.target), class: 'kpi-target' }), s('text', { x: L + 4, y: y(opts.target) - 5, class: 'kpi-axis', 'text-anchor': 'start' }, opts.fmt(opts.target))]
      : null,
    s('polyline', { points: pts.map((p, i) => `${x(i)},${y(p.value)}`).join(' '), class: 'kpi-line' }),
    pts.map((p, i) => [
      s('circle', { cx: x(i), cy: y(p.value), r: 4.5, class: p.met === false ? 'kpi-dot is-below' : 'kpi-dot' }),
      // A wide invisible target, so the hover is easy to hit.
      s('rect', {
        x: x(i) - (W - L - R) / Math.max(pts.length - 1, 1) / 2,
        y: T,
        width: (W - L - R) / Math.max(pts.length - 1, 1),
        height: H - T - B,
        class: 'kpi-hit',
        'data-i': i,
      }),
    ]),
    pts.map((p, i) => (pts.length <= 12 || i % Math.ceil(pts.length / 12) === 0 ? s('text', { x: x(i), y: H - 10, class: 'kpi-axis', 'text-anchor': 'middle' }, opts.xLabel(p)) : null)),
  );
  svg.addEventListener('pointermove', (e) => {
    const i = e.target.dataset && e.target.dataset.i;
    if (i === undefined) return (tip.hidden = true);
    const p = pts[Number(i)];
    tip.replaceChildren(h('b', {}, opts.fmt(p.value)), ' ', h('span', { class: 'muted' }, opts.xLabel(p, true)));
    const box = svg.getBoundingClientRect();
    const cb = wrap.getBoundingClientRect();
    tip.style.left = (box.left - cb.left + (x(Number(i)) / W) * box.width).toFixed(0) + 'px';
    tip.style.top = (box.top - cb.top + (y(p.value) / H) * box.height - 8).toFixed(0) + 'px';
    tip.hidden = false;
  });
  svg.addEventListener('pointerleave', () => (tip.hidden = true));
  const wrap = h('div', { class: 'kpi-chart-box kpi-body', dir: 'ltr' }, svg, tip);
  return wrap;
}

/* ------------------------------- the register ------------------------------ */

export async function kpisPage(root, param, alive) {
  let d;
  try {
    d = await api('/kpis');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  if (param) {
    const k = d.kpis.find((x) => String(x.id) === String(param));
    if (k) return kpiDetail(root, k, d);
  }
  const f = (S.kpiF = S.kpiF || { q: '', chapter: '', show: '' });
  const live = d.kpis.filter((k) => k.active);
  // The last finished period is the one that should have its numbers by now.
  const latest = (k) => [...k.values].reverse().find((v) => v.value !== null) || null;
  const due = (k) => prevPeriod(k.current);
  const missing = (k) => k.source === 'manual' && !k.values.some((v) => v.period === due(k));
  const search = input({ type: 'search', class: 'doc-search-input', value: f.q, placeholder: t('kpi.search_ph'), 'aria-label': t('kpi.search_ph'), autocomplete: 'off' });
  const pickCh = select([['', t('qa.all_chapters')], ...d.chapters.map((c) => [c.code, c.code + ' · ' + pick(c.name_ar, c.name_en)])], f.chapter, { 'aria-label': t('qa.chapter') });
  const pickShow = select([['', t('kpi.show_all')], ['below', t('kpi.below')], ['missing', t('kpi.missing')]], f.show, { 'aria-label': t('kpi.show_all') });
  const box = h('div', {});
  const norm = (v) => String(v || '').toLowerCase();
  const draw = () => {
    const q = norm(f.q.trim());
    const rows = d.kpis.filter((k) => {
      const l = latest(k);
      return (
        (!f.chapter || k.chapter === f.chapter) &&
        (!f.show || (f.show === 'below' ? l && l.met === false : missing(k))) &&
        (!q || [k.code, k.name_ar, k.name_en, k.dept_ar, k.dept_en].some((v) => norm(v).includes(q)))
      );
    });
    box.replaceChildren(
      h(
        'section',
        { class: 'panel' },
        rows.length
          ? h(
              'div',
              { class: 'table-scroll' },
              h(
                'table',
                {},
                h('thead', {}, h('tr', {}, ['kpi.name', 'user.department', 'kpi.target', 'kpi.last', 'kpi.trend', 'kpi.status'].map((c) => h('th', { scope: 'col' }, t(c))))),
                h(
                  'tbody',
                  {},
                  rows.map((k) => {
                    const l = latest(k);
                    return h(
                      'tr',
                      { class: k.active ? '' : 'is-off' },
                      h(
                        'td',
                        { class: 'wrap-cell' },
                        link('reports/kpis/' + k.id, { class: 'strong' }, pick(k.name_ar, k.name_en)),
                        h('div', { class: 'small muted' }, h('span', { class: 'mono', dir: 'ltr' }, k.code), k.chapter ? ' · ' + k.chapter : '', k.source !== 'manual' ? ' · ' + t('kpi.auto') : '', unitNote(k) ? ' · ' + unitNote(k) : ''),
                      ),
                      h('td', {}, pick(k.dept_ar, k.dept_en) || h('span', { class: 'muted' }, '-')),
                      h('td', {}, h('span', { class: 'mono', dir: 'ltr' }, targetText(k))),
                      h('td', {}, l ? [h('span', { class: 'mono strong', dir: 'ltr' }, fmtVal(k, l.value)), h('div', { class: 'small muted' }, periodLabel(l.period, true))] : h('span', { class: 'muted' }, '-')),
                      h('td', {}, spark(k)),
                      h('td', {}, missing(k) ? h('span', { class: 'chip chip-near' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('kpi.missing')) : metChip(l && l.met)),
                    );
                  }),
                ),
              ),
            )
          : h('p', { class: 'empty' }, d.kpis.length ? t('capa.no_match') : t('kpi.empty')),
      ),
    );
  };
  for (const [el, key] of [[search, 'q'], [pickCh, 'chapter'], [pickShow, 'show']])
    el.addEventListener(el === search ? 'input' : 'change', () => {
      f[key] = el.value;
      draw();
    });
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.kpis')), h('p', { class: 'muted' }, t('kpi.sub', { n: live.length }))),
      d.can_manage
        ? h(
            'div',
            { class: 'actions' },
            d.library.length ? h('button', { type: 'button', class: 'btn', onclick: () => libraryDialog(d) }, icon('download'), t('kpi.library')) : '',
            h('button', { type: 'button', class: 'btn btn-primary', onclick: () => kpiDialog(null, d) }, icon('plus'), t('kpi.add')),
          )
        : '',
    ),
    kpiRow([
      ['kpi.k_total', live.length],
      ['kpi.k_met', live.filter((k) => latest(k) && latest(k).met === true).length],
      ['kpi.k_below', live.filter((k) => latest(k) && latest(k).met === false).length],
      ['kpi.k_missing', live.filter(missing).length],
    ]),
    h('div', { class: 'filters' }, h('div', { class: 'doc-search', role: 'search' }, icon('search'), search), pickShow, pickCh),
    box,
  );
  draw();
}

function kpiDetail(root, k, d) {
  const metaRow = (label, value) => h('div', { class: 'meta' }, h('span', { class: 'meta-label' }, label), value);
  const vals = [...k.values].reverse();
  const entry = k.can_enter ? entryForm(k) : '';
  root.replaceChildren(
    h('p', {}, link('reports/kpis', { class: 'back-link' }, t('kpi.back'))),
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, pick(k.name_ar, k.name_en)), h('p', { class: 'muted' }, h('span', { class: 'mono', dir: 'ltr' }, k.code), k.chapter ? ' · ' + k.chapter : '', k.std_code ? ' · ' + k.std_code : '')),
      d.can_manage
        ? h(
            'div',
            { class: 'actions' },
            h('button', { type: 'button', class: 'btn', onclick: () => kpiDialog(k, d) }, icon('edit'), t('common.edit')),
            h('button', { type: 'button', class: 'btn btn-icon', title: t('common.delete'), 'aria-label': t('common.delete'), onclick: () => simpleDelete(t('kpi.delete_q'), '/kpis/' + k.id, t('kpi.deleted'), () => navigate('reports/kpis')) }, icon('trash')),
          )
        : '',
    ),
    h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'meta-grid' },
        metaRow(t('kpi.target'), h('span', { class: 'mono', dir: 'ltr' }, targetText(k))),
        metaRow(t('kpi.unit'), h('span', {}, t('kpi.unit.' + k.unit))),
        metaRow(t('kpi.frequency'), h('span', {}, t('kpi.freq.' + k.frequency))),
        metaRow(t('user.department'), h('span', {}, pick(k.dept_ar, k.dept_en) || '-')),
        metaRow(t('kpi.source'), h('span', {}, t('kpi.src.' + k.source))),
        k.num_ar ? metaRow(t('kpi.num'), h('span', {}, k.num_ar)) : '',
        k.den_ar && k.unit !== 'value' ? metaRow(t('kpi.den'), h('span', {}, k.den_ar)) : '',
      ),
    ),
    h(
      'section',
      { class: 'panel' },
      panelHead(t('kpi.trend')),
      trendChart(k.values, { target: k.target, pct: k.unit === 'pct', fmt: (v) => fmtVal(k, v), xLabel: (p, long) => periodLabel(p.period, !long), label: pick(k.name_ar, k.name_en) }),
    ),
    entry,
    h(
      'section',
      { class: 'panel' },
      panelHead(t('kpi.values')),
      vals.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['kpi.period', ...(k.unit === 'value' ? ['kpi.value'] : ['kpi.num_short', 'kpi.den_short', 'kpi.value']), 'kpi.status', 'kpi.by', ''].map((c) => h('th', { scope: 'col' }, c ? t(c) : '')))),
              h(
                'tbody',
                {},
                vals.map((v) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, periodLabel(v.period)),
                    ...(k.unit === 'value' ? [] : [h('td', { class: 'mono', dir: 'ltr' }, num(v.num)), h('td', { class: 'mono', dir: 'ltr' }, num(v.den))]),
                    h('td', { class: 'mono strong', dir: 'ltr' }, fmtVal(k, v.value)),
                    h('td', {}, metChip(v.met), v.note ? h('div', { class: 'small muted' }, v.note) : ''),
                    h('td', { class: 'small muted' }, v.entered_by === 'system' ? t('kpi.auto') : v.entered_by || '-'),
                    h('td', {}, v.met === false && canCapa() ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => openCapa(k, v) }, t('kpi.open_capa')) : ''),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('kpi.no_values')),
    ),
  );
}

// A below-target period becomes a corrective action, tied to the indicator's chapter and standard.
async function openCapa(k, v) {
  try {
    const r = await api('/capa', {
      method: 'POST',
      body: { title: t('kpi.capa_title', { name: pick(k.name_ar, k.name_en), period: periodLabel(v.period) }), detail: t('kpi.target') + ' ' + targetText(k) + ' · ' + t('kpi.value') + ' ' + fmtVal(k, v.value), chapter: k.chapter || '', std_code: k.std_code || '', department_id: k.department_id },
    });
    toast(t('capa.added'));
    navigate('quality/capa/' + r.id);
  } catch (e) {
    toast(errText(e), true);
  }
}

function entryForm(k) {
  const periods = lastPeriods(k.current, 12);
  const have = Object.fromEntries(k.values.map((v) => [v.period, v]));
  const per = select(periods.map((p) => [p, periodLabel(p) + (have[p] ? ' ✓' : '')]), have[prevPeriod(k.current)] ? k.current : prevPeriod(k.current), { 'aria-label': t('kpi.period') });
  const n = input({ type: 'number', min: 0, step: 'any', dir: 'ltr', 'aria-label': k.num_ar || t('kpi.num') });
  const dn = input({ type: 'number', min: 0, step: 'any', dir: 'ltr', 'aria-label': k.den_ar || t('kpi.den') });
  const note = input({ type: 'text', maxlength: 500, dir: 'auto' });
  const out = h('span', { class: 'mono strong', dir: 'ltr', 'aria-live': 'polite' });
  const fill = () => {
    const v = have[per.value];
    n.value = v ? v.num ?? '' : '';
    dn.value = v ? v.den ?? '' : '';
    note.value = v ? v.note || '' : '';
    calc();
  };
  const calc = () => {
    const a = Number(n.value), b = Number(dn.value);
    const v = n.value === '' ? null : k.unit === 'value' ? a : b > 0 ? (a / b) * (k.unit === 'pct' ? 100 : 1000) : null;
    out.textContent = v === null ? '' : '= ' + fmtVal(k, Math.round(v * 100) / 100);
  };
  per.addEventListener('change', fill);
  n.addEventListener('input', calc);
  dn.addEventListener('input', calc);
  fill();
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const save = h('button', { type: 'submit', class: 'btn btn-primary' }, t('common.save'));
  return h(
    'section',
    { class: 'panel' },
    panelHead(t('kpi.enter')),
    h(
      'form',
      {
        class: 'stack kpi-body',
        onsubmit: async (e) => {
          e.preventDefault();
          err.hidden = true;
          save.disabled = true;
          try {
            await api('/kpis/' + k.id + '/values', { method: 'PUT', body: { period: per.value, num: n.value, den: k.unit === 'value' ? null : dn.value, note: note.value } });
            toast(t('capa.saved'));
            render();
          } catch (x) {
            err.textContent = errText(x);
            err.hidden = false;
            save.disabled = false;
          }
        },
      },
      field(t('kpi.period'), per),
      h('div', { class: 'form-grid' }, field(k.num_ar || t('kpi.num'), n), k.unit === 'value' ? '' : field(k.den_ar || t('kpi.den'), dn)),
      field(t('kpi.note'), note),
      err,
      h('div', { class: 'actions' }, save, out),
    ),
  );
}

function kpiDialog(k, d) {
  const code = input({ type: 'text', required: true, maxlength: 20, dir: 'ltr', value: k ? k.code : '', placeholder: 'IPC-HH' });
  const nameAr = input({ type: 'text', required: true, maxlength: 200, dir: 'rtl', value: k ? k.name_ar : '' });
  const nameEn = input({ type: 'text', required: true, maxlength: 200, dir: 'ltr', value: k ? k.name_en : '' });
  const chapter = select([['', t('rnd.no_chapter')], ...d.chapters.map((c) => [c.code, c.code + ' · ' + pick(c.name_ar, c.name_en)])], k ? k.chapter || '' : '', {});
  const std = input({ type: 'text', maxlength: 30, dir: 'ltr', value: k ? k.std_code || '' : '', placeholder: 'QM.5' });
  const dept = select([['', t('common.none')], ...d.departments.map((x) => [x.id, pick(x.name_ar, x.name_en)])], k ? k.department_id || '' : '', {});
  const numAr = input({ type: 'text', maxlength: 300, dir: 'auto', value: k ? k.num_ar || '' : '' });
  const denAr = input({ type: 'text', maxlength: 300, dir: 'auto', value: k ? k.den_ar || '' : '' });
  const unit = select(UNITS.map((u) => [u, t('kpi.unit.' + u)]), k ? k.unit : 'pct', {});
  const dir = select([['up', t('kpi.dir.up')], ['down', t('kpi.dir.down')]], k ? k.direction : 'up', {});
  const target = input({ type: 'number', step: 'any', dir: 'ltr', value: k && k.target !== null ? k.target : '' });
  const freq = select([['monthly', t('kpi.freq.monthly')], ['quarterly', t('kpi.freq.quarterly')]], k ? k.frequency : 'monthly', {});
  const src = select(SOURCES.map((x) => [x, t('kpi.src.' + x)]), k ? k.source : 'manual', {});
  const active = input({ type: 'checkbox', checked: k ? !!k.active : true });
  openDialog({
    title: t(k ? 'kpi.edit' : 'kpi.add'),
    body: h(
      'div',
      { class: 'stack' },
      h('div', { class: 'form-grid' }, field(t('dept.name_ar'), nameAr), field(t('dept.name_en'), nameEn)),
      h('div', { class: 'form-grid' }, field(t('kpi.code'), code), field(t('user.department'), dept)),
      h('div', { class: 'form-grid' }, field(t('qa.chapter'), chapter), field(t('capa.std'), std)),
      h('div', { class: 'form-grid' }, field(t('kpi.num'), numAr), field(t('kpi.den'), denAr)),
      h('div', { class: 'form-grid' }, field(t('kpi.unit'), unit), field(t('kpi.direction'), dir)),
      h('div', { class: 'form-grid' }, field(t('kpi.target'), target), field(t('kpi.frequency'), freq)),
      field(t('kpi.source'), src),
      h('label', { class: 'check' }, active, ' ', t('field.active')),
    ),
    onSubmit: async () => {
      const body = { code: code.value, name_ar: nameAr.value, name_en: nameEn.value, chapter: chapter.value, std_code: std.value, department_id: dept.value ? Number(dept.value) : null, num_ar: numAr.value, den_ar: denAr.value, unit: unit.value, direction: dir.value, target: target.value, frequency: freq.value, source: src.value, active: active.checked };
      await api(k ? '/kpis/' + k.id : '/kpis', { method: k ? 'PUT' : 'POST', body });
      toast(t('capa.saved'));
      render();
    },
  });
}

function libraryDialog(d) {
  const boxes = d.library.map((x) => {
    const c = input({ type: 'checkbox', checked: true, value: x.code });
    return h('label', { class: 'check' }, c, ' ', pick(x.name_ar, x.name_en), h('span', { class: 'muted small' }, ' · ' + (x.auto ? t('kpi.auto') : t('kpi.unit.' + x.unit))));
  });
  openDialog({
    title: t('kpi.library'),
    body: h('div', { class: 'stack kpi-lib' }, boxes),
    submitLabel: t('kpi.library_add'),
    onSubmit: async () => {
      const codes = boxes.map((b) => b.querySelector('input')).filter((c) => c.checked).map((c) => c.value);
      const r = await api('/kpis/library', { method: 'POST', body: { codes } });
      toast(t('kpi.library_added', { n: r.added }));
      render();
    },
  });
}

/* ------------------------------ readiness report --------------------------- */

export async function readinessPage(root, param, alive) {
  let d;
  try {
    d = await api('/readiness' + (param ? '?framework=' + encodeURIComponent(param) : ''));
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const T = d.total;
  const pctFmt = (v) => Math.round(v) + '%';
  const chapterRow = (c) =>
    h(
      'tr',
      {},
      h('td', { class: 'wrap-cell' }, c.code ? [h('span', { class: 'mono' }, c.code), ' · '] : '', pick(c.name_ar, c.name_en)),
      h('td', { class: 'mono' }, String(c.n)),
      h('td', { class: 'kpi-meter-cell' }, meter(c.pct, pick(c.name_ar, c.name_en)), h('span', { class: 'mono small', dir: 'ltr' }, c.pct === null ? '-' : c.pct + '%')),
      h('td', { class: 'mono' }, String(c.met)),
      h('td', { class: 'mono' }, String(c.partial)),
      h('td', { class: 'mono' }, String(c.not_met)),
      h('td', { class: 'mono' }, String(c.open)),
      d.has_esr ? h('td', { class: 'mono' + (c.esr_gap ? ' strong' : '') }, String(c.esr_gap || 0)) : '',
    );
  const head = (first) => h('thead', {}, h('tr', {}, [first, 'rdy.n_std', 'qa.readiness', 'qa.score.met', 'qa.score.partial', 'qa.score.not_met', 'qa.score.open', ...(d.has_esr ? ['rdy.esr_gap'] : [])].map((c) => h('th', { scope: 'col' }, t(c)))));
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.readiness')), h('p', { class: 'muted' }, pick(d.frameworks.find((f) => f.key === d.framework).name_ar, d.frameworks.find((f) => f.key === d.framework).name_en))),
      h('div', { class: 'actions no-print' }, h('button', { type: 'button', class: 'btn', onclick: () => window.print() }, icon('file'), t('rep.print'))),
    ),
    d.frameworks.length > 1
      ? h('nav', { class: 'qa-fw-tabs no-print' }, d.frameworks.map((f) => link('reports/readiness/' + f.key, { class: 'qa-fw-tab' + (f.key === d.framework ? ' is-active' : '') }, pick(f.name_ar, f.name_en))))
      : '',
    kpiRow([
      ['qa.readiness', T.pct === null ? '-' : T.pct + '%'],
      ['rdy.n_std', T.n],
      ['qa.score.met', T.met],
      ['rdy.gaps', T.partial + T.not_met],
      ['qa.score.open', T.open],
      ...(d.has_esr ? [['rdy.esr_gap', T.esr_gap]] : []),
    ]),
    h(
      'section',
      { class: 'panel' },
      panelHead(t('rdy.trend')),
      trendChart(
        d.trend.map((x) => ({ period: x.month, value: x.pct })),
        { target: 80, pct: true, fmt: pctFmt, xLabel: (p, long) => periodLabel(p.period, !long), label: t('rdy.trend') },
      ),
    ),
    h('section', { class: 'panel' }, panelHead(t('rdy.by_chapter')), d.chapters.length ? h('div', { class: 'table-scroll' }, h('table', {}, head('qa.chapter'), h('tbody', {}, d.chapters.map(chapterRow)))) : h('p', { class: 'empty' }, t('rdy.no_std'))),
    d.departments.length
      ? h(
          'section',
          { class: 'panel' },
          panelHead(t('rdy.by_dept')),
          h(
            'div',
            { class: 'table-scroll' },
            h('table', {}, head('user.department'), h('tbody', {}, d.departments.map((x) => chapterRow({ ...x, code: '', name_ar: x.name_ar, name_en: x.name_en })))),
          ),
        )
      : '',
    h(
      'section',
      { class: 'panel' },
      panelHead(t('rdy.gaps_list'), String(d.gaps.length)),
      d.gaps.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['qa.code', 'qa.standard', 'user.department', 'qa.score'].map((c) => h('th', { scope: 'col' }, t(c))))),
              h(
                'tbody',
                {},
                d.gaps.map((g) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, h('span', { class: 'mono', dir: 'ltr' }, g.code), g.esr ? h('span', { class: 'tag tag-esr' }, ' ESR') : ''),
                    h('td', { class: 'wrap-cell' }, pick(g.title_ar, g.title_en)),
                    h('td', {}, pick(g.dept_ar, g.dept_en) || h('span', { class: 'muted' }, '-')),
                    h('td', {}, scoreChip(g.score)),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('rdy.no_gaps')),
    ),
  );
}
