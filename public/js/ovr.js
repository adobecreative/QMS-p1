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
  S.ovrRole = r;
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
      tk.capa_id ? h('div', { class: 'small' }, link('quality/capa/' + tk.capa_id, {}, 'CAPA #' + tk.capa_id)) : '',
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
    o.rca ? rcaPanel(o, o.rca, reload) : '',
    o.capa && (o.capa.length || (o.capa_needed && !closed))
      ? h(
          'section',
          { class: 'panel pad stack' },
          h('h2', {}, t('nav.capa')),
          o.capa.length
            ? h('ul', { class: 'ack-list' }, o.capa.map((c) => h('li', {}, link('quality/capa/' + c.id, {}, h('span', { dir: 'ltr', class: 'mono' }, '#' + c.id), ' ', c.title), h('span', { class: 'small muted' }, c.owner || '', ' · ', t('capa.st.' + c.status)))))
            : h('p', { class: 'notice notice-warn' }, t('ovr.capa_needed')),
        )
      : '',
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
  // Root cause analysis: always for major harm and sentinel events; the quality manager can ask for one on any report.
  const severe = () => harm.value === 'major' || harm.value === 'sentinel';
  const rca = input({ type: 'checkbox', checked: !!o.rca });
  const syncRca = () => {
    if (severe()) rca.checked = true;
    rca.disabled = severe() || !S.ovrRole?.manager || !!(o.rca && o.rca.approved_at);
  };
  harm.addEventListener('change', syncRca);
  syncRca();
  openDialog({
    title: t(o.status === 'new' ? 'ovr.receive' : 'ovr.classify') + ' #' + o.id,
    body: h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, field(t('ovr.category'), cat), field(t('ovr.sub'), sub)), h('div', { class: 'form-grid' }, field(t('ovr.harm'), harm), field(t('ovr.dept'), dept)), checkField(t('rca.title'), rca)),
    onSubmit: async () => {
      const body = { category_id: Number(cat.value), sub_id: sub.value ? Number(sub.value) : null, harm_final: harm.value, department_id: Number(dept.value) };
      if (S.ovrRole?.manager) body.rca = rca.checked;
      await api('/ovr/' + o.id, { method: 'PUT', body });
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


/* --------------------------- root cause analysis --------------------------- */

const FISH = ['people', 'methods', 'equipment', 'environment', 'materials', 'communication'];
const RCA_STEPS = ['team', 'analysis', 'plan'];
const SVG_NS = 'http://www.w3.org/2000/svg';
// An SVG element; text is set as text, never as markup.
const sv = (tag, attrs, text) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) el.setAttribute(k, v);
  if (text !== undefined) el.textContent = text;
  return el;
};
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// The fishbone: the problem at the head, six branches, each with its causes; root causes stand out.
// Clicking a branch's name takes you to its box below.
function fishbone(st, onBranch) {
  const W = 760;
  const rtl = document.documentElement.dir === 'rtl';
  const X = (x) => (rtl ? W - x : x);
  // Anchors are physical (the drawing sets direction ltr); causes sit on the side the bone leans away from.
  const away = rtl ? 'end' : 'start';
  const svg = sv('svg', { viewBox: `0 0 ${W} 330`, class: 'fish', role: 'img', 'aria-label': t('rca.fish'), direction: 'ltr' });
  svg.append(sv('line', { x1: X(20), y1: 165, x2: X(600), y2: 165, class: 'fish-spine' }));
  svg.append(sv('rect', { x: rtl ? W - 750 : 600, y: 120, width: 150, height: 90, rx: 10, class: 'fish-head' }));
  const prob = cut(st.problem || t('rca.problem'), 60);
  const lines = [prob.slice(0, 22), prob.slice(22, 44), prob.slice(44)].filter(Boolean);
  lines.forEach((l, i) => svg.append(sv('text', { x: X(675), y: 165 - (lines.length - 1) * 9 + i * 18, 'text-anchor': 'middle', class: 'fish-head-text' }, l)));
  FISH.forEach((k, i) => {
    const top = i < 3;
    const bx = 190 + (i % 3) * 170;
    const tip = bx - 95;
    const ty = top ? 45 : 285;
    svg.append(sv('line', { x1: X(bx), y1: 165, x2: X(tip), y2: ty, class: 'fish-bone' }));
    const label = sv('text', { x: X(tip), y: top ? 30 : 310, 'text-anchor': 'middle', class: 'fish-label', tabindex: '0', role: 'button' }, t('rca.b.' + k));
    label.addEventListener('click', () => onBranch(k));
    label.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onBranch(k)));
    svg.append(label);
    const causes = (st.bones[k] || []).slice(0, 4);
    causes.forEach((c, j) => {
      const y = top ? 70 + j * 22 : 260 - j * 22;
      const x = bx - ((165 - y) / (165 - ty)) * 95;
      svg.append(sv('text', { x: X(x + 8), y: y + 4, 'text-anchor': away, class: 'fish-cause' + (c.root ? ' is-root' : '') }, cut(c.t, 20)));
    });
    const more = (st.bones[k] || []).length - causes.length;
    if (more > 0) svg.append(sv('text', { x: X(bx + 8), y: top ? 155 : 185, 'text-anchor': away, class: 'fish-cause' }, '+' + more));
  });
  return svg;
}

// The analysis on the report's page: seven steps, saved together; the quality manager approves the plan.
function rcaPanel(o, rca, reload) {
  const edit = rca.can_edit;
  const st = {
    team: [...rca.team],
    problem: rca.problem || typeOf(o),
    timeline: rca.timeline.map((x) => ({ ...x })),
    whys: [...rca.whys],
    bones: Object.fromEntries(FISH.map((k) => [k, (rca.bones[k] || []).map((x) => ({ ...x }))])),
    roots: [...rca.roots],
    plan: rca.plan.map((x) => ({ ...x })),
    measure: rca.measure || '',
  };
  const names = Object.fromEntries(rca.team_people.map((p) => [p.id, pick(p.name, p.name_en)]));
  let people = rca.team_people;
  const peopleReady = edit ? api('/ovr/people').then((r) => (people = r.people)).catch(() => null) : Promise.resolve();
  const nameOf = (id) => names[id] || (people.find((p) => p.id === id) && pick(people.find((p) => p.id === id).name, people.find((p) => p.id === id).name_en)) || '#' + id;
  const del = (onclick) => (edit ? h('button', { type: 'button', class: 'btn btn-small', 'aria-label': t('common.delete'), onclick }, '×') : '');
  const step = (n, title, ...kids) => h('div', { class: 'rca-step stack' }, h('h3', {}, h('span', { class: 'rca-n' }, String(n)), ' ', title), ...kids);

  // 1. Team
  const teamBox = h('div', { class: 'chips' });
  const teamPick = select([['', t('req.pick')]], '');
  const drawTeam = () => {
    teamBox.replaceChildren(...(st.team.length ? st.team.map((id) => h('span', { class: 'tag rca-chip' }, nameOf(id), del(() => ((st.team = st.team.filter((x) => x !== id)), drawTeam())))) : [h('span', { class: 'muted small' }, t('rca.team_none'))]));
    teamPick.replaceChildren(...[['', t('rca.team_add')], ...people.filter((p) => !st.team.includes(p.id)).map((p) => [p.id, pick(p.name, p.name_en) + (p.dept_ar ? ' - ' + pick(p.dept_ar, p.dept_en) : '')])].map(([v, x]) => h('option', { value: v }, x)));
  };
  teamPick.addEventListener('change', () => {
    if (teamPick.value) st.team.push(Number(teamPick.value));
    drawTeam();
  });
  peopleReady.then(drawTeam);
  drawTeam();

  // 2. Timeline
  const tlBox = h('div', { class: 'stack' });
  const drawTl = () =>
    tlBox.replaceChildren(
      ...st.timeline.map((x, i) =>
        edit
          ? h('div', { class: 'rca-row' }, input({ type: 'datetime-local', value: x.at, oninput: (e) => (x.at = e.target.value), 'aria-label': t('rca.when') }), input({ type: 'text', maxlength: 500, dir: 'auto', value: x.text, oninput: (e) => (x.text = e.target.value), 'aria-label': t('rca.event') }), del(() => (st.timeline.splice(i, 1), drawTl())))
          : h('div', { class: 'rca-row' }, h('span', { class: 'mono small', dir: 'ltr' }, (x.at || '').replace('T', ' ')), para(x.text)),
      ),
      edit ? h('div', {}, h('button', { type: 'button', class: 'btn btn-small', onclick: () => (st.timeline.push({ at: '', text: '' }), drawTl(), tlBox.querySelector('.rca-row:last-of-type input[type=text]')?.focus()) }, icon('plus'), t('rca.event_add'))) : '',
    );
  drawTl();

  // 3. Five whys: each answer opens the next question.
  const problem = input({ type: 'text', maxlength: 1000, dir: 'auto', value: st.problem, disabled: !edit });
  const whyInputs = [0, 1, 2, 3, 4].map((i) => input({ type: 'text', maxlength: 500, dir: 'auto', value: st.whys[i] || '', disabled: !edit }));
  const whyRows = whyInputs.map((inp, i) => h('div', { class: 'rca-why' }, h('label', { for: (inp.id = 'why' + i) }, t('rca.why_n', { n: i + 1 })), inp));
  const showWhys = () => whyRows.forEach((row, i) => (row.hidden = i > 0 && !whyInputs[i - 1].value.trim() && !whyInputs[i].value.trim()));
  whyInputs.forEach((inp, i) =>
    inp.addEventListener('input', () => {
      st.whys[i] = inp.value;
      showWhys();
    }),
  );
  showWhys();

  // 4. Fishbone
  const fishWrap = h('div', { class: 'fish-wrap' });
  const branchBoxes = {};
  const drawFish = () => fishWrap.replaceChildren(fishbone(st, (k) => branchBoxes[k].querySelector('input')?.focus()));
  problem.addEventListener('input', () => ((st.problem = problem.value), drawFish()));
  const branch = (k) => {
    const box = h('div', { class: 'rca-branch' });
    const add = input({ type: 'text', maxlength: 200, dir: 'auto', placeholder: t('rca.cause_add'), 'aria-label': t('rca.b.' + k) + ' - ' + t('rca.cause_add') });
    const draw = () =>
      box.replaceChildren(
        h('b', {}, t('rca.b.' + k)),
        h(
          'div',
          { class: 'chips' },
          st.bones[k].map((c, i) =>
            h(
              'span',
              { class: 'tag rca-chip' + (c.root ? ' is-root' : '') },
              edit ? h('button', { type: 'button', class: 'rca-star', 'aria-pressed': String(!!c.root), title: t('rca.mark_root'), onclick: () => ((c.root = !c.root), draw(), drawFish(), drawRoots()) }, c.root ? '★' : '☆') : c.root ? '★ ' : '',
              c.t,
              del(() => (st.bones[k].splice(i, 1), draw(), drawFish(), drawRoots())),
            ),
          ),
        ),
        edit ? add : '',
      );
    add.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = add.value.trim();
      if (!v || st.bones[k].length >= 20) return;
      st.bones[k].push({ t: v, root: false });
      add.value = '';
      draw();
      drawFish();
      add.focus();
    });
    add.addEventListener('blur', () => {
      const v = add.value.trim();
      if (v && st.bones[k].length < 20) {
        st.bones[k].push({ t: v, root: false });
        add.value = '';
        draw();
        drawFish();
      }
    });
    draw();
    branchBoxes[k] = box;
    return box;
  };
  const branches = h('div', { class: 'rca-branches' }, FISH.map(branch));
  drawFish();

  // 5. Root causes: the fishbone's marked causes, and any written here.
  const rootsBox = h('div', { class: 'stack' });
  const rootAdd = input({ type: 'text', maxlength: 500, dir: 'auto', placeholder: t('rca.root_add'), 'aria-label': t('rca.root_add') });
  rootAdd.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (rootAdd.value.trim()) st.roots.push(rootAdd.value.trim());
    rootAdd.value = '';
    drawRoots();
    rootAdd.focus();
  });
  const drawRoots = () => {
    const marked = FISH.flatMap((k) => st.bones[k].filter((c) => c.root).map((c) => [k, c.t]));
    rootsBox.replaceChildren(
      marked.length || st.roots.length
        ? h(
            'ul',
            { class: 'ack-list' },
            marked.map(([k, v]) => h('li', {}, h('span', {}, '★ ', v, h('span', { class: 'muted small' }, ' · ', t('rca.b.' + k))))),
            st.roots.map((v, i) => h('li', {}, h('span', { dir: 'auto' }, v), del(() => (st.roots.splice(i, 1), drawRoots())))),
          )
        : h('p', { class: 'muted small' }, t('rca.roots_none')),
      edit ? rootAdd : '',
    );
  };
  drawRoots();

  // 6. Action plan: each line goes to its owner as an action and opens a CAPA once approved.
  const planBox = h('div', { class: 'stack' });
  const drawPlan = () =>
    planBox.replaceChildren(
      ...st.plan.map((x, i) => {
        if (!edit) return h('div', { class: 'rca-row' }, para(x.text), h('span', { class: 'small muted' }, nameOf(x.owner_id), ' · ', dateEl(x.due)));
        const owner = select([['', t('capa.owner')], ...people.map((p) => [p.id, pick(p.name, p.name_en)])], x.owner_id || '', { 'aria-label': t('capa.owner') });
        owner.addEventListener('change', () => (x.owner_id = Number(owner.value) || null));
        return h(
          'div',
          { class: 'rca-row rca-plan' },
          input({ type: 'text', maxlength: 500, dir: 'auto', value: x.text, oninput: (e) => (x.text = e.target.value), 'aria-label': t('rca.action') }),
          owner,
          input({ type: 'date', min: S.today, value: x.due || '', oninput: (e) => (x.due = e.target.value), 'aria-label': t('ovr.due') }),
          del(() => (st.plan.splice(i, 1), drawPlan())),
        );
      }),
      edit ? h('div', {}, h('button', { type: 'button', class: 'btn btn-small', onclick: () => (st.plan.push({ text: '', owner_id: null, due: '' }), drawPlan()) }, icon('plus'), t('rca.action_add'))) : '',
      !edit && !st.plan.length ? h('p', { class: 'muted small' }, '-') : '',
    );
  peopleReady.then(drawPlan);
  drawPlan();

  // 7. Measure
  const measure = h('textarea', { rows: 2, maxlength: 1000, dir: 'auto', disabled: !edit }, st.measure);
  measure.addEventListener('input', () => (st.measure = measure.value));

  const save = async () => {
    const body = { ...st, team: st.team, whys: whyInputs.map((x) => x.value), problem: problem.value, measure: measure.value };
    await api('/ovr/' + o.id + '/rca', { method: 'PUT', body });
  };
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const run = (fn, msg) => async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    err.hidden = true;
    try {
      await fn();
      toast(t(msg));
      reload();
    } catch (e) {
      err.textContent = errText(e);
      err.hidden = false;
      b.disabled = false;
    }
  };
  const stages = h(
    'ol',
    { class: 'rca-stages' },
    RCA_STEPS.map((k, i) => {
      const done = k === 'team' ? rca.team_at : k === 'analysis' ? rca.analysis_at : rca.approved_at;
      const cur = rca.stage === k;
      return h(
        'li',
        { class: (done ? 'is-done' : cur ? 'is-current' : '') + (cur && rca.late ? ' is-late' : '') },
        h('b', {}, (done ? '✓ ' : i + 1 + '. ') + t('rca.st.' + k)),
        h('span', { class: 'small muted' }, ' ', dateEl(rca[k + '_due'])),
        cur && rca.late ? h('span', { class: 'note note-expired' }, ' ', t('rnd.late')) : '',
      );
    }),
  );
  return h(
    'section',
    { class: 'panel pad stack', id: 'rca' },
    h('div', { class: 'section-head' }, h('h2', {}, t('rca.title')), rca.approved_at ? h('span', { class: 'chip chip-valid' }, t('rca.approved'), ' · ', rca.approved_by) : ''),
    stages,
    step(1, t('rca.team'), teamBox, edit ? teamPick : ''),
    step(2, t('rca.timeline'), tlBox),
    step(3, t('rca.whys'), field(t('rca.problem'), problem), ...whyRows),
    step(4, t('rca.fish'), fishWrap, branches),
    step(5, t('rca.roots'), rootsBox),
    step(6, t('rca.plan'), planBox),
    step(7, t('rca.measure'), measure),
    err,
    edit || rca.can_approve
      ? h(
          'div',
          { class: 'actions' },
          edit ? h('button', { type: 'button', class: 'btn' + (rca.can_approve ? '' : ' btn-primary'), onclick: run(save, 'capa.saved') }, t('common.save')) : '',
          rca.can_approve ? h('button', { type: 'button', class: 'btn btn-primary', onclick: run(async () => (edit ? await save() : null, await api('/ovr/' + o.id + '/rca/approve', { method: 'POST' })), 'rca.approved_ok') }, icon('check'), t('rca.approve')) : '',
        )
      : '',
  );
}
