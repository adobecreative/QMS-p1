// Incident reports (OVR): the report form (in the app, or from a place's QR code), the register for quality,
// one report with what was sent to whom, and the categories. The reporter's name shows only to the quality manager.
import { render } from '../app.js';
import { kpiRow } from './assets.js';
import { S, h, icon, store, t } from './core.js';
import { link, setUrl } from './layout.js';
import { api, checkField, dateEl, errText, errorBox, field, input, openDialog, select, toast } from './offline.js';
import { fmtTime, pick, publicShell, shrinkPhoto, simpleDelete } from './tickets.js';

export const OVR_HARMS = ['near_miss', 'no_harm', 'minor', 'moderate', 'major', 'sentinel'];
export const OVR_STATUS = ['new', 'review', 'reply', 'action', 'closed'];
const ST_CHIP = { new: 'chip-expired', review: 'chip-near', reply: 'chip-review', action: 'chip-review', closed: 'chip-valid' };
const HARM_CHIP = { near_miss: 'chip-valid', no_harm: 'chip-valid', minor: 'chip-near', moderate: 'chip-near', major: 'chip-expired', sentinel: 'chip-expired' };
export const ovrChip = (s) => h('span', { class: 'chip ' + ST_CHIP[s] }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('ovr.st.' + s));
export const harmChip = (x) => h('span', { class: 'chip ' + HARM_CHIP[x] }, t('ovr.harm.' + x));
const harmOf = (o) => o.harm_final || o.harm;
const typeOf = (o) => [pick(o.cat_ar, o.cat_en), pick(o.sub_ar, o.sub_en)].filter(Boolean).join(' / ');
const placeOf = (o) => pick(o.loc_ar, o.loc_en) || o.place_text || '';
const here = (path) => {
  S.route = path;
  setUrl(path);
};
// The date and time now, as a local date-time field wants it.
const nowLocal = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

/* --------------------------------- the form -------------------------------- */

// The same form in the app (signed in: the account is the reporter) and on the public page (employee number).
function ovrForm(meta, code, done) {
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const loc = meta.location;
  const empNo = input({ type: 'text', maxlength: 30, dir: 'ltr', inputmode: 'numeric', autocomplete: 'off', value: store.get('fm_ovr_emp', '') });
  const repName = input({ type: 'text', maxlength: 100, autocomplete: 'name' });
  const when = input({ type: 'datetime-local', required: true, value: nowLocal(), max: nowLocal() });
  const dept = select([['', t('req.pick')], ...meta.departments.map((d) => [d.id, pick(d.name_ar, d.name_en)])], (loc && loc.department_id) || (S.user && S.user.department_id) || '', { required: true });
  const place = loc ? null : select([['', t('ovr.no_place')], ...meta.places.map((p) => [p.id, pick(p.name_ar, p.name_en)])], '');
  const where = input({ type: 'text', maxlength: 200 });
  const tops = meta.categories.filter((c) => !c.parent_id);
  const subsOf = (id) => meta.categories.filter((c) => c.parent_id === id);
  const cat = select([['', t('req.pick')], ...tops.map((c) => [c.id, pick(c.name_ar, c.name_en)])], '', { required: true });
  const sub = select([['', t('req.pick')]], '', { required: true });
  const subField = field(t('ovr.sub'), sub);
  subField.hidden = true;
  const sentinelNote = h('p', { class: 'notice notice-warn', hidden: true }, t('ovr.sentinel_note'));
  cat.addEventListener('change', () => {
    const list = subsOf(Number(cat.value));
    sub.replaceChildren(...[['', t('req.pick')], ...list.map((s) => [s.id, pick(s.name_ar, s.name_en)])].map(([v, x]) => h('option', { value: v }, x)));
    subField.hidden = !list.length;
    sub.required = list.length > 0;
    sentinelNote.hidden = true;
  });
  // Harm as large buttons, mildest first.
  const harmBox = h(
    'fieldset',
    { class: 'cat-pick' },
    h('legend', {}, t('ovr.harm')),
    h(
      'div',
      { class: 'cat-options' },
      OVR_HARMS.map((x) => {
        const r = input({ type: 'radio', name: 'harm', value: x, required: true, id: 'harm-' + x });
        return h('label', { class: 'cat-option', for: 'harm-' + x }, r, h('span', {}, t('ovr.harm.' + x)));
      }),
    ),
  );
  sub.addEventListener('change', () => {
    const s = meta.categories.find((c) => String(c.id) === sub.value);
    sentinelNote.hidden = !(s && s.sentinel);
    if (s && s.sentinel) harmBox.querySelector('input[value=sentinel]').checked = true;
  });
  // The patient: only when the incident is about one.
  const isPatient = input({ type: 'checkbox' });
  const mrn = input({ type: 'text', maxlength: 40, dir: 'ltr', autocomplete: 'off' });
  const pname = input({ type: 'text', maxlength: 120, autocomplete: 'off' });
  const age = input({ type: 'text', maxlength: 10, inputmode: 'numeric', autocomplete: 'off' });
  const sex = select([['', '-'], ['m', t('ovr.male')], ['f', t('ovr.female')]], '');
  const patientBox = h('div', { class: 'form-grid', hidden: true }, field(t('ovr.mrn'), mrn), field(t('ovr.patient_name'), pname), field(t('ovr.age'), age), field(t('ovr.sex'), sex));
  isPatient.addEventListener('change', () => {
    patientBox.hidden = !isPatient.checked;
    mrn.required = pname.required = isPatient.checked;
  });
  const desc = h('textarea', { required: true, minlength: 5, maxlength: 3000, rows: 4, dir: 'auto' });
  const immediate = h('textarea', { maxlength: 1000, rows: 2, dir: 'auto' });
  const involved = input({ type: 'text', maxlength: 500, dir: 'auto' });
  const photo = input({ type: 'file', accept: 'image/*' });
  const trap = input({ type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', class: 'visually-hidden', 'aria-hidden': 'true' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, t('ovr.send'));
  const signedIn = meta.signed_in;
  const form = h(
    'form',
    { class: 'stack' },
    loc ? h('p', { class: 'notice' }, t('req.at', { place: pick(loc.name_ar, loc.name_en) })) : null,
    meta.bad_location ? h('p', { class: 'form-error' }, t('req.bad_qr')) : null,
    signedIn ? null : h('div', { class: 'form-grid' }, field(t('staff.emp_no'), empNo), meta.staff_check ? null : field(t('req.name'), repName)),
    h('div', { class: 'form-grid' }, field(t('ovr.when'), when), field(t('ovr.dept'), dept)),
    place ? h('div', { class: 'form-grid' }, field(t('ovr.place'), place), field(t('ovr.where_more'), where)) : field(t('ovr.where_more'), where),
    h('div', { class: 'form-grid' }, field(t('ovr.category'), cat), subField),
    sentinelNote,
    harmBox,
    checkField(t('ovr.is_patient'), isPatient),
    patientBox,
    field(t('ovr.desc'), desc),
    field(t('ovr.immediate'), immediate),
    field(t('ovr.involved'), involved),
    field(t('req.photo'), photo),
    h('p', { class: 'hint' }, t('ovr.private')),
    trap,
    err,
    submit,
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    const harm = form.querySelector('input[name=harm]:checked');
    if (!signedIn && !empNo.value.trim()) {
      err.textContent = t('err.ovr_emp_required');
      err.hidden = false;
      empNo.focus();
      return;
    }
    if (!harm) {
      err.textContent = t('err.ovr_bad_harm');
      err.hidden = false;
      return;
    }
    submit.disabled = true;
    try {
      const fd = new FormData();
      const fields = {
        emp_no: empNo.value, reporter_name: repName.value, occurred_at: when.value, department_id: dept.value, loc: code || '', location_id: place ? place.value : '', place_text: where.value,
        category_id: cat.value, sub_id: sub.value, harm: harm.value, patient: isPatient.checked ? '1' : '0', patient_mrn: mrn.value, patient_name: pname.value, patient_age: age.value, patient_sex: sex.value,
        description: desc.value, immediate_action: immediate.value, involved: involved.value, website: trap.value,
      };
      for (const [k, v] of Object.entries(fields)) fd.set(k, v);
      const f = photo.files && photo.files[0];
      if (f) fd.set('photo', await shrinkPhoto(f));
      const r = await api('/public/ovr', { method: 'POST', form: fd });
      if (!signedIn) store.set('fm_ovr_emp', empNo.value.trim());
      done(r);
    } catch (e) {
      err.textContent = errText(e);
      err.hidden = false;
      submit.disabled = false;
    }
  });
  return form;
}

// ovr/ovrnew: the form inside the app.
export async function ovrNewPage(root, _param, alive) {
  let meta;
  try {
    meta = await api('/public/ovr/form');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const box = h('section', { class: 'panel pad' });
  const sent = (r) => {
    box.replaceChildren(
      h('div', { class: 'stack' }, h('p', { class: 'notice' }, t('ovr.sent', { n: r.id })), link('ovr/ovrs/' + r.id, { class: 'btn btn-primary btn-block' }, t('ovr.open')), h('button', { type: 'button', class: 'btn btn-block', onclick: () => render() }, t('ovr.another'))),
    );
    window.scrollTo(0, 0);
  };
  box.append(ovrForm(meta, '', sent));
  root.replaceChildren(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('nav.ovrnew')))), box);
}

// /incident?loc=<code>: the form from a place's QR code, signed in or not.
export async function incidentPage() {
  const code = new URLSearchParams(location.search).get('loc') || '';
  let meta;
  try {
    meta = await api('/public/ovr/form' + (code ? '?loc=' + encodeURIComponent(code) : ''));
  } catch (e) {
    return publicShell(h('h1', {}, t('ovr.title')), errorBox(e));
  }
  const box = h('div', {});
  const sent = (r) => {
    const track = 'ovr-track/' + r.id + '/' + r.track;
    box.replaceChildren(h('div', { class: 'stack' }, h('p', { class: 'notice' }, t('ovr.sent', { n: r.id })), link(track, { class: 'btn btn-primary btn-block' }, t('ovr.follow')), h('a', { class: 'btn btn-block', href: location.pathname + location.search }, t('ovr.another'))));
    window.scrollTo(0, 0);
  };
  box.append(ovrForm(meta, code, sent));
  return publicShell(h('h1', {}, t('ovr.title')), box);
}

// #/ovr-track/<id>/<token>: where a report sent from a QR code stands.
export async function ovrTrackPage(id, token) {
  let d;
  try {
    d = await api('/public/ovr/' + id + '?k=' + token);
  } catch (e) {
    return publicShell(h('h1', {}, t('ovr.track', { n: id })), errorBox(e));
  }
  const o = d.ovr;
  return publicShell(
    h('h1', {}, t('ovr.track', { n: id })),
    h('dl', { class: 'kv-list' },
      h('div', { class: 'kv' }, h('dt', {}, t('ovr.category')), h('dd', {}, typeOf(o) || '-')),
      h('div', { class: 'kv' }, h('dt', {}, t('ovr.status')), h('dd', {}, ovrChip(o.status))),
      h('div', { class: 'kv' }, h('dt', {}, t('ovr.sent_at')), h('dd', {}, fmtTime(o.created_at))),
      o.closed_at ? h('div', { class: 'kv' }, h('dt', {}, t('ovr.closed_at')), h('dd', {}, fmtTime(o.closed_at))) : null,
    ),
  );
}

/* -------------------------------- the register ------------------------------ */

// ovr/ovrs, or ovr/ovrs/12 for one report.
export async function ovrListPage(root, param, alive) {
  if (param) return ovrDetail(root, param, alive);
  let d;
  try {
    d = await api('/ovr');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const quality = d.role.viewer;
  const f = (S.ovrF = S.ovrF || { q: '', status: 'open', harm: '', view: 'all' });
  const search = input({ type: 'search', class: 'doc-search-input', value: f.q, placeholder: t('ovr.search_ph'), 'aria-label': t('ovr.search_ph'), autocomplete: 'off' });
  const pickSt = select([['open', t('ovr.open_only')], ['', t('capa.all')], ...OVR_STATUS.map((s) => [s, t('ovr.st.' + s)])], f.status, { 'aria-label': t('ovr.status') });
  const pickHarm = select([['', t('ovr.all_harms')], ...OVR_HARMS.map((x) => [x, t('ovr.harm.' + x)])], f.harm, { 'aria-label': t('ovr.harm') });
  const box = h('div', {});
  const norm = (v) => String(v || '').toLowerCase();
  // Everyone else: what was sent to me, and my own reports.
  const tabs = quality
    ? null
    : h('div', { class: 'tabs', role: 'tablist' }, ['all', 'tasks', 'mine'].map((v) => h('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': String(f.view === v), onclick: () => ((f.view = v), draw()) }, t('ovr.view.' + v))));
  const draw = () => {
    if (tabs) tabs.querySelectorAll('.tab').forEach((b, i) => b.setAttribute('aria-selected', String(['all', 'tasks', 'mine'][i] === f.view)));
    const q = norm(f.q.trim());
    const rows = d.ovr.filter(
      (o) =>
        (f.status === 'open' ? o.status !== 'closed' : !f.status || o.status === f.status) &&
        (!f.harm || harmOf(o) === f.harm) &&
        (quality || f.view === 'all' || (f.view === 'tasks' ? !!o.my_task : o.mine)) &&
        (!q || ['#' + o.id, o.cat_ar, o.cat_en, o.sub_ar, o.sub_en, o.dept_ar, o.dept_en, o.loc_ar, o.loc_en, o.place_text, o.description].some((v) => norm(v).includes(q))),
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
                h('thead', {}, h('tr', {}, ['ovr.no', 'ovr.category', 'ovr.dept', 'ovr.harm', 'ovr.due', 'ovr.status'].map((c) => h('th', { scope: 'col' }, t(c))))),
                h(
                  'tbody',
                  {},
                  rows.map((o) =>
                    h(
                      'tr',
                      {},
                      h('td', {}, link('ovr/ovrs/' + o.id, { class: 'mono strong', dir: 'ltr' }, '#' + o.id), h('div', { class: 'small muted' }, fmtTime(o.created_at))),
                      h('td', { class: 'wrap-cell' }, typeOf(o) || '-', o.my_task ? h('div', { class: 'small' }, h('span', { class: 'note ' + (o.my_task.late ? 'note-expired' : 'note-near') }, t('ovr.task.' + o.my_task.kind))) : '', o.reporter ? h('div', { class: 'small muted' }, o.reporter.name + (o.reporter.emp_no ? ' · ' + o.reporter.emp_no : '')) : ''),
                      h('td', {}, pick(o.dept_ar, o.dept_en) || '-', placeOf(o) ? h('div', { class: 'small muted' }, placeOf(o)) : ''),
                      h('td', {}, harmChip(harmOf(o))),
                      h('td', {}, dateEl(o.due), o.late ? h('span', { class: 'note note-expired' }, ' ', t('rnd.late')) : ''),
                      h('td', {}, ovrChip(o.status)),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty' }, d.ovr.length ? t('capa.no_match') : t('ovr.empty')),
      ),
    );
  };
  search.addEventListener('input', () => ((f.q = search.value), draw()));
  pickSt.addEventListener('change', () => ((f.status = pickSt.value), draw()));
  pickHarm.addEventListener('change', () => ((f.harm = pickHarm.value), draw()));
  const open = d.ovr.filter((o) => o.status !== 'closed');
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('nav.ovrs')), h('p', { class: 'muted' }, t('ovr.n', { n: d.ovr.length, open: open.length })))),
    quality
      ? kpiRow([
          ['ovr.k_new', d.ovr.filter((o) => o.status === 'new').length],
          ['ovr.k_open', open.length],
          ['ovr.k_late', open.filter((o) => o.late).length],
          ['ovr.k_severe', open.filter((o) => harmOf(o) === 'major' || harmOf(o) === 'sentinel').length],
        ])
      : tabs,
    h('div', { class: 'filters' }, h('div', { class: 'doc-search', role: 'search' }, icon('search'), search), pickSt, pickHarm),
    box,
  );
  draw();
}

const kv = (label, value) => (value === '' || value === null || value === undefined ? null : h('div', { class: 'kv' }, h('dt', {}, label), h('dd', {}, value)));
const para = (v) => h('span', { class: 'pre-wrap', dir: 'auto' }, v);

async function ovrDetail(root, id, alive) {
  let d;
  try {
    d = await api('/ovr/' + id);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const o = d.ovr;
  const r = d.role;
  const closed = o.status === 'closed';
  const reload = () => render();
  const act = async (path, body, msg) => {
    await api('/ovr/' + o.id + path, { method: 'POST', body });
    toast(t(msg));
    reload();
  };
  const actions = [];
  if (r.officer && !closed) {
    actions.push(
      h('button', { type: 'button', class: 'btn', onclick: () => classifyDialog(o, reload) }, icon('edit'), t(o.status === 'new' ? 'ovr.receive' : 'ovr.classify')),
      h('button', { type: 'button', class: 'btn', onclick: () => routeDialog(o, 'reply', reload) }, t('ovr.route_reply')),
      h('button', { type: 'button', class: 'btn', onclick: () => routeDialog(o, 'action', reload) }, t('ovr.route_action')),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => noteAction(t('ovr.close'), t('ovr.close_note'), (note) => act('/close', { note }, 'ovr.closed_ok')) }, icon('check'), t('ovr.close')),
    );
  }
  if (r.manager && closed) actions.push(h('button', { type: 'button', class: 'btn', onclick: () => noteAction(t('ovr.reopen'), t('ovr.reopen_note'), (note) => act('/reopen', { note }, 'ovr.reopened')) }, t('ovr.reopen')));
  if (r.manager) actions.push(h('button', { type: 'button', class: 'btn', onclick: () => simpleDelete(t('ovr.delete_q'), '/ovr/' + o.id, t('capa.deleted'), () => (here('ovr/ovrs'), render())) }, icon('trash')));

  const facts = h(
    'dl',
    { class: 'kv-list ovr-facts' },
    kv(t('ovr.category'), typeOf(o)),
    kv(t('ovr.harm'), h('span', {}, harmChip(harmOf(o)), o.harm_final && o.harm_final !== o.harm ? h('span', { class: 'small muted' }, ' ', t('ovr.reported_as'), ' ', t('ovr.harm.' + o.harm)) : '')),
    kv(t('ovr.when'), h('span', { dir: 'ltr', class: 'mono' }, o.occurred_at.replace('T', ' '))),
    kv(t('ovr.dept'), pick(o.dept_ar, o.dept_en)),
    kv(t('ovr.place'), placeOf(o)),
    o.chapter ? kv(t('qa.chapter'), h('span', { class: 'mono', dir: 'ltr' }, o.chapter)) : null,
    kv(t('ovr.due'), h('span', {}, dateEl(o.due), o.late ? h('span', { class: 'note note-expired' }, ' ', t('rnd.late')) : '')),
    o.reporter ? kv(t('ovr.reporter'), o.reporter.name + (o.reporter.emp_no ? ' · ' + o.reporter.emp_no : '')) : null,
    o.patient && o.patient_mrn !== undefined ? kv(t('ovr.patient'), [o.patient_name, o.patient_mrn, o.patient_age, o.patient_sex ? t(o.patient_sex === 'm' ? 'ovr.male' : 'ovr.female') : ''].filter(Boolean).join(' · ')) : null,
    kv(t('ovr.desc'), para(o.description)),
    kv(t('ovr.immediate'), o.immediate_action ? para(o.immediate_action) : ''),
    kv(t('ovr.involved'), o.involved),
    o.has_photo ? kv(t('req.photo'), h('a', { href: '/api/ovr/' + o.id + '/photo', target: '_blank', rel: 'noopener' }, t('ovr.photo_open'))) : null,
    closed ? kv(t('ovr.close_note'), h('span', {}, para(o.close_note || ''), h('div', { class: 'small muted' }, (o.closed_by || '') + ' · ' + fmtTime(o.closed_at)))) : null,
  );

  // What was sent to whom; the person it was sent to answers here.
  const taskEl = (tk) => {
    const mineOpen = tk.status === 'open' && tk.user_id === S.user.id && !closed;
    return h(
      'li',
      {},
      h('div', { class: 'step-head' }, h('b', {}, t('ovr.task.' + tk.kind)), ' · ', pick(tk.user_name, tk.user_name_en), ' · ', h('span', { class: 'small muted' }, t('ovr.due'), ' ', dateEl(tk.due)), tk.late ? h('span', { class: 'note note-expired' }, ' ', t('rnd.late')) : '', tk.status === 'done' ? h('span', { class: 'note note-valid' }, ' ', t('ovr.task_done')) : ''),
      tk.note ? h('div', { class: 'small' }, h('span', { class: 'muted' }, (tk.routed_by || '') + ': '), para(tk.note)) : '',
      tk.reply ? h('div', {}, h('span', { class: 'muted' }, t('ovr.reply') + ': '), para(tk.reply)) : '',
      tk.correction ? h('div', {}, h('span', { class: 'muted' }, t('ovr.correction') + ': '), para(tk.correction)) : '',
      tk.improvement ? h('div', {}, h('span', { class: 'muted' }, t('ovr.improvement') + ': '), para(tk.improvement)) : '',
      mineOpen ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary btn-small', onclick: () => answerDialog(o, tk, reload) }, t(tk.kind === 'action' ? 'ovr.do_action' : 'ovr.do_reply'))) : '',
      r.officer && tk.status === 'open' && !closed ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-small', onclick: () => simpleDelete(t('ovr.withdraw_q'), '/ovr/' + o.id + '/tasks/' + tk.id, t('ovr.withdrawn'), reload) }, t('ovr.withdraw'))) : '',
    );
  };
  const steps = (d.ovr.steps || []).map((s) => h('li', {}, h('div', { class: 'step-head' }, h('b', {}, t('ovr.step.' + s.kind)), s.by_name ? ' · ' + s.by_name : '', ' · ', h('span', { class: 'small muted' }, fmtTime(s.at))), s.text ? para(s.text) : ''));
  root.replaceChildren(
    h('p', {}, link('ovr/ovrs', {}, '← ' + t('nav.ovrs'))),
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('ovr.track', { n: o.id }), ' ', ovrChip(o.status)), h('p', { class: 'muted' }, fmtTime(o.created_at))), actions.length ? h('div', { class: 'actions' }, actions) : ''),
    h('section', { class: 'panel pad' }, facts),
    o.tasks.length ? h('section', { class: 'panel pad stack' }, h('h2', {}, t('ovr.tasks')), h('ul', { class: 'steps' }, o.tasks.map(taskEl))) : '',
    steps.length ? h('section', { class: 'panel pad stack' }, h('h2', {}, t('ovr.history')), h('ul', { class: 'steps' }, steps)) : '',
  );
}

function noteAction(title, label, send) {
  const note = h('textarea', { rows: 3, maxlength: 2000, required: true, dir: 'auto' });
  openDialog({ title, body: field(label, note), onSubmit: () => send(note.value) });
}

async function classifyDialog(o, done) {
  const [meta, cats] = await Promise.all([api('/public/ovr/form'), api('/ovr/cats')]);
  const tops = cats.categories.filter((c) => !c.parent_id && (c.active || c.id === o.category_id));
  const subsOf = (id) => cats.categories.filter((c) => c.parent_id === id && (c.active || c.id === o.sub_id));
  const cat = select(tops.map((c) => [c.id, pick(c.name_ar, c.name_en)]), o.category_id);
  const sub = select([], '');
  const fill = () => {
    const list = subsOf(Number(cat.value));
    sub.replaceChildren(...list.map((s) => h('option', { value: s.id, selected: s.id === o.sub_id }, pick(s.name_ar, s.name_en))));
    sub.disabled = !list.length;
  };
  cat.addEventListener('change', fill);
  fill();
  const harm = select(OVR_HARMS.map((x) => [x, t('ovr.harm.' + x)]), harmOf(o));
  const dept = select(meta.departments.map((x) => [x.id, pick(x.name_ar, x.name_en)]), o.department_id);
  openDialog({
    title: t(o.status === 'new' ? 'ovr.receive' : 'ovr.classify') + ' #' + o.id,
    body: h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, field(t('ovr.category'), cat), field(t('ovr.sub'), sub)), h('div', { class: 'form-grid' }, field(t('ovr.harm'), harm), field(t('ovr.dept'), dept))),
    onSubmit: async () => {
      await api('/ovr/' + o.id, { method: 'PUT', body: { category_id: Number(cat.value), sub_id: sub.value ? Number(sub.value) : null, harm_final: harm.value, department_id: Number(dept.value) } });
      toast(t('capa.saved'));
      done();
    },
  });
}

async function routeDialog(o, kind, done) {
  const { people } = await api('/ovr/people');
  const who = select([['', t('req.pick')], ...people.map((p) => [p.id, pick(p.name, p.name_en) + (p.dept_ar ? ' - ' + pick(p.dept_ar, p.dept_en) : '')])], '', { required: true });
  const note = h('textarea', { rows: 3, maxlength: 1000, dir: 'auto' });
  const due = input({ type: 'date', min: S.today });
  openDialog({
    title: t(kind === 'action' ? 'ovr.route_action' : 'ovr.route_reply') + ' #' + o.id,
    body: h('div', { class: 'stack' }, field(t('ovr.to'), who), field(t('ovr.note'), note), field(t('ovr.due'), due, t('ovr.due_hint'))),
    onSubmit: async () => {
      await api('/ovr/' + o.id + '/route', { method: 'POST', body: { user_id: Number(who.value), kind, note: note.value, due: due.value } });
      toast(t('ovr.routed'));
      done();
    },
  });
}

function answerDialog(o, tk, done) {
  const area = (n) => h('textarea', { rows: 3, maxlength: n, required: true, dir: 'auto' });
  const reply = area(3000);
  const correction = area(2000);
  const improvement = area(2000);
  openDialog({
    title: t(tk.kind === 'action' ? 'ovr.do_action' : 'ovr.do_reply') + ' #' + o.id,
    body: tk.kind === 'action' ? h('div', { class: 'stack' }, field(t('ovr.correction'), correction), field(t('ovr.improvement'), improvement)) : field(t('ovr.reply'), reply),
    onSubmit: async () => {
      await api('/ovr/' + o.id + '/tasks/' + tk.id, { method: 'POST', body: tk.kind === 'action' ? { correction: correction.value, improvement: improvement.value } : { reply: reply.value } });
      toast(t('ovr.answered'));
      done();
    },
  });
}

/* -------------------------------- categories -------------------------------- */

// ovr/ovrcats: categories and their sub-categories (quality manager).
export async function ovrCatsPage(root, _param, alive) {
  let d;
  try {
    d = await api('/ovr/cats');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const tops = d.categories.filter((c) => !c.parent_id);
  const subs = (id) => d.categories.filter((c) => c.parent_id === id);
  const name = (c) => h('span', { class: c.active ? '' : 'muted' }, pick(c.name_ar, c.name_en), c.active ? '' : ' (' + t('ovr.inactive') + ')', c.sentinel ? h('span', { class: 'note note-expired' }, ' ', t('ovr.harm.sentinel')) : '');
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('nav.ovrcats'))), d.can_edit ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => catDialog(null, null) }, icon('plus'), t('ovr.cat_add'))) : ''),
    ...tops.map((c) =>
      h(
        'section',
        { class: 'panel pad' },
        h('div', { class: 'page-head' }, h('h2', {}, name(c), c.chapter ? h('span', { class: 'small muted mono', dir: 'ltr' }, ' ' + c.chapter) : ''), d.can_edit ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-small', onclick: () => catDialog(c, null) }, icon('edit')), h('button', { type: 'button', class: 'btn btn-small', onclick: () => catDialog(null, c) }, icon('plus'), t('ovr.sub_add'))) : ''),
        subs(c.id).length
          ? h('ul', { class: 'ack-list' }, subs(c.id).map((s) => h('li', {}, name(s), d.can_edit ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => catDialog(s, c) }, icon('edit')) : '')))
          : h('p', { class: 'muted small' }, t('ovr.no_subs')),
      ),
    ),
  );
}

function catDialog(c, parent) {
  const ar = input({ type: 'text', required: true, maxlength: 120, dir: 'rtl', value: c ? c.name_ar : '' });
  const en = input({ type: 'text', required: true, maxlength: 120, dir: 'ltr', value: c ? c.name_en : '' });
  const chapter = input({ type: 'text', maxlength: 10, dir: 'ltr', value: c ? c.chapter || '' : '' });
  const sentinel = input({ type: 'checkbox', checked: !!(c && c.sentinel) });
  const active = input({ type: 'checkbox', checked: !c || !!c.active });
  const isSub = !!parent;
  openDialog({
    title: c ? pick(c.name_ar, c.name_en) : t(isSub ? 'ovr.sub_add' : 'ovr.cat_add') + (parent ? ' - ' + pick(parent.name_ar, parent.name_en) : ''),
    body: h(
      'div',
      { class: 'stack' },
      h('div', { class: 'form-grid' }, field(t('field.name_ar'), ar), field(t('field.name_en'), en)),
      isSub ? checkField(t('ovr.sentinel_flag'), sentinel) : field(t('qa.chapter'), chapter),
      c ? checkField(t('ovr.active'), active) : '',
      c && !c.used ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-small', onclick: (ev) => (ev.target.closest('dialog').close(), simpleDelete(t('ovr.cat_delete_q'), '/ovr/cats/' + c.id, t('capa.deleted'))) }, icon('trash'), t('common.delete'))) : '',
    ),
    onSubmit: async () => {
      const body = { name_ar: ar.value, name_en: en.value, chapter: chapter.value, sentinel: sentinel.checked, active: active.checked };
      if (!c) body.parent_id = parent ? parent.id : null;
      await api(c ? '/ovr/cats/' + c.id : '/ovr/cats', { method: c ? 'PUT' : 'POST', body });
      toast(t('capa.saved'));
      render();
    },
  });
}

