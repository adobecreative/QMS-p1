// Patient experience: the public page from a place's QR code (complaint, suggestion, thanks, or the survey) and its
// tracking link; for quality the register, one complaint (send for a reply, close with what the patient is told),
// the report, and the settings (deadlines and survey questions).
import { render } from '../app.js';
import { kpiRow } from './assets.js';
import { S, h, icon, t } from './core.js';
import { link, printHead, setUrl } from './layout.js';
import { api, dateEl, errText, errorBox, field, input, openDialog, select, toast } from './offline.js';
import { fmtTime, pick, publicShell, simpleDelete } from './tickets.js';

const KINDS = ['complaint', 'suggestion', 'praise'];
const STATUS = ['new', 'routed', 'replied', 'closed'];
const ST_CHIP = { new: 'chip-expired', routed: 'chip-near', replied: 'chip-review', closed: 'chip-valid' };
const KIND_CHIP = { complaint: 'chip-expired', suggestion: 'chip-review', praise: 'chip-valid' };
const stChip = (s) => h('span', { class: 'chip ' + ST_CHIP[s] }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('pex.st.' + s));
const kindChip = (k) => h('span', { class: 'chip ' + KIND_CHIP[k] }, t('pex.kind.' + k));
const kv = (label, value) => (value === '' || value === null || value === undefined ? null : h('div', { class: 'kv' }, h('dt', {}, label), h('dd', {}, value)));
const para = (v) => h('span', { class: 'pre-wrap', dir: 'auto' }, v);
const here = (path) => {
  S.route = path;
  setUrl(path);
};

/* ------------------------------- public page ------------------------------- */

// /feedback?loc=<code>: what the patient wants to do, then the form or the survey.
export async function feedbackPage() {
  const code = new URLSearchParams(location.search).get('loc') || '';
  let meta;
  try {
    meta = await api('/public/pex/form' + (code ? '?loc=' + encodeURIComponent(code) : ''));
  } catch (e) {
    return publicShell(h('h1', {}, t('pex.title')), errorBox(e));
  }
  const box = h('div', {});
  const title = h('h1', {}, meta.location ? pick(meta.location.name_ar, meta.location.name_en) : t('pex.title'));
  const choose = () =>
    box.replaceChildren(
      h(
        'div',
        { class: 'qr-choices' },
        h('button', { type: 'button', class: 'qr-choice qr-choice-main', onclick: () => survey() }, icon('award', 28), h('span', { class: 'strong' }, t('pex.survey')), h('span', { class: 'small' }, t('pex.survey_hint'))),
        h('button', { type: 'button', class: 'qr-choice', onclick: () => form() }, icon('users', 28), h('span', { class: 'strong' }, t('pex.write')), h('span', { class: 'small' }, t('pex.write_hint'))),
      ),
    );
  const deptSel = () => (meta.location ? null : select([['', t('req.pick')], ...meta.departments.map((d) => [d.id, pick(d.name_ar, d.name_en)])], '', { required: true }));
  const form = () => {
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const kinds = h(
      'fieldset',
      { class: 'cat-pick' },
      h('legend', {}, t('pex.kind')),
      h(
        'div',
        { class: 'cat-options' },
        KINDS.map((k, i) => h('label', { class: 'cat-option', for: 'pk-' + k }, input({ type: 'radio', name: 'kind', value: k, id: 'pk-' + k, required: true, checked: i === 0 }), h('span', {}, t('pex.kind.' + k)))),
      ),
    );
    const cat = select(meta.categories.map((c) => [c, t('pex.cat.' + c)]), 'other');
    const dept = deptSel();
    const desc = h('textarea', { rows: 5, maxlength: 3000, required: true, dir: 'auto' });
    const name = input({ type: 'text', maxlength: 120, autocomplete: 'name' });
    const phone = input({ type: 'tel', maxlength: 20, dir: 'ltr', inputmode: 'tel', autocomplete: 'tel' });
    const mrn = input({ type: 'text', maxlength: 40, dir: 'ltr', autocomplete: 'off' });
    const trap = input({ type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', class: 'visually-hidden', 'aria-hidden': 'true' });
    const catField = field(t('pex.category'), cat);
    const sync = () => {
      const k = kinds.querySelector('input:checked').value;
      catField.hidden = k !== 'complaint';
      name.required = phone.required = k === 'complaint';
    };
    kinds.addEventListener('change', sync);
    const f = h(
      'form',
      { class: 'stack', novalidate: false },
      kinds,
      catField,
      dept ? field(t('ovr.dept'), dept) : '',
      field(t('pex.desc'), desc),
      h('div', { class: 'form-grid' }, field(t('pex.name'), name), field(t('pex.phone'), phone)),
      field(t('pex.mrn'), mrn),
      trap,
      err,
      h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, t('pex.send')),
      h('button', { type: 'button', class: 'btn btn-block', onclick: choose }, t('common.cancel')),
    );
    sync();
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      err.hidden = true;
      const btn = f.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        const k = kinds.querySelector('input:checked').value;
        const r = await api('/public/pex', {
          method: 'POST',
          body: { kind: k, category: k === 'complaint' ? cat.value : 'other', department_id: dept && dept.value ? Number(dept.value) : null, loc: code, description: desc.value, patient_name: name.value, phone: phone.value, patient_mrn: mrn.value, website: trap.value },
        });
        const track = 'pex-track/' + r.id + '/' + r.track;
        box.replaceChildren(h('div', { class: 'stack' }, h('p', { class: 'notice' }, t('pex.sent', { n: r.id })), k === 'complaint' ? link(track, { class: 'btn btn-primary btn-block' }, t('ovr.follow')) : '', h('a', { class: 'btn btn-block', href: location.pathname + location.search }, t('pex.done'))));
        window.scrollTo(0, 0);
      } catch (e) {
        err.textContent = errText(e);
        err.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
    box.replaceChildren(f);
  };
  const survey = () => {
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const answers = {};
    const dept = deptSel();
    const comment = h('textarea', { rows: 3, maxlength: 1000, dir: 'auto' });
    const rows = meta.questions.map((q) =>
      h(
        'fieldset',
        { class: 'svy-q' },
        h('legend', {}, pick(q.text_ar, q.text_en)),
        h(
          'div',
          { class: 'svy-scale', dir: 'ltr' },
          [1, 2, 3, 4, 5].map((v) =>
            h('label', { class: 'svy-opt svy-' + v }, input({ type: 'radio', name: 'q' + q.id, value: v, onchange: () => (answers[q.id] = v) }), h('span', { 'aria-hidden': 'true' }, ['😞', '🙁', '😐', '🙂', '😀'][v - 1]), h('span', { class: 'small' }, t('pex.sc.' + v))),
          ),
        ),
      ),
    );
    const f = h('form', { class: 'stack' }, dept ? field(t('ovr.dept'), dept) : '', ...rows, field(t('pex.comment'), comment), err, h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, t('pex.send')), h('button', { type: 'button', class: 'btn btn-block', onclick: choose }, t('common.cancel')));
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      err.hidden = true;
      try {
        await api('/public/pex/survey', { method: 'POST', body: { loc: code, department_id: dept && dept.value ? Number(dept.value) : null, answers, comment: comment.value } });
        box.replaceChildren(h('div', { class: 'stack' }, h('p', { class: 'notice' }, t('pex.thanks')), h('a', { class: 'btn btn-block', href: location.pathname + location.search }, t('pex.done'))));
        window.scrollTo(0, 0);
      } catch (e) {
        err.textContent = errText(e);
        err.hidden = false;
      }
    });
    box.replaceChildren(f);
  };
  choose();
  return publicShell(title, box);
}

// #/pex-track/<id>/<token>
export async function pexTrackPage(id, token) {
  let d;
  try {
    d = await api('/public/pex/' + id + '?k=' + token);
  } catch (e) {
    return publicShell(h('h1', {}, t('pex.track', { n: id })), errorBox(e));
  }
  const p = d.pex;
  return publicShell(
    h('h1', {}, t('pex.track', { n: id })),
    h(
      'dl',
      { class: 'kv-list' },
      kv(t('ovr.status'), p.status === 'closed' ? stChip('closed') : h('span', { class: 'chip chip-near' }, t('pex.in_progress'))),
      kv(t('ovr.sent_at'), fmtTime(p.created_at)),
      kv(t('ovr.closed_at'), p.closed_at ? fmtTime(p.closed_at) : ''),
      kv(t('pex.resolution'), p.resolution ? para(p.resolution) : ''),
    ),
  );
}

/* --------------------------------- register -------------------------------- */

// pex/pexs, or pex/pexs/12 for one.
export async function pexListPage(root, param, alive) {
  if (param) return pexDetail(root, param, alive);
  let d;
  try {
    d = await api('/pex');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const f = (S.pexF = S.pexF || { q: '', kind: 'complaint', status: 'open' });
  const search = input({ type: 'search', class: 'doc-search-input', value: f.q, placeholder: t('pex.search_ph'), 'aria-label': t('pex.search_ph'), autocomplete: 'off' });
  const pickKind = select([['', t('capa.all')], ...KINDS.map((k) => [k, t('pex.kinds.' + k)])], f.kind, { 'aria-label': t('pex.kind') });
  const pickSt = select([['open', t('ovr.open_only')], ['', t('capa.all')], ...STATUS.map((s) => [s, t('pex.st.' + s)])], f.status, { 'aria-label': t('ovr.status') });
  const box = h('div', {});
  const norm = (v) => String(v || '').toLowerCase();
  const draw = () => {
    const q = norm(f.q.trim());
    const rows = d.pex.filter((p) => (!f.kind || p.kind === f.kind) && (f.status === 'open' ? p.status !== 'closed' : !f.status || p.status === f.status) && (!q || ['#' + p.id, p.description, p.dept_ar, p.dept_en, p.loc_ar].some((v) => norm(v).includes(q))));
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
                h('thead', {}, h('tr', {}, ['ovr.no', 'pex.desc', 'ovr.dept', 'ovr.due', 'ovr.status'].map((c) => h('th', { scope: 'col' }, t(c))))),
                h(
                  'tbody',
                  {},
                  rows.map((p) =>
                    h(
                      'tr',
                      {},
                      h('td', {}, link('pex/pexs/' + p.id, { class: 'mono strong', dir: 'ltr' }, '#' + p.id), h('div', { class: 'small muted' }, fmtTime(p.created_at))),
                      h('td', { class: 'wrap-cell' }, h('div', {}, kindChip(p.kind), p.kind === 'complaint' ? h('span', { class: 'small muted' }, ' ' + t('pex.cat.' + p.category)) : ''), h('div', { class: 'small' }, p.description.slice(0, 160))),
                      h('td', {}, pick(p.dept_ar, p.dept_en) || pick(p.loc_ar, p.loc_en) || '-'),
                      h('td', {}, p.due ? h('span', {}, dateEl(p.due), p.late ? h('span', { class: 'note note-expired' }, ' ', t('rnd.late')) : '') : '-'),
                      h('td', {}, stChip(p.status), p.to_name ? h('div', { class: 'small muted' }, pick(p.to_name, p.to_name_en)) : ''),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty' }, d.pex.length ? t('capa.no_match') : t('pex.empty')),
      ),
    );
  };
  search.addEventListener('input', () => ((f.q = search.value), draw()));
  pickKind.addEventListener('change', () => ((f.kind = pickKind.value), draw()));
  pickSt.addEventListener('change', () => ((f.status = pickSt.value), draw()));
  const open = d.pex.filter((p) => p.kind === 'complaint' && p.status !== 'closed');
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.pexs'))),
      d.role.officer ? h('div', { class: 'actions' }, h('a', { class: 'btn btn-primary', href: '/feedback' }, icon('plus'), t('pex.add'))) : '',
    ),
    d.role.viewer
      ? kpiRow([
          ['pex.k_new', open.filter((p) => p.status === 'new').length],
          ['pex.k_open', open.length],
          ['pex.k_late', open.filter((p) => p.late).length],
          ['pex.k_praise', d.pex.filter((p) => p.kind === 'praise').length],
        ])
      : '',
    h('div', { class: 'filters' }, h('div', { class: 'doc-search', role: 'search' }, icon('search'), search), d.role.viewer ? pickKind : '', pickSt),
    box,
  );
  draw();
}

async function pexDetail(root, id, alive) {
  let d;
  try {
    d = await api('/pex/' + id);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const p = d.pex;
  const can = p.can;
  const actions = [];
  if (can.route) actions.push(h('button', { type: 'button', class: 'btn' + (p.status === 'new' ? ' btn-primary' : ''), onclick: () => routeDialog(p) }, icon('users'), t('pex.route')));
  if (can.reply) actions.push(h('button', { type: 'button', class: 'btn btn-primary', onclick: () => replyDialog(p) }, icon('edit'), t('pex.reply')));
  if (can.close) actions.push(h('button', { type: 'button', class: 'btn' + (p.status !== 'new' ? ' btn-primary' : ''), onclick: () => closeDialog(p) }, icon('check'), t('pex.close')));
  if (can.reopen) actions.push(h('button', { type: 'button', class: 'btn', onclick: async () => (await api('/pex/' + p.id + '/close', { method: 'POST', body: { reopen: true } }), toast(t('capa.saved')), render()) }, t('risk.reopen')));
  actions.push(h('button', { type: 'button', class: 'btn', onclick: () => window.print() }, icon('file'), t('rep.print')));
  if (can.delete) actions.push(h('button', { type: 'button', class: 'btn', 'aria-label': t('common.delete'), onclick: () => simpleDelete(t('pex.delete_q'), '/pex/' + p.id, t('capa.deleted'), () => (here('pex/pexs'), render())) }, icon('trash')));
  root.replaceChildren(
    printHead(),
    h('p', { class: 'no-print' }, link('pex/pexs', {}, '← ' + t('nav.pexs'))),
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, '#' + p.id + ' · ', t('pex.kind.' + p.kind)), h('p', {}, stChip(p.status), ' ', p.due ? h('span', { class: 'small muted' }, t('ovr.due'), ' ', dateEl(p.due), p.late ? h('span', { class: 'note note-expired' }, ' ', t('rnd.late')) : '') : '')), h('div', { class: 'actions no-print' }, actions)),
    h(
      'section',
      { class: 'panel pad' },
      h(
        'dl',
        { class: 'kv-list' },
        kv(t('pex.category'), p.kind === 'complaint' ? t('pex.cat.' + p.category) : ''),
        kv(t('ovr.dept'), pick(p.dept_ar, p.dept_en)),
        kv(t('ovr.place'), pick(p.loc_ar, p.loc_en)),
        kv(t('pex.desc'), para(p.description)),
        kv(t('pex.name'), p.patient_name),
        kv(t('pex.phone'), p.phone ? h('a', { href: 'tel:' + p.phone, dir: 'ltr' }, p.phone) : ''),
        kv(t('pex.mrn'), p.patient_mrn ? h('span', { dir: 'ltr' }, p.patient_mrn) : ''),
        kv(t('ovr.sent_at'), fmtTime(p.created_at) + (p.created_by ? ' · ' + p.created_by : '')),
      ),
    ),
    p.routed_to
      ? h(
          'section',
          { class: 'panel pad' },
          h('dl', { class: 'kv-list' }, kv(t('pex.sent_to'), pick(p.to_name, p.to_name_en)), kv(t('ovr.note'), p.route_note ? para(p.route_note) : ''), kv(t('pex.reply'), p.reply ? para(p.reply) : h('span', { class: 'muted' }, t('pex.waiting'))), kv(t('pex.replied_by'), p.replied_at ? p.replied_by + ' · ' + fmtTime(p.replied_at) : '')),
        )
      : '',
    p.status === 'closed' ? h('section', { class: 'panel pad' }, h('dl', { class: 'kv-list' }, kv(t('pex.resolution'), p.resolution ? para(p.resolution) : '-'), kv(t('ovr.closed_at'), fmtTime(p.closed_at) + ' · ' + p.closed_by))) : '',
  );
}

async function routeDialog(p) {
  const { people } = await api('/pex/people');
  const to = select([['', t('req.pick')], ...people.map((x) => [x.id, pick(x.name, x.name_en) + (x.dept_ar ? ' - ' + pick(x.dept_ar, x.dept_en) : '')])], p.routed_to || '', { required: true });
  const note = h('textarea', { rows: 3, maxlength: 1000, dir: 'auto' });
  openDialog({
    title: t('pex.route'),
    body: h('div', { class: 'stack' }, field(t('pex.sent_to'), to), field(t('ovr.note'), note)),
    onSubmit: async () => {
      await api('/pex/' + p.id + '/route', { method: 'POST', body: { user_id: Number(to.value), note: note.value } });
      toast(t('capa.saved'));
      render();
    },
  });
}
function replyDialog(p) {
  const reply = h('textarea', { rows: 5, maxlength: 3000, required: true, dir: 'auto' });
  openDialog({
    title: t('pex.reply'),
    body: field(t('pex.reply'), reply),
    onSubmit: async () => {
      await api('/pex/' + p.id + '/reply', { method: 'POST', body: { reply: reply.value } });
      toast(t('capa.saved'));
      render();
    },
  });
}
function closeDialog(p) {
  const res = h('textarea', { rows: 4, maxlength: 3000, required: p.kind === 'complaint', dir: 'auto' }, p.reply || '');
  openDialog({
    title: t('pex.close'),
    body: field(t('pex.resolution'), res),
    onSubmit: async () => {
      await api('/pex/' + p.id + '/close', { method: 'POST', body: { resolution: res.value } });
      toast(t('capa.saved'));
      render();
    },
  });
}

/* --------------------------------- report --------------------------------- */

export async function pexReportPage(root, _param, alive) {
  const f = S.pexRep || {};
  let d;
  try {
    const q = new URLSearchParams();
    if (f.from) q.set('from', f.from);
    if (f.to) q.set('to', f.to);
    d = await api('/pex/report' + (q.toString() ? '?' + q : ''));
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const T = d.totals;
  const monthName = (m, short) => {
    try {
      return new Intl.DateTimeFormat(S.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { month: short ? 'short' : 'long', year: short ? '2-digit' : 'numeric', timeZone: 'UTC' }).format(new Date(m + '-01T00:00:00Z'));
    } catch {
      return m;
    }
  };
  const months = [];
  for (let m = d.this_month, i = 0; i < 36; i++) {
    months.push(m);
    const [y, mm] = m.split('-').map(Number);
    m = mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, '0')}`;
  }
  const fromSel = select(months.map((m) => [m, monthName(m)]), d.from, { 'aria-label': t('ovr.rep_from') });
  const toSel = select(months.map((m) => [m, monthName(m)]), d.to, { 'aria-label': t('ovr.rep_to') });
  const set = (k, v) => ((S.pexRep = { from: d.from, to: d.to, [k]: v }), render());
  fromSel.addEventListener('change', () => set('from', fromSel.value));
  toSel.addEventListener('change', () => set('to', toSel.value));
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '-');
  const top = (title, rows, label) =>
    h(
      'div',
      { class: 'panel rep-top' },
      h('h3', {}, t(title)),
      rows.length
        ? h(
            'ol',
            {},
            rows.map((r) => {
              const max = Math.max(1, ...rows.map((x) => x.n));
              return h('li', {}, h('span', { class: 'rep-top-name' }, label ? label(r) : pick(r.name_ar, r.name_en)), h('span', { class: 'rep-bar', 'aria-hidden': 'true' }, h('span', { style: `width:${r.n ? Math.max(4, Math.round((r.n / max) * 100)) : 0}%` })), h('span', { class: 'mono', dir: 'ltr' }, String(r.n)));
            }),
          )
        : h('p', { class: 'muted small rep-none' }, t('rep.none')),
    );
  const max = Math.max(1, ...d.months.map((x) => x.n));
  const trend = h(
    'div',
    { class: 'panel rep-trend' },
    h('h3', {}, t('pex.rep_trend')),
    h('div', { class: 'rep-columns', role: 'list' }, d.months.map((x) => h('div', { class: 'rep-col', role: 'listitem', 'aria-label': monthName(x.m) + ': ' + x.n }, h('span', { class: 'mono small', dir: 'ltr' }, String(x.n)), h('span', { class: 'rep-col-bar', style: `height:${x.n ? Math.max(4, Math.round((x.n / max) * 120)) : 2}px` }), h('span', { class: 'small muted' }, monthName(x.m, true))))),
  );
  requestAnimationFrame(() => {
    const cols = trend.querySelector('.rep-columns');
    if (cols) cols.scrollLeft = (getComputedStyle(cols).direction === 'rtl' ? -1 : 1) * cols.scrollWidth;
  });
  root.replaceChildren(
    printHead(),
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.pexrep')), h('p', { class: 'muted' }, d.from === d.to ? monthName(d.from) : monthName(d.from) + ' - ' + monthName(d.to))),
      h('div', { class: 'actions no-print' }, fromSel, toSel, h('button', { type: 'button', class: 'btn', onclick: () => window.print() }, icon('file'), t('rep.print'))),
    ),
    kpiRow([
      ['pex.rep_sat', pct(T.satisfied, T.answers)],
      ['pex.rep_responses', T.responses],
      ['pex.kinds.complaint', T.complaints],
      ['pex.rep_ontime', pct(T.on_time, T.closed)],
      ['ovr.rep_days', T.avg_days === null ? '-' : T.avg_days],
      ['pex.kinds.suggestion', T.suggestions],
      ['pex.kinds.praise', T.praise],
    ]),
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('pex.rep_by_q')))),
      d.questions.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['pex.question', 'pex.rep_avg', 'pex.rep_sat', 'pex.rep_n'].map((c) => h('th', { scope: 'col' }, t(c))))),
              h('tbody', {}, d.questions.map((q) => h('tr', {}, h('td', { class: 'wrap-cell' }, pick(q.text_ar, q.text_en)), h('td', { class: 'mono', dir: 'ltr' }, q.avg === null ? '-' : q.avg + ' / 5'), h('td', { class: 'kpi-meter-cell' }, h('span', { class: 'mono small', dir: 'ltr' }, q.pct === null ? '-' : q.pct + '%')), h('td', { class: 'mono' }, String(q.n))))),
            ),
          )
        : h('p', { class: 'empty' }, t('rep.none')),
    ),
    trend,
    h('div', { class: 'rep-tops' }, top('pex.rep_by_cat', d.categories, (r) => t('pex.cat.' + r.k)), top('ovr.rep_by_dept', d.departments)),
  );
}

/* -------------------------------- settings -------------------------------- */

export async function pexSettingsPage(root, _param, alive) {
  let d;
  try {
    d = await api('/pex/settings');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const reply = input({ type: 'number', min: 1, max: 30, required: true, value: d.reply_days, dir: 'ltr' });
  const close = input({ type: 'number', min: 1, max: 90, required: true, value: d.close_days, dir: 'ltr' });
  const form = h('form', { class: 'panel pad stack' }, h('div', { class: 'form-grid' }, field(t('pex.reply_days'), reply), field(t('pex.close_days'), close)), h('div', {}, h('button', { type: 'submit', class: 'btn btn-primary' }, t('common.save'))));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/pex/settings', { method: 'PUT', body: { reply_days: Number(reply.value), close_days: Number(close.value) } });
      toast(t('capa.saved'));
    } catch (e) {
      toast(errText(e));
    }
  });
  const qDialog = (q) => {
    const ar = input({ type: 'text', required: true, maxlength: 200, dir: 'rtl', value: q ? q.text_ar : '' });
    const en = input({ type: 'text', required: true, maxlength: 200, dir: 'ltr', value: q ? q.text_en : '' });
    openDialog({
      title: q ? t('ivg.edit') : t('pex.q_add'),
      body: h('div', { class: 'stack' }, field(t('pex.q_ar'), ar), field(t('pex.q_en'), en)),
      onSubmit: async () => {
        await api(q ? '/pex/settings/questions/' + q.id : '/pex/settings/questions', { method: q ? 'PUT' : 'POST', body: { text_ar: ar.value, text_en: en.value } });
        render();
      },
    });
  };
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('nav.pexset')))),
    form,
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('pex.questions'))), h('button', { type: 'button', class: 'btn btn-small', onclick: () => qDialog(null) }, icon('plus'), t('pex.q_add'))),
      h(
        'div',
        { class: 'table-scroll' },
        h(
          'table',
          {},
          h(
            'tbody',
            {},
            d.questions.map((q) =>
              h(
                'tr',
                { class: q.active ? '' : 'muted' },
                h('td', { class: 'wrap-cell' }, pick(q.text_ar, q.text_en)),
                h(
                  'td',
                  { class: 'nowrap' },
                  h('button', { type: 'button', class: 'btn btn-small', onclick: () => qDialog(q) }, icon('edit')),
                  ' ',
                  h('button', { type: 'button', class: 'btn btn-small', onclick: async () => (await api('/pex/settings/questions/' + q.id, { method: 'PUT', body: { active: !q.active } }), render()) }, t(q.active ? 'pex.q_off' : 'pex.q_on')),
                  ' ',
                  h('button', { type: 'button', class: 'btn btn-small', 'aria-label': t('common.delete'), onclick: () => simpleDelete(t('pex.q_delete'), '/pex/settings/questions/' + q.id, t('capa.deleted'), () => render()) }, icon('trash')),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
