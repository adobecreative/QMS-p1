// Investigations: the register, one investigation (questions and answers, files, the committee's minutes, the person's
// reply, the decision) and the settings (approver, human resources, deadlines, penalties). Run by quality and HR.
import { render } from '../app.js';
import { kpiRow } from './assets.js';
import { S, h, icon, t } from './core.js';
import { link, printHead, setUrl } from './layout.js';
import { api, checkField, dateEl, errText, errorBox, field, input, openDialog, select, toast } from './offline.js';
import { fmtTime, pick, simpleDelete } from './tickets.js';

export const INV_STATUS = ['open', 'reply', 'decision', 'closed'];
const ST_CHIP = { open: 'chip-near', reply: 'chip-review', decision: 'chip-review', closed: 'chip-valid' };
const invChip = (s) => h('span', { class: 'chip ' + ST_CHIP[s] }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('ivg.st.' + s));
const para = (v) => h('span', { class: 'pre-wrap', dir: 'auto' }, v);
const kv = (label, value) => (value === '' || value === null || value === undefined ? null : h('div', { class: 'kv' }, h('dt', {}, label), h('dd', {}, value)));
const late = (on) => (on ? h('span', { class: 'note note-expired' }, ' ', t('rnd.late')) : '');
const personOpt = (p) => [p.id, pick(p.name, p.name_en) + (p.dept_ar ? ' - ' + pick(p.dept_ar, p.dept_en) : '')];
const here = (path) => {
  S.route = path;
  setUrl(path);
};
let penCache = null;
const penalties = async () => (penCache = (await api('/inv/penalties')).penalties);
// "Salary deduction · 3 days", or "Cleared".
const outcomeText = (outcome, ar, en, days) => (outcome === 'cleared' ? t('ivg.cleared') : outcome ? pick(ar, en) + (days ? ' · ' + t('ivg.n_days', { n: days }) : '') : '');

/* --------------------------------- register -------------------------------- */

// inv/invs, or inv/invs/12 for one investigation.
export async function invListPage(root, param, alive) {
  if (param) return invDetail(root, param, alive);
  let d;
  try {
    d = await api('/inv');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const officer = d.role.officer;
  const f = (S.invF = S.invF || { q: '', status: 'open' });
  const search = input({ type: 'search', class: 'doc-search-input', value: f.q, placeholder: t('ivg.search_ph'), 'aria-label': t('ivg.search_ph'), autocomplete: 'off' });
  const pickSt = select([['open', t('ovr.open_only')], ['', t('capa.all')], ...INV_STATUS.map((s) => [s, t('ivg.st.' + s)])], f.status, { 'aria-label': t('ovr.status') });
  const box = h('div', {});
  const norm = (v) => String(v || '').toLowerCase();
  const draw = () => {
    const q = norm(f.q.trim());
    const rows = d.invs.filter(
      (i) => (f.status === 'open' ? i.status !== 'closed' : !f.status || i.status === f.status) && (!q || ['#' + i.id, i.title, i.subject_name, i.dept_ar, i.dept_en].some((v) => norm(v).includes(q))),
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
                h('thead', {}, h('tr', {}, ['ovr.no', 'ivg.case', 'ovr.dept', 'ovr.due', 'ovr.status'].map((c) => h('th', { scope: 'col' }, t(c))))),
                h(
                  'tbody',
                  {},
                  rows.map((i) =>
                    h(
                      'tr',
                      {},
                      h('td', {}, link('inv/invs/' + i.id, { class: 'mono strong', dir: 'ltr' }, '#' + i.id), h('div', { class: 'small muted' }, fmtTime(i.created_at))),
                      h(
                        'td',
                        { class: 'wrap-cell' },
                        i.title ? h('div', {}, i.title) : h('div', { class: 'muted' }, t('ivg.questions')),
                        i.subject_name ? h('div', { class: 'small muted' }, i.subject_name) : '',
                        i.my_questions ? h('div', { class: 'small' }, h('span', { class: 'note ' + (i.my_due && i.my_due < d.today ? 'note-expired' : 'note-near') }, t('ivg.my_questions', { n: i.my_questions }))) : '',
                        i.waiting_me ? h('div', { class: 'small' }, h('span', { class: 'note note-near' }, t('ivg.waiting_me'))) : '',
                      ),
                      h('td', {}, pick(i.dept_ar, i.dept_en) || '-'),
                      h('td', {}, i.due ? h('span', {}, dateEl(i.due), late(i.late)) : '-'),
                      h('td', {}, invChip(i.status), i.outcome ? h('div', { class: 'small muted' }, t(i.outcome === 'cleared' ? 'ivg.cleared' : 'ivg.penalty')) : ''),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty' }, d.invs.length ? t('capa.no_match') : t('ivg.empty')),
      ),
    );
  };
  search.addEventListener('input', () => ((f.q = search.value), draw()));
  pickSt.addEventListener('change', () => ((f.status = pickSt.value), draw()));
  const open = d.invs.filter((i) => i.status !== 'closed');
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.invs'))),
      officer ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => caseDialog(null) }, icon('plus'), t('ivg.new'))) : '',
    ),
    officer
      ? kpiRow([
          ['ivg.k_open', open.length],
          ['ivg.k_decision', open.filter((i) => i.status === 'decision').length],
          ['ivg.k_late', open.filter((i) => i.late).length],
          ['ivg.k_closed', d.invs.length - open.length],
        ])
      : '',
    h('div', { class: 'filters' }, h('div', { class: 'doc-search', role: 'search' }, icon('search'), search), pickSt),
    box,
  );
  draw();
}

// Pick several people: a list to add from, and chips to take off.
function peoplePicker(people, ids, exclude) {
  const st = [...ids];
  const chips = h('div', { class: 'chips' });
  const pickOne = select([], '');
  const draw = () => {
    chips.replaceChildren(
      ...st.map((id) => {
        const p = people.find((x) => x.id === id);
        return h('span', { class: 'tag rca-chip' }, p ? pick(p.name, p.name_en) : '#' + id, h('button', { type: 'button', class: 'btn btn-small', 'aria-label': t('common.delete'), onclick: () => (st.splice(st.indexOf(id), 1), draw()) }, '×'));
      }),
    );
    const ex = exclude ? exclude() : [];
    pickOne.replaceChildren(...[['', t('rca.team_add')], ...people.filter((p) => !st.includes(p.id) && !ex.includes(p.id)).map(personOpt)].map(([v, x]) => h('option', { value: v }, x)));
  };
  pickOne.addEventListener('change', () => {
    if (pickOne.value) st.push(Number(pickOne.value));
    draw();
  });
  draw();
  return { el: h('div', { class: 'stack' }, chips, pickOne), ids: () => st, draw };
}

// Open (or edit) an investigation: the case, the person and the committee.
async function caseDialog(inv) {
  const { people, departments } = await api('/inv/people');
  const title = input({ type: 'text', required: true, maxlength: 200, dir: 'auto', value: inv ? inv.title : '' });
  const details = h('textarea', { rows: 3, maxlength: 4000, dir: 'auto' }, inv ? inv.details : '');
  const requested = input({ type: 'text', maxlength: 200, dir: 'auto', value: inv ? inv.requested_by : '' });
  const subj = select([['', t('req.pick')], ...people.map(personOpt), ['other', t('ivg.no_account')]], inv ? inv.subject_user_id || 'other' : '', { required: true });
  const sName = input({ type: 'text', maxlength: 120, dir: 'auto', value: inv && !inv.subject_user_id ? inv.subject_name : '' });
  const sEmp = input({ type: 'text', maxlength: 30, dir: 'ltr', inputmode: 'numeric', value: inv ? inv.subject_emp_no : '' });
  const other = h('div', { class: 'form-grid' }, field(t('req.name'), sName), field(t('staff.emp_no'), sEmp));
  const syncOther = () => {
    other.hidden = subj.value !== 'other';
    sName.required = subj.value === 'other';
  };
  subj.addEventListener('change', () => {
    syncOther();
    const p = people.find((x) => String(x.id) === subj.value);
    if (p && p.department_id) dept.value = p.department_id;
    members.draw();
    head.querySelectorAll('option').forEach((o) => (o.disabled = o.value && o.value === subj.value));
  });
  const dept = select([['', '-'], ...departments.map((x) => [x.id, pick(x.name_ar, x.name_en)])], inv ? inv.department_id || '' : '');
  const comm = inv ? inv.committee || [] : [];
  const headNow = comm.find((x) => x.role === 'head');
  const head = select([['', '-'], ...people.map(personOpt)], headNow ? headNow.id : !inv ? S.user.id : '');
  const members = peoplePicker(people, comm.filter((x) => x.role === 'member').map((x) => x.id), () => [Number(head.value), Number(subj.value)].filter(Boolean));
  head.addEventListener('change', () => members.draw());
  syncOther();
  openDialog({
    title: inv ? t('ivg.edit') + ' #' + inv.id : t('ivg.new'),
    body: h(
      'div',
      { class: 'stack' },
      field(t('ivg.title'), title),
      field(t('ivg.details'), details),
      h('div', { class: 'form-grid' }, field(t('ivg.subject'), subj), field(t('ovr.dept'), dept)),
      other,
      field(t('ivg.requested_by'), requested),
      h('div', { class: 'form-grid' }, field(t('ivg.head'), head), field(t('ivg.members'), members.el)),
    ),
    onSubmit: async () => {
      const body = {
        title: title.value, details: details.value, requested_by: requested.value, department_id: dept.value ? Number(dept.value) : null,
        subject_user_id: subj.value && subj.value !== 'other' ? Number(subj.value) : null, subject_name: sName.value, subject_emp_no: sEmp.value,
        head_id: head.value ? Number(head.value) : null, members: members.ids(),
      };
      const r = await api(inv ? '/inv/' + inv.id : '/inv', { method: inv ? 'PUT' : 'POST', body });
      toast(t('capa.saved'));
      if (!inv) here('inv/invs/' + r.id);
      render();
    },
  });
}

/* ------------------------------- one investigation ------------------------------ */

async function invDetail(root, id, alive) {
  let d;
  try {
    [d] = await Promise.all([api('/inv/' + id), penalties()]);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const i = d.inv;
  const can = i.can;
  const reload = () => render();
  const post = async (path, body, msg) => {
    await api('/inv/' + i.id + path, { method: 'POST', body });
    toast(t(msg));
    reload();
  };
  const witness = i.part === 'witness';
  const subject = i.part === 'subject';

  const actions = [];
  if (can.edit && d.role.officer) actions.push(h('button', { type: 'button', class: 'btn', onclick: () => caseDialog(i) }, icon('edit'), t('ivg.edit')));
  if (!witness) actions.push(h('button', { type: 'button', class: 'btn', onclick: () => window.print() }, icon('file'), t('rep.print')));
  if (can.delete) actions.push(h('button', { type: 'button', class: 'btn', 'aria-label': t('common.delete'), onclick: () => simpleDelete(t('ivg.delete_q'), '/inv/' + i.id, t('capa.deleted'), () => (here('inv/invs'), render())) }, icon('trash')));

  // The stages and their dates.
  const order = ['open', 'reply', 'decision', 'closed'];
  const at = order.indexOf(i.status);
  const stages = witness
    ? ''
    : h(
        'ol',
        { class: 'rca-stages' },
        [['open', i.minutes_due], ['reply', i.reply_due], ['decision', i.decision_due]].map(([k, due], n) =>
          h(
            'li',
            { class: (n < at ? 'is-done' : n === at ? 'is-current' : '') + (n === at && i.late ? ' is-late' : '') },
            h('b', {}, (n < at ? '✓ ' : n + 1 + '. ') + t('ivg.stage.' + k)),
            due ? h('span', { class: 'small muted' }, ' ', dateEl(due)) : '',
          ),
        ),
      );

  const committee = (i.committee || []).map((p) => pick(p.name, p.name_en) + (p.role === 'head' ? ' (' + t('ivg.head') + ')' : '')).join('، ');
  const facts = witness
    ? h('section', { class: 'panel pad' }, h('p', { class: 'notice' }, t('ivg.witness_note')))
    : h(
        'section',
        { class: 'panel pad' },
        h(
          'dl',
          { class: 'kv-list ovr-facts' },
          kv(t('ivg.subject'), i.subject_name + (i.subject_emp_no ? ' · ' + i.subject_emp_no : '')),
          kv(t('ovr.dept'), pick(i.dept_ar, i.dept_en)),
          kv(t('ivg.requested_by'), i.requested_by),
          kv(t('ivg.details'), i.details ? para(i.details) : ''),
          kv(t('ivg.committee'), committee),
          kv(t('ivg.opened_by'), i.opened_by ? i.opened_by + ' · ' + fmtTime(i.created_at) : ''),
        ),
      );

  // Questions, by person. The person answers here; for someone without an account the committee writes the answer.
  const qs = i.questions || [];
  const byPerson = [];
  for (const q of qs) {
    const key = (q.to_user_id || 'n') + ':' + q.to_name;
    let g = byPerson.find((x) => x.key === key);
    if (!g) byPerson.push((g = { key, name: q.to_name, kind: q.kind, list: [] }));
    g.list.push(q);
  }
  const qEl = (q) => {
    const mine = q.to_user_id === S.user.id;
    const canAnswer = !q.answer && i.status === 'open' && (mine || (!q.to_user_id && can.ask));
    return h(
      'li',
      {},
      h('div', {}, h('b', {}, para(q.question))),
      h('div', { class: 'small muted' }, q.asked_by, ' · ', t('ovr.due'), ' ', dateEl(q.due), late(q.late)),
      q.answer
        ? h('div', {}, h('span', { class: 'muted' }, t('ivg.answer') + ': '), para(q.answer), h('div', { class: 'small muted' }, (q.to_user_id ? '' : t('ivg.recorded_by') + ' ' + q.answered_by + ' · ') + fmtTime(q.answered_at)))
        : i.status !== 'open' ? h('div', { class: 'small muted' }, t('ivg.no_answer')) : '',
      canAnswer || (can.ask && !q.answer)
        ? h(
            'div',
            { class: 'actions' },
            canAnswer ? h('button', { type: 'button', class: 'btn btn-primary btn-small', onclick: () => answerDialog(i, q) }, t(mine ? 'ivg.do_answer' : 'ivg.record_answer')) : '',
            can.ask && !q.answer ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => simpleDelete(t('ivg.unask_q'), '/inv/' + i.id + '/questions/' + q.id, t('capa.deleted'), reload) }, icon('trash')) : '',
          )
        : '',
    );
  };
  const qPanel =
    qs.length || can.ask
      ? h(
          'section',
          { class: 'panel pad stack' },
          h('div', { class: 'section-head' }, h('h2', {}, t('ivg.questions')), can.ask ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => askDialog(i) }, icon('plus'), t('ivg.ask')) : ''),
          byPerson.length
            ? byPerson.map((g) => h('div', { class: 'stack' }, h('h3', {}, g.name, ' ', h('span', { class: 'small muted' }, t('ivg.kind.' + g.kind))), h('ul', { class: 'steps' }, g.list.map(qEl))))
            : h('p', { class: 'muted small' }, t('ivg.no_questions')),
        )
      : '';

  // Files: anyone taking part adds; the committee sees them all, the person and a witness their own.
  const files = i.files || [];
  const filesPanel =
    files.length || can.upload
      ? h(
          'section',
          { class: 'panel pad stack' },
          h('div', { class: 'section-head' }, h('h2', {}, t('ivg.files')), can.upload ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => uploadDialog(i) }, icon('plus'), t('ivg.add_file')) : ''),
          files.length
            ? h(
                'ul',
                { class: 'ack-list' },
                files.map((f) =>
                  h(
                    'li',
                    {},
                    h('a', { href: '/api/inv/' + i.id + '/files/' + f.id, target: '_blank', rel: 'noopener' }, f.name),
                    h('span', { class: 'small muted' }, (f.by_name || '') + ' · ' + fmtTime(f.created_at)),
                    can.upload && (d.role.officer || f.by_id === S.user.id) ? h('button', { type: 'button', class: 'btn btn-small', 'aria-label': t('common.delete'), onclick: () => simpleDelete(t('ivg.file_delete_q'), '/inv/' + i.id + '/files/' + f.id, t('capa.deleted'), reload) }, icon('trash')) : '',
                  ),
                ),
              )
            : h('p', { class: 'muted small' }, t('ivg.no_files')),
        )
      : '';

  root.replaceChildren(
    printHead(),
    h('p', { class: 'no-print' }, link('inv/invs', {}, '← ' + t('nav.invs'))),
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('ivg.track', { n: i.id }), ' ', invChip(i.status)), h('p', {}, witness ? '' : i.title)), actions.length ? h('div', { class: 'actions' }, actions) : ''),
    stages,
    facts,
    qPanel,
    filesPanel,
    witness ? '' : minutesPanel(i, can, reload),
    witness ? '' : replyPanel(i, can, subject, post),
    witness ? '' : decisionPanel(i, can, post),
    i.steps && i.steps.length
      ? h('section', { class: 'panel pad stack no-print' }, h('h2', {}, t('ovr.history')), h('ul', { class: 'steps' }, i.steps.map((s) => h('li', {}, h('div', { class: 'step-head' }, h('b', {}, t('ivg.step.' + s.kind)), s.by_name ? ' · ' + s.by_name : '', ' · ', h('span', { class: 'small muted' }, fmtTime(s.at))), s.text ? para(s.text) : ''))))
      : '',
  );
}

// The outcome controls: cleared, or a penalty (with days when it takes them).
function outcomeFields(outcome, penaltyId, days) {
  const list = (penCache || []).filter((p) => p.active || p.id === penaltyId);
  const pick1 = select([['', t('req.pick')], ['cleared', t('ivg.cleared')], ...list.map((p) => ['p' + p.id, pick(p.name_ar, p.name_en)])], outcome === 'cleared' ? 'cleared' : penaltyId ? 'p' + penaltyId : '');
  const n = input({ type: 'number', min: 1, max: 365, step: 1, inputmode: 'numeric', value: days || '' });
  const nField = field(t('ivg.days'), n);
  const sync = () => {
    const p = list.find((x) => 'p' + x.id === pick1.value);
    nField.hidden = !(p && p.days);
    n.required = !nField.hidden;
  };
  pick1.addEventListener('change', sync);
  sync();
  return {
    pick: pick1,
    nField,
    value: () => (pick1.value === 'cleared' ? { outcome: 'cleared' } : pick1.value ? { outcome: 'penalty', penalty_id: Number(pick1.value.slice(1)), days: nField.hidden ? null : Number(n.value) } : { outcome: '' }),
  };
}

// The committee's minutes: written and saved, then submitted for the person's reply (or straight to the decision).
function minutesPanel(i, can, reload) {
  if (!can.minutes) {
    if (!i.minutes_at) return '';
    return h(
      'section',
      { class: 'panel pad stack' },
      h('h2', {}, t('ivg.minutes')),
      h(
        'dl',
        { class: 'kv-list' },
        kv(t('ivg.facts'), para(i.facts)),
        kv(t('ivg.finding'), para(i.finding)),
        kv(t('ivg.recommend'), outcomeText(i.rec_outcome, i.rec_pen_ar, i.rec_pen_en, i.rec_days)),
        kv(t('ivg.minutes_by'), i.minutes_by + ' · ' + fmtTime(i.minutes_at)),
      ),
    );
  }
  const facts = h('textarea', { rows: 5, maxlength: 8000, dir: 'auto' }, i.facts || '');
  const finding = h('textarea', { rows: 3, maxlength: 4000, dir: 'auto' }, i.finding || '');
  const rec = outcomeFields(i.rec_outcome, i.rec_penalty_id, i.rec_days);
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const save = (submit) => async () => {
    err.hidden = true;
    try {
      const v = rec.value();
      await api('/inv/' + i.id + '/minutes', { method: 'PUT', body: { facts: facts.value, finding: finding.value, rec_outcome: v.outcome || null, rec_penalty_id: v.penalty_id || null, rec_days: v.days || null, submit } });
      toast(t(submit ? 'ivg.minutes_sent' : 'capa.saved'));
      reload();
    } catch (e) {
      err.textContent = errText(e);
      err.hidden = false;
    }
  };
  return h(
    'section',
    { class: 'panel pad stack' },
    h('h2', {}, t('ivg.minutes')),
    field(t('ivg.facts'), facts),
    field(t('ivg.finding'), finding),
    h('div', { class: 'form-grid' }, field(t('ivg.recommend'), rec.pick), rec.nField),
    err,
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: save(false) }, t('common.save')), h('button', { type: 'button', class: 'btn btn-primary', onclick: save(true) }, icon('check'), t('ivg.submit_minutes'))),
  );
}

// The person's right of reply to the minutes.
function replyPanel(i, can, subject, post) {
  if (can.reply) {
    const text = h('textarea', { rows: 4, maxlength: 4000, required: true, dir: 'auto' });
    return h(
      'section',
      { class: 'panel pad stack' },
      h('h2', {}, t('ivg.reply')),
      h('p', { class: 'small muted' }, t('ovr.due'), ' ', dateEl(i.reply_due), late(i.late)),
      text,
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => (text.value.trim() ? post('/reply', { reply: text.value }, 'ivg.replied') : text.focus()) }, t('ivg.send_reply'))),
    );
  }
  if (i.reply) return h('section', { class: 'panel pad stack' }, h('h2', {}, t('ivg.reply')), para(i.reply), h('p', { class: 'small muted' }, fmtTime(i.reply_at)));
  if ((i.status === 'decision' || i.status === 'closed') && i.subject_user_id && i.minutes_at && !subject) return h('section', { class: 'panel pad' }, h('h2', {}, t('ivg.reply')), h('p', { class: 'muted' }, t('ivg.no_reply')));
  return '';
}

// The decision: the approver decides or returns the minutes; closed, everyone taking part sees it.
function decisionPanel(i, can, post) {
  if (i.status === 'closed')
    return h(
      'section',
      { class: 'panel pad stack' },
      h('h2', {}, t('ivg.decision')),
      h('dl', { class: 'kv-list' }, kv(t('ivg.decision'), h('b', {}, outcomeText(i.outcome, i.pen_ar, i.pen_en, i.penalty_days))), kv(t('ovr.note'), i.decision_note ? para(i.decision_note) : ''), kv(t('ivg.decided_by'), i.decided_by + ' · ' + fmtTime(i.decided_at))),
    );
  if (!can.decide) return '';
  const out = outcomeFields(i.rec_outcome, i.rec_penalty_id, i.rec_days);
  const note = h('textarea', { rows: 3, maxlength: 3000, dir: 'auto' });
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const go = (fn) => async () => {
    err.hidden = true;
    try {
      await fn();
    } catch (e) {
      err.textContent = errText(e);
      err.hidden = false;
    }
  };
  return h(
    'section',
    { class: 'panel pad stack' },
    h('h2', {}, t('ivg.decision')),
    i.status === 'reply' ? h('p', { class: 'small muted' }, t('ivg.no_reply')) : '',
    h('div', { class: 'form-grid' }, field(t('ivg.decision'), out.pick), out.nField),
    field(t('ovr.note'), note),
    err,
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', class: 'btn', onclick: go(() => (note.value.trim() ? post('/return', { note: note.value }, 'ivg.returned') : Promise.reject(new Error(t('err.ovr_note_required'))))) }, t('ivg.return')),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: go(() => post('/decide', { ...out.value(), note: note.value }, 'ivg.decided')) }, icon('check'), t('ivg.decide')),
    ),
  );
}

async function askDialog(i) {
  const { people } = await api('/inv/people');
  const to = select(
    [['subject', t('ivg.kind.subject') + ' - ' + i.subject_name], ...people.filter((p) => p.id !== i.subject_user_id).map(personOpt), ['other', t('ivg.no_account')]],
    'subject',
  );
  const name = input({ type: 'text', maxlength: 120, dir: 'auto' });
  const nameField = field(t('req.name'), name);
  const sync = () => {
    nameField.hidden = to.value !== 'other';
    name.required = !nameField.hidden;
  };
  to.addEventListener('change', sync);
  sync();
  const text = h('textarea', { rows: 5, maxlength: 8000, required: true, dir: 'auto' });
  openDialog({
    title: t('ivg.ask') + ' #' + i.id,
    body: h('div', { class: 'stack' }, field(t('ivg.to'), to), nameField, field(t('ivg.questions'), text, t('ivg.one_per_line'))),
    onSubmit: async () => {
      const questions = text.value.split('\n').map((x) => x.trim()).filter(Boolean);
      await api('/inv/' + i.id + '/questions', { method: 'POST', body: { to: to.value === 'other' ? '' : to.value === 'subject' ? 'subject' : Number(to.value), to_name: name.value, questions } });
      toast(t('ivg.asked'));
      render();
    },
  });
}

function answerDialog(i, q) {
  const text = h('textarea', { rows: 5, maxlength: 4000, required: true, dir: 'auto' });
  openDialog({
    title: t(q.to_user_id ? 'ivg.do_answer' : 'ivg.record_answer'),
    body: h('div', { class: 'stack' }, h('p', {}, h('b', {}, para(q.question))), field(t('ivg.answer'), text)),
    onSubmit: async () => {
      await api('/inv/' + i.id + '/questions/' + q.id, { method: 'POST', body: { answer: text.value } });
      toast(t('ovr.answered'));
      render();
    },
  });
}

function uploadDialog(i) {
  const file = input({ type: 'file', required: true, accept: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg' });
  const name = input({ type: 'text', maxlength: 160, dir: 'auto' });
  openDialog({
    title: t('ivg.add_file'),
    body: h('div', { class: 'stack' }, field(t('ivg.file'), file), field(t('ivg.file_name'), name)),
    onSubmit: async () => {
      const fd = new FormData();
      fd.set('file', file.files[0]);
      fd.set('name', name.value);
      await api('/inv/' + i.id + '/files', { method: 'POST', form: fd });
      toast(t('capa.saved'));
      render();
    },
  });
}

/* ---------------------------------- settings ---------------------------------- */

// inv/invset: the approver, human resources, deadlines, committee absences and the penalties.
export async function invSettingsPage(root, _param, alive) {
  let cfg, people, pens;
  try {
    [cfg, { people }, pens] = await Promise.all([api('/inv/settings'), api('/inv/people'), api('/inv/penalties')]);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const approver = select([['', '-'], ...people.map(personOpt)], cfg.approver || '');
  const staff = peoplePicker(people, cfg.staff);
  const num = (v, max) => input({ type: 'number', min: 1, max, step: 1, required: true, inputmode: 'numeric', value: v });
  const ans = num(cfg.answer_days, 30);
  const mins = num(cfg.minutes_days, 60);
  const dec = num(cfg.decision_days, 30);
  const after = input({ type: 'number', min: 0, max: 20, step: 1, required: true, inputmode: 'numeric', value: cfg.absence_after });
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const form = h(
    'form',
    { class: 'panel pad stack' },
    h('div', { class: 'form-grid' }, field(t('ivg.approver'), approver), field(t('ivg.hr_staff'), staff.el)),
    h('h2', {}, t('ivg.deadlines')),
    h('div', { class: 'form-grid' }, field(t('ivg.answer_days'), ans), field(t('ivg.minutes_days'), mins), field(t('ivg.decision_days'), dec)),
    h('h2', {}, t('ovr.absence')),
    field(t('ovr.absence_after'), after, t('ovr.absence_hint')),
    err,
    h('div', {}, h('button', { type: 'submit', class: 'btn btn-primary' }, t('common.save'))),
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    try {
      await api('/inv/settings', {
        method: 'PUT',
        body: { approver: approver.value ? Number(approver.value) : null, staff: staff.ids(), answer_days: Number(ans.value), minutes_days: Number(mins.value), decision_days: Number(dec.value), absence_after: Number(after.value) },
      });
      toast(t('capa.saved'));
    } catch (e) {
      err.textContent = errText(e);
      err.hidden = false;
    }
  });
  const penName = (p) => h('span', { class: p.active ? '' : 'muted' }, pick(p.name_ar, p.name_en), p.days ? h('span', { class: 'small muted' }, ' · ' + t('ivg.takes_days')) : '', p.active ? '' : ' (' + t('ovr.inactive') + ')');
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('nav.invset')))),
    form,
    h(
      'section',
      { class: 'panel pad stack' },
      h('div', { class: 'section-head' }, h('h2', {}, t('ivg.penalties')), h('button', { type: 'button', class: 'btn btn-small', onclick: () => penDialog(null) }, icon('plus'), t('ivg.pen_add'))),
      h('ul', { class: 'ack-list' }, pens.penalties.map((p) => h('li', {}, penName(p), h('button', { type: 'button', class: 'btn btn-small', 'aria-label': t('common.edit'), onclick: () => penDialog(p) }, icon('edit'))))),
    ),
  );
}

function penDialog(p) {
  const ar = input({ type: 'text', required: true, maxlength: 120, dir: 'rtl', value: p ? p.name_ar : '' });
  const en = input({ type: 'text', required: true, maxlength: 120, dir: 'ltr', value: p ? p.name_en : '' });
  const days = input({ type: 'checkbox', checked: !!(p && p.days) });
  const active = input({ type: 'checkbox', checked: !p || !!p.active });
  openDialog({
    title: p ? pick(p.name_ar, p.name_en) : t('ivg.pen_add'),
    body: h(
      'div',
      { class: 'stack' },
      h('div', { class: 'form-grid' }, field(t('field.name_ar'), ar), field(t('field.name_en'), en)),
      checkField(t('ivg.takes_days'), days),
      p ? checkField(t('ovr.active'), active) : '',
      p && !p.used ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-small', onclick: (ev) => (ev.target.closest('dialog').close(), simpleDelete(t('ivg.pen_delete_q'), '/inv/penalties/' + p.id, t('capa.deleted'))) }, icon('trash'), t('common.delete'))) : '',
    ),
    onSubmit: async () => {
      await api(p ? '/inv/penalties/' + p.id : '/inv/penalties', { method: p ? 'PUT' : 'POST', body: { name_ar: ar.value, name_en: en.value, days: days.checked, active: active.checked } });
      toast(t('capa.saved'));
      render();
    },
  });
}
