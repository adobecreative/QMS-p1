// Excel files: a small .xlsx writer and reader, and the ZIP helpers they use.
import { render } from '../app.js';
import { ApiError, MAX_PDF_BYTES, S, h, t } from './core.js';
import { extractPdfText } from './docs.js';
import { orgNames } from './layout.js';
import { api, checkField, deptById, deptName, field, fileName, fmtDate, input, isAdmin, openDialog, select, toast, typeName } from './offline.js';

/* ---------------------------- Excel report ----------------------------- */

// Style ids, matching cellXfs in downloadXlsx's styles.xml.
export const XLS_STYLE = { text: 0, head: 1, title: 2, date: 3, num: 4, pct: 5, valid: 6, near: 7, expired: 8, review: 9, none: 10, muted: 11, time: 12 };

// The files report.
export function exportXlsx(rows) {
  const withAck = isAdmin();
  const ST = XLS_STYLE;
  const serial = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000 + 25569;
  const head = ['file.name', 'file.number', 'file.type', 'file.department', 'file.issue', 'file.expiry', 'xls.days', 'file.status'].map((k) => t(k));
  if (withAck) head.push(t('ack.col'), t('xls.ack_pct'));
  const body = rows.map((f) => {
    const cells = [
      { v: fileName(f) },
      { v: f.file_number },
      { v: typeName(f.doc_type) },
      { v: deptName(deptById(f.department_id)) },
      { v: f.issue_date ? serial(f.issue_date) : null, s: ST.date },
      { v: f.expiry_date ? serial(f.expiry_date) : null, s: ST.date },
      { v: f.days_left ?? null, s: ST.num },
      { v: t('status.' + f.status), s: ST[f.status] },
    ];
    if (withAck) {
      cells.push({ v: f.has_pdf ? f.ack_count + ' / ' + f.ack_total : '', s: ST.num });
      cells.push({ v: f.has_pdf && f.ack_total ? f.ack_count / f.ack_total : null, s: ST.pct });
    }
    return cells;
  });
  downloadXlsx({ fileName: 'files-report', sheet: t('xls.sheet'), title: t('xls.title'), head, widths: [42, 14, 12, 22, 13, 13, 12, 18, 12, 12], rows: body });
}

// A real .xlsx built in the browser: right-to-left in Arabic, coloured cells, filters, frozen header.
// rows: arrays of cells { v, s } with s from XLS_STYLE. title: null leaves the header on the first row.
export function downloadXlsx({ fileName: baseName, sheet: sheetName, title, head, widths, rows }) {
  const localToday = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in the viewer's own time zone
  const esc = (v) =>
    String(v ?? '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const colName = (i) => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + (i % 26));
  const ST = XLS_STYLE;
  // Sheet names: at most 31 characters, none of : \ / ? * [ ]
  const safeSheet = String(sheetName || 'Sheet1').replace(/[:\\/?*[\]]/g, ' ').slice(0, 31);

  const sheetRows = [];
  const cellXml = (ref, c) => {
    if (c === null || c === undefined || c.v === null || c.v === undefined || c.v === '') return c && c.s ? `<c r="${ref}" s="${c.s}"/>` : '';
    if (typeof c.v === 'number') return `<c r="${ref}" s="${c.s || 0}"><v>${c.v}</v></c>`;
    return `<c r="${ref}" s="${c.s || 0}" t="inlineStr"><is><t xml:space="preserve">${esc(c.v)}</t></is></c>`;
  };
  const addRow = (cells, height) => {
    const r = sheetRows.length + 1;
    sheetRows.push(`<row r="${r}"${height ? ` ht="${height}" customHeight="1"` : ''}>${cells.map((c, i) => cellXml(colName(i) + r, c)).join('')}</row>`);
  };

  if (title) {
    // The organisation's name in both languages heads every exported sheet.
    addRow([{ v: orgNames() + ' - ' + title, s: ST.title }], 24);
    addRow([{ v: t('xls.date') + ': ' + fmtDate(localToday), s: ST.muted }]);
    addRow([]);
  }
  const headRow = sheetRows.length + 1;
  addRow(head.map((v) => ({ v, s: ST.head })), 22);
  for (const cells of rows) addRow(cells);
  const lastCol = colName(head.length - 1);
  const lastRow = sheetRows.length;

  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
    `<sheetViews><sheetView workbookViewId="0"${S.lang === 'ar' ? ' rightToLeft="1"' : ''}><pane ySplit="${headRow}" topLeftCell="A${headRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<cols>${head.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${widths[i] || 14}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${sheetRows.join('')}</sheetData>` +
    (lastRow > headRow ? `<autoFilter ref="A${headRow}:${lastCol}${lastRow}"/>` : '') +
    // Prints landscape, all columns on one page width.
    '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>' +
    '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
    '</worksheet>';

  const fill = (rgb) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
  const xf = (font, fillId, numFmt, extra) =>
    `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fillId}" borderId="${fillId === 0 ? 0 : 1}" xfId="0"${font ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1" applyBorder="1"' : ''}${numFmt ? ' applyNumberFormat="1"' : ''} applyAlignment="1"><alignment vertical="center"${extra || ''}/></xf>`;
  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy hh:mm"/></numFmts>' +
    '<fonts count="4">' +
    '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="15"/><color rgb="FF8A6420"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><sz val="10"/><color rgb="FF6E6553"/><name val="Calibri"/><family val="2"/></font>' +
    '</fonts>' +
    // fills 0 and 1 are reserved by Excel.
    `<fills count="8"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fill('8A6420')}${fill('D9EEE3')}${fill('F6EBC8')}${fill('F5DCD8')}${fill('FAF7F0')}${fill('FFFFFF')}</fills>` +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFE8DFCC"/></left><right style="thin"><color rgb="FFE8DFCC"/></right><top style="thin"><color rgb="FFE8DFCC"/></top><bottom style="thin"><color rgb="FFE8DFCC"/></bottom><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="13">' +
    xf(0, 0, 0, ' wrapText="1"') + // text
    xf(1, 2, 0, ' horizontal="center" wrapText="1"') + // head
    xf(2, 0, 0) + // title
    xf(0, 0, 164, ' horizontal="center"') + // date
    xf(0, 0, 0, ' horizontal="center"') + // num
    xf(0, 0, 9, ' horizontal="center"') + // pct
    xf(0, 3, 0, ' horizontal="center"') + // valid
    xf(0, 4, 0, ' horizontal="center"') + // near
    xf(0, 5, 0, ' horizontal="center"') + // expired
    xf(0, 7, 0, ' horizontal="center"') + // review (white)
    xf(0, 6, 0, ' horizontal="center"') + // none
    xf(3, 0, 0) + // muted
    xf(0, 0, 165, ' horizontal="center"') + // time
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  const files = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets><sheet name="${esc(safeSheet)}" sheetId="1" r:id="rId1"/></sheets>` +
      (lastRow > headRow ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${esc(safeSheet.replace(/'/g, "''"))}'!$A$${headRow}:$${lastCol}$${lastRow}</definedName></definedNames>` : '') +
      '</workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet,
    'xl/styles.xml': styles,
  };
  const blob = new Blob([zipStore(files)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: baseName + '-' + localToday + '.xlsx' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Minimal ZIP writer (no compression): enough for an .xlsx, no library needed.
export let crcTable = null;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const DOS_DATE = (2026 - 1980) << 9 | (1 << 5) | 1; // fixed timestamp keeps it simple
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = typeof content === 'string' ? enc.encode(content) : content; // text or raw bytes
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, 0, true);
    cen.setUint16(14, DOS_DATE, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cenSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)]);
}

export function fileDialog(file) {
  const isEdit = !!file;
  if (!S.departments.length) {
    toast(t('file.no_depts'), true);
    return;
  }
  const dept = select(
    S.departments.map((d) => [d.id, deptName(d)]),
    file ? file.department_id : S.dash.dept || S.departments[0].id,
    { required: true, disabled: S.user.docs === 'dept_admin' },
  );
  const name = input({ type: 'text', required: true, maxlength: 200, dir: 'rtl', value: file ? file.name : '' });
  const nameEn = input({ type: 'text', dir: 'ltr', required: true, maxlength: 200, value: file ? file.name_en || '' : '' });
  const number = input({ type: 'text', required: true, maxlength: 60, dir: 'ltr', value: file ? file.file_number : '' });
  if (!S.docTypes.length) {
    toast(t('file.no_types'), true);
    return;
  }
  const type = select(
    S.docTypes.map((x) => [x.key, typeName(x.key)]),
    file ? file.doc_type : S.docTypes[0].key,
    { required: true },
  );
  const issue = input({ type: 'date', value: (file && file.issue_date) || '' });
  const permanent = input({ type: 'checkbox', checked: isEdit && !file.expiry_date });
  const expiry = input({ type: 'date', value: (file && file.expiry_date) || '' });
  const near = input({ type: 'number', min: 0, max: 3650, step: 1, inputmode: 'numeric', placeholder: String(S.defaults.near_days), value: file && file.near_days !== null ? file.near_days : '' });
  const notify = input({ type: 'date', value: (file && file.notify_date) || '' });
  const review = input({ type: 'checkbox', checked: !!(file && file.under_review) });
  const pdf = input({ type: 'file', accept: 'application/pdf,.pdf', required: !isEdit });
  const sync = () => {
    expiry.disabled = permanent.checked;
    near.disabled = permanent.checked;
    expiry.required = !permanent.checked;
  };
  permanent.addEventListener('change', sync);
  sync();

  openDialog({
    title: t(isEdit ? 'file.edit' : 'file.add'),
    body: h(
      'div',
      { class: 'form-grid' },
      field(t('file.name_ar'), name),
      field(t('file.name_en'), nameEn),
      field(t('file.number'), number),
      field(t('file.type'), type),
      field(t('file.department'), dept),
      field(t('file.issue'), issue),
      h('div', { class: 'span-2' }, checkField(t('file.permanent'), permanent)),
      field(t('file.expiry'), expiry),
      field(t('file.near_days'), near, t('file.near_hint', { n: S.defaults.near_days })),
      h('div', { class: 'span-2' }, checkField(t('file.review'), review)),
      h('div', { class: 'span-2' }, field(t('file.notify'), notify, t('file.notify_hint'))),
      h('div', { class: 'span-2' }, field(t(isEdit ? 'file.pdf_replace' : 'file.pdf'), pdf, isEdit && file.pdf_name ? t('file.pdf_replace_hint', { name: file.pdf_name }) : null)),
    ),
    onSubmit: async () => {
      const fd = new FormData();
      fd.set('department_id', dept.value);
      fd.set('name', name.value);
      fd.set('name_en', nameEn.value);
      fd.set('file_number', number.value);
      fd.set('doc_type', type.value);
      fd.set('issue_date', issue.value);
      fd.set('expiry_date', permanent.checked ? '' : expiry.value);
      fd.set('near_days', permanent.checked ? '' : near.value);
      fd.set('notify_date', notify.value);
      fd.set('under_review', review.checked ? '1' : '0');
      const picked = pdf.files && pdf.files[0];
      if (picked) {
        if (picked.size > MAX_PDF_BYTES) throw new ApiError('pdf_too_large');
        fd.set('pdf', picked);
        const text = await extractPdfText(await picked.arrayBuffer()).catch(() => null);
        if (text) {
          fd.set('text_body', text.body);
          fd.set('text_compact', text.compact);
        }
      }
      await api(isEdit ? '/files/' + file.id : '/files', { method: isEdit ? 'PUT' : 'POST', form: fd });
      toast(t(isEdit ? 'file.saved' : 'file.added'));
      render();
    },
  });
}

export function deleteFile(f) {
  openDialog({
    title: t('file.delete_q', { name: fileName(f) }),
    body: h('p', { class: 'muted' }, t('file.delete_hint')),
    submitLabel: t('common.delete'),
    danger: true,
    onSubmit: async () => {
      await api('/files/' + f.id, { method: 'DELETE' });
      toast(t('file.deleted'));
      render();
    },
  });
}
