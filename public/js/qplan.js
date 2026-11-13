// The annual quality plan, the improvement projects (PDSA) and the quality report (a month or a year).
import { render } from '../app.js';
import { kpiRow } from './assets.js';
import { S, h, icon, t } from './core.js';
import { fmtVal, kpiDialog, libraryDialog, periodLabel, trendChart } from './kpis.js';
import { isAdminRole, link, printHead, setUrl } from './layout.js';
import { api, dateEl, errorBox, field, input, openDialog, select, toast } from './offline.js';
import { reportMailPanel } from './reports.js';
import { fmtTime, pick, simpleDelete } from './tickets.js';

const GOAL_CHIP = { achieved: 'chip-valid', on_track: 'chip-review', behind: 'chip-near', late: 'chip-expired', dropped: '' };
const goalChip = (st) => h('span', { class: 'chip ' + GOAL_CHIP[st] }, t('qp.st.' + st));
const PDSA_CHIP = { active: 'chip-review', done: 'chip-valid', stopped: '' };
const pdsaChip = (st) => h('span', { class: 'chip ' + PDSA_CHIP[st] }, t('pdsa.st.' + st));
const kv = (label, value) => (value === '' || value === null || value === undefined ? null : h('div', { class: 'kv' }, h('dt', {}, label), h('dd', {}, value)));
const para = (v) => h('span', { class: 'pre-wrap', dir: 'auto' }, v);
const panelHead = (title, note) => h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, title), note ? h('span', { class: 'muted small' }, note) : ''));
const here = (path) => {
  S.route = path;
  setUrl(path);
};
const personOpt = (p) => [p.id, pick(p.name, p.name_en) + (p.dept_ar ? ' - ' + pick(p.dept_ar, p.dept_en) : '')];
const kpiOpt = (k) => [k.id, k.code + ' · ' + pick(k.name_ar, k.name_en)];
const kpiNow = (k) => (k && k.value !== null && k.value !== undefined ? h('span', { class: 'mono', dir: 'ltr' }, fmtVal(k, k.value), k.target !== null ? ' / ' + fmtVal(k, k.target) : '') : '');
// The indicator list; a quality manager can add one (new or from the library) without leaving the dialog.
function kpiSelect(d, value) {
  const can = isAdminRole(S.user) || S.user.quality === 'manager';
  const sel = select([], '');
  let prev = String(value || '');
  const fill = (lib) => {
    sel.replaceChildren(
      h('option', { value: '' }, '-'),
      ...d.kpis.map((k) => h('option', { value: k.id }, kpiOpt(k)[1])),
      ...(can ? [h('option', { value: '__new' }, '+ ' + t('kpi.add'))] : []),
      ...(can && lib ? [h('option', { value: '__lib' }, '+ ' + t('kpi.library'))] : []),
    );
    sel.value = prev;
  };
  let lib = true;
  fill(lib);
  sel.addEventListener('change', async (ev) => {
    const v = sel.value;
    if (v !== '__new' && v !== '__lib') {
      prev = v;
      return;
    }
    ev.stopImmediatePropagation();
    sel.value = prev;
    let kd;
    try {
      kd = await api('/kpis');
    } catch (e) {
      toast(e.message || String(e));
      return;
    }
    const done = async (id) => {
      const r = await api('/kpis');
      d.kpis = r.kpis.filter((k) => k.active).map((k) => {
        const last = k.values.length ? k.values[k.values.length - 1] : null;
        return { ...k, value: last ? last.value : null, period: last ? last.period : null, met: last ? last.met : null };
      });
      lib = r.library.length > 0;
      if (id) prev = String(id);
      fill(lib);
      if (id) sel.dispatchEvent(new Event('change'));
    };
    if (v === '__new' || !kd.library.length) kpiDialog(null, kd, done);
    else libraryDialog(kd, done);
  });
  return sel;
}
const num = (v) => (v === null || v === undefined || v === '' ? '' : String(v));

/* ---------------------------------- the plan ---------------------------------- */

export async function qplanPage(root, _param, alive) {
  const year = S.planYear || new Date().getFullYear();
  let d;
  try {
    d = await api('/plan?year=' + year);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const pickYear = select(d.years.map((y) => [y, String(y)]), d.year, { 'aria-label': t('qp.year') });
  pickYear.addEventListener('change', () => ((S.planYear = Number(pickYear.value)), render()));
  const approved = d.plan.status === 'approved';
  const actions = [];
  if (d.role.officer) actions.push(h('button', { type: 'button', class: 'btn btn-primary', onclick: () => goalDialog(null, d) }, icon('plus'), t('qp.add')));
  if (d.role.manager && d.goals.length)
    actions.push(
      h(
        'button',
        { type: 'button', class: 'btn', onclick: async () => (await api('/plan/approve', { method: 'POST', body: { year: d.year, approved: !approved } }), toast(t('capa.saved')), render()) },
        approved ? t('qp.reopen') : [icon('check'), t('qp.approve')],
      ),
    );
  actions.push(h('button', { type: 'button', class: 'btn', onclick: () => window.print() }, icon('file'), t('rep.print')));
  const count = (st) => d.goals.filter((g) => g.status === st).length;
  const byQ = [1, 2, 3, 4].map((q) => d.goals.filter((g) => g.quarter === q));
  root.replaceChildren(
    printHead(),
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h1', {}, t('qp.title', { y: d.year })),
        h('p', {}, approved ? h('span', { class: 'chip chip-valid' }, t('qp.approved_by', { n: d.plan.approved_by }), ' · ', fmtTime(d.plan.approved_at)) : h('span', { class: 'chip chip-near' }, t('qp.draft'))),
      ),
      h('div', { class: 'actions no-print' }, pickYear, ...actions),
    ),
    kpiRow([
      ['qp.k_goals', d.goals.length],
      ['qp.st.achieved', count('achieved')],
      ['qp.st.on_track', count('on_track')],
      ['qp.st.behind', count('behind')],
      ['qp.st.late', count('late')],
    ]),
    ...(d.goals.length
      ? byQ.map((list, i) =>
          list.length
            ? h(
                'section',
                { class: 'panel' },
                panelHead(t('qp.q' + (i + 1)), String(list.length)),
                h(
                  'div',
                  { class: 'table-scroll' },
                  h(
                    'table',
                    {},
                    h('thead', {}, h('tr', {}, ['qp.goal', 'ovr.dept', 'qp.owner', 'qp.link', 'ovr.status', ''].map((c) => h('th', { scope: 'col' }, c ? t(c) : '')))),
                    h('tbody', {}, list.map((g) => goalRow(g, d))),
                  ),
                ),
              )
            : '',
        )
      : [h('section', { class: 'panel' }, h('p', { class: 'empty' }, t('qp.empty')))]),
  );
}

function goalRow(g, d) {
  const linked = [];
  if (g.kpi) linked.push(h('div', {}, h('span', { class: 'mono small', dir: 'ltr' }, g.kpi.code), ' ', kpiNow(g.kpi)));
  if (g.pdsa) linked.push(h('div', {}, link('quality/pdsa/' + g.pdsa.id, { class: 'mono small', dir: 'ltr' }, g.pdsa.code), ' ', h('span', { class: 'small muted' }, t('pdsa.st.' + g.pdsa.status))));
  const btns = [];
  if (g.can_update && !g.can_edit) btns.push(h('button', { type: 'button', class: 'btn btn-small', onclick: () => progressDialog(g, false) }, t('qp.update')));
  if (g.can_edit) btns.push(h('button', { type: 'button', class: 'btn btn-icon', title: t('common.edit'), 'aria-label': t('common.edit'), onclick: () => goalDialog(g, d) }, icon('edit')));
  return h(
    'tr',
    {},
    h(
      'td',
      { class: 'wrap-cell' },
      h('div', { class: 'strong' }, g.title),
      h('div', { class: 'small muted' }, [g.chapter, g.std_code].filter(Boolean).join(' · '), g.measure ? (g.chapter || g.std_code ? ' · ' : '') + g.measure : ''),
      g.note ? h('div', { class: 'small' }, para(g.note)) : '',
    ),
    h('td', {}, pick(g.dept_ar, g.dept_en) || '-'),
    h('td', {}, pick(g.owner_name, g.owner_name_en) || '-'),
    h('td', {}, linked.length ? linked : '-'),
    h('td', {}, goalChip(g.status)),
    h('td', { class: 'no-print' }, h('div', { class: 'row-actions' }, btns)),
  );
}

function goalDialog(g, d) {
  const title = input({ type: 'text', required: true, maxlength: 300, dir: 'auto', value: g ? g.title : '' });
  const detail = h('textarea', { rows: 2, maxlength: 2000, dir: 'auto' }, g ? g.detail : '');
  const chap = select([['', '-'], ...d.chapters.map((c) => [c.code, c.code + ' · ' + pick(c.name_ar, c.name_en)])], g ? g.chapter : '');
  const std = input({ type: 'text', maxlength: 30, dir: 'ltr', value: g ? g.std_code : '', autocomplete: 'off' });
  const quarter = select([1, 2, 3, 4].map((q) => [q, t('qp.q' + q)]), g ? g.quarter : Math.min(4, Math.floor(new Date().getMonth() / 3) + 1));
  const measure = input({ type: 'text', maxlength: 300, dir: 'auto', value: g ? g.measure : '' });
  const dept = select([['', '-'], ...d.departments.map((x) => [x.id, pick(x.name_ar, x.name_en)])], g ? g.department_id || '' : '');
  const owner = select([['', '-'], ...d.people.map(personOpt)], g ? g.owner_id || '' : '');
  const kpi = kpiSelect(d, g ? g.kpi_id : '');
  const pdsa = select([['', '-'], ...d.projects.map((p) => [p.id, p.code + ' · ' + p.title])], g ? g.pdsa_id || '' : '');
  const progress = g ? select([['', t('qp.auto')], ['done', t('qp.st.achieved')], ['dropped', t('qp.st.dropped')]], g.progress) : null;
  const dlg = openDialog({
    title: g ? t('common.edit') : t('qp.add'),
    body: h(
      'div',
      { class: 'stack' },
      field(t('qp.goal'), title),
      field(t('qp.detail'), detail),
      h('div', { class: 'form-grid' }, field(t('qa.chapter'), chap), field(t('qp.std'), std), field(t('qp.quarter'), quarter), field(t('qp.measure'), measure)),
      h('div', { class: 'form-grid' }, field(t('ovr.dept'), dept), field(t('qp.owner'), owner), field(t('qp.kpi'), kpi), field(t('qp.pdsa'), pdsa)),
      progress ? field(t('ovr.status'), progress) : '',
    ),
    onSubmit: async () => {
      const body = {
        year: d.year, title: title.value, detail: detail.value, chapter: chap.value, std_code: std.value, quarter: Number(quarter.value), measure: measure.value,
        department_id: dept.value ? Number(dept.value) : null, owner_id: owner.value ? Number(owner.value) : null, kpi_id: kpi.value ? Number(kpi.value) : null, pdsa_id: pdsa.value ? Number(pdsa.value) : null,
      };
      await api(g ? '/plan/goals/' + g.id : '/plan/goals', { method: g ? 'PUT' : 'POST', body });
      if (g && progress.value !== (g.progress || '')) await api('/plan/goals/' + g.id + '/progress', { method: 'POST', body: { progress: progress.value } });
      toast(t('capa.saved'));
      render();
    },
  });
  if (g && d.role.officer)
    dlg.querySelector('.dialog-actions').append(
      h('button', { type: 'button', class: 'btn', 'aria-label': t('common.delete'), onclick: () => (dlg.close(), simpleDelete(t('qp.delete_q'), '/plan/goals/' + g.id, t('capa.deleted'))) }, icon('trash')),
    );
}

// A department head or the goal's owner: mark it done and leave a note.
function progressDialog(g) {
  const done = input({ type: 'checkbox', checked: g.progress === 'done' });
  const note = h('textarea', { rows: 3, maxlength: 2000, dir: 'auto' }, g.note);
  openDialog({
    title: g.title,
    body: h('div', { class: 'stack' }, h('label', { class: 'check' }, done, ' ', t('qp.mark_done')), field(t('qp.note'), note)),
    onSubmit: async () => {
      await api('/plan/goals/' + g.id + '/progress', { method: 'POST', body: { progress: done.checked ? 'done' : '', note: note.value } });
      toast(t('capa.saved'));
      render();
    },
  });
}

/* ------------------------------- PDSA projects ------------------------------- */

// quality/pdsa, or quality/pdsa/4 for one project.
export async function pdsaPage(root, param, alive) {
  if (param) return pdsaDetail(root, param, alive);
  let d;
  try {
    d = await api('/pdsa');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const f = (S.pdsaF = S.pdsaF || { status: 'active' });
  const pickSt = select([['active', t('pdsa.st.active')], ['done', t('pdsa.st.done')], ['stopped', t('pdsa.st.stopped')], ['', t('capa.all')]], f.status, { 'aria-label': t('ovr.status') });
  const box = h('div', {});
  const draw = () => {
    const rows = d.projects.filter((p) => !f.status || p.status === f.status);
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
                h('thead', {}, h('tr', {}, ['risk.code', 'pdsa.project', 'ovr.dept', 'pdsa.leader', 'qp.kpi', 'pdsa.cycles', 'ovr.status'].map((c) => h('th', { scope: 'col' }, t(c))))),
                h(
                  'tbody',
                  {},
                  rows.map((p) =>
                    h(
                      'tr',
                      {},
                      h('td', {}, link('quality/pdsa/' + p.id, { class: 'mono strong', dir: 'ltr' }, p.code)),
                      h('td', { class: 'wrap-cell' }, h('div', {}, p.title), p.aim ? h('div', { class: 'small muted' }, p.aim) : ''),
                      h('td', {}, pick(p.dept_ar, p.dept_en) || '-'),
                      h('td', {}, pick(p.leader_name, p.leader_name_en) || '-'),
                      h('td', {}, p.kpi_code ? h('span', { class: 'mono small', dir: 'ltr' }, p.kpi_code) : '-'),
                      h('td', {}, h('span', { class: 'mono' }, String(p.n_cycles)), p.next_due ? h('div', { class: 'small' }, dateEl(p.next_due), p.late ? h('span', { class: 'note note-expired' }, ' ', t('rnd.late')) : '') : ''),
                      h('td', {}, pdsaChip(p.status)),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty' }, d.projects.length ? t('capa.no_match') : t('pdsa.empty')),
      ),
    );
  };
  pickSt.addEventListener('change', () => ((f.status = pickSt.value), draw()));
  const active = d.projects.filter((p) => p.status === 'active');
  const suggest = d.suggestions.length
    ? h(
        'section',
        { class: 'panel' },
        panelHead(t('risk.suggest')),
        h(
          'ul',
          { class: 'risk-suggest' },
          d.suggestions.map((s) =>
            h(
              'li',
              {},
              h(
                'span',
                {},
                h('span', { class: 'tag' }, t('pdsa.src.' + s.source)),
                ' ',
                s.code ? h('span', { class: 'mono small', dir: 'ltr' }, s.code + ' ') : '',
                pick(s.title_ar, s.title_en),
                ' ',
                h('span', { class: 'muted small' }, s.source === 'kpi' ? t('pdsa.why_kpi', { n: 3 }) : s.source === 'risk' ? t('pdsa.why_risk', { n: s.score }) : t('risk.suggest_n', { n: s.n })),
              ),
              h('button', { type: 'button', class: 'btn btn-small', onclick: () => pdsaDialog(null, d, s) }, icon('plus'), t('pdsa.add')),
            ),
          ),
        ),
      )
    : '';
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.pdsa'))),
      d.can_add ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => pdsaDialog(null, d) }, icon('plus'), t('pdsa.add'))) : '',
    ),
    kpiRow([
      ['pdsa.st.active', active.length],
      ['pdsa.k_late', active.filter((p) => p.late).length],
      ['pdsa.st.done', d.projects.filter((p) => p.status === 'done').length],
    ]),
    suggest,
    h('div', { class: 'filters' }, pickSt),
    box,
  );
  draw();
}

async function pdsaDialog(p, d, preset) {
  const ppl = (p && p.people) || (await api('/pdsa/people')).people;
  const s = preset || {};
  const title = input({ type: 'text', required: true, maxlength: 200, dir: 'auto', value: p ? p.title : s.title_ar ? pick(s.title_ar, s.title_en) : '' });
  const problem = h('textarea', { rows: 3, maxlength: 3000, dir: 'auto' }, p ? p.problem : '');
  const aim = h('textarea', { rows: 2, maxlength: 1000, dir: 'auto' }, p ? p.aim : '');
  const officer = d.role ? d.role.officer : true;
  const dept = officer ? select([['', '-'], ...d.departments.map((x) => [x.id, pick(x.name_ar, x.name_en)])], p ? p.department_id || '' : S.user.department_id || '') : null;
  const leader = select([['', '-'], ...ppl.map(personOpt)], p ? p.leader_id || '' : S.user.id);
  const team = h('select', { multiple: true, size: 6 }, ppl.map((x) => h('option', { value: x.id, selected: p ? p.team.includes(x.id) : false }, personOpt(x)[1])));
  const kpi = kpiSelect(d, p ? p.kpi_id : s.kpi_id);
  const base = input({ type: 'number', step: 'any', dir: 'ltr', value: p ? num(p.baseline) : num(s.baseline) });
  const target = input({ type: 'number', step: 'any', dir: 'ltr', value: p ? num(p.target) : num(s.target) });
  const start = input({ type: 'date', value: p ? p.start_on || '' : '' });
  const due = input({ type: 'date', value: p ? p.due_on || '' : '' });
  // Choosing an indicator fills in its latest value and target.
  kpi.addEventListener('change', () => {
    const k = d.kpis.find((x) => String(x.id) === kpi.value);
    if (k && !base.value && k.value !== null) base.value = k.value;
    if (k && !target.value && k.target !== null) target.value = k.target;
  });
  openDialog({
    title: p ? t('common.edit') : t('pdsa.add'),
    body: h(
      'div',
      { class: 'stack' },
      field(t('pdsa.project'), title),
      field(t('pdsa.problem'), problem),
      field(t('pdsa.aim'), aim),
      h('div', { class: 'form-grid' }, dept ? field(t('ovr.dept'), dept) : '', field(t('pdsa.leader'), leader), field(t('qp.kpi'), kpi), field(t('pdsa.baseline'), base), field(t('pdsa.target'), target), field(t('pdsa.start'), start), field(t('pdsa.due'), due)),
      field(t('pdsa.team'), team),
    ),
    onSubmit: async () => {
      const body = {
        title: title.value, problem: problem.value, aim: aim.value, leader_id: leader.value ? Number(leader.value) : null, team: [...team.selectedOptions].map((o) => Number(o.value)),
        kpi_id: kpi.value ? Number(kpi.value) : null, baseline: base.value, target: target.value, start_on: start.value, due_on: due.value,
        ...(dept ? { department_id: dept.value ? Number(dept.value) : null } : {}),
        ...(s.source ? { source: s.source, source_ref: s.ref } : {}),
      };
      const r = await api(p ? '/pdsa/' + p.id : '/pdsa', { method: p ? 'PUT' : 'POST', body });
      toast(t('capa.saved'));
      if (!p) here('quality/pdsa/' + r.id);
      render();
    },
  });
}

async function pdsaDetail(root, id, alive) {
  let d, meta;
  try {
    [d, meta] = await Promise.all([api('/pdsa/' + id), api('/pdsa')]);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const p = d.project;
  const can = p.can;
  const last = p.cycles[p.cycles.length - 1];
  const actions = [];
  if (can.cycle && (!last || last.done_at)) actions.push(h('button', { type: 'button', class: 'btn btn-primary', onclick: () => cycleDialog(p, null) }, icon('plus'), t('pdsa.add_cycle')));
  if (can.edit) actions.push(h('button', { type: 'button', class: 'btn', onclick: () => pdsaDialog(p, { ...meta, role: meta.role }) }, icon('edit'), t('common.edit')));
  if (can.close && p.status === 'active') actions.push(h('button', { type: 'button', class: 'btn', onclick: () => closeDialog(p) }, icon('check'), t('pdsa.finish')));
  if (meta.role.manager && p.status !== 'active') actions.push(h('button', { type: 'button', class: 'btn', onclick: async () => (await api('/pdsa/' + p.id + '/close', { method: 'POST', body: { status: 'active' } }), toast(t('capa.saved')), render()) }, t('risk.reopen')));
  actions.push(h('button', { type: 'button', class: 'btn', onclick: () => window.print() }, icon('file'), t('rep.print')));
  if (can.delete) actions.push(h('button', { type: 'button', class: 'btn', 'aria-label': t('common.delete'), onclick: () => simpleDelete(t('pdsa.delete_q'), '/pdsa/' + p.id, t('capa.deleted'), () => (here('quality/pdsa'), render())) }, icon('trash')));
  const team = p.team.map((uid) => (p.people.find((x) => x.id === uid) || {})).filter((x) => x.id).map((x) => pick(x.name, x.name_en));
  const k = p.kpi;
  const goalK = k ? { ...k, target: p.target ?? k.target } : null;
  root.replaceChildren(
    printHead(),
    h('p', { class: 'no-print' }, link('quality/pdsa', {}, '← ' + t('nav.pdsa'))),
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, h('span', { class: 'mono', dir: 'ltr' }, p.code), ' ', p.title), h('p', {}, pdsaChip(p.status), p.source !== 'manual' ? [' ', h('span', { class: 'tag' }, t('pdsa.src.' + p.source))] : '')),
      h('div', { class: 'actions no-print' }, actions),
    ),
    h(
      'section',
      { class: 'panel pad' },
      h(
        'dl',
        { class: 'kv-list' },
        kv(t('pdsa.problem'), p.problem ? para(p.problem) : ''),
        kv(t('pdsa.aim'), p.aim ? para(p.aim) : ''),
        kv(t('ovr.dept'), pick(p.dept_ar, p.dept_en)),
        kv(t('pdsa.leader'), pick(p.leader_name, p.leader_name_en)),
        kv(t('pdsa.team'), team.join('، ')),
        kv(t('qp.kpi'), p.kpi_code ? p.kpi_code + ' · ' + pick(p.kpi_ar, p.kpi_en) : ''),
        kv(t('pdsa.baseline'), goalK && p.baseline !== null ? h('span', { class: 'mono', dir: 'ltr' }, fmtVal(goalK, p.baseline)) : num(p.baseline)),
        kv(t('pdsa.target'), goalK && goalK.target !== null ? h('span', { class: 'mono', dir: 'ltr' }, fmtVal(goalK, goalK.target)) : num(p.target)),
        kv(t('pdsa.start'), p.start_on ? dateEl(p.start_on) : ''),
        kv(t('pdsa.due'), p.due_on ? dateEl(p.due_on) : ''),
        kv(t('pdsa.result'), p.result ? para(p.result) : ''),
      ),
    ),
    k
      ? h(
          'section',
          { class: 'panel' },
          panelHead(pick(k.name_ar, k.name_en)),
          trendChart(k.values, { target: goalK.target, pct: k.unit === 'pct', fmt: (v) => fmtVal(k, v), xLabel: (x, long) => periodLabel(x.period, !long), label: pick(k.name_ar, k.name_en), markFrom: p.start_on ? (k.frequency === 'quarterly' ? `${p.start_on.slice(0, 4)}-Q${Math.floor((Number(p.start_on.slice(5, 7)) - 1) / 3) + 1}` : p.start_on.slice(0, 7)) : null }),
        )
      : '',
    h(
      'section',
      { class: 'panel' },
      panelHead(t('pdsa.cycles'), String(p.cycles.length)),
      p.cycles.length ? h('div', { class: 'pdsa-cycles' }, p.cycles.map((c) => cycleCard(p, c))) : h('p', { class: 'empty' }, t('pdsa.no_cycles')),
    ),
  );
}

function cycleCard(p, c) {
  const part = (key, v) => h('div', { class: 'pdsa-part' }, h('div', { class: 'pdsa-letter', 'aria-hidden': 'true' }, t('pdsa.l.' + key)), h('div', {}, h('div', { class: 'small muted' }, t('pdsa.p.' + key)), v ? para(v) : h('span', { class: 'muted' }, '-')));
  return h(
    'article',
    { class: 'pdsa-cycle' + (c.done_at ? ' is-done' : '') },
    h(
      'div',
      { class: 'pdsa-cycle-head' },
      h('h3', {}, t('pdsa.cycle_n', { n: c.n })),
      h(
        'span',
        { class: 'small' },
        c.done_at ? [h('span', { class: 'chip chip-valid' }, t('pdsa.act.' + c.act)), ' ', h('span', { class: 'muted' }, fmtTime(c.done_at))] : [dateEl(c.due), c.late ? h('span', { class: 'note note-expired' }, ' ', t('rnd.late')) : ''],
      ),
      p.can.cycle ? h('button', { type: 'button', class: 'btn btn-small no-print', onclick: () => cycleDialog(p, c) }, icon('edit'), t(c.done_at ? 'common.edit' : 'pdsa.update_cycle')) : '',
    ),
    h('div', { class: 'pdsa-parts' }, part('plan', c.plan), part('do', c.do_text), part('study', c.study), part('act', c.act ? t('pdsa.act.' + c.act) : '')),
  );
}

function cycleDialog(p, c) {
  const plan = h('textarea', { rows: 3, maxlength: 3000, dir: 'auto', required: true }, c ? c.plan : '');
  const due = input({ type: 'date', value: c ? c.due || '' : '' });
  const doT = c ? h('textarea', { rows: 3, maxlength: 3000, dir: 'auto' }, c.do_text) : null;
  const study = c ? h('textarea', { rows: 3, maxlength: 3000, dir: 'auto' }, c.study) : null;
  const act = c ? select([['', '-'], ...['adopt', 'adapt', 'abandon'].map((x) => [x, t('pdsa.act.' + x)])], c.act) : null;
  const done = c ? input({ type: 'checkbox', checked: !!c.done_at }) : null;
  openDialog({
    title: c ? t('pdsa.cycle_n', { n: c.n }) : t('pdsa.add_cycle'),
    body: h(
      'div',
      { class: 'stack' },
      field(t('pdsa.p.plan'), plan),
      field(t('pdsa.due'), due),
      c ? [field(t('pdsa.p.do'), doT), field(t('pdsa.p.study'), study), field(t('pdsa.p.act'), act), h('label', { class: 'check' }, done, ' ', t('pdsa.cycle_done'))] : '',
    ),
    onSubmit: async () => {
      if (c) await api('/pdsa/' + p.id + '/cycles/' + c.id, { method: 'PUT', body: { plan: plan.value, due: due.value, do_text: doT.value, study: study.value, act: act.value, done: done.checked } });
      else await api('/pdsa/' + p.id + '/cycles', { method: 'POST', body: { plan: plan.value, due: due.value } });
      toast(t('capa.saved'));
      render();
    },
  });
}

function closeDialog(p) {
  const st = select([['done', t('pdsa.st.done')], ['stopped', t('pdsa.st.stopped')]], 'done');
  const result = h('textarea', { rows: 4, maxlength: 3000, dir: 'auto' }, p.result);
  openDialog({
    title: t('pdsa.finish'),
    body: h('div', { class: 'stack' }, field(t('ovr.status'), st), field(t('pdsa.result'), result)),
    onSubmit: async () => {
      await api('/pdsa/' + p.id + '/close', { method: 'POST', body: { status: st.value, result: result.value } });
      toast(t('capa.saved'));
      render();
    },
  });
}

/* ------------------------------- the quality report ------------------------------- */

const prevMonth = (m) => (m.slice(5) === '01' ? `${Number(m.slice(0, 4)) - 1}-12` : `${m.slice(0, 4)}-${String(Number(m.slice(5)) - 1).padStart(2, '0')}`);
const pLabel = (p) => (/^\d{4}$/.test(p) ? t('qrep.year', { y: p }) : periodLabel(p));

// reports/qreport, or reports/qreport/2026-10 (a month) or reports/qreport/2026 (the year).
export async function qreportPage(root, param, alive) {
  const today = new Date();
  const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const period = /^\d{4}(-(0[1-9]|1[0-2]))?$/.test(param || '') ? param : prevMonth(thisMonth);
  let d;
  try {
    d = await api('/qreport?period=' + period);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const opts = [];
  for (let m = thisMonth, i = 0; i < 24; i++, m = prevMonth(m)) opts.push([m, periodLabel(m)]);
  const y = today.getFullYear();
  for (const yy of [y, y - 1, y - 2]) opts.push([String(yy), t('qrep.year', { y: yy })]);
  const pickP = select(opts, d.period, { 'aria-label': t('qrep.period') });
  pickP.addEventListener('change', () => (here('reports/qreport/' + pickP.value), render()));
  const c = d.cur;
  const p = d.prev;
  const prevLabel = d.kind === 'year' ? d.prev_from.slice(0, 4) : periodLabel(d.prev_from);
  const cmp = (label, a, b) => h('tr', {}, h('td', {}, label), h('td', { class: 'mono strong', dir: 'ltr' }, a ?? '-'), h('td', { class: 'mono muted', dir: 'ltr' }, b ?? '-'));
  const cmpTable = (title, rows) =>
    h('section', { class: 'panel' }, panelHead(title), h('div', { class: 'table-scroll' }, h('table', {}, h('thead', {}, h('tr', {}, [t('qrep.item'), pLabel(d.period), prevLabel].map((x) => h('th', { scope: 'col' }, x)))), h('tbody', {}, rows))));
  const sat = (x) => (x.survey.satisfied_pct === null ? '-' : x.survey.satisfied_pct + '%');
  const mini = (title, items) => h('section', { class: 'panel' }, panelHead(title), h('dl', { class: 'kv-list qrep-mini' }, items.map(([k, v]) => kv(k.includes('.') ? t(k) : k, h('span', { class: 'mono', dir: 'ltr' }, String(v ?? '-'))))));
  const canMail = isAdminRole(S.user) || S.user.quality === 'manager';
  root.replaceChildren(
    printHead(),
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('qrep.title', { p: pLabel(d.period) }))), h('div', { class: 'actions no-print' }, pickP, h('button', { type: 'button', class: 'btn', onclick: () => window.print() }, icon('file'), t('rep.print')))),
    kpiRow([
      ['qrep.k_ovr', c.ovr.n],
      ['qrep.k_complaints', c.pex.complaints],
      ['qrep.k_sat', sat(c)],
      ['qrep.k_kpi_below', d.kpis.below.length],
      ['qrep.k_capa_late', d.capa.late],
      ['qrep.k_risk_high', d.risks.critical + d.risks.high],
    ]),
    h(
      'div',
      { class: 'qrep-grid' },
      cmpTable(t('qrep.safety'), [cmp(t('qrep.ovr'), c.ovr.n, p.ovr.n), cmp(t('qrep.severe'), c.ovr.severe, p.ovr.severe), cmp(t('qrep.near_miss'), c.ovr.near_miss, p.ovr.near_miss)]),
      cmpTable(t('qrep.pex'), [cmp(t('qrep.complaints'), c.pex.complaints, p.pex.complaints), cmp(t('qrep.on_time'), c.pex.on_time, p.pex.on_time), cmp(t('qrep.praise'), c.pex.praise, p.pex.praise), cmp(t('qrep.sat'), sat(c), sat(p)), cmp(t('qrep.responses'), c.survey.responses, p.survey.responses)]),
    ),
    d.ovr.categories.length
      ? (() => {
          const max = Math.max(1, ...d.ovr.categories.map((x) => x.n));
          return h(
            'div',
            { class: 'panel rep-top' },
            h('h3', {}, t('qrep.top_ovr')),
            h('ol', {}, d.ovr.categories.map((x) => h('li', {}, h('span', { class: 'rep-top-name' }, pick(x.name_ar, x.name_en)), h('span', { class: 'rep-bar', 'aria-hidden': 'true' }, h('span', { style: `width:${Math.max(4, Math.round((x.n / max) * 100))}%` })), h('span', { class: 'mono', dir: 'ltr' }, String(x.n))))),
          );
        })()
      : '',
    h(
      'section',
      { class: 'panel' },
      panelHead(t('qrep.kpis'), t('qrep.kpi_sum', { met: d.kpis.met, below: d.kpis.below.length, missing: d.kpis.missing })),
      d.kpis.below.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, [t('qp.kpi'), t('qrep.value'), t('qrep.target')].map((x) => h('th', { scope: 'col' }, x)))),
              h('tbody', {}, d.kpis.below.map((k) => h('tr', {}, h('td', {}, h('span', { class: 'mono small', dir: 'ltr' }, k.code), ' ', pick(k.name_ar, k.name_en)), h('td', { class: 'mono', dir: 'ltr' }, fmtVal(k, k.value)), h('td', { class: 'mono', dir: 'ltr' }, fmtVal(k, k.target))))),
            ),
          )
        : h('p', { class: 'empty' }, t('qrep.kpi_none_below')),
    ),
    h(
      'div',
      { class: 'qrep-grid' },
      mini(t('qrep.capa'), [['qrep.capa_opened', d.capa.opened], ['qrep.capa_closed', d.capa.closed], ['qrep.capa_open', d.capa.open], ['qrep.capa_late', d.capa.late]]),
      mini(t('nav.risks'), [['qrep.risk_open', d.risks.open], ['risk.lv.critical', d.risks.critical], ['risk.lv.high', d.risks.high], ['qrep.risk_new', d.risks.new], ['risk.k_late', d.risks.late]]),
      mini(t('nav.pdsa'), [['pdsa.st.active', d.pdsa.active], ['qrep.pdsa_started', d.pdsa.started], ['pdsa.st.done', d.pdsa.done], ['pdsa.k_late', d.pdsa.cycles_late]]),
      mini(t('qp.title', { y: d.goals.year }), [['qp.k_goals', d.goals.n], ['qp.st.achieved', d.goals.achieved], ['qp.st.on_track', d.goals.on_track], ['qp.st.behind', d.goals.behind], ['qp.st.late', d.goals.late]]),
    ),
    d.readiness.length ? mini(t('qrep.readiness'), d.readiness.map((r) => [pick(r.name_ar, r.name_en), r.pct === null ? '-' : r.pct + '%'])) : '',
    canMail ? h('div', { class: 'no-print' }, reportMailPanel()) : '',
  );
}
