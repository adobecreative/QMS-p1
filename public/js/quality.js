// Quality & Accreditation: CBAHI chapters (the system's home), their standards, the self-assessment
// and the readiness score. Each standard can name the JCI standards it matches.
import { render } from '../app.js';
import { kpiRow } from './assets.js';
import { lockedAdd, pdfViewer } from './docs.js';
import { S, h, has, icon, t } from './core.js';
import { link, navigate } from './layout.js';
import { api, checkField, errText, errorBox, field, fmtDate, input, openDialog, select, statusChip, toast } from './offline.js';
import { pick, simpleDelete } from './tickets.js';
import { fileDialog } from './xlsx.js';

export const STD_SCORES = ['met', 'partial', 'not_met', 'na'];
const SCORE_CHIP = { met: 'chip-valid', partial: 'chip-near', not_met: 'chip-expired', na: 'chip-review' };
export const scoreChip = (s) => h('span', { class: 'chip ' + (s ? SCORE_CHIP[s] : 'chip-review') }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t(s ? 'qa.score.' + s : 'qa.score.open'));
const pctText = (p) => (p === null || p === undefined ? '-' : p + '%');
// Green from 80%, yellow from 60%, red below (the usual accreditation-readiness bands).
const band = (p) => (p === null || p === undefined ? '' : p >= 80 ? 'is-good' : p >= 60 ? 'is-mid' : 'is-low');
export const meter = (p, label) => h('div', { class: 'qa-meter ' + band(p), role: 'img', 'aria-label': label + ': ' + pctText(p) }, h('span', { style: 'width:' + (p || 0) + '%' }));
const counts = (s) =>
  h(
    'div',
    { class: 'qa-counts' },
    ['met', 'partial', 'not_met', 'open'].map((k) => h('span', { class: 'qa-count qa-' + k }, h('b', {}, String(s[k] || 0)), ' ' + t('qa.score.' + k))),
  );
const chapterName = (c) => pick(c.name_ar, c.name_en);
// The framework a page shows: cbahi, jci or chi. CBAHI links stay as they were (quality/standards/LD);
// the others carry the framework (quality/standards/jci.FMS, or quality/standards/jci for all of JCI).
const FW = ['cbahi', 'jci', 'chi'];
const fwName = (f) => pick(f.name_ar, f.name_en);
const stdLink = (fw, code) => 'quality/standards' + (fw === 'cbahi' ? (code ? '/' + code : '') : '/' + fw + (code ? '.' + code : ''));
const fwQuery = (fw) => 'framework=' + encodeURIComponent(fw);
// How an element is named: JCI "ME 3", CBAHI and CHI the sub-standard code (LD.1.3).
const elLabel = (s, e) => (s.framework === 'jci' ? 'ME ' + e.num : s.code + '.' + e.num);
function fwTabs(d, here) {
  const on = d.frameworks.filter((f) => f.on);
  if (on.length < 2) return '';
  return h(
    'nav',
    { class: 'qa-fw-tabs', 'aria-label': t('qa.frameworks') },
    on.map((f) => link(here(f.key), { class: 'qa-fw-tab' + (f.key === d.framework ? ' is-active' : ''), 'aria-current': f.key === d.framework ? 'page' : null }, fwName(f), h('span', { class: 'qa-fw-n' }, String(f.n)))),
  );
}

/* ------------------------------ the chapters ------------------------------ */

export async function chaptersPage(root, param, alive) {
  let d;
  const want = FW.includes(String(param || '')) ? param : S.qaFw || '';
  try {
    d = await api('/quality' + (want ? '?' + fwQuery(want) : ''));
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  S.quality = d;
  S.qaFw = d.framework;
  const fw = d.framework;
  const card = (code, name, sub, stats, extra, cls, files) =>
    link(
      stdLink(fw, code),
      { class: 'qa-card' + (cls ? ' ' + cls : '') },
      h('div', { class: 'qa-card-head' }, h('span', { class: 'qa-code', dir: 'ltr' }, code), h('span', { class: 'qa-pct ' + band(stats.pct), dir: 'ltr' }, pctText(stats.pct))),
      h('span', { class: 'qa-name' }, name),
      sub ? h('span', { class: 'qa-sub' }, sub) : null,
      meter(stats.pct, t('qa.readiness')),
      h('span', { class: 'qa-n muted' }, t('qa.n_standards', { n: stats.n || 0 }), files ? ' · ' + t('qa.n_files', { n: files }) : ''),
      stats.n ? counts(stats) : null,
      extra,
    );
  const esrCard = !d.has_esr ? '' : card(
    'ESR',
    t('qa.esr'),
    t('qa.esr_sub'),
    d.esr,
    d.esr.esr_gap ? h('span', { class: 'qa-alert' }, icon('bell', 16), t('qa.esr_gap', { n: d.esr.esr_gap })) : null,
    'qa-card-esr',
  );
  const cards = d.chapters
    .filter((c) => c.active)
    .map((c) => {
      const linked = c.code === 'FMS' && d.fms ? h('span', { class: 'qa-linked' + (d.fms.error ? ' is-error' : '') }, t(d.fms.error ? 'qa.fms.badge_error' : 'qa.fms.badge')) : null;
      const el = card(c.code, chapterName(c), fw === 'cbahi' && c.jci ? 'JCI: ' + c.jci : '', c.stats, [c.stats.esr_gap ? h('span', { class: 'qa-alert' }, t('qa.esr_gap', { n: c.stats.esr_gap })) : null, linked], '', c.files);
      if (!d.can_manage) return el;
      return h('div', { class: 'qa-card-wrap' }, el, h('button', { type: 'button', class: 'btn btn-icon qa-edit', title: t('common.edit'), 'aria-label': t('common.edit') + ': ' + chapterName(c), onclick: () => chapterDialog(c, fw) }, icon('edit')));
    });
  const depts = d.departments.length
    ? h(
        'section',
        { class: 'panel' },
        h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('qa.by_dept')))),
        h(
          'div',
          { class: 'table-scroll' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, ['user.department', 'qa.standards', 'qa.readiness', 'qa.score.not_met', 'qa.esr_short'].map((c) => h('th', { scope: 'col' }, t(c))))),
            h(
              'tbody',
              {},
              d.departments.map((r) => {
                return h(
                  'tr',
                  {},
                  h('td', { class: 'strong' }, pick(r.name_ar, r.name_en)),
                  h('td', {}, h('span', { class: 'mono' }, String(r.n))),
                  h('td', {}, h('div', { class: 'qa-cell-meter' }, meter(r.pct, t('qa.readiness')), h('span', { class: 'mono nowrap', dir: 'ltr' }, pctText(r.pct)))),
                  h('td', {}, h('span', { class: 'mono' }, String(r.not_met))),
                  h('td', {}, r.esr_gap ? h('span', { class: 'chip chip-expired' }, String(r.esr_gap)) : h('span', { class: 'muted' }, '0')),
                );
              }),
            ),
          ),
        ),
      )
    : '';
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.chapters')), h('p', { class: 'muted' }, t('qa.chapters_sub_fw', { fw: fwName(d.frameworks.find((f) => f.key === fw)) }))),
      h(
        'div',
        { class: 'actions' },
        link(stdLink(fw), { class: 'btn' }, t('qa.all_standards')),
        d.can_manage ? h('button', { type: 'button', class: 'btn', onclick: () => frameworksDialog(d) }, icon('grid'), t('qa.frameworks')) : null,
        d.can_manage ? h('button', { type: 'button', class: 'btn', onclick: () => packDialog() }, icon('download'), t('qa.pack')) : null,
        d.can_manage ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => chapterDialog(null, fw) }, icon('plus'), t('qa.chapter_add')) : null,
      ),
    ),
    fwTabs(d, (k) => 'quality/chapters/' + k),
    kpiRow([
      ['qa.k_readiness', pctText(d.total.pct)],
      ['qa.k_standards', d.total.n || 0],
      ['qa.k_met', d.total.met || 0],
      ['qa.k_gaps', (d.total.partial || 0) + (d.total.not_met || 0)],
      ['qa.k_open', d.total.open || 0],
      ...(d.has_esr ? [['qa.k_esr', d.total.esr_gap || 0]] : []),
    ]),
    d.total.n ? '' : h('p', { class: 'notice' }, t(d.can_manage ? 'qa.empty_manager' : 'qa.empty')),
    h('section', { class: 'qa-grid', 'aria-label': t('nav.chapters') }, esrCard, cards),
    depts,
    h('p', { class: 'hint' }, t('qa.formula')),
  );
}

function chapterDialog(c, fw) {
  const code = input({ type: 'text', required: true, maxlength: 6, dir: 'ltr', pattern: '[A-Za-z&]{2,6}', value: c ? c.code : '', disabled: !!c });
  const nameAr = input({ type: 'text', required: true, maxlength: 120, dir: 'rtl', value: c ? c.name_ar : '' });
  const nameEn = input({ type: 'text', required: true, maxlength: 120, dir: 'ltr', value: c ? c.name_en : '' });
  const jci = input({ type: 'text', maxlength: 60, dir: 'ltr', value: c ? c.jci || '' : '', placeholder: 'GLD, QPS' });
  const active = input({ type: 'checkbox', checked: c ? !!c.active : true });
  openDialog({
    title: t(c ? 'qa.chapter_edit' : 'qa.chapter_add'),
    body: h(
      'div',
      { class: 'stack' },
      field(t('qa.chapter_code'), code, c ? null : t('qa.chapter_code_hint')),
      h('div', { class: 'form-grid' }, field(t('user.name_ar'), nameAr), field(t('user.name_en'), nameEn)),
      fw === 'cbahi' ? field(t('qa.jci_chapters'), jci, t('qa.jci_chapters_hint')) : null,
      c ? checkField(t('field.active'), active) : null,
    ),
    onSubmit: async () => {
      const body = { name_ar: nameAr.value, name_en: nameEn.value, jci: jci.value, active: active.checked };
      if (c) await api('/std-chapters/' + encodeURIComponent(c.code) + '?' + fwQuery(fw), { method: 'PUT', body });
      else await api('/std-chapters?' + fwQuery(fw), { method: 'POST', body: { ...body, code: code.value } });
      toast(t('qa.chapter_saved'));
      render();
    },
  });
}

/* ------------------------------ the standards ----------------------------- */

// quality/standards/LD: one chapter; quality/standards/ESR: every ESR; quality/standards: all of them.
export async function standardsPage(root, param, alive) {
  const raw = String(param || '');
  const m = /^(cbahi|jci|chi)(?:\.(.*))?$/.exec(raw);
  const fw = m ? m[1] : 'cbahi';
  const ch = String(m ? m[2] || '' : raw).toUpperCase();
  let d, list, files;
  const real = ch && ch !== 'ESR';
  try {
    [d, list, files] = await Promise.all([
      api('/quality?' + fwQuery(fw)),
      api('/standards?' + fwQuery(fw) + (ch ? '&chapter=' + encodeURIComponent(ch) : '')),
      real && fw === 'cbahi' ? api('/quality/files?chapter=' + encodeURIComponent(ch)) : null,
    ]);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  S.quality = d;
  S.qaFw = fw;
  const chapters = d.chapters;
  const chapter = chapters.find((c) => c.code === ch);
  const stds = list.standards;
  const f = (S.stdF = S.stdF || { q: '', score: '' });
  const title = ch === 'ESR' ? t('qa.esr') : chapter ? chapter.code + ' · ' + chapterName(chapter) : t('qa.all_standards');
  const stats = ch === 'ESR' ? d.esr : chapter ? chapter.stats : d.total;

  const pickCh = select([['', t('qa.all_chapters')], ...(d.has_esr ? [['ESR', 'ESR · ' + t('qa.esr')]] : []), ...chapters.map((c) => [c.code, c.code + ' · ' + chapterName(c)])], ch, { 'aria-label': t('qa.chapter') });
  pickCh.addEventListener('change', () => navigate(stdLink(fw, pickCh.value)));
  const score = select([['', t('qa.all_scores')], ['open', t('qa.score.open')], ...STD_SCORES.map((s) => [s, t('qa.score.' + s)])], f.score, { 'aria-label': t('qa.score') });
  const search = input({ type: 'search', class: 'doc-search-input', value: f.q, placeholder: t('qa.search_ph'), 'aria-label': t('qa.search'), autocomplete: 'off' });
  const box = h('div', {});
  const norm = (s) => String(s || '').toLowerCase();
  const draw = () => {
    const q = norm(f.q.trim());
    const rows = stds.filter((s) => (!f.score || (f.score === 'open' ? !s.score : s.score === f.score)) && (!q || [s.code, s.title_ar, s.title_en, s.jci, ...s.elements.map((e) => e.text)].some((v) => norm(v).includes(q))));
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
                { class: 'qa-table' },
                h('thead', {}, h('tr', {}, ['qa.code', 'qa.standard', ...(fw === 'cbahi' ? ['qa.jci'] : []), 'user.department', 'qa.score', 'common.actions'].map((c) => h('th', { scope: 'col' }, t(c))))),
                h('tbody', {}, rows.map((s) => stdRow(s, d.can_manage, chapters))),
              ),
            )
          : h('p', { class: 'empty' }, stds.length ? t('qa.no_match') : t(d.can_manage ? 'qa.empty_manager' : 'qa.empty')),
      ),
    );
  };
  search.addEventListener('input', () => {
    f.q = search.value;
    draw();
  });
  score.addEventListener('change', () => {
    f.score = score.value;
    draw();
  });
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, link('quality/chapters/' + fw, { class: 'back-link' }, t('nav.chapters')), h('h1', {}, title), h('p', { class: 'muted' }, ch === 'ESR' ? t('qa.esr_sub') : chapter && chapter.jci && fw === 'cbahi' ? t('qa.maps_to', { jci: chapter.jci }) : t('qa.standards_sub'))),
      h(
        'div',
        { class: 'actions' },
        ch && stds.some((s) => s.elements.length) ? link(assessLink(fw, ch), { class: 'btn' + (d.can_assess && !d.can_manage ? ' btn-primary' : '') }, icon('check'), t('qa.assess_chapter')) : null,
        d.can_manage ? h('button', { type: 'button', class: 'btn', onclick: () => importDialog(chapters, ch, fw) }, icon('download'), t('qa.import')) : null,
        d.can_manage ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => standardDialog(null, chapters, ch, fw) }, icon('plus'), t('qa.std_add')) : null,
      ),
    ),
    fwTabs(d, (k) => stdLink(k)),
    h('section', { class: 'panel qa-summary' }, h('div', { class: 'qa-summary-pct' }, h('b', { class: band(stats.pct), dir: 'ltr' }, pctText(stats.pct)), h('span', { class: 'muted' }, t('qa.readiness'))), h('div', { class: 'qa-summary-body' }, meter(stats.pct, t('qa.readiness')), counts(stats))),
    chapter && files ? filesPanel(chapter, files) : '',
    ch === 'FMS' && fw === 'cbahi' ? fmsPanel(d.fms) : '',
    chapter ? h('h2', { class: 'qa-section-title' }, t('qa.chapter_standards')) : '',
    h('div', { class: 'filters' }, h('div', { class: 'doc-search', role: 'search' }, icon('search'), search), pickCh, score),
    box,
  );
  draw();
}

/* --------------------------- the chapter's files -------------------------- */

// The chapter's files as tiles, like a library page: policies, plans, records. They live in the
// documents system, filed under this chapter; quality users read them here.
const TYPE_ICON = { policy: 'shield', program: 'grid', procedure: 'clipboard', plan: 'clipboard', form: 'edit', report: 'chart', license: 'award' };
function filesPanel(chapter, data) {
  const typeName = (k) => {
    const x = data.doc_types.find((y) => y.key === k);
    return x ? pick(x.name_ar, x.name_en) : k;
  };
  // A portal document carries its own type names (the portal has its own list of types).
  const kind = (f) => (f.portal && (f.type_ar || f.type_en) ? pick(f.type_ar, f.type_en) : typeName(f.doc_type));
  const tile = (f) =>
    h(
      'button',
      { type: 'button', class: 'qa-file', onclick: () => fileViewer(f, kind(f)), disabled: !f.has_pdf, title: pick(f.name, f.name_en) },
      h('span', { class: 'qa-file-icon' }, icon(TYPE_ICON[f.doc_type] || 'file', 26)),
      h('span', { class: 'qa-file-name' }, pick(f.name, f.name_en)),
      h('span', { class: 'qa-file-meta' }, h('span', { class: 'tag' }, kind(f)), f.portal ? h('span', { class: 'tag' }, t('pdoc.from_portal')) : null, h('span', { class: 'mono small', dir: 'ltr' }, f.file_number)),
      f.status !== 'none' ? statusChip(f.status) : null,
    );
  const add = data.locked
    ? lockedAdd(t('qa.file_add'))
    : data.can_add
    ? h(
        'button',
        {
          type: 'button',
          class: 'btn btn-primary',
          onclick: async () => {
            try {
              const [dp, ty] = await Promise.all([api('/departments?for=docs'), api('/doc-types')]);
              S.departments = dp.departments;
              S.docTypes = ty.doc_types;
              S.chapters = ty.chapters;
            } catch (e) {
              toast(errText(e), true);
              return;
            }
            fileDialog(null, { chapter: chapter.code });
          },
        },
        icon('plus'),
        t('qa.file_add'),
      )
    : null;
  return h(
    'section',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('qa.chapter_files')), h('span', { class: 'muted small' }, t('qa.n_files', { n: data.files.length }))), add),
    data.files.length ? h('div', { class: 'qa-files' }, data.files.map(tile)) : h('p', { class: 'empty' }, t(data.can_add ? 'qa.files_empty_admin' : 'qa.files_empty')),
  );
}

export function fileViewer(f, typeLabel) {
  const dlg = h(
    'dialog',
    { class: 'dialog dialog-wide' },
    h(
      'div',
      { class: 'dialog-body' },
      h('div', { class: 'qa-viewer-head' }, h('div', {}, h('span', { class: 'tag' }, typeLabel), h('h2', { class: 'dialog-title' }, pick(f.name, f.name_en)), h('p', { class: 'muted small' }, [pick(f.dept_ar, f.dept_en), f.file_number].filter(Boolean).join(' · '))), h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': t('common.close'), title: t('common.close'), onclick: () => dlg.close() }, icon('close'))),
      pdfViewer(f),
    ),
  );
  dlg.addEventListener('close', () => {
    document.body.classList.remove('no-scroll');
    dlg.remove();
  });
  document.body.append(dlg);
  dlg.showModal();
}

// The element badges: D = a document is needed (JCI), New = added in JCI's 8th edition.
const elBadges = (e) => [e.doc ? h('span', { class: 'chip chip-review qa-badge', title: t('qa.el_doc') }, 'D') : null, e.is_new ? h('span', { class: 'chip chip-near qa-badge', title: t('qa.el_new') }, t('qa.new')) : null];
// The standard's text: the hospital's Arabic wording, or the manual's English until it has one.
const stdText = (s) => (s.title_ar ? pick(s.title_ar, s.title_en) : h('span', { dir: 'ltr', lang: 'en' }, s.title_en));
function elementsList(s) {
  if (!s.elements.length) return null;
  const done = s.elements.filter((e) => e.score).length;
  return h(
    'details',
    { class: 'qa-els' },
    h('summary', {}, t(s.framework === 'jci' ? 'qa.els_me' : 'qa.els_sub', { n: s.elements.length }), done ? ' · ' + t('qa.els_done', { n: done }) : ''),
    h(
      'ol',
      { class: 'qa-el-list' },
      s.elements.map((e) =>
        h(
          'li',
          {},
          h('div', { class: 'qa-el-head' }, h('span', { class: 'mono small strong', dir: 'ltr' }, elLabel(s, e)), elBadges(e), e.score ? scoreChip(e.score) : null),
          h('p', { class: 'qa-el-text', dir: 'auto' }, e.text),
          e.note && e.score !== 'met' ? h('p', { class: 'small muted qa-note' }, e.note) : null,
        ),
      ),
    ),
  );
}

function stdRow(s, canManage, chapters) {
  const newEls = s.elements.filter((e) => e.is_new).length;
  return h(
    'tr',
    {},
    h('td', { class: 'nowrap' }, h('span', { class: 'mono strong', dir: 'ltr' }, s.code), s.esr ? [' ', h('span', { class: 'chip chip-expired qa-esr', title: t('qa.esr') }, 'ESR')] : null, newEls ? [' ', h('span', { class: 'chip chip-near qa-badge', title: t('qa.el_new') }, t('qa.new'))] : null),
    h('td', { class: 'wrap-cell' }, stdText(s), s.note && s.score !== 'met' ? h('p', { class: 'small muted qa-note' }, s.note) : null, elementsList(s)),
    s.framework === 'cbahi' ? h('td', { class: 'nowrap' }, s.jci ? h('span', { class: 'mono', dir: 'ltr' }, s.jci) : h('span', { class: 'muted' }, t('common.none'))) : null,
    h('td', {}, s.department_id ? pick(s.dept_ar, s.dept_en) : h('span', { class: 'muted' }, t('common.none'))),
    h('td', { class: 'nowrap' }, scoreChip(s.score), s.assessed_at ? h('div', { class: 'small muted' }, fmtDate(s.assessed_at.slice(0, 10))) : null),
    h(
      'td',
      {},
      h(
        'div',
        { class: 'row-actions' },
        s.can_score ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => (s.elements.length ? openAssess(s.framework, s.chapter, s.code) : assessDialog(s)) }, icon('check'), t('qa.assess')) : null,
        s.assessed_at ? h('button', { type: 'button', class: 'btn btn-icon', title: t('qa.history'), 'aria-label': t('qa.history') + ': ' + s.code, onclick: () => historyDialog(s) }, icon('clipboard')) : null,
        canManage ? h('button', { type: 'button', class: 'btn btn-icon', title: t('common.edit'), 'aria-label': t('common.edit') + ': ' + s.code, onclick: () => standardDialog(s, chapters, null, s.framework) }, icon('edit')) : null,
        canManage ? h('button', { type: 'button', class: 'btn btn-icon', title: t('common.delete'), 'aria-label': t('common.delete') + ': ' + s.code, onclick: () => simpleDelete(t('qa.std_delete_q', { code: s.code }), '/standards/' + s.id, t('qa.std_deleted')) }, icon('trash')) : null,
      ),
    ),
  );
}

function standardDialog(s, chapters, ch, fw) {
  const code = input({ type: 'text', required: true, maxlength: 30, dir: 'ltr', value: s ? s.code : ch && ch !== 'ESR' ? ch + '.' : '', placeholder: 'LD.1' });
  const chapter = select(chapters.map((c) => [c.code, c.code + ' · ' + chapterName(c)]), s ? s.chapter : ch && ch !== 'ESR' ? ch : chapters[0] && chapters[0].code, {});
  const titleAr = h('textarea', { rows: 3, required: !s || !!s.title_ar, maxlength: 1000, dir: 'rtl' }, s ? s.title_ar : '');
  const titleEn = h('textarea', { rows: 3, required: true, maxlength: 1000, dir: 'ltr' }, s ? s.title_en : '');
  const jci = input({ type: 'text', maxlength: 200, dir: 'ltr', value: s ? s.jci || '' : '', placeholder: 'GLD.1, GLD.3' });
  const esr = input({ type: 'checkbox', checked: s ? !!s.esr : ch === 'ESR' });
  const dept = select([['', t('common.none')], ...(S.quality.dept_list || []).map((x) => [x.id, pick(x.name_ar, x.name_en)])], s ? s.department_id ?? '' : '', {});
  const els = elementsEditor(s, fw, code);
  code.addEventListener('input', () => {
    const m = /^([A-Za-z&]{2,6})/.exec(code.value);
    if (m && chapters.some((c) => c.code === m[1].toUpperCase())) chapter.value = m[1].toUpperCase();
  });
  openDialog({
    title: t(s ? 'qa.std_edit' : 'qa.std_add'),
    body: h(
      'div',
      { class: 'stack' },
      h('div', { class: 'form-grid' }, field(t('qa.code'), code), field(t('qa.chapter'), chapter)),
      field(t('qa.title_ar'), titleAr, t('qa.title_hint')),
      field(t('qa.title_en'), titleEn),
      h('div', { class: 'form-grid' }, fw === 'cbahi' ? field(t('qa.jci'), jci, t('qa.jci_hint')) : null, field(t('qa.owner_dept'), dept, t('qa.owner_dept_hint'))),
      fw === 'cbahi' ? checkField(t('qa.esr_check'), esr) : null,
      els.box,
    ),
    onSubmit: async () => {
      const body = { framework: fw, code: code.value, chapter: chapter.value, title_ar: titleAr.value, title_en: titleEn.value, jci: jci.value, esr: esr.checked, department_id: dept.value ? Number(dept.value) : null, elements: els.value() };
      await api(s ? '/standards/' + s.id : '/standards', { method: s ? 'PUT' : 'POST', body });
      toast(t('qa.std_saved'));
      render();
    },
  });
}

// The standard's sub-standards (JCI: MEs) in the standard's dialog: number and text, added, changed, removed.
// One already scored cannot be removed, so its history stays.
function elementsEditor(s, fw, code) {
  const rows = (s ? s.elements : []).map((e) => ({ id: e.id, num: e.num, text: e.text, doc: e.doc, locked: !!(e.score || (e.activities || []).some((a) => a.score)) }));
  const list = h('ol', { class: 'qa-el-edit' });
  const prefix = () => (fw === 'jci' ? 'ME ' : (code.value.trim() || 'X') + '.');
  const draw = () =>
    list.replaceChildren(
      ...rows.map((r) => {
        const num = input({ type: 'text', dir: 'ltr', maxlength: 10, required: true, value: r.num, 'aria-label': t('qa.el_num') });
        num.addEventListener('input', () => (r.num = num.value));
        const text = h('textarea', { rows: 3, dir: 'auto', maxlength: 4000, required: true, 'aria-label': t('qa.el_text') }, r.text);
        text.addEventListener('input', () => (r.text = text.value));
        const del = h('button', {
          type: 'button',
          class: 'btn btn-icon btn-small',
          disabled: r.locked,
          title: t(r.locked ? 'qa.el_scored' : 'common.delete'),
          'aria-label': t('common.delete') + ': ' + prefix() + r.num,
          onclick: () => {
            rows.splice(rows.indexOf(r), 1);
            draw();
          },
        }, icon('trash', 16));
        return h('li', {}, h('div', { class: 'qa-el-edit-num' }, h('span', { class: 'mono small muted', dir: 'ltr' }, prefix()), num, del), text);
      }),
    );
  code.addEventListener('input', draw);
  draw();
  const add = h('button', {
    type: 'button',
    class: 'btn btn-small',
    onclick: () => {
      const next = rows.reduce((n, r) => Math.max(n, parseInt(r.num, 10) || 0), 0) + 1;
      rows.push({ id: null, num: String(next), text: '', doc: 0, locked: false });
      draw();
      list.querySelector('li:last-child textarea')?.focus();
    },
  }, icon('plus', 16), t(fw === 'jci' ? 'qa.me_add' : 'qa.el_add'));
  return {
    box: h('fieldset', { class: 'qa-el-fieldset' }, h('legend', {}, t(fw === 'jci' ? 'qa.els_me_title' : 'qa.els_title')), list, add),
    value: () => rows.map((r) => ({ id: r.id, num: r.num.trim(), text: r.text.trim(), doc: r.doc })),
  };
}

function assessDialog(s) {
  const choice = h(
    'div',
    { class: 'qa-choices', role: 'radiogroup', 'aria-label': t('qa.score') },
    STD_SCORES.map((v) => {
      const r = input({ type: 'radio', name: 'qa-score', value: v, checked: s.score === v, required: true });
      return h('label', { class: 'qa-choice qa-' + v }, r, h('span', {}, t('qa.score.' + v)));
    }),
  );
  const note = h('textarea', { rows: 3, maxlength: 2000 }, s.note || '');
  const evidence = input({ type: 'text', maxlength: 1000, value: s.evidence || '', placeholder: t('qa.evidence_ph') });
  openDialog({
    title: t('qa.assess') + ': ' + s.code,
    body: h(
      'div',
      { class: 'stack' },
      h('p', { class: 'qa-std-text' }, pick(s.title_ar, s.title_en)),
      s.jci ? h('p', { class: 'small muted' }, 'JCI: ', h('span', { dir: 'ltr' }, s.jci)) : null,
      s.esr ? h('p', { class: 'notice notice-warn' }, t('qa.esr_note')) : null,
      choice,
      field(t('qa.note'), note, t('qa.note_hint')),
      field(t('qa.evidence'), evidence, t('qa.evidence_hint')),
    ),
    onSubmit: async () => {
      const picked = choice.querySelector('input:checked');
      await api('/standards/' + s.id + '/score', { method: 'PUT', body: { score: picked ? picked.value : '', note: note.value, evidence: evidence.value } });
      toast(t('qa.assessed'));
      render();
    },
  });
}

async function historyDialog(s) {
  let d;
  try {
    d = await api('/standards/' + s.id + '/history');
  } catch (e) {
    toast(errText(e), true);
    return;
  }
  const when = new Intl.DateTimeFormat(S.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  openDialog({
    title: t('qa.history') + ': ' + s.code,
    submitLabel: t('common.close'),
    body: d.history.length
      ? h(
          'ol',
          { class: 'qa-history' },
          d.history.map((x) =>
            h('li', {}, h('div', { class: 'qa-history-head' }, scoreChip(x.score), h('span', { class: 'small muted' }, when.format(new Date(x.at)) + ' · ' + (x.user_name || ''))), x.note ? h('p', { class: 'small' }, x.note) : null, x.evidence ? h('p', { class: 'small muted' }, t('qa.evidence') + ': ' + x.evidence) : null),
          ),
        )
      : h('p', { class: 'empty' }, t('qa.history_empty')),
    onSubmit: async () => {},
  });
}

// The pasted lines that hold a standard: not empty, not the header row.
const importLines = (text) => text.split(/\r?\n/).filter((l) => l.split('\t')[0].trim() && !/^(code|الرمز|رمز)$/i.test(l.split('\t')[0].trim()));

// Paste rows straight from Excel: code, Arabic text, English text, ESR, JCI (the chapter comes from the code).
function importDialog(chapters, ch, fw) {
  const area = h('textarea', { rows: 10, dir: 'auto', class: 'mono', placeholder: 'LD.1\tنص المعيار\tStandard text\tESR\tGLD.1' });
  const result = h('div', { class: 'small', role: 'status' });
  openDialog({
    title: t('qa.import'),
    submitLabel: t('qa.import_go'),
    body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('qa.import_help')), h('p', { class: 'small muted' }, t('qa.import_cols')), area, result),
    onSubmit: async () => {
      const lines = importLines(area.value);
      const rows = lines
        .map((c) => c.split('\t').map((x) => x.trim()))
        .map(([code, title_ar, title_en, esr, jci]) => ({ code, title_ar, title_en, esr: /^(1|y|yes|esr|نعم|✓)$/i.test(esr || '') ? 1 : 0, jci: jci || '' }));
      if (!rows.length) throw new Error(t('qa.import_empty'));
      const r = await api('/standards/import', { method: 'POST', body: { framework: fw, rows } });
      toast(t('qa.import_done', { n: r.saved }) + (r.errors.length ? ' · ' + t('qa.import_errors', { n: r.errors.length }) : ''), !!r.errors.length);
      if (r.errors.length) {
        // Keep the dialog open on the rows that failed, so they can be fixed and sent again.
        result.replaceChildren(h('p', { class: 'form-error' }, t('qa.import_errors', { n: r.errors.length }) + ': ' + r.errors.slice(0, 8).map((e) => (e.code || '#' + e.row) + ' (' + t('err.' + e.error) + ')').join('، ')));
        const bad = new Set(r.errors.map((e) => e.row));
        area.value = lines.filter((_, i) => bad.has(i + 1)).join('\n');
        render();
        throw new Error(t('qa.import_fix'));
      }
      render();
    },
  });
  if (ch) area.focus();
}

/* --------------------------- scoring a chapter ---------------------------- */

// quality/assess/FMS (CBAHI) or quality/assess/jci.FMS: the chapter's standards one page at a time, each
// sub-standard (or ME) scored by activity, saved as it is scored, with the chapter's tally on top.
const assessLink = (fw, code) => 'quality/assess/' + (fw === 'cbahi' ? code : fw + '.' + code);
function openAssess(fw, chapter, code) {
  S.qaGo = code;
  navigate(assessLink(fw, chapter));
}
// The surveyors' marks: CBAHI and CHI 2 / 1 / 0, JCI 10 / 5 / 0, and NA.
const MARKS = { cbahi: { met: '2', partial: '1', not_met: '0', na: 'NA' }, jci: { met: '10', partial: '5', not_met: '0', na: 'NA' } };
const marks = (fw) => MARKS[fw] || MARKS.cbahi;
const ACTIVITIES = ['document', 'observation', 'interview'];
// A first guess for a sub-standard with no activity yet; it can be changed on the page.
const DOC_RE = /\b(policy|policies|procedure|plan|program|programme|written|documented|records?|minutes|log|bylaws|approved)\b/i;
const guessKind = (e) => (e.doc || DOC_RE.test(e.text) ? 'document' : 'observation');
const isGap = (a) => a.score === 'partial' || a.score === 'not_met';
const needsNote = (a) => isGap(a) && !String(a.note || '').trim();
// The element's own text, and its listed items (the "•" lines) numbered under it: FMS.33.1.1, FMS.33.1.2...
function elBody(s, e) {
  const [lead, ...items] = String(e.text).split(/\n\s*[•▪●◦-]\s*/);
  const label = elLabel(s, e);
  return [
    h('p', { class: 'qa-el-text', dir: 'auto' }, lead.trim()),
    items.length
      ? h(
          'ol',
          { class: 'qa-subitems', dir: 'ltr', lang: 'en' },
          items.map((x, i) => h('li', {}, s.framework === 'jci' ? null : h('span', { class: 'mono qa-subitem-code' }, label + '.' + (i + 1)), x.trim())),
        )
      : null,
  ];
}

export async function assessPage(root, param, alive) {
  const raw = String(param || '');
  const m = /^(cbahi|jci|chi)(?:\.(.*))?$/.exec(raw);
  const fw = m ? m[1] : 'cbahi';
  const ch = String(m ? m[2] || '' : raw).toUpperCase();
  if (!ch) return navigate('quality/chapters/' + fw);
  let d, list;
  try {
    [d, list] = await Promise.all([api('/quality?' + fwQuery(fw)), api('/standards?' + fwQuery(fw) + '&chapter=' + encodeURIComponent(ch))]);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  S.quality = d;
  S.qaFw = fw;
  const chapter = d.chapters.find((c) => c.code === ch);
  const title = ch === 'ESR' ? t('qa.esr') : chapter ? chapter.code + ' · ' + chapterName(chapter) : ch;
  const stds = list.standards;
  // Every element works from a list of activities; one not scored by activity yet shows a single one,
  // carrying the element's own score, until it is saved.
  for (const s of stds)
    for (const e of s.elements)
      e.acts = e.activities.length ? e.activities.map((a) => ({ ...a, note: a.note || '' })) : [{ id: null, kind: guessKind(e), score: e.score || null, note: e.note || '' }];
  const mk = marks(fw);
  const key = fw + '.' + ch;
  const pos = (S.qaPos = S.qaPos || {});
  if (S.qaGo) {
    const i = stds.findIndex((s) => s.code === S.qaGo);
    if (i >= 0) pos[key] = i;
    S.qaGo = null;
  }
  let at = Math.min(pos[key] || 0, Math.max(stds.length - 1, 0));

  const acts = (s) => s.elements.flatMap((e) => e.acts);
  const state = (s) => {
    const a = acts(s);
    if (!a.length) return s.score ? 'done' : 'empty';
    const n = a.filter((x) => x.score).length;
    return a.some(needsNote) ? 'note' : n === a.length ? 'done' : n ? 'part' : 'empty';
  };
  const tally = h('div', { class: 'qa-tally', role: 'status' });
  const pager = h('nav', { class: 'qa-pager', 'aria-label': t('qa.pages') });
  const page = h('div', { class: 'qa-page' });
  const drawTally = () => {
    const all = stds.flatMap(acts);
    const items = [
      ['qa.t_standards', stds.length],
      ['qa.t_subs', stds.reduce((n, s) => n + s.elements.length, 0)],
      ['qa.t_scorables', all.length],
      ['qa.t_scored', all.filter((a) => a.score).length],
      ['qa.t_needs_note', all.filter(needsNote).length],
    ];
    tally.replaceChildren(...items.map(([k, n], i) => h('span', { class: 'qa-tally-item' + (i === 4 && n ? ' is-warn' : '') }, h('span', { class: 'muted' }, t(k)), h('b', { class: 'mono' }, String(n)))));
  };
  const drawPager = () =>
    pager.replaceChildren(
      ...stds.map((s, i) =>
        h(
          'button',
          { type: 'button', class: 'qa-pg qa-pg-' + state(s) + (i === at ? ' is-here' : ''), 'aria-current': i === at ? 'page' : null, title: s.code + ' · ' + t('qa.pg.' + state(s)), 'aria-label': s.code + ' · ' + t('qa.pg.' + state(s)), onclick: () => go(i) },
          String(i + 1),
        ),
      ),
    );
  const refresh = () => {
    drawTally();
    drawPager();
  };

  // Saving: one element at a time, in order, with what the page holds when the request leaves.
  const saver = (s, e, status) => {
    let chain = Promise.resolve();
    let timer = null;
    const send = async () => {
      const snap = e.acts.slice();
      status.textContent = t('qa.saving');
      status.className = 'qa-save small muted';
      try {
        const r = await api('/standards/' + s.id + '/elements/' + e.id, { method: 'PUT', body: { activities: snap.map((a) => ({ id: a.id, kind: a.kind, score: a.score, note: a.note })) } });
        r.activities.forEach((x, i) => (snap[i].id = x.id));
        e.score = r.element.score;
        s.score = r.score;
        status.textContent = t('qa.saved');
      } catch (err) {
        status.textContent = errText(err);
        status.className = 'qa-save small form-error';
      }
    };
    return (wait) => {
      clearTimeout(timer);
      timer = setTimeout(() => (chain = chain.then(send)), wait || 0);
    };
  };

  const activityRow = (s, e, a, save, redraw) => {
    const can = s.can_score;
    const name = 'qa-a-' + e.id + '-' + Math.random().toString(36).slice(2, 8);
    const kind = can ? select(ACTIVITIES.map((k) => [k, t('qa.act.' + k)]), a.kind, { class: 'qa-kind', 'aria-label': t('qa.activity') }) : h('span', { class: 'tag' }, t('qa.act.' + a.kind));
    if (can)
      kind.addEventListener('change', () => {
        a.kind = kind.value;
        save();
      });
    const pills = h(
      'div',
      { class: 'qa-marks', role: 'radiogroup', 'aria-label': t('qa.score') + ': ' + elLabel(s, e) },
      STD_SCORES.map((v) => {
        const r = input({ type: 'radio', name, value: v, checked: a.score === v, disabled: !can });
        r.addEventListener('change', () => {
          a.score = v;
          sync();
          refresh();
          save();
        });
        return h('label', { class: 'qa-mark qa-' + v, title: t('qa.score.' + v) }, r, h('span', { dir: 'ltr' }, mk[v]));
      }),
    );
    const clear = can
      ? h('button', {
          type: 'button',
          class: 'btn-link small',
          onclick: () => {
            a.score = null;
            pills.querySelectorAll('input').forEach((x) => (x.checked = false));
            sync();
            refresh();
            save();
          },
        }, t('qa.clear'))
      : null;
    const note = input({ type: 'text', class: 'qa-act-note', maxlength: 1000, value: a.note, placeholder: t('qa.comment'), 'aria-label': t('qa.comment') + ': ' + elLabel(s, e), disabled: !can });
    note.addEventListener('input', () => {
      a.note = note.value;
      sync();
      refresh();
    });
    note.addEventListener('change', () => save());
    const drop =
      can && e.acts.length > 1
        ? h('button', {
            type: 'button',
            class: 'btn btn-icon btn-small',
            title: t('qa.act_remove'),
            'aria-label': t('qa.act_remove'),
            onclick: () => {
              e.acts.splice(e.acts.indexOf(a), 1);
              redraw();
              refresh();
              save();
            },
          }, icon('close', 16))
        : null;
    const row = h('div', { class: 'qa-act' }, h('div', { class: 'qa-act-head' }, kind, pills, clear, drop), note);
    const sync = () => row.classList.toggle('is-need', needsNote(a));
    sync();
    return row;
  };

  const elementBlock = (s, e) => {
    const status = h('span', { class: 'qa-save small muted', role: 'status' });
    const save = saver(s, e, status);
    const box = h('div', { class: 'qa-acts' });
    const redraw = () => box.replaceChildren(...e.acts.map((a) => activityRow(s, e, a, (w) => save(w), redraw)));
    redraw();
    const add = s.can_score
      ? h('button', {
          type: 'button',
          class: 'btn-link small',
          onclick: () => {
            const used = new Set(e.acts.map((a) => a.kind));
            e.acts.push({ id: null, kind: ACTIVITIES.find((k) => !used.has(k)) || 'observation', score: null, note: '' });
            redraw();
            refresh();
            save();
          },
        }, icon('plus', 14), t('qa.act_add'))
      : null;
    return h(
      'li',
      { class: 'qa-el-assess' },
      h('div', { class: 'qa-el-head' }, h('span', { class: 'mono small strong qa-el-code', dir: 'ltr' }, elLabel(s, e)), elBadges(e), status),
      elBody(s, e),
      box,
      add,
    );
  };

  const go = (i) => {
    at = Math.max(0, Math.min(i, stds.length - 1));
    pos[key] = at;
    draw();
    root.querySelector('.qa-tally')?.scrollIntoView({ block: 'nearest' });
  };
  const draw = () => {
    drawPager();
    const s = stds[at];
    if (!s) {
      page.replaceChildren(h('p', { class: 'empty' }, t('qa.no_standards')));
      return;
    }
    page.replaceChildren(
      h(
        'article',
        { class: 'panel qa-std' },
        h(
          'div',
          { class: 'qa-std-head' },
          h('span', { class: 'qa-std-code mono', dir: 'ltr' }, s.code),
          h('div', { class: 'qa-std-title' }, h('p', { class: 'strong' }, stdText(s)), h('div', { class: 'qa-std-tags' }, s.esr && fw === 'cbahi' ? h('span', { class: 'chip chip-expired qa-esr' }, 'ESR') : null, s.jci && fw === 'cbahi' ? h('span', { class: 'small muted', dir: 'ltr' }, 'JCI ' + s.jci) : null, scoreChip(s.score))),
        ),
        s.elements.length
          ? h('ol', { class: 'qa-el-list' }, s.elements.map((e) => elementBlock(s, e)))
          : h('p', {}, s.can_score ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => assessDialog(s) }, icon('check'), t('qa.assess')) : null),
      ),
      h(
        'div',
        { class: 'qa-std-nav' },
        h('button', { type: 'button', class: 'btn', disabled: at === 0, onclick: () => go(at - 1) }, t('qa.prev')),
        h('span', { class: 'muted small mono', dir: 'ltr' }, at + 1 + ' / ' + stds.length),
        h('button', { type: 'button', class: 'btn btn-primary', disabled: at >= stds.length - 1, onclick: () => go(at + 1) }, t('qa.next')),
      ),
    );
  };
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, link(stdLink(fw, ch), { class: 'back-link' }, title), h('h1', {}, t('qa.assess_chapter')))),
    h('div', { class: 'qa-assess-top' }, tally, pager),
    page,
  );
  drawTally();
  draw();
}

/* ----------------------- frameworks and import packs ----------------------- */

// Which frameworks the hospital works with; the first one opens by default.
function frameworksDialog(d) {
  const boxes = d.frameworks.map((f) => ({ f, box: input({ type: 'checkbox', checked: f.on }) }));
  openDialog({
    title: t('qa.frameworks'),
    body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('qa.frameworks_help')), boxes.map(({ f, box }) => checkField(fwName(f) + ' (' + t('qa.n_standards', { n: f.n }) + ')', box))),
    onSubmit: async () => {
      const on = boxes.filter((b) => b.box.checked).map((b) => b.f.key);
      if (!on.length) throw new Error(t('qa.frameworks_one'));
      await api('/quality/frameworks', { method: 'PUT', body: { on } });
      toast(t('qa.frameworks_saved'));
      render();
    },
  });
}

// An import pack: a JSON file built from the hospital's own copy of a manual (CBAHI, JCI, CHI). It is sent in
// small parts so each request stays light; sending the same pack again updates the texts and keeps the scores.
export const PACK_PART = 25;
export function packParts(pack) {
  const list = pack.standards || [];
  const parts = [];
  for (let i = 0; i < list.length; i += PACK_PART) parts.push(list.slice(i, i + PACK_PART));
  return parts.length ? parts : [[]];
}
function packDialog() {
  const file = input({ type: 'file', accept: '.json,application/json', required: true });
  const info = h('div', { class: 'small', role: 'status' });
  const bar = h('progress', { max: 100, value: 0, hidden: true, class: 'qa-progress' });
  let pack = null;
  file.addEventListener('change', async () => {
    pack = null;
    info.replaceChildren();
    const f = file.files[0];
    if (!f) return;
    try {
      const p = JSON.parse(await f.text());
      if (p.format !== 'qms-standards-pack' || !FW.includes(p.framework) || !Array.isArray(p.standards)) throw new Error();
      pack = p;
      const els = p.standards.reduce((n, s) => n + (s.elements ? s.elements.length : 0), 0);
      info.replaceChildren(h('p', {}, h('b', {}, p.title || p.framework.toUpperCase()), ' · ', t('qa.pack_counts', { c: (p.chapters || []).length, s: p.standards.length, e: els })));
    } catch {
      info.replaceChildren(h('p', { class: 'form-error' }, t('qa.pack_bad')));
    }
  });
  openDialog({
    title: t('qa.pack'),
    submitLabel: t('qa.import_go'),
    body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('qa.pack_help')), field(t('qa.pack_file'), file), info, bar),
    onSubmit: async () => {
      if (!pack) throw new Error(t('qa.pack_bad'));
      const parts = packParts(pack);
      bar.hidden = false;
      let saved = 0;
      const errors = [];
      for (let i = 0; i < parts.length; i++) {
        const r = await api('/standards/pack', {
          method: 'POST',
          body: { framework: pack.framework, edition: pack.edition || '', chapters: i === 0 ? pack.chapters || [] : [], standards: parts[i], first: i === 0, last: i === parts.length - 1 },
        });
        saved += r.saved;
        errors.push(...r.errors);
        bar.value = Math.round(((i + 1) / parts.length) * 100);
      }
      toast(t('qa.import_done', { n: saved }) + (errors.length ? ' · ' + t('qa.import_errors', { n: errors.length }) : ''), !!errors.length);
      S.qaFw = pack.framework;
      navigate('quality/chapters/' + pack.framework);
      render();
    },
  });
}

/* ------------------- the optional link to the Fikra portal ------------------ */

const when = (iso) => new Intl.DateTimeFormat(S.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const linkError = (code) => t(has('err.' + code) ? 'err.' + code : 'err.link_unreachable');

// FMS evidence from the portal, on the FMS chapter (and the ESR and all-standards views).
export function fmsPanel(f) {
  if (!f) return '';
  const sn = f.snapshot;
  const portal = f.portal ? (() => { try { const p = JSON.parse(f.portal); return pick(p.name_ar, p.name_en); } catch { return ''; } })() : '';
  const rows = [];
  if (sn && sn.tickets) {
    const tk = sn.tickets;
    rows.push(
      ['qa.fms.open', tk.open + (tk.open_partial ? '+' : '')],
      ['qa.fms.late', tk.late],
      ['qa.fms.patient', tk.patient_impact],
      ['qa.fms.closed30', tk.closed_30],
      ['qa.fms.sla', pctText(tk.sla_pct)],
      ['qa.fms.wo30', tk.work_orders_30],
    );
  }
  if (sn && sn.assets) {
    const a = sn.assets;
    rows.push(['qa.fms.assets', a.total + (a.partial ? '+' : '')], ['qa.fms.down', a.out_of_service], ['qa.fms.pm', pctText(a.pm_pct)], ['qa.fms.pm_overdue', a.pm_overdue], ['qa.fms.high_risk', a.high_risk]);
  }
  return h(
    'section',
    { class: 'panel qa-fms' },
    h(
      'div',
      { class: 'panel-head' },
      h('div', { class: 'panel-title' }, h('h2', {}, t('qa.fms.title')), portal ? h('span', { class: 'muted small' }, portal) : null),
      h('span', { class: 'small muted' }, f.synced_at ? t('qa.fms.synced', { at: when(sn ? sn.at : f.synced_at) }) : t('qa.fms.never')),
    ),
    f.error ? h('p', { class: 'notice notice-warn qa-fms-note' }, t('qa.fms.error', { err: linkError(f.error) })) : null,
    rows.length ? kpiRow(rows) : h('p', { class: 'empty' }, t('qa.fms.empty')),
    h('p', { class: 'hint qa-fms-note' }, t('qa.fms.hint')),
  );
}

// Admin Center, system owner only: switch the link on, the portal's address and its read-only key.
export function linkPanel() {
  const box = h('section', { class: 'panel pad stack settings', 'aria-busy': 'true' }, h('h2', {}, t('link.title')));
  api('/fms-link')
    .then((d) => draw(d))
    .catch(() => box.remove());
  const draw = (d) => {
    const on = input({ type: 'checkbox', checked: d.on });
    const url = input({ type: 'url', dir: 'ltr', maxlength: 300, value: d.url, placeholder: 'https://portal.example.com' });
    const key = input({ type: 'password', dir: 'ltr', maxlength: 60, autocomplete: 'off', placeholder: 'fms_...' });
    const fields = h('div', { class: 'stack' }, field(t('link.url'), url, t('link.url_hint')), field(t('link.key'), key, d.key_set ? t('link.key_set') : t('link.key_hint')));
    const show = () => (fields.hidden = !on.checked);
    on.addEventListener('change', show);
    show();
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const status = d.on
      ? h('p', { class: 'small ' + (d.error ? 'form-error' : 'muted') }, d.error ? t('link.failed', { err: linkError(d.error) }) : d.synced_at ? t('link.ok', { at: when(d.synced_at) }) : t('qa.fms.never'))
      : h('p', { class: 'small muted' }, t('link.off'));
    const save = h('button', { type: 'submit', class: 'btn btn-primary' }, t('common.save'));
    const sync = d.on ? h('button', { type: 'button', class: 'btn' }, t('link.sync')) : '';
    if (sync)
      sync.addEventListener('click', async () => {
        sync.disabled = true;
        try {
          const r = await api('/fms-link/sync', { method: 'POST' });
          toast(r.ok ? t('link.synced') : t('link.failed', { err: linkError(r.error) }), !r.ok);
          draw(await api('/fms-link'));
        } catch (e) {
          toast(errText(e), true);
          sync.disabled = false;
        }
      });
    // What the key lets this system read, from the last sync (the portal decides it on the key).
    const scopes = (d.snapshot && d.snapshot.scopes) || [];
    const reads = d.on && d.snapshot
      ? h('p', { class: 'small' }, t('link.reads') + ': ', ['tickets_read', 'assets_read', 'docs_read', 'staff'].flatMap((k) => [h('span', { class: 'chip' + (scopes.includes(k) ? ' chip-valid' : ' muted') }, (scopes.includes(k) ? '✓ ' : '') + t('link.read.' + k)), ' ']))
      : '';
    const form = h('form', { class: 'stack' }, checkField(t('link.on'), on), fields, status, reads, err, h('div', { class: 'actions' }, save, sync));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      err.hidden = true;
      save.disabled = true;
      try {
        const r = await api('/fms-link', { method: 'PUT', body: { on: on.checked, url: url.value, key: key.value } });
        toast(!r.on ? t('link.saved_off') : r.sync && !r.sync.ok ? t('link.failed', { err: linkError(r.sync.error) }) : t('link.saved_on'), !!(r.on && r.sync && !r.sync.ok));
        draw(r);
      } catch (e) {
        err.textContent = errText(e);
        err.hidden = false;
        save.disabled = false;
      }
    });
    box.removeAttribute('aria-busy');
    box.replaceChildren(h('h2', {}, t('link.title')), h('p', { class: 'muted' }, t('link.help')), form);
  };
  return box;
}

/* ----------------------- the Fikra portal's documents ---------------------- */

// Document Control → Portal documents: the register read over the optional link. The files stay in the
// portal; a quality manager or documents admin files each one under a CBAHI chapter, where it shows as evidence.
// mode: 'dash' (the dashboard: status cards) or 'list' (the documents page). Old links to pdocs open the list.
export async function portalDocsPage(root, mode, alive) {
  const dash = mode === 'dash';
  let d;
  try {
    d = await api('/portal-docs');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const f = (S.pdocF = S.pdocF || { q: '', chapter: '', status: '', type: '', dept: '' });
  const uniq = (key, en) => [...new Map(d.docs.filter((x) => x[key]).map((x) => [x[key], pick(x[key], x[en])])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const pickType = select([['', t('pdoc.all_types')], ...uniq('type_ar', 'type_en')], f.type, { 'aria-label': t('pdoc.all_types') });
  const pickDept = select([['', t('pdoc.all_depts')], ...uniq('department_ar', 'department_en')], f.dept, { 'aria-label': t('pdoc.all_depts') });
  const cards = dash ? h('section', { class: 'cards', 'aria-label': t('dash.summary') }) : '';
  const chName = (c) => c.code + ' · ' + pick(c.name_ar, c.name_en);
  const search = input({ type: 'search', class: 'doc-search-input', value: f.q, placeholder: t('pdoc.search_ph'), 'aria-label': t('qa.search'), autocomplete: 'off' });
  const pickCh = select([['', t('qa.all_chapters')], ['-', t('pdoc.unfiled')], ...d.chapters.map((c) => [c.code, chName(c)])], f.chapter, { 'aria-label': t('qa.chapter') });
  const box = h('div', {});
  const norm = (v) => String(v || '').toLowerCase();
  const chapterCell = (doc) => {
    if (!d.can_file) {
      const c = d.chapters.find((x) => x.code === doc.chapter);
      return c ? chName(c) : h('span', { class: 'muted' }, '-');
    }
    const sel = select([['', t('pdoc.no_chapter')], ...d.chapters.map((c) => [c.code, chName(c)])], doc.chapter || '', { 'aria-label': t('qa.chapter') + ': ' + doc.name_ar });
    sel.addEventListener('change', async () => {
      sel.disabled = true;
      try {
        await api('/portal-docs/' + doc.id, { method: 'PUT', body: { chapter: sel.value } });
        doc.chapter = sel.value || null;
        toast(t('pdoc.filed'));
      } catch (e) {
        toast(errText(e), true);
        sel.value = doc.chapter || '';
      }
      sel.disabled = false;
    });
    return sel;
  };
  const draw = () => {
    const q = norm(f.q.trim());
    const base = d.docs.filter(
      (x) =>
        (!f.chapter || (f.chapter === '-' ? !x.chapter : x.chapter === f.chapter)) &&
        (!f.type || x.type_ar === f.type) &&
        (!f.dept || x.department_ar === f.dept) &&
        (!q || [x.name_ar, x.name_en, x.file_number, x.department_ar, x.department_en].some((v) => norm(v).includes(q))),
    );
    const rows = base.filter((x) => !dash || !f.status || (x.status || 'none') === f.status);
    const counts = { valid: 0, near: 0, expired: 0, review: 0 };
    base.forEach((x) => x.status in counts && counts[x.status]++);
    if (dash) cards.replaceChildren(
      ...['valid', 'near', 'expired', 'review'].map((st) =>
        h(
          'button',
          {
            type: 'button',
            class: 'card card-' + st,
            'aria-pressed': String(f.status === st),
            onclick: () => {
              f.status = f.status === st ? '' : st;
              draw();
            },
          },
          h('span', { class: 'card-label' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('status.' + st)),
          h('span', { class: 'card-num' }, String(counts[st])),
        ),
      ),
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
                h('thead', {}, h('tr', {}, ['pdoc.name', 'user.department', 'pdoc.expiry', 'pdoc.status', 'qa.chapter'].map((c) => h('th', { scope: 'col' }, t(c))))),
                h(
                  'tbody',
                  {},
                  rows.map((x) =>
                    h(
                      'tr',
                      {},
                      h(
                        'td',
                        { class: 'wrap-cell' },
                        x.has_pdf
                          ? h('button', { type: 'button', class: 'btn-link strong', onclick: () => fileViewer({ ...x, name: x.name_ar, dept_ar: x.department_ar, dept_en: x.department_en }, pick(x.type_ar, x.type_en) || x.doc_type) }, pick(x.name_ar, x.name_en))
                          : h('span', { class: 'strong' }, pick(x.name_ar, x.name_en)),
                        h('div', { class: 'small muted' }, [pick(x.type_ar, x.type_en), x.file_number].filter(Boolean).join(' · ')),
                      ),
                      h('td', {}, pick(x.department_ar, x.department_en) || '-'),
                      h('td', {}, x.expiry_date ? h('span', { dir: 'ltr' }, fmtDate(x.expiry_date)) : h('span', { class: 'muted' }, '-')),
                      h('td', {}, statusChip(x.status || 'none')),
                      h('td', {}, chapterCell(x)),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty' }, d.docs.length ? t('qa.no_match') : t('pdoc.empty')),
      ),
    );
  };
  search.addEventListener('input', () => {
    f.q = search.value;
    draw();
  });
  pickCh.addEventListener('change', () => {
    f.chapter = pickCh.value;
    draw();
  });
  pickType.addEventListener('change', () => {
    f.type = pickType.value;
    draw();
  });
  pickDept.addEventListener('change', () => {
    f.dept = pickDept.value;
    draw();
  });
  const filed = d.docs.filter((x) => x.chapter).length;
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t(dash ? 'nav.dashboard' : 'nav.documents')), h('p', { class: 'muted' }, t('pdoc.sub', { n: d.docs.length, filed }))),
      S.user.docs === 'admin' || S.user.docs === 'dept_admin' ? h('div', { class: 'actions' }, lockedAdd(t('file.add'))) : '',
    ),
    !d.on ? h('p', { class: 'notice notice-warn' }, t('pdoc.off')) : d.error ? h('p', { class: 'notice notice-warn' }, t('qa.fms.error', { err: linkError(d.error) })) : '',
    cards,
    h('div', { class: 'filters' }, h('div', { class: 'doc-search', role: 'search' }, icon('search'), search), pickDept, pickType, pickCh),
    box,
  );
  draw();
}
