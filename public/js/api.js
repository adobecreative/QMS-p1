// The integration API keys page.
import { render } from '../app.js';
import { ApiError, S, h, icon, t } from './core.js';
import { fmtStamp, normText } from './docs.js';
import { api, checkField, errText, errorBox, field, input, openDialog, toast } from './offline.js';
import { simpleDelete, timeEl } from './tickets.js';

/* --------------------------- integration (API) -------------------------- */

// Keys other systems (HR, the hospital information system) use to reach /api/v1, and how to use them.
export const API_DOCS = [
  ['GET', '/ping', '', 'api.ep.ping'],
  ['GET', '/summary', '', 'api.ep.summary'],
  ['GET', '/departments', '', 'api.ep.departments'],
  ['GET', '/locations', '', 'api.ep.locations'],
  ['GET', '/categories', '', 'api.ep.categories'],
  ['GET', '/staff', 'staff', 'api.ep.staff_get'],
  ['POST', '/staff', 'staff', 'api.ep.staff_post'],
  ['POST', '/tickets', 'tickets_write', 'api.ep.tickets_post'],
  ['GET', '/tickets?status=open&since=…', 'tickets_read', 'api.ep.tickets_get'],
  ['GET', '/tickets/{id}', 'tickets_read', 'api.ep.ticket_get'],
  ['GET', '/assets?status=…&after_id=…', 'assets_read', 'api.ep.assets_get'],
  ['GET', '/assets/{tag}', 'assets_read', 'api.ep.asset_get'],
  ['GET', '/parts', 'inventory', 'api.ep.parts_get'],
  ['POST', '/parts', 'inventory', 'api.ep.parts_post'],
  ['GET', '/stores', 'inventory', 'api.ep.stores_get'],
  ['GET', '/stock', 'inventory', 'api.ep.stock_get'],
  ['POST', '/receipts', 'inventory', 'api.ep.receipts_post'],
  ['GET', '/part-requests?status=active&since=…', 'inventory', 'api.ep.requests_get'],
  ['POST', '/part-requests/{id}', 'inventory', 'api.ep.request_post'],
  ['POST', '/part-requests/{id}/issue', 'inventory', 'api.ep.request_issue'],
  ['GET', '/costs?from=…&to=…', 'costs_read', 'api.ep.costs_get'],
  ['GET', '/documents?after_id=…', 'docs_read', 'api.ep.documents_get'],
  ['GET', '/documents/{id}/pdf', 'docs_read', 'api.ep.document_pdf'],
];
export const keyName = (k) => (S.lang === 'ar' ? k.name_ar : k.name_en);
export async function apiPage(root, _param, alive) {
  let d;
  try {
    d = await api('/api-keys');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const code = (text) => h('pre', { class: 'api-code', dir: 'ltr' }, text);
  const copyBtn = (text) =>
    h('button', {
      type: 'button',
      class: 'btn',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast(t('tk.copied'));
        } catch {
          toast(text);
        }
      },
    }, t('tk.copy'));
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.api')), h('p', { class: 'muted' }, t('api.sub'))),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => apiKeyDialog(null, d.scopes) }, icon('plus'), t('api.add'))),
    ),
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('api.keys')), h('span', { class: 'muted small' }, t('api.limit', { n: d.per_hour })))),
      d.keys.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['api.name', 'api.key', 'api.scopes', 'user.status', 'api.last_used', 'common.actions'].map((c) => h('th', { scope: 'col' }, t(c))))),
              h(
                'tbody',
                {},
                d.keys.map((k) =>
                  h(
                    'tr',
                    {},
                    h('td', { class: 'strong' }, keyName(k), h('div', { class: 'muted small' }, t('api.made_by', { name: k.created_by || '', date: fmtStamp(k.created_at) }))),
                    h('td', {}, h('span', { class: 'mono', dir: 'ltr' }, k.prefix + '…')),
                    h('td', {}, h('div', { class: 'api-scopes' }, k.scopes.map((s) => h('span', { class: 'chip' }, t('api.scope.' + s))))),
                    h('td', {}, k.active ? h('span', { class: 'chip chip-valid' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('field.active')) : h('span', { class: 'chip chip-review' }, t('user.inactive'))),
                    h('td', {}, timeEl(k.last_used_at), k.used_n ? h('div', { class: 'muted small' }, t('api.calls', { n: k.used_n })) : null),
                    h(
                      'td',
                      {},
                      h(
                        'div',
                        { class: 'row-actions' },
                        h('button', { type: 'button', class: 'btn btn-icon', title: t('common.edit'), 'aria-label': t('common.edit') + ': ' + keyName(k), onclick: () => apiKeyDialog(k, d.scopes) }, icon('edit')),
                        h('button', { type: 'button', class: 'btn btn-icon', title: t('common.delete'), 'aria-label': t('common.delete') + ': ' + keyName(k), onclick: () => simpleDelete(t('api.delete_q', { name: keyName(k) }), '/api-keys/' + k.id, t('api.deleted')) }, icon('trash')),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('api.empty')),
    ),
    h(
      'section',
      { class: 'panel api-doc' },
      h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('api.doc')))),
      h('div', { class: 'stack' },
        h('p', {}, t('api.doc_base')),
        h('div', { class: 'copy-row api-base' }, input({ type: 'text', readonly: true, value: d.base, dir: 'ltr', onfocus: (e) => e.target.select() }), copyBtn(d.base)),
        h('p', {}, t('api.doc_auth')),
        code('Authorization: Bearer fms_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'),
        h(
          'div',
          { class: 'table-scroll' },
          h(
            'table',
            { class: 'api-table' },
            h('thead', {}, h('tr', {}, ['api.method', 'api.path', 'api.scope', 'api.what'].map((c) => h('th', { scope: 'col' }, t(c))))),
            h('tbody', {}, API_DOCS.map(([m, p, s, k]) => h('tr', {}, h('td', {}, h('span', { class: 'mono api-method api-' + m.toLowerCase() }, m)), h('td', {}, h('span', { class: 'mono', dir: 'ltr' }, p)), h('td', {}, s ? t('api.scope.' + s) : h('span', { class: 'muted' }, t('api.any_key'))), h('td', {}, t(k))))),
          ),
        ),
        h('h3', {}, t('api.ex_staff')),
        h('p', { class: 'muted small' }, t('api.ex_staff_hint')),
        code(`curl -X POST ${d.base}/staff \\
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \\
  -d '{"full": true, "rows": [
        {"emp_no": "1001", "name": "أحمد علي", "name_en": "Ahmed Ali",
         "department": "Nursing", "phone": "0500000000"}
      ]}'`),
        h('h3', {}, t('api.ex_ticket')),
        h('p', { class: 'muted small' }, t('api.ex_ticket_hint')),
        code(`curl -X POST ${d.base}/tickets \\
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \\
  -d '{"emp_no": "1001", "category_id": 3, "location_id": 12,
       "description": "تسريب مياه في الغرفة 12", "patient_impact": false}'`),
        h('h3', {}, t('api.ex_follow')),
        h('p', { class: 'muted small' }, t('api.ex_follow_hint')),
        code(`curl "${d.base}/tickets?since=2026-01-01T00:00:00Z&limit=200" \\
  -H "Authorization: Bearer $KEY"`),
        h('h3', {}, t('api.errors')),
        h('p', { class: 'muted small' }, t('api.errors_hint')),
        code(`401 {"error": "api_key_invalid"}   403 {"error": "api_scope"}
400 {"error": "type_required"}     429 {"error": "too_many_requests"}`),
      ),
    ),
  );
}
export function apiKeyDialog(k, scopes) {
  const ar = input({ type: 'text', required: true, maxlength: 100, dir: 'rtl', value: k ? k.name_ar : '', placeholder: t('api.name_ar_ph') });
  const en = input({ type: 'text', required: true, maxlength: 100, dir: 'ltr', value: k ? k.name_en : '', placeholder: 'HR' });
  const boxes = scopes.map((s) => [s, input({ type: 'checkbox', checked: k ? k.scopes.includes(s) : false })]);
  const active = input({ type: 'checkbox', checked: k ? k.active : true });
  openDialog({
    title: t(k ? 'api.edit' : 'api.add'),
    body: h(
      'div',
      { class: 'stack' },
      field(t('api.name_ar'), ar),
      field(t('api.name_en'), en),
      h('fieldset', { class: 'api-scope-set' }, h('legend', {}, t('api.scopes')), boxes.map(([s, box]) => h('div', {}, checkField(t('api.scope.' + s), box), h('p', { class: 'hint' }, t('api.scope_hint.' + s))))),
      k ? checkField(t('api.active'), active) : null,
    ),
    onSubmit: async () => {
      const body = { name_ar: ar.value, name_en: en.value, scopes: boxes.filter(([, b]) => b.checked).map(([s]) => s), active: active.checked };
      const r = await api(k ? '/api-keys/' + k.id : '/api-keys', { method: k ? 'PUT' : 'POST', body });
      render();
      if (k) toast(t('tk.saved'));
      else setTimeout(() => apiKeyShown(r.key), 0);
    },
  });
}
// The new key, once: the system keeps only its fingerprint.
export function apiKeyShown(key) {
  openDialog({
    title: t('api.made'),
    body: h('div', { class: 'stack' }, h('p', { class: 'notice notice-warn' }, t('api.once')), h('div', { class: 'copy-row' }, input({ type: 'text', readonly: true, value: key, dir: 'ltr', onfocus: (e) => e.target.select() }))),
    submitLabel: t('tk.copy'),
    onSubmit: async () => {
      try {
        await navigator.clipboard.writeText(key);
        toast(t('tk.copied'));
      } catch {
        toast(key);
      }
    },
  });
}

// Reads the first sheet of an Excel file (or a CSV) in the browser: no library, no upload of the file.
export async function readSheet(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) return parseCsv(new TextDecoder().decode(buf).replace(/^﻿/, ''));
  const dv = new DataView(buf.buffer);
  let end = buf.length - 22;
  while (end >= 0 && dv.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new ApiError('bad_sheet');
  const entries = new Map();
  let p = dv.getUint32(end + 16, true);
  for (let i = 0, n = dv.getUint16(end + 10, true); i < n; i++) {
    const nameLen = dv.getUint16(p + 28, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), offset: dv.getUint32(p + 42, true) });
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  const read = async (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
    const raw = buf.subarray(start, start + e.size);
    const bytes = e.method === 0 ? raw : new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    return new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
  };
  const sheetName = entries.has('xl/worksheets/sheet1.xml') ? 'xl/worksheets/sheet1.xml' : [...entries.keys()].find((k) => /^xl\/worksheets\/[^/]+\.xml$/.test(k));
  if (!sheetName) throw new ApiError('bad_sheet');
  const shared = await read('xl/sharedStrings.xml');
  const strings = shared ? [...shared.getElementsByTagName('si')].map((si) => [...si.getElementsByTagName('t')].map((x) => x.textContent).join('')) : [];
  const sheet = await read(sheetName);
  const rows = [];
  for (const row of sheet.getElementsByTagName('row')) {
    const cells = [];
    for (const c of row.getElementsByTagName('c')) {
      const ref = c.getAttribute('r') || '';
      let col = 0;
      for (const ch of ref.replace(/\d+/g, '')) col = col * 26 + ch.charCodeAt(0) - 64;
      const type = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0];
      let text = '';
      if (type === 's') text = strings[Number(v && v.textContent)] || '';
      else if (type === 'inlineStr') text = [...c.getElementsByTagName('t')].map((x) => x.textContent).join('');
      else text = v ? v.textContent : '';
      cells[(col || cells.length + 1) - 1] = text.trim();
    }
    rows.push(Array.from(cells, (x) => x || ''));
  }
  return rows;
}
export function parseCsv(text) {
  const sep = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows;
}
// Which column is which, from the header words; without a header: number, Arabic name, English name, department, phone.
export function staffRows(sheet) {
  const rows = sheet.filter((r) => r.some(Boolean));
  if (!rows.length) return [];
  // normText turns "لا" into "ال" (so "الاسم" becomes "االسم"): headers are tried as typed too.
  const find = (head, re) => head.findIndex((x) => re.test(String(x || '').toLowerCase()) || re.test(normText(x)));
  const head = rows[0];
  const col = {
    emp_no: find(head, /رقم|الرقم|كود|emp|id|no\b|number|code/),
    name_en: find(head, /نجليز|english|name_en|\(en\)/),
    dept: find(head, /قسم|اداره|dep/),
    phone: find(head, /جوال|هاتف|تليفون|موبايل|تحويله|phone|mobile|ext/),
  };
  col.name = head.findIndex((x, i) => i !== col.name_en && i !== col.emp_no && (/اسم|name/.test(String(x || '').toLowerCase()) || /اسم|name/.test(normText(x))));
  const hasHead = col.emp_no >= 0 && col.name >= 0;
  if (!hasHead) Object.assign(col, { emp_no: 0, name: 1, name_en: 2, dept: 3, phone: 4 });
  const depts = new Map();
  for (const d of S.departments) {
    depts.set(normText(d.name_ar), d.id);
    depts.set(normText(d.name_en), d.id);
  }
  return rows.slice(hasHead ? 1 : 0).map((r) => {
    const deptText = col.dept >= 0 ? r[col.dept] || '' : '';
    return {
      emp_no: String(r[col.emp_no] || '').replace(/\.0$/, '').trim(),
      name: String(r[col.name] || '').trim(),
      name_en: col.name_en >= 0 ? String(r[col.name_en] || '').trim() : '',
      department_id: deptText ? depts.get(normText(deptText)) || null : null,
      dept_text: deptText,
      phone: col.phone >= 0 ? String(r[col.phone] || '').trim() : '',
    };
  });
}
export function importDialog() {
  const file = input({ type: 'file', accept: '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv', required: true });
  const off = input({ type: 'checkbox' });
  const preview = h('p', { class: 'muted small', 'aria-live': 'polite' });
  let parsed = null;
  file.addEventListener('change', async () => {
    parsed = null;
    preview.textContent = '';
    const f = file.files && file.files[0];
    if (!f) return;
    try {
      parsed = staffRows(await readSheet(f));
      const good = parsed.filter((r) => r.emp_no && r.name && r.name_en);
      const noDept = good.filter((r) => r.dept_text && !r.department_id).length;
      preview.textContent = t('staff.preview', { n: good.length }) + (noDept ? ' ' + t('staff.preview_dept', { n: noDept }) : '');
    } catch (e) {
      preview.textContent = errText(e);
    }
  });
  openDialog({
    title: t('staff.import'),
    body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('staff.import_help')), field(t('staff.file'), file), preview, checkField(t('staff.deactivate'), off), h('p', { class: 'hint' }, t('staff.deactivate_hint'))),
    submitLabel: t('staff.import'),
    onSubmit: async () => {
      if (!parsed) throw new ApiError('bad_sheet');
      const good = parsed.filter((r) => r.emp_no && r.name && r.name_en).map(({ dept_text, ...r }) => r);
      if (!good.length) throw new ApiError('bad_sheet');
      const total = { added: 0, updated: 0, deactivated: 0 };
      for (let i = 0; i < good.length; i += 1000) {
        const last = i + 1000 >= good.length;
        const r = await api('/staff/import', { method: 'POST', body: { rows: good.slice(i, i + 1000), keep: last && off.checked ? good.map((x) => x.emp_no) : undefined } });
        total.added += r.added;
        total.updated += r.updated;
        total.deactivated += r.deactivated;
      }
      toast(t('staff.imported', total));
      render();
    },
  });
}
