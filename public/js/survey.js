// Mock surveys, tracers (quality/mock) and clinical audits (quality/audits).
// quality/mock: surveys and tracers; mock/4: one survey and its report; mock/4.LD: scoring a chapter in it;
// mock/t7: one tracer. quality/audits, audits/3: one audit with its cases.
import { render } from '../app.js';
import { kpiRow } from './assets.js';
import { S, h, icon, t } from './core.js';
import { link, navigate } from './layout.js';
import { api, dateEl, errText, errorBox, field, input, openDialog, select, toast } from './offline.js';
import { assessPage, meter, scoreChip } from './quality.js';
import { pick, simpleDelete } from './tickets.js';

const pctText = (p) => (p === null || p === undefined ? '-' : p + '%');
const panelHead = (title, extra) => h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, title)), extra || '');
const both = (s) => {
  const [ar, en] = String(s || '').split(' | ');
  return pick(ar, en || ar);
};
const chName = (c) => (c ? c.code + ' · ' + pick(c.name_ar, c.name_en) : '');
const delta = (a, b) => (a === null || a === undefined || b === null || b === undefined || a === b ? '' : h('span', { class: 'small ' + (a >= b ? 'note-valid' : 'note-expired'), dir: 'ltr' }, ' ' + (a >= b ? '+' : '') + (a - b)));
const ST_CHIP = { active: 'chip-review', open: 'chip-review', closed: 'chip-valid', done: 'chip-valid' };
const stChip = (st) => h('span', { class: 'chip ' + (ST_CHIP[st] || '') }, t('mock.st.' + st));

// The three-way answer used by tracers and audits, in the scoring page's style.
function marks(value, options, onPick, can, label) {
  const name = 'm' + Math.random().toString(36).slice(2, 9);
  return h(
    'div',
    { class: 'qa-marks', role: 'radiogroup', 'aria-label': label },
    options.map(([v, cls, mark, title]) => {
      const r = input({ type: 'radio', name, value: v, checked: value === v, disabled: !can });
      r.addEventListener('change', () => onPick(v));
      return h('label', { class: 'qa-mark ' + cls, title }, r, h('span', { dir: 'ltr' }, mark));
    }),
  );
}
const TR_OPTS = () => [
  ['met', 'qa-met', '✓', t('qa.score.met')],
  ['not_met', 'qa-not_met', '✗', t('qa.score.not_met')],
  ['na', 'qa-na', 'NA', t('qa.score.na')],
];
const AUD_OPTS = () => [
  ['y', 'qa-met', '✓', t('aud.yes')],
  ['n', 'qa-not_met', '✗', t('aud.no')],
  ['na', 'qa-na', 'NA', t('qa.score.na')],
];

/* --------------------------------- surveys --------------------------------- */

export async function mockPage(root, param, alive) {
  const p = String(param || '');
  if (/^t\d+$/.test(p)) return tracerDetail(root, Number(p.slice(1)), alive);
  const m = /^(\d+)\.([A-Z&]{2,6})$/.exec(p);
  if (m) return assessPage(root, '', alive, 'quality', { id: Number(m[1]), chapter: m[2] });
  if (/^\d+$/.test(p)) return surveyDetail(root, Number(p), alive);
  let d;
  try {
    d = await api('/mock');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const fwName = (k) => {
    const f = d.frameworks.find((x) => x.key === k);
    return f ? pick(f.name_ar, f.name_en) : k;
  };
  const active = d.surveys.filter((s) => s.status === 'active');
  const last = d.surveys.find((s) => s.status === 'closed');
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.mock'))),
      h(
        'div',
        { class: 'actions' },
        d.can_trace ? h('button', { type: 'button', class: 'btn', onclick: () => tracerDialog(d) }, icon('plus'), t('tr.add')) : '',
        d.can_manage ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => surveyDialog(null, d) }, icon('plus'), t('mock.add')) : '',
      ),
    ),
    kpiRow([
      ['mock.k_active', active.length],
      ['mock.k_last', last ? pctText(last.pct) : '-'],
      ['mock.k_tracers', d.tracers.filter((x) => x.status === 'open').length],
    ]),
    h(
      'section',
      { class: 'panel' },
      d.surveys.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['risk.code', 'mock.title', 'mock.framework', 'mock.progress', 'mock.readiness', 'ovr.status'].map((c) => h('th', { scope: 'col' }, t(c))))),
              h(
                'tbody',
                {},
                d.surveys.map((s) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, link('quality/mock/' + s.id, { class: 'mono strong', dir: 'ltr' }, s.code)),
                    h('td', { class: 'wrap-cell' }, h('div', {}, s.title), h('div', { class: 'small muted', dir: 'ltr' }, s.chapters.join(' · '))),
                    h('td', {}, fwName(s.framework)),
                    h('td', {}, h('span', { class: 'mono', dir: 'ltr' }, s.scored + ' / ' + s.units)),
                    h('td', {}, h('span', { class: 'mono strong', dir: 'ltr' }, pctText(s.pct)), s.esr_gap ? h('div', { class: 'small note-expired' }, 'ESR ' + s.esr_gap) : ''),
                    h('td', {}, stChip(s.status), s.applied_at ? h('div', { class: 'small muted' }, t('mock.applied')) : ''),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('mock.empty')),
    ),
    tracersPanel(d.tracers, null),
  );
}

function tracersPanel(list, add) {
  return h(
    'section',
    { class: 'panel' },
    panelHead(t('tr.title'), add),
    list.length
      ? h(
          'div',
          { class: 'table-scroll' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, ['risk.code', 'tr.kind', 'ovr.dept', 'tr.date', 'tr.result', 'ovr.status'].map((c) => h('th', { scope: 'col' }, t(c))))),
            h(
              'tbody',
              {},
              list.map((x) =>
                h(
                  'tr',
                  {},
                  h('td', {}, link('quality/mock/t' + x.id, { class: 'mono strong', dir: 'ltr' }, x.code), x.survey_code ? h('div', { class: 'small muted', dir: 'ltr' }, x.survey_code) : ''),
                  h('td', {}, x.kind === 'patient' ? t('tr.patient') : t('tr.topic.' + x.topic), x.mrn ? h('div', { class: 'small muted', dir: 'ltr' }, x.mrn) : ''),
                  h('td', {}, pick(x.dept_ar, x.dept_en) || '-'),
                  h('td', {}, dateEl(x.on_date)),
                  h('td', {}, h('span', { class: 'mono', dir: 'ltr' }, x.n_met + ' / ' + x.n_items), x.n_not ? h('span', { class: 'small note-expired' }, ' ✗' + x.n_not) : ''),
                  h('td', {}, stChip(x.status)),
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'empty' }, t('tr.empty')),
  );
}

function surveyDialog(sv, d) {
  const fws = d.frameworks;
  const fw = select(fws.map((f) => [f.key, pick(f.name_ar, f.name_en)]), sv ? sv.framework : fws[0] ? fws[0].key : 'cbahi', { disabled: !!sv });
  const title = input({ type: 'text', required: true, maxlength: 200, dir: 'auto', value: sv ? sv.title : '' });
  const start = input({ type: 'date', value: sv ? sv.start_on || '' : d.today || '' });
  const end = input({ type: 'date', value: sv ? sv.end_on || '' : '' });
  const box = h('div', { class: 'mock-chapters' });
  const had = new Set(sv ? sv.chapters : []);
  const who = sv ? Object.fromEntries((sv.assign || []).map((a) => [a.code, a.user_id])) : {};
  let rows = [];
  const draw = () => {
    rows = d.chapters
      .filter((c) => c.framework === fw.value)
      .map((c) => {
        const on = input({ type: 'checkbox', checked: had.has(c.code), value: c.code });
        const person = select([['', '-'], ...d.people.map((p) => [p.id, pick(p.name, p.name_en)])], who[c.code] || '', { 'aria-label': t('mock.assessor') + ': ' + c.code });
        return { code: c.code, on, person, el: h('div', { class: 'mock-ch-row' }, h('label', { class: 'check' }, on, ' ', h('span', { class: 'mono small', dir: 'ltr' }, c.code), ' ', pick(c.name_ar, c.name_en)), person) };
      });
    box.replaceChildren(...(rows.length ? rows.map((r) => r.el) : [h('p', { class: 'empty' }, t('qa.no_standards'))]));
  };
  fw.addEventListener('change', draw);
  draw();
  openDialog({
    title: sv ? t('common.edit') : t('mock.add'),
    body: h(
      'div',
      { class: 'stack' },
      field(t('mock.title'), title),
      h('div', { class: 'form-grid' }, fws.length > 1 ? field(t('mock.framework'), fw) : '', field(t('pdsa.start'), start), field(t('mock.end'), end)),
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('mock.chapters')), box),
    ),
    onSubmit: async () => {
      const chosen = rows.filter((r) => r.on.checked);
      const body = { title: title.value, framework: fw.value, start_on: start.value, end_on: end.value, chapters: chosen.map((r) => r.code), assign: Object.fromEntries(chosen.filter((r) => r.person.value).map((r) => [r.code, Number(r.person.value)])) };
      const r = await api(sv ? '/mock/' + sv.id : '/mock', { method: sv ? 'PUT' : 'POST', body });
      toast(t('capa.saved'));
      if (sv) render();
      else navigate('quality/mock/' + r.id);
    },
  });
}

async function surveyDetail(root, id, alive) {
  let d;
  try {
    d = await api('/mock/' + id);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const sv = d.survey;
  const active = sv.status === 'active';
  const edit = async () => {
    const all = await api('/mock');
    surveyDialog({ ...sv, assign: d.chapters.map((c) => ({ code: c.code, user_id: c.user_id })) }, all);
  };
  const close = () => {
    const result = h('textarea', { rows: 3, maxlength: 2000, dir: 'auto' });
    openDialog({
      title: t('mock.close'),
      body: h('div', { class: 'stack' }, h('p', {}, t('mock.close_note', { n: d.total.not_met + d.total.partial })), field(t('mock.result'), result)),
      submitLabel: t('mock.close'),
      onSubmit: async () => {
        const r = await api('/mock/' + id + '/close', { method: 'POST', body: { result: result.value } });
        toast(t('mock.capa_made', { n: r.capa }));
        render();
      },
    });
  };
  const apply = () =>
    openDialog({
      title: t('mock.apply'),
      body: h('p', {}, t('mock.apply_note')),
      submitLabel: t('mock.apply'),
      onSubmit: async () => {
        const r = await api('/mock/' + id + '/apply', { method: 'POST' });
        toast(t('mock.applied_n', { n: r.standards }));
        render();
      },
    });
  const prev = d.prev;
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, link('quality/mock', { class: 'back-link' }, t('nav.mock')), h('h1', {}, h('span', { class: 'mono', dir: 'ltr' }, sv.code), ' · ', sv.title), h('div', { class: 'qa-std-tags' }, stChip(sv.status), sv.applied_at ? h('span', { class: 'chip chip-valid' }, t('mock.applied')) : '', h('span', { class: 'small muted' }, dateEl(sv.start_on), sv.end_on ? ' - ' : '', sv.end_on ? dateEl(sv.end_on) : ''))),
      h(
        'div',
        { class: 'actions' },
        d.can_manage && active ? h('button', { type: 'button', class: 'btn', onclick: edit }, icon('edit'), t('common.edit')) : '',
        d.can_manage && active ? h('button', { type: 'button', class: 'btn btn-primary', onclick: close }, icon('check'), t('mock.close')) : '',
        d.can_manage && !active && !sv.applied_at ? h('button', { type: 'button', class: 'btn btn-primary', onclick: apply }, icon('check'), t('mock.apply')) : '',
        d.can_manage ? h('button', { type: 'button', class: 'btn btn-icon', title: t('common.delete'), 'aria-label': t('common.delete'), onclick: () => simpleDelete(t('common.delete') + ' ' + sv.code, '/mock/' + id, t('capa.deleted'), () => navigate('quality/mock')) }, icon('trash')) : '',
      ),
    ),
    h(
      'section',
      { class: 'panel kpis' },
      h('div', { class: 'kpi' }, h('span', { class: 'kpi-num', dir: 'ltr' }, pctText(d.total.pct), prev && d.scored ? delta(d.total.pct, prev.pct) : ''), h('span', { class: 'kpi-label' }, t('mock.readiness'))),
      h('div', { class: 'kpi' }, h('span', { class: 'kpi-num', dir: 'ltr' }, d.scored + ' / ' + d.units), h('span', { class: 'kpi-label' }, t('mock.progress'))),
      h('div', { class: 'kpi' }, h('span', { class: 'kpi-num', dir: 'ltr' }, String(d.total.not_met + d.total.partial)), h('span', { class: 'kpi-label' }, t('mock.gaps'))),
      d.has_esr ? h('div', { class: 'kpi' }, h('span', { class: 'kpi-num', dir: 'ltr' }, String(d.total.esr_gap)), h('span', { class: 'kpi-label' }, t('mock.esr_gaps'))) : '',
    ),
    h(
      'section',
      { class: 'panel' },
      panelHead(t('mock.chapters'), prev ? h('span', { class: 'muted small' }, t('mock.vs', { code: prev.code })) : ''),
      h(
        'div',
        { class: 'table-scroll' },
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, [t('qa.chapter'), t('mock.assessor'), t('mock.progress'), t('mock.readiness'), prev ? prev.code : null, ''].filter((x) => x !== null).map((c) => h('th', { scope: 'col' }, c)))),
          h(
            'tbody',
            {},
            d.chapters.map((c) =>
              h(
                'tr',
                {},
                h('td', { class: 'wrap-cell' }, chName(c)),
                h('td', {}, pick(c.user_name, c.user_name_en) || '-'),
                h('td', {}, h('span', { class: 'mono small', dir: 'ltr' }, c.scored + ' / ' + c.units), meter(c.units ? Math.round((c.scored / c.units) * 100) : 0, t('mock.progress'))),
                h('td', {}, h('span', { class: 'mono strong', dir: 'ltr' }, pctText(c.pct)), prev && c.scored ? delta(c.pct, c.prev) : '', c.esr_gap ? h('div', { class: 'small note-expired' }, 'ESR ' + c.esr_gap) : ''),
                prev ? h('td', {}, h('span', { class: 'mono', dir: 'ltr' }, pctText(c.prev))) : null,
                h('td', {}, link('quality/mock/' + id + '.' + c.code, { class: 'btn btn-small' + (c.can_score ? ' btn-primary' : '') }, c.can_score ? t('qa.assess') : t('mock.view'))),
              ),
            ),
          ),
        ),
      ),
    ),
    d.esr_gaps.length
      ? h(
          'section',
          { class: 'panel' },
          panelHead(t('mock.esr_gaps')),
          h('ul', { class: 'mock-gaps' }, d.esr_gaps.map((g) => h('li', {}, h('span', { class: 'mono strong', dir: 'ltr' }, g.code), ' ', pick(g.title_ar, g.title_en), ' ', scoreChip(g.score), g.note ? h('div', { class: 'small muted' }, g.note) : ''))),
        )
      : '',
    sv.result ? h('section', { class: 'panel pad' }, h('h2', {}, t('mock.result')), h('p', { class: 'pre-wrap', dir: 'auto' }, sv.result)) : '',
    tracersPanel(d.tracers, d.can_trace ? h('button', { type: 'button', class: 'btn btn-small', onclick: async () => tracerDialog(await api('/mock'), id) }, icon('plus'), t('tr.add')) : ''),
  );
}

/* --------------------------------- tracers --------------------------------- */

function tracerDialog(d, surveyId) {
  const kind = select([['patient', t('tr.patient')], ...d.topics.map((x) => ['system:' + x, t('tr.topic.' + x)])], 'patient');
  const mrn = input({ type: 'text', maxlength: 30, dir: 'ltr', autocomplete: 'off' });
  const dept = select([['', '-'], ...d.departments.map((x) => [x.id, pick(x.name_ar, x.name_en)])], '');
  const live = d.surveys.filter((s) => s.status === 'active');
  const survey = select([['', '-'], ...live.map((s) => [s.id, s.code + ' · ' + s.title])], surveyId || '');
  const day = input({ type: 'date', value: d.today || '' });
  const mrnField = field(t('tr.mrn'), mrn);
  const sync = () => (mrnField.hidden = kind.value !== 'patient');
  kind.addEventListener('change', sync);
  sync();
  openDialog({
    title: t('tr.add'),
    body: h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, field(t('tr.kind'), kind), mrnField), h('div', { class: 'form-grid' }, field(t('ovr.dept'), dept), field(t('tr.date'), day)), live.length ? field(t('nav.mock'), survey) : ''),
    onSubmit: async () => {
      const [k, topic] = kind.value.split(':');
      const r = await api('/tracers', { method: 'POST', body: { kind: k, topic, mrn: mrn.value, department_id: dept.value ? Number(dept.value) : null, survey_id: survey.value ? Number(survey.value) : null, on_date: day.value } });
      navigate('quality/mock/t' + r.id);
    },
  });
}

async function tracerDetail(root, id, alive) {
  let d;
  try {
    d = await api('/tracers/' + id);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const tr = d.tracer;
  const can = d.can_edit;
  const status = h('span', { class: 'qa-save small muted', role: 'status' });
  const save = async (it) => {
    status.textContent = t('qa.saving');
    status.className = 'qa-save small muted';
    try {
      await api('/tracers/' + id + '/items/' + it.id, { method: 'PUT', body: { result: it.result, note: it.note || '' } });
      status.textContent = t('qa.saved');
      tally();
    } catch (e) {
      status.textContent = errText(e);
      status.className = 'qa-save small form-error';
    }
  };
  const counts = h('div', { class: 'qa-tally', role: 'status' });
  const tally = () => {
    const n = (r) => d.items.filter((i) => i.result === r).length;
    counts.replaceChildren(
      ...[
        ['tr.k_items', d.items.length],
        ['qa.score.met', n('met')],
        ['qa.score.not_met', n('not_met')],
        ['tr.k_open', d.items.filter((i) => !i.result).length],
      ].map(([k, v]) => h('span', { class: 'qa-tally-item' }, h('span', { class: 'muted' }, t(k)), h('b', { class: 'mono' }, String(v)))),
    );
  };
  const itemRow = (it) => {
    const note = input({ type: 'text', class: 'qa-act-note', maxlength: 1000, value: it.note || '', placeholder: t('qa.comment'), 'aria-label': t('qa.comment'), disabled: !can });
    const row = h('li', { class: 'qa-el-assess' });
    const sync = () => row.classList.toggle('is-need', it.result === 'not_met' && !String(it.note || '').trim());
    note.addEventListener('input', () => ((it.note = note.value), sync()));
    note.addEventListener('change', () => save(it));
    const pills = marks(it.result, TR_OPTS(), (v) => ((it.result = v), sync(), save(it)), can, both(it.question));
    row.append(
      h('div', { class: 'qa-el-head' }, it.chapter ? h('span', { class: 'mono small strong', dir: 'ltr' }, it.chapter) : '', it.capa_id ? link('quality/capa', { class: 'small' }, 'CAPA #' + it.capa_id) : ''),
      h('p', { class: 'qa-el-text', dir: 'auto' }, both(it.question)),
      h(
        'div',
        { class: 'qa-act' },
        h(
          'div',
          { class: 'qa-act-head' },
          pills,
          can
            ? h('button', {
                type: 'button',
                class: 'btn btn-icon btn-small',
                title: t('common.delete'),
                'aria-label': t('common.delete'),
                onclick: async () => {
                  await api('/tracers/' + id + '/items/' + it.id, { method: 'DELETE' });
                  render();
                },
              }, icon('close', 16))
            : '',
        ),
        note,
      ),
    );
    sync();
    return row;
  };
  // Lines grouped by station, in the order they were added.
  const groups = [];
  for (const it of d.items) {
    const g = groups[groups.length - 1];
    if (g && g.station === (it.station || '')) g.items.push(it);
    else groups.push({ station: it.station || '', items: [it] });
  }
  const addBox = can
    ? (() => {
        const dept = select([['', '-'], ...d.departments.map((x) => [x.id, pick(x.name_ar, x.name_en)])], '', { 'aria-label': t('tr.station') });
        const q = input({ type: 'text', maxlength: 500, dir: 'auto', placeholder: t('tr.question'), 'aria-label': t('tr.question') });
        const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
        const add = async (body) => {
          err.hidden = true;
          try {
            await api('/tracers/' + id + '/items', { method: 'POST', body });
            render();
          } catch (e) {
            err.textContent = errText(e);
            err.hidden = false;
          }
        };
        return h(
          'section',
          { class: 'panel pad stack' },
          tr.kind === 'patient'
            ? h('div', { class: 'tr-add' }, field(t('tr.next_station'), dept), h('button', { type: 'button', class: 'btn', onclick: () => dept.value && add({ department_id: Number(dept.value) }) }, icon('plus'), t('tr.add_station')))
            : '',
          h('div', { class: 'tr-add' }, field(t('tr.question'), q), h('button', { type: 'button', class: 'btn', onclick: () => q.value.trim() && add({ question: q.value, department_id: dept && dept.value ? Number(dept.value) : null }) }, icon('plus'), t('tr.add_question'))),
          err,
        );
      })()
    : '';
  const close = () => {
    const sum = h('textarea', { rows: 3, maxlength: 2000, dir: 'auto' });
    openDialog({
      title: t('tr.close'),
      body: field(t('mock.result'), sum),
      submitLabel: t('tr.close'),
      onSubmit: async () => {
        const r = await api('/tracers/' + id + '/close', { method: 'POST', body: { summary: sum.value } });
        toast(t('mock.capa_made', { n: r.capa }));
        render();
      },
    });
  };
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        tr.survey_id ? link('quality/mock/' + tr.survey_id, { class: 'back-link' }, tr.survey_code + ' · ' + tr.survey_title) : link('quality/mock', { class: 'back-link' }, t('nav.mock')),
        h('h1', {}, h('span', { class: 'mono', dir: 'ltr' }, tr.code), ' · ', tr.kind === 'patient' ? t('tr.patient') : t('tr.topic.' + tr.topic)),
        h('div', { class: 'qa-std-tags' }, stChip(tr.status), tr.mrn ? h('span', { class: 'tag', dir: 'ltr' }, tr.mrn) : '', pick(tr.dept_ar, tr.dept_en) ? h('span', { class: 'small muted' }, pick(tr.dept_ar, tr.dept_en)) : '', h('span', { class: 'small muted' }, dateEl(tr.on_date), ' · ', tr.by_name || '')),
      ),
      h(
        'div',
        { class: 'actions' },
        can ? h('button', { type: 'button', class: 'btn btn-primary', onclick: close }, icon('check'), t('tr.close')) : '',
        d.can_manage || can ? h('button', { type: 'button', class: 'btn btn-icon', title: t('common.delete'), 'aria-label': t('common.delete'), onclick: () => simpleDelete(t('common.delete') + ' ' + tr.code, '/tracers/' + id, t('capa.deleted'), () => navigate(tr.survey_id ? 'quality/mock/' + tr.survey_id : 'quality/mock')) }, icon('trash')) : '',
      ),
    ),
    h('div', { class: 'qa-assess-top' }, counts, status),
    ...groups.map((g) => h('section', { class: 'panel qa-std' }, g.station ? h('h2', { class: 'tr-station' }, both(g.station)) : '', h('ol', { class: 'qa-el-list' }, g.items.map(itemRow)))),
    addBox,
    tr.summary ? h('section', { class: 'panel pad' }, h('h2', {}, t('mock.result')), h('p', { class: 'pre-wrap', dir: 'auto' }, tr.summary)) : '',
  );
  tally();
}

/* ------------------------------ clinical audits ------------------------------ */

export async function auditsPage(root, param, alive) {
  if (param) return auditDetail(root, Number(param), alive);
  let d;
  try {
    d = await api('/audits');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const f = (S.audF = S.audF || { status: 'active' });
  const pickSt = select([['active', t('mock.st.active')], ['done', t('mock.st.done')], ['', t('capa.all')]], f.status, { 'aria-label': t('ovr.status') });
  const box = h('section', { class: 'panel' });
  const draw = () => {
    const rows = d.audits.filter((a) => !f.status || a.status === f.status);
    box.replaceChildren(
      rows.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['risk.code', 'aud.topic', 'ovr.dept', 'aud.owner', 'aud.cases', 'aud.compliance', 'ovr.status'].map((c) => h('th', { scope: 'col' }, t(c))))),
              h(
                'tbody',
                {},
                rows.map((a) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, link('quality/audits/' + a.id, { class: 'mono strong', dir: 'ltr' }, a.code), a.n_round > 1 ? h('div', { class: 'small muted' }, t('aud.round', { n: a.n_round })) : ''),
                    h('td', { class: 'wrap-cell' }, a.title),
                    h('td', {}, pick(a.dept_ar, a.dept_en) || '-'),
                    h('td', {}, pick(a.owner_name, a.owner_name_en) || '-'),
                    h('td', {}, h('span', { class: 'mono', dir: 'ltr' }, a.n_cases + (a.sample ? ' / ' + a.sample : ''))),
                    h('td', {}, h('span', { class: 'mono strong', dir: 'ltr' }, pctText(a.pct)), a.below ? h('div', { class: 'small note-expired' }, t('aud.below_n', { n: a.below })) : ''),
                    h('td', {}, stChip(a.status)),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, d.audits.length ? t('capa.no_match') : t('aud.empty')),
    );
  };
  pickSt.addEventListener('change', () => ((f.status = pickSt.value), draw()));
  const act = d.audits.filter((a) => a.status === 'active');
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('nav.audits'))), d.can_add ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => auditDialog(null, d) }, icon('plus'), t('aud.add'))) : ''),
    kpiRow([
      ['mock.st.active', act.length],
      ['aud.k_below', act.filter((a) => a.below).length],
      ['mock.st.done', d.audits.filter((a) => a.status === 'done').length],
    ]),
    h('div', { class: 'filters' }, pickSt),
    box,
  );
  draw();
}

function auditDialog(a, d) {
  const lib = a ? null : select([['', '-'], ...d.library.map((x) => [x.key, pick(x.title_ar, x.title_en)])], '');
  const title = input({ type: 'text', required: true, maxlength: 200, dir: 'auto', value: a ? a.title : '' });
  const ref = input({ type: 'text', maxlength: 500, dir: 'auto', value: a ? a.reference || '' : '' });
  const dept = d.dept_only ? null : select([['', '-'], ...d.departments.map((x) => [x.id, pick(x.name_ar, x.name_en)])], a ? a.department_id || '' : '');
  const owner = select([['', '-'], ...d.people.map((p) => [p.id, pick(p.name, p.name_en)])], a ? a.owner_id || '' : S.user.id);
  const chapter = select([['', '-'], ...d.chapters.map((c) => [c.code, chName(c)])], a ? a.chapter || '' : '');
  const from = input({ type: 'date', value: a ? a.period_from || '' : '' });
  const to = input({ type: 'date', value: a ? a.period_to || '' : '' });
  const sample = input({ type: 'number', min: 1, max: 10000, step: 1, dir: 'ltr', value: a && a.sample ? a.sample : '' });
  const kpi = select([['', '-'], ...d.kpis.map((k) => [k.id, k.code + ' · ' + pick(k.name_ar, k.name_en)])], a ? a.kpi_id || '' : '');
  const list = h('ol', { class: 'aud-crit' });
  const crit = [];
  const addRow = (c) => {
    const text = input({ type: 'text', required: true, maxlength: 500, dir: 'auto', value: c ? both(c.text) : '', 'aria-label': t('aud.criterion') });
    text.dataset.raw = c ? c.text : '';
    const target = input({ type: 'number', min: 1, max: 100, step: 1, dir: 'ltr', value: c ? c.target : 90, 'aria-label': t('aud.target') });
    const row = { id: c ? c.id : null, text, target };
    const li = h('li', {}, text, h('span', { class: 'aud-target' }, target, '%'), h('button', { type: 'button', class: 'btn btn-icon btn-small', title: t('common.delete'), 'aria-label': t('common.delete'), onclick: () => (crit.splice(crit.indexOf(row), 1), li.remove()) }, icon('close', 16)));
    row.li = li;
    crit.push(row);
    list.append(li);
  };
  (a ? a.criteria : []).forEach(addRow);
  if (!a) addRow(null);
  if (lib)
    lib.addEventListener('change', () => {
      const x = d.library.find((y) => y.key === lib.value);
      if (!x) return;
      if (!title.value) title.value = pick(x.title_ar, x.title_en);
      if (x.chapter && !chapter.value) chapter.value = x.chapter;
      crit.splice(0).forEach((r) => r.li.remove());
      x.criteria.forEach(addRow);
    });
  openDialog({
    title: a ? t('common.edit') : t('aud.add'),
    body: h(
      'div',
      { class: 'stack' },
      lib ? field(t('kpi.library'), lib) : '',
      field(t('aud.topic'), title),
      field(t('aud.reference'), ref),
      h('div', { class: 'form-grid' }, dept ? field(t('ovr.dept'), dept) : '', field(t('aud.owner'), owner), field(t('qa.chapter'), chapter), field(t('qp.kpi'), kpi)),
      h('div', { class: 'form-grid' }, field(t('aud.from'), from), field(t('aud.to'), to), field(t('aud.sample'), sample)),
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('aud.criteria')), list, h('button', { type: 'button', class: 'btn-link small', onclick: () => addRow(null) }, icon('plus', 14), t('aud.add_criterion'))),
    ),
    onSubmit: async () => {
      const body = {
        title: title.value,
        reference: ref.value,
        department_id: dept && dept.value ? Number(dept.value) : null,
        owner_id: owner.value ? Number(owner.value) : null,
        chapter: chapter.value,
        period_from: from.value,
        period_to: to.value,
        sample: sample.value ? Number(sample.value) : null,
        kpi_id: kpi.value ? Number(kpi.value) : null,
        library: lib ? lib.value : undefined,
        // A library line keeps both languages while its wording is unchanged.
        criteria: crit.map((r) => ({ id: r.id, text: r.text.dataset.raw && both(r.text.dataset.raw) === r.text.value ? r.text.dataset.raw : r.text.value, target: Number(r.target.value) || 90 })),
      };
      const r = await api(a ? '/audits/' + a.id : '/audits', { method: a ? 'PUT' : 'POST', body });
      toast(t('capa.saved'));
      if (a) render();
      else navigate('quality/audits/' + r.id);
    },
  });
}

function caseDialog(d, c) {
  const mrn = input({ type: 'text', required: true, maxlength: 30, dir: 'ltr', autocomplete: 'off', value: c ? c.mrn : '' });
  const day = input({ type: 'date', value: c ? c.case_date : new Date().toLocaleDateString('en-CA') });
  const note = input({ type: 'text', maxlength: 1000, dir: 'auto', value: c ? c.note || '' : '' });
  const ans = Object.assign({}, c ? c.answers : {});
  const rows = d.criteria.map((k) =>
    h('li', { class: 'aud-case-row' }, h('span', { dir: 'auto' }, both(k.text)), marks(ans[k.id] || null, AUD_OPTS(), (v) => (ans[k.id] = v), true, both(k.text))),
  );
  openDialog({
    title: c ? t('common.edit') : t('aud.add_case'),
    body: h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, field(t('tr.mrn'), mrn), field(t('tr.date'), day)), h('ol', { class: 'aud-case' }, rows), field(t('qa.comment'), note)),
    onSubmit: async () => {
      await api('/audits/' + d.audit.id + '/cases' + (c ? '/' + c.id : ''), { method: c ? 'PUT' : 'POST', body: { mrn: mrn.value, case_date: day.value, answers: ans, note: note.value } });
      toast(t('capa.saved'));
      render();
    },
  });
}

async function auditDetail(root, id, alive) {
  let d;
  try {
    d = await api('/audits/' + id);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const a = d.audit;
  const prev = d.prev;
  const edit = async () => auditDialog({ ...a, criteria: d.criteria }, await api('/audits'));
  const close = () => {
    const below = d.criteria.filter((c) => c.met === false).length;
    const plan = select([['capa', t('aud.plan.capa')], ['pdsa', t('aud.plan.pdsa')], ['none', t('aud.plan.none')]], below ? 'capa' : 'none');
    const result = h('textarea', { rows: 3, maxlength: 2000, dir: 'auto' });
    openDialog({
      title: t('aud.close'),
      body: h('div', { class: 'stack' }, h('p', {}, t('aud.below_n', { n: below })), field(t('aud.plan'), plan), field(t('mock.result'), result)),
      submitLabel: t('aud.close'),
      onSubmit: async () => {
        const r = await api('/audits/' + id + '/close', { method: 'POST', body: { plan: plan.value, result: result.value } });
        if (r.pdsa_id) navigate('quality/pdsa/' + r.pdsa_id);
        else {
          toast(t('mock.capa_made', { n: r.made }));
          render();
        }
      },
    });
  };
  const reaudit = async () => {
    const r = await api('/audits/' + id + '/reaudit', { method: 'POST' });
    navigate('quality/audits/' + r.id);
  };
  const ansCell = (v) => h('td', { class: 'mono ' + (v === 'n' ? 'note-expired' : v === 'y' ? 'note-valid' : 'muted'), dir: 'ltr' }, v === 'y' ? '✓' : v === 'n' ? '✗' : 'NA');
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        link('quality/audits', { class: 'back-link' }, t('nav.audits')),
        h('h1', {}, h('span', { class: 'mono', dir: 'ltr' }, a.code), ' · ', a.title),
        h(
          'div',
          { class: 'qa-std-tags' },
          stChip(a.status),
          a.n_round > 1 ? h('span', { class: 'tag' }, t('aud.round', { n: a.n_round })) : '',
          prev ? link('quality/audits/' + prev.id, { class: 'small mono', dir: 'ltr' }, prev.code) : '',
          d.next ? link('quality/audits/' + d.next.id, { class: 'small' }, t('aud.reaudit') + ' ', h('span', { class: 'mono', dir: 'ltr' }, d.next.code)) : '',
          pick(a.dept_ar, a.dept_en) ? h('span', { class: 'small muted' }, pick(a.dept_ar, a.dept_en)) : '',
          a.kpi_code ? h('span', { class: 'small mono', dir: 'ltr' }, a.kpi_code) : '',
        ),
        a.reference ? h('p', { class: 'small muted', dir: 'auto' }, a.reference) : '',
      ),
      h(
        'div',
        { class: 'actions' },
        d.can_edit ? h('button', { type: 'button', class: 'btn', onclick: edit }, icon('edit'), t('common.edit')) : '',
        d.can_close ? h('button', { type: 'button', class: 'btn', onclick: close }, icon('check'), t('aud.close')) : '',
        d.can_reaudit ? h('button', { type: 'button', class: 'btn btn-primary', onclick: reaudit }, icon('plus'), t('aud.reaudit')) : '',
        d.can_enter ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => caseDialog(d) }, icon('plus'), t('aud.add_case')) : '',
        d.can_delete ? h('button', { type: 'button', class: 'btn btn-icon', title: t('common.delete'), 'aria-label': t('common.delete'), onclick: () => simpleDelete(t('common.delete') + ' ' + a.code, '/audits/' + id, t('capa.deleted'), () => navigate('quality/audits')) }, icon('trash')) : '',
      ),
    ),
    h(
      'section',
      { class: 'panel kpis' },
      h('div', { class: 'kpi' }, h('span', { class: 'kpi-num', dir: 'ltr' }, pctText(d.pct), prev ? delta(d.pct, prev.pct) : ''), h('span', { class: 'kpi-label' }, t('aud.compliance'))),
      h('div', { class: 'kpi' }, h('span', { class: 'kpi-num', dir: 'ltr' }, d.cases + (a.sample ? ' / ' + a.sample : '')), h('span', { class: 'kpi-label' }, t('aud.cases'))),
      h('div', { class: 'kpi' }, h('span', { class: 'kpi-num', dir: 'ltr' }, String(d.criteria.filter((c) => c.met === false).length)), h('span', { class: 'kpi-label' }, t('aud.k_below'))),
    ),
    h(
      'section',
      { class: 'panel' },
      panelHead(t('aud.criteria'), prev ? h('span', { class: 'muted small' }, t('mock.vs', { code: prev.code })) : ''),
      h(
        'div',
        { class: 'table-scroll' },
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, ['#', t('aud.criterion'), t('aud.target'), '✓', '✗', 'NA', t('aud.compliance'), prev ? prev.code : null].filter((x) => x !== null).map((c) => h('th', { scope: 'col' }, c)))),
          h(
            'tbody',
            {},
            d.criteria.map((c) =>
              h(
                'tr',
                {},
                h('td', { class: 'mono' }, String(c.n)),
                h('td', { class: 'wrap-cell', dir: 'auto' }, both(c.text)),
                h('td', { class: 'mono', dir: 'ltr' }, c.target + '%'),
                h('td', { class: 'mono' }, String(c.yes)),
                h('td', { class: 'mono' }, String(c.no)),
                h('td', { class: 'mono' }, String(c.na)),
                h('td', {}, h('span', { class: 'chip ' + (c.met === false ? 'chip-expired' : c.met ? 'chip-valid' : '') }, pctText(c.pct)), prev ? delta(c.pct, prev.criteria[c.n]) : ''),
                prev ? h('td', { class: 'mono', dir: 'ltr' }, pctText(prev.criteria[c.n])) : null,
              ),
            ),
          ),
        ),
      ),
    ),
    h(
      'section',
      { class: 'panel' },
      panelHead(t('aud.cases')),
      d.list.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, [t('tr.mrn'), t('tr.date'), ...d.criteria.map((c) => '#' + c.n), t('qa.comment'), ''].map((c) => h('th', { scope: 'col' }, c)))),
              h(
                'tbody',
                {},
                d.list.map((c) =>
                  h(
                    'tr',
                    {},
                    h('td', { class: 'mono', dir: 'ltr' }, c.mrn),
                    h('td', {}, dateEl(c.case_date)),
                    ...d.criteria.map((k) => ansCell(c.answers[k.id])),
                    h('td', { class: 'wrap-cell small' }, c.note || '', h('div', { class: 'muted' }, c.by_name || '')),
                    h(
                      'td',
                      {},
                      d.can_enter
                        ? h('span', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-icon btn-small', title: t('common.edit'), 'aria-label': t('common.edit'), onclick: () => caseDialog(d, c) }, icon('edit', 16)), h('button', { type: 'button', class: 'btn btn-icon btn-small', title: t('common.delete'), 'aria-label': t('common.delete'), onclick: () => simpleDelete(t('common.delete') + ' ' + c.mrn, '/audits/' + id + '/cases/' + c.id, t('capa.deleted')) }, icon('trash', 16)))
                        : '',
                    ),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('aud.no_cases')),
    ),
    a.result || (a.plan && a.plan !== 'none') ? h('section', { class: 'panel pad' }, h('h2', {}, t('mock.result')), a.plan && a.plan !== 'none' ? h('p', {}, h('span', { class: 'tag' }, t('aud.plan.' + a.plan))) : '', a.result ? h('p', { class: 'pre-wrap', dir: 'auto' }, a.result) : '') : '',
  );
}

