// Committees & meetings: the committees master (hospital committees, departmental meetings, special
// meetings), one committee's page (details, members, papers, sessions) and the calendar of every session.
import { render } from '../app.js';
import { kpiRow } from './assets.js';
import { ApiError, S, h, icon, t } from './core.js';
import { link, navigate } from './layout.js';
import { api, checkField, errText, errorBox, field, fmtDate, input, loading, openDialog, select, toast } from './offline.js';
import { pick, printQr, publicShell, simpleDelete } from './tickets.js';

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
  if (/^s\d+$/.test(String(param || ''))) return minutesPage(root, Number(param.slice(1)), alive);
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
      h('div', { class: 'form-grid' }, special ? null : field(t('mtg.frequency'), freq, t('mtg.freq_hint')), field(t(special ? 'mtg.date' : 'mtg.first_date'), first)),
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

  // Members: one compact card each, so a long list stays easy to read.
  const memberCard = (m) =>
    h(
      'article',
      { class: 'mtg-member' + (m.active ? '' : ' is-off') },
      h(
        'div',
        { class: 'mtg-member-head' },
        h('div', { class: 'mtg-member-name' }, h('span', { class: 'strong' }, pick(m.name, m.name_en)), m.emp_no ? h('span', { class: 'small muted' }, ltr(m.emp_no)) : null),
        h('span', { class: 'chip ' + (m.role === 'chair' ? 'chip-progress' : 'chip-review') }, t('mtg.role.' + m.role)),
      ),
      m.position ? h('div', { class: 'small muted' }, m.position) : null,
      h(
        'div',
        { class: 'mtg-member-contact small' },
        m.phone ? h('a', { href: 'tel:' + m.phone.replace(/[^\d+]/g, ''), dir: 'ltr' }, icon('phone', 14), m.phone) : null,
        m.email ? h('bdi', { dir: 'ltr' }, m.email) : h('span', { class: 'chip chip-expired' }, t('mtg.no_email')),
      ),
      m.active && m.substitute_name ? h('div', { class: 'small muted' }, t('mtg.substitute_is', { name: m.substitute_name })) : null,
      m.active ? null : h('div', { class: 'small muted' }, t('mtg.inactive_since', { reason: m.inactive_reason || '' })),
      h(
        'div',
        { class: 'mtg-member-foot' },
        attCell(m.attendance),
        run
          ? h(
              'div',
              { class: 'row-actions' },
              h('button', { type: 'button', class: 'btn btn-icon', title: t('common.edit'), 'aria-label': t('common.edit') + ': ' + m.name, onclick: () => memberDialog(c, m) }, icon('edit')),
              h('button', { type: 'button', class: 'btn btn-icon', title: t('common.delete'), 'aria-label': t('common.delete') + ': ' + m.name, onclick: () => simpleDelete(t('mtg.member_delete_q', { name: m.name }), '/committees/' + c.id + '/members/' + m.id, t('mtg.member_deleted')) }, icon('trash')),
            )
          : null,
      ),
    );
  const offMembers = d.members.filter((m) => !m.active);
  const memberGrid = h('div', { class: 'mtg-members' });
  const memberFind = input({ type: 'search', placeholder: t('mtg.member_search'), 'aria-label': t('mtg.member_search'), autocomplete: 'off' });
  const drawMembers = () => {
    const q = memberFind.value.trim().toLowerCase();
    const list = activeMembers.filter((m) => !q || [m.name, m.name_en, m.emp_no, m.position, m.email, m.phone].some((v) => v && String(v).toLowerCase().includes(q)));
    memberGrid.replaceChildren(...(list.length ? list.map(memberCard) : [h('p', { class: 'empty' }, t('mtg.members_empty'))]));
  };
  memberFind.addEventListener('input', drawMembers);
  drawMembers();
  const members = h(
    'section',
    { class: 'panel' },
    h(
      'div',
      { class: 'panel-head' },
      h('div', { class: 'panel-title' }, h('h2', {}, t('mtg.members_title')), h('span', { class: 'muted small' }, t('mtg.members_n', { n: activeMembers.length }))),
      run ? h('div', { class: 'actions' }, c.kind === 'department' && c.department_id ? h('button', { type: 'button', class: 'btn', onclick: () => suggestDialog(c, d.members) }, icon('users'), t('mtg.suggest')) : null, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => memberDialog(c, null) }, icon('plus'), t('mtg.member_add'))) : null,
    ),
    activeMembers.length > 8 ? h('div', { class: 'mtg-member-filter' }, h('div', { class: 'doc-search', role: 'search' }, icon('search'), memberFind)) : null,
    d.members.length ? memberGrid : h('p', { class: 'empty' }, t('mtg.members_empty')),
    offMembers.length ? h('details', { class: 'mtg-past' }, h('summary', {}, t('mtg.inactive_n', { n: offMembers.length })), h('div', { class: 'mtg-members' }, offMembers.map(memberCard))) : null,
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

  // Sessions: one row each that wraps on a tablet or phone, so nothing scrolls sideways.
  const sessionRow = (s) =>
    h(
      'div',
      { class: 'mtg-sess', role: 'listitem' },
      h(
        'div',
        { class: 'mtg-sess-when' },
        h('div', { class: 'strong' }, when(s)),
        h(
          'div',
          { class: 'small muted' },
          ltr(s.code),
          s.kind === 'extraordinary' ? ' · ' + t('mtg.extraordinary') : '',
          s.venue && s.venue !== c.venue ? ' · ' + s.venue : '',
          s.original_date && s.original_date !== s.date ? ' · ' + t('mtg.was', { d: fmtDate(s.original_date) }) : '',
        ),
      ),
      h(
        'div',
        { class: 'mtg-sess-state' },
        statusChip(s),
        s.reason && s.status !== 'held' ? h('div', { class: 'small muted' }, s.reason) : null,
        s.status !== 'held' && s.status !== 'cancelled' ? h('div', { class: 'small ' + (s.invited_at ? '' : 'muted') }, s.invited_at ? t('mtg.invited') : t('mtg.not_invited')) : null,
      ),
      h(
        'div',
        { class: 'mtg-sess-acts' },
        s.minutes_status || (run && s.status !== 'cancelled' && !s.date_tbd && s.date <= d.today) ? link('meetings/committees/s' + s.id, { class: 'btn btn-small' }, icon('file'), t('mtg.minutes'), s.minutes_status ? [' ', minutesChip(s.minutes_status)] : null) : null,
        run && !s.date_tbd && s.status !== 'cancelled' && s.date >= d.today && s.minutes_status !== 'approved' ? h('button', { type: 'button', class: 'btn btn-small', title: t('mtg.checkin_qr'), 'aria-label': t('mtg.checkin_qr') + ': ' + s.code, onclick: () => showCheckinQr(c, s) }, 'QR') : null,
        !s.date_tbd && s.status !== 'cancelled' ? h('a', { class: 'btn btn-icon', href: '/api/committee-sessions/' + s.id + '/ics', title: t('mtg.ics'), 'aria-label': t('mtg.ics') + ': ' + s.code }, icon('download')) : null,
        run ? sessionMenu(c, s, d.today) : null,
      ),
    );
  const sessionList = (list, empty) => (list.length ? h('div', { class: 'mtg-sessions', role: 'list' }, list.map(sessionRow)) : h('p', { class: 'empty' }, t(empty)));
  const SHOWN = 6;
  const later = upcoming.slice(SHOWN, 24);
  const sessions = h(
    'section',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('mtg.sessions_title'))), run && c.active ? h('button', { type: 'button', class: 'btn', onclick: () => extraDialog(c) }, icon('plus'), t(c.kind === 'special' ? 'mtg.session_add' : 'mtg.extra_add')) : null),
    sessionList(upcoming.slice(0, SHOWN), 'mtg.sessions_empty'),
    later.length ? h('details', { class: 'mtg-past' }, h('summary', {}, t('mtg.later_n', { n: later.length })), sessionList(later, 'mtg.sessions_empty')) : null,
    past.length ? h('details', { class: 'mtg-past' }, h('summary', {}, t('mtg.past_n', { n: past.length })), sessionList(past, 'mtg.sessions_empty')) : null,
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

const MINUTES_CHIP = { draft: 'chip-review', pending: 'chip-near', approved: 'chip-valid' };
const minutesChip = (st) => h('span', { class: 'chip ' + MINUTES_CHIP[st] }, t('mtg.ms.' + st));
const ATT = ['present', 'late', 'absent', 'excused'];
// A member's attendance over the held sessions: the share present (late counts as present).
function attCell(a) {
  if (!a || !a.n) return h('span', { class: 'muted' }, '-');
  return h('span', { class: 'chip ' + (a.pct >= 75 ? 'chip-valid' : a.pct >= 50 ? 'chip-near' : 'chip-expired'), title: t('mtg.att_detail', { p: a.present, n: a.n, a: a.absent, e: a.excused }) }, ltr(a.pct + '%'), ' ', h('span', { class: 'small' }, ltr(a.present + '/' + a.n)));
}

// The minutes of one session: attendance, then one line per subject with its action, owner, date and state.
async function minutesPage(root, sid, alive) {
  let d;
  try {
    d = await api('/committee-sessions/' + sid + '/minutes');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const c = d.committee;
  const s = d.session;
  const edit = d.can_edit;
  const ro = (v) => (v ? h('span', {}, v) : h('span', { class: 'muted' }, '-'));

  // Attendance.
  const marked = Object.fromEntries(d.attendance.map((a) => [a.member_id, a]));
  const attRows = d.members.map((m) => {
    const cur = marked[m.id];
    // Over and not checked in: absent, unless the secretary changes it.
    const auto = !cur && d.ended && m.active && edit ? 'absent' : '';
    const sel = select([['', '-'], ...ATT.map((a) => [a, t('mtg.att.' + a)])], cur ? cur.status : auto, { disabled: !edit, 'aria-label': t('mtg.attendance') + ': ' + m.name });
    const note = input({ type: 'text', maxlength: 200, value: cur ? cur.note || '' : '', disabled: !edit, 'aria-label': t('mtg.notes') + ': ' + m.name });
    return { m, sel, note };
  });
  const count = h('span', { class: 'muted small' });
  const recount = () => {
    const n = attRows.filter((r) => r.sel.value === 'present' || r.sel.value === 'late').length;
    count.textContent = t('mtg.att_count', { n, of: attRows.filter((r) => r.m.active && r.m.role !== 'invitee').length });
  };
  attRows.forEach((r) => r.sel.addEventListener('change', recount));
  recount();
  const allPresent = edit ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => (attRows.forEach((r) => !r.sel.value && (r.sel.value = 'present')), recount()) }, t('mtg.att_all')) : null;
  const attPanel = h(
    'section',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('mtg.attendance')), count), allPresent),
    h(
      'div',
      { class: 'table-scroll' },
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, ['mtg.member', 'mtg.member_role', 'mtg.attendance', 'mtg.notes'].map((x) => h('th', { scope: 'col' }, t(x))))),
        h('tbody', {}, attRows.map((r) => h('tr', {}, h('td', {}, h('div', { class: 'strong' }, pick(r.m.name, r.m.name_en)), r.m.position ? h('div', { class: 'small muted' }, r.m.position) : null), h('td', {}, t('mtg.role.' + r.m.role)), h('td', {}, r.sel, marked[r.m.id] && marked[r.m.id].method ? h('div', { class: 'small muted' }, t('mtg.via.' + marked[r.m.id].method), ' ', ltr(new Date(marked[r.m.id].checked_at).toLocaleTimeString(S.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit' }))) : null), h('td', {}, r.note)))),
      ),
    ),
  );

  // Lines of the minutes.
  const list = h('div', { class: 'stack mtg-items' });
  const rows = [];
  const addRow = (i) => {
    const subject = input({ type: 'text', maxlength: 300, value: i.subject || '', disabled: !edit, 'aria-label': t('mtg.subject') });
    const discussion = h('textarea', { rows: 2, maxlength: 4000, disabled: !edit, 'aria-label': t('mtg.discussion') }, i.discussion || '');
    const action = h('textarea', { rows: 2, maxlength: 1000, disabled: !edit, 'aria-label': t('mtg.action') }, i.action || '');
    const resp = input({ type: 'text', maxlength: 200, value: i.responsibility || '', disabled: !edit });
    const target = input({ type: 'date', value: i.target_date || '', disabled: !edit });
    const status = select([['open', t('mtg.item.open')], ['closed', t('mtg.item.closed')]], i.status || 'open', { disabled: !edit });
    const row = { i, subject, discussion, action, resp, target, status };
    const el = h(
      'fieldset',
      { class: 'app-roles mtg-item' },
      h('legend', {}, String(rows.length + 1), i.carried_from ? [' ', h('span', { class: 'tag' }, t('mtg.carried'))] : null),
      field(t('mtg.subject'), subject),
      field(t('mtg.discussion'), discussion),
      field(t('mtg.action'), action),
      h('div', { class: 'form-grid' }, field(t('mtg.responsibility'), resp), field(t('mtg.target'), target), field(t('mtg.status'), status)),
      edit ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => (rows.splice(rows.indexOf(row), 1), el.remove()) }, icon('trash'), t('common.delete')) : null,
    );
    row.el = el;
    rows.push(row);
    list.append(el);
  };
  const start = d.items.length ? d.items : d.carry.length ? [{ subject: t('mtg.call_to_order') }, ...d.carry] : edit ? [{ subject: t('mtg.call_to_order') }] : [];
  start.forEach(addRow);
  const itemsPanel = h(
    'section',
    { class: 'panel pad' },
    h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('mtg.minutes')))),
    list,
    !start.length && !edit ? h('p', { class: 'empty' }, t('mtg.minutes_empty')) : null,
    edit ? h('button', { type: 'button', class: 'btn', onclick: () => addRow({}) }, icon('plus'), t('mtg.item_add')) : null,
  );

  const started = input({ type: 'time', value: s.time_started || s.start_time, disabled: !edit });
  const save = async (submit) => {
    try {
      await api('/committee-sessions/' + s.id + '/minutes', {
        method: 'PUT',
        body: {
          submit,
          time_started: started.value,
          attendance: attRows.filter((r) => r.sel.value).map((r) => ({ member_id: r.m.id, status: r.sel.value, note: r.note.value })),
          items: rows.map((r) => ({ subject: r.subject.value, discussion: r.discussion.value, action: r.action.value, responsibility: r.resp.value, target_date: r.target.value || null, status: r.status.value, carried_from: r.i.carried_from || null })),
        },
      });
      toast(t(submit ? 'mtg.ms_sent' : 'mtg.ms_saved'));
      render();
    } catch (e) {
      toast(errText(e), true);
    }
  };
  const act = (path, msg) => api('/committee-sessions/' + s.id + '/minutes/' + path, { method: 'POST' }).then(() => (toast(t(msg)), render())).catch((e) => toast(errText(e), true));

  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        link('meetings/committees/' + c.id, { class: 'back-link' }, name(c)),
        h('h1', {}, t('mtg.minutes'), ' ', ltr(s.code)),
        h('p', { class: 'muted' }, when(s), s.venue ? ' · ' + s.venue : '', ' ', minutesChip(s.minutes_status)),
        s.approved_by ? h('p', { class: 'small muted' }, t('mtg.ms_approved_by', { name: s.approved_by, d: fmtDate(s.approved_at.slice(0, 10)) })) : null,
      ),
      h(
        'div',
        { class: 'actions' },
        edit ? h('button', { type: 'button', class: 'btn', onclick: () => save(false) }, t('mtg.ms_save')) : null,
        edit ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => save(true) }, t('mtg.ms_send')) : null,
        d.can_approve ? h('button', { type: 'button', class: 'btn', onclick: () => act('return', 'mtg.ms_returned') }, t('mtg.ms_return')) : null,
        d.can_approve ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => act('approve', 'mtg.ms_approved') }, t('mtg.ms_approve')) : null,
        d.can_reopen ? h('button', { type: 'button', class: 'btn', onclick: () => act('reopen', 'mtg.ms_reopened') }, t('mtg.ms_reopen')) : null,
      ),
    ),
    h('section', { class: 'panel pad' }, h('div', { class: 'form-grid' }, field(t('mtg.time_started'), started))),
    attPanel,
    itemsPanel,
  );
}

// The session's QR code, to show on the screen or print for the room. Members scan it and give their number.
async function showCheckinQr(c, s) {
  try {
    const r = await api('/committee-sessions/' + s.id + '/checkin');
    await printQr([{ url: location.origin + '/#/checkin/' + r.code, title: name(c) + ' · ' + s.code, heading: t('mtg.checkin_scan') }]);
  } catch (e) {
    toast(errText(e), true);
  }
}

// The page a member opens from their emailed link or the session's QR code. No account needed.
export async function checkinPage(code) {
  let d;
  try {
    d = await api('/checkin/' + code);
  } catch (e) {
    return publicShell(h('h1', {}, t('mtg.checkin')), errorBox(e));
  }
  const head = [h('h1', {}, t('mtg.checkin')), h('p', { class: 'strong' }, pick(d.committee.name_ar, d.committee.name_en)), h('p', { class: 'muted' }, when({ ...d.session, date_tbd: 0 }), d.session.venue ? ' · ' + d.session.venue : '')];
  const box = h('div', { class: 'stack' });
  const done = (r) => box.replaceChildren(h('p', { class: 'notice notice-ok' }, t(r.again ? 'mtg.checkin_again' : 'mtg.checkin_done', { name: pick(r.name, r.name_en), st: t('mtg.att.' + r.status) })));
  const send = async (body, btn) => {
    btn.disabled = true;
    try {
      done(await api('/checkin/' + code, { method: 'POST', body }));
    } catch (e) {
      btn.disabled = false;
      toast(errText(e), true);
    }
  };
  if (d.marked) done({ name: d.member.name, name_en: d.member.name_en, status: d.marked, again: true });
  else if (d.phase === 'before' || d.phase === 'closed') box.append(h('p', { class: 'notice notice-warn' }, t('mtg.checkin_' + d.phase)));
  else if (d.qr) {
    const who = input({ type: 'text', required: true, dir: 'ltr', maxlength: 200, autocomplete: 'off', placeholder: t('mtg.checkin_who_ph') });
    const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, t('mtg.checkin_btn'));
    box.append(h('form', { class: 'stack', onsubmit: (e) => (e.preventDefault(), send({ who: who.value }, btn)) }, field(t('mtg.checkin_who'), who), btn));
  } else {
    const btn = h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: () => send({}, btn) }, t('mtg.checkin_btn'));
    box.append(h('p', {}, pick(d.member.name, d.member.name_en)), btn);
  }
  return publicShell(...head, box);
}

// Attendance across committees and meetings over a period, to measure compliance.
export async function attendancePage(root, _param, alive) {
  const year = new Date().getFullYear();
  const from = input({ type: 'date', value: year + '-01-01' });
  const to = input({ type: 'date', value: new Date().toISOString().slice(0, 10) });
  const body = h('div', { class: 'stack' }, loading());
  const pctChip = (p) => (p === null || p === undefined ? h('span', { class: 'muted' }, '-') : h('span', { class: 'chip ' + (p >= 75 ? 'chip-valid' : p >= 50 ? 'chip-near' : 'chip-expired') }, ltr(p + '%')));
  const load = async () => {
    body.replaceChildren(loading());
    let d;
    try {
      d = await api('/committees/attendance?from=' + from.value + '&to=' + to.value);
    } catch (e) {
      if (alive()) body.replaceChildren(errorBox(e));
      return;
    }
    if (!alive()) return;
    const rows = d.committees.filter((c) => c.held);
    body.replaceChildren(
      kpiRow([
        ['mtg.rep_committees', d.summary.committees],
        ['mtg.rep_held', d.summary.held],
        ['mtg.rep_pct', d.summary.pct === null ? '-' : d.summary.pct + '%'],
        ['mtg.rep_quorum', d.summary.quorum_pct === null ? '-' : d.summary.quorum_pct + '%'],
      ]),
      h(
        'section',
        { class: 'panel' },
        h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('mtg.rep_by_committee')))),
        rows.length
          ? h(
              'div',
              { class: 'table-scroll' },
              h(
                'table',
                {},
                h('thead', {}, h('tr', {}, ['mtg.code', 'mtg.name', 'mtg.rep_held', 'mtg.rep_pct', 'mtg.rep_quorum_met', 'mtg.att.absent', 'mtg.att.excused'].map((x) => h('th', { scope: 'col' }, t(x))))),
                h(
                  'tbody',
                  {},
                  rows.map((c) =>
                    h(
                      'tr',
                      {},
                      h('td', {}, ltr(c.code)),
                      h('td', {}, link('meetings/committees/' + c.id, {}, name(c)), h('div', { class: 'small muted' }, t('mtg.kinds.' + c.kind))),
                      h('td', {}, ltr(String(c.held))),
                      h('td', {}, pctChip(c.pct)),
                      h('td', {}, c.recorded ? ltr(c.quorum_met + '/' + c.recorded) : h('span', { class: 'muted' }, '-')),
                      h('td', {}, ltr(String(c.absent))),
                      h('td', {}, ltr(String(c.excused))),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty' }, t('mtg.rep_empty')),
      ),
      h(
        'section',
        { class: 'panel' },
        h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('mtg.rep_low')), h('span', { class: 'muted small' }, t('mtg.rep_low_sub')))),
        d.low.length
          ? h(
              'div',
              { class: 'table-scroll' },
              h(
                'table',
                {},
                h('thead', {}, h('tr', {}, ['mtg.member', 'mtg.name', 'mtg.rep_pct', 'mtg.rep_came', 'mtg.att.absent', 'mtg.att.excused'].map((x) => h('th', { scope: 'col' }, t(x))))),
                h(
                  'tbody',
                  {},
                  d.low.map((m) => {
                    const c = d.committees.find((x) => x.id === m.committee_id) || {};
                    return h('tr', {}, h('td', { class: 'strong' }, pick(m.name, m.name_en)), h('td', {}, name(c)), h('td', {}, pctChip(m.pct)), h('td', {}, ltr(m.p + '/' + m.n)), h('td', {}, ltr(String(m.ab))), h('td', {}, ltr(String(m.ex))));
                  }),
                ),
              ),
            )
          : h('p', { class: 'empty' }, t('mtg.rep_low_empty')),
      ),
    );
  };
  from.addEventListener('change', load);
  to.addEventListener('change', load);
  root.replaceChildren(h('div', { class: 'page-head' }, h('h1', {}, t('nav.attendance'))), h('section', { class: 'panel pad' }, h('div', { class: 'form-grid' }, field(t('mtg.rep_from'), from), field(t('mtg.rep_to'), to))), body);
  load();
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

// A member: picked from the staff list (their details come from it) or, for someone outside it, typed in.
function memberDialog(c, m) {
  const find = input({ type: 'search', placeholder: t('mtg.find_ph'), 'aria-label': t('mtg.find'), autocomplete: 'off' });
  const found = h('div', { class: 'mtg-found', role: 'listbox', 'aria-label': t('mtg.find') });
  const card = h('div', { class: 'mtg-picked' });
  const empNo = input({ type: 'text', maxlength: 30, dir: 'ltr', value: m ? m.emp_no || '' : '' });
  const nm = input({ type: 'text', maxlength: 120, value: m ? m.name : '' });
  const nmEn = input({ type: 'text', maxlength: 120, dir: 'ltr', value: m ? m.name_en || '' : '' });
  const email = input({ type: 'email', maxlength: 160, dir: 'ltr', value: m ? m.email || '' : '' });
  const phone = input({ type: 'tel', maxlength: 30, dir: 'ltr', value: m ? m.phone || '' : '' });
  const position = input({ type: 'text', maxlength: 120, value: m ? m.position || '' : '' });
  const role = select(ROLES.map((r) => [r, t('mtg.role.' + r)]), m ? m.role : 'member', {});
  const subName = input({ type: 'text', maxlength: 120, value: m ? m.substitute_name || '' : '' });
  const subEmail = input({ type: 'email', maxlength: 160, dir: 'ltr', value: m ? m.substitute_email || '' : '' });
  const active = input({ type: 'checkbox', checked: m ? !!m.active : true });
  const reason = input({ type: 'text', maxlength: 300, value: m ? m.inactive_reason || '' : '' });
  const reasonField = field(t('mtg.inactive_reason'), reason);
  const manual = h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, field(t('user.name_ar'), nm), field(t('user.name_en'), nmEn)), h('div', { class: 'form-grid' }, field(t('mtg.emp_no'), empNo), field(t('mtg.position'), position)), h('div', { class: 'form-grid' }, field(t('user.email'), email), field(t('mtg.phone'), phone)));
  const findBox = h('div', { class: 'stack' }, field(t('mtg.find'), find), found);
  // picked: the staff member chosen (or this member when they are on the list); null = typed in.
  let picked = m && m.on_staff ? { emp_no: m.emp_no, name: m.name, name_en: m.name_en, email: m.email, job_title: m.position, phone: m.phone } : null;
  let typed = !!m && !picked;
  const draw = () => {
    card.hidden = !picked;
    if (picked)
      card.replaceChildren(
        h('div', { class: 'mtg-member-name' }, h('span', { class: 'strong' }, pick(picked.name, picked.name_en)), ltr(picked.emp_no)),
        picked.job_title ? h('div', { class: 'small muted' }, picked.job_title) : null,
        h('div', { class: 'mtg-member-contact small' }, picked.phone ? h('span', { dir: 'ltr' }, picked.phone) : null, picked.email ? h('bdi', { dir: 'ltr' }, picked.email) : h('span', { class: 'chip chip-expired' }, t('mtg.no_email'))),
        m ? null : h('button', { type: 'button', class: 'btn btn-small', onclick: () => ((picked = null), draw(), find.focus()) }, t('mtg.change')),
      );
    findBox.hidden = !!m || !!picked || typed;
    manual.hidden = !typed;
    nm.required = typed;
  };
  const sync = () => {
    reasonField.hidden = active.checked;
    reason.required = !active.checked;
  };
  active.addEventListener('change', sync);
  sync();
  const outside = h('button', { type: 'button', class: 'btn-link small', onclick: () => ((typed = true), draw(), nm.focus()) }, t('mtg.outside'));
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
                  { type: 'button', class: 'mtg-found-item', onclick: () => ((picked = p), found.replaceChildren(), (find.value = ''), draw(), role.focus()) },
                  h('span', { class: 'mono' }, p.emp_no),
                  ' ',
                  h('b', {}, pick(p.name, p.name_en)),
                  p.job_title || p.dept_ar ? h('span', { class: 'small muted' }, ' · ' + (p.job_title || pick(p.dept_ar, p.dept_en))) : null,
                ),
              )
            : [h('p', { class: 'small muted' }, t('mtg.find_none'))]),
          outside,
        );
      } catch (e) {
        found.replaceChildren(h('p', { class: 'small form-error' }, errText(e)));
      }
    }, 250);
  });
  draw();
  openDialog({
    title: t(m ? 'mtg.member_edit' : 'mtg.member_add'),
    body: h(
      'div',
      { class: 'stack' },
      findBox,
      card,
      manual,
      field(t('mtg.member_role'), role),
      h('fieldset', { class: 'app-roles' }, h('legend', {}, t('mtg.substitute')), h('div', { class: 'form-grid' }, field(t('mtg.substitute_name'), subName), field(t('mtg.substitute_email'), subEmail))),
      m ? checkField(t('mtg.member_active'), active) : null,
      m ? reasonField : null,
    ),
    onSubmit: async () => {
      if (!picked && !typed) throw new ApiError('mtg_pick_member');
      const who = picked ? { emp_no: picked.emp_no, name: picked.name } : { emp_no: arabicDigits(empNo.value), name: nm.value, name_en: nmEn.value, email: email.value, phone: phone.value, position: position.value };
      const body = { ...who, role: role.value, substitute_name: subName.value, substitute_email: subEmail.value, active: active.checked, inactive_reason: reason.value };
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
