// Suppliers and contracts.
import { render } from '../app.js';
import { assetName, assetStatusChip, dueChip, tn } from './assets.js';
import { S, h, icon, t } from './core.js';
import { normText } from './docs.js';
import { access, link, navigate } from './layout.js';
import { api, checkField, dateEl, errText, errorBox, field, fmtDate, input, openDialog, select, toast } from './offline.js';
import { fmtDuration, fromLocalInput, pick, simpleDelete, timeEl, toLocalInput } from './tickets.js';

/* ------------------------ contracts and suppliers ------------------------ */

// Part of Asset Management: suppliers with their papers, contracts with the assets they cover,
// the planned visits, the agreed time to arrive and the penalty for arriving late.
export const VENDOR_DOC_KINDS = ['cr', 'zakat', 'gosi', 'sfda', 'insurance', 'other'];
export const CONTRACT_KINDS = ['comprehensive', 'labor', 'parts', 'warranty', 'service'];
export const vendorName = (v) => pick(v.name_ar || v.vendor_ar, v.name_en || v.vendor_en);
export const contractTitle = (c) => pick(c.title_ar, c.title_en);
export const fmtMoney = (n) => (n === null || n === undefined ? t('common.none') : new Intl.NumberFormat(S.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { maximumFractionDigits: 2 }).format(n) + ' ' + t('con.sar'));
export const fmtHours = (min) => (min === null || min === undefined ? t('common.none') : fmtDuration(min * 60000));
export const STATE_CHIP = { active: 'chip-valid', ending: 'chip-near', expired: 'chip-expired', upcoming: 'chip-progress', renewed: 'chip-review' };
export const contractChip = (c) =>
  h('span', { class: 'cell-stack' }, h('span', { class: 'chip ' + STATE_CHIP[c.state] }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('con.state.' + c.state)), c.state === 'ending' || c.state === 'active' ? h('span', { class: 'note' + (c.state === 'ending' ? ' note-near' : '') }, t('days.left', { n: c.days_left })) : null);
export const period = (c) => h('span', { class: 'nowrap', dir: 'ltr' }, fmtDate(c.start_date) + ' - ' + fmtDate(c.end_date));
export const pdfLink = (href, label) => h('a', { class: 'btn btn-small', href, target: '_blank', rel: 'noopener' }, icon('file'), label || t('con.view_pdf'));
export const fileInput = () => input({ type: 'file', accept: 'application/pdf,.pdf' });
export const lateText = (v) => (!v || !v.due_at ? '' : v.late_min ? t('con.late_by', { d: fmtHours(v.late_min) }) : t('tk.on_time'));

export async function contractsPage(root, param, alive) {
  if (param) return contractDetail(root, param, alive);
  let d;
  try {
    d = await api('/contracts');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const search = input({ type: 'search', class: 'doc-search-input', value: S.conQ || '', placeholder: t('con.search_ph'), 'aria-label': t('con.search'), autocomplete: 'off' });
  const state = select([['', t('con.all_states')], ...['active', 'ending', 'upcoming', 'expired', 'renewed'].map((s) => [s, t('con.state.' + s)])], S.conState || '', { 'aria-label': t('con.state') });
  const box = h('div', {});
  const counts = (s) => d.contracts.filter((c) => c.state === s).length;
  const draw = () => {
    const q = normText(search.value);
    const rows = d.contracts.filter((c) => (!state.value || c.state === state.value) && (!q || normText([c.number, c.title_ar, c.title_en, c.vendor_ar, c.vendor_en].join(' ')).includes(q)));
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
                h('thead', {}, h('tr', {}, ['con.number', 'con.title', 'con.vendor', 'con.kind', 'con.period', 'con.state', 'con.assets', 'con.visits', 'con.value'].map((c) => h('th', { scope: 'col' }, t(c))))),
                h(
                  'tbody',
                  {},
                  rows.map((c) =>
                    h(
                      'tr',
                      { class: 'row-link', onclick: (e) => e.target.closest('a,button') || navigate('assets/contracts/' + c.id) },
                      h('td', {}, link('contracts/' + c.id, { class: 'btn btn-small mono', dir: 'ltr' }, c.number)),
                      h('td', { class: 'strong' }, contractTitle(c), c.has_pdf ? null : h('div', { class: 'muted small' }, t('con.no_pdf'))),
                      h('td', {}, vendorName(c)),
                      h('td', {}, t('con.kind.' + c.kind)),
                      h('td', {}, period(c)),
                      h('td', {}, contractChip(c)),
                      h('td', {}, h('span', { class: 'mono' }, String(c.asset_count))),
                      h('td', {}, c.visits.total ? h('span', { class: 'cell-stack' }, h('span', { class: 'mono', dir: 'ltr' }, c.visits.done + ' / ' + c.visits.total), c.visits.behind && c.state !== 'renewed' && c.state !== 'expired' ? h('span', { class: 'note note-near' }, tn('con.visits_behind', c.visits.behind)) : null) : h('span', { class: 'muted' }, t('common.none'))),
                      h('td', { class: 'nowrap' }, fmtMoney(c.value)),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty' }, d.contracts.length ? t('con.no_match') : t('con.empty')),
      ),
    );
  };
  search.addEventListener('input', () => {
    S.conQ = search.value;
    draw();
  });
  state.addEventListener('change', () => {
    S.conState = state.value;
    draw();
  });
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.contracts')), h('p', { class: 'muted' }, t('con.sub'))),
      h(
        'div',
        { class: 'actions' },
        link('vendors', { class: 'btn' }, icon('users'), t('nav.vendors')),
        d.can_manage ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => (d.vendors.some((v) => v.active) ? contractDialog(null, d.vendors) : toast(t('con.vendor_first'), true)) }, icon('plus'), t('con.add')) : null,
      ),
    ),
    h(
      'div',
      { class: 'panel kpis' },
      ...[
        ['active', 'kpi-valid'],
        ['ending', 'kpi-near'],
        ['expired', 'kpi-expired'],
      ].map(([s, cls]) => h('button', { type: 'button', class: 'kpi kpi-btn ' + cls, onclick: () => { state.value = s; S.conState = s; draw(); } }, h('span', { class: 'kpi-num' }, String(counts(s))), h('span', { class: 'kpi-label' }, t('con.state.' + s)))),
    ),
    d.uncovered.length
      ? h(
          'details',
          { class: 'notice notice-warn' },
          h('summary', { class: 'strong' }, tn('con.uncovered', d.uncovered.length)),
          h('p', { class: 'small' }, t('con.uncovered_hint')),
          h('div', { class: 'con-tags' }, d.uncovered.map((a) => link('register/' + a.id, { class: 'btn btn-small' }, h('span', { class: 'mono', dir: 'ltr' }, a.tag), ' ' + assetName(a)))),
        )
      : '',
    h('div', { class: 'filters' }, h('div', { class: 'doc-search', role: 'search' }, icon('search'), search), state),
    box,
  );
  draw();
}

export function contractDialog(c, vendors, renew) {
  const plusYear = (day) => {
    const x = new Date(day + 'T00:00:00Z');
    x.setUTCFullYear(x.getUTCFullYear() + 1);
    x.setUTCDate(x.getUTCDate() - 1);
    return x.toISOString().slice(0, 10);
  };
  const nextDay = (day) => new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const start0 = renew ? nextDay(c.end_date) : c ? c.start_date : '';
  const vendor = select([['', t('req.pick')], ...vendors.filter((v) => v.active || (c && v.id === c.vendor_id)).map((v) => [v.id, vendorName(v)])], c ? c.vendor_id : '', { required: true, disabled: !!renew });
  const number = input({ type: 'text', required: true, maxlength: 50, dir: 'ltr', value: c && !renew ? c.number : '' });
  const titleAr = input({ type: 'text', required: true, maxlength: 200, dir: 'rtl', value: c ? c.title_ar : '' });
  const titleEn = input({ type: 'text', required: true, maxlength: 200, dir: 'ltr', value: c ? c.title_en : '' });
  const kind = select(CONTRACT_KINDS.map((k) => [k, t('con.kind.' + k)]), c ? c.kind : 'comprehensive', {});
  const start = input({ type: 'date', required: true, value: start0 });
  const end = input({ type: 'date', required: true, value: renew ? plusYear(start0) : c ? c.end_date : '' });
  const n = (v, attrs) => input({ type: 'number', min: 0, step: 'any', dir: 'ltr', value: v ?? '', ...attrs });
  const value = n(c ? c.value : '');
  const hours = n(c ? c.response_hours : '', { max: 720 });
  const visits = n(c ? c.visits_per_year : '', { max: 365, step: 1 });
  const penalty = n(c ? c.penalty_per_hour : '');
  const cap = n(c ? c.penalty_cap_pct : '', { max: 100 });
  const notes = h('textarea', { rows: 2, maxlength: 3000 }, c ? c.notes || '' : '');
  const pdf = fileInput();
  const numOrNull = (el) => (el.value === '' ? null : Number(el.value));
  openDialog({
    title: renew ? t('con.renew') + ': ' + c.number : t(c ? 'con.edit' : 'con.add'),
    body: h(
      'div',
      { class: 'stack' },
      renew ? h('p', { class: 'notice' }, t('con.renew_hint')) : null,
      field(t('con.vendor'), vendor),
      h('div', { class: 'form-grid' }, field(t('con.number'), number), field(t('con.kind'), kind)),
      field(t('con.title_ar'), titleAr),
      field(t('con.title_en'), titleEn),
      h('div', { class: 'form-grid' }, field(t('con.start'), start), field(t('con.end'), end)),
      h('div', { class: 'form-grid' }, field(t('con.value'), value, t('con.sar')), field(t('con.visits_year'), visits, t('con.visits_hint'))),
      h('fieldset', { class: 'api-scope-set' }, h('legend', {}, t('con.sla')), h('p', { class: 'hint' }, t('con.sla_hint')), h('div', { class: 'form-grid' }, field(t('con.response_hours'), hours), field(t('con.penalty_hour'), penalty, t('con.sar'))), field(t('con.penalty_cap'), cap, t('con.penalty_cap_hint'))),
      field(t('con.notes'), notes),
      field(t('con.pdf'), pdf, c && c.has_pdf && !renew ? t('con.pdf_replace') : t('con.pdf_hint')),
    ),
    onSubmit: async () => {
      const body = {
        vendor_id: Number(vendor.value),
        number: number.value,
        title_ar: titleAr.value,
        title_en: titleEn.value,
        kind: kind.value,
        start_date: start.value,
        end_date: end.value,
        value: numOrNull(value),
        response_hours: numOrNull(hours),
        visits_per_year: numOrNull(visits),
        penalty_per_hour: numOrNull(penalty),
        penalty_cap_pct: numOrNull(cap),
        notes: notes.value,
      };
      const r = await api(renew ? '/contracts/' + c.id + '/renew' : c ? '/contracts/' + c.id : '/contracts', { method: renew || !c ? 'POST' : 'PUT', body });
      const cid = renew || !c ? r.id : c.id;
      if (pdf.files[0]) {
        const form = new FormData();
        form.append('pdf', pdf.files[0]);
        try {
          await api('/contracts/' + cid + '/pdf', { method: 'POST', form });
        } catch (e) {
          toast(t('con.saved_no_pdf') + ' ' + errText(e), true);
          navigate('assets/contracts/' + cid);
          return;
        }
      }
      toast(t('tk.saved'));
      if (renew || !c) navigate('assets/contracts/' + cid);
      else render();
    },
  });
}

export async function contractDetail(root, id, alive) {
  let d;
  let vendors;
  try {
    [d, vendors] = await Promise.all([api('/contracts/' + id), api('/contracts').then((x) => x.vendors)]);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const c = d.contract;
  const metaRow = (label, value) => h('div', { class: 'meta' }, h('span', { class: 'meta-label' }, label), value);
  const none = () => h('span', { class: 'muted' }, t('common.none'));
  const seeDesk = access('desk') !== 'none';
  const ticketLink = (tid) => (seeDesk ? link('desk/tickets/' + tid, { class: 'btn btn-small' }, '#' + tid) : h('span', { class: 'mono' }, '#' + tid));
  const head = (title, extra, button) => h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, title), extra ? h('span', { class: 'muted small' }, extra) : null), button || null);
  const v = c.visits;
  const visitsPanel = h(
    'section',
    { class: 'panel' },
    head(t('con.visits_title'), v.total ? t('con.visits_line', { done: v.done, due: v.due, total: v.total }) : t('con.no_visits_planned'), d.can_manage ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => visitDialog(c, d.today) }, icon('plus'), t('con.add_visit')) : null),
    v.behind && c.state !== 'expired' && c.state !== 'renewed' ? h('p', { class: 'notice notice-warn con-pad' }, tn('con.visits_behind_long', v.behind)) : '',
    d.visits.length
      ? h(
          'div',
          { class: 'table-scroll' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, ['con.visit_on', 'con.notes', 'tk.no', 'con.by', ...(d.can_manage ? ['common.actions'] : [])].map((x) => h('th', { scope: 'col' }, t(x))))),
            h(
              'tbody',
              {},
              d.visits.map((x) =>
                h(
                  'tr',
                  {},
                  h('td', {}, dateEl(x.done_on)),
                  h('td', { class: 'wrap-cell' }, x.note || none()),
                  h('td', {}, x.ticket_id ? ticketLink(x.ticket_id) : none()),
                  h('td', {}, x.user_name || none()),
                  d.can_manage ? h('td', {}, h('button', { type: 'button', class: 'btn btn-icon', title: t('common.delete'), 'aria-label': t('common.delete') + ': ' + fmtDate(x.done_on), onclick: () => simpleDelete(t('con.visit_delete_q', { d: fmtDate(x.done_on) }), '/contracts/' + c.id + '/visits/' + x.id, t('con.visit_deleted')) }, icon('trash'))) : null,
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'empty' }, t('con.no_visits')),
  );
  const assetsPanel = h(
    'section',
    { class: 'panel' },
    head(t('con.assets_title'), String(d.assets.length), d.can_manage ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => coverDialog(c, d.assets) }, icon('edit'), t('con.edit_assets')) : null),
    d.assets.length
      ? h(
          'div',
          { class: 'table-scroll' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, ['ast.tag', 'ast.name', 'tk.location', 'ast.risk', 'user.status'].map((x) => h('th', { scope: 'col' }, t(x))))),
            h(
              'tbody',
              {},
              d.assets.map((a) =>
                h(
                  'tr',
                  {},
                  h('td', {}, link('register/' + a.id, { class: 'btn btn-small mono', dir: 'ltr' }, a.tag)),
                  h('td', { class: 'strong' }, assetName(a)),
                  h('td', {}, pick(a.loc_ar, a.loc_en) || none()),
                  h('td', {}, a.risk === 'high' ? h('span', { class: 'note note-expired strong' }, t('ast.risk.high')) : t('ast.risk.' + a.risk)),
                  h('td', {}, assetStatusChip(a.status)),
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'empty' }, t('con.no_assets')),
  );
  const ticketsPanel = h(
    'section',
    { class: 'panel' },
    head(t('con.tickets_title'), c.penalties ? t('con.penalties_total', { v: fmtMoney(c.penalties) }) + (c.penalties_raw > c.penalties ? ' (' + t('con.capped') + ')' : '') : String(d.tickets.length)),
    d.tickets.length
      ? h(
          'div',
          { class: 'table-scroll' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, ['tk.no', 'ast.tag', 'con.called', 'con.arrived', 'con.lateness', 'con.penalty'].map((x) => h('th', { scope: 'col' }, t(x))))),
            h(
              'tbody',
              {},
              d.tickets.map((tk) =>
                h(
                  'tr',
                  {},
                  h('td', {}, ticketLink(tk.id)),
                  h('td', {}, tk.asset_tag ? h('span', { class: 'mono', dir: 'ltr' }, tk.asset_tag) : none()),
                  h('td', {}, timeEl(tk.vendor_called_at)),
                  h('td', {}, tk.vendor_arrived_at ? timeEl(tk.vendor_arrived_at) : h('span', { class: 'note note-near' }, t('con.not_arrived'))),
                  h('td', {}, tk.due_at ? h('span', { class: 'note' + (tk.late_min ? ' note-expired' : '') }, lateText(tk)) : none()),
                  h('td', { class: 'nowrap' }, tk.penalty ? fmtMoney(tk.penalty) : none()),
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'empty' }, t('con.no_tickets')),
  );
  const historyPanel =
    d.history.length > 1
      ? h(
          'section',
          { class: 'panel' },
          head(t('con.history')),
          h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['con.number', 'con.period', 'con.value'].map((x) => h('th', { scope: 'col' }, t(x))))),
              h(
                'tbody',
                {},
                d.history.map((x) =>
                  h(
                    'tr',
                    { class: x.id === c.id ? 'row-current' : '' },
                    h('td', {}, x.id === c.id ? h('span', { class: 'mono strong', dir: 'ltr' }, x.number) : link('contracts/' + x.id, { class: 'btn btn-small mono', dir: 'ltr' }, x.number)),
                    h('td', {}, period(x)),
                    h('td', { class: 'nowrap' }, fmtMoney(x.value)),
                  ),
                ),
              ),
            ),
          ),
        )
      : '';
  root.replaceChildren(
    h('p', {}, link('contracts', { class: 'back-link' }, t('con.back'))),
    h(
      'div',
      { class: 'panel doc-head' },
      h('div', { class: 'doc-title ticket-title' }, h('span', { class: 'mono strong', dir: 'ltr' }, c.number), contractChip(c)),
      h('h1', {}, contractTitle(c)),
      h(
        'div',
        { class: 'actions' },
        c.has_pdf ? pdfLink('/api/contracts/' + c.id + '/pdf') : null,
        d.can_manage ? h('button', { type: 'button', class: 'btn', onclick: () => contractDialog(c, vendors) }, icon('edit'), t('common.edit')) : null,
        d.can_manage && c.state !== 'renewed' ? h('button', { type: 'button', class: 'btn', onclick: () => contractDialog(c, vendors, true) }, t('con.renew')) : null,
        d.can_manage && !d.tickets.length && c.state !== 'renewed' ? h('button', { type: 'button', class: 'btn', onclick: () => simpleDelete(t('con.delete_q', { n: c.number }), '/contracts/' + c.id, t('con.deleted'), () => navigate('assets/contracts')) }, icon('trash'), t('common.delete')) : null,
      ),
      h(
        'div',
        { class: 'meta-grid' },
        metaRow(t('con.vendor'), link('vendors/' + c.vendor_id, {}, vendorName(c))),
        metaRow(t('con.kind'), h('span', {}, t('con.kind.' + c.kind))),
        metaRow(t('con.start'), dateEl(c.start_date)),
        metaRow(t('con.end'), dateEl(c.end_date)),
        metaRow(t('con.value'), h('span', { class: 'strong' }, fmtMoney(c.value))),
        metaRow(t('con.response_hours'), c.response_hours ? h('span', {}, tn('con.hours_n', c.response_hours)) : none()),
        metaRow(t('con.penalty_hour'), c.penalty_per_hour ? h('span', {}, fmtMoney(c.penalty_per_hour), c.penalty_cap_pct ? h('span', { class: 'muted' }, ' - ' + t('con.cap_line', { p: c.penalty_cap_pct })) : null) : none()),
        metaRow(t('con.visits_year'), c.visits_per_year ? h('span', {}, String(c.visits_per_year)) : none()),
        c.notes ? metaRow(t('con.notes'), h('span', { class: 'pre-line' }, c.notes)) : null,
      ),
    ),
    assetsPanel,
    visitsPanel,
    ticketsPanel,
    historyPanel,
  );
}

export function visitDialog(c, today) {
  const on = input({ type: 'date', required: true, value: today, min: c.start_date, max: today < c.end_date ? today : c.end_date });
  const ticket = input({ type: 'number', min: 1, step: 1, dir: 'ltr' });
  const note = h('textarea', { rows: 2, maxlength: 500 });
  openDialog({
    title: t('con.add_visit'),
    body: h('div', { class: 'stack' }, field(t('con.visit_on'), on), field(t('con.visit_ticket'), ticket, t('con.visit_ticket_hint')), field(t('tk.note_optional'), note)),
    onSubmit: async () => {
      await api('/contracts/' + c.id + '/visits', { method: 'POST', body: { done_on: on.value, ticket_id: ticket.value ? Number(ticket.value) : null, note: note.value } });
      toast(t('tk.saved'));
      render();
    },
  });
}

// The assets a contract covers: a searchable list of every asset, ticked or not.
export async function coverDialog(c, covered) {
  let all;
  try {
    all = (S.assetMeta = await api('/assets')).assets;
  } catch (e) {
    toast(errText(e), true);
    return;
  }
  const chosen = new Set(covered.map((a) => a.id));
  const search = input({ type: 'search', placeholder: t('con.find_asset'), 'aria-label': t('con.find_asset'), autocomplete: 'off' });
  const count = h('span', { class: 'muted small' });
  const list = h('div', { class: 'cover-list' });
  const draw = () => {
    const q = normText(search.value);
    const rows = all.filter((a) => !q || normText([a.tag, a.name_ar, a.name_en, a.loc_ar, a.loc_en].join(' ')).includes(q)).slice(0, 300);
    list.replaceChildren(
      ...rows.map((a) => {
        const box = input({ type: 'checkbox', checked: chosen.has(a.id), onchange: () => { box.checked ? chosen.add(a.id) : chosen.delete(a.id); count.textContent = tn('con.chosen', chosen.size); } });
        return checkField(h('span', {}, h('span', { class: 'mono', dir: 'ltr' }, a.tag), ' ' + assetName(a), a.loc_ar ? h('span', { class: 'muted small' }, ' - ' + pick(a.loc_ar, a.loc_en)) : null), box);
      }),
    );
    if (!rows.length) list.append(h('p', { class: 'muted' }, t('con.no_assets_match')));
  };
  count.textContent = tn('con.chosen', chosen.size);
  search.addEventListener('input', draw);
  draw();
  openDialog({
    title: t('con.edit_assets'),
    body: h('div', { class: 'stack' }, search, count, list),
    onSubmit: async () => {
      await api('/contracts/' + c.id + '/assets', { method: 'PUT', body: { asset_ids: [...chosen] } });
      toast(t('tk.saved'));
      render();
    },
  });
}

export async function vendorsPage(root, param, alive) {
  if (param) return vendorDetail(root, param, alive);
  let d;
  try {
    d = await api('/vendors');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  root.replaceChildren(
    h('p', {}, link('contracts', { class: 'back-link' }, t('con.back'))),
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.vendors')), h('p', { class: 'muted' }, t('vnd.sub'))),
      d.can_manage ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => vendorDialog(null) }, icon('plus'), t('vnd.add'))) : null,
    ),
    h(
      'section',
      { class: 'panel' },
      d.vendors.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['vnd.name', 'vnd.cr', 'vnd.contact', 'tk.phone', 'vnd.active_contracts', 'vnd.docs', 'user.status'].map((c) => h('th', { scope: 'col' }, t(c))))),
              h(
                'tbody',
                {},
                d.vendors.map((v) =>
                  h(
                    'tr',
                    { class: 'row-link', onclick: (e) => e.target.closest('a,button') || navigate('assets/vendors/' + v.id) },
                    h('td', { class: 'strong' }, link('vendors/' + v.id, {}, vendorName(v)), v.services ? h('div', { class: 'muted small' }, v.services) : null),
                    h('td', {}, v.cr_no ? h('span', { class: 'mono', dir: 'ltr' }, v.cr_no) : h('span', { class: 'muted' }, t('common.none'))),
                    h('td', {}, v.contact_name || h('span', { class: 'muted' }, t('common.none'))),
                    h('td', {}, v.phone ? h('a', { href: 'tel:' + v.phone, dir: 'ltr' }, v.phone) : h('span', { class: 'muted' }, t('common.none'))),
                    h('td', {}, h('span', { class: 'mono' }, String(v.active_contracts))),
                    h('td', {}, v.docs_expired ? h('span', { class: 'note note-expired' }, tn('vnd.docs_expired', v.docs_expired)) : v.docs_near ? h('span', { class: 'note note-near' }, tn('vnd.docs_near', v.docs_near)) : h('span', { class: 'muted small' }, t('vnd.docs_ok'))),
                    h('td', {}, v.active ? h('span', { class: 'chip chip-valid' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('field.active')) : h('span', { class: 'chip chip-review' }, t('user.inactive'))),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('vnd.empty')),
    ),
  );
}

export function vendorDialog(v) {
  const ar = input({ type: 'text', required: true, maxlength: 150, dir: 'rtl', value: v ? v.name_ar : '' });
  const en = input({ type: 'text', required: true, maxlength: 150, dir: 'ltr', value: v ? v.name_en : '' });
  const cr = input({ type: 'text', maxlength: 30, dir: 'ltr', value: v ? v.cr_no || '' : '' });
  const vat = input({ type: 'text', maxlength: 30, dir: 'ltr', value: v ? v.vat_no || '' : '' });
  const contact = input({ type: 'text', maxlength: 100, value: v ? v.contact_name || '' : '' });
  const phone = input({ type: 'tel', maxlength: 30, dir: 'ltr', value: v ? v.phone || '' : '' });
  const email = input({ type: 'email', maxlength: 200, dir: 'ltr', value: v ? v.email || '' : '' });
  const services = input({ type: 'text', maxlength: 300, value: v ? v.services || '' : '', placeholder: t('vnd.services_ph') });
  const notes = h('textarea', { rows: 2, maxlength: 2000 }, v ? v.notes || '' : '');
  const active = input({ type: 'checkbox', checked: v ? !!v.active : true });
  openDialog({
    title: t(v ? 'vnd.edit' : 'vnd.add'),
    body: h(
      'div',
      { class: 'stack' },
      field(t('vnd.name_ar'), ar),
      field(t('vnd.name_en'), en),
      h('div', { class: 'form-grid' }, field(t('vnd.cr'), cr), field(t('vnd.vat'), vat)),
      h('div', { class: 'form-grid' }, field(t('vnd.contact'), contact), field(t('tk.phone'), phone)),
      field(t('vnd.email'), email),
      field(t('vnd.services'), services),
      field(t('con.notes'), notes),
      v ? checkField(t('vnd.active'), active) : null,
    ),
    onSubmit: async () => {
      const r = await api(v ? '/vendors/' + v.id : '/vendors', { method: v ? 'PUT' : 'POST', body: { name_ar: ar.value, name_en: en.value, cr_no: cr.value, vat_no: vat.value, contact_name: contact.value, phone: phone.value, email: email.value, services: services.value, notes: notes.value, active: active.checked } });
      toast(t('tk.saved'));
      if (v) render();
      else navigate('assets/vendors/' + r.id);
    },
  });
}

export async function vendorDetail(root, id, alive) {
  let d;
  try {
    d = await api('/vendors/' + id);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const { vendor: v, stats } = d;
  const metaRow = (label, value) => h('div', { class: 'meta' }, h('span', { class: 'meta-label' }, label), value);
  const none = () => h('span', { class: 'muted' }, t('common.none'));
  const ltr = (x) => (x ? h('span', { dir: 'ltr' }, x) : none());
  const seeDesk = access('desk') !== 'none';
  const ticketLink = (tid) => (seeDesk ? link('desk/tickets/' + tid, { class: 'btn btn-small' }, '#' + tid) : h('span', { class: 'mono' }, '#' + tid));
  const head = (title, extra, button) => h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, title), extra ? h('span', { class: 'muted small' }, extra) : null), button || null);
  const kpi = (num, label, cls) => h('div', { class: 'kpi ' + (cls || '') }, h('span', { class: 'kpi-num' }, num), h('span', { class: 'kpi-label' }, label));
  const onTime = stats.timed ? Math.round((stats.on_time / stats.timed) * 100) : null;
  root.replaceChildren(
    h('p', {}, link('vendors', { class: 'back-link' }, t('vnd.back'))),
    h(
      'div',
      { class: 'panel doc-head' },
      h('div', { class: 'doc-title ticket-title' }, v.active ? h('span', { class: 'chip chip-valid' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('field.active')) : h('span', { class: 'chip chip-review' }, t('user.inactive'))),
      h('h1', {}, vendorName(v)),
      d.can_manage
        ? h(
            'div',
            { class: 'actions' },
            h('button', { type: 'button', class: 'btn', onclick: () => vendorDialog(v) }, icon('edit'), t('common.edit')),
            !d.contracts.length && !d.tickets.length ? h('button', { type: 'button', class: 'btn', onclick: () => simpleDelete(t('vnd.delete_q', { name: vendorName(v) }), '/vendors/' + v.id, t('vnd.deleted'), () => navigate('assets/vendors')) }, icon('trash'), t('common.delete')) : null,
          )
        : null,
      h(
        'div',
        { class: 'meta-grid' },
        metaRow(t('vnd.cr'), ltr(v.cr_no)),
        metaRow(t('vnd.vat'), ltr(v.vat_no)),
        metaRow(t('vnd.contact'), v.contact_name ? h('span', {}, v.contact_name) : none()),
        metaRow(t('tk.phone'), v.phone ? h('a', { href: 'tel:' + v.phone, dir: 'ltr' }, v.phone) : none()),
        metaRow(t('vnd.email'), v.email ? h('a', { href: 'mailto:' + v.email, dir: 'ltr' }, v.email) : none()),
        metaRow(t('vnd.services'), v.services ? h('span', {}, v.services) : none()),
        v.notes ? metaRow(t('con.notes'), h('span', { class: 'pre-line' }, v.notes)) : null,
      ),
    ),
    h('h2', { class: 'section-title' }, t('vnd.performance')),
    h(
      'div',
      { class: 'panel kpis' },
      kpi(String(stats.sent), t('vnd.sent')),
      kpi(stats.avg_arrive_min === null ? '-' : fmtHours(stats.avg_arrive_min), t('vnd.avg_arrive')),
      kpi(onTime === null ? '-' : onTime + '%', t('vnd.on_time'), onTime === null ? '' : onTime >= 90 ? 'kpi-valid' : onTime >= 70 ? 'kpi-near' : 'kpi-expired'),
      kpi(fmtMoney(stats.penalties), t('vnd.penalties'), stats.penalties ? 'kpi-expired' : ''),
    ),
    h(
      'section',
      { class: 'panel' },
      head(t('vnd.docs'), String(d.docs.length), d.can_manage ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => vendorDocDialog(v) }, icon('plus'), t('vnd.add_doc')) : null),
      d.docs.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['vnd.doc_kind', 'vnd.doc_no', 'vnd.expiry', 'con.pdf', ...(d.can_manage ? ['common.actions'] : [])].map((x) => h('th', { scope: 'col' }, t(x))))),
              h(
                'tbody',
                {},
                d.docs.map((x) =>
                  h(
                    'tr',
                    {},
                    h('td', { class: 'strong' }, t('vnd.kind.' + x.kind), x.note ? h('div', { class: 'muted small' }, x.note) : null),
                    h('td', {}, x.number ? h('span', { class: 'mono', dir: 'ltr' }, x.number) : none()),
                    h('td', {}, x.expiry_date ? dueChip(x.expiry_date, d.today, true) : h('span', { class: 'muted small' }, t('vnd.no_expiry'))),
                    h('td', {}, x.has_file ? pdfLink('/api/vendor-docs/' + x.id + '/file', t('vnd.open_file')) : none()),
                    d.can_manage ? h('td', {}, h('button', { type: 'button', class: 'btn btn-icon', title: t('common.delete'), 'aria-label': t('common.delete') + ': ' + t('vnd.kind.' + x.kind), onclick: () => simpleDelete(t('vnd.doc_delete_q', { kind: t('vnd.kind.' + x.kind) }), '/vendor-docs/' + x.id, t('vnd.doc_deleted')) }, icon('trash'))) : null,
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('vnd.no_docs')),
    ),
    h(
      'section',
      { class: 'panel' },
      head(t('nav.contracts'), String(d.contracts.length)),
      d.contracts.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['con.number', 'con.title', 'con.period', 'con.state', 'con.value', 'vnd.penalties'].map((x) => h('th', { scope: 'col' }, t(x))))),
              h(
                'tbody',
                {},
                d.contracts.map((c) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, link('contracts/' + c.id, { class: 'btn btn-small mono', dir: 'ltr' }, c.number)),
                    h('td', { class: 'strong' }, contractTitle(c)),
                    h('td', {}, period(c)),
                    h('td', {}, contractChip(c)),
                    h('td', { class: 'nowrap' }, fmtMoney(c.value)),
                    h('td', { class: 'nowrap' }, c.penalties ? fmtMoney(c.penalties) : none()),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('vnd.no_contracts')),
    ),
    h(
      'section',
      { class: 'panel' },
      head(t('con.tickets_title'), String(d.tickets.length)),
      d.tickets.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['tk.no', 'ast.tag', 'req.desc', 'con.called', 'con.arrived', 'con.lateness', 'con.penalty'].map((x) => h('th', { scope: 'col' }, t(x))))),
              h(
                'tbody',
                {},
                d.tickets.map((tk) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, ticketLink(tk.id)),
                    h('td', {}, tk.asset_tag ? h('span', { class: 'mono', dir: 'ltr' }, tk.asset_tag) : none()),
                    h('td', { class: 'wrap-cell clamp' }, tk.description.split('\n')[0]),
                    h('td', {}, timeEl(tk.vendor_called_at)),
                    h('td', {}, tk.vendor_arrived_at ? timeEl(tk.vendor_arrived_at) : h('span', { class: 'note note-near' }, t('con.not_arrived'))),
                    h('td', {}, tk.due_at ? h('span', { class: 'note' + (tk.late_min ? ' note-expired' : '') }, lateText(tk)) : none()),
                    h('td', { class: 'nowrap' }, tk.penalty ? fmtMoney(tk.penalty) : none()),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('con.no_tickets')),
    ),
  );
}

export function vendorDocDialog(v) {
  const kind = select(VENDOR_DOC_KINDS.map((k) => [k, t('vnd.kind.' + k)]), 'cr', {});
  const number = input({ type: 'text', maxlength: 50, dir: 'ltr' });
  const expiry = input({ type: 'date' });
  const note = input({ type: 'text', maxlength: 300 });
  const pdf = fileInput();
  openDialog({
    title: t('vnd.add_doc'),
    body: h('div', { class: 'stack' }, field(t('vnd.doc_kind'), kind), field(t('vnd.doc_no'), number), field(t('vnd.expiry'), expiry, t('vnd.expiry_hint')), field(t('tk.note_optional'), note), field(t('con.pdf'), pdf)),
    onSubmit: async () => {
      const form = new FormData();
      form.append('kind', kind.value);
      form.append('number', number.value);
      form.append('expiry_date', expiry.value);
      form.append('note', note.value);
      if (pdf.files[0]) form.append('pdf', pdf.files[0]);
      await api('/vendors/' + v.id + '/docs', { method: 'POST', form });
      toast(t('tk.saved'));
      render();
    },
  });
}

// From a request: send it to a supplier (the contract that covers the device comes first), then record when the supplier came.
export async function vendorCallDialog(tk, covered, act) {
  let vendors;
  try {
    vendors = (await api('/vendors/pick')).vendors;
  } catch (e) {
    toast(errText(e), true);
    return;
  }
  if (!vendors.length) {
    toast(t('vnd.none_active'), true);
    return;
  }
  const vendor = select([['', t('req.pick')], ...vendors.map((v) => [v.id, vendorName(v)])], covered ? covered.vendor_id : '', { required: true });
  const contract = select([], '', {});
  const fill = () => {
    const v = vendors.find((x) => String(x.id) === vendor.value);
    const list = v ? v.contracts : [];
    contract.replaceChildren(h('option', { value: '' }, t('vnd.no_contract')), ...list.map((c) => h('option', { value: c.id, selected: covered && covered.id === c.id }, c.number + ' - ' + contractTitle(c) + (c.response_hours ? ' (' + tn('con.hours_n', c.response_hours) + ')' : ''))));
  };
  vendor.addEventListener('change', fill);
  fill();
  const at = input({ type: 'datetime-local', required: true, value: toLocalInput(new Date().toISOString()) });
  const note = h('textarea', { rows: 2, maxlength: 2000 });
  openDialog({
    title: t('vnd.send'),
    body: h('div', { class: 'stack' }, covered ? h('p', { class: 'notice' }, t('vnd.covered', { c: covered.number, v: vendorName(covered) })) : null, field(t('con.vendor'), vendor), field(t('con.contract'), contract, t('vnd.contract_hint')), field(t('con.called'), at), field(t('tk.note_optional'), note)),
    submitLabel: t('vnd.send'),
    onSubmit: () => act('vendor_call', { vendor_id: Number(vendor.value), contract_id: contract.value ? Number(contract.value) : null, at: fromLocalInput(at.value), note: note.value }),
  });
}
export function vendorArriveDialog(act) {
  const at = input({ type: 'datetime-local', required: true, value: toLocalInput(new Date().toISOString()) });
  const note = h('textarea', { rows: 2, maxlength: 2000 });
  openDialog({
    title: t('vnd.arrived'),
    body: h('div', { class: 'stack' }, field(t('con.arrived'), at), field(t('tk.note_optional'), note)),
    submitLabel: t('vnd.arrived'),
    onSubmit: () => act('vendor_arrived', { at: fromLocalInput(at.value), note: note.value }),
  });
}
