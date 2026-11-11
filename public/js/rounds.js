// Quality rounds.
import { render } from '../app.js';
import { compliancePct, daysTo, dueChip, kpiRow, tn } from './assets.js';
import { ApiError, S, h, icon, t } from './core.js';
import { access, fullPath, link, navigate, setUrl } from './layout.js';
import { api, checkField, dateEl, errText, errorBox, field, fmtDate, input, openDialog, select, send, toast } from './offline.js';
import { capaChip } from './capa.js';
import { pick, simpleDelete, timeEl } from './tickets.js';

/* ----------------------------- Quality rounds ----------------------------- */

export const ROUND_RESULTS = ['ok', 'fail', 'na'];
export const roundScore = (r) => (r.ok_n + r.fail_n ? Math.round((r.ok_n / (r.ok_n + r.fail_n)) * 100) + '%' : '-');
export const resultChip = (res) => h('span', { class: 'chip ' + (res === 'ok' ? 'chip-valid' : res === 'fail' ? 'chip-expired' : 'chip-review') }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('rnd.res.' + res));

// Rounds to walk: every place of every checklist by its next date. rounds/due/5 walks place 5.
export async function duePage(root, param, alive) {
  if (param) return roundRun(root, Number(param), alive);
  let d;
  try {
    d = await api('/rounds');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const { places, today, stats } = d;
  const tabs = [
    ['now', (p) => p.next_due <= today],
    ['week', (p) => p.next_due > today && daysTo(p.next_due, today) <= 7],
    ['all', () => true],
  ];
  S.rndTab = S.rndTab || 'now';
  const box = h('div', {});
  const draw = () => {
    const rows = places.filter(tabs.find(([k]) => k === S.rndTab)[1]);
    box.replaceChildren(
      h(
        'div',
        { class: 'tabs', role: 'tablist' },
        tabs.map(([k, f]) =>
          h(
            'button',
            { type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(S.rndTab === k), onclick: () => ((S.rndTab = k), draw()) },
            t('rnd.tab.' + k),
            ' ',
            h('span', { class: 'muted small' }, String(places.filter(f).length)),
          ),
        ),
      ),
      rows.length
        ? h(
            'div',
            { class: 'round-cards' },
            rows.map((p) =>
              link(
                'rounds/due/' + p.id,
                { class: 'round-card' + (p.next_due < today ? ' round-late' : '') },
                h('span', { class: 'round-card-main' }, h('span', { class: 'strong' }, pick(p.loc_ar, p.loc_en)), h('span', { class: 'muted small' }, pick(p.name_ar, p.name_en), pick(p.dept_ar, p.dept_en) ? ' · ' + pick(p.dept_ar, p.dept_en) : '')),
                dueChip(p.next_due, today),
                h('span', { class: 'btn btn-small btn-primary' }, t('rnd.start')),
              ),
            ),
          )
        : h(
            'div',
            { class: 'panel empty' },
            h('p', {}, t(places.length ? 'rnd.tab_empty' : d.can_manage ? 'rnd.empty_manage' : 'rnd.empty')),
            !places.length && d.can_manage ? link('rounds/checklists', { class: 'btn btn-primary' }, icon('plus'), t('rnd.form_add')) : null,
          ),
    );
  };
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('nav.due')), h('p', { class: 'muted' }, t('rnd.sub')))),
    kpiRow([
      ['rnd.k_late', places.filter((p) => p.next_due < today).length],
      ['rnd.k_today', places.filter((p) => p.next_due === today).length],
      ['rnd.k_week', places.filter((p) => p.next_due > today && daysTo(p.next_due, today) <= 7).length],
      ['rnd.k_ontime', compliancePct(stats)],
      ['rnd.k_done', stats.n],
      ['rnd.k_with_fail', stats.with_fail],
    ]),
    box,
  );
  draw();
}

// The place's QR code was scanned: remember it for the round, and open the round (or the list when there are several).
export async function roundScanPage(root, code, alive) {
  let d;
  try {
    d = await api('/rounds/scan/' + encodeURIComponent(code));
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  S.rndScan = { code, location_id: d.location.id };
  if (d.places.length === 1) {
    S.route = fullPath('rounds/due/' + d.places[0].id);
    setUrl(S.route, false);
    render();
    return;
  }
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, pick(d.location.name_ar, d.location.name_en)), h('p', { class: 'muted' }, icon('check'), ' ', t('rnd.scanned_here')))),
    d.places.length
      ? h(
          'div',
          { class: 'round-cards' },
          d.places.map((p) =>
            link('rounds/due/' + p.id, { class: 'round-card' + (p.next_due < d.today ? ' round-late' : '') }, h('span', { class: 'round-card-main' }, h('span', { class: 'strong' }, pick(p.name_ar, p.name_en))), dueChip(p.next_due, d.today), h('span', { class: 'btn btn-small btn-primary' }, t('rnd.start'))),
          ),
        )
      : h('p', { class: 'panel empty' }, t('rnd.scan_none')),
  );
}

// Walking one place: each line is fine, has a problem, or does not apply. Problems need a word on what was seen.
export async function roundRun(root, placeId, alive) {
  let d;
  try {
    d = await api('/rounds/start/' + placeId);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const { place, items, today } = d;
  const scanned = !!S.rndScan && S.rndScan.location_id === place.location_id;
  const blocked = d.require_scan && !scanned;
  const answers = new Map();
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const general = h('textarea', { rows: 2, maxlength: 1000, placeholder: t('rnd.note_ph') });
  const progress = h('span', { class: 'muted small', 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, icon('check'), t('rnd.submit'));
  const rows = items.map((it, i) => {
    const note = h('input', { type: 'text', maxlength: 500, dir: 'auto', placeholder: t('rnd.fail_ph'), 'aria-label': t('rnd.fail_ph') });
    const noteBox = h('div', { class: 'round-note', hidden: true }, note);
    const buttons = ROUND_RESULTS.map((res) =>
      h('button', { type: 'button', class: 'round-pick round-' + res, 'aria-pressed': 'false', onclick: () => choose(res) }, icon(res === 'ok' ? 'check' : res === 'fail' ? 'close' : 'minus'), t('rnd.res.' + res)),
    );
    const row = h(
      'li',
      { class: 'round-item' },
      h('div', { class: 'round-text' }, h('span', { class: 'round-num', dir: 'ltr' }, String(i + 1)), h('span', {}, pick(it.text_ar, it.text_en)), it.std_code ? h('span', { class: 'mono muted small', dir: 'ltr' }, ' ' + it.std_code) : ''),
      h('div', { class: 'round-picks', role: 'group', 'aria-label': pick(it.text_ar, it.text_en) }, buttons),
      noteBox,
    );
    const choose = (res) => {
      answers.set(it.id, { res, note });
      buttons.forEach((b, k) => b.setAttribute('aria-pressed', String(ROUND_RESULTS[k] === res)));
      row.dataset.result = res;
      noteBox.hidden = res !== 'fail';
      note.required = res === 'fail';
      if (res === 'fail') note.focus();
      err.hidden = true;
      count();
    };
    row.choose = choose;
    return row;
  });
  const count = () => {
    const fails = [...answers.values()].filter((a) => a.res === 'fail').length;
    progress.textContent = t('rnd.progress', { n: answers.size, of: items.length }) + (fails ? ' · ' + tn('rnd.fails', fails) : '');
  };
  count();
  const allOk = h('button', { type: 'button', class: 'btn btn-small', onclick: () => rows.forEach((r, i) => !answers.has(items[i].id) && r.choose('ok')) }, t('rnd.rest_ok'));
  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (ev) => {
        ev.preventDefault();
        err.hidden = true;
        const missing = items.findIndex((it) => !answers.has(it.id));
        if (missing >= 0) {
          err.textContent = t('rnd.answer_all');
          err.hidden = false;
          rows[missing].scrollIntoView({ block: 'center' });
          return;
        }
        submit.disabled = true;
        try {
          const r = await api('/rounds', {
            method: 'POST',
            body: { place_id: place.id, loc_code: scanned ? S.rndScan.code : undefined, note: general.value, answers: items.map((it) => ({ item_id: it.id, result: answers.get(it.id).res, note: answers.get(it.id).note.value })) },
          });
          if (r.queued) {
            navigate('rounds/due');
            return;
          }
          S.rndDone = r;
          root.replaceChildren(roundDone(r, place));
          window.scrollTo(0, 0);
        } catch (e) {
          err.textContent = errText(e);
          err.hidden = false;
          submit.disabled = false;
        }
      },
    },
    h('ol', { class: 'round-list' }, rows),
    field(t('rnd.note'), general),
    err,
    submit,
  );
  root.replaceChildren(
    h('p', {}, link('rounds/due', { class: 'back-link' }, t('rnd.back'))),
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, pick(place.loc_ar, place.loc_en)), h('p', { class: 'muted' }, pick(place.name_ar, place.name_en), ' · ', t('rnd.due_on'), ' ', h('span', { dir: 'ltr' }, fmtDate(place.next_due)), place.next_due < today ? h('span', { class: 'note note-expired' }, ' ', t('rnd.late')) : null)),
    ),
    scanned
      ? h('p', { class: 'notice' }, icon('check'), ' ', t('rnd.scanned_here'))
      : blocked
        ? h('p', { class: 'notice notice-warn' }, t('rnd.scan_needed'))
        : '',
    blocked ? '' : h('div', { class: 'round-bar' }, progress, allOk),
    blocked ? '' : h('section', { class: 'panel' }, form),
  );
}
export function roundDone(r, place) {
  const seeDesk = access('desk') !== 'none';
  const seeCapa = access('quality') !== 'none';
  return h(
    'section',
    { class: 'panel round-done stack' },
    h('h1', {}, icon('check', 28), ' ', t('rnd.saved')),
    h('p', {}, pick(place.loc_ar, place.loc_en), ' · ', pick(place.name_ar, place.name_en)),
    h('p', { class: 'round-score' }, t('rnd.score'), ' ', h('strong', { dir: 'ltr' }, roundScore(r)), ' · ', tn('rnd.fails', r.fail_n)),
    r.capa_n ? h('p', { class: 'notice notice-warn' }, t('rnd.capa_opened', { n: r.capa_n }), ' ', seeCapa ? link('quality/capa', { class: 'btn btn-small' }, t('nav.capa')) : '') : null,
    r.ticket_id ? h('p', { class: 'notice notice-warn' }, t('rnd.ticket_opened'), ' ', seeDesk ? link('desk/tickets/' + r.ticket_id, { class: 'btn btn-small' }, '#' + r.ticket_id) : h('strong', { dir: 'ltr' }, '#' + r.ticket_id)) : null,
    r.fail_n ? null : h('p', { class: 'notice' }, t('rnd.all_good')),
    h('p', { class: 'muted' }, t('rnd.next'), ' ', h('span', { dir: 'ltr' }, fmtDate(r.next_due))),
    h('div', { class: 'actions' }, link('rounds/due', { class: 'btn btn-primary' }, t('rnd.more')), link('rounds/rlog/' + r.id, { class: 'btn' }, t('rnd.view'))),
  );
}

// Rounds done, newest first. rounds/rlog/7 shows one round line by line.
export async function roundLogPage(root, param, alive) {
  if (param) return roundDetail(root, Number(param), alive);
  S.rndLog = S.rndLog || {};
  const q = new URLSearchParams();
  for (const k of ['from', 'to', 'form']) if (S.rndLog[k]) q.set(k, S.rndLog[k]);
  let d;
  try {
    d = await api('/rounds/log' + (q.toString() ? '?' + q : ''));
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const from = input({ type: 'date', value: d.from });
  const to = input({ type: 'date', value: d.to });
  const form = select([['', t('rnd.all_forms')], ...d.forms.map((f) => [f.id, pick(f.name_ar, f.name_en)])], S.rndLog.form || '', {});
  const apply = () => {
    S.rndLog = { from: from.value, to: to.value, form: form.value };
    render();
  };
  for (const el of [from, to, form]) el.addEventListener('change', apply);
  const list = d.rounds;
  const onTime = list.filter((r) => r.on_time).length;
  const seeDesk = access('desk') !== 'none';
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('nav.rlog')), h('p', { class: 'muted' }, t('rnd.log_sub')))),
    h('section', { class: 'panel filters' }, h('div', { class: 'form-grid' }, field(t('rnd.from'), from), field(t('rnd.to'), to), field(t('rnd.form'), form))),
    kpiRow([
      ['rnd.k_done', list.length],
      ['rnd.k_ontime', compliancePct({ n: list.length, ok: onTime })],
      ['rnd.k_with_fail', list.filter((r) => r.fail_n).length],
      seeDesk ? ['rnd.k_tickets', list.filter((r) => r.ticket_id).length] : ['rnd.k_capa', list.reduce((n, r) => n + (r.capa_n || 0), 0)],
      ['rnd.k_scanned', compliancePct({ n: list.length, ok: list.filter((r) => r.scanned).length })],
    ]),
    h(
      'section',
      { class: 'panel' },
      list.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['rnd.when', 'rnd.place', 'rnd.form', 'rnd.by', 'rnd.score', 'rnd.timing', seeDesk ? 'rnd.ticket' : 'rnd.capa'].map((c) => h('th', { scope: 'col' }, t(c))))),
              h(
                'tbody',
                {},
                list.map((r) =>
                  h(
                    'tr',
                    { class: 'row-link', onclick: (ev) => ev.target.closest('a') || navigate('rounds/rlog/' + r.id) },
                    h('td', {}, timeEl(r.done_at)),
                    h('td', { class: 'strong' }, link('rounds/rlog/' + r.id, {}, pick(r.loc_ar, r.loc_en) || '#' + r.id), r.scanned ? h('span', { class: 'note note-valid', title: t('rnd.scanned') }, ' ', icon('check'), t('rnd.scanned_short')) : ''),
                    h('td', {}, pick(r.name_ar, r.name_en)),
                    h('td', {}, r.user_name || t('common.none')),
                    h('td', {}, h('span', { dir: 'ltr', class: 'mono' }, roundScore(r)), r.fail_n ? h('span', { class: 'note note-expired' }, ' ', tn('rnd.fails', r.fail_n)) : null),
                    h('td', {}, h('span', { class: 'chip ' + (r.on_time ? 'chip-valid' : 'chip-near') }, t(r.on_time ? 'rnd.on_time' : 'rnd.late'))),
                    seeDesk
                      ? h('td', {}, r.ticket_id ? link('desk/tickets/' + r.ticket_id, { class: 'btn btn-small' }, '#' + r.ticket_id) : h('span', { class: 'muted' }, t('common.none')))
                      : h('td', {}, r.capa_n ? [h('span', { class: 'mono' }, String(r.capa_n)), r.capa_open ? h('span', { class: 'note note-expired' }, ' ', r.capa_open + ' ' + t('capa.k_open')) : ''] : h('span', { class: 'muted' }, t('common.none'))),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('rnd.log_empty')),
    ),
  );
}
export async function roundDetail(root, id, alive) {
  let d;
  try {
    d = await api('/rounds/' + id);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const { round: r, answers, capa } = d;
  const seeDesk = access('desk') !== 'none';
  const seeCapa = access('quality') !== 'none';
  const metaRow = (label, value) => h('div', { class: 'meta' }, h('span', { class: 'meta-label' }, label), value);
  root.replaceChildren(
    h('p', {}, link('rounds/rlog', { class: 'back-link' }, t('rnd.back_log'))),
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, pick(r.loc_ar, r.loc_en)), h('p', { class: 'muted' }, pick(r.name_ar, r.name_en)))),
    h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'meta-grid' },
        metaRow(t('rnd.when'), timeEl(r.done_at)),
        metaRow(t('rnd.by'), h('span', {}, r.user_name || t('common.none'))),
        metaRow(t('rnd.scan'), h('span', { class: r.scanned ? '' : 'muted' }, t(r.scanned ? 'rnd.scanned' : 'rnd.not_scanned'))),
        metaRow(t('rnd.due_on'), h('span', {}, dateEl(r.due), ' ', h('span', { class: 'chip ' + (r.on_time ? 'chip-valid' : 'chip-near') }, t(r.on_time ? 'rnd.on_time' : 'rnd.late')))),
        metaRow(t('rnd.score'), h('span', {}, h('span', { dir: 'ltr' }, roundScore(r)), ' · ', tn('rnd.fails', r.fail_n), r.na_n ? ' · ' + tn('rnd.nas', r.na_n) : '')),
        r.ticket_id ? metaRow(t('rnd.ticket'), seeDesk ? link('desk/tickets/' + r.ticket_id, { class: 'btn btn-small' }, '#' + r.ticket_id) : h('span', {}, '#' + r.ticket_id)) : '',
      ),
      r.note ? h('p', { class: 'pre' }, r.note) : '',
    ),
    h(
      'section',
      { class: 'panel' },
      h(
        'ol',
        { class: 'round-list' },
        answers.map((a) =>
          h(
            'li',
            { class: 'round-item', 'data-result': a.result },
            h('div', { class: 'round-text' }, h('span', {}, pick(a.text_ar, a.text_en)), a.std_code ? h('span', { class: 'mono muted small', dir: 'ltr' }, ' ' + a.std_code) : ''),
            resultChip(a.result),
            a.note ? h('p', { class: 'muted small' }, a.note) : '',
          ),
        ),
      ),
    ),
    capa && capa.length
      ? h(
          'section',
          { class: 'panel' },
          h('h2', {}, t('rnd.capa')),
          h(
            'ul',
            { class: 'home-list' },
            capa.map((c) =>
              h('li', {}, seeCapa ? link('quality/capa/' + c.id, {}, c.title) : h('span', {}, c.title), c.std_code ? h('span', { class: 'mono muted small', dir: 'ltr' }, ' ' + c.std_code) : '', ' ', capaChip(c.status)),
            ),
          ),
        )
      : '',
  );
}

// Checklists (managers): what is checked, where, how often, and which team hears about a problem.
export async function checklistsPage(root, _param, alive) {
  let d;
  try {
    d = await api('/round-forms');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const label = (f) => pick(f.name_ar, f.name_en);
  const seeDesk = access('desk') !== 'none';
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.checklists')), h('p', { class: 'muted' }, t('rnd.forms_sub'))),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => roundFormDialog(null, d) }, icon('plus'), t('rnd.form_add'))),
    ),
    roundReminders(d),
    h(
      'section',
      { class: 'panel' },
      d.forms.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['rnd.form', 'rnd.every', 'rnd.items', 'rnd.places', 'qa.chapter', ...(seeDesk ? ['rnd.category'] : []), 'user.status', 'common.actions'].map((c) => h('th', { scope: 'col' }, t(c))))),
              h(
                'tbody',
                {},
                d.forms.map((f) =>
                  h(
                    'tr',
                    {},
                    h('td', { class: 'strong' }, label(f)),
                    h('td', {}, tn('rnd.every_n', f.every_days)),
                    h('td', {}, h('span', { class: 'mono' }, String(f.item_count))),
                    h('td', {}, h('span', { class: 'mono' }, String(f.place_count))),
                    h('td', {}, f.chapter ? h('span', { class: 'mono' }, f.chapter) : h('span', { class: 'muted' }, t('common.none'))),
                    seeDesk ? h('td', {}, pick(f.cat_ar, f.cat_en) || t('common.none')) : '',
                    h('td', {}, f.active ? t('field.active') : h('span', { class: 'muted' }, t('user.inactive'))),
                    h(
                      'td',
                      {},
                      h(
                        'div',
                        { class: 'row-actions' },
                        h('button', { type: 'button', class: 'btn btn-icon', title: t('common.edit'), 'aria-label': t('common.edit') + ': ' + label(f), onclick: () => editRoundForm(f, d) }, icon('edit')),
                        f.round_count
                          ? ''
                          : h('button', { type: 'button', class: 'btn btn-icon', title: t('common.delete'), 'aria-label': t('common.delete') + ': ' + label(f), onclick: () => simpleDelete(t('rnd.delete_q', { name: label(f) }), '/round-forms/' + f.id, t('rnd.deleted')) }, icon('trash')),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('rnd.forms_empty')),
    ),
  );
}
// The morning email to inspectors: on or off, and a button to send it now.
export function roundReminders(d) {
  const on = input({ type: 'checkbox', checked: d.reminders });
  on.addEventListener('change', async () => {
    on.disabled = true;
    try {
      await api('/round-forms/reminders', { method: 'PUT', body: { on: on.checked } });
      toast(t(on.checked ? 'rnd.remind_on' : 'rnd.remind_off'));
    } catch (e) {
      on.checked = !on.checked;
      toast(errText(e), true);
    } finally {
      on.disabled = false;
    }
  });
  const send = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-small',
      onclick: async () => {
        send.disabled = true;
        try {
          const r = await api('/round-forms/reminders', { method: 'POST', body: {} });
          if (!r.ok) toast(errText({ code: r.error }), true);
          else toast(r.places ? t('rnd.remind_sent', { emails: r.emails, places: r.places }) : t('rnd.remind_nothing'));
        } catch (e) {
          toast(errText(e), true);
        } finally {
          send.disabled = false;
        }
      },
    },
    t('rnd.remind_now'),
  );
  const scan = input({ type: 'checkbox', checked: d.require_scan });
  scan.addEventListener('change', async () => {
    scan.disabled = true;
    try {
      await api('/round-forms/require-scan', { method: 'PUT', body: { on: scan.checked } });
      toast(t(scan.checked ? 'rnd.scan_on' : 'rnd.scan_off'));
    } catch (e) {
      scan.checked = !scan.checked;
      toast(errText(e), true);
    } finally {
      scan.disabled = false;
    }
  });
  return h(
    'section',
    { class: 'panel round-remind' },
    checkField(t('rnd.require_scan'), scan),
    h('p', { class: 'hint' }, t('rnd.require_scan_hint')),
    checkField(t('rnd.remind'), on),
    h('p', { class: 'hint' }, t('rnd.remind_hint')),
    h('div', { class: 'actions' }, send, d.reminded_on ? h('span', { class: 'muted small' }, t('rnd.remind_last'), ' ', h('span', { dir: 'ltr' }, fmtDate(d.reminded_on))) : ''),
  );
}
export async function editRoundForm(f, meta) {
  try {
    roundFormDialog(await api('/round-forms/' + f.id), meta);
  } catch (e) {
    toast(errText(e), true);
  }
}
export function roundFormDialog(x, meta) {
  const f = x && x.form;
  const nameAr = input({ type: 'text', required: true, maxlength: 150, dir: 'rtl', value: f ? f.name_ar : '', placeholder: 'جولة السلامة من الحريق' });
  const nameEn = input({ type: 'text', required: true, maxlength: 150, dir: 'ltr', value: f ? f.name_en : '', placeholder: 'Fire safety round' });
  const every = input({ type: 'number', required: true, min: 1, max: 366, value: f ? f.every_days : 30 });
  // A maintenance request for failed lines only when the requests system is in use; corrective actions always.
  const seeDesk = access('desk') !== 'none';
  const cat = select([['', t('rnd.pick_category')], ...meta.categories.map((c) => [c.id, pick(c.name_ar, c.name_en) + (pick(c.team_ar, c.team_en) ? ' · ' + pick(c.team_ar, c.team_en) : '')])], f && f.category_id ? f.category_id : '', {});
  const chapter = select([['', t('rnd.no_chapter')], ...(meta.chapters || []).map((c) => [c.code, c.code + ' · ' + pick(c.name_ar, c.name_en)])], f ? f.chapter || '' : '', {});
  const first = input({ type: 'date', value: meta.today });
  const active = input({ type: 'checkbox', checked: f ? !!f.active : true });
  const lines = h('ol', { class: 'round-edit' });
  const addLine = (it) => {
    const ar = h('input', { type: 'text', required: true, maxlength: 300, dir: 'rtl', value: it ? it.text_ar : '', placeholder: t('rnd.item_ar'), 'aria-label': t('rnd.item_ar') });
    const en = input({ type: 'text', maxlength: 300, dir: 'ltr', value: it ? it.text_en || '' : '', placeholder: t('rnd.item_en'), 'aria-label': t('rnd.item_en') });
    const std = input({ type: 'text', maxlength: 30, dir: 'ltr', class: 'round-std', value: it ? it.std_code || '' : '', placeholder: 'FMS.3.1', 'aria-label': t('capa.std') });
    const li = h('li', {}, ar, en, std, h('button', { type: 'button', class: 'btn btn-icon', title: t('common.delete'), 'aria-label': t('common.delete'), onclick: () => li.remove() }, icon('trash')));
    li.read = () => ({ text_ar: ar.value, text_en: en.value, std_code: std.value });
    lines.append(li);
    return ar;
  };
  (x ? x.items : [null, null, null]).forEach(addLine);
  const picked = new Set(x ? x.places.map((p) => p.location_id) : []);
  const find = input({ type: 'search', placeholder: t('rnd.find_place'), 'aria-label': t('rnd.find_place') });
  const placeCount = h('span', { class: 'muted small' });
  const showCount = () => (placeCount.textContent = tn('rnd.n_places', picked.size));
  const boxes = meta.locations.map((l) => {
    const c = input({ type: 'checkbox', checked: picked.has(l.id) });
    c.addEventListener('change', () => (c.checked ? picked.add(l.id) : picked.delete(l.id), showCount()));
    const row = checkField(pick(l.name_ar, l.name_en), c);
    row.dataset.q = (l.name_ar + ' ' + l.name_en).toLowerCase();
    return row;
  });
  find.addEventListener('input', () => {
    const q = find.value.trim().toLowerCase();
    for (const b of boxes) b.hidden = !!q && !b.dataset.q.includes(q);
  });
  showCount();
  openDialog({
    title: t(f ? 'rnd.form_edit' : 'rnd.form_add'),
    body: h(
      'div',
      { class: 'stack' },
      h('div', { class: 'form-grid' }, field(t('dept.name_ar'), nameAr), field(t('dept.name_en'), nameEn)),
      h('div', { class: 'form-grid' }, field(t('rnd.every_days'), every), field(t(f ? 'rnd.first_due_new' : 'rnd.first_due'), first)),
      field(t('qa.chapter'), chapter),
      seeDesk ? field(t('rnd.category'), cat, t('rnd.category_hint')) : '',
      h('fieldset', { class: 'app-roles' }, h('legend', {}, t('rnd.items')), h('p', { class: 'hint' }, t('rnd.items_hint'), ' ', t('rnd.std_hint')), lines, h('button', { type: 'button', class: 'btn btn-small', onclick: () => addLine(null).focus() }, icon('plus'), t('rnd.add_item'))),
      h('fieldset', { class: 'app-roles' }, h('legend', {}, t('rnd.places'), ' ', placeCount), meta.locations.length > 8 ? find : '', h('div', { class: 'place-picks' }, boxes)),
      checkField(t('user.active'), active),
    ),
    onSubmit: async () => {
      const items = [...lines.children].map((li) => li.read()).filter((it) => it.text_ar.trim());
      if (!items.length) throw new ApiError('items_required');
      if (!picked.size) throw new ApiError('places_required');
      const body = { name_ar: nameAr.value, name_en: nameEn.value, every_days: Number(every.value), category_id: seeDesk ? Number(cat.value) || 0 : f ? f.category_id || 0 : 0, chapter: chapter.value, first_due: first.value, active: active.checked, items, location_ids: [...picked] };
      await api(f ? '/round-forms/' + f.id : '/round-forms', { method: f ? 'PUT' : 'POST', body });
      toast(t(f ? 'rnd.form_saved' : 'rnd.form_added'));
      render();
    },
  });
}
