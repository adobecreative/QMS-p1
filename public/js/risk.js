// Risk register (heat map, list, one risk with its reviews and actions) and FMEA (list and the worksheet).
import { render } from '../app.js';
import { kpiRow } from './assets.js';
import { S, h, icon, t } from './core.js';
import { link, printHead, setUrl } from './layout.js';
import { api, dateEl, errorBox, field, input, openDialog, select, toast } from './offline.js';
import { fmtTime, pick, simpleDelete } from './tickets.js';

export const RISK_CATS = ['clinical', 'patient_safety', 'medication', 'infection', 'facility', 'equipment', 'staff', 'it', 'financial', 'legal', 'reputation'];
const RESPONSES = ['mitigate', 'accept', 'transfer', 'avoid'];
const level = (score) => (score >= 15 ? 'critical' : score >= 10 ? 'high' : score >= 5 ? 'medium' : 'low');
const levelChip = (lv, score) => h('span', { class: 'chip risk-' + lv }, t('risk.lv.' + lv), score ? h('span', { class: 'mono', dir: 'ltr' }, ' ' + score) : '');
const kv = (label, value) => (value === '' || value === null || value === undefined ? null : h('div', { class: 'kv' }, h('dt', {}, label), h('dd', {}, value)));
const para = (v) => h('span', { class: 'pre-wrap', dir: 'auto' }, v);
const here = (path) => {
  S.route = path;
  setUrl(path);
};
const personOpt = (p) => [p.id, pick(p.name, p.name_en) + (p.dept_ar ? ' - ' + pick(p.dept_ar, p.dept_en) : '')];
const scaleSel = (kind, v, max) => select([['', '-'], ...Array.from({ length: max }, (_, i) => [i + 1, i + 1 + (max === 5 ? ' - ' + t('risk.' + kind + '.' + (i + 1)) : '')])], v || '', { 'aria-label': t('risk.' + kind) });

/* --------------------------------- heat map -------------------------------- */

// Likelihood down the side (5 at the top), impact along the bottom; each cell the number of open risks.
function heatMap(list, onPick) {
  const grid = Array.from({ length: 5 }, () => Array(5).fill(0));
  for (const r of list) grid[r.likelihood - 1][r.impact - 1] += 1;
  const rows = [];
  for (let l = 5; l >= 1; l--) {
    rows.push(h('span', { class: 'heat-axis small muted' }, String(l)));
    for (let i = 1; i <= 5; i++) {
      const n = grid[l - 1][i - 1];
      rows.push(
        h(
          'button',
          { type: 'button', class: 'heat-cell risk-' + level(l * i) + (n ? '' : ' is-empty'), 'aria-label': `${t('risk.likelihood')} ${l} · ${t('risk.impact')} ${i}: ${n}`, onclick: () => onPick(l, i) },
          n ? String(n) : '',
        ),
      );
    }
  }
  rows.push(h('span', {}), ...[1, 2, 3, 4, 5].map((i) => h('span', { class: 'heat-axis small muted' }, String(i))));
  return h(
    'div',
    { class: 'heat-wrap' },
    h('span', { class: 'heat-label-y small muted' }, t('risk.likelihood')),
    h('div', { class: 'heat', dir: 'ltr' }, rows),
    h('span', { class: 'heat-label-x small muted' }, t('risk.impact')),
  );
}

/* --------------------------------- register -------------------------------- */

// risk/risks, or risk/risks/12 for one risk.
export async function riskListPage(root, param, alive) {
  if (param) return riskDetail(root, param, alive);
  let d;
  try {
    d = await api('/risk');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const can = d.role.officer || !!d.role.dept;
  const f = (S.riskF = S.riskF || { q: '', status: 'open', level: '', dept: '', cell: null });
  const search = input({ type: 'search', class: 'doc-search-input', value: f.q, placeholder: t('risk.search_ph'), 'aria-label': t('risk.search_ph'), autocomplete: 'off' });
  const pickSt = select([['open', t('risk.st.open')], ['closed', t('risk.st.closed')], ['', t('capa.all')]], f.status, { 'aria-label': t('ovr.status') });
  const pickLv = select([['', t('risk.all_levels')], ...['critical', 'high', 'medium', 'low'].map((x) => [x, t('risk.lv.' + x)])], f.level, { 'aria-label': t('risk.level') });
  const pickDept = d.role.viewer ? select([['', t('ovr.rep_all_depts')], ...d.departments.map((x) => [x.id, pick(x.name_ar, x.name_en)])], f.dept, { 'aria-label': t('user.department') }) : null;
  const box = h('div', {});
  const cellNote = h('div', {});
  const norm = (v) => String(v || '').toLowerCase();
  const draw = () => {
    const q = norm(f.q.trim());
    const rows = d.risks.filter(
      (r) =>
        (!f.status || r.status === f.status) &&
        (!f.level || r.level === f.level) &&
        (!f.dept || String(r.department_id) === String(f.dept)) &&
        (!f.cell || (r.likelihood === f.cell[0] && r.impact === f.cell[1])) &&
        (!q || [r.code, r.title, r.owner_name, r.dept_ar, r.dept_en].some((v) => norm(v).includes(q))),
    );
    cellNote.replaceChildren(
      f.cell
        ? h('p', { class: 'small' }, h('span', { class: 'tag' }, `${t('risk.likelihood')} ${f.cell[0]} × ${t('risk.impact')} ${f.cell[1]}`), ' ', h('button', { type: 'button', class: 'btn btn-small', onclick: () => ((f.cell = null), draw()) }, '×'))
        : '',
    );
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
                h('thead', {}, h('tr', {}, ['risk.code', 'risk.risk', 'ovr.dept', 'risk.owner', 'risk.level', 'risk.next_review'].map((c) => h('th', { scope: 'col' }, t(c))))),
                h(
                  'tbody',
                  {},
                  rows.map((r) =>
                    h(
                      'tr',
                      {},
                      h('td', {}, link('risk/risks/' + r.id, { class: 'mono strong', dir: 'ltr' }, r.code)),
                      h('td', { class: 'wrap-cell' }, h('div', {}, r.title), h('div', { class: 'small muted' }, t('risk.cat.' + r.category), r.open_actions ? ' · ' + t('risk.n_open_actions', { n: r.open_actions }) : '')),
                      h('td', {}, pick(r.dept_ar, r.dept_en) || '-'),
                      h('td', {}, pick(r.owner_name, r.owner_name_en) || '-'),
                      h('td', {}, levelChip(r.level, r.score), r.res_level ? h('div', { class: 'small muted' }, t('risk.residual'), ' ', h('span', { class: 'mono', dir: 'ltr' }, String(r.res_score))) : ''),
                      h('td', {}, r.status === 'open' && r.next_review ? h('span', {}, dateEl(r.next_review), r.review_late ? h('span', { class: 'note note-expired' }, ' ', t('rnd.late')) : '') : r.status === 'closed' ? t('risk.st.closed') : '-'),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty' }, d.risks.length ? t('capa.no_match') : t('risk.empty')),
      ),
    );
  };
  search.addEventListener('input', () => ((f.q = search.value), draw()));
  pickSt.addEventListener('change', () => ((f.status = pickSt.value), draw()));
  pickLv.addEventListener('change', () => ((f.level = pickLv.value), draw()));
  if (pickDept) pickDept.addEventListener('change', () => ((f.dept = pickDept.value), draw()));
  const open = d.risks.filter((r) => r.status === 'open');
  const suggest = d.suggestions.length
    ? h(
        'section',
        { class: 'panel' },
        h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('risk.suggest')))),
        h(
          'ul',
          { class: 'risk-suggest' },
          d.suggestions.map((s) =>
            h(
              'li',
              {},
              h('span', {}, pick(s.name_ar, s.name_en), ' ', h('span', { class: 'muted small' }, t('risk.suggest_n', { n: s.n }))),
              h('button', { type: 'button', class: 'btn btn-small', onclick: () => riskDialog(null, d, { title: pick(s.name_ar, s.name_en), ovr_cat_id: s.id, chapter: s.chapter }) }, icon('plus'), t('risk.add')),
            ),
          ),
        ),
      )
    : '';
  root.replaceChildren(
    printHead(),
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.risks'))),
      h(
        'div',
        { class: 'actions no-print' },
        h('button', { type: 'button', class: 'btn', onclick: () => window.print() }, icon('file'), t('rep.print')),
        can ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => riskDialog(null, d) }, icon('plus'), t('risk.add')) : '',
      ),
    ),
    kpiRow([
      ['risk.k_open', open.length],
      ['risk.lv.critical', open.filter((r) => r.level === 'critical').length],
      ['risk.lv.high', open.filter((r) => r.level === 'high').length],
      ['risk.k_late', open.filter((r) => r.review_late).length],
      ['risk.k_actions', open.reduce((n, r) => n + r.open_actions, 0)],
    ]),
    h(
      'div',
      { class: 'risk-top' },
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('risk.heat')))), heatMap(open, (l, i) => ((f.cell = [l, i]), (f.status = 'open'), (pickSt.value = 'open'), draw()))),
      suggest,
    ),
    h('div', { class: 'filters no-print' }, h('div', { class: 'doc-search', role: 'search' }, icon('search'), search), pickSt, pickLv, pickDept || ''),
    cellNote,
    box,
  );
  draw();
}

// Add or edit a risk. preset: from a suggestion (title, incident type, chapter).
async function riskDialog(r, d, preset) {
  const { people } = await api('/risk/people');
  const p = preset || {};
  const title = input({ type: 'text', required: true, maxlength: 200, dir: 'auto', value: r ? r.title : p.title || '' });
  const desc = h('textarea', { rows: 3, maxlength: 3000, dir: 'auto' }, r ? r.description : '');
  const cat = select([['', t('req.pick')], ...RISK_CATS.map((c) => [c, t('risk.cat.' + c)])], r ? r.category : '', { required: true });
  const dept = d.role.officer ? select([['', '-'], ...d.departments.map((x) => [x.id, pick(x.name_ar, x.name_en)])], r ? r.department_id || '' : '') : null;
  const chap = select([['', '-'], ...d.chapters.map((c) => [c.code, c.code + ' · ' + pick(c.name_ar, c.name_en)])], r ? r.chapter : p.chapter || '');
  const owner = select([['', '-'], ...people.map(personOpt)], r ? r.owner_id || '' : S.user.id);
  const like = scaleSel('likelihood', r && r.likelihood, 5);
  const imp = scaleSel('impact', r && r.impact, 5);
  like.required = imp.required = true;
  const now = h('div', { class: 'risk-now' });
  const showNow = () => now.replaceChildren(like.value && imp.value ? levelChip(level(like.value * imp.value), like.value * imp.value) : '');
  like.addEventListener('change', showNow);
  imp.addEventListener('change', showNow);
  showNow();
  const controls = h('textarea', { rows: 2, maxlength: 3000, dir: 'auto' }, r ? r.controls : '');
  const resp = select(RESPONSES.map((x) => [x, t('risk.resp.' + x)]), r ? r.response : 'mitigate');
  const rl = scaleSel('likelihood', r && r.res_likelihood, 5);
  const ri = scaleSel('impact', r && r.res_impact, 5);
  openDialog({
    title: r ? r.code : t('risk.add'),
    body: h(
      'div',
      { class: 'stack' },
      field(t('risk.risk'), title),
      field(t('risk.desc'), desc),
      h('div', { class: 'form-grid' }, field(t('risk.category'), cat), dept ? field(t('ovr.dept'), dept) : '', field(t('qa.chapter'), chap), field(t('risk.owner'), owner)),
      h('div', { class: 'form-grid' }, field(t('risk.likelihood'), like), field(t('risk.impact'), imp)),
      now,
      field(t('risk.controls'), controls),
      h('div', { class: 'form-grid' }, field(t('risk.response'), resp), field(t('risk.res_likelihood'), rl), field(t('risk.res_impact'), ri)),
    ),
    onSubmit: async () => {
      const body = {
        title: title.value, description: desc.value, category: cat.value, chapter: chap.value, owner_id: owner.value ? Number(owner.value) : null,
        likelihood: Number(like.value), impact: Number(imp.value), controls: controls.value, response: resp.value,
        res_likelihood: rl.value ? Number(rl.value) : null, res_impact: ri.value ? Number(ri.value) : null,
        ...(dept ? { department_id: dept.value ? Number(dept.value) : null } : {}),
        ...(p.ovr_cat_id ? { ovr_cat_id: p.ovr_cat_id } : {}),
      };
      const res = await api(r ? '/risk/' + r.id : '/risk', { method: r ? 'PUT' : 'POST', body });
      toast(t('capa.saved'));
      if (!r) here('risk/risks/' + res.id);
      render();
    },
  });
}

async function riskDetail(root, id, alive) {
  let d, meta;
  try {
    [d, meta] = await Promise.all([api('/risk/' + id), api('/risk')]);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const r = d.risk;
  const can = r.can;
  const actions = [];
  if (can.review) actions.push(h('button', { type: 'button', class: 'btn btn-primary', onclick: () => reviewDialog(r) }, icon('check'), t('risk.review')));
  if (can.edit) actions.push(h('button', { type: 'button', class: 'btn', onclick: () => actionDialog(r) }, icon('plus'), t('risk.add_action')));
  if (can.edit) actions.push(h('button', { type: 'button', class: 'btn', onclick: () => riskDialog(r, meta) }, icon('edit'), t('ivg.edit')));
  if (can.close)
    actions.push(
      h(
        'button',
        { type: 'button', class: 'btn', onclick: async () => (await api('/risk/' + r.id + '/close', { method: 'POST', body: { closed: r.status === 'open' } }), toast(t('capa.saved')), render()) },
        t(r.status === 'open' ? 'risk.close' : 'risk.reopen'),
      ),
    );
  actions.push(h('button', { type: 'button', class: 'btn', onclick: () => window.print() }, icon('file'), t('rep.print')));
  if (can.delete) actions.push(h('button', { type: 'button', class: 'btn', 'aria-label': t('common.delete'), onclick: () => simpleDelete(t('risk.delete_q'), '/risk/' + r.id, t('capa.deleted'), () => (here('risk/risks'), render())) }, icon('trash')));
  root.replaceChildren(
    printHead(),
    h('p', { class: 'no-print' }, link('risk/risks', {}, '← ' + t('nav.risks'))),
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, h('span', { class: 'mono', dir: 'ltr' }, r.code), ' ', r.title), h('p', {}, levelChip(r.level, r.score), r.status === 'closed' ? [' ', h('span', { class: 'chip chip-valid' }, t('risk.st.closed'))] : '')),
      h('div', { class: 'actions no-print' }, actions),
    ),
    h(
      'section',
      { class: 'panel pad' },
      h(
        'dl',
        { class: 'kv-list' },
        kv(t('risk.category'), t('risk.cat.' + r.category)),
        kv(t('ovr.dept'), pick(r.dept_ar, r.dept_en)),
        kv(t('qa.chapter'), r.chapter),
        kv(t('risk.owner'), pick(r.owner_name, r.owner_name_en)),
        kv(t('risk.rating'), `${t('risk.likelihood')} ${r.likelihood} × ${t('risk.impact')} ${r.impact} = ${r.score}`),
        kv(t('risk.residual'), r.res_score ? h('span', {}, levelChip(r.res_level, r.res_score)) : ''),
        kv(t('risk.response'), t('risk.resp.' + r.response)),
        kv(t('risk.next_review'), r.status === 'open' && r.next_review ? h('span', {}, dateEl(r.next_review), r.review_late ? h('span', { class: 'note note-expired' }, ' ', t('rnd.late')) : '') : ''),
        kv(t('risk.ovr_type'), pick(r.ovr_cat_ar, r.ovr_cat_en)),
        kv(t('risk.desc'), r.description ? para(r.description) : ''),
        kv(t('risk.controls'), r.controls ? para(r.controls) : ''),
      ),
    ),
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('risk.actions')), h('span', { class: 'muted small' }, String(r.actions.length)))),
      r.actions.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['capa.title', 'capa.owner', 'capa.due', 'ovr.status'].map((c) => h('th', { scope: 'col' }, t(c))))),
              h(
                'tbody',
                {},
                r.actions.map((a) =>
                  h('tr', {}, h('td', { class: 'wrap-cell' }, a.title), h('td', {}, a.owner || '-'), h('td', {}, a.due ? h('span', {}, dateEl(a.due), a.late ? h('span', { class: 'note note-expired' }, ' ', t('rnd.late')) : '') : '-'), h('td', {}, t('capa.st.' + a.status))),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('risk.no_actions')),
    ),
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('risk.reviews')))),
      h(
        'ol',
        { class: 'risk-history' },
        r.reviews.map((v) => h('li', {}, levelChip(level(v.likelihood * v.impact), v.likelihood * v.impact), ' ', h('span', { class: 'small muted' }, fmtTime(v.at), ' · ', v.by_name || ''), v.note ? h('div', {}, para(v.note)) : '')),
      ),
    ),
  );
}

function reviewDialog(r) {
  const like = scaleSel('likelihood', r.likelihood, 5);
  const imp = scaleSel('impact', r.impact, 5);
  like.required = imp.required = true;
  const note = h('textarea', { rows: 3, maxlength: 2000, dir: 'auto' });
  openDialog({
    title: t('risk.review') + ' ' + r.code,
    body: h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, field(t('risk.likelihood'), like), field(t('risk.impact'), imp)), field(t('risk.note'), note)),
    onSubmit: async () => {
      await api('/risk/' + r.id + '/review', { method: 'POST', body: { likelihood: Number(like.value), impact: Number(imp.value), note: note.value } });
      toast(t('capa.saved'));
      render();
    },
  });
}

function actionDialog(r) {
  const title = input({ type: 'text', required: true, maxlength: 500, dir: 'auto' });
  const owner = input({ type: 'text', maxlength: 150, dir: 'auto', value: r.owner_name || '' });
  const due = input({ type: 'date', required: true });
  openDialog({
    title: t('risk.add_action'),
    body: h('div', { class: 'stack' }, field(t('capa.title'), title), h('div', { class: 'form-grid' }, field(t('capa.owner'), owner), field(t('capa.due'), due))),
    onSubmit: async () => {
      await api('/risk/' + r.id + '/actions', { method: 'POST', body: { title: title.value, owner: owner.value, due: due.value } });
      toast(t('capa.saved'));
      render();
    },
  });
}

/* ----------------------------------- FMEA ----------------------------------- */

// risk/fmea, or risk/fmea/3 for one worksheet.
export async function fmeaPage(root, param, alive) {
  if (param) return fmeaDetail(root, param, alive);
  let d;
  try {
    d = await api('/risk/fmea');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.fmea'))),
      d.can_add ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => fmeaDialog(null, d.departments) }, icon('plus'), t('fmea.add'))) : '',
    ),
    h(
      'section',
      { class: 'panel' },
      d.fmea.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['ovr.no', 'fmea.title', 'ovr.dept', 'fmea.modes', 'fmea.max_rpn', 'ovr.status'].map((c) => h('th', { scope: 'col' }, t(c))))),
              h(
                'tbody',
                {},
                d.fmea.map((f) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, link('risk/fmea/' + f.id, { class: 'mono strong', dir: 'ltr' }, '#' + f.id)),
                    h('td', { class: 'wrap-cell' }, f.title, h('div', { class: 'small muted' }, fmtTime(f.created_at))),
                    h('td', {}, pick(f.dept_ar, f.dept_en) || '-'),
                    h('td', { class: 'mono' }, String(f.n_modes), f.n_high ? h('span', { class: 'note note-expired' }, ' ', t('fmea.n_high', { n: f.n_high })) : ''),
                    h('td', { class: 'mono', dir: 'ltr' }, f.max_rpn ? String(f.max_rpn) + (f.max_rpn2 !== null ? ' → ' + f.max_rpn2 : '') : '-'),
                    h('td', {}, h('span', { class: 'chip ' + (f.status === 'approved' ? 'chip-valid' : 'chip-near') }, t('fmea.st.' + f.status))),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('fmea.empty')),
    ),
  );
}

async function fmeaDialog(f, departments, people) {
  const ppl = people || (await api('/risk/people')).people;
  const title = input({ type: 'text', required: true, maxlength: 200, dir: 'auto', value: f ? f.title : '' });
  const proc = h('textarea', { rows: 2, maxlength: 2000, dir: 'auto' }, f ? f.process : '');
  const dept = select([['', '-'], ...departments.map((x) => [x.id, pick(x.name_ar, x.name_en)])], f ? f.department_id || '' : S.user.department_id || '');
  const team = h('select', { multiple: true, size: 6 }, ppl.map((p) => h('option', { value: p.id, selected: f ? f.team.includes(p.id) : false }, personOpt(p)[1])));
  openDialog({
    title: f ? t('ivg.edit') : t('fmea.add'),
    body: h('div', { class: 'stack' }, field(t('fmea.title'), title), field(t('fmea.process'), proc), field(t('ovr.dept'), dept), field(t('fmea.team'), team)),
    onSubmit: async () => {
      const body = { title: title.value, process: proc.value, department_id: dept.value ? Number(dept.value) : null, team: [...team.selectedOptions].map((o) => Number(o.value)) };
      const r = await api(f ? '/risk/fmea/' + f.id : '/risk/fmea', { method: f ? 'PUT' : 'POST', body });
      toast(t('capa.saved'));
      if (!f) here('risk/fmea/' + r.id);
      render();
    },
  });
}

async function fmeaDetail(root, id, alive) {
  let d, list;
  try {
    [d, list] = await Promise.all([api('/risk/fmea/' + id), api('/risk/fmea')]);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const f = d.fmea;
  const approved = f.status === 'approved';
  const edit = f.can.edit;
  const steps = f.steps.length ? f.steps : [{ step: '', modes: [] }];
  const people = f.people;
  const HIGH = f.rpn_high;
  const rpnOf = (m, two) => (two ? (m.s2 && m.o2 && m.d2 ? m.s2 * m.o2 * m.d2 : null) : m.s && m.o && m.d ? m.s * m.o * m.d : null);
  const rpnTag = (v, sev) => (v ? h('span', { class: 'chip ' + (v >= HIGH || sev >= 9 ? 'chip-expired' : 'chip-valid'), dir: 'ltr' }, 'RPN ' + v) : h('span', { class: 'muted' }, 'RPN -'));
  const box = h('div', { class: 'stack' });
  let dirty = false;
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', hidden: !edit, onclick: () => save() }, t('common.save'));
  const mark = () => {
    dirty = true;
    saveBtn.classList.add('is-dirty');
  };
  const txt = (m, k, max, ph) => {
    if (!edit || approved) return m[k] ? h('div', { class: 'pre-wrap', dir: 'auto' }, m[k]) : h('span', { class: 'muted' }, '-');
    const el = h('textarea', { rows: 1, maxlength: max, dir: 'auto', 'aria-label': ph }, m[k] || '');
    el.addEventListener('input', () => ((m[k] = el.value), mark()));
    return el;
  };
  const num = (m, k, after, onChange) => {
    const can = edit && (after ? approved : !approved);
    if (!can) return h('span', { class: 'mono' }, m[k] || '-');
    const el = scaleSel('fmea_' + k.replace('2', ''), m[k], 10);
    el.addEventListener('change', () => ((m[k] = el.value ? Number(el.value) : null), mark(), onChange()));
    return el;
  };
  const draw = () => {
    box.replaceChildren(
      ...steps.map((st, si) => {
        const stepIn = edit && !approved ? input({ type: 'text', maxlength: 300, dir: 'auto', value: st.step, placeholder: t('fmea.step') + ' ' + (si + 1), 'aria-label': t('fmea.step') }) : h('strong', {}, st.step || t('fmea.step') + ' ' + (si + 1));
        if (stepIn.tagName === 'INPUT') stepIn.addEventListener('input', () => ((st.step = stepIn.value), mark()));
        return h(
          'section',
          { class: 'panel pad fmea-step' },
          h(
            'div',
            { class: 'fmea-step-head' },
            h('span', { class: 'fmea-step-n mono' }, String(si + 1)),
            stepIn,
            edit && !approved ? h('button', { type: 'button', class: 'btn btn-small', 'aria-label': t('common.delete'), onclick: () => (steps.splice(si, 1), mark(), draw()) }, icon('trash')) : '',
          ),
          ...st.modes.map((m, mi) => {
            const score = h('span', {});
            const score2 = h('span', {});
            const sync = () => {
              score.replaceChildren(rpnTag(rpnOf(m), m.s || 0));
              score2.replaceChildren(approved || rpnOf(m, true) ? rpnTag(rpnOf(m, true), m.s2 || 0) : '');
            };
            sync();
            const owner =
              edit && !approved
                ? (() => {
                    const el = select([['', '-'], ...people.map(personOpt)], m.owner_id || '', { 'aria-label': t('capa.owner') });
                    el.addEventListener('change', () => ((m.owner_id = el.value ? Number(el.value) : null), mark()));
                    return el;
                  })()
                : h('span', {}, (people.find((p) => p.id === m.owner_id) || {}).name || '-');
            const due =
              edit && !approved
                ? (() => {
                    const el = input({ type: 'date', value: m.due || '', 'aria-label': t('capa.due') });
                    el.addEventListener('change', () => ((m.due = el.value || null), mark()));
                    return el;
                  })()
                : m.due
                  ? dateEl(m.due)
                  : h('span', { class: 'muted' }, '-');
            return h(
              'div',
              { class: 'fmea-mode' },
              h('div', { class: 'fmea-mode-head' }, h('span', { class: 'small muted' }, t('fmea.mode') + ' ' + (si + 1) + '.' + (mi + 1)), score, score2, edit && !approved ? h('button', { type: 'button', class: 'btn btn-small', 'aria-label': t('common.delete'), onclick: () => (st.modes.splice(mi, 1), mark(), draw()) }, '×') : ''),
              h(
                'div',
                { class: 'fmea-grid' },
                field(t('fmea.mode'), txt(m, 'mode', 500, t('fmea.mode'))),
                field(t('fmea.effect'), txt(m, 'effect', 500, t('fmea.effect'))),
                field(t('fmea.cause'), txt(m, 'cause', 500, t('fmea.cause'))),
                field(t('fmea.controls'), txt(m, 'controls', 500, t('fmea.controls'))),
              ),
              h('div', { class: 'fmea-sod' }, field(t('fmea.s'), num(m, 's', false, sync)), field(t('fmea.o'), num(m, 'o', false, sync)), field(t('fmea.d'), num(m, 'd', false, sync))),
              h('div', { class: 'fmea-grid' }, field(t('fmea.action'), txt(m, 'action', 500, t('fmea.action'))), field(t('capa.owner'), owner), field(t('capa.due'), due)),
              approved ? h('div', { class: 'fmea-sod' }, field(t('fmea.s2'), num(m, 's2', true, sync)), field(t('fmea.o2'), num(m, 'o2', true, sync)), field(t('fmea.d2'), num(m, 'd2', true, sync))) : '',
            );
          }),
          edit && !approved ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => (st.modes.push({}), mark(), draw()) }, icon('plus'), t('fmea.add_mode')) : '',
        );
      }),
      edit && !approved ? h('div', {}, h('button', { type: 'button', class: 'btn', onclick: () => (steps.push({ step: '', modes: [{}] }), mark(), draw()) }, icon('plus'), t('fmea.add_step'))) : '',
    );
  };
  const save = async () => {
    await api('/risk/fmea/' + f.id, { method: 'PUT', body: { steps } });
    dirty = false;
    toast(t('capa.saved'));
    render();
  };
  const actions = [];
  if (edit) actions.push(saveBtn);
  if (edit && !approved) actions.push(h('button', { type: 'button', class: 'btn', onclick: () => fmeaDialog(f, list.departments, people) }, icon('edit'), t('ivg.edit')));
  if (f.can.approve)
    actions.push(
      h(
        'button',
        {
          type: 'button',
          class: 'btn',
          onclick: async () => {
            if (dirty) await api('/risk/fmea/' + f.id, { method: 'PUT', body: { steps } });
            const r = await api('/risk/fmea/' + f.id + '/approve', { method: 'POST' });
            toast(t('fmea.approved_n', { n: r.actions }));
            render();
          },
        },
        icon('check'),
        t('fmea.approve'),
      ),
    );
  actions.push(h('button', { type: 'button', class: 'btn', onclick: () => window.print() }, icon('file'), t('rep.print')));
  if (f.can.delete) actions.push(h('button', { type: 'button', class: 'btn', 'aria-label': t('common.delete'), onclick: () => simpleDelete(t('fmea.delete_q'), '/risk/fmea/' + f.id, t('capa.deleted'), () => (here('risk/fmea'), render())) }, icon('trash')));
  const teamNames = f.team.map((x) => (people.find((p) => p.id === x) || {}).name).filter(Boolean);
  root.replaceChildren(
    printHead(),
    h('p', { class: 'no-print' }, link('risk/fmea', {}, '← ' + t('nav.fmea'))),
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, 'FMEA #' + f.id + ' · ' + f.title), h('p', {}, h('span', { class: 'chip ' + (approved ? 'chip-valid' : 'chip-near') }, t('fmea.st.' + f.status)), f.approved_by ? h('span', { class: 'small muted' }, ' ', f.approved_by, ' · ', fmtTime(f.approved_at)) : '')),
      h('div', { class: 'actions no-print' }, actions),
    ),
    h(
      'section',
      { class: 'panel pad' },
      h('dl', { class: 'kv-list' }, kv(t('ovr.dept'), pick(f.dept_ar, f.dept_en)), kv(t('fmea.process'), f.process ? para(f.process) : ''), kv(t('fmea.team'), teamNames.join('، ')), kv(t('fmea.legend'), t('fmea.legend_text', { n: HIGH }))),
    ),
    box,
    f.actions.length
      ? h(
          'section',
          { class: 'panel' },
          h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('risk.actions')))),
          h(
            'div',
            { class: 'table-scroll' },
            h('table', {}, h('thead', {}, h('tr', {}, ['capa.title', 'capa.owner', 'capa.due', 'ovr.status'].map((c) => h('th', { scope: 'col' }, t(c))))), h('tbody', {}, f.actions.map((a) => h('tr', {}, h('td', { class: 'wrap-cell' }, a.title), h('td', {}, a.owner || '-'), h('td', {}, a.due ? dateEl(a.due) : '-'), h('td', {}, t('capa.st.' + a.status)))))),
          ),
        )
      : '',
  );
  draw();
}
