// Working offline: the API wrapper, saved copies and the queue of changes sent when back online.
import { render } from '../app.js';
import { daysTo, tn } from './assets.js';
import { $app, ApiError, S, h, has, nextId, store, t } from './core.js';
import { access } from './layout.js';
import { fmtTime, rememberTicket } from './tickets.js';

/* ------------------------------- offline ------------------------------- */
// When the internet drops, pages open from the last copy this device saw, and entries wait on the
// device (IndexedDB) and go to the server in order once it is back.

export const IDB = (() => {
  let db = null;
  const open = () =>
    (db ||= new Promise((resolve, reject) => {
      const req = indexedDB.open('fm-offline', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('pages');
        req.result.createObjectStore('queue', { keyPath: 'n', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = async (name, mode, fn) => {
    const tx = (await open()).transaction(name, mode);
    const req = fn(tx.objectStore(name));
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  };
  // Storage can be missing (private mode) or full: offline copies are a bonus, never a blocker.
  const safe = (fn, fallback) => (...a) => (window.indexedDB ? fn(...a).catch(() => fallback) : Promise.resolve(fallback));
  return {
    get: safe((k) => run('pages', 'readonly', (s) => s.get(k)), undefined),
    put: safe((k, v) => run('pages', 'readwrite', (s) => s.put(v, k)), undefined),
    add: safe((v) => run('queue', 'readwrite', (s) => s.add(v)), undefined),
    all: safe(() => run('queue', 'readonly', (s) => s.getAll()), []),
    drop: safe((n) => run('queue', 'readwrite', (s) => s.delete(n)), undefined),
    clear: safe(async () => (await run('pages', 'readwrite', (s) => s.clear()), run('queue', 'readwrite', (s) => s.clear())), undefined),
  };
})();

export const ACTION_KEYS = { receive: 'tk.receive', close: 'tk.close', hold: 'tk.hold', resume: 'tk.resume', expected: 'tk.change_expected', transfer: 'tk.transfer', assign: 'tk.assign', priority: 'tk.change_priority', reopen: 'tk.reopen', comment: 'tk.comment' };
// Entries that may wait for the internet, and what to call them in the waiting list.
export const QUEUEABLE = [
  ['POST', /^\/public\/tickets$/, () => t('off.k_ticket')],
  ['POST', /^\/tickets\/(\d+)\/action$/, (m, b) => t('off.k_action', { n: m[1] }) + (b && ACTION_KEYS[b.action] ? ' (' + t(ACTION_KEYS[b.action]) + ')' : '')],
  ['POST', /^\/assets$/, (m, b) => t('off.k_asset') + (b && b.tag ? ' ' + b.tag : '')],
  ['PUT', /^\/assets\/\d+$/, (m, b) => t('off.k_asset_edit') + (b && b.tag ? ' ' + b.tag : '')],
  ['POST', /^\/assets\/\d+\/plans$/, () => t('off.k_plan')],
  ['PUT', /^\/pm-plans\/\d+$/, () => t('off.k_plan')],
  ['POST', /^\/files$/, () => t('off.k_file')],
  ['PUT', /^\/files\/\d+$/, () => t('off.k_file')],
  ['POST', /^\/files\/\d+\/ack$/, () => t('off.k_ack')],
  ['POST', /^\/rounds$/, () => t('off.k_round')],
];
export const queueRule = (method, path) => QUEUEABLE.find(([m, re]) => m === method && re.test(path));

export const OFF = { down: false, pending: 0, failed: [], syncing: false, savedAt: 0 };
export const offBar = h('div', { class: 'offbar', role: 'status', hidden: true });
document.body.insertBefore(offBar, $app);
export function drawOffBar() {
  const parts = [];
  if (OFF.down) parts.push(h('span', {}, h('strong', {}, t('off.down')), ' ', t('off.down_hint')));
  if (OFF.pending) parts.push(h('span', { class: 'chip chip-pm' }, tn('off.pending', OFF.pending)));
  if (OFF.failed.length)
    parts.push(
      h('button', { type: 'button', class: 'btn btn-small', onclick: failedDialog }, tn('off.failed', OFF.failed.length)),
    );
  if (!OFF.down && OFF.pending && !OFF.syncing) parts.push(h('button', { type: 'button', class: 'btn btn-small', onclick: () => syncQueue() }, t('off.send_now')));
  offBar.replaceChildren(...parts);
  offBar.hidden = !parts.length;
  offBar.classList.toggle('offbar-down', OFF.down);
}
export function setDown(down) {
  if (OFF.down === down) return;
  OFF.down = down;
  drawOffBar();
  if (!down) syncQueue();
}
export function failedDialog() {
  openDialog({
    title: t('off.failed_title'),
    body: h(
      'div',
      { class: 'stack' },
      h('p', { class: 'muted' }, t('off.failed_hint')),
      h('ul', { class: 'ack-list' }, OFF.failed.map((f) => h('li', {}, h('div', { class: 'strong' }, f.label), h('span', { class: 'muted small' }, fmtTime(f.at) + ' - ' + errText(new ApiError(f.code)))))),
    ),
    submitLabel: t('off.failed_clear'),
    onSubmit: async () => {
      OFF.failed = [];
      drawOffBar();
    },
  });
}

// FormData cannot be stored as is; its fields (and any photo or PDF) can.
export const formEntries = (fd) => [...fd.entries()].map(([k, v]) => (v instanceof Blob ? [k, v, v.name || 'file'] : [k, v]));
export const formFrom = (entries) => {
  const fd = new FormData();
  for (const [k, v, name] of entries) v instanceof Blob ? fd.append(k, v, name) : fd.append(k, v);
  return fd;
};

export async function send(path, init, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch('/api' + path, Object.assign({ signal: ctl.signal }, init));
  } finally {
    clearTimeout(timer);
  }
}
export const readBody = async (res) => {
  try {
    return await res.json();
  } catch {
    return null; // empty or non-JSON body
  }
};

export async function api(path, opts) {
  const o = opts || {};
  const method = o.method || 'GET';
  const init = { method, credentials: 'same-origin', headers: {} };
  if (o.form) init.body = o.form;
  else if (o.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(o.body);
  }
  let res;
  try {
    res = await send(path, init, method === 'GET' ? 10000 : 60000);
  } catch {
    setDown(true);
    if (method === 'GET') {
      const saved = await IDB.get(path);
      if (saved) return saved.data;
      throw new ApiError('offline_page');
    }
    const rule = queueRule(method, path);
    if (!rule) throw new ApiError('offline_action');
    await IDB.add({ path, method, body: o.body, form: o.form ? formEntries(o.form) : null, label: rule[2](path.match(rule[1]), o.body), extra: o.offline || null, at: new Date().toISOString() });
    OFF.pending++;
    drawOffBar();
    toast(t('off.saved'));
    OFF.savedAt = Date.now();
    return { queued: true };
  }
  setDown(false);
  const data = await readBody(res);
  if (!res.ok) {
    const code = (data && data.error) || 'server_error';
    if (res.status === 401 && code === 'unauthorized' && S.user) {
      S.user = null;
      render();
    }
    throw new ApiError(code);
  }
  if (method === 'GET') IDB.put(path, { data, at: Date.now() });
  return data;
}

// Sends waiting entries oldest first. Stops at the first network failure; an entry the server
// refuses (say, a request that was closed meanwhile) is set aside in the "not sent" list.
export async function syncQueue() {
  if (OFF.syncing) return;
  OFF.syncing = true;
  let sent = 0;
  try {
    for (const q of await IDB.all()) {
      const init = { method: q.method, credentials: 'same-origin', headers: {} };
      if (q.form) init.body = formFrom(q.form);
      else if (q.body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(q.body);
      }
      let res;
      try {
        res = await send(q.path, init, 60000);
      } catch {
        setDown(true);
        break;
      }
      OFF.down = false;
      const data = await readBody(res);
      // Signed out meanwhile: keep the entries until someone signs in again.
      if (res.status === 401) break;
      await IDB.drop(q.n);
      if (res.ok) {
        sent++;
        if (q.extra && q.extra.ticket && data) rememberTicket(data, q.extra.ticket);
      } else OFF.failed.push({ label: q.label, at: q.at, code: (data && data.error) || 'server_error' });
    }
  } finally {
    OFF.pending = (await IDB.all()).length;
    OFF.syncing = false;
    drawOffBar();
  }
  if (sent) {
    toast(tn('off.sent', sent));
    if (S.user) render();
  }
}
window.addEventListener('online', () => syncQueue());
setInterval(() => {
  if (OFF.pending || OFF.down) syncQueue().then(() => (OFF.down && !OFF.pending ? api('/bootstrap').catch(() => {}) : null));
  else if (S.user) warmPages();
}, 30000);

// Keeps a fresh copy of the main lists (and the open requests) on the device for when the
// internet drops, at most every 10 minutes and one call at a time.
export let warming = false;
export async function warmPages() {
  if (warming || Date.now() - Number(store.get('fm_off_warm', '0')) < 600000) return;
  warming = true;
  try {
    await warmAll();
    if (!OFF.down) store.set('fm_off_warm', String(Date.now()));
  } finally {
    warming = false;
  }
}
export async function warmAll() {
  const paths = [];
  if (access('docs') !== 'none') paths.push('/departments?for=docs', '/doc-types', '/files');
  if (access('desk') !== 'none') paths.push('/tickets/meta', '/tickets/badge', '/tickets?days=' + S.tk.days);
  if (access('assets') !== 'none') paths.push('/assets', '/pm');
  if (access('rounds') !== 'none') paths.push('/rounds');
  for (const p of paths) {
    const d = await api(p).catch(() => null);
    if (OFF.down) return;
    // The checklists due soonest, so a round can be walked where there is no signal.
    if (d && p === '/rounds')
      for (const pl of (d.places || []).filter((x) => daysTo(x.next_due, d.today) <= 7).slice(0, 30)) {
        await api('/rounds/start/' + pl.id).catch(() => null);
        if (OFF.down) return;
      }
    if (d && p.startsWith('/tickets?'))
      for (const tk of (d.tickets || []).filter((x) => x.status !== 'closed').slice(0, 20)) {
        await api('/tickets/' + tk.id).catch(() => null);
        if (OFF.down) return;
      }
  }
}

// A toast from the caller ("Saved") right after an entry was kept on the device would mislead.
export const quietToast = () => Date.now() - OFF.savedAt < 1500;

export const errText = (e) => {
  const key = 'err.' + (e && e.code);
  return has(key) ? t(key) : t('err.server_error');
};

export const fmtDate = (d) => (d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '');
export const dateEl = (d) => (d ? h('span', { class: 'mono', dir: 'ltr' }, fmtDate(d)) : h('span', { class: 'muted' }, t('common.none')));
export const deptName = (d) => (d ? (S.lang === 'ar' ? d.name_ar : d.name_en) : '');
// A file's English name is optional: English shows it when set, otherwise the main (Arabic) name.
// Must match ARABIC_RE in src/worker.js.
export const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
export const ARABIC_RE_G = new RegExp(ARABIC_RE.source, 'g');
// Must match LATIN_RE in src/worker.js.
export const LATIN_RE = /[A-Za-z]/;
export const LATIN_RE_G = /[A-Za-z]/g;
export const EASTERN_DIGITS_G = /[\u0660-\u0669\u06F0-\u06F9]/g;
export const fileName = (f) => (S.lang === 'en' && f.name_en ? f.name_en : f.name);
// People (users, staff) carry an Arabic and an English name.
export const personName = (u) => (S.lang === 'en' && u.name_en ? u.name_en : u.name);
export const deptById = (id) => S.departments.find((d) => d.id === id);
// A file's type is stored by key; the name comes from the types the super admin manages.
export const typeName = (key) => {
  const ty = S.docTypes.find((x) => x.key === key);
  if (ty) return S.lang === 'ar' ? ty.name_ar : ty.name_en;
  return has('type.' + key) ? t('type.' + key) : String(key || '');
};
// Technicians and viewers read files; only admins manage them.
export const isAdmin = () => S.user.docs === 'admin' || S.user.docs === 'dept_admin';
export const canEdit = (f) => S.user.docs === 'admin' || (S.user.docs === 'dept_admin' && S.user.department_id === f.department_id);

export function statusChip(status) {
  if (status === 'none') return h('span', { class: 'muted small' }, t('status.none'));
  return h('span', { class: 'chip chip-' + status }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('status.' + status));
}
export function daysNote(f) {
  if (f.status === 'near') return h('span', { class: 'note note-near' }, f.days_left === 0 ? t('days.today') : t('days.left', { n: f.days_left }));
  if (f.status === 'expired') return h('span', { class: 'note note-expired' }, t('days.ago', { n: -f.days_left }));
  return null;
}

export function toast(message, bad) {
  if (!bad && quietToast()) return;
  const el = h('div', { class: 'toast' + (bad ? ' toast-bad' : ''), role: 'status' }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), 4000);
}

// Keeps a field in one language, as the server checks: 'en' fields (English names, numbers, emails, codes)
// drop Arabic letters and turn Arabic digits into 0-9; 'ar' fields (Arabic names) drop English letters.
export function guardLang(el, lang) {
  const bad = lang === 'en' ? ARABIC_RE : LATIN_RE;
  const badG = lang === 'en' ? ARABIC_RE_G : LATIN_RE_G;
  const msg = lang === 'en' ? 'err.field_arabic' : 'err.name_ar_latin';
  const check = () => el.setCustomValidity(bad.test(el.value) ? t(msg) : '');
  const clean = (s) => (lang === 'en' ? s.replace(EASTERN_DIGITS_G, (d) => String(d.charCodeAt(0) & 0xf)) : s).replace(badG, '');
  // Drop letters as they are typed or pasted, keeping the caret in place.
  el.addEventListener('input', () => {
    const v = el.value;
    const fixed = clean(v);
    if (fixed !== v) {
      const pos = el.selectionStart; // null on email inputs
      const before = pos === null ? fixed : clean(v.slice(0, pos));
      el.value = fixed;
      if (pos !== null) el.setSelectionRange(before.length, before.length);
      if (bad.test(v)) toast(t(msg), true);
    }
    check();
  });
  check();
  return el;
}
export const TEXT_TYPES = ['text', 'email', 'tel', 'url'];
export const input = (attrs) => {
  const el = h('input', attrs);
  if (TEXT_TYPES.includes(attrs.type) && !attrs.readonly && (attrs.dir === 'ltr' || attrs.dir === 'rtl')) guardLang(el, attrs.dir === 'ltr' ? 'en' : 'ar');
  return el;
};
export function select(options, value, attrs) {
  const el = h('select', attrs);
  for (const [v, text] of options) {
    const opt = h('option', { value: v }, text);
    if (String(v) === String(value ?? '')) opt.selected = true;
    el.append(opt);
  }
  return el;
}
export function field(label, control, hint) {
  if (!control.id) control.id = 'f' + nextId();
  return h('div', { class: 'field' }, h('label', { for: control.id }, label), control, hint ? h('p', { class: 'hint' }, hint) : null);
}
export function checkField(label, control) {
  if (!control.id) control.id = 'f' + nextId();
  return h('div', { class: 'check' }, control, h('label', { for: control.id }, label));
}

export function openDialog({ title, body, submitLabel, onSubmit, danger }) {
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary') }, submitLabel || t('common.save'));
  const form = h(
    'form',
    { method: 'dialog' },
    h('h2', { class: 'dialog-title' }, title),
    body,
    err,
    h('div', { class: 'dialog-actions' }, submit, h('button', { type: 'button', class: 'btn', autofocus: !!danger, onclick: () => dlg.close() }, t('common.cancel'))),
  );
  const dlg = h('dialog', { class: 'dialog' }, form);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    submit.disabled = true;
    try {
      await onSubmit();
      dlg.close();
    } catch (e) {
      err.textContent = errText(e);
      err.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

export const loading = () => h('p', { class: 'loading' }, t('common.loading'));
export const errorBox = (e) => h('div', { class: 'panel empty' }, h('p', { class: 'form-error' }, errText(e)), h('button', { type: 'button', class: 'btn', onclick: render }, t('common.retry')));
