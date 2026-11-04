// Asset Management: assets, types and planned maintenance.
import { render } from '../app.js';
import { contractTitle, fmtMoney, vendorName } from './contracts.js';
import { S, h, has, icon, t } from './core.js';
import { normText } from './docs.js';
import { assetImportDialog, assetTemplate, planDialog } from './inventory.js';
import { access, link, navigate } from './layout.js';
import { api, deptName, errorBox, field, fmtDate, input, openDialog, select, toast } from './offline.js';
import { pick, printQr, simpleDelete, ticketChip, timeEl } from './tickets.js';

/* ---------------------------- Asset Management --------------------------- */

export const PM_KINDS = ['ppm', 'calibration', 'inspection'];
// Counted words: Arabic has its own form for 1, 2, 3 to 10 and 11 or more (key_1, key_2, key_few, key).
export const tn = (key, n) => {
  const form = n === 0 ? '_0' : n === 1 ? '_1' : n === 2 ? '_2' : n <= 10 ? '_few' : '';
  return has(key + form) ? t(key + form, { n }) : t(key, { n });
};
export const assetName = (a) => pick(a.name_ar, a.name_en);
export const daysTo = (day, today) => Math.round((Date.parse(day + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
// A planned date: red when past, yellow within 30 days.
// warranty: the wording of an end date (ends today, expired) instead of a due date (due today, late).
export function dueChip(day, today, warranty) {
  if (!day) return h('span', { class: 'muted' }, t('common.none'));
  const n = daysTo(day, today);
  const cls = n < 0 ? 'chip-expired' : n <= 30 ? 'chip-near' : 'chip-valid';
  const note = warranty
    ? n < 0 ? t('days.ago', { n: -n }) : n === 0 ? t('days.today') : t('days.left', { n })
    : n < 0 ? tn('pm.days_ago', -n) : n === 0 ? t('pm.due_today') : tn('pm.days_left', n);
  return h('span', { class: 'cell-stack' }, h('span', { class: 'chip ' + cls }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { dir: 'ltr' }, fmtDate(day))), n <= 30 ? h('span', { class: 'note ' + (n < 0 ? 'note-expired' : 'note-near') }, note) : null);
}
export const assetStatusChip = (s) => h('span', { class: 'chip ' + (s === 'in_service' ? 'chip-valid' : s === 'out_of_service' ? 'chip-expired' : 'chip-review') }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('ast.status.' + s));
export const compliancePct = (c) => (c && c.n ? Math.round((c.ok / c.n) * 100) + '%' : '-');
export const kpiRow = (items) => h('section', { class: 'panel kpis', 'aria-label': t('kpi.title') }, items.map(([k, v]) => h('div', { class: 'kpi' }, h('span', { class: 'kpi-num', dir: 'ltr' }, String(v)), h('span', { class: 'kpi-label' }, t(k)))));
// An asset's QR opens the request form with the device already filled in (and its place, when it has one).
export const assetQrUrl = (a) => location.origin + '/request?' + (a.loc_code ? 'loc=' + encodeURIComponent(a.loc_code) + '&' : '') + 'asset=' + encodeURIComponent(a.tag);
export const printAssetQr = (list) => printQr(list.map((a) => ({ url: assetQrUrl(a), title: assetName(a) + ' - ' + a.tag, heading: t('qr.scan_asset') })));

export async function registerPage(root, param, alive) {
  if (param) return assetDetail(root, Number(param), alive);
  let data;
  try {
    data = await api('/assets');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  S.assetMeta = data;
  const { assets, today } = data;
  const live = assets.filter((a) => a.status !== 'retired');
  const f = (S.assetF = S.assetF || { q: '', dept: '', status: '', pm: '' });
  const search = input({ type: 'search', class: 'doc-search-input', value: f.q, placeholder: t('ast.search_ph'), 'aria-label': t('ast.search'), autocomplete: 'off' });
  const dept = select([['', t('ast.all_depts')], ...data.departments.map((d) => [d.id, pick(d.name_ar, d.name_en)])], f.dept, { 'aria-label': t('user.department') });
  const status = select([['', t('ast.all_status')], ...['in_service', 'out_of_service', 'retired'].map((s) => [s, t('ast.status.' + s)])], f.status, { 'aria-label': t('ast.status') });
  const pm = select([['', t('ast.pm_any')], ['overdue', t('ast.pm_overdue')], ['soon', t('ast.pm_soon')], ['none', t('ast.pm_none')]], f.pm, { 'aria-label': t('ast.next_pm') });
  const box = h('div', {});
  const filtered = () => {
    const q = normText(f.q);
    return assets.filter((a) => {
      if (q && !normText([a.tag, a.name_ar, a.name_en, a.serial_no, a.model, a.manufacturer, a.type_ar, a.type_en].join(' ')).includes(q)) return false;
      if (f.dept && String(a.department_id) !== f.dept) return false;
      if (f.status ? a.status !== f.status : a.status === 'retired') return false;
      const n = a.next_pm ? daysTo(a.next_pm, today) : null;
      if (f.pm === 'overdue' && !(n !== null && n < 0)) return false;
      if (f.pm === 'soon' && !(n !== null && n >= 0 && n <= 30)) return false;
      if (f.pm === 'none' && a.next_pm) return false;
      return true;
    });
  };
  const draw = () => {
    const rows = filtered();
    const shown = rows.slice(0, 300);
    box.replaceChildren(
      h(
        'section',
        { class: 'panel' },
        h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('nav.register')), h('span', { class: 'muted small' }, tn('ast.count', rows.length)))),
        shown.length
          ? h(
              'div',
              { class: 'table-scroll' },
              h(
                'table',
                { class: 'assets-table' },
                h('thead', {}, h('tr', {}, ['ast.tag', 'ast.name', 'ast.type', 'ast.where', 'ast.status', 'ast.next_pm', 'ast.open_faults'].map((c) => h('th', { scope: 'col' }, t(c))))),
                h(
                  'tbody',
                  {},
                  shown.map((a) =>
                    h(
                      'tr',
                      {},
                      h('td', {}, link('register/' + a.id, { class: 'btn btn-small mono', dir: 'ltr', 'aria-label': t('ast.open') + ' ' + a.tag }, a.tag)),
                      h('td', { class: 'wrap-cell' }, h('div', { class: 'strong' }, assetName(a)), a.model || a.manufacturer ? h('div', { class: 'muted small', dir: 'ltr' }, [a.manufacturer, a.model].filter(Boolean).join(' ')) : null, a.risk === 'high' ? h('span', { class: 'note note-expired' }, t('ast.risk.high')) : null),
                      h('td', { class: 'wrap-cell' }, h('div', {}, pick(a.type_ar, a.type_en) || t('common.none')), h('div', { class: 'muted small' }, pick(a.team_ar, a.team_en))),
                      h('td', { class: 'wrap-cell' }, h('div', {}, pick(a.dept_ar, a.dept_en) || t('common.none')), a.loc_ar ? h('div', { class: 'muted small' }, pick(a.loc_ar, a.loc_en)) : null),
                      h('td', {}, assetStatusChip(a.status)),
                      h('td', {}, dueChip(a.next_pm, today)),
                      h('td', {}, a.open_faults ? h('span', { class: 'note note-expired strong' }, String(a.open_faults)) : h('span', { class: 'muted' }, '0')),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty' }, assets.length ? t('ast.no_match') : t('ast.empty')),
        rows.length > shown.length ? h('p', { class: 'muted small panel-foot' }, t('staff.more', { n: rows.length - shown.length })) : null,
      ),
    );
  };
  search.addEventListener('input', () => {
    f.q = search.value;
    draw();
  });
  for (const [el, k] of [[dept, 'dept'], [status, 'status'], [pm, 'pm']]) {
    el.addEventListener('change', () => {
      f[k] = el.value;
      draw();
    });
  }
  const overdue = live.filter((a) => a.next_pm && a.next_pm < today).length;
  const soon = live.filter((a) => a.next_pm && a.next_pm >= today && daysTo(a.next_pm, today) <= 30).length;
  const warranty = live.filter((a) => a.warranty_end && a.warranty_end >= today && daysTo(a.warranty_end, today) <= 90).length;
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.register')), h('p', { class: 'muted' }, t('ast.sub'))),
      data.can_manage
        ? h(
            'div',
            { class: 'actions' },
            h('button', { type: 'button', class: 'btn', onclick: assetTemplate }, icon('download'), t('staff.template')),
            h('button', { type: 'button', class: 'btn', onclick: assetImportDialog }, icon('file'), t('ast.import')),
            h('button', { type: 'button', class: 'btn', onclick: () => printAssetQr(filtered().filter((a) => a.status !== 'retired')) }, t('ast.print_qr')),
            h('button', { type: 'button', class: 'btn btn-primary', onclick: () => assetDialog(null) }, icon('plus'), t('ast.add')),
          )
        : null,
    ),
    kpiRow([
      ['ast.k_total', live.length],
      ['ast.k_out', live.filter((a) => a.status === 'out_of_service').length],
      ['ast.k_overdue', overdue],
      ['ast.k_soon', soon],
      ['ast.k_compliance', compliancePct(data.compliance)],
      ['ast.k_warranty', warranty],
      ['ast.k_faults', live.reduce((n, a) => n + a.open_faults, 0)],
    ]),
    riskPanel(),
    h('div', { class: 'filters' }, h('div', { class: 'doc-search', role: 'search' }, icon('search'), search), dept, status, pm),
    box,
  );
  draw();
}

// Devices to watch (see assetRisk in src/systems/assets.js): shown once loaded, open when one is high.
export const RISK_CHIP = { high: 'chip-expired', medium: 'chip-near', low: 'chip-review' };
export function riskReason([key, v]) {
  return key === 'pm_overdue' ? t('rk.r.pm_overdue', { d: fmtDate(v) }) : t('rk.r.' + key, { n: v });
}
export function riskPanel() {
  const panel = h('details', { class: 'panel fold risk-panel', hidden: true });
  api('/assets/risk')
    .then(({ assets }) => {
      panel.open = assets.some((a) => a.level === 'high');
      panel.append(
        h('summary', {}, h('div', {}, h('h2', {}, t('rk.title'), ' ', h('span', { class: 'muted small' }, String(assets.length))), h('p', { class: 'muted small' }, t('rk.help')))),
        h(
          'div',
          { class: 'pad' },
          assets.length
            ? h(
                'ul',
                { class: 'risk-list' },
                assets.map((a) =>
                  h(
                    'li',
                    {},
                    h('div', { class: 'risk-head' }, link('register/' + a.id, { class: 'btn btn-small mono', dir: 'ltr' }, a.tag), h('span', { class: 'strong' }, assetName(a)), h('span', { class: 'chip ' + RISK_CHIP[a.level] }, t('rk.level.' + a.level), ' ', h('span', { dir: 'ltr' }, a.score + '/100'))),
                    h('div', { class: 'muted small' }, [pick(a.dept_ar, a.dept_en), ...a.reasons.filter(([k, v]) => !(k === 'faults_year' && v === a.f90)).map(riskReason)].filter(Boolean).join(' · ')),
                    h('div', { class: 'small' }, a.next_fault ? t('rk.next', { d: fmtDate(a.next_fault) }) : '', a.parts_cost > 0 ? h('span', { class: 'muted' }, (a.next_fault ? ' · ' : '') + t('rk.parts', { c: fmtMoney(a.parts_cost) })) : ''),
                  ),
                ),
              )
            : h('p', { class: 'muted' }, t('rk.none')),
        ),
      );
      panel.hidden = false;
    })
    .catch(() => {});
  return panel;
}

export function assetDialog(a) {
  const m = S.assetMeta;
  const tag = input({ type: 'text', required: true, maxlength: 60, dir: 'ltr', value: a ? a.tag : '', placeholder: 'BME-0001' });
  const ar = input({ type: 'text', required: true, maxlength: 150, dir: 'rtl', value: a ? a.name_ar : '', placeholder: 'جهاز تنفس صناعي' });
  const en = input({ type: 'text', required: true, maxlength: 150, dir: 'ltr', value: a ? a.name_en : '', placeholder: 'Ventilator' });
  const teamOf = (x) => deptName(m.departments.find((d) => d.id === x.team_id));
  const cat = select([['', t('req.pick')], ...m.types.filter((x) => x.active || (a && x.id === a.type_id)).map((x) => [x.id, pick(x.name_ar, x.name_en) + ' - ' + teamOf(x)])], a ? a.type_id : '', { required: true });
  const dept = select([['', t('common.none')], ...m.departments.map((d) => [d.id, pick(d.name_ar, d.name_en)])], a ? a.department_id : '', {});
  const loc = select([['', t('common.none')], ...m.locations.filter((l) => l.active || (a && l.id === a.location_id)).map((l) => [l.id, pick(l.name_ar, l.name_en)])], a ? a.location_id : '', {});
  const maker = input({ type: 'text', maxlength: 100, dir: 'ltr', value: a ? a.manufacturer || '' : '' });
  const model = input({ type: 'text', maxlength: 100, dir: 'ltr', value: a ? a.model || '' : '' });
  const serial = input({ type: 'text', maxlength: 100, dir: 'ltr', value: a ? a.serial_no || '' : '' });
  const bought = input({ type: 'date', value: a ? a.purchase_date || '' : '' });
  const warranty = input({ type: 'date', value: a ? a.warranty_end || '' : '' });
  const status = select(['in_service', 'out_of_service', 'retired'].map((s) => [s, t('ast.status.' + s)]), a ? a.status : 'in_service', {});
  const risk = select(['high', 'medium', 'low'].map((r) => [r, t('ast.risk.' + r)]), a ? a.risk : 'medium', {});
  const notes = h('textarea', { rows: 2, maxlength: 1000 }, a ? a.notes || '' : '');
  // A place belongs to a department: picking the place fills the department when it is empty.
  loc.addEventListener('change', () => {
    const l = m.locations.find((x) => String(x.id) === loc.value);
    if (l && l.department_id && !dept.value) dept.value = String(l.department_id);
  });
  openDialog({
    title: t(a ? 'ast.edit' : 'ast.add'),
    body: h(
      'div',
      { class: 'stack' },
      field(t('ast.tag'), tag, t('ast.tag_hint')),
      h('div', { class: 'form-grid' }, field(t('dept.name_ar'), ar), field(t('dept.name_en'), en)),
      field(t('ast.type'), cat, t('ast.type_hint')),
      h('div', { class: 'form-grid' }, field(t('user.department'), dept), field(t('tk.location'), loc)),
      h('div', { class: 'form-grid' }, field(t('ast.maker'), maker), field(t('ast.model'), model)),
      h('div', { class: 'form-grid' }, field(t('ast.serial'), serial), field(t('ast.risk'), risk, t('ast.risk_hint'))),
      h('div', { class: 'form-grid' }, field(t('ast.bought'), bought), field(t('ast.warranty'), warranty)),
      field(t('ast.status'), status),
      field(t('ast.notes'), notes),
    ),
    onSubmit: async () => {
      const body = {
        tag: tag.value, name_ar: ar.value, name_en: en.value, type_id: Number(cat.value) || null, department_id: Number(dept.value) || null, location_id: Number(loc.value) || null,
        manufacturer: maker.value, model: model.value, serial_no: serial.value, purchase_date: bought.value, warranty_end: warranty.value, status: status.value, risk: risk.value, notes: notes.value,
      };
      const r = await api(a ? '/assets/' + a.id : '/assets', { method: a ? 'PUT' : 'POST', body });
      toast(t('tk.saved'));
      if (!a && !r.queued) navigate('assets/register/' + r.id);
      else render();
    },
  });
}

export async function assetDetail(root, id, alive) {
  let d;
  try {
    [d] = await Promise.all([api('/assets/' + id), S.assetMeta ? null : api('/assets').then((m) => (S.assetMeta = m))]);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const { asset: a, plans, done, tickets, today } = d;
  const metaRow = (label, value) => h('div', { class: 'meta' }, h('span', { class: 'meta-label' }, label), value);
  const none = () => h('span', { class: 'muted' }, t('common.none'));
  const ltr = (v) => (v ? h('span', { dir: 'ltr' }, v) : none());
  const seeDesk = access('desk') !== 'none';
  const ticketLink = (tid) => (seeDesk ? link('desk/tickets/' + tid, { class: 'btn btn-small' }, '#' + tid) : h('span', { class: 'mono' }, '#' + tid));
  const missing = PM_KINDS.filter((k) => !plans.some((p) => p.kind === k));
  const planPanel = h(
    'section',
    { class: 'panel' },
    h(
      'div',
      { class: 'panel-head' },
      h('div', { class: 'panel-title' }, h('h2', {}, t('pm.plans'))),
      d.can_manage && missing.length ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => planDialog(a, null, missing) }, icon('plus'), t('pm.add')) : null,
    ),
    plans.length
      ? h(
          'div',
          { class: 'table-scroll' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, ['pm.kind', 'pm.every', 'pm.next', 'pm.last', 'pm.order', ...(d.can_manage ? ['common.actions'] : [])].map((c) => h('th', { scope: 'col' }, t(c))))),
            h(
              'tbody',
              {},
              plans.map((p) =>
                h(
                  'tr',
                  {},
                  h('td', { class: 'strong' }, t('pm.kind.' + p.kind), p.active ? null : h('div', { class: 'muted small' }, t('pm.paused'))),
                  h('td', {}, tn('pm.every_n', p.every_months)),
                  h('td', {}, p.active ? dueChip(p.next_due, today) : h('span', { class: 'muted', dir: 'ltr' }, fmtDate(p.next_due))),
                  h('td', {}, p.last_done ? h('span', { dir: 'ltr' }, fmtDate(p.last_done)) : none()),
                  h('td', {}, p.open_ticket_id ? ticketLink(p.open_ticket_id) : h('span', { class: 'muted small' }, tn('pm.opens', p.lead_days))),
                  d.can_manage
                    ? h(
                        'td',
                        {},
                        h(
                          'div',
                          { class: 'row-actions' },
                          h('button', { type: 'button', class: 'btn btn-icon', title: t('common.edit'), 'aria-label': t('common.edit') + ': ' + t('pm.kind.' + p.kind), onclick: () => planDialog(a, p) }, icon('edit')),
                          h('button', { type: 'button', class: 'btn btn-icon', title: t('common.delete'), 'aria-label': t('common.delete') + ': ' + t('pm.kind.' + p.kind), onclick: () => simpleDelete(t('pm.delete_q', { kind: t('pm.kind.' + p.kind) }), '/pm-plans/' + p.id, t('pm.deleted')) }, icon('trash')),
                        ),
                      )
                    : null,
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'empty' }, t('pm.none')),
  );
  const historyPanel = h(
    'section',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('pm.history')))),
    done.length
      ? h(
          'div',
          { class: 'table-scroll' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, ['pm.kind', 'pm.due', 'pm.done_on', 'pm.result', 'tk.assignee', 'pm.order'].map((c) => h('th', { scope: 'col' }, t(c))))),
            h(
              'tbody',
              {},
              done.map((x) =>
                h(
                  'tr',
                  {},
                  h('td', {}, t('pm.kind.' + x.kind)),
                  h('td', { dir: 'ltr' }, fmtDate(x.due)),
                  h('td', {}, h('span', { dir: 'ltr' }, fmtDate(x.done_on)), ' ', h('span', { class: 'note ' + (x.on_time ? '' : 'note-expired') }, t(x.on_time ? 'tk.on_time' : 'pm.late'))),
                  h('td', {}, x.result ? t('res.' + x.result) : none()),
                  h('td', {}, x.user_name || none()),
                  h('td', {}, x.ticket_id ? ticketLink(x.ticket_id) : none()),
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'empty' }, t('pm.no_history')),
  );
  const ticketsPanel = h(
    'section',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('ast.requests')), h('span', { class: 'muted small' }, String(tickets.length)))),
    tickets.length
      ? h(
          'div',
          { class: 'table-scroll' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, ['tk.no', 'tk.created', 'tk.category', 'req.desc', 'tk.status'].map((c) => h('th', { scope: 'col' }, t(c))))),
            h(
              'tbody',
              {},
              tickets.map((tk) =>
                h(
                  'tr',
                  {},
                  h('td', {}, ticketLink(tk.id)),
                  h('td', {}, timeEl(tk.created_at)),
                  h('td', {}, tk.pm_plan_id ? h('span', { class: 'chip chip-pm' }, t('pm.planned')) : pick(tk.cat_ar, tk.cat_en)),
                  h('td', { class: 'wrap-cell clamp' }, tk.description.split('\n')[0]),
                  h('td', {}, ticketChip(tk)),
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'empty' }, t('ast.no_requests')),
  );
  root.replaceChildren(
    h('p', {}, link('register', { class: 'back-link' }, t('ast.back'))),
    h(
      'div',
      { class: 'panel doc-head' },
      h('div', { class: 'doc-title ticket-title' }, h('span', { class: 'mono strong', dir: 'ltr' }, a.tag), assetStatusChip(a.status), a.risk === 'high' ? h('span', { class: 'note note-expired strong' }, t('ast.risk.high')) : null, a.open_faults ? h('span', { class: 'note note-near strong' }, tn('ast.faults_open', a.open_faults)) : null),
      h('h1', {}, assetName(a)),
      d.can_manage
        ? h(
            'div',
            { class: 'actions' },
            h('button', { type: 'button', class: 'btn', onclick: () => assetDialog(a) }, icon('edit'), t('common.edit')),
            a.status !== 'retired' ? h('button', { type: 'button', class: 'btn', onclick: () => printAssetQr([a]) }, t('qr.print')) : null,
            h('button', { type: 'button', class: 'btn', onclick: () => simpleDelete(t('ast.delete_q', { name: assetName(a) }), '/assets/' + a.id, t('ast.deleted'), () => navigate('assets/register')) }, icon('trash'), t('common.delete')),
          )
        : null,
      h(
        'div',
        { class: 'meta-grid' },
        metaRow(t('ast.type'), h('span', {}, pick(a.type_ar, a.type_en) || t('common.none'), a.team_ar ? h('span', { class: 'muted' }, ' - ' + pick(a.team_ar, a.team_en)) : null)),
        metaRow(t('user.department'), h('span', {}, pick(a.dept_ar, a.dept_en) || t('common.none'))),
        metaRow(t('tk.location'), h('span', {}, pick(a.loc_ar, a.loc_en) || t('common.none'))),
        metaRow(t('ast.maker'), ltr(a.manufacturer)),
        metaRow(t('ast.model'), ltr(a.model)),
        metaRow(t('ast.serial'), ltr(a.serial_no)),
        metaRow(t('ast.risk'), h('span', {}, t('ast.risk.' + a.risk))),
        metaRow(
          t('con.contract'),
          d.contract
            ? h('span', { class: 'cell-stack' }, link('contracts/' + d.contract.id, {}, h('span', { dir: 'ltr' }, d.contract.number), ' - ' + contractTitle(d.contract)), h('span', { class: 'muted small' }, vendorName(d.contract) + ' - ' + t('con.until', { d: fmtDate(d.contract.end_date) })))
            : h('span', { class: a.risk === 'high' ? 'note note-expired' : 'muted' }, t('con.not_covered')),
        ),
        d.parts_cost && (d.parts_cost.cost || d.parts_cost.covered) ? metaRow(t('inv.asset_cost'), h('span', { class: 'cell-stack' }, h('span', { class: 'strong' }, fmtMoney(d.parts_cost.cost)), d.parts_cost.covered ? h('span', { class: 'muted small' }, t('inv.cost_supplier') + ': ' + fmtMoney(d.parts_cost.covered)) : null)) : null,
        metaRow(t('ast.bought'), a.purchase_date ? ltr(fmtDate(a.purchase_date)) : none()),
        metaRow(t('ast.warranty'), a.warranty_end ? (a.warranty_end < today ? h('span', { class: 'cell-stack' }, ltr(fmtDate(a.warranty_end)), h('span', { class: 'note note-expired' }, t('ast.warranty_over'))) : dueChip(a.warranty_end, today, true)) : none()),
        a.notes ? metaRow(t('ast.notes'), h('span', { class: 'pre-line' }, a.notes)) : null,
      ),
    ),
    planPanel,
    historyPanel,
    ticketsPanel,
  );
}
