// Shared state, translations and small helpers used by every page.

// Facilities Management - web app (no build step, plain JavaScript).

export const I18N = window.I18N;
export const $app = document.getElementById('app');
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_CHARS = 300000; // same limit as the server

export const store = {
  get(key, fallback) {
    try {
      return localStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode: the choice just will not be remembered */
    }
  },
};

export const S = {
  lang: store.get('fm_lang', 'ar') === 'en' ? 'en' : 'ar',
  user: null,
  needsSetup: false,
  defaults: { near_days: 30 },
  departments: [],
  docTypes: [],
  brand: { name_ar: '', name_en: '', logo: null },
  dash: { dept: '', status: '' },
  docDept: '',
  docQuery: '',
  tk: { status: '', team: '', q: '', days: 30 },
  ticketMeta: null,
  staffQ: '',
  route: location.hash.replace(/^#\/?/, ''),
};
// Set by the embedded demo: some in-app viewers treat every href as an outside link.
export const NO_HREF = !!window.__NO_HREF;

export let uid = 0;
export const nextId = () => ++uid; // element ids, unique on the page

/* ------------------------------- helpers ------------------------------- */

export const has = (key) => key in I18N[S.lang] || key in I18N.en;
// {who} and {whoAll}: who a request can affect, as the owner named it for the sector (patient, student, guest...).
const WHO_DEFAULT = { one_ar: 'مريض', all_ar: 'المرضى', one_en: 'a patient', all_en: 'patients' };
export function t(key, vars) {
  let text = I18N[S.lang][key] ?? I18N.en[key] ?? key;
  if (text.includes('{who')) {
    const w = { ...WHO_DEFAULT, ...(S.brand && S.brand.who) };
    const ar = S.lang === 'ar';
    text = text.split('{whoAll}').join(ar ? w.all_ar : w.all_en).split('{who}').join(ar ? w.one_ar : w.one_en);
  }
  if (vars) for (const k of Object.keys(vars)) text = text.split('{' + k + '}').join(vars[k]);
  return text;
}

// Builds DOM nodes; text always goes in as text, never as HTML.
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(3)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const ICONS = {
  award: '<circle cx="12" cy="9" r="6"/><path d="M9 14.5L8 21l4-2 4 2-1-6.5"/><path d="M9.5 9l1.8 1.8L14.8 7.5"/>',
  spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  building: '<path d="M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16"/><path d="M14 10h5a1 1 0 0 1 1 1v10"/><path d="M3 21h18"/><path d="M8 8h2"/><path d="M8 12h2"/><path d="M8 16h2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  download: '<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  expand: '<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  logout: '<path d="M10 4H5v16h5"/><path d="M14 8l4 4-4 4"/><path d="M18 12H9"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  desk: '<path d="M4 13a8 8 0 0 1 16 0"/><rect x="2.5" y="13" width="4" height="6" rx="1.5"/><rect x="17.5" y="13" width="4" height="6" rx="1.5"/><path d="M20 19a4 4 0 0 1-4 3h-3"/>',
  box: '<path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5L12 12l8.5-4.5"/><path d="M12 12v9"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  chart: '<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7" y="12" width="3" height="5" rx="0.5"/><rect x="12" y="8" width="3" height="9" rx="0.5"/><rect x="17" y="5" width="3" height="12" rx="0.5"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M9 11l2 2 4-4"/><path d="M9 17h6"/>',
  alert: '<path d="M12 4L2.5 20h19z"/><path d="M12 10v4.5"/><path d="M12 17.5v.01"/>',
  phone: '<path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 14a6.5 6.5 0 0 1 3.5 6"/>',
};
export function icon(name, size) {
  const s = size || 18;
  const span = h('span', { class: 'icon', 'aria-hidden': 'true' });
  // Static markup from the table above only.
  span.innerHTML = `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

export class ApiError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// On a phone every table in a .table-scroll shows each row as a card (styles.css, "phone layout").
// Each cell is given its column name to show above it; empty cells ("None", "-") are hidden there.
// Pages build their tables in many places, so this watches the app and labels new tables as they appear.
function cardTables() {
  for (const table of $app.querySelectorAll('.table-scroll > table')) {
    const head = table.tHead && table.tHead.rows[0];
    if (!head || !table.tBodies.length) continue;
    const cols = [...head.cells].map((th) => th.textContent.trim());
    table.classList.add('row-cards');
    for (const body of table.tBodies)
      for (const tr of body.rows) {
        // Rows can be redrawn inside a table that stays, so each row is marked, not the table.
        if (tr.classList.contains('card-row')) continue;
        tr.classList.add('card-row');
        if (tr.cells.length === 1 && cols.length > 1) {
          tr.cells[0].classList.add('cell-full');
          continue;
        }
        [...tr.cells].forEach((td, i) => {
          if (cols[i] && !td.hasAttribute('data-label')) td.setAttribute('data-label', cols[i]);
          if (!td.querySelector('input, select, button, textarea') && ['', '-', t('common.none')].includes(td.textContent.trim())) td.classList.add('cell-none');
          if (td.querySelector('.row-actions, .actions') || (!cols[i] && td.querySelector('button, a.btn'))) td.classList.add('cell-actions');
        });
      }
  }
}
let cardQueued = false;
if ($app)
  new MutationObserver(() => {
    if (cardQueued) return;
    cardQueued = true;
    requestAnimationFrame(() => {
      cardQueued = false;
      cardTables();
    });
  }).observe($app, { childList: true, subtree: true });
