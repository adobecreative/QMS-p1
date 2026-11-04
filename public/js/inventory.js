// Spare parts: stores, stock, receipts and part requests.
import { render } from '../app.js';
import { readSheet } from './api.js';
import { PM_KINDS, assetName, compliancePct, daysTo, dueChip, kpiRow, tn } from './assets.js';
import { fmtMoney, vendorName } from './contracts.js';
import { ApiError, S, h, has, icon, nextId, store, t } from './core.js';
import { normText } from './docs.js';
import { access, link, navigate } from './layout.js';
import { api, checkField, deptName, errText, errorBox, field, fmtDate, input, openDialog, select, toast } from './offline.js';
import { fmtTime, pick, simpleDelete, timeEl } from './tickets.js';
import { XLS_STYLE, downloadXlsx } from './xlsx.js';

/* ------------------------------ spare parts ------------------------------ */

// The stock is kept here (standalone), in a sub-store fed by the ERP (linked), or by the ERP alone (erp).
export const fmtQty = (n) => new Intl.NumberFormat(S.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { maximumFractionDigits: 3 }).format(n || 0);
export const partName = (p) => pick(p.name_ar, p.name_en);
// Rows joined with a part carry the store as store_ar / store_en (their name_ar is the part's).
export const storeName = (s) => pick(s.store_ar || s.name_ar, s.store_en || s.name_en);
export const unitText = (u) => (has('inv.unit.' + u) ? t('inv.unit.' + u) : u || '');
export const modeChip = (mode) => h('span', { class: 'chip ' + (mode === 'erp' ? 'chip-review' : mode === 'linked' ? 'chip-progress' : 'chip-valid') }, t('inv.mode.' + mode));
export const REQ_CHIP = { open: 'chip-near', sent: 'chip-progress', done: 'chip-valid', cancelled: 'chip-review' };
export const reqChip = (r) => h('span', { class: 'chip ' + REQ_CHIP[r.status] }, t('inv.req.' + r.status));
export const MOVE_IN = ['transfer_in', 'purchase', 'opening', 'return'];
export const qtyCell = (m) => h('span', { class: 'mono ' + (m.qty < 0 ? 'qty-out' : 'qty-in'), dir: 'ltr' }, (m.qty > 0 ? '+' : '') + fmtQty(m.qty));
export const reqReason = (r) => (r.reason === 'ticket' && r.ticket_id ? h('span', {}, t('inv.reason.ticket') + ' ', link('desk/tickets/' + r.ticket_id, {}, '#' + r.ticket_id)) : h('span', {}, t('inv.reason.' + r.reason)));
// A move's reference: the voucher, order or invoice number, or the request it was used on.
export const moveRef = (m) =>
  h(
    'span',
    { class: 'cell-stack' },
    m.ticket_id ? link('desk/tickets/' + m.ticket_id, {}, '#' + m.ticket_id) : null,
    m.doc_no ? h('span', { class: 'small' }, t(m.kind === 'transfer_in' ? 'inv.voucher' : 'inv.po') + ': ', h('span', { class: 'mono', dir: 'ltr' }, m.doc_no)) : null,
    m.invoice_no ? h('span', { class: 'small' }, t('inv.invoice') + ': ', h('span', { class: 'mono', dir: 'ltr' }, m.invoice_no)) : null,
    m.asset_tag ? h('span', { class: 'muted small mono', dir: 'ltr' }, m.asset_tag) : null,
    m.covered ? h('span', { class: 'note note-near' }, t('inv.covered')) : null,
    m.source === 'api' ? h('span', { class: 'muted small' }, t('inv.from_api')) : null,
  );
export const INV_MODES = ['standalone', 'linked', 'erp'];
export const loadInv = async () => (S.inv = await api('/inventory'));

export async function partsPage(root, param, alive) {
  if (param) return partDetail(root, Number(param), alive);
  let d;
  try {
    d = await loadInv();
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const stocked = d.mode !== 'erp';
  const stores = d.stores.filter((s) => s.active);
  const search = input({ type: 'search', class: 'doc-search-input', value: S.invQ || '', placeholder: t('inv.search_ph'), 'aria-label': t('inv.search'), autocomplete: 'off' });
  const store = select([['', t('inv.all_stores')], ...stores.map((s) => [s.id, storeName(s)])], S.invStore || '', { 'aria-label': t('inv.store') });
  const lowOnly = input({ type: 'checkbox', checked: !!S.invLow });
  const box = h('div', {});
  const draw = () => {
    const q = normText(search.value);
    const sid = Number(store.value) || null;
    const rows = d.parts.filter((p) => (!q || normText([p.code, p.erp_code, p.name_ar, p.name_en].join(' ')).includes(q)) && (!lowOnly.checked || p.low) && (!sid || p.stock.some((s) => s.store_id === sid)));
    const qtyIn = (p) => (sid ? (p.stock.find((s) => s.store_id === sid) || { qty: 0 }).qty : p.qty);
    const cols = ['inv.code', 'inv.part', 'inv.unit', ...(stocked ? ['inv.qty', 'inv.min'] : []), 'inv.avg_cost', ...(stocked ? ['inv.value'] : []), 'inv.state'];
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
                h('thead', {}, h('tr', {}, cols.map((c) => h('th', { scope: 'col' }, t(c))))),
                h(
                  'tbody',
                  {},
                  rows.map((p) =>
                    h(
                      'tr',
                      { class: 'row-link' + (p.active ? '' : ' row-muted'), onclick: (e) => e.target.closest('a,button') || navigate('assets/parts/' + p.id) },
                      h('td', {}, link('parts/' + p.id, { class: 'btn btn-small mono', dir: 'ltr' }, p.code)),
                      h('td', { class: 'strong' }, partName(p), p.erp_code ? h('div', { class: 'muted small' }, t('inv.erp_code') + ': ', h('span', { dir: 'ltr' }, p.erp_code)) : null),
                      h('td', {}, unitText(p.unit)),
                      stocked ? h('td', {}, h('span', { class: 'mono strong' + (p.low ? ' qty-out' : ''), dir: 'ltr' }, fmtQty(qtyIn(p))), !sid && p.stock.length > 1 ? h('div', { class: 'muted small' }, tn('inv.in_stores', p.stock.length)) : null) : null,
                      stocked ? h('td', {}, p.min_qty ? h('span', { class: 'mono', dir: 'ltr' }, fmtQty(p.min_qty)) : h('span', { class: 'muted' }, t('common.none'))) : null,
                      h('td', { class: 'nowrap' }, fmtMoney(p.unit_cost)),
                      stocked ? h('td', { class: 'nowrap' }, fmtMoney(p.value)) : null,
                      h(
                        'td',
                        {},
                        h(
                          'span',
                          { class: 'cell-stack' },
                          !p.active ? h('span', { class: 'chip chip-review' }, t('inv.inactive')) : p.low ? h('span', { class: 'chip chip-expired' }, t('inv.low')) : stocked && !p.stock.length ? h('span', { class: 'muted small' }, t('inv.not_stocked')) : h('span', { class: 'chip chip-valid' }, t('inv.ok')),
                          p.open_requests ? h('span', { class: 'note note-near' }, tn('inv.requests_n', p.open_requests)) : null,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty' }, d.parts.length ? t('inv.no_match') : t('inv.empty')),
      ),
    );
  };
  search.addEventListener('input', () => {
    S.invQ = search.value;
    draw();
  });
  store.addEventListener('change', () => {
    S.invStore = store.value;
    draw();
  });
  lowOnly.addEventListener('change', () => {
    S.invLow = lowOnly.checked;
    draw();
  });
  const lowCount = d.parts.filter((p) => p.low).length;
  const needStores = () => {
    if (stores.length) return true;
    toast(t('inv.store_first'), true);
    storesDialog(d);
    return false;
  };
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.parts'), ' ', modeChip(d.mode)), h('p', { class: 'muted' }, t('inv.sub.' + d.mode))),
      h(
        'div',
        { class: 'actions' },
        link('requests', { class: 'btn' }, t('nav.requests'), d.open_requests ? h('span', { class: 'badge' }, String(d.open_requests)) : null),
        link('moves', { class: 'btn' }, t('nav.moves')),
        d.can_manage && stocked && d.receipt_kinds.length ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => needStores() && receiveDialog(d) }, icon('download'), t('inv.receive')) : null,
        d.can_manage && stocked ? h('button', { type: 'button', class: 'btn', onclick: () => needStores() && countDialog(d) }, icon('clipboard'), t('inv.count')) : null,
        d.can_manage ? h('button', { type: 'button', class: 'btn', onclick: () => partDialog(null, d) }, icon('plus'), t('inv.add_part')) : null,
        d.can_manage && stocked ? h('button', { type: 'button', class: 'btn', onclick: () => storesDialog(d) }, icon('building'), t('inv.stores')) : null,
        d.can_mode ? h('button', { type: 'button', class: 'btn', onclick: () => modeDialog(d.mode) }, t('inv.mode')) : null,
      ),
    ),
    d.mode === 'linked' ? h('p', { class: 'notice' }, t('inv.linked_hint')) : d.mode === 'erp' ? h('p', { class: 'notice' }, t('inv.erp_hint')) : '',
    h(
      'div',
      { class: 'panel kpis' },
      h('div', { class: 'kpi' }, h('span', { class: 'kpi-num' }, String(d.parts.filter((p) => p.active).length)), h('span', { class: 'kpi-label' }, t('inv.kpi_parts'))),
      stocked
        ? h('button', { type: 'button', class: 'kpi kpi-btn' + (lowCount ? ' kpi-expired' : ' kpi-valid'), onclick: () => { lowOnly.checked = true; S.invLow = true; draw(); } }, h('span', { class: 'kpi-num' }, String(lowCount)), h('span', { class: 'kpi-label' }, t('inv.kpi_low')))
        : null,
      stocked ? h('div', { class: 'kpi' }, h('span', { class: 'kpi-num', dir: 'ltr' }, fmtMoney(d.value)), h('span', { class: 'kpi-label' }, t('inv.kpi_value'))) : null,
      h('button', { type: 'button', class: 'kpi kpi-btn' + (d.open_requests ? ' kpi-near' : ''), onclick: () => navigate('assets/requests') }, h('span', { class: 'kpi-num' }, String(d.open_requests)), h('span', { class: 'kpi-label' }, t('inv.kpi_requests'))),
    ),
    h('div', { class: 'filters' }, h('div', { class: 'doc-search', role: 'search' }, icon('search'), search), stocked && stores.length > 1 ? store : null, stocked ? checkField(t('inv.low_only'), lowOnly) : null),
    box,
  );
  draw();
}

export function partDialog(p, d) {
  const code = input({ type: 'text', required: true, maxlength: 40, dir: 'ltr', value: p ? p.code : '', pattern: '[A-Za-z0-9_./-]+' });
  const ar = input({ type: 'text', required: true, maxlength: 150, dir: 'rtl', value: p ? p.name_ar : '' });
  const en = input({ type: 'text', required: true, maxlength: 150, dir: 'ltr', value: p ? p.name_en : '' });
  const unit = select(d.units.map((u) => [u, unitText(u)]), p ? p.unit : 'piece', {});
  const type = select([['', t('inv.any_type')], ...d.types.map((x) => [x.id, pick(x.name_ar, x.name_en)])], p ? p.type_id || '' : '', {});
  const n = (v) => input({ type: 'number', min: 0, step: 'any', dir: 'ltr', value: v || v === 0 ? v : '' });
  const min = n(p ? p.min_qty : '');
  const reorder = n(p ? p.reorder_qty : '');
  const erp = input({ type: 'text', maxlength: 40, dir: 'ltr', value: p ? p.erp_code || '' : '', pattern: '[A-Za-z0-9_./-]+' });
  const notes = h('textarea', { rows: 2, maxlength: 1000 }, p ? p.notes || '' : '');
  const active = input({ type: 'checkbox', checked: p ? !!p.active : true });
  const stocked = d.mode !== 'erp';
  openDialog({
    title: t(p ? 'inv.edit_part' : 'inv.add_part'),
    body: h(
      'div',
      { class: 'stack' },
      h('div', { class: 'form-grid' }, field(t('inv.code'), code, t('inv.code_hint')), field(t('inv.erp_code'), erp, t('inv.erp_code_hint'))),
      field(t('inv.name_ar'), ar),
      field(t('inv.name_en'), en),
      h('div', { class: 'form-grid' }, field(t('inv.unit'), unit), field(t('inv.for_type'), type)),
      stocked ? h('div', { class: 'form-grid' }, field(t('inv.min'), min, t('inv.min_hint')), field(t('inv.reorder'), reorder, t('inv.reorder_hint'))) : null,
      field(t('con.notes'), notes),
      p ? checkField(t('inv.active'), active) : null,
    ),
    onSubmit: async () => {
      const body = { code: code.value, name_ar: ar.value, name_en: en.value, unit: unit.value, type_id: type.value ? Number(type.value) : null, min_qty: stocked ? min.value : p ? p.min_qty : 0, reorder_qty: stocked ? reorder.value : p ? p.reorder_qty : 0, erp_code: erp.value, notes: notes.value, active: active.checked };
      const r = await api(p ? '/parts/' + p.id : '/parts', { method: p ? 'PUT' : 'POST', body });
      toast(t(p ? 'inv.part_saved' : 'inv.part_added'));
      if (p) render();
      else navigate('assets/parts/' + r.id);
    },
  });
}

export async function partDetail(root, id, alive) {
  let d;
  let inv;
  try {
    [d, inv] = await Promise.all([api('/parts/' + id), S.inv ? Promise.resolve(S.inv) : loadInv()]);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const p = d.part;
  const stocked = d.mode !== 'erp';
  const metaRow = (label, value) => h('div', { class: 'meta' }, h('span', { class: 'meta-label' }, label), value);
  const none = () => h('span', { class: 'muted' }, t('common.none'));
  const qty = d.stock.reduce((s, r) => s + r.qty, 0);
  const type = p.type_id ? inv.types.find((x) => x.id === p.type_id) : null;
  root.replaceChildren(
    h('p', {}, link('parts', { class: 'back-link' }, t('inv.back'))),
    h(
      'div',
      { class: 'panel doc-head' },
      h('div', { class: 'doc-title ticket-title' }, h('span', { class: 'mono strong', dir: 'ltr' }, p.code), p.active ? null : h('span', { class: 'chip chip-review' }, t('inv.inactive'))),
      h('h1', {}, partName(p)),
      h(
        'div',
        { class: 'actions' },
        d.can_manage ? h('button', { type: 'button', class: 'btn', onclick: () => partDialog(p, inv) }, icon('edit'), t('common.edit')) : null,
        d.can_manage && !d.moves.length && !d.requests.length ? h('button', { type: 'button', class: 'btn', onclick: () => simpleDelete(t('inv.delete_q', { name: partName(p) }), '/parts/' + p.id, t('inv.part_deleted'), () => navigate('assets/parts')) }, icon('trash'), t('common.delete')) : null,
      ),
      h(
        'div',
        { class: 'meta-grid' },
        metaRow(t('inv.unit'), h('span', {}, unitText(p.unit))),
        metaRow(t('inv.erp_code'), p.erp_code ? h('span', { class: 'mono', dir: 'ltr' }, p.erp_code) : none()),
        metaRow(t('inv.for_type'), type ? h('span', {}, pick(type.name_ar, type.name_en)) : none()),
        stocked ? metaRow(t('inv.qty'), h('span', { class: 'strong mono', dir: 'ltr' }, fmtQty(qty))) : null,
        stocked ? metaRow(t('inv.min'), p.min_qty ? h('span', { class: 'mono', dir: 'ltr' }, fmtQty(p.min_qty)) : none()) : null,
        stocked ? metaRow(t('inv.reorder'), p.reorder_qty ? h('span', { class: 'mono', dir: 'ltr' }, fmtQty(p.reorder_qty)) : none()) : null,
        metaRow(t('inv.avg_cost'), h('span', {}, fmtMoney(p.unit_cost))),
        p.notes ? metaRow(t('con.notes'), h('span', { class: 'pre-line' }, p.notes)) : null,
      ),
    ),
    stocked && d.stock.length
      ? h(
          'section',
          { class: 'panel' },
          h('h2', { class: 'section-title con-pad' }, t('inv.by_store')),
          h('div', { class: 'table-scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['inv.store', 'inv.qty'].map((c) => h('th', { scope: 'col' }, t(c))))), h('tbody', {}, d.stock.map((s) => h('tr', {}, h('td', {}, storeName(s)), h('td', {}, h('span', { class: 'mono strong' + (p.min_qty && s.qty <= p.min_qty ? ' qty-out' : ''), dir: 'ltr' }, fmtQty(s.qty)))))))),
        )
      : '',
    d.requests.length ? h('section', { class: 'panel' }, h('h2', { class: 'section-title con-pad' }, t('nav.requests')), requestsTable(d.requests, d.mode, null)) : '',
    h('section', { class: 'panel' }, h('h2', { class: 'section-title con-pad' }, t('nav.moves')), d.moves.length ? movesTable(d.moves, false) : h('p', { class: 'empty' }, t('inv.no_moves'))),
  );
}

export function movesTable(moves, withPart) {
  const cols = ['inv.when', 'inv.kind', ...(withPart ? ['inv.part'] : []), 'inv.store', 'inv.qty_moved', 'inv.unit_cost', 'inv.ref', 'inv.by'];
  return h(
    'div',
    { class: 'table-scroll' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', { scope: 'col' }, t(c))))),
      h(
        'tbody',
        {},
        moves.map((m) =>
          h(
            'tr',
            {},
            h('td', {}, timeEl(m.created_at)),
            h('td', {}, h('span', { class: 'chip ' + (MOVE_IN.includes(m.kind) ? 'chip-valid' : m.kind === 'adjust' ? 'chip-review' : 'chip-progress') }, t('inv.kind.' + m.kind))),
            withPart ? h('td', {}, link('parts/' + m.part_id, { class: 'mono', dir: 'ltr' }, m.code), h('div', { class: 'small' }, partName(m))) : null,
            h('td', {}, m.store_id ? storeName(m) : h('span', { class: 'muted' }, t('inv.erp_store'))),
            h('td', {}, qtyCell(m)),
            h('td', { class: 'nowrap' }, fmtMoney(m.unit_cost)),
            h('td', { class: 'wrap-cell' }, moveRef(m), m.note ? h('div', { class: 'muted small' }, m.note) : null),
            h('td', { class: 'small' }, m.user_name || ''),
          ),
        ),
      ),
    ),
  );
}

export async function movesPage(root, _param, alive) {
  const days = S.invDays || 30;
  let d;
  try {
    d = await api('/stock-moves?days=' + days);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const range = select([30, 90, 365].map((n) => [n, t('inv.days_' + n)]), days, { 'aria-label': t('inv.period') });
  range.addEventListener('change', () => {
    S.invDays = Number(range.value);
    render();
  });
  const kinds = [...new Set(d.moves.map((m) => m.kind))];
  const kind = select([['', t('inv.all_kinds')], ...kinds.map((k) => [k, t('inv.kind.' + k)])], '', { 'aria-label': t('inv.kind') });
  const search = input({ type: 'search', class: 'doc-search-input', placeholder: t('inv.search_ph'), 'aria-label': t('inv.search'), autocomplete: 'off' });
  const box = h('div', {});
  const shown = () => {
    const q = normText(search.value);
    return d.moves.filter((m) => (!kind.value || m.kind === kind.value) && (!q || normText([m.code, m.name_ar, m.name_en, m.doc_no, m.invoice_no, m.ticket_id ? '#' + m.ticket_id : ''].join(' ')).includes(q)));
  };
  const draw = () => {
    const rows = shown();
    box.replaceChildren(h('section', { class: 'panel' }, rows.length ? movesTable(rows, true) : h('p', { class: 'empty' }, t('inv.no_moves'))));
  };
  kind.addEventListener('change', draw);
  search.addEventListener('input', draw);
  const xlsx = () => {
    const ST = XLS_STYLE;
    downloadXlsx({
      fileName: 'stock-moves',
      sheet: t('nav.moves'),
      title: t('nav.moves'),
      head: ['inv.when', 'inv.kind', 'inv.code', 'inv.part', 'inv.store', 'inv.qty_moved', 'inv.unit_cost', 'inv.request', 'inv.doc_no', 'inv.invoice', 'inv.by'].map((k) => t(k)),
      widths: [18, 16, 14, 30, 20, 10, 12, 10, 16, 16, 20],
      rows: shown().map((m) => [
        { v: fmtTime(m.created_at), s: ST.time },
        { v: t('inv.kind.' + m.kind) },
        { v: m.code },
        { v: partName(m) },
        { v: m.store_id ? storeName(m) : t('inv.erp_store') },
        { v: m.qty, s: ST.num },
        { v: m.unit_cost, s: ST.num },
        { v: m.ticket_id ? '#' + m.ticket_id : '' },
        { v: m.doc_no || '' },
        { v: m.invoice_no || '' },
        { v: m.user_name || '' },
      ]),
    });
  };
  root.replaceChildren(
    h('p', {}, link('parts', { class: 'back-link' }, t('inv.back'))),
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('nav.moves')), h('p', { class: 'muted' }, t('inv.moves_sub'))), h('div', { class: 'actions' }, d.moves.length ? h('button', { type: 'button', class: 'btn', onclick: xlsx }, icon('download'), t('inv.export')) : null)),
    h('div', { class: 'filters' }, h('div', { class: 'doc-search', role: 'search' }, icon('search'), search), kind, range),
    box,
  );
  draw();
}

export function requestsTable(rows, mode, d) {
  const manage = d && d.can_manage;
  const cols = ['inv.req_no', 'inv.when', ...(d ? ['inv.part'] : []), 'inv.qty', ...(mode !== 'erp' ? ['inv.store'] : []), 'inv.reason', 'inv.state', 'inv.ext_ref', ...(manage ? ['common.actions'] : [])];
  return h(
    'div',
    { class: 'table-scroll' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', { scope: 'col' }, t(c))))),
      h(
        'tbody',
        {},
        rows.map((r) => {
          const live = r.status === 'open' || r.status === 'sent';
          return h(
            'tr',
            {},
            h('td', {}, h('span', { class: 'mono', dir: 'ltr' }, '#' + r.id)),
            h('td', {}, timeEl(r.created_at), r.user_name && r.user_name !== 'system' ? h('div', { class: 'muted small' }, r.user_name) : null),
            d ? h('td', {}, link('parts/' + r.part_id, { class: 'mono', dir: 'ltr' }, r.code), h('div', { class: 'small' }, partName(r))) : null,
            h('td', {}, h('span', { class: 'mono strong', dir: 'ltr' }, fmtQty(r.qty)), ' ', h('span', { class: 'muted small' }, unitText(r.unit))),
            mode !== 'erp' ? h('td', {}, r.store_id ? storeName(r) : h('span', { class: 'muted' }, t('common.none'))) : null,
            h('td', { class: 'wrap-cell' }, reqReason(r), r.note ? h('div', { class: 'muted small' }, r.note) : null),
            h('td', {}, reqChip(r)),
            h('td', {}, r.ext_ref ? h('span', { class: 'mono', dir: 'ltr' }, r.ext_ref) : h('span', { class: 'muted' }, t('common.none'))),
            manage
              ? h(
                  'td',
                  {},
                  live
                    ? h(
                        'div',
                        { class: 'row-actions' },
                        r.status === 'open' ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => requestStatusDialog(r, 'sent') }, t('inv.mark_sent')) : null,
                        mode === 'erp' && r.ticket_id ? h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => erpIssueDialog(r) }, t('inv.record_issue')) : null,
                        mode !== 'erp' && d.receipt_kinds.length && r.store_id ? h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => receiveDialog(d, r) }, t('inv.receive')) : null,
                        mode !== 'erp' ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => requestStatusDialog(r, 'done') }, t('inv.mark_done')) : null,
                        h('button', { type: 'button', class: 'btn btn-small', onclick: () => requestStatusDialog(r, 'cancelled') }, t('inv.cancel_req')),
                      )
                    : null,
                )
              : null,
          );
        }),
      ),
    ),
  );
}

export async function requestsPage(root, _param, alive) {
  const all = !!S.invAllReq;
  let d;
  let inv;
  try {
    [d, inv] = await Promise.all([api('/part-requests' + (all ? '?status=all' : '')), loadInv()]);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const which = select([['active', t('inv.req_active')], ['all', t('inv.req_all')]], all ? 'all' : 'active', { 'aria-label': t('inv.state') });
  which.addEventListener('change', () => {
    S.invAllReq = which.value === 'all';
    render();
  });
  root.replaceChildren(
    h('p', {}, link('parts', { class: 'back-link' }, t('inv.back'))),
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.requests')), h('p', { class: 'muted' }, t('inv.req_sub.' + d.mode))),
      h('div', { class: 'actions' }, d.can_manage ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => manualRequestDialog(inv) }, icon('plus'), t('inv.new_request')) : null),
    ),
    h('div', { class: 'filters' }, which),
    h('section', { class: 'panel' }, d.requests.length ? requestsTable(d.requests, d.mode, inv) : h('p', { class: 'empty' }, t('inv.no_requests'))),
  );
}

export function requestStatusDialog(r, status) {
  const ref = input({ type: 'text', maxlength: 50, dir: 'ltr', value: r.ext_ref || '' });
  openDialog({
    title: t(status === 'sent' ? 'inv.mark_sent' : status === 'done' ? 'inv.mark_done' : 'inv.cancel_req') + ' #' + r.id,
    body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, partName(r) + ' - ' + fmtQty(r.qty) + ' ' + unitText(r.unit)), status !== 'cancelled' ? field(t('inv.ext_ref'), ref, t('inv.ext_ref_hint')) : h('p', {}, t('inv.cancel_hint'))),
    submitLabel: t(status === 'sent' ? 'inv.mark_sent' : status === 'done' ? 'inv.mark_done' : 'inv.cancel_req'),
    danger: status === 'cancelled',
    onSubmit: async () => {
      await api('/part-requests/' + r.id, { method: 'PUT', body: { status, ext_ref: status !== 'cancelled' ? ref.value : undefined } });
      toast(t('inv.req_saved'));
      render();
    },
  });
}

export function erpIssueDialog(r) {
  const qty = input({ type: 'number', min: 0.001, step: 'any', required: true, dir: 'ltr', value: r.qty });
  const cost = input({ type: 'number', min: 0, step: 'any', required: true, dir: 'ltr' });
  openDialog({
    title: t('inv.record_issue') + ' #' + r.id,
    body: h('div', { class: 'stack' }, h('p', { class: 'notice' }, t('inv.record_issue_hint', { n: r.ticket_id })), h('p', { class: 'strong' }, partName(r)), h('div', { class: 'form-grid' }, field(t('inv.qty'), qty), field(t('inv.unit_cost'), cost, t('con.sar')))),
    submitLabel: t('inv.record_issue'),
    onSubmit: async () => {
      await api('/part-requests/' + r.id + '/issue', { method: 'POST', body: { qty: qty.value, unit_cost: cost.value } });
      toast(t('inv.issued'));
      render();
    },
  });
}

export function partSelect(parts, value, attrs) {
  return select([['', t('inv.pick_part')], ...parts.filter((p) => p.active !== 0 && p.active !== false).map((p) => [p.id, p.code + ' - ' + partName(p)])], value || '', attrs || {});
}

export function manualRequestDialog(d) {
  const part = partSelect(d.parts, '', { required: true });
  const stores = d.stores.filter((s) => s.active);
  const store = select([['', t('common.none')], ...stores.map((s) => [s.id, storeName(s)])], stores.length === 1 ? stores[0].id : '', {});
  const qty = input({ type: 'number', min: 0.001, step: 'any', required: true, dir: 'ltr' });
  const note = h('textarea', { rows: 2, maxlength: 300 });
  openDialog({
    title: t('inv.new_request'),
    body: h('div', { class: 'stack' }, field(t('inv.part'), part), h('div', { class: 'form-grid' }, field(t('inv.qty'), qty), d.mode !== 'erp' ? field(t('inv.store'), store) : h('div', {})), field(t('tk.note_optional'), note)),
    onSubmit: async () => {
      await api('/part-requests', { method: 'POST', body: { part_id: Number(part.value), store_id: store.value ? Number(store.value) : null, qty: qty.value, note: note.value } });
      toast(t('inv.req_saved'));
      render();
    },
  });
}

// A receipt of several lines. From a part request (req), it starts with that part and closes the request.
export function receiveDialog(d, req) {
  const stores = d.stores.filter((s) => s.active);
  const kind = select(d.receipt_kinds.map((k) => [k, t('inv.kind.' + k)]), d.mode === 'linked' ? 'transfer_in' : 'purchase', {});
  const store = select(stores.map((s) => [s.id, storeName(s)]), req && req.store_id ? req.store_id : stores[0] ? stores[0].id : '', { required: true });
  const docNo = input({ type: 'text', maxlength: 50, dir: 'ltr' });
  const invoice = input({ type: 'text', maxlength: 50, dir: 'ltr' });
  const vendor = select([['', t('common.none')], ...d.vendors.map((v) => [v.id, vendorName(v)])], '', {});
  const note = h('textarea', { rows: 2, maxlength: 300 });
  const lines = h('div', { class: 'stack inv-lines' });
  const addLine = (partId, q) => {
    const part = partSelect(d.parts, partId, { required: true, 'aria-label': t('inv.part') });
    const qty = input({ type: 'number', min: 0.001, step: 'any', required: true, dir: 'ltr', value: q || '', 'aria-label': t('inv.qty'), placeholder: t('inv.qty') });
    const cost = input({ type: 'number', min: 0, step: 'any', dir: 'ltr', 'aria-label': t('inv.unit_cost'), placeholder: t('inv.unit_cost') });
    const row = h('div', { class: 'inv-line' }, part, qty, cost, h('button', { type: 'button', class: 'btn btn-icon', title: t('common.delete'), 'aria-label': t('common.delete'), onclick: () => lines.children.length > 1 && row.remove() }, icon('trash')));
    row._get = () => ({ part_id: Number(part.value), qty: qty.value, unit_cost: cost.value === '' ? null : cost.value });
    lines.append(row);
  };
  addLine(req ? req.part_id : '', req ? req.qty : '');
  const docField = field(t('inv.doc_no'), docNo);
  const invField = field(t('inv.invoice'), invoice);
  const vendorField = field(t('con.vendor'), vendor);
  const sync = () => {
    const k = kind.value;
    docField.querySelector('label').textContent = t(k === 'transfer_in' ? 'inv.voucher' : 'inv.po');
    docField.hidden = k === 'opening';
    invField.hidden = vendorField.hidden = k !== 'purchase';
    docNo.required = k === 'transfer_in';
  };
  kind.addEventListener('change', sync);
  sync();
  openDialog({
    title: t('inv.receive'),
    body: h(
      'div',
      { class: 'stack' },
      d.mode === 'linked' ? h('p', { class: 'notice' }, t('inv.manual_hint')) : null,
      h('div', { class: 'form-grid' }, field(t('inv.kind'), kind), field(t('inv.store'), store)),
      h('div', { class: 'form-grid' }, docField, invField),
      vendorField,
      h('fieldset', { class: 'api-scope-set' }, h('legend', {}, t('inv.lines')), h('p', { class: 'hint' }, t('inv.cost_hint')), lines, h('button', { type: 'button', class: 'btn btn-small', onclick: () => addLine() }, icon('plus'), t('inv.add_line'))),
      field(t('tk.note_optional'), note),
    ),
    submitLabel: t('inv.receive'),
    onSubmit: async () => {
      await api('/stock-moves/receive', {
        method: 'POST',
        body: { kind: kind.value, store_id: Number(store.value), doc_no: docNo.value, invoice_no: kind.value === 'purchase' ? invoice.value : '', vendor_id: kind.value === 'purchase' && vendor.value ? Number(vendor.value) : null, note: note.value, request_ids: req ? [req.id] : [], lines: [...lines.children].map((r) => r._get()) },
      });
      toast(t('inv.received'));
      render();
    },
  });
}

// A stock count: every part held in the store, with the quantity on record; only the lines filled in are sent.
export function countDialog(d) {
  const stores = d.stores.filter((s) => s.active);
  const store = select(stores.map((s) => [s.id, storeName(s)]), stores[0].id, {});
  const list = h('div', { class: 'stack' });
  const inputs = new Map();
  const fill = () => {
    inputs.clear();
    const sid = Number(store.value);
    const rows = d.parts.filter((p) => p.active || p.stock.some((s) => s.store_id === sid && s.qty > 0));
    list.replaceChildren(
      rows.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['inv.part', 'inv.on_record', 'inv.counted'].map((c) => h('th', { scope: 'col' }, t(c))))),
              h(
                'tbody',
                {},
                rows.map((p) => {
                  const onRecord = (p.stock.find((s) => s.store_id === sid) || { qty: 0 }).qty;
                  const el = input({ type: 'number', min: 0, step: 'any', dir: 'ltr', class: 'count-input', 'aria-label': t('inv.counted') + ': ' + p.code });
                  inputs.set(p.id, el);
                  return h('tr', {}, h('td', {}, h('span', { class: 'mono', dir: 'ltr' }, p.code), ' ', partName(p)), h('td', {}, h('span', { class: 'mono', dir: 'ltr' }, fmtQty(onRecord))), h('td', {}, el));
                }),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('inv.empty')),
    );
  };
  store.addEventListener('change', fill);
  fill();
  openDialog({
    title: t('inv.count'),
    body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('inv.count_hint')), field(t('inv.store'), store), list),
    submitLabel: t('inv.count_save'),
    onSubmit: async () => {
      const lines = [...inputs].filter(([, el]) => el.value !== '').map(([part_id, el]) => ({ part_id, counted: el.value }));
      if (!lines.length) throw Object.assign(new Error('count_empty'), { code: 'count_empty' });
      const r = await api('/stock-moves/count', { method: 'POST', body: { store_id: Number(store.value), lines } });
      toast(t('inv.counted_done', { n: r.counted, d: r.differences }));
      render();
    },
  });
}

export function storesDialog(d) {
  const rows = d.stores;
  const team = (id) => (id ? d.teams.find((x) => x.id === id) : null);
  const dlg = openDialog({
    title: t('inv.stores'),
    body: h(
      'div',
      { class: 'stack' },
      h('p', { class: 'muted' }, t('inv.stores_hint.' + d.mode)),
      rows.length
        ? h(
            'ul',
            { class: 'plain-list' },
            rows.map((s) =>
              h(
                'li',
                { class: 'inv-store' },
                h('span', { class: 'strong' }, storeName(s)),
                s.erp_code ? h('span', { class: 'mono muted', dir: 'ltr' }, s.erp_code) : null,
                team(s.team_id) ? h('span', { class: 'muted small' }, pick(team(s.team_id).name_ar, team(s.team_id).name_en)) : null,
                s.active ? null : h('span', { class: 'chip chip-review' }, t('inv.inactive')),
                h('button', { type: 'button', class: 'btn btn-icon', title: t('common.edit'), 'aria-label': t('common.edit') + ': ' + storeName(s), onclick: () => (dlg.close(), storeDialog(s, d)) }, icon('edit')),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('inv.no_stores')),
    ),
    submitLabel: t('inv.add_store'),
    onSubmit: async () => {
      setTimeout(() => storeDialog(null, d));
    },
  });
}
export function storeDialog(s, d) {
  const ar = input({ type: 'text', required: true, maxlength: 100, dir: 'rtl', value: s ? s.name_ar : '' });
  const en = input({ type: 'text', required: true, maxlength: 100, dir: 'ltr', value: s ? s.name_en : '' });
  const erp = input({ type: 'text', maxlength: 40, dir: 'ltr', value: s ? s.erp_code || '' : '', pattern: '[A-Za-z0-9_./-]+' });
  const team = select([['', t('common.none')], ...d.teams.map((x) => [x.id, pick(x.name_ar, x.name_en)])], s ? s.team_id || '' : '', {});
  const active = input({ type: 'checkbox', checked: s ? !!s.active : true });
  const dlg = openDialog({
    title: t(s ? 'inv.edit_store' : 'inv.add_store'),
    body: h('div', { class: 'stack' }, field(t('inv.name_ar'), ar), field(t('inv.name_en'), en), h('div', { class: 'form-grid' }, field(t('inv.store_code'), erp, t('inv.store_code_hint')), field(t('tk.team'), team)), s ? checkField(t('inv.active'), active) : null),
    onSubmit: async () => {
      await api(s ? '/stores/' + s.id : '/stores', { method: s ? 'PUT' : 'POST', body: { name_ar: ar.value, name_en: en.value, erp_code: erp.value, team_id: team.value ? Number(team.value) : null, active: active.checked } });
      toast(t('inv.store_saved'));
      render();
    },
  });
  if (s && !s.move_count)
    dlg.querySelector('.dialog-actions').append(
      h('button', { type: 'button', class: 'btn btn-end', onclick: () => (dlg.close(), simpleDelete(t('inv.store_delete_q', { name: storeName(s) }), '/stores/' + s.id, t('inv.store_deleted'))) }, icon('trash'), t('common.delete')),
    );
}

// System admin only: how the stock is kept. Switching keeps every record.
export function modeDialog(current) {
  const name = 'inv-mode-' + nextId();
  const radios = INV_MODES.map((m) => {
    const r = input({ type: 'radio', name, value: m, checked: m === current, id: name + m });
    return h('label', { class: 'mode-opt', for: name + m }, r, h('span', { class: 'stack-tight' }, h('span', { class: 'strong' }, t('inv.mode.' + m)), h('span', { class: 'small muted' }, t('inv.mode_hint.' + m))));
  });
  openDialog({
    title: t('inv.mode'),
    body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('inv.mode_intro')), ...radios, h('p', { class: 'hint' }, t('inv.mode_keep'))),
    onSubmit: async () => {
      const picked = radios.map((l) => l.querySelector('input')).find((r) => r.checked);
      await api('/inventory/mode', { method: 'PUT', body: { mode: picked.value } });
      toast(t('inv.mode_saved'));
      render();
    },
  });
}
// What the spare parts cost, by department (cost center), device and request, for a range of days.
export async function costsPage(root, _param, alive) {
  // The hospital's day, so a part used after midnight there counts even if this device is in another time zone.
  const today = S.today || new Date().toLocaleDateString('en-CA');
  const from = S.costFrom || today.slice(0, 8) + '01';
  const to = S.costTo || today;
  let d;
  try {
    d = await api('/inventory/costs?from=' + from + '&to=' + to);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const fromEl = input({ type: 'date', value: from, 'aria-label': t('inv.from') });
  const toEl = input({ type: 'date', value: to, 'aria-label': t('inv.to') });
  const apply = () => {
    if (!fromEl.value || !toEl.value) return;
    S.costFrom = fromEl.value;
    S.costTo = toEl.value;
    render();
  };
  fromEl.addEventListener('change', apply);
  toEl.addEventListener('change', apply);
  const money = (n) => h('span', { class: 'nowrap' }, fmtMoney(n));
  const groupTable = (rows, first, name) =>
    h(
      'div',
      { class: 'table-scroll' },
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, [...first, 'inv.lines_n', 'inv.cost_dept', 'inv.cost_supplier'].map((c) => h('th', { scope: 'col' }, t(c))))),
        h('tbody', {}, rows.map((g) => h('tr', {}, ...name(g), h('td', {}, h('span', { class: 'mono' }, String(g.lines))), h('td', { class: 'strong' }, money(g.cost)), h('td', {}, g.covered ? money(g.covered) : h('span', { class: 'muted' }, t('common.none')))))),
      ),
    );
  const xlsx = () => {
    const ST = XLS_STYLE;
    downloadXlsx({
      fileName: 'maintenance-cost-' + d.from + '-' + d.to,
      sheet: t('nav.costs'),
      title: t('nav.costs') + ' ' + fmtDate(d.from) + ' - ' + fmtDate(d.to),
      head: ['inv.day', 'inv.cost_center', 'user.department', 'tk.asset', 'inv.request', 'inv.code', 'inv.part', 'inv.qty', 'inv.unit_cost', 'inv.cost', 'inv.charged_to'].map((k) => t(k)),
      widths: [12, 14, 24, 14, 10, 14, 30, 10, 12, 12, 22],
      rows: d.lines.map((m) => [
        { v: fmtDate(m.day) },
        { v: m.cost_center || '' },
        { v: pick(m.dept_ar, m.dept_en) || '' },
        { v: m.asset_tag || '' },
        { v: m.ticket_id ? '#' + m.ticket_id : '' },
        { v: m.code },
        { v: partName(m) },
        { v: m.qty, s: ST.num },
        { v: m.unit_cost, s: ST.num },
        { v: m.cost, s: ST.num },
        { v: m.covered ? t('inv.charged_supplier') + (m.vendor_ar ? ': ' + pick(m.vendor_ar, m.vendor_en) : '') : t('inv.charged_dept') },
      ]),
    });
  };
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.costs')), h('p', { class: 'muted' }, t('inv.costs_sub'))),
      h('div', { class: 'actions' }, d.lines.length ? h('button', { type: 'button', class: 'btn', onclick: xlsx }, icon('download'), t('inv.export')) : null),
    ),
    h('div', { class: 'filters' }, field(t('inv.from'), fromEl), field(t('inv.to'), toEl)),
    h(
      'div',
      { class: 'panel kpis' },
      h('div', { class: 'kpi' }, h('span', { class: 'kpi-num', dir: 'ltr' }, fmtMoney(d.total)), h('span', { class: 'kpi-label' }, t('inv.cost_dept'))),
      h('div', { class: 'kpi' }, h('span', { class: 'kpi-num', dir: 'ltr' }, fmtMoney(d.covered)), h('span', { class: 'kpi-label' }, t('inv.cost_supplier'))),
      h('div', { class: 'kpi' }, h('span', { class: 'kpi-num' }, String(d.lines.length)), h('span', { class: 'kpi-label' }, t('inv.lines_n'))),
    ),
    d.more ? h('p', { class: 'notice notice-warn' }, t('inv.costs_more')) : '',
    d.lines.length
      ? h(
          'div',
          { class: 'stack' },
          h('section', { class: 'panel' }, h('h2', { class: 'section-title con-pad' }, t('inv.by_dept')), groupTable(d.by_dept, ['user.department', 'inv.cost_center'], (g) => [h('td', { class: 'strong' }, pick(g.dept_ar, g.dept_en) || t('common.none')), h('td', {}, g.cost_center ? h('span', { class: 'mono', dir: 'ltr' }, g.cost_center) : h('span', { class: 'note note-near' }, t('inv.no_cost_center')))])),
          h('section', { class: 'panel' }, h('h2', { class: 'section-title con-pad' }, t('inv.by_asset')), groupTable(d.by_asset, ['tk.asset'], (g) => [h('td', {}, g.asset_id ? link('register/' + g.asset_id, {}, h('span', { class: 'mono', dir: 'ltr' }, g.tag), ' ' + assetName(g)) : h('span', { class: 'muted' }, t('inv.no_asset')))])),
        )
      : h('section', { class: 'panel' }, h('p', { class: 'empty' }, t('inv.no_costs'))),
  );
}

// On a request: the parts used, given back, and asked for.
export async function ticketParts(box, tk) {
  let d;
  try {
    d = await api('/tickets/' + tk.id + '/parts');
  } catch {
    box.replaceChildren();
    return;
  }
  if (!d.can_issue && !d.moves.length && !d.requests.length) return box.replaceChildren();
  const stocked = d.mode !== 'erp';
  const issues = d.moves.filter((m) => m.kind === 'issue');
  const left = (m) => Math.round((-m.qty - m.returned) * 1000) / 1000;
  box.replaceChildren(
    h(
      'section',
      { class: 'panel pad stack' },
      h('div', { class: 'section-head' }, h('h2', {}, t('inv.ticket_title')), h('div', { class: 'actions' }, d.can_issue && stocked ? h('button', { type: 'button', class: 'btn btn-primary btn-small', onclick: () => issueDialog(tk, d) }, icon('minus'), t('inv.issue')) : null, d.can_issue ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => askPartDialog(tk, d) }, icon('plus'), t('inv.ask')) : null)),
      issues.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['inv.part', 'inv.qty', 'inv.store', 'inv.cost', 'inv.by', ...(d.can_issue ? ['common.actions'] : [])].map((c) => h('th', { scope: 'col' }, t(c))))),
              h(
                'tbody',
                {},
                issues.map((m) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, h('span', { class: 'mono', dir: 'ltr' }, m.code), ' ', partName(m), m.covered ? h('div', { class: 'note note-near' }, t('inv.covered')) : null),
                    h('td', {}, h('span', { class: 'mono strong', dir: 'ltr' }, fmtQty(-m.qty)), ' ', unitText(m.unit), m.returned ? h('div', { class: 'muted small' }, t('inv.returned_n', { n: fmtQty(m.returned) })) : null),
                    h('td', {}, m.store_id ? storeName(m) : h('span', { class: 'muted' }, t('inv.erp_store'))),
                    h('td', { class: 'nowrap' }, fmtMoney(Math.round(left(m) * m.unit_cost * 100) / 100)),
                    h('td', { class: 'small' }, m.user_name, h('div', { class: 'muted' }, fmtTime(m.created_at))),
                    d.can_issue ? h('td', {}, left(m) > 0 ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => returnDialog(tk, m, left(m)) }, t('inv.return')) : null) : null,
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'muted' }, t('inv.ticket_none')),
      issues.length ? h('p', { class: 'strong' }, t('inv.ticket_cost') + ': ' + fmtMoney(d.cost), d.covered ? h('span', { class: 'muted' }, ' - ' + t('inv.cost_supplier') + ': ' + fmtMoney(d.covered)) : null) : null,
      d.requests.length ? h('div', { class: 'stack' }, h('h3', { class: 'section-title' }, t('inv.ticket_requests')), h('ul', { class: 'plain-list' }, d.requests.map((r) => h('li', {}, reqChip(r), ' ', h('span', { class: 'mono', dir: 'ltr' }, r.code), ' ', partName(r), ' - ', fmtQty(r.qty) + ' ' + unitText(r.unit), r.ext_ref ? h('span', { class: 'muted small' }, ' (' + r.ext_ref + ')') : null)))) : null,
    ),
  );
}
export async function issueDialog(tk, d) {
  let pickData;
  try {
    pickData = await api('/inventory/pick');
  } catch (e) {
    return toast(errText(e), true);
  }
  const inStock = pickData.parts.filter((p) => p.stock.length);
  if (!inStock.length) return toast(t('inv.none_in_stock'), true);
  const storeById = new Map(pickData.stores.map((s) => [s.id, s]));
  const opts = inStock.flatMap((p) => p.stock.map((s) => [p.id + ':' + s.store_id, p.code + ' - ' + partName(p) + ' (' + fmtQty(s.qty) + ' ' + unitText(p.unit) + (pickData.stores.length > 1 ? ' - ' + storeName(storeById.get(s.store_id)) : '') + ')']));
  const part = select([['', t('inv.pick_part')], ...opts], '', { required: true });
  const qty = input({ type: 'number', min: 0.001, step: 'any', required: true, dir: 'ltr', value: 1 });
  const note = h('textarea', { rows: 2, maxlength: 300 });
  openDialog({
    title: t('inv.issue') + ' - #' + tk.id,
    body: h('div', { class: 'stack' }, field(t('inv.part'), part), field(t('inv.qty'), qty), field(t('tk.note_optional'), note)),
    submitLabel: t('inv.issue'),
    onSubmit: async () => {
      const [partId, storeId] = part.value.split(':').map(Number);
      await api('/tickets/' + tk.id + '/parts', { method: 'POST', body: { part_id: partId, store_id: storeId, qty: qty.value, note: note.value } });
      toast(t('inv.issued'));
      render();
    },
  });
}
export function returnDialog(tk, m, max) {
  const qty = input({ type: 'number', min: 0.001, max, step: 'any', required: true, dir: 'ltr', value: max });
  const note = h('textarea', { rows: 2, maxlength: 300 });
  openDialog({
    title: t('inv.return') + ': ' + partName(m),
    body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, t(m.store_id ? 'inv.return_hint' : 'inv.return_hint_erp')), field(t('inv.qty'), qty), field(t('tk.note_optional'), note)),
    submitLabel: t('inv.return'),
    onSubmit: async () => {
      await api('/tickets/' + tk.id + '/parts/' + m.id + '/return', { method: 'POST', body: { qty: qty.value, note: note.value } });
      toast(t('inv.returned'));
      render();
    },
  });
}
export async function askPartDialog(tk, d) {
  let pickData;
  try {
    pickData = await api('/inventory/pick');
  } catch (e) {
    return toast(errText(e), true);
  }
  if (!pickData.parts.length) return toast(t('inv.empty'), true);
  const part = partSelect(pickData.parts, '', { required: true });
  const stores = pickData.stores;
  const store = select(stores.map((s) => [s.id, storeName(s)]), stores[0] ? stores[0].id : '', {});
  const qty = input({ type: 'number', min: 0.001, step: 'any', required: true, dir: 'ltr', value: 1 });
  const note = h('textarea', { rows: 2, maxlength: 300 });
  openDialog({
    title: t('inv.ask') + ' - #' + tk.id,
    body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('inv.ask_hint.' + d.mode)), field(t('inv.part'), part), h('div', { class: 'form-grid' }, field(t('inv.qty'), qty), d.mode !== 'erp' && stores.length > 1 ? field(t('inv.store'), store) : h('div', {})), field(t('tk.note_optional'), note)),
    submitLabel: t('inv.ask'),
    onSubmit: async () => {
      await api('/tickets/' + tk.id + '/part-requests', { method: 'POST', body: { part_id: Number(part.value), store_id: d.mode !== 'erp' && store.value ? Number(store.value) : null, qty: qty.value, note: note.value } });
      toast(t('inv.req_saved'));
      render();
    },
  });
}

// With `choices` (asset -> kinds it still lacks) the dialog starts by picking the device.
export function planDialog(a, p, kinds, choices) {
  const kind = select((p ? [p.kind] : kinds).map((k) => [k, t('pm.kind.' + k)]), p ? p.kind : kinds[0], { disabled: !!p });
  const assetSel = choices
    ? select(
        [['', t('pm.pick_asset')], ...choices.map(([x]) => [x.id, x.tag + ' - ' + pick(x.name_ar, x.name_en)])],
        '',
        {
          required: true,
          onchange: () => {
            const c = choices.find(([x]) => String(x.id) === assetSel.value);
            kind.replaceChildren(...(c ? c[1] : PM_KINDS).map((k) => h('option', { value: k }, t('pm.kind.' + k))));
          },
        },
      )
    : null;
  const every = select([1, 2, 3, 4, 6, 12, 24, 36].map((n) => [n, tn('pm.every_n', n)]), p ? p.every_months : 6, {});
  if (p && ![1, 2, 3, 4, 6, 12, 24, 36].includes(p.every_months)) every.append(h('option', { value: p.every_months, selected: true }, tn('pm.every_n', p.every_months)));
  const next = input({ type: 'date', required: true, value: p ? p.next_due : '' });
  const lead = input({ type: 'number', min: 0, max: 90, step: 1, required: true, inputmode: 'numeric', value: p ? p.lead_days : 7 });
  const checklist = h('textarea', { rows: 5, maxlength: 3000, placeholder: t('pm.checklist_ph') }, p ? p.checklist || '' : '');
  const active = input({ type: 'checkbox', checked: p ? !!p.active : true });
  openDialog({
    title: a ? t(p ? 'pm.edit' : 'pm.add') + ' - ' + a.tag : t('pm.new'),
    body: h(
      'div',
      { class: 'stack' },
      assetSel ? field(t('pm.asset'), assetSel) : null,
      h('div', { class: 'form-grid' }, field(t('pm.kind'), kind), field(t('pm.every'), every)),
      h('div', { class: 'form-grid' }, field(t('pm.next'), next), field(t('pm.lead'), lead, t('pm.lead_hint'))),
      field(t('pm.checklist'), checklist, t('pm.checklist_hint')),
      checkField(t('pm.active'), active),
    ),
    onSubmit: async () => {
      const body = { kind: kind.value, every_months: Number(every.value), next_due: next.value, lead_days: Number(lead.value), checklist: checklist.value, active: active.checked };
      await api(p ? '/pm-plans/' + p.id : '/assets/' + (a ? a.id : assetSel.value) + '/plans', { method: p ? 'PUT' : 'POST', body });
      toast(t('tk.saved'));
      render();
    },
  });
}

// The maintenance schedule: every plan by its next date, with the on-time rate.
export async function pmPage(root, _param, alive) {
  let d;
  try {
    d = await api('/pm');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const { plans, today } = d;
  const live = plans.filter((p) => p.active && p.asset_status === 'in_service');
  const tabs = [
    ['overdue', (p) => p.next_due < today],
    ['soon', (p) => p.next_due >= today && daysTo(p.next_due, today) <= 30],
    ['open', (p) => !!p.open_ticket_id],
    ['all', () => true],
  ];
  S.pmTab = S.pmTab || 'soon';
  const box = h('div', {});
  const seeDesk = access('desk') !== 'none';
  const draw = () => {
    const test = tabs.find(([k]) => k === S.pmTab)[1];
    const rows = (S.pmTab === 'all' ? plans : live).filter(test);
    box.replaceChildren(
      h(
        'div',
        { class: 'tabs', role: 'tablist' },
        tabs.map(([k, f]) =>
          h(
            'button',
            { type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(S.pmTab === k), onclick: () => ((S.pmTab = k), draw()) },
            t('pm.tab.' + k),
            ' ',
            h('span', { class: 'muted small' }, String((k === 'all' ? plans : live).filter(f).length)),
          ),
        ),
      ),
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
                h('thead', {}, h('tr', {}, ['pm.next', 'ast.tag', 'ast.name', 'pm.kind', 'pm.every', 'tk.team', 'user.department', 'pm.order'].map((c) => h('th', { scope: 'col' }, t(c))))),
                h(
                  'tbody',
                  {},
                  rows.map((p) =>
                    h(
                      'tr',
                      {},
                      h('td', {}, p.active ? dueChip(p.next_due, today) : h('span', { class: 'muted' }, t('pm.paused'))),
                      h('td', {}, link('register/' + p.asset_id, { class: 'btn btn-small mono', dir: 'ltr' }, p.tag)),
                      h('td', { class: 'wrap-cell' }, h('div', { class: 'strong' }, pick(p.name_ar, p.name_en)), p.risk === 'high' ? h('span', { class: 'note note-expired' }, t('ast.risk.high')) : null),
                      h('td', {}, t('pm.kind.' + p.kind)),
                      h('td', {}, tn('pm.every_n', p.every_months)),
                      h('td', {}, pick(p.team_ar, p.team_en) || t('common.none')),
                      h('td', {}, pick(p.dept_ar, p.dept_en) || t('common.none')),
                      h('td', {}, p.open_ticket_id ? (seeDesk ? link('desk/tickets/' + p.open_ticket_id, { class: 'btn btn-small' }, '#' + p.open_ticket_id) : '#' + p.open_ticket_id) : h('span', { class: 'muted small' }, tn('pm.opens', p.lead_days))),
                    ),
                  ),
                ),
              ),
            )
          : plans.length
            ? h('p', { class: 'empty' }, t('pm.tab_empty'))
            : h('div', { class: 'empty' }, h('p', {}, t(d.can_manage ? 'pm.empty_manage' : 'pm.empty')), d.can_manage ? h('button', { type: 'button', class: 'btn btn-primary', onclick: newPlan }, icon('plus'), t('pm.new')) : null),
      ),
    );
  };
  const runBtn = d.can_manage
    ? h(
        'button',
        {
          type: 'button',
          class: 'btn',
          onclick: async (ev) => {
            ev.currentTarget.disabled = true;
            try {
              const r = await api('/pm/run', { method: 'POST', body: {} });
              toast(tn('pm.run_done', r.opened));
              render();
            } catch (e) {
              toast(errText(e), true);
              ev.target.disabled = false;
            }
          },
        },
        t('pm.run'),
      )
    : null;
  // Devices in service that still lack at least one kind of plan.
  const newPlan = async () => {
    try {
      const { assets } = await api('/assets');
      const choices = assets
        .filter((x) => x.status === 'in_service')
        .map((x) => [x, PM_KINDS.filter((k) => !plans.some((q) => q.asset_id === x.id && q.kind === k))])
        .filter(([, ks]) => ks.length);
      if (!choices.length) return toast(t('pm.no_free_assets'), true);
      planDialog(null, null, PM_KINDS, choices);
    } catch (e) {
      toast(errText(e), true);
    }
  };
  const newBtn = d.can_manage ? h('button', { type: 'button', class: 'btn btn-primary', onclick: newPlan }, icon('plus'), t('pm.new')) : null;
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('nav.pm')), h('p', { class: 'muted' }, t('pm.sub'))), d.can_manage ? h('div', { class: 'actions' }, newBtn, runBtn) : null),
    kpiRow([
      ['ast.k_overdue', live.filter((p) => p.next_due < today).length],
      ['ast.k_soon', live.filter((p) => p.next_due >= today && daysTo(p.next_due, today) <= 30).length],
      ['pm.k_open', plans.filter((p) => p.open_ticket_id).length],
      ['ast.k_compliance', compliancePct(d.compliance)],
      ['pm.k_done', d.compliance.n],
    ]),
    h('p', { class: 'hint' }, t('pm.how')),
    box,
  );
  draw();
}

// Device types (managers): each one names the team that looks after the device.
export async function devTypesPage(root, _param, alive) {
  let data;
  try {
    data = await api('/assets');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  S.assetMeta = data;
  const teams = data.departments.filter((d) => d.is_team);
  const teamName = (id) => deptName(data.departments.find((d) => d.id === id)) || t('common.none');
  const label = (x) => pick(x.name_ar, x.name_en);
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.devtypes')), h('p', { class: 'muted' }, t('dt.sub'))),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => devTypeDialog(null, teams) }, icon('plus'), t('dt.add'))),
    ),
    teams.length ? '' : h('p', { class: 'notice notice-warn' }, t('cat.no_teams')),
    h(
      'section',
      { class: 'panel' },
      data.types.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['dept.name_ar', 'dept.name_en', 'tk.team', 'user.status', 'dt.count', 'common.actions'].map((c) => h('th', { scope: 'col' }, t(c))))),
              h(
                'tbody',
                {},
                data.types.map((x) =>
                  h(
                    'tr',
                    {},
                    h('td', { class: 'strong', dir: 'rtl' }, x.name_ar),
                    h('td', { dir: 'ltr' }, x.name_en),
                    h('td', {}, teamName(x.team_id)),
                    h('td', {}, x.active ? t('field.active') : h('span', { class: 'muted' }, t('user.inactive'))),
                    h('td', {}, h('span', { class: 'mono' }, String(x.asset_count))),
                    h(
                      'td',
                      {},
                      h(
                        'div',
                        { class: 'row-actions' },
                        h('button', { type: 'button', class: 'btn btn-icon', title: t('common.edit'), 'aria-label': t('common.edit') + ': ' + label(x), onclick: () => devTypeDialog(x, teams) }, icon('edit')),
                        h('button', { type: 'button', class: 'btn btn-icon', title: t('common.delete'), 'aria-label': t('common.delete') + ': ' + label(x), onclick: () => simpleDelete(t('dt.delete_q', { name: label(x) }), '/asset-types/' + x.id, t('dt.deleted')) }, icon('trash')),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('dt.empty')),
    ),
  );
}
export function devTypeDialog(x, teams) {
  if (!teams.length) {
    toast(t('cat.no_teams'), true);
    return;
  }
  const ar = input({ type: 'text', required: true, maxlength: 100, dir: 'rtl', value: x ? x.name_ar : '', placeholder: 'جهاز تنفس صناعي' });
  const en = input({ type: 'text', required: true, maxlength: 100, dir: 'ltr', value: x ? x.name_en : '', placeholder: 'Ventilator' });
  const team = select(teams.map((d) => [d.id, deptName(d)]), x ? x.team_id : teams[0].id, {});
  const active = input({ type: 'checkbox', checked: x ? !!x.active : true });
  openDialog({
    title: t(x ? 'dt.edit' : 'dt.add'),
    body: h('div', { class: 'stack' }, field(t('dept.name_ar'), ar), field(t('dept.name_en'), en), field(t('tk.team'), team, t('dt.team_hint')), checkField(t('cat.active'), active)),
    onSubmit: async () => {
      await api(x ? '/asset-types/' + x.id : '/asset-types', { method: x ? 'PUT' : 'POST', body: { name_ar: ar.value, name_en: en.value, team_id: Number(team.value), active: active.checked } });
      toast(t('tk.saved'));
      render();
    },
  });
}

/* Excel: template and import */

export const ASSET_COLS = [
  ['tag', 'ast.tag', /tag|^رقم|asset/],
  ['name_ar', 'dept.name_ar', /بالعربي|arabic|name_ar/],
  ['name_en', 'dept.name_en', /نجليز|english|name_en/],
  ['type', 'ast.type', /نوع|type|category/],
  ['dept', 'user.department', /قسم|اداره|dep/],
  ['loc', 'tk.location', /مكان|موقع|loc|room/],
  ['manufacturer', 'ast.maker', /مصنع|شركه|manuf|make|brand/],
  ['model', 'ast.model', /موديل|طراز|model/],
  ['serial_no', 'ast.serial', /تسلسل|سيريال|serial|s\/n/],
  ['purchase_date', 'ast.bought', /شراء|تركيب|purchase|install/],
  ['warranty_end', 'ast.warranty', /ضمان|warrant/],
  ['risk', 'ast.risk', /خطور|risk/],
  ['ppm_months', 'xls.ppm_months', /صيانه.*(شهر|كل)|ppm.*(month|every)|ppm interval/],
  ['ppm_next', 'xls.ppm_next', /صيانه.*(قادم|تاريخ)|next ppm|ppm.*(next|date|due)/],
  ['cal_months', 'xls.cal_months', /معاير.*(شهر|كل)|calib.*(month|every)|calibration interval/],
  ['cal_next', 'xls.cal_next', /معاير.*(قادم|تاريخ)|next calib|calib.*(next|date|due)/],
];
export function assetTemplate() {
  const m = S.assetMeta;
  const cat = m.types.find((x) => x.active);
  const dep = m.departments.find((d) => !d.is_team) || m.departments[0];
  downloadXlsx({
    fileName: 'assets-template',
    sheet: t('nav.register'),
    title: null,
    head: ASSET_COLS.map(([, k]) => t(k)),
    widths: [14, 26, 24, 20, 22, 20, 16, 14, 16, 14, 14, 10, 14, 16, 14, 16],
    rows: [[
      { v: 'BME-0001' }, { v: 'جهاز تنفس صناعي' }, { v: 'Ventilator' }, { v: cat ? pick(cat.name_ar, cat.name_en) : '' }, { v: dep ? pick(dep.name_ar, dep.name_en) : '' }, { v: '' },
      { v: 'Drager' }, { v: 'V500' }, { v: 'SN12345' }, { v: '2024-01-15' }, { v: '2027-01-15' }, { v: t('ast.risk.high') }, { v: '6' }, { v: '2026-12-01' }, { v: '12' }, { v: '2027-03-01' },
    ]],
  });
}
// Dates from Excel come as day numbers, as 2026-12-01, or as 01/12/2026 (day first).
export function sheetDate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^\d{4,5}(\.\d+)?$/.test(s) && Number(s) > 20000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000).toISOString().slice(0, 10);
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}
export function assetRows(sheet) {
  const m = S.assetMeta;
  const rows = sheet.filter((r) => r.some(Boolean));
  if (!rows.length) return [];
  const head = rows[0];
  const col = {};
  const used = new Set();
  for (const [key, , re] of ASSET_COLS) {
    const i = head.findIndex((x, j) => !used.has(j) && (re.test(String(x || '').toLowerCase()) || re.test(normText(x))));
    col[key] = i;
    if (i >= 0) used.add(i);
  }
  const hasHead = col.tag >= 0 && (col.name_ar >= 0 || col.name_en >= 0);
  if (!hasHead) ASSET_COLS.forEach(([key], i) => (col[key] = i));
  const byName = (list) => {
    const map = new Map();
    for (const x of list) {
      map.set(normText(x.name_ar), x.id);
      map.set(normText(x.name_en), x.id);
    }
    return (v) => (v ? map.get(normText(v)) || null : null);
  };
  const typeOf = byName(m.types);
  const depOf = byName(m.departments);
  const locOf = byName(m.locations);
  const cell = (r, k) => (col[k] >= 0 ? String(r[col[k]] || '').trim() : '');
  const riskOf = (v) => {
    const s = normText(v).toLowerCase();
    if (/high|عالي|مرتفع/.test(s)) return 'high';
    if (/low|منخفض/.test(s)) return 'low';
    return 'medium';
  };
  return rows.slice(hasHead ? 1 : 0).map((r) => ({
    tag: cell(r, 'tag').replace(/\.0$/, ''),
    name_ar: cell(r, 'name_ar'),
    name_en: cell(r, 'name_en'),
    type_id: typeOf(cell(r, 'type')),
    type_text: cell(r, 'type'),
    department_id: depOf(cell(r, 'dept')),
    location_id: locOf(cell(r, 'loc')),
    manufacturer: cell(r, 'manufacturer'),
    model: cell(r, 'model'),
    serial_no: cell(r, 'serial_no'),
    purchase_date: sheetDate(cell(r, 'purchase_date')),
    warranty_end: sheetDate(cell(r, 'warranty_end')),
    risk: riskOf(cell(r, 'risk')),
    ppm_months: Number(cell(r, 'ppm_months')) || null,
    ppm_next: sheetDate(cell(r, 'ppm_next')),
    cal_months: Number(cell(r, 'cal_months')) || null,
    cal_next: sheetDate(cell(r, 'cal_next')),
  }));
}
export function assetImportDialog() {
  const file = input({ type: 'file', accept: '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv', required: true });
  const preview = h('p', { class: 'muted small', 'aria-live': 'polite' });
  let parsed = null;
  const usable = (r) => r.tag && r.name_ar && r.name_en && r.type_id;
  file.addEventListener('change', async () => {
    parsed = null;
    preview.textContent = '';
    const f = file.files && file.files[0];
    if (!f) return;
    try {
      parsed = assetRows(await readSheet(f));
      const good = parsed.filter(usable);
      const noType = parsed.filter((r) => r.tag && !r.type_id).length;
      preview.textContent = t('ast.preview', { n: tn('ast.count', good.length) }) + (noType ? ' ' + t('ast.preview_type', { n: noType }) : '');
    } catch (e) {
      preview.textContent = errText(e);
    }
  });
  openDialog({
    title: t('ast.import'),
    body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('ast.import_help')), field(t('staff.file'), file), preview),
    submitLabel: t('ast.import'),
    onSubmit: async () => {
      if (!parsed) throw new ApiError('bad_sheet');
      const good = parsed.filter(usable).map(({ type_text, ...r }) => r);
      if (!good.length) throw new ApiError('bad_sheet');
      const total = { added: 0, updated: 0, plans: 0, skipped: 0 };
      for (let i = 0; i < good.length; i += 500) {
        const r = await api('/assets/import', { method: 'POST', body: { rows: good.slice(i, i + 500) } });
        for (const k of Object.keys(total)) total[k] += r[k];
      }
      toast(t('ast.imported', total));
      render();
    },
  });
}
