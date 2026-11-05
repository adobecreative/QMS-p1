// Document Control: dashboard, read acknowledgement, the reader, departments and file types.
import { render } from '../app.js';
import { MAX_TEXT_CHARS, S, h, icon, t } from './core.js';
import { isAdminRole, link, setUrl } from './layout.js';
import { api, canEdit, checkField, dateEl, daysNote, deptById, deptName, errText, errorBox, field, fileName, fmtDate, input, isAdmin, openDialog, personName, select, statusChip, toast, typeName } from './offline.js';
import { pick } from './tickets.js';
import { deleteFile, exportXlsx, fileDialog } from './xlsx.js';

/* ------------------------------ dashboard ------------------------------ */

export const STATUS_RANK = { expired: 0, near: 1, review: 2, valid: 3, none: 4 };
export function sortFiles(files) {
  return files.slice().sort((a, b) => {
    if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    const da = a.days_left ?? Infinity;
    const db = b.days_left ?? Infinity;
    if (da !== db) return da - db;
    return fileName(a).localeCompare(fileName(b));
  });
}

export async function loadFiles() {
  const [d, ty, f] = await Promise.all([api('/departments?for=docs'), api('/doc-types'), api('/files')]);
  S.departments = d.departments;
  S.docTypes = ty.doc_types;
  S.chapters = ty.chapters || [];
  return f.files;
}

export async function dashboardPage(root, _param, alive) {
  let files;
  try {
    files = await loadFiles();
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  fillSearchText();
  const canAdd = isAdmin();
  if (S.dash.dept && !S.departments.some((d) => String(d.id) === S.dash.dept)) S.dash.dept = '';

  const draw = () => {
    const inDept = files.filter((f) => !S.dash.dept || String(f.department_id) === S.dash.dept);
    const counts = { valid: 0, near: 0, expired: 0, review: 0, none: 0 };
    inDept.forEach((f) => counts[f.status]++);
    const rows = sortFiles(inDept.filter((f) => !S.dash.status || f.status === S.dash.status));

    const cards = ['valid', 'near', 'expired', 'review'].map((st) =>
      h(
        'button',
        {
          type: 'button',
          class: 'card card-' + st,
          'aria-pressed': String(S.dash.status === st),
          onclick: () => {
            S.dash.status = S.dash.status === st ? '' : st;
            draw();
          },
        },
        h('span', { class: 'card-label' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('status.' + st)),
        h('span', { class: 'card-num' }, String(counts[st])),
      ),
    );

    const deptFilter =
      S.departments.length > 1
        ? h(
            'div',
            { class: 'inline-field' },
            h('label', { for: 'dash-dept' }, t('file.department')),
            select([['', t('dash.all_depts')], ...S.departments.map((d) => [d.id, deptName(d)])], S.dash.dept, {
              id: 'dash-dept',
              onchange: (e) => {
                S.dash.dept = e.target.value;
                draw();
              },
            }),
          )
        : null;

    const emptyText = files.length ? t('dash.empty_filter') : canAdd ? t('dash.empty_admin') : t('dash.empty');
    root.replaceChildren(
      h(
        'div',
        { class: 'page-head' },
        h('div', {}, h('h1', {}, t('nav.dashboard')), h('p', { class: 'muted' }, t('dash.sub'))),
        h(
          'div',
          { class: 'actions' },
          h('button', { type: 'button', class: 'btn', disabled: !rows.length, onclick: () => exportXlsx(rows) }, icon('download'), t('dash.export')),
          canAdd ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => fileDialog(null) }, icon('plus'), t('file.add')) : null,
        ),
      ),
      h('section', { class: 'cards', 'aria-label': t('dash.summary') }, cards),
      h(
        'section',
        { class: 'panel' },
        h(
          'div',
          { class: 'panel-head' },
          h('div', { class: 'panel-title' }, h('h2', {}, S.dash.status ? t('status.' + S.dash.status) : t('dash.all')), h('span', { class: 'muted small' }, t('dash.count', { n: rows.length }))),
          deptFilter,
        ),
        rows.length ? h('div', { class: 'table-scroll' }, filesTable(rows)) : h('p', { class: 'empty' }, emptyText),
      ),
    );
  };
  draw();
}

export function filesTable(rows) {
  const showAck = isAdmin();
  const cols = ['file.name', 'file.number', 'file.type', 'file.department', 'file.issue', 'file.expiry', 'file.status', ...(showAck ? ['ack.col'] : []), 'file.col_file'];
  return h(
    'table',
    { class: 'files-table' },
    h('thead', {}, h('tr', {}, cols.map((c) => h('th', { scope: 'col' }, t(c))))),
    h(
      'tbody',
      {},
      rows.map((f) =>
        h(
          'tr',
          {},
          h('td', { class: 'strong wrap-cell' }, fileName(f)),
          h('td', {}, h('span', { class: 'mono', dir: 'ltr' }, f.file_number)),
          h('td', {}, typeName(f.doc_type)),
          h('td', {}, deptName(deptById(f.department_id))),
          h('td', {}, dateEl(f.issue_date)),
          h('td', {}, h('div', { class: 'cell-stack' }, dateEl(f.expiry_date), daysNote(f))),
          h('td', {}, statusChip(f.status)),
          showAck ? h('td', {}, f.has_pdf ? ackCount(f) : h('span', { class: 'muted' }, t('common.none'))) : null,
          h(
            'td',
            {},
            h(
              'div',
              { class: 'row-actions' },
              link('documents/' + f.id, { class: 'btn btn-small' }, icon('file', 16), t('file.view')),
              canEdit(f)
                ? [
                    h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': t('common.edit') + ': ' + fileName(f), title: t('common.edit'), onclick: () => fileDialog(f) }, icon('edit')),
                    h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': t('common.delete') + ': ' + fileName(f), title: t('common.delete'), onclick: () => deleteFile(f) }, icon('trash')),
                  ]
                : null,
            ),
          ),
        ),
      ),
    ),
  );
}

/* ------------------------- read acknowledgement ------------------------- */

export const fmtStamp = (iso) => fmtDate(new Date(iso).toLocaleDateString('en-CA')); // local date, not UTC

// "5 of 12" in the files table. Opens the who-read list for people who manage the file.
export function ackCount(f) {
  const full = f.ack_total > 0 && f.ack_count >= f.ack_total;
  const text = h('span', { class: 'ack-count' + (full ? ' ack-full' : ''), dir: 'ltr' }, f.ack_count + ' / ' + f.ack_total);
  if (!canEdit(f)) return text;
  return h('button', { type: 'button', class: 'btn btn-small', title: t('ack.who'), 'aria-label': t('ack.who') + ': ' + fileName(f), onclick: () => ackDialog(f) }, text);
}

// Under the file title in the reader: confirm reading, and (for managers) see who has read it.
export function ackBar(f) {
  const bar = h('div', { class: 'panel ack-bar' });
  const draw = () => {
    let mine;
    if (f.acked_at) {
      mine = h('p', { class: 'ack-ok' }, icon('check'), t('ack.done', { date: fmtStamp(f.acked_at) }));
    } else {
      const btn = h(
        'button',
        {
          type: 'button',
          class: 'btn btn-primary',
          onclick: async () => {
            btn.disabled = true;
            try {
              const r = await api('/files/' + f.id + '/ack', { method: 'POST' });
              f.acked_at = r.acked_at;
              f.ack_count = r.ack_count;
              toast(t('ack.saved'));
              draw();
            } catch (e) {
              toast(errText(e), true);
              btn.disabled = false;
            }
          },
        },
        icon('check'),
        t('ack.button'),
      );
      mine = h('div', { class: 'ack-btns' }, h('p', { class: 'ack-text' }, t('ack.prompt')), btn);
    }
    const who = canEdit(f)
      ? h('button', { type: 'button', class: 'btn', onclick: () => ackDialog(f) }, icon('users'), t('ack.who'), h('span', { class: 'ack-count', dir: 'ltr' }, f.ack_count + ' / ' + f.ack_total))
      : null;
    bar.replaceChildren(...[mine, who].filter(Boolean));
  };
  draw();
  return bar;
}

export async function ackDialog(f) {
  let users;
  try {
    users = (await api('/files/' + f.id + '/acks')).users;
  } catch (e) {
    toast(errText(e), true);
    return;
  }
  const read = users.filter((u) => u.acked_at);
  const unread = users.filter((u) => !u.acked_at);
  const who = (u) => {
    const dept = u.department_id ? deptName(deptById(u.department_id)) : '';
    return h('span', {}, h('span', { class: 'strong' }, personName(u)), ' ', h('span', { class: 'muted small' }, [isAdminRole(u) ? t('role.' + u.role) : null, dept].filter(Boolean).join(' - ')));
  };
  const list = (rows, withDate) =>
    h(
      'ul',
      { class: 'ack-list' },
      rows.map((u) => h('li', {}, who(u), withDate ? h('span', { class: 'mono small', dir: 'ltr' }, fmtStamp(u.acked_at)) : null)),
    );
  const body = h(
    'div',
    {},
    h('p', { class: 'muted small' }, t('ack.renew_note')),
    h('h3', { class: 'ack-h' }, t('ack.unread', { n: unread.length })),
    unread.length ? list(unread, false) : h('p', { class: 'muted' }, t('ack.all_read')),
    h('h3', { class: 'ack-h' }, t('ack.read', { n: read.length })),
    read.length ? list(read, true) : h('p', { class: 'muted' }, t('ack.none_yet')),
  );
  const dlg = openDialog({ title: fileName(f), body, submitLabel: t('ack.close'), onSubmit: async () => {} });
  // Only one way out of a read-only list.
  const cancel = dlg.querySelector('.dialog-actions .btn:not([type=submit])');
  if (cancel) cancel.remove();
}

/* --------------------------- documents (reader) ------------------------- */

export async function documentsPage(root, param, alive) {
  let files;
  try {
    files = await loadFiles();
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  fillSearchText();
  if (!S.departments.length) {
    root.replaceChildren(h('div', { class: 'panel empty' }, t('doc.no_depts')));
    return;
  }
  let selected = files.find((f) => String(f.id) === param) || null;
  let dept = selected ? String(selected.department_id) : S.departments.some((d) => String(d.id) === S.docDept) ? S.docDept : String(S.departments[0].id);
  let openPage = 1;

  // Search by file name or number (here, instantly) and by words inside the PDFs (on the server).
  // While searching, the list shows matches from every department.
  const box = input({ type: 'search', class: 'doc-search-input', value: S.docQuery || '', placeholder: t('doc.search_ph'), 'aria-label': t('doc.search'), autocomplete: 'off', enterkeyhint: 'search' });
  const listBody = h('div', { class: 'doc-list-body' });
  let hits = null; // { q, map: id -> { page, snippet } } for the last finished content search
  let pending = '';
  let timer = 0;
  const queryNow = () => normText(box.value);
  async function searchContent(q) {
    pending = q;
    let map = new Map();
    try {
      const r = await api('/files/search?q=' + encodeURIComponent(q));
      map = new Map(r.results.map((x) => [x.id, x]));
    } catch {
      /* name matches still show */
    }
    if (!alive() || pending !== q) return;
    pending = '';
    hits = { q, map };
    drawList();
  }
  box.addEventListener('input', () => {
    S.docQuery = box.value;
    clearTimeout(timer);
    const q = queryNow();
    if ([...q.replace(/\s+/g, '')].length >= 2 && (!hits || hits.q !== q)) {
      pending = q;
      timer = setTimeout(() => searchContent(q), 300);
    } else pending = '';
    drawList();
  });

  const pick = (f, page) => {
    selected = f;
    dept = String(f.department_id);
    openPage = page || 1;
    draw();
    // On a phone the file opens below the results: bring it into view.
    if (queryNow() && window.innerWidth < 860) {
      const doc = root.querySelector('.doc');
      if (doc) doc.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };
  const item = (f, extra) =>
    h(
      'button',
      { type: 'button', class: 'doc-item', 'aria-current': selected && f.id === selected.id ? 'true' : null, onclick: () => pick(f, extra && extra.hit && extra.hit.page) },
      h('span', { class: 'doc-item-name' }, fileName(f)),
      h(
        'span',
        { class: 'doc-item-meta' },
        h('span', { class: 'tag' }, typeName(f.doc_type)),
        h('span', { class: 'mono small', dir: 'ltr' }, f.file_number),
        extra ? h('span', { class: 'small' }, deptName(deptById(f.department_id))) : null,
      ),
      extra && extra.hit ? h('span', { class: 'doc-hit' }, h('span', { class: 'doc-hit-page' }, t('doc.found_page', { n: extra.hit.page })), extra.hit.snippet ? markText(extra.hit.snippet, extra.q) : null) : null,
    );

  function drawList() {
    const q = queryNow();
    if (!q) {
      const list = files.filter((f) => String(f.department_id) === dept);
      const deptSelect = select(
        S.departments.map((d) => [d.id, deptName(d)]),
        dept,
        {
          onchange: (e) => {
            dept = e.target.value;
            selected = null;
            draw();
          },
        },
      );
      listBody.replaceChildren(
        field(t('file.department'), deptSelect),
        h('div', { class: 'doc-list-head' }, h('h2', {}, t('doc.list')), h('span', { class: 'muted small' }, t('dash.count', { n: list.length }))),
        list.length ? h('div', { class: 'doc-items' }, list.map((f) => item(f))) : h('p', { class: 'empty' }, t('doc.empty')),
      );
      return;
    }
    const qc = q.replace(/\s+/g, '');
    const map = hits && hits.q === q ? hits.map : new Map();
    const found = files.filter((f) => {
      const label = normText(f.name + ' ' + (f.name_en || '') + ' ' + f.file_number);
      return label.includes(q) || label.replace(/\s+/g, '').includes(qc) || map.has(f.id);
    });
    listBody.replaceChildren(
      ...[
        h('div', { class: 'doc-list-head' }, h('h2', {}, t('doc.results')), h('span', { class: 'muted small' }, t('dash.count', { n: found.length }))),
        pending === q ? h('p', { class: 'muted small' }, t('doc.searching')) : null,
        found.length
          ? h('div', { class: 'doc-items' }, found.map((f) => item(f, { hit: map.get(f.id), q })))
          : pending === q
            ? null
            : h('p', { class: 'empty' }, t('doc.no_results')),
      ].filter(Boolean),
    );
  }

  const draw = () => {
    S.docDept = dept;
    const list = files.filter((f) => String(f.department_id) === dept);
    if (!selected || String(selected.department_id) !== dept) {
      selected = list[0] || null;
      openPage = 1;
    }
    S.route = selected ? 'documents/' + selected.id : 'documents';
    setUrl(S.route, false);
    drawList();
    root.replaceChildren(
      h(
        'div',
        { class: 'doc-layout' },
        h(
          'aside',
          { class: 'panel doc-list', 'aria-label': t('doc.list') },
          h('div', { class: 'doc-search', role: 'search' }, icon('search'), box),
          listBody,
        ),
        selected ? docArticle(selected, openPage) : h('div', { class: 'panel empty doc' }, t('doc.pick')),
      ),
    );
  };
  draw();
  const q0 = queryNow();
  if ([...q0.replace(/\s+/g, '')].length >= 2) searchContent(q0);
}

// The snippet with the searched words highlighted (text nodes only, no HTML).
export function markText(text, q) {
  const el = h('span', { class: 'doc-hit-text' });
  const at = q ? text.indexOf(q) : -1;
  if (at < 0) {
    el.textContent = '…' + text + '…';
    return el;
  }
  el.append('…' + text.slice(0, at), h('mark', {}, text.slice(at, at + q.length)), text.slice(at + q.length) + '…');
  return el;
}

// Must match normText() in src/worker.js. Folds Arabic letter variants and diacritics so a search
// finds the word however it was typed; "لا" and "ال" count as the same (PDFs often reverse the ligature).
export function normText(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ً-ٰٟۖ-ۭـ​-‏‪-‮⁦-⁩]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/لا/g, 'ال')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[^\S\f]+/g, ' ')
    .trim();
}

// The words of a PDF for search, read here because the server's free CPU limit is too small.
// Pages are separated by \f so a match can open on its page. A scanned PDF gives empty text.
export async function extractPdfText(data) {
  await loadPdfJs();
  const doc = await window.pdfjsLib.getDocument({ data, isEvalSupported: false, cMapUrl: '/vendor/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/standard_fonts/' }).promise;
  try {
    const pages = [];
    let total = 0;
    for (let n = 1; n <= doc.numPages && total < MAX_TEXT_CHARS; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let raw = '';
      for (const it of content.items) raw += (it.str || '') + (it.hasEOL ? '\n' : '');
      const text = normText(raw).replace(/\f/g, ' ');
      pages.push(text);
      total += text.length + 1;
      page.cleanup();
    }
    const body = pages.join('\f').slice(0, MAX_TEXT_CHARS);
    return { body, compact: body.replace(/ /g, '') };
  } finally {
    doc.destroy();
  }
}

// Files uploaded before search existed (or whose text could not be read at upload) are read once,
// in the background, by the browser of someone who manages them.
export let textFillRunning = false;
export async function fillSearchText() {
  if (textFillRunning || !S.user || !isAdmin()) return;
  textFillRunning = true;
  try {
    const { files } = await api('/files/text-missing');
    for (const f of files) {
      if (!S.user) break;
      try {
        const res = await fetch('/api/files/' + f.id + '/pdf', { credentials: 'same-origin' });
        if (!res.ok) continue;
        const text = await extractPdfText(await res.arrayBuffer());
        await api('/files/' + f.id + '/text', { method: 'PUT', body: { pdf_key: f.pdf_key, ...text } });
      } catch {
        /* try again next time */
      }
    }
  } catch {
    /* not now */
  } finally {
    textFillRunning = false;
  }
}

export function docArticle(f, startPage) {
  const meta = (label, value) => h('div', { class: 'meta' }, h('span', { class: 'meta-label' }, label), value);
  return h(
    'article',
    { class: 'doc' },
    h(
      'div',
      { class: 'panel doc-head' },
      h('div', { class: 'doc-title' }, h('span', { class: 'tag' }, typeName(f.doc_type)), h('h1', {}, fileName(f))),
      h(
        'div',
        { class: 'meta-grid' },
        meta(t('file.department'), h('span', { class: 'strong' }, deptName(deptById(f.department_id)))),
        meta(t('file.number'), h('span', { class: 'mono strong', dir: 'ltr' }, f.file_number)),
        f.chapter ? meta(t('file.chapter'), h('span', { class: 'strong' }, chapterLabel(f.chapter))) : null,
        meta(t('file.issue'), dateEl(f.issue_date)),
        meta(t('file.expiry'), h('div', { class: 'meta-row' }, dateEl(f.expiry_date), f.status !== 'none' ? statusChip(f.status) : null)),
      ),
    ),
    f.has_pdf ? ackBar(f) : null,
    f.has_pdf ? pdfViewer(f, startPage) : h('div', { class: 'panel empty' }, t('doc.no_pdf')),
  );
}

export function chapterLabel(code) {
  const c = (S.chapters || []).find((x) => x.code === code);
  return c ? code + ' · ' + (S.lang === 'en' ? c.name_en : c.name_ar) : code;
}

export let pdfJsLoading = null;
export function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve();
  if (!pdfJsLoading) {
    pdfJsLoading = new Promise((resolve, reject) => {
      const s = h('script', { src: '/vendor/pdf.min.js' });
      s.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';
        resolve();
      };
      s.onerror = () => {
        pdfJsLoading = null;
        reject(new Error('pdfjs'));
      };
      document.head.append(s);
    });
  }
  return pdfJsLoading;
}

// Reads the PDF inside the page (works on phones too). One page at a time.
export function pdfViewer(file, startPage) {
  const st = { doc: null, page: 1, zoom: 1, busy: false, again: false, full: false };
  // dir=ltr is required: in an RTL page the canvas would otherwise inherit "rtl" and PDF.js would misplace every glyph.
  const canvas = h('canvas', { class: 'pdf-canvas', dir: 'ltr' });
  const stage = h('div', { class: 'pdf-stage' }, h('p', { class: 'pdf-msg' }, t('doc.loading')));
  const pageLabel = h('span', { class: 'pdf-page' });
  const zoomLabel = h('span', { class: 'pdf-zoom mono', dir: 'ltr' }, '100%');
  const iconBtn = (name, label, fn) => h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': label, title: label, onclick: fn }, icon(name));
  const prev = iconBtn('up', t('doc.prev'), () => go(st.page - 1));
  const next = iconBtn('down', t('doc.next'), () => go(st.page + 1));
  const zoomOut = iconBtn('minus', t('doc.zoom_out'), () => setZoom(st.zoom - 0.25));
  const zoomIn = iconBtn('plus', t('doc.zoom_in'), () => setZoom(st.zoom + 0.25));
  const fullLabel = h('span', {}, t('doc.full'));
  const fullBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => setFull(!st.full) }, icon('expand'), fullLabel);
  const wrap = h(
    'div',
    { class: 'pdf' },
    h('div', { class: 'pdf-bar' }, h('div', { class: 'pdf-group' }, prev, next, pageLabel), h('div', { class: 'pdf-group' }, zoomOut, zoomLabel, zoomIn, fullBtn)),
    stage,
  );

  function labels() {
    const total = st.doc ? st.doc.numPages : 0;
    pageLabel.textContent = st.doc ? t('doc.page', { n: st.page, total }) : '';
    zoomLabel.textContent = Math.round(st.zoom * 100) + '%';
    prev.disabled = !st.doc || st.page <= 1;
    next.disabled = !st.doc || st.page >= total;
    zoomOut.disabled = !st.doc || st.zoom <= 0.5;
    zoomIn.disabled = !st.doc || st.zoom >= 3;
  }
  async function draw() {
    if (!st.doc) return;
    if (st.busy) {
      st.again = true;
      return;
    }
    st.busy = true;
    try {
      const page = await st.doc.getPage(st.page);
      const base = page.getViewport({ scale: 1 });
      const room = Math.max(220, stage.clientWidth - 32);
      const fit = Math.min(room, st.full ? 1100 : 820) / base.width;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const view = page.getViewport({ scale: fit * st.zoom * ratio });
      canvas.width = Math.floor(view.width);
      canvas.height = Math.floor(view.height);
      canvas.style.width = Math.floor(view.width / ratio) + 'px';
      canvas.style.height = Math.floor(view.height / ratio) + 'px';
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: view }).promise;
    } catch {
      stage.replaceChildren(h('p', { class: 'pdf-msg' }, t('doc.failed')));
    } finally {
      st.busy = false;
      labels();
      if (st.again) {
        st.again = false;
        draw();
      }
    }
  }
  function go(n) {
    if (!st.doc || n < 1 || n > st.doc.numPages) return;
    st.page = n;
    stage.scrollTop = 0;
    labels();
    draw();
  }
  function setZoom(z) {
    st.zoom = Math.min(3, Math.max(0.5, z));
    labels();
    draw();
  }
  function setFull(on) {
    st.full = on;
    wrap.classList.toggle('pdf-full', on);
    document.body.classList.toggle('no-scroll', on);
    fullLabel.textContent = t(on ? 'doc.exit_full' : 'doc.full');
    draw();
  }

  let resizeTimer = 0;
  const onResize = () => {
    if (!wrap.isConnected) return cleanup();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(draw, 150);
  };
  const onKey = (e) => {
    if (!wrap.isConnected) return cleanup();
    if (e.key === 'Escape' && st.full) setFull(false);
  };
  function cleanup() {
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('no-scroll');
  }
  window.addEventListener('resize', onResize);
  document.addEventListener('keydown', onKey);

  labels();
  (async () => {
    try {
      await loadPdfJs();
      const url = (file.pdf_url || '/api/files/' + file.id + '/pdf') + '?v=' + encodeURIComponent(file.updated_at || '');
      st.doc = await window.pdfjsLib.getDocument({ url, isEvalSupported: false, cMapUrl: '/vendor/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/standard_fonts/' }).promise;
      st.page = Math.min(Math.max(1, startPage || 1), st.doc.numPages);
      stage.replaceChildren(canvas);
      draw();
    } catch {
      stage.replaceChildren(h('p', { class: 'pdf-msg' }, t('doc.failed')));
    }
  })();
  return wrap;
}

/* ------------------------------ departments ----------------------------- */

export async function departmentsPage(root, _param, alive) {
  let list;
  try {
    list = (await api('/departments')).departments;
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  S.departments = list;
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, t('nav.departments')), h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => deptDialog(null) }, icon('plus'), t('dept.add')))),
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
              h('thead', {}, h('tr', {}, ['dept.name_ar', 'dept.name_en', 'dept.team', 'inv.cost_center', 'dept.files', 'common.actions'].map((c) => h('th', { scope: 'col' }, t(c))))),
              h(
                'tbody',
                {},
                list.map((d) =>
                  h(
                    'tr',
                    {},
                    h('td', { class: 'strong', dir: 'rtl' }, d.name_ar),
                    h('td', { dir: 'ltr' }, d.name_en),
                    h('td', {}, d.is_team ? h('span', { class: 'chip chip-progress' }, t('dept.team_yes')) : h('span', { class: 'muted' }, t('common.no')), d.is_team && d.auto_assign ? h('div', { class: 'muted small' }, t('dept.auto_on')) : null),
                    h('td', {}, d.cost_center ? h('span', { class: 'mono', dir: 'ltr' }, d.cost_center) : h('span', { class: 'muted' }, t('common.none'))),
                    h('td', {}, h('span', { class: 'mono' }, String(d.file_count))),
                    h(
                      'td',
                      {},
                      h(
                        'div',
                        { class: 'row-actions' },
                        h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': t('common.edit') + ': ' + deptName(d), title: t('common.edit'), onclick: () => deptDialog(d) }, icon('edit')),
                        h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': t('common.delete') + ': ' + deptName(d), title: t('common.delete'), onclick: () => deleteDept(d) }, icon('trash')),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('dept.empty')),
    ),
  );
}

export function deptDialog(d) {
  const ar = input({ type: 'text', required: true, maxlength: 100, dir: 'rtl', value: d ? d.name_ar : '' });
  const en = input({ type: 'text', required: true, maxlength: 100, dir: 'ltr', value: d ? d.name_en : '' });
  const team = input({ type: 'checkbox', checked: d ? !!d.is_team : false });
  const auto = input({ type: 'checkbox', checked: d ? !!d.auto_assign : false });
  const cc = input({ type: 'text', maxlength: 30, dir: 'ltr', value: d ? d.cost_center || '' : '', pattern: '[A-Za-z0-9_./-]+' });
  const autoBox = h('div', { class: 'stack' }, checkField(t('dept.auto_assign'), auto), h('p', { class: 'hint' }, t('dept.auto_assign_hint')));
  const sync = () => (autoBox.hidden = !team.checked);
  team.addEventListener('change', sync);
  sync();
  openDialog({
    title: t(d ? 'dept.edit' : 'dept.add'),
    body: h('div', { class: 'stack' }, field(t('dept.name_ar'), ar), field(t('dept.name_en'), en), field(t('inv.cost_center'), cc, t('dept.cost_center_hint')), checkField(t('dept.is_team'), team), h('p', { class: 'muted small' }, t('dept.is_team_hint')), autoBox),
    onSubmit: async () => {
      await api(d ? '/departments/' + d.id : '/departments', { method: d ? 'PUT' : 'POST', body: { name_ar: ar.value, name_en: en.value, is_team: team.checked, auto_assign: team.checked && auto.checked, cost_center: cc.value } });
      toast(t(d ? 'dept.saved' : 'dept.added'));
      render();
    },
  });
}
export function deleteDept(d) {
  openDialog({
    title: t('dept.delete_q', { name: deptName(d) }),
    body: h('div', {}),
    submitLabel: t('common.delete'),
    danger: true,
    onSubmit: async () => {
      await api('/departments/' + d.id, { method: 'DELETE' });
      toast(t('dept.deleted'));
      render();
    },
  });
}

/* ------------------------------ file types ------------------------------ */

export async function typesPage(root, _param, alive) {
  let list;
  try {
    list = (await api('/doc-types')).doc_types;
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  S.docTypes = list;
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, t('nav.types')), h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => typeDialog(null) }, icon('plus'), t('dtype.add')))),
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
              h('thead', {}, h('tr', {}, ['dept.name_ar', 'dept.name_en', 'dept.files', 'common.actions'].map((c) => h('th', { scope: 'col' }, t(c))))),
              h(
                'tbody',
                {},
                list.map((x) =>
                  h(
                    'tr',
                    {},
                    h('td', { class: 'strong', dir: 'rtl' }, x.name_ar),
                    h('td', { dir: 'ltr' }, x.name_en),
                    h('td', {}, h('span', { class: 'mono' }, String(x.file_count))),
                    h(
                      'td',
                      {},
                      h(
                        'div',
                        { class: 'row-actions' },
                        h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': t('common.edit') + ': ' + typeName(x.key), title: t('common.edit'), onclick: () => typeDialog(x) }, icon('edit')),
                        h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': t('common.delete') + ': ' + typeName(x.key), title: t('common.delete'), onclick: () => deleteType(x) }, icon('trash')),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('dtype.empty')),
    ),
  );
}

export function typeDialog(x) {
  const ar = input({ type: 'text', required: true, maxlength: 100, dir: 'rtl', value: x ? x.name_ar : '' });
  const en = input({ type: 'text', required: true, maxlength: 100, dir: 'ltr', value: x ? x.name_en : '' });
  openDialog({
    title: t(x ? 'dtype.edit' : 'dtype.add'),
    body: h('div', { class: 'stack' }, field(t('dept.name_ar'), ar), field(t('dept.name_en'), en)),
    onSubmit: async () => {
      await api(x ? '/doc-types/' + x.id : '/doc-types', { method: x ? 'PUT' : 'POST', body: { name_ar: ar.value, name_en: en.value } });
      toast(t(x ? 'dtype.saved' : 'dtype.added'));
      render();
    },
  });
}
export function deleteType(x) {
  openDialog({
    title: t('dtype.delete_q', { name: typeName(x.key) }),
    body: h('div', {}),
    submitLabel: t('common.delete'),
    danger: true,
    onSubmit: async () => {
      await api('/doc-types/' + x.id, { method: 'DELETE' });
      toast(t('dtype.deleted'));
      render();
    },
  });
}
