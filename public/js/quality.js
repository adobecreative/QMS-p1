// Quality & Accreditation: CBAHI chapters (the system's home), their standards, the self-assessment
// and the readiness score. Each standard can name the JCI standards it matches.
import { render } from '../app.js';
import { kpiRow } from './assets.js';
import { S, h, icon, t } from './core.js';
import { link, navigate } from './layout.js';
import { api, checkField, errText, errorBox, field, fmtDate, input, openDialog, select, toast } from './offline.js';
import { pick, simpleDelete } from './tickets.js';

export const STD_SCORES = ['met', 'partial', 'not_met', 'na'];
const SCORE_CHIP = { met: 'chip-valid', partial: 'chip-near', not_met: 'chip-expired', na: 'chip-review' };
export const scoreChip = (s) => h('span', { class: 'chip ' + (s ? SCORE_CHIP[s] : 'chip-review') }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t(s ? 'qa.score.' + s : 'qa.score.open'));
const pctText = (p) => (p === null || p === undefined ? '-' : p + '%');
// Green from 80%, yellow from 60%, red below (the usual accreditation-readiness bands).
const band = (p) => (p === null || p === undefined ? '' : p >= 80 ? 'is-good' : p >= 60 ? 'is-mid' : 'is-low');
const meter = (p, label) => h('div', { class: 'qa-meter ' + band(p), role: 'img', 'aria-label': label + ': ' + pctText(p) }, h('span', { style: 'width:' + (p || 0) + '%' }));
const counts = (s) =>
  h(
    'div',
    { class: 'qa-counts' },
    ['met', 'partial', 'not_met', 'open'].map((k) => h('span', { class: 'qa-count qa-' + k }, h('b', {}, String(s[k] || 0)), ' ' + t('qa.score.' + k))),
  );
const chapterName = (c) => pick(c.name_ar, c.name_en);

/* ------------------------------ the chapters ------------------------------ */

export async function chaptersPage(root, _param, alive) {
  let d;
  try {
    d = await api('/quality');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  S.quality = d;
  const card = (code, name, sub, stats, extra, cls) =>
    link(
      'quality/standards/' + code,
      { class: 'qa-card' + (cls ? ' ' + cls : '') },
      h('div', { class: 'qa-card-head' }, h('span', { class: 'qa-code', dir: 'ltr' }, code), h('span', { class: 'qa-pct ' + band(stats.pct), dir: 'ltr' }, pctText(stats.pct))),
      h('span', { class: 'qa-name' }, name),
      sub ? h('span', { class: 'qa-sub' }, sub) : null,
      meter(stats.pct, t('qa.readiness')),
      h('span', { class: 'qa-n muted' }, t('qa.n_standards', { n: stats.n || 0 })),
      stats.n ? counts(stats) : null,
      extra,
    );
  const esrCard = card(
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
      const el = card(c.code, chapterName(c), c.jci ? 'JCI: ' + c.jci : '', c.stats, c.stats.esr_gap ? h('span', { class: 'qa-alert' }, t('qa.esr_gap', { n: c.stats.esr_gap })) : null);
      if (!d.can_manage) return el;
      return h('div', { class: 'qa-card-wrap' }, el, h('button', { type: 'button', class: 'btn btn-icon qa-edit', title: t('common.edit'), 'aria-label': t('common.edit') + ': ' + chapterName(c), onclick: () => chapterDialog(c) }, icon('edit')));
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
      h('div', {}, h('h1', {}, t('nav.chapters')), h('p', { class: 'muted' }, t('qa.chapters_sub'))),
      h(
        'div',
        { class: 'actions' },
        link('quality/standards', { class: 'btn' }, t('qa.all_standards')),
        d.can_manage ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => chapterDialog(null) }, icon('plus'), t('qa.chapter_add')) : null,
      ),
    ),
    kpiRow([
      ['qa.k_readiness', pctText(d.total.pct)],
      ['qa.k_standards', d.total.n || 0],
      ['qa.k_met', d.total.met || 0],
      ['qa.k_gaps', (d.total.partial || 0) + (d.total.not_met || 0)],
      ['qa.k_open', d.total.open || 0],
      ['qa.k_esr', d.total.esr_gap || 0],
    ]),
    d.total.n ? '' : h('p', { class: 'notice' }, t(d.can_manage ? 'qa.empty_manager' : 'qa.empty')),
    h('section', { class: 'qa-grid', 'aria-label': t('nav.chapters') }, esrCard, cards),
    depts,
    h('p', { class: 'hint' }, t('qa.formula')),
  );
}

function chapterDialog(c) {
  const code = input({ type: 'text', required: true, maxlength: 6, dir: 'ltr', pattern: '[A-Za-z]{2,6}', value: c ? c.code : '', disabled: !!c });
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
      field(t('qa.jci_chapters'), jci, t('qa.jci_chapters_hint')),
      c ? checkField(t('field.active'), active) : null,
    ),
    onSubmit: async () => {
      const body = { name_ar: nameAr.value, name_en: nameEn.value, jci: jci.value, active: active.checked };
      if (c) await api('/std-chapters/' + c.code, { method: 'PUT', body });
      else await api('/std-chapters', { method: 'POST', body: { ...body, code: code.value } });
      toast(t('qa.chapter_saved'));
      render();
    },
  });
}

/* ------------------------------ the standards ----------------------------- */

// quality/standards/LD: one chapter; quality/standards/ESR: every ESR; quality/standards: all of them.
export async function standardsPage(root, param, alive) {
  const ch = String(param || '').toUpperCase();
  let d, list;
  try {
    [d, list] = await Promise.all([api('/quality'), api('/standards' + (ch ? '?chapter=' + encodeURIComponent(ch) : ''))]);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  S.quality = d;
  const chapters = d.chapters;
  const chapter = chapters.find((c) => c.code === ch);
  const stds = list.standards;
  const f = (S.stdF = S.stdF || { q: '', score: '' });
  const title = ch === 'ESR' ? t('qa.esr') : chapter ? chapter.code + ' · ' + chapterName(chapter) : t('qa.all_standards');
  const stats = ch === 'ESR' ? d.esr : chapter ? chapter.stats : d.total;

  const pickCh = select([['', t('qa.all_chapters')], ['ESR', 'ESR · ' + t('qa.esr')], ...chapters.map((c) => [c.code, c.code + ' · ' + chapterName(c)])], ch, { 'aria-label': t('qa.chapter') });
  pickCh.addEventListener('change', () => navigate('quality/standards' + (pickCh.value ? '/' + pickCh.value : '')));
  const score = select([['', t('qa.all_scores')], ['open', t('qa.score.open')], ...STD_SCORES.map((s) => [s, t('qa.score.' + s)])], f.score, { 'aria-label': t('qa.score') });
  const search = input({ type: 'search', class: 'doc-search-input', value: f.q, placeholder: t('qa.search_ph'), 'aria-label': t('qa.search'), autocomplete: 'off' });
  const box = h('div', {});
  const norm = (s) => String(s || '').toLowerCase();
  const draw = () => {
    const q = norm(f.q.trim());
    const rows = stds.filter((s) => (!f.score || (f.score === 'open' ? !s.score : s.score === f.score)) && (!q || [s.code, s.title_ar, s.title_en, s.jci].some((v) => norm(v).includes(q))));
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
                h('thead', {}, h('tr', {}, ['qa.code', 'qa.standard', 'qa.jci', 'user.department', 'qa.score', 'common.actions'].map((c) => h('th', { scope: 'col' }, t(c))))),
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
      h('div', {}, link('quality/chapters', { class: 'back-link' }, t('nav.chapters')), h('h1', {}, title), h('p', { class: 'muted' }, ch === 'ESR' ? t('qa.esr_sub') : chapter && chapter.jci ? t('qa.maps_to', { jci: chapter.jci }) : t('qa.standards_sub'))),
      d.can_manage
        ? h(
            'div',
            { class: 'actions' },
            h('button', { type: 'button', class: 'btn', onclick: () => importDialog(chapters, ch) }, icon('download'), t('qa.import')),
            h('button', { type: 'button', class: 'btn btn-primary', onclick: () => standardDialog(null, chapters, ch) }, icon('plus'), t('qa.std_add')),
          )
        : null,
    ),
    h('section', { class: 'panel qa-summary' }, h('div', { class: 'qa-summary-pct' }, h('b', { class: band(stats.pct), dir: 'ltr' }, pctText(stats.pct)), h('span', { class: 'muted' }, t('qa.readiness'))), h('div', { class: 'qa-summary-body' }, meter(stats.pct, t('qa.readiness')), counts(stats))),
    h('div', { class: 'filters' }, h('div', { class: 'doc-search', role: 'search' }, icon('search'), search), pickCh, score),
    box,
  );
  draw();
}

function stdRow(s, canManage, chapters) {
  const title = pick(s.title_ar, s.title_en);
  return h(
    'tr',
    {},
    h('td', { class: 'nowrap' }, h('span', { class: 'mono strong', dir: 'ltr' }, s.code), s.esr ? [' ', h('span', { class: 'chip chip-expired qa-esr', title: t('qa.esr') }, 'ESR')] : null),
    h('td', { class: 'wrap-cell' }, title, s.note && s.score !== 'met' ? h('p', { class: 'small muted qa-note' }, s.note) : null),
    h('td', { class: 'nowrap' }, s.jci ? h('span', { class: 'mono', dir: 'ltr' }, s.jci) : h('span', { class: 'muted' }, t('common.none'))),
    h('td', {}, s.department_id ? pick(s.dept_ar, s.dept_en) : h('span', { class: 'muted' }, t('common.none'))),
    h('td', { class: 'nowrap' }, scoreChip(s.score), s.assessed_at ? h('div', { class: 'small muted' }, fmtDate(s.assessed_at.slice(0, 10))) : null),
    h(
      'td',
      {},
      h(
        'div',
        { class: 'row-actions' },
        s.can_score ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => assessDialog(s) }, icon('check'), t('qa.assess')) : null,
        s.assessed_at ? h('button', { type: 'button', class: 'btn btn-icon', title: t('qa.history'), 'aria-label': t('qa.history') + ': ' + s.code, onclick: () => historyDialog(s) }, icon('clipboard')) : null,
        canManage ? h('button', { type: 'button', class: 'btn btn-icon', title: t('common.edit'), 'aria-label': t('common.edit') + ': ' + s.code, onclick: () => standardDialog(s, chapters) }, icon('edit')) : null,
        canManage ? h('button', { type: 'button', class: 'btn btn-icon', title: t('common.delete'), 'aria-label': t('common.delete') + ': ' + s.code, onclick: () => simpleDelete(t('qa.std_delete_q', { code: s.code }), '/standards/' + s.id, t('qa.std_deleted')) }, icon('trash')) : null,
      ),
    ),
  );
}

function standardDialog(s, chapters, ch) {
  const code = input({ type: 'text', required: true, maxlength: 30, dir: 'ltr', value: s ? s.code : ch && ch !== 'ESR' ? ch + '.' : '', placeholder: 'LD.1' });
  const chapter = select(chapters.map((c) => [c.code, c.code + ' · ' + chapterName(c)]), s ? s.chapter : ch && ch !== 'ESR' ? ch : chapters[0] && chapters[0].code, {});
  const titleAr = h('textarea', { rows: 3, required: true, maxlength: 1000, dir: 'rtl' }, s ? s.title_ar : '');
  const titleEn = h('textarea', { rows: 3, required: true, maxlength: 1000, dir: 'ltr' }, s ? s.title_en : '');
  const jci = input({ type: 'text', maxlength: 200, dir: 'ltr', value: s ? s.jci || '' : '', placeholder: 'GLD.1, GLD.3' });
  const esr = input({ type: 'checkbox', checked: s ? !!s.esr : ch === 'ESR' });
  const dept = select([['', t('common.none')], ...(S.quality.dept_list || []).map((x) => [x.id, pick(x.name_ar, x.name_en)])], s ? s.department_id ?? '' : '', {});
  code.addEventListener('input', () => {
    const m = /^([A-Za-z]{2,6})/.exec(code.value);
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
      h('div', { class: 'form-grid' }, field(t('qa.jci'), jci, t('qa.jci_hint')), field(t('qa.owner_dept'), dept, t('qa.owner_dept_hint'))),
      checkField(t('qa.esr_check'), esr),
    ),
    onSubmit: async () => {
      const body = { code: code.value, chapter: chapter.value, title_ar: titleAr.value, title_en: titleEn.value, jci: jci.value, esr: esr.checked, department_id: dept.value ? Number(dept.value) : null };
      await api(s ? '/standards/' + s.id : '/standards', { method: s ? 'PUT' : 'POST', body });
      toast(t('qa.std_saved'));
      render();
    },
  });
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
function importDialog(chapters, ch) {
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
      const r = await api('/standards/import', { method: 'POST', body: { rows } });
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
