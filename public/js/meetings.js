// Committees & meetings: the committees master (hospital committees, departmental meetings, special
// meetings), one committee's page (details, members, papers, sessions) and the calendar of every session.
import { render } from '../app.js';
import { kpiRow } from './assets.js';
import { S, h, icon, t } from './core.js';
import { link, navigate } from './layout.js';
import { api, checkField, errText, errorBox, field, fmtDate, input, openDialog, select, toast } from './offline.js';
import { pick, simpleDelete } from './tickets.js';

const KINDS = ['committee', 'department', 'special'];
const FREQS = ['weekly', 'biweekly', 'monthly', 'bimonthly', 'quarterly', 'semiannual', 'annual'];
const ROLES = ['chair', 'co_chair', 'secretary', 'member', 'invitee'];
const SPECIAL = ['urgent', 'rca', 'task_force', 'other'];
const STATUS_CHIP = { scheduled: 'chip-review', rescheduled: 'chip-near', postponed: 'chip-near', cancelled: 'chip-expired', held: 'chip-valid' };
const name = (c) => pick(c.name_ar, c.name_en);
const statusChip = (s) => h('span', { class: 'chip ' + STATUS_CHIP[s.status] }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('mtg.st.' + s.status));
const weekday = (d) => new Intl.DateTimeFormat(S.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z'));
const when = (s) => (s.date_tbd ? t('mtg.tbd') : weekday(s.date) + ' ' + fmtDate(s.date) + ' · ' + s.start_time);
// Employee numbers typed with Arabic-Indic digits (٢٨٢٤) are sent as 2824.
const arabicDigits = (v) => String(v || '').replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
const ltr = (x) => h('span', { dir: 'ltr', class: 'mono' }, x);

/* ------------------------------ the committees ----------------------------- */

// meetings/committees: the list; meetings/committees/5: one committee.
export async function committeesPage(root, param, alive) {
  if (/^\d+$/.test(String(param || ''))) return committeePage(root, Number(param), alive);
  let d;
  try {
    d = await api('/committees');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  S.mtgDepts = d.departments;
  const kind = KINDS.includes(S.mtgKind) ? S.mtgKind : 'committee';
  const f = (S.mtgF = S.mtgF || { q: '', off: false });
  const all = d.committees;
  const tabs = h(
    'nav',
    { class: 'mtg-tabs', 'aria-label': t('nav.committees') },
    KINDS.map((k) =>
      h(
        'button',
        { type: 'button', class: 'mtg-tab' + (k === kind ? ' is-active' : ''), 'aria-pressed': String(k === kind), onclick: () => ((S.mtgKind = k), render()) },
        t('mtg.kinds.' + k),
        h('span', { class: 'mtg-tab-n' }, String(all.filter((c) => c.kind === k && c.active).length)),
      ),
    ),
  );
  const search = input({ type: 'search', class: 'doc-search-input', value: f.q, placeholder: t('mtg.search_ph'), 'aria-label': t('mtg.search'), autocomplete: 'off' });
  const off = input({ type: 'checkbox', checked: f.off });
  const box = h('div', {});
  const norm = (x) => String(x || '').toLowerCase();
  const draw = () => {
    const q = norm(f.q.trim());
    const rows = all.filter((c) => c.kind === kind && (f.off || c.active) && (!q || [c.code, c.name_ar, c.name_en, c.chair, c.dept_ar, c.dept_en].some((v) => norm(v).includes(q))));
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
                h('thead', {}, h('tr', {}, ['mtg.code', 'mtg.name', kind === 'department' ? 'user.department' : 'mtg.chair', kind === 'special' ? 'mtg.type' : 'mtg.frequency', 'mtg.members', 'mtg.next', 'mtg.compliance'].map((c) => h('th', { scope: 'col' }, t(c))))),
                h(
                  'tbody',
                  {},
                  rows.map((c) =>
                    h(
                      'tr',
                      { class: c.active ? '' : 'is-off' },
                      h('td', { class: 'nowrap' }, link('meetings/committees/' + c.id, { class: 'mono strong' }, c.code)),
                      h('td', { class: 'wrap-cell' }, link('meetings/committees/' + c.id, { class: 'strong' }, name(c)), c.urgent ? [' ', h('span', { class: 'chip chip-expired' }, t('mtg.urgent'))] : null, c.active ? null : h('div', { class: 'small muted' }, t('mtg.off'))),
                      h('td', {}, kind === 'department' ? pick(c.dept_ar, c.dept_en) || '-' : c.chair || h('span', { class: 'muted' }, t('common.none'))),
                      h('td', {}, kind === 'special' ? t('mtg.types.' + (c.meeting_type || 'other')) : t('mtg.freq.' + c.frequency)),
                      h('td', {}, h('span', { class: 'mono' }, String(c.members))),
                      h('td', { class: 'nowrap' }, c.next_at ? [weekday(c.next_at.slice(0, 10)), h('div', { class: 'small muted' }, ltr(fmtDate(c.next_at.slice(0, 10)) + ' ' + c.next_at.slice(11)))] : h('span', { class: 'muted' }, t('common.none'))),
                      h('td', { class: 'nowrap' }, c.due_year ? h('span', { class: 'mono' }, c.held_year + ' / ' + c.due_year) : h('span', { class: 'muted' }, '-')),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty' }, t(all.some((c) => c.kind === kind) ? 'mtg.no_match' : 'mtg.empty_' + kind)),
      ),
    );
  };
  search.addEventListener('input', () => ((f.q = search.value), draw()));
  off.addEventListener('change', () => ((f.off = off.checked), draw()));
  const canAdd = kind === 'department' ? d.can_create_dept : d.can_create;
  const active = all.filter((c) => c.active);
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.committees')), h('p', { class: 'muted' }, t('mtg.sub'))),
      h('div', { class: 'actions' }, link('meetings/calendar', { class: 'btn' }, icon('clipboard'), t('nav.calendar')), canAdd ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => committeeDialog(null, kind, d) }, icon('plus'), t('mtg.add_' + kind)) : null),
    ),
    kpiRow([
      ['mtg.k_committees', active.filter((c) => c.kind === 'committee').length],
      ['mtg.k_departments', active.filter((c) => c.kind === 'department').length],
      ['mtg.k_special', active.filter((c) => c.kind === 'special').length],
      ['mtg.k_week', active.filter((c) => c.next_at && c.next_at.slice(0, 10) <= addDays(d.today, 7)).length],
    ]),
    tabs,
    h('div', { class: 'filters' }, h('div', { class: 'doc-search', role: 'search' }, icon('search'), search), checkField(t('mtg.show_off'), off)),
    box,
  );
  draw();
}

const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

function committeeDialog(c, kind, ctx) {
  kind = c ? c.kind : kind;
  const v = (k, dflt) => (c ? c[k] ?? dflt : dflt);
  const nameAr = input({ type: 'text', required: true, maxlength: 160, dir: 'rtl', value: v('name_ar', '') });
  const nameEn = input({ type: 'text', required: true, maxlength: 160, dir: 'ltr', value: v('name_en', '') });
  const depts = (ctx && ctx.departments) || S.mtgDepts || [];
  const mine = ctx && !ctx.can_create && ctx.my_department;
  const dept = select([['', t('common.none')], ...depts.filter((x) => !mine || x.id === ctx.my_department).map((x) => [x.id, pick(x.name_ar, x.name_en)])], v('department_id', mine || ''), { required: kind === 'department' });
  const freq = select(FREQS.map((x) => [x, t('mtg.freq.' + x)]), v('frequency', 'monthly'), {});
  const type = select(SPECIAL.map((x) => [x, t('mtg.types.' + x)]), v('meeting_type', 'urgent'), {});
  const first = input({ type: 'date', required: true, value: v('first_date', '') });
  const time = input({ type: 'time', required: true, value: v('start_time', '10:00') });
  const dur = input({ type: 'number', min: 15, max: 600, step: 15, required: true, value: v('duration_min', 60) });
  const venue = input({ type: 'text', maxlength: 200, value: v('venue', '') });
  const quorum = input({ type: 'number', min: 1, max: 100, required: true, value: v('quorum_pct', 50) });
  const purpose = h('textarea', { rows: 3, maxlength: 2000 }, v('purpose', ''));
  const active = input({ type: 'checkbox', checked: c ? !!c.active : true });
  const special = kind === 'special';
  openDialog({
    title: t(c ? 'mtg.edit_' + kind : 'mtg.add_' + kind),
    body: h(
      'div',
      { class: 'stack' },
      h('div', { class: 'form-grid' }, field(t('user.name_ar'), nameAr), field(t('user.name_en'), nameEn)),
      kind === 'department' ? field(t('user.department'), dept, t('mtg.dept_hint')) : null,
      special ? field(t('mtg.type'), type, t('mtg.type_hint')) : null,
      h('div', { class: 'form-grid' }, special ? null : field(t('mtg.frequency'), freq, t('mtg.freq_hint')), field(t(special ? 'mtg.date' : 'mtg.first_date'), first, special ? null : t('mtg.first_hint'))),
      h('div', { class: 'form-grid' }, field(t('mtg.time'), time), field(t('mtg.duration'), dur)),
      h('div', { class: 'form-grid' }, field(t('mtg.venue'), venue), field(t('mtg.quorum'), quorum, t('mtg.quorum_hint'))),
      field(t(special ? 'mtg.purpose_special' : 'mtg.purpose'), purpose),
      c ? checkField(t('field.active'), active) : null,
    ),
    onSubmit: async () => {
      const body = {
        kind,
        name_ar: nameAr.value,
        name_en: nameEn.value,
        department_id: dept.value ? Number(dept.value) : null,
        frequency: special ? 'none' : freq.value,
        meeting_type: special ? type.value : null,
        urgent: special && type.value === 'urgent',
        first_date: first.value,
        start_time: time.value,
        duration_min: Number(dur.value),
        venue: venue.value,
        quorum_pct: Number(quorum.value),
        purpose: purpose.value,
        active: active.checked,
      };
      const r = await api(c ? '/committees/' + c.id : '/committees', { method: c ? 'PUT' : 'POST', body });
      toast(t('mtg.saved'));
      if (!c) navigate('meetings/committees/' + r.id);
      render();
    },
  });
}

/* ------------------------------ one committee ------------------------------ */

async function committeePage(root, id, alive) {
  let d;
  try {
    d = await api('/committees/' + id);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const c = d.committee;
  const run = d.can_run;
  const upcoming = d.sessions.filter((s) => s.date >= d.today && s.status !== 'held');
  const past = d.sessions.filter((s) => !(s.date >= d.today && s.status !== 'held')).reverse();
  const next = upcoming.find((s) => s.status !== 'cancelled' && !s.date_tbd);
  const activeMembers = d.members.filter((m) => m.active);

  const info = h(
    'section',
    { class: 'panel pad mtg-info' },
    h(
      'dl',
      { class: 'mtg-facts' },
      [
        ['mtg.code', ltr(c.code)],
        c.kind === 'department' ? ['user.department', pick(c.dept_ar, c.dept_en)] : null,
        c.kind === 'special' ? ['mtg.type', t('mtg.types.' + (c.meeting_type || 'other'))] : ['mtg.frequency', t('mtg.freq.' + c.frequency)],
        ['mtg.time', [ltr(c.start_time), ' · ' + t('mtg.minutes_n', { n: c.duration_min })]],
        ['mtg.venue', c.venue || t('common.none')],
        ['mtg.quorum', t('mtg.quorum_of', { pct: c.quorum_pct, n: c.quorum_n })],
        ['mtg.next', next ? when(next) : t('common.none')],
      ]
        .filter(Boolean)
        .map(([k, v]) => h('div', {}, h('dt', {}, t(k)), h('dd', {}, v))),
    ),
    c.purpose ? h('div', { class: 'mtg-purpose' }, h('h3', {}, t(c.kind === 'special' ? 'mtg.purpose_special' : 'mtg.purpose')), h('p', {}, c.purpose)) : null,
  );

  // Members.
  const memberRow = (m) =>
    h(
      'tr',
      { class: m.active ? '' : 'is-off' },
      h('td', {}, h('div', { class: 'strong' }, pick(m.name, m.name_en)), m.emp_no ? h('div', { class: 'small muted' }, ltr(m.emp_no)) : null),
      h('td', {}, m.position || h('span', { class: 'muted' }, '-')),
      h('td', {}, h('span', { class: 'chip ' + (m.role === 'chair' ? 'chip-progress' : 'chip-review') }, t('mtg.role.' + m.role))),
      h('td', {}, m.email ? h('bdi', { dir: 'ltr', class: 'small' }, m.email) : h('span', { class: 'small form-error' }, t('mtg.no_email'))),
      h('td', { class: 'small' }, m.active ? (m.substitute_name ? t('mtg.substitute_is', { name: m.substitute_name }) : '') : h('span', { class: 'muted' }, t('mtg.inactive_since', { reason: m.inactive_reason || '' }))),
      run
        ? h(
            'td',
            {},
            h(
              'div',
              { class: 'row-actions' },
              h('button', { type: 'button', class: 'btn btn-icon', title: t('common.edit'), 'aria-label': t('common.edit') + ': ' + m.name, onclick: () => memberDialog(c, m) }, icon('edit')),
              h('button', { type: 'button', class: 'btn btn-icon', title: t('common.delete'), 'aria-label': t('common.delete') + ': ' + m.name, onclick: () => simpleDelete(t('mtg.member_delete_q', { name: m.name }), '/committees/' + c.id + '/members/' + m.id, t('mtg.member_deleted')) }, icon('trash')),
            ),
          )
        : null,
    );
  const members = h(
    'section',
    { class: 'panel' },
    h(
      'div',
      { class: 'panel-head' },
      h('div', { class: 'panel-title' }, h('h2', {}, t('mtg.members_title')), h('span', { class: 'muted small' }, t('mtg.members_n', { n: activeMembers.length }))),
      run ? h('div', { class: 'actions' }, c.kind === 'department' && c.department_id ? h('button', { type: 'button', class: 'btn', onclick: () => suggestDialog(c, d.members) }, icon('users'), t('mtg.suggest')) : null, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => memberDialog(c, null) }, icon('plus'), t('mtg.member_add'))) : null,
    ),
    d.members.length
      ? h('div', { class: 'table-scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['mtg.member', 'mtg.position', 'mtg.member_role', 'user.email', 'mtg.notes', ...(run ? ['common.actions'] : [])].map((x) => h('th', { scope: 'col' }, t(x))))), h('tbody', {}, d.members.map(memberRow))))
      : h('p', { class: 'empty' }, t('mtg.members_empty')),
  );

  // Terms of reference and reference papers.
  const fileTile = (f) =>
    h(
      'div',
      { class: 'mtg-file' },
      h('a', { href: '/api/committees/' + c.id + '/files/' + f.id, target: '_blank', rel: 'noopener', class: 'mtg-file-link' }, icon('file', 22), h('span', {}, f.name)),
      h('span', { class: 'tag' }, t('mtg.file.' + f.kind)),
      run ? h('button', { type: 'button', class: 'btn btn-icon', title: t('common.delete'), 'aria-label': t('common.delete') + ': ' + f.name, onclick: () => simpleDelete(t('mtg.file_delete_q', { name: f.name }), '/committees/' + c.id + '/files/' + f.id, t('mtg.file_deleted')) }, icon('trash')) : null,
    );
  const files = h(
    'section',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('mtg.files_title'))), run ? h('button', { type: 'button', class: 'btn', onclick: () => fileDialog(c) }, icon('plus'), t('mtg.file_add')) : null),
    d.files.length ? h('div', { class: 'mtg-files' }, d.files.map(fileTile)) : h('p', { class: 'empty' }, t('mtg.files_empty')),
  );

  // Sessions.
  const sessionRow = (s) =>
    h(
      'tr',
      {},
      h('td', { class: 'nowrap' }, ltr(s.code), s.kind === 'extraordinary' ? h('div', { class: 'small muted' }, t('mtg.extraordinary')) : null),
      h('td', { class: 'nowrap' }, when(s), s.original_date && s.original_date !== s.date ? h('div', { class: 'small muted' }, t('mtg.was', { d: fmtDate(s.original_date) })) : null),
      h('td', {}, s.venue || h('span', { class: 'muted' }, '-')),
      h('td', {}, statusChip(s), s.reason && s.status !== 'held' ? h('div', { class: 'small muted' }, s.reason) : null),
      h('td', { class: 'small' }, s.invited_at ? t('mtg.invited') : h('span', { class: 'muted' }, t('mtg.not_invited'))),
      h(
        'td',
        {},
        h(
          'div',
          { class: 'row-actions' },
          !s.date_tbd && s.status !== 'cancelled' ? h('a', { class: 'btn btn-icon', href: '/api/committee-sessions/' + s.id + '/ics', title: t('mtg.ics'), 'aria-label': t('mtg.ics') + ': ' + s.code }, icon('download')) : null,
          run ? sessionMenu(c, s, d.today) : null,
        ),
      ),
    );
  const sessionsTable = (list, empty) =>
    list.length
      ? h('div', { class: 'table-scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['mtg.session', 'mtg.when', 'mtg.venue', 'mtg.status', 'mtg.invitation', 'common.actions'].map((x) => h('th', { scope: 'col' }, t(x))))), h('tbody', {}, list.map(sessionRow))))
      : h('p', { class: 'empty' }, t(empty));
  const sessions = h(
    'section',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('mtg.sessions_title'))), run && c.active ? h('button', { type: 'button', class: 'btn', onclick: () => extraDialog(c) }, icon('plus'), t(c.kind === 'special' ? 'mtg.session_add' : 'mtg.extra_add')) : null),
    sessionsTable(upcoming.slice(0, 24), 'mtg.sessions_empty'),
    past.length ? h('details', { class: 'mtg-past' }, h('summary', {}, t('mtg.past_n', { n: past.length })), sessionsTable(past, 'mtg.sessions_empty')) : null,
  );

  root.replaceChildren(
    ...[h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        link('meetings/committees', { class: 'back-link' }, t('nav.committees')),
        h('h1', {}, name(c), c.urgent ? [' ', h('span', { class: 'chip chip-expired' }, t('mtg.urgent'))] : null),
        h('p', { class: 'muted' }, t('mtg.kinds.' + c.kind) + (c.active ? '' : ' · ' + t('mtg.off'))),
      ),
      run
        ? h(
            'div',
            { class: 'actions' },
            h('button', { type: 'button', class: 'btn', onclick: () => committeeDialog(c, c.kind, { departments: S.mtgDepts || [], can_create: d.can_manage }) }, icon('edit'), t('common.edit')),
            d.can_manage ? h('button', { type: 'button', class: 'btn btn-icon', title: t('common.delete'), 'aria-label': t('common.delete'), onclick: () => simpleDelete(t('mtg.delete_q', { name: name(c) }), '/committees/' + c.id, t('mtg.deleted'), () => navigate('meetings/committees')) }, icon('trash')) : null,
          )
        : null,
    ),
    activeMembers.length && !activeMembers.some((m) => m.role === 'chair') ? h('p', { class: 'notice notice-warn' }, t('mtg.no_chair')) : null,
    info,
    members,
    sessions,
    files,
    ].filter(Boolean),
  );
}

function sessionMenu(c, s, today) {
  const open = ['scheduled', 'rescheduled', 'postponed'].includes(s.status);
  const items = [];
  if (open && !s.date_tbd && s.date >= today) items.push(['invite', 'mtg.act.invite']);
  if (open) items.push(['reschedule', 'mtg.act.reschedule'], ['postpone', 'mtg.act.postpone'], ['cancel', 'mtg.act.cancel']);
  if (open && !s.date_tbd && s.date <= today) items.push(['held', 'mtg.act.held']);
  if ((s.status === 'cancelled' && s.date >= today) || s.status === 'held') items.push(['restore', 'mtg.act.restore']);
  if (!items.length) return null;
  const sel = select([['', t('mtg.act.pick')], ...items.map(([k, l]) => [k, t(l)])], '', { 'aria-label': t('common.actions') + ': ' + s.code, class: 'mtg-act' });
  sel.addEventListener('change', () => {
    const a = sel.value;
    sel.value = '';
    if (a) sessionDialog(c, s, a);
  });
  return sel;
}

function sessionDialog(c, s, action) {
  if (action === 'invite') {
    api('/committees/' + c.id + '/sessions/' + s.id + '/invite', { method: 'POST' })
      .then((r) => {
        toast(r.notified ? t('mtg.invite_sent') : t('mtg.invite_failed'), !r.notified);
        render();
      })
      .catch((e) => toast(errText(e), true));
    return;
  }
  const needDate = action === 'reschedule' || action === 'postpone';
  const date = input({ type: 'date', required: action === 'reschedule', value: action === 'reschedule' ? s.date : '' });
  const time = input({ type: 'time', value: s.start_time });
  const venue = input({ type: 'text', maxlength: 200, value: s.venue || '' });
  const reason = h('textarea', { rows: 3, maxlength: 500, required: action !== 'held' && action !== 'restore' });
  openDialog({
    title: t('mtg.act.' + action) + ': ' + s.code,
    danger: action === 'cancel',
    body: h(
      'div',
      { class: 'stack' },
      h('p', { class: 'muted' }, when(s)),
      needDate ? h('div', { class: 'form-grid' }, field(t(action === 'postpone' ? 'mtg.new_date_opt' : 'mtg.new_date'), date, action === 'postpone' ? t('mtg.postpone_hint') : null), field(t('mtg.time'), time)) : null,
      needDate ? field(t('mtg.venue'), venue) : null,
      action === 'held' || action === 'restore' ? h('p', {}, t('mtg.confirm_' + action)) : field(t('mtg.reason'), reason, t('mtg.reason_hint')),
    ),
    onSubmit: async () => {
      const r = await api('/committee-sessions/' + s.id, { method: 'PUT', body: { action, date: date.value || null, start_time: time.value, venue: venue.value, reason: reason.value } });
      toast(t('mtg.session_saved') + (r.notified === true ? ' · ' + t('mtg.members_told') : r.notified === false ? ' · ' + t('mtg.invite_failed') : ''), r.notified === false);
      render();
    },
  });
}

function extraDialog(c) {
  const date = input({ type: 'date', required: true });
  const time = input({ type: 'time', required: true, value: c.start_time });
  const venue = input({ type: 'text', maxlength: 200, value: c.venue || '' });
  const reason = h('textarea', { rows: 2, maxlength: 500 });
  openDialog({
    title: t(c.kind === 'special' ? 'mtg.session_add' : 'mtg.extra_add'),
    body: h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, field(t('mtg.date'), date), field(t('mtg.time'), time)), field(t('mtg.venue'), venue), field(t('mtg.extra_reason'), reason), h('p', { class: 'hint' }, t('mtg.extra_hint'))),
    onSubmit: async () => {
      const r = await api('/committees/' + c.id + '/sessions', { method: 'POST', body: { date: date.value, start_time: time.value, venue: venue.value, reason: reason.value } });
      toast(t('mtg.session_saved') + (r.notified ? ' · ' + t('mtg.members_told') : ''));
      render();
    },
  });
}

// A member: found by employee number (Arabic digits work too) or typed in.
function memberDialog(c, m) {
  const find = input({ type: 'search', placeholder: t('mtg.find_ph'), 'aria-label': t('mtg.find'), autocomplete: 'off' });
  const found = h('div', { class: 'mtg-found', role: 'listbox', 'aria-label': t('mtg.find') });
  const empNo = input({ type: 'text', maxlength: 30, dir: 'ltr', value: m ? m.emp_no || '' : '' });
  const nm = input({ type: 'text', required: true, maxlength: 120, value: m ? m.name : '' });
  const nmEn = input({ type: 'text', maxlength: 120, dir: 'ltr', value: m ? m.name_en || '' : '' });
  const email = input({ type: 'email', maxlength: 160, dir: 'ltr', value: m ? m.email || '' : '' });
  const position = input({ type: 'text', maxlength: 120, value: m ? m.position || '' : '' });
  const role = select(ROLES.map((r) => [r, t('mtg.role.' + r)]), m ? m.role : 'member', {});
  const subName = input({ type: 'text', maxlength: 120, value: m ? m.substitute_name || '' : '' });
  const subEmail = input({ type: 'email', maxlength: 160, dir: 'ltr', value: m ? m.substitute_email || '' : '' });
  const active = input({ type: 'checkbox', checked: m ? !!m.active : true });
  const reason = input({ type: 'text', maxlength: 300, value: m ? m.inactive_reason || '' : '' });
  const reasonField = field(t('mtg.inactive_reason'), reason, t('mtg.inactive_hint'));
  const sync = () => {
    reasonField.hidden = active.checked;
    reason.required = !active.checked;
  };
  active.addEventListener('change', sync);
  sync();
  let timer;
  find.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = find.value.trim();
      if (!q) return found.replaceChildren();
      try {
        const r = await api('/committees/staff?q=' + encodeURIComponent(q));
        found.replaceChildren(
          ...(r.staff.length
            ? r.staff.map((p) =>
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'mtg-found-item',
                    onclick: () => {
                      empNo.value = p.emp_no;
                      nm.value = p.name;
                      nmEn.value = p.name_en || '';
                      found.replaceChildren();
                      find.value = '';
                      email.focus();
                    },
                  },
                  h('span', { class: 'mono' }, p.emp_no),
                  ' ',
                  h('b', {}, pick(p.name, p.name_en)),
                  p.dept_ar ? h('span', { class: 'small muted' }, ' · ' + pick(p.dept_ar, p.dept_en)) : null,
                ),
              )
            : [h('p', { class: 'small muted' }, t('mtg.find_none'))]),
        );
      } catch (e) {
        found.replaceChildren(h('p', { class: 'small form-error' }, errText(e)));
      }
    }, 250);
  });
  openDialog({
    title: t(m ? 'mtg.member_edit' : 'mtg.member_add'),
    body: h(
      'div',
      { class: 'stack' },
      m ? null : field(t('mtg.find'), find, t('mtg.find_hint')),
      m ? null : found,
      h('div', { class: 'form-grid' }, field(t('mtg.emp_no'), empNo), field(t('mtg.member_role'), role)),
      h('div', { class: 'form-grid' }, field(t('user.name_ar'), nm), field(t('user.name_en'), nmEn)),
      h('div', { class: 'form-grid' }, field(t('user.email'), email, t('mtg.email_hint')), field(t('mtg.position'), position)),
      h('fieldset', { class: 'app-roles' }, h('legend', {}, t('mtg.substitute')), h('div', { class: 'form-grid' }, field(t('mtg.substitute_name'), subName), field(t('mtg.substitute_email'), subEmail))),
      m ? checkField(t('mtg.member_active'), active) : null,
      m ? reasonField : null,
    ),
    onSubmit: async () => {
      const body = { emp_no: arabicDigits(empNo.value), name: nm.value, name_en: nmEn.value, email: email.value, position: position.value, role: role.value, substitute_name: subName.value, substitute_email: subEmail.value, active: active.checked, inactive_reason: reason.value };
      await api('/committees/' + c.id + '/members' + (m ? '/' + m.id : ''), { method: m ? 'PUT' : 'POST', body });
      toast(t('mtg.member_saved'));
      render();
    },
  });
}

// A department's meeting: its staff are offered as members.
async function suggestDialog(c, members) {
  let r;
  try {
    r = await api('/committees/staff?department_id=' + c.department_id);
  } catch (e) {
    toast(errText(e), true);
    return;
  }
  const have = new Set(members.filter((m) => m.active).map((m) => m.emp_no));
  const list = r.staff.filter((p) => !have.has(p.emp_no));
  const boxes = list.map((p) => ({ p, box: input({ type: 'checkbox', checked: true }) }));
  openDialog({
    title: t('mtg.suggest'),
    submitLabel: t('mtg.suggest_add'),
    body: list.length ? h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('mtg.suggest_help')), h('div', { class: 'mtg-suggest' }, boxes.map(({ p, box }) => checkField(p.emp_no + ' · ' + pick(p.name, p.name_en), box)))) : h('p', { class: 'empty' }, t('mtg.suggest_none')),
    onSubmit: async () => {
      let n = 0;
      for (const { p, box } of boxes) {
        if (!box.checked) continue;
        await api('/committees/' + c.id + '/members', { method: 'POST', body: { emp_no: p.emp_no, name: p.name, name_en: p.name_en, role: 'member' } });
        n++;
      }
      toast(t('mtg.suggest_done', { n }));
      render();
    },
  });
}

function fileDialog(c) {
  const file = input({ type: 'file', required: true, accept: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg' });
  const nm = input({ type: 'text', maxlength: 160 });
  const kind = select(['tor', 'reference'].map((k) => [k, t('mtg.file.' + k)]), 'tor', {});
  openDialog({
    title: t('mtg.file_add'),
    body: h('div', { class: 'stack' }, field(t('mtg.file_kind'), kind), field(t('mtg.file'), file, t('mtg.file_hint')), field(t('mtg.file_name'), nm, t('mtg.file_name_hint'))),
    onSubmit: async () => {
      const fd = new FormData();
      fd.set('kind', kind.value);
      fd.set('name', nm.value);
      fd.set('file', file.files[0]);
      await api('/committees/' + c.id + '/files', { method: 'POST', form: fd });
      toast(t('mtg.file_saved'));
      render();
    },
  });
}

/* -------------------------------- the calendar ------------------------------ */

// meetings/calendar/2026-11: a month of sessions, every committee.
export async function calendarPage(root, param, alive) {
  const now = new Date();
  const ym = /^\d{4}-\d{2}$/.test(String(param || '')) ? param : now.toISOString().slice(0, 7);
  const first = ym + '-01';
  const startDow = new Date(first + 'T00:00:00Z').getUTCDay();
  const gridStart = addDays(first, -startDow);
  const gridEnd = addDays(gridStart, 41);
  let d;
  try {
    d = await api('/committees/calendar?from=' + gridStart + '&to=' + gridEnd);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const byDay = {};
  for (const s of d.sessions) (byDay[s.date] = byDay[s.date] || []).push(s);
  const month = new Intl.DateTimeFormat(S.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(first + 'T00:00:00Z'));
  const shift = (n) => {
    const dt = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1));
    return dt.toISOString().slice(0, 7);
  };
  const dayNames = [...Array(7)].map((_, i) => new Intl.DateTimeFormat(S.lang === 'ar' ? 'ar' : 'en-GB', { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 10, 1 + i))));
  const cells = [...Array(42)].map((_, i) => {
    const day = addDays(gridStart, i);
    const list = byDay[day] || [];
    return h(
      'div',
      { class: 'mtg-day' + (day.slice(0, 7) !== ym ? ' is-out' : '') + (day === d.today ? ' is-today' : ''), role: 'gridcell', 'aria-label': fmtDate(day) },
      h('span', { class: 'mtg-day-n' }, String(Number(day.slice(8)))),
      list.map((s) =>
        link(
          'meetings/committees/' + s.committee_id,
          { class: 'mtg-ev mtg-ev-' + s.kind + ' is-' + s.status, title: name(s) + ' · ' + s.start_time + ' · ' + t('mtg.st.' + s.status) },
          h('span', { class: 'mtg-ev-time', dir: 'ltr' }, s.start_time),
          h('span', { class: 'mtg-ev-name' }, name(s)),
        ),
      ),
    );
  });
  const list = d.sessions.filter((s) => s.date.slice(0, 7) === ym);
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.calendar')), h('p', { class: 'muted' }, t('mtg.cal_sub'))),
      h('div', { class: 'actions mtg-cal-nav' }, link('meetings/calendar/' + shift(-1), { class: 'btn', 'aria-label': t('mtg.prev_month') }, t('mtg.prev_month')), link('meetings/calendar', { class: 'btn' }, t('mtg.this_month')), link('meetings/calendar/' + shift(1), { class: 'btn', 'aria-label': t('mtg.next_month') }, t('mtg.next_month'))),
    ),
    h(
      'section',
      { class: 'panel mtg-cal' },
      h('h2', { class: 'mtg-cal-title' }, month),
      h('div', { class: 'mtg-legend' }, KINDS.map((k) => h('span', { class: 'mtg-key mtg-ev-' + k }, t('mtg.kinds.' + k)))),
      h('div', { class: 'mtg-grid', role: 'grid' }, dayNames.map((n) => h('div', { class: 'mtg-dow', role: 'columnheader' }, n)), cells),
    ),
    // The same sessions as a list: easier to read on a phone.
    h(
      'section',
      { class: 'panel mtg-cal-list' },
      h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('mtg.month_list')))),
      list.length
        ? h('ul', { class: 'home-list' }, list.map((s) => h('li', {}, link('meetings/committees/' + s.committee_id, { class: 'home-item' }, h('span', { class: 'home-item-text' }, h('b', {}, name(s)), h('small', { class: 'muted' }, when(s) + (s.venue ? ' · ' + s.venue : ''))), statusChip(s)))))
        : h('p', { class: 'empty' }, t('mtg.month_empty')),
    ),
  );
}
