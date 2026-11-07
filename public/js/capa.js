// Corrective actions (CAPA): the register, open ones first, and the dialog to work one through to verified.
import { render } from '../app.js';
import { kpiRow } from './assets.js';
import { S, h, icon, t } from './core.js';
import { link, setUrl } from './layout.js';
import { api, dateEl, errorBox, field, input, openDialog, select, toast } from './offline.js';
import { pick, simpleDelete } from './tickets.js';

export const CAPA_STATUS = ['open', 'doing', 'done', 'verified'];
const CHIP = { open: 'chip-expired', doing: 'chip-near', done: 'chip-review', verified: 'chip-valid' };
const live = (c) => c.status === 'open' || c.status === 'doing';
export const capaChip = (s) => h('span', { class: 'chip ' + CHIP[s] }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('capa.st.' + s));
export const capaLate = (c, today) => live(c) && c.due && c.due < today;
// The open action is in the address, so it can be linked; closing it goes back to the list.
const here = (path) => {
  S.route = path;
  setUrl(path);
};
const stdLabel = (c) => c.std_code || c.chapter || '';

// quality/capa, or quality/capa/12 to open one.
export async function capaPage(root, param, alive) {
  let d;
  try {
    d = await api('/capa');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const f = (S.capaF = S.capaF || { q: '', status: 'live', chapter: '' });
  const search = input({ type: 'search', class: 'doc-search-input', value: f.q, placeholder: t('capa.search_ph'), 'aria-label': t('capa.search_ph'), autocomplete: 'off' });
  const pickSt = select([['live', t('capa.live')], ['', t('capa.all')], ...CAPA_STATUS.map((s) => [s, t('capa.st.' + s)])], f.status, { 'aria-label': t('capa.status') });
  const pickCh = select([['', t('qa.all_chapters')], ...d.chapters.map((c) => [c.code, c.code + ' · ' + pick(c.name_ar, c.name_en)])], f.chapter, { 'aria-label': t('qa.chapter') });
  const box = h('div', {});
  const norm = (v) => String(v || '').toLowerCase();
  const draw = () => {
    const q = norm(f.q.trim());
    const rows = d.capa.filter(
      (c) =>
        (f.status === 'live' ? live(c) : !f.status || c.status === f.status) &&
        (!f.chapter || c.chapter === f.chapter) &&
        (!q || [c.title, c.detail, c.std_code, c.owner, c.loc_ar, c.loc_en, c.dept_ar, c.dept_en, '#' + c.id].some((v) => norm(v).includes(q))),
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
                h('thead', {}, h('tr', {}, ['capa.title', 'rnd.place', 'capa.std', 'capa.owner', 'capa.due', 'capa.status'].map((c) => h('th', { scope: 'col' }, t(c))))),
                h(
                  'tbody',
                  {},
                  rows.map((c) =>
                    h(
                      'tr',
                      {},
                      h(
                        'td',
                        { class: 'wrap-cell' },
                        h('button', { type: 'button', class: 'btn-link strong', onclick: () => capaDialog(c, d) }, c.title),
                        h('div', { class: 'small muted' }, h('span', { dir: 'ltr' }, '#' + c.id), ' · ', t('capa.src.' + c.source), c.form_ar ? ' · ' + pick(c.form_ar, c.form_en) : ''),
                      ),
                      h('td', {}, pick(c.loc_ar, c.loc_en) || pick(c.dept_ar, c.dept_en) || h('span', { class: 'muted' }, '-')),
                      h('td', {}, stdLabel(c) ? h('span', { class: 'mono', dir: 'ltr' }, stdLabel(c)) : h('span', { class: 'muted' }, '-')),
                      h('td', {}, c.owner || h('span', { class: 'muted' }, '-')),
                      h('td', {}, dateEl(c.due), capaLate(c, d.today) ? h('span', { class: 'note note-expired' }, ' ', t('rnd.late')) : ''),
                      h('td', {}, capaChip(c.status)),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty' }, d.capa.length ? t('capa.no_match') : t('capa.empty')),
      ),
    );
  };
  search.addEventListener('input', () => {
    f.q = search.value;
    draw();
  });
  pickSt.addEventListener('change', () => {
    f.status = pickSt.value;
    draw();
  });
  pickCh.addEventListener('change', () => {
    f.chapter = pickCh.value;
    draw();
  });
  const open = d.capa.filter(live);
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.capa')), h('p', { class: 'muted' }, t('capa.n', { n: d.capa.length, open: open.length }))),
      d.can_edit ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => capaDialog(null, d) }, icon('plus'), t('capa.add'))) : '',
    ),
    kpiRow([
      ['capa.k_open', open.length],
      ['capa.k_late', open.filter((c) => capaLate(c, d.today)).length],
      ['capa.k_done', d.capa.filter((c) => c.status === 'done').length],
      ['capa.k_verified', d.capa.filter((c) => c.status === 'verified').length],
    ]),
    h('div', { class: 'filters' }, h('div', { class: 'doc-search', role: 'search' }, icon('search'), search), pickSt, pickCh),
    box,
  );
  draw();
  const want = param && d.capa.find((c) => String(c.id) === String(param));
  if (want) capaDialog(want, d);
}

function capaDialog(c, d) {
  const ro = !d.can_edit;
  const area = (v, n) => h('textarea', { rows: 2, maxlength: n, dir: 'auto', disabled: ro }, v || '');
  const title = input({ type: 'text', required: true, maxlength: 500, dir: 'auto', value: c ? c.title : '', disabled: ro });
  const detail = area(c && c.detail, 2000);
  const owner = input({ type: 'text', maxlength: 150, dir: 'auto', value: c ? c.owner || '' : '', disabled: ro });
  const due = input({ type: 'date', value: c ? c.due || '' : '', disabled: ro });
  const chapter = select([['', t('rnd.no_chapter')], ...d.chapters.map((x) => [x.code, x.code + ' · ' + pick(x.name_ar, x.name_en)])], c ? c.chapter || '' : '', { disabled: ro });
  const std = input({ type: 'text', maxlength: 30, dir: 'ltr', value: c ? c.std_code || '' : '', placeholder: 'FMS.3.1', disabled: ro });
  const dept = select([['', t('common.none')], ...d.departments.map((x) => [x.id, pick(x.name_ar, x.name_en)])], c ? c.department_id || '' : '', { disabled: ro });
  // Only a quality manager sets "verified", or moves a verified one back.
  const allowed = CAPA_STATUS.filter((s) => d.can_verify || (s !== 'verified' && !(c && c.status === 'verified')) || (c && c.status === s));
  const status = select(allowed.map((s) => [s, t('capa.st.' + s)]), c ? c.status : 'open', { disabled: ro });
  const cause = area(c && c.cause, 2000);
  const action = area(c && c.action, 2000);
  const who = c && [c.done_by ? [t('capa.done_by'), c.done_by, c.done_at] : null, c.verified_by ? [t('capa.verified_by'), c.verified_by, c.verified_at] : null].filter(Boolean);
  if (c) here('quality/capa/' + c.id);
  const dlg = openDialog({
    title: c ? t('capa.edit') + ' #' + c.id : t('capa.add'),
    body: h(
      'div',
      { class: 'stack' },
      c && c.round_id ? h('p', { class: 'muted small' }, t('capa.from_round'), ' ', link('rounds/rlog/' + c.round_id, { onclick: () => dlg.close() }, pick(c.form_ar, c.form_en) || '#' + c.round_id), c.loc_ar ? ' · ' + pick(c.loc_ar, c.loc_en) : '') : '',
      field(t('capa.title'), title),
      field(t('capa.detail'), detail),
      h('div', { class: 'form-grid' }, field(t('qa.chapter'), chapter), field(t('capa.std'), std)),
      h('div', { class: 'form-grid' }, field(t('capa.owner'), owner), field(t('user.department'), dept)),
      h('div', { class: 'form-grid' }, field(t('capa.due'), due), field(t('capa.status'), status)),
      field(t('capa.cause'), cause),
      field(t('capa.action'), action),
      who && who.length ? h('p', { class: 'muted small' }, who.map(([k, n, at]) => k + ': ' + n + (at ? ' (' + at.slice(0, 10) + ')' : '')).join(' · ')) : '',
      c && d.can_verify ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-small', onclick: () => (dlg.close(), simpleDelete(t('capa.delete_q'), '/capa/' + c.id, t('capa.deleted'))) }, icon('trash'), t('common.delete'))) : '',
    ),
    onSubmit: async () => {
      if (ro) return;
      const body = { title: title.value, detail: detail.value, owner: owner.value, due: due.value, chapter: chapter.value, std_code: std.value, department_id: dept.value ? Number(dept.value) : null, status: status.value, cause: cause.value, action: action.value };
      await api(c ? '/capa/' + c.id : '/capa', { method: c ? 'PUT' : 'POST', body });
      toast(t(c ? 'capa.saved' : 'capa.added'));
      here('quality/capa');
      render();
    },
  });
  if (c) dlg.addEventListener('close', () => here('quality/capa'));
}
