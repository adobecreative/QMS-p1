// Requests and work orders, the public request form and the staff list.
import { render } from '../app.js';
import { importDialog } from './api.js';
import { fmtHours, fmtMoney, lateText, period, vendorArriveDialog, vendorCallDialog, vendorName } from './contracts.js';
import { S, h, icon, store, t } from './core.js';
import { normText } from './docs.js';
import { fmtQty, ticketParts, unitText } from './inventory.js';
import { OFF_APPS, access, brand, flowDialog, langToggle, link, navigate, orgNameIn, orgNames, supportLine } from './layout.js';
import { OFF, api, checkField, deptById, deptName, errText, errorBox, field, fmtDate, input, loading, openDialog, personName, select, send, toast } from './offline.js';
import { XLS_STYLE, downloadXlsx } from './xlsx.js';

/* ------------------------------- tickets -------------------------------- */

// Maintenance requests: the public page employees send them from (no account), the tracking page,
// and the pages technicians, team supervisors and super admins work in.

export const fmtTime = (iso) => {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat(S.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return iso;
  }
};
export const timeEl = (iso) => (iso ? h('span', { class: 'nowrap', dir: 'auto' }, fmtTime(iso)) : h('span', { class: 'muted' }, t('common.none')));
// 95 -> "1 h 35 min", 3000 -> "2 d 2 h"
export function fmtDuration(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return t('dur.min', { n: min });
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return min % 60 ? t('dur.h_min', { h: hrs, m: min % 60 }) : t('dur.h', { n: hrs });
  const days = Math.floor(hrs / 24);
  return hrs % 24 ? t('dur.d_h', { d: days, h: hrs % 24 }) : t('dur.d', { n: days });
}
// A value for <input type="datetime-local"> in the viewer's own time zone, and back to ISO.
export const toLocalInput = (iso) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
export const fromLocalInput = (v) => (v ? new Date(v).toISOString() : '');
export const pick = (ar, en) => (S.lang === 'en' ? en || ar : ar || en);

export const priorityChip = (p) => h('span', { class: 'chip chip-p' + p, title: t('tk.priority') }, 'P' + p + ' ' + t('prio.' + p));
export function ticketChip(tk) {
  if (tk.status === 'closed') return h('span', { class: 'chip ' + (tk.resolution === 'unresolved' ? 'chip-expired' : 'chip-valid') }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('res.' + tk.resolution));
  const cls = tk.late ? 'chip-expired' : tk.status === 'on_hold' ? 'chip-near' : tk.status === 'new' ? 'chip-review' : 'chip-progress';
  return h('span', { class: 'chip ' + cls }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('tst.' + tk.status));
}
export function lateNote(tk, now) {
  if (!tk.late) return null;
  const due = tk.late === 'response' ? tk.response_due : tk.expected_at || tk.resolve_due;
  return h('span', { class: 'note note-expired' }, t(tk.late === 'response' ? 'tk.late_response' : 'tk.late_resolve', { d: fmtDuration(Math.max(60000, Date.parse(now) - Date.parse(due))) }));
}
// A phone number as WhatsApp wants it (country code, digits only). Local Saudi numbers (05..., 5...) get 966.
export function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^05\d{8}$/.test(d)) d = '966' + d.slice(1);
  else if (/^5\d{8}$/.test(d)) d = '966' + d;
  return d.length >= 11 && d.length <= 15 ? d : '';
}
export const ticketNo = (id) => h('span', { class: 'mono strong', dir: 'ltr' }, '#' + id);
export const requestUrl = (code) => location.origin + '/request' + (code ? '?loc=' + encodeURIComponent(code) : '');

/* QR codes (vendor/qrcode.js, MIT) drawn as SVG, for the request link and each place */

export let qrLoading = null;
export function loadQr() {
  if (window.qrcode) return Promise.resolve();
  if (!qrLoading) {
    qrLoading = new Promise((resolve, reject) => {
      const s = h('script', { src: '/vendor/qrcode.js' });
      s.onload = resolve;
      s.onerror = () => {
        qrLoading = null;
        reject(new Error('qr'));
      };
      document.head.append(s);
    });
  }
  return qrLoading;
}
export async function qrSvg(text, size) {
  await loadQr();
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `-4 -4 ${n + 8} ${n + 8}`);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('class', 'qr');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR');
  const bg = document.createElementNS(NS, 'rect');
  for (const [k, v] of Object.entries({ x: -4, y: -4, width: n + 8, height: n + 8, fill: '#ffffff' })) bg.setAttribute(k, v);
  svg.append(bg);
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000000');
  svg.append(path);
  return svg;
}
// Shows the QR cards on their own sheet, with Print and Close, and prints nothing else of the page.
// Phones only open the print dialog from a direct tap, and on iPhone printing does not wait, so the sheet
// stays open until it is closed; on a computer the dialog opens at once, and the sheet closes after it.
export async function printQr(items) {
  const cards = [];
  for (const it of items) {
    cards.push(
      h(
        'div',
        { class: 'qr-card' },
        h('div', { class: 'qr-org' }, orgNames()),
        h('div', { class: 'qr-title' }, it.heading || t('qr.scan')),
        await qrSvg(it.url, 260),
        h('div', { class: 'qr-place' }, it.title),
        h('div', { class: 'qr-url', dir: 'ltr' }, it.url.replace(/^https?:\/\//, '').replace(/\?.*/, '')),
      ),
    );
  }
  const close = () => {
    document.body.classList.remove('print-qr');
    sheet.remove();
    window.removeEventListener('afterprint', afterPrint);
    window.removeEventListener('hashchange', close);
  };
  const touch = matchMedia('(pointer: coarse)').matches;
  const afterPrint = () => touch || close();
  const sheet = h(
    'div',
    { class: 'qr-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('qr.print') },
    h(
      'div',
      { class: 'qr-bar' },
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => window.print() }, t('rep.print')),
      h('button', { type: 'button', class: 'btn', onclick: close }, t('qr.close')),
    ),
    cards,
  );
  // An open modal dialog would make the sheet untappable, so close it first.
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  document.querySelector('.qr-sheet')?.remove();
  document.body.append(sheet);
  document.body.classList.add('print-qr');
  window.scrollTo(0, 0);
  window.addEventListener('afterprint', afterPrint);
  window.addEventListener('hashchange', close);
  sheet.querySelector('.qr-bar .btn-primary').focus();
  if (!touch) setTimeout(() => window.print(), 50);
}

/* the employee's side: send a request, follow it */

export const MY_TICKETS = 'fm_my_tickets';
export const myTickets = () => {
  try {
    const v = JSON.parse(store.get(MY_TICKETS, '[]'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

export function rememberTicket(r, cat) {
  store.set(MY_TICKETS, JSON.stringify([{ id: r.id, token: r.token, at: new Date().toISOString(), cat_ar: cat.cat_ar, cat_en: cat.cat_en }, ...myTickets()].slice(0, 20)));
}

// Photos from phones are large: they are made smaller here before upload.
export async function shrinkPhoto(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = h('canvas', {});
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    return blob && blob.size < file.size ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file;
  } catch {
    return file;
  }
}

export const publicShell = (...body) =>
  h('div', { class: 'auth public' }, h('div', { class: 'auth-card public-card' }, h('div', { class: 'auth-brand' }, brand('auth')), ...body, langToggle(), supportLine()));

export async function requestPage() {
  const root = h('div', {}, loading());
  const qs = new URLSearchParams(location.search);
  const code = qs.get('loc') || '';
  const assetTag = qs.get('asset') || '';
  let meta;
  try {
    const params = new URLSearchParams();
    if (code) params.set('loc', code);
    if (assetTag) params.set('asset', assetTag);
    meta = await api('/public/form' + (params.toString() ? '?' + params : ''));
  } catch (e) {
    return publicShell(h('h1', {}, t('req.title')), errorBox(e));
  }
  // A device's QR first asks what the person wants: report a fault, or see the device.
  if (meta.asset && !qs.has('report')) {
    const report = new URLSearchParams(qs);
    report.set('report', '1');
    return publicShell(
      h('h1', {}, pick(meta.asset.name_ar, meta.asset.name_en)),
      h('p', { class: 'muted mono', dir: 'ltr' }, meta.asset.tag),
      h(
        'div',
        { class: 'qr-choices' },
        h('a', { class: 'qr-choice qr-choice-main', href: '/request?' + report }, icon('desk', 28), h('span', { class: 'strong' }, t('qrc.report')), h('span', { class: 'small' }, t('qrc.report_hint'))),
        h('a', { class: 'qr-choice', href: '/#/assets/register/' + meta.asset.id }, icon('box', 28), h('span', { class: 'strong' }, t('qrc.info')), h('span', { class: 'small' }, t('qrc.info_hint'))),
      ),
    );
  }
  // A place's QR code: report an incident, report a fault (when maintenance requests are on here), or start a round.
  if (meta.location && !qs.has('report')) {
    const report = new URLSearchParams(qs);
    report.set('report', '1');
    const desk = !OFF_APPS.includes('desk');
    const incident = '/incident?loc=' + encodeURIComponent(code);
    return publicShell(
      h('h1', {}, pick(meta.location.name_ar, meta.location.name_en)),
      h(
        'div',
        { class: 'qr-choices' },
        h('a', { class: 'qr-choice qr-choice-main', href: incident }, icon('alert', 28), h('span', { class: 'strong' }, t('qrc.incident')), h('span', { class: 'small' }, t('qrc.incident_hint'))),
        h('a', { class: 'qr-choice', href: '/feedback?loc=' + encodeURIComponent(code) }, icon('users', 28), h('span', { class: 'strong' }, t('qrc.patient')), h('span', { class: 'small' }, t('qrc.patient_hint'))),
        desk ? h('a', { class: 'qr-choice', href: '/request?' + report }, icon('desk', 28), h('span', { class: 'strong' }, t('qrc.report')), h('span', { class: 'small' }, t('qrc.report_place_hint'))) : null,
        meta.location.rounds ? h('a', { class: 'qr-choice', href: '/#/rounds/scan/' + encodeURIComponent(code) }, icon('clipboard', 28), h('span', { class: 'strong' }, t('qrc.round')), h('span', { class: 'small' }, t('qrc.round_hint'))) : null,
      ),
    );
  }
  const saved = (() => {
    try {
      return JSON.parse(store.get('fm_requester', '{}')) || {};
    } catch {
      return {};
    }
  })();
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const empNo = input({ type: 'text', required: true, maxlength: 30, dir: 'ltr', inputmode: 'numeric', autocomplete: 'off', value: saved.emp_no || '' });
  const name = input({ type: 'text', required: true, maxlength: 100, autocomplete: 'name', value: saved.name || '' });
  const loc = meta.location;
  const dept = select([['', t('req.pick')], ...meta.departments.map((d) => [d.id, pick(d.name_ar, d.name_en)])], saved.department_id || (loc && loc.department_id) || '', { required: true });
  const phone = input({ type: 'tel', maxlength: 30, dir: 'ltr', autocomplete: 'tel', value: saved.phone || '' });
  // Without a QR, the place is picked from the list; the text box is for the room or for a place not listed.
  const places = loc ? [] : meta.places || [];
  const place = places.length ? select([['', t('req.pick')], ...places.map((p) => [p.id, pick(p.name_ar, p.name_en)]), ['other', t('req.place_other')]], '', { required: true }) : null;
  const where = input({ type: 'text', maxlength: 200, required: !loc && !place, placeholder: t('req.where_ph') });
  if (place) place.addEventListener('change', () => (where.required = place.value === 'other'));
  const asset = input({ type: 'text', maxlength: 60, dir: 'ltr', placeholder: t('req.asset_ph'), value: meta.asset ? meta.asset.tag : '' });
  const impact = input({ type: 'checkbox' });
  const desc = h('textarea', { required: true, maxlength: 2000, rows: 4, placeholder: t('req.desc_ph') });
  const photo = input({ type: 'file', accept: 'image/*' });
  const trap = input({ type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', class: 'visually-hidden', 'aria-hidden': 'true' });

  // Problem types as large buttons, grouped by the team that receives them.
  const groups = new Map();
  for (const c of meta.categories) {
    if (!groups.has(c.team_id)) groups.set(c.team_id, { id: c.team_id, name: pick(c.team_ar, c.team_en), list: [] });
    groups.get(c.team_id).list.push(c);
  }
  // From a device's QR only the device team's types show, with a way to see the rest.
  const ownTeam = meta.asset && groups.has(meta.asset.team_id) ? meta.asset.team_id : null;
  const showAll = () => {
    catBox.querySelectorAll('.cat-group[hidden]').forEach((g) => (g.hidden = false));
    moreBtn.remove();
  };
  const moreBtn = h('button', { type: 'button', class: 'btn btn-small cat-more', onclick: showAll }, t('req.all_types'));
  const catBox = h(
    'fieldset',
    { class: 'cat-pick' },
    h('legend', {}, t('req.type')),
    [...groups.values()].map((g) =>
      h(
        'div',
        { class: 'cat-group', hidden: ownTeam !== null && g.id !== ownTeam },
        h('div', { class: 'cat-team' }, g.name),
        h(
          'div',
          { class: 'cat-options' },
          g.list.map((c) => {
            const r = input({ type: 'radio', name: 'category', value: c.id, required: true, id: 'cat' + c.id });
            return h('label', { class: 'cat-option', for: 'cat' + c.id }, r, h('span', {}, pick(c.name_ar, c.name_en)));
          }),
        ),
      ),
    ),
    ownTeam !== null ? moreBtn : null,
  );

  // With a staff list, the employee number is enough: the name and department come from the list.
  const deptField = field(t('req.dept'), dept);
  const who = h('p', { class: 'who-card', 'aria-live': 'polite', hidden: true });
  let found = null;
  if (meta.staff_check) {
    deptField.hidden = true;
    dept.required = false;
    let timer = null;
    const lookUp = async () => {
      const no = empNo.value.trim();
      found = null;
      who.hidden = true;
      deptField.hidden = true;
      dept.required = false;
      if (!no) return;
      try {
        const r = await api('/public/staff?emp_no=' + encodeURIComponent(no));
        if (no !== empNo.value.trim()) return;
        if (!r.found) {
          who.className = 'who-card who-missing';
          who.textContent = t('req.emp_unknown');
          who.hidden = false;
          return;
        }
        found = r;
        who.className = 'who-card';
        who.textContent = [pick(r.name_ar, r.name_en), pick(r.dept_ar, r.dept_en)].filter(Boolean).join(' - ');
        who.hidden = false;
        // Listed without a department: the employee picks it.
        if (!r.department_id) {
          deptField.hidden = false;
          dept.required = true;
        }
      } catch (e) {
        // No internet: the server checks the number when the request goes out.
        if (OFF.down) found = { offline: true };
        who.className = 'who-card who-missing';
        who.textContent = OFF.down ? t('off.emp_later') : errText(e);
        who.hidden = false;
      }
    };
    empNo.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(lookUp, 500);
    });
    if (empNo.value) lookUp();
  }

  // The AI assistant reads the description and picks the problem type, until the employee picks one.
  const aiNote = h('p', { class: 'hint ai-note', 'aria-live': 'polite', hidden: true }, t('req.ai_picked'));
  let picked = false;
  if (meta.ai) {
    let timer = null;
    let asked = '';
    let calls = 0;
    catBox.addEventListener('change', (ev) => {
      if (ev.isTrusted) {
        picked = true;
        aiNote.hidden = true;
      }
    });
    desc.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const text = desc.value.trim();
        if (picked || text.length < 10 || text === asked || calls >= 5) return;
        asked = text;
        calls++;
        try {
          const r = await api('/public/suggest', { method: 'POST', body: { description: text } });
          const box = r.category_id && !picked ? catBox.querySelector('input[value="' + r.category_id + '"]') : null;
          if (box) {
            if (box.closest('.cat-group').hidden) showAll();
            box.checked = true;
            aiNote.hidden = false;
          }
        } catch {
          /* no suggestion: the employee picks */
        }
      }, 1200);
    });
  }

  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, t('req.send'));
  const form = h(
    'form',
    { class: 'stack' },
    loc ? h('p', { class: 'notice' }, t('req.at', { place: pick(loc.name_ar, loc.name_en) })) : null,
    meta.asset ? h('p', { class: 'notice' }, t('req.for_asset', { name: pick(meta.asset.name_ar, meta.asset.name_en), tag: meta.asset.tag })) : null,
    meta.bad_location ? h('p', { class: 'form-error' }, t('req.bad_qr')) : null,
    h('h2', { class: 'req-h' }, t('req.you')),
    meta.staff_check
      ? h('div', { class: 'form-grid' }, h('div', { class: 'stack' }, field(t('staff.emp_no'), empNo, t('req.emp_hint')), who), deptField, field(t('req.phone'), phone))
      : h('div', { class: 'form-grid' }, field(t('staff.emp_no'), empNo), field(t('req.name'), name), deptField, field(t('req.phone'), phone)),
    h('h2', { class: 'req-h' }, t('req.problem')),
    // With the assistant on, the description comes first so it can pick the type.
    meta.ai ? field(t('req.desc'), desc, t('req.desc_ai_hint')) : null,
    meta.categories.length ? catBox : h('p', { class: 'form-error' }, t('req.no_types')),
    meta.ai ? aiNote : null,
    checkField(t('req.impact'), impact),
    place ? field(t('req.place'), place) : null,
    field(loc || place ? t('req.where_more') : t('req.where'), where),
    field(t('req.asset'), asset, t('req.asset_hint')),
    meta.ai ? null : field(t('req.desc'), desc),
    field(t('req.photo'), photo, t('req.photo_hint')),
    trap,
    err,
    submit,
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    const cat = form.querySelector('input[name=category]:checked');
    if (meta.staff_check && !found) {
      err.textContent = t('req.emp_unknown');
      err.hidden = false;
      empNo.focus();
      return;
    }
    if (!cat) {
      err.textContent = t('err.category_required');
      err.hidden = false;
      return;
    }
    submit.disabled = true;
    try {
      const fd = new FormData();
      const fields = { emp_no: empNo.value, name: name.value, department_id: dept.value, phone: phone.value, category_id: cat.value, location_text: where.value, location_id: place && place.value !== 'other' ? place.value : '', asset_tag: asset.value, description: desc.value, impact: impact.checked ? '1' : '0', loc: code, website: trap.value };
      for (const [k, v] of Object.entries(fields)) fd.set(k, v);
      const f = photo.files && photo.files[0];
      if (f) fd.set('photo', await shrinkPhoto(f));
      const c = meta.categories.find((x) => String(x.id) === cat.value);
      const r = await api('/public/tickets', { method: 'POST', form: fd, offline: { ticket: { cat_ar: c.name_ar, cat_en: c.name_en } } });
      store.set('fm_requester', JSON.stringify({ emp_no: empNo.value, name: name.value, department_id: dept.value, phone: phone.value }));
      if (r.queued) {
        root.replaceChildren(h('div', { class: 'stack' }, h('p', { class: 'notice notice-warn' }, t('off.ticket_saved')), h('button', { type: 'button', class: 'btn btn-block', onclick: () => render() }, t('req.another'))));
        window.scrollTo(0, 0);
        return;
      }
      rememberTicket(r, { cat_ar: c.name_ar, cat_en: c.name_en });
      const track = 'track/' + r.id + '/' + r.token;
      root.replaceChildren(
        h('div', { class: 'stack' }, h('p', { class: 'notice' }, t('req.sent', { n: r.id })), h('p', { class: 'muted' }, t('req.sent_hint')), link(track, { class: 'btn btn-primary btn-block' }, t('req.follow')), h('button', { type: 'button', class: 'btn btn-block', onclick: () => render() }, t('req.another'))),
      );
      window.scrollTo(0, 0);
    } catch (e) {
      err.textContent = errText(e);
      err.hidden = false;
      submit.disabled = false;
    }
  });
  const mine = myTickets();
  const history = mine.length
    ? h(
        'div',
        { class: 'stack my-tickets' },
        h('h2', { class: 'req-h' }, t('req.mine')),
        h('ul', { class: 'ack-list' }, mine.map((m) => h('li', {}, link('track/' + m.id + '/' + m.token, {}, '#' + m.id + ' ' + pick(m.cat_ar, m.cat_en)), h('span', { class: 'muted small' }, fmtTime(m.at))))),
      )
    : null;
  const blocked = meta.require_qr && !loc;
  root.replaceChildren(...[blocked ? h('p', { class: 'notice notice-warn' }, t('req.need_qr')) : form, history].filter(Boolean));
  return publicShell(h('h1', {}, t('req.title')), blocked ? null : h('p', { class: 'muted' }, t('req.intro')), root);
}

export async function trackPage(id, token) {
  let data;
  try {
    data = await api('/public/tickets/' + id + '?t=' + token);
  } catch (e) {
    return publicShell(h('h1', {}, t('trk.title', { n: id })), errorBox(e), h('p', { class: 'auth-link' }, link('request', {}, t('req.new'))));
  }
  const tk = data.ticket;
  const steps = data.events.map((e) => {
    let d = {};
    try {
      d = JSON.parse(e.data || '{}') || {};
    } catch {
      /* no details */
    }
    let text = t('trk.' + e.kind, { who: e.actor });
    if (e.kind === 'hold' && d.code) text += ' - ' + t('hold.' + d.code);
    if (e.kind === 'closed') text = t('res.' + d.result) + (d.code ? ' - ' + t('close.' + d.code) : '');
    if (e.kind === 'feedback' && d.rating) text = t('trk.feedback', { n: d.rating });
    return h('li', {}, h('span', { class: 'strong' }, text), h('span', { class: 'muted small' }, fmtTime(e.at)), e.note ? h('span', { class: 'small step-note' }, e.note) : null);
  });
  const info = h(
    'div',
    { class: 'meta-grid' },
    h('div', { class: 'meta' }, h('span', { class: 'meta-label' }, t('tk.category')), h('span', { class: 'strong' }, pick(tk.cat_ar, tk.cat_en))),
    h('div', { class: 'meta' }, h('span', { class: 'meta-label' }, t('tk.team')), h('span', {}, pick(tk.team_ar, tk.team_en))),
    h('div', { class: 'meta' }, h('span', { class: 'meta-label' }, t('tk.assignee')), tk.assignee_name ? h('span', {}, pick(tk.assignee_name, tk.assignee_name_en) + (tk.assignee_title ? ' - ' + t('job.' + tk.assignee_title) : '')) : h('span', { class: 'muted' }, t('trk.waiting'))),
    tk.status !== 'closed' && tk.expected_at ? h('div', { class: 'meta' }, h('span', { class: 'meta-label' }, t('tk.expected')), timeEl(tk.expected_at)) : null,
  );
  let feedback = null;
  if (tk.can_feedback) {
    let stars = 0;
    const note = h('textarea', { rows: 2, maxlength: 500, placeholder: t('trk.note_ph') });
    const starBtns = [1, 2, 3, 4, 5].map((n) =>
      h('button', { type: 'button', class: 'star', 'aria-label': String(n), 'aria-pressed': 'false', onclick: () => { stars = n; starBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(i < n))); } }, '★'),
    );
    const send = async (reopen, btn) => {
      if (!reopen && !stars) {
        toast(t('err.rating_required'), true);
        return;
      }
      btn.disabled = true;
      try {
        await api('/public/tickets/' + id + '/feedback', { method: 'POST', body: { t: token, rating: stars, note: note.value, reopen } });
        toast(t(reopen ? 'trk.reopened' : 'trk.thanks'));
        render();
      } catch (e) {
        toast(errText(e), true);
        btn.disabled = false;
      }
    };
    feedback = h(
      'div',
      { class: 'panel pad stack' },
      h('h2', {}, t('trk.rate')),
      h('div', { class: 'stars', role: 'group', 'aria-label': t('trk.rate') }, starBtns),
      note,
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: (e) => send(false, e.currentTarget) }, t('trk.send_rating')),
        h('button', { type: 'button', class: 'btn', onclick: (e) => send(true, e.currentTarget) }, t('trk.still')),
      ),
    );
  }
  return publicShell(
    h('h1', {}, t('trk.title', { n: tk.id })),
    h('div', { class: 'meta-row' }, ticketChip(tk), priorityChip(tk.priority)),
    h('p', { class: 'muted' }, tk.description),
    info,
    h('ol', { class: 'steps' }, steps),
    tk.status === 'closed' && tk.close_note ? h('p', { class: 'notice' }, tk.close_note) : null,
    feedback,
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: () => render() }, t('trk.refresh')), link('request', { class: 'btn' }, t('req.new'))),
  );
}

/* the team's side */

export async function loadTicketMeta() {
  const m = await api('/tickets/meta');
  S.ticketMeta = m;
  return m;
}

// The red number beside "Requests" in the menu.
export async function refreshBadge() {
  const el = document.querySelector('.nav-link[data-nav=tickets] .badge');
  if (!el) return;
  try {
    const { count } = await api('/tickets/badge');
    el.textContent = count > 99 ? '99+' : String(count);
    el.hidden = !count;
  } catch {
    /* not now */
  }
}

export async function ticketsPage(root, param, alive) {
  if (/^\d+$/.test(param)) return ticketDetail(root, Number(param), alive);
  let data;
  let meta;
  const load = async () => {
    [data, meta] = await Promise.all([api('/tickets?days=' + S.tk.days), loadTicketMeta()]);
  };
  try {
    await load();
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const isSuper = S.user.desk === 'admin';
  const search = input({ type: 'search', class: 'doc-search-input', value: S.tk.q, placeholder: t('tk.search_ph'), 'aria-label': t('tk.search'), autocomplete: 'off' });
  search.addEventListener('input', () => {
    S.tk.q = search.value;
    drawList();
  });
  const listBox = h('div', {});

  const matches = (tk) => {
    const q = normText(S.tk.q);
    if (!q) return true;
    return normText([tk.id, tk.requester_name, tk.requester_emp_no, tk.asset_tag, tk.cat_ar, tk.cat_en, tk.location_text, tk.loc_ar, tk.assignee_name, tk.assignee_name_en, tk.description].join(' ')).includes(q);
  };
  const bucket = (tk) => (tk.status === 'closed' ? 'closed' : tk.late ? 'late' : tk.status);

  function drawList() {
    const tickets = data.tickets.filter((tk) => (!S.tk.team || String(tk.team_id) === S.tk.team) && matches(tk));
    const counts = { new: 0, in_progress: 0, on_hold: 0, late: 0, closed: 0 };
    tickets.forEach((tk) => counts[bucket(tk)]++);
    const rows = tickets.filter((tk) => !S.tk.status || bucket(tk) === S.tk.status);
    const cards = ['new', 'in_progress', 'on_hold', 'late', 'closed'].map((st) =>
      h(
        'button',
        {
          type: 'button',
          class: 'card card-' + { new: 'review', in_progress: 'progress', on_hold: 'near', late: 'expired', closed: 'valid' }[st] + (st === 'new' && counts.new ? ' card-waiting' : ''),
          'aria-pressed': String(S.tk.status === st),
          onclick: () => {
            S.tk.status = S.tk.status === st ? '' : st;
            drawList();
          },
        },
        h('span', { class: 'card-label' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('tcard.' + st)),
        h('span', { class: 'card-num' }, String(counts[st])),
      ),
    );
    listBox.replaceChildren(
      h('section', { class: 'cards', 'aria-label': t('dash.summary') }, cards),
      kpiPanel(tickets),
      h(
        'section',
        { class: 'panel' },
        h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, S.tk.status ? t('tcard.' + S.tk.status) : t('tk.all')), h('span', { class: 'muted small' }, t('tk.count', { n: rows.length })))),
        rows.length ? h('div', { class: 'table-scroll' }, ticketsTable(rows, data.now)) : h('p', { class: 'empty' }, data.tickets.length ? t('tk.empty_filter') : t('tk.empty')),
      ),
    );
  }

  const teamFilter =
    meta.teams.length > 1 && (isSuper || S.user.desk === 'supervisor')
      ? h(
          'div',
          { class: 'inline-field' },
          h('label', { for: 'tk-team' }, t('tk.team')),
          select([['', t('tk.all_teams')], ...meta.teams.map((d) => [d.id, deptName(d)])], S.tk.team, {
            id: 'tk-team',
            onchange: (e) => {
              S.tk.team = e.target.value;
              drawList();
            },
          }),
        )
      : null;
  const period = h(
    'div',
    { class: 'inline-field' },
    h('label', { for: 'tk-days' }, t('tk.period')),
    select([30, 90, 365].map((d) => [d, t('tk.days', { n: d })]), S.tk.days, {
      id: 'tk-days',
      onchange: (e) => {
        S.tk.days = Number(e.target.value);
        render();
      },
    }),
  );
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.tickets')), h('p', { class: 'muted' }, t('tk.sub'))),
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => linkDialog() }, icon('plus'), t('tk.link')),
        h('button', { type: 'button', class: 'btn', onclick: () => exportTickets(data.tickets.filter((tk) => (!S.tk.team || String(tk.team_id) === S.tk.team) && matches(tk) && (!S.tk.status || bucket(tk) === S.tk.status))) }, icon('download'), t('dash.export')),
        isSuper ? link('categories', { class: 'btn' }, t('nav.categories')) : null,
        isSuper ? link('locations', { class: 'btn' }, t('nav.locations')) : null,
      ),
    ),
    h('div', { class: 'filters' }, h('div', { class: 'doc-search', role: 'search' }, icon('search'), search), teamFilter, period),
    listBox,
  );
  drawList();
  // New requests appear without reloading the page.
  const timer = setInterval(async () => {
    if (!alive()) return clearInterval(timer);
    if (document.querySelector('dialog[open]')) return;
    try {
      data = await api('/tickets?days=' + S.tk.days);
      if (alive()) {
        drawList();
        refreshBadge();
      }
    } catch {
      /* next time */
    }
  }, 60000);
}

// How well requests were handled in the period: on time, how fast, fixed or not, rating.
export function kpiPanel(tickets) {
  const closed = tickets.filter((tk) => tk.status === 'closed');
  const received = tickets.filter((tk) => tk.received_at);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '-');
  const avg = (list, f) => (list.length ? fmtDuration(list.reduce((n, x) => n + f(x), 0) / list.length) : '-');
  const rated = closed.filter((tk) => tk.rating);
  const items = [
    ['kpi.on_time', pct(closed.filter((tk) => tk.sla_met).length, closed.length)],
    ['kpi.response_on_time', pct(received.filter((tk) => tk.response_met).length, received.length)],
    ['kpi.avg_response', avg(received, (tk) => Date.parse(tk.received_at) - Date.parse(tk.created_at))],
    ['kpi.avg_resolve', avg(closed, (tk) => Date.parse(tk.closed_at) - Date.parse(tk.created_at))],
    ['kpi.resolved', pct(closed.filter((tk) => tk.resolution !== 'unresolved').length, closed.length)],
    ['kpi.reopened', String(tickets.filter((tk) => tk.reopen_count > 0).length)],
    ['kpi.rating', rated.length ? (rated.reduce((n, tk) => n + tk.rating, 0) / rated.length).toFixed(1) + ' / 5' : '-'],
  ];
  return h('section', { class: 'panel kpis', 'aria-label': t('kpi.title') }, items.map(([k, v]) => h('div', { class: 'kpi' }, h('span', { class: 'kpi-num', dir: 'ltr' }, v), h('span', { class: 'kpi-label' }, t(k)))));
}

// Mirrors canSuperviseTicket in src/worker.js.
export const canSupervise = (tk) => S.user.desk === 'admin' || (S.user.desk === 'supervisor' && S.user.department_id === tk.team_id);
// Mirrors canWorkTicket in src/worker.js (the server still decides).
export const canWork = (tk) => S.user.desk === 'admin' || ((S.user.desk === 'technician' || S.user.desk === 'supervisor') && S.user.department_id === tk.team_id);
// Opens the request and its receive form in one step.
export const receiveNow = (id) => {
  S.autoReceive = id;
  navigate('tickets/' + id);
};

export function ticketsTable(rows, now) {
  const cols = ['tk.no', 'tk.created', 'tk.priority', 'tk.category', 'tk.requester', 'tk.location', 'tk.status', 'tk.assignee', 'tk.due'];
  const table = h(
    'table',
    { class: 'tickets-table' },
    h('thead', {}, h('tr', {}, cols.map((c) => h('th', { scope: 'col' }, t(c))))),
    h(
      'tbody',
      {},
      rows.map((tk) =>
        h(
          'tr',
          {
            // A new request waiting for the team glows softly; the whole row opens it.
            class: ['row-link', tk.late ? 'row-late' : '', tk.status === 'new' && canWork(tk) ? 'row-new' : ''].filter(Boolean).join(' '),
            onclick: (e) => {
              if (!e.target.closest('a, button')) navigate('tickets/' + tk.id);
            },
          },
          h('td', {}, link('tickets/' + tk.id, { class: 'btn btn-small', 'aria-label': t('tk.open') + ' #' + tk.id }, '#' + tk.id)),
          h('td', {}, timeEl(tk.created_at)),
          h('td', {}, priorityChip(tk.priority), tk.patient_impact ? h('div', { class: 'note note-expired' }, t('tk.impact')) : null),
          h('td', { class: 'wrap-cell' }, h('div', { class: 'strong' }, pick(tk.cat_ar, tk.cat_en)), h('div', { class: 'muted small' }, pick(tk.team_ar, tk.team_en))),
          h(
            'td',
            { class: 'wrap-cell' },
            tk.pm_plan_id
              ? h('div', {}, t('tk.auto_order'))
              : h('div', {}, h('button', { type: 'button', class: 'btn-link', title: t('pp.view'), onclick: () => personDialog(tk, 'requester') }, h('bdi', {}, tk.requester_name))),
            h('div', { class: 'muted small' }, tk.pm_plan_id ? t('tk.auto_from', { kind: t('pm.kind.' + tk.pm_kind) }) : h('span', { dir: 'ltr' }, tk.requester_emp_no), !tk.pm_plan_id && tk.rdept_ar ? ' - ' + pick(tk.rdept_ar, tk.rdept_en) : ''),
          ),
          h('td', { class: 'wrap-cell' }, [pick(tk.loc_ar, tk.loc_en), tk.location_text].filter(Boolean).join(' - ') || h('span', { class: 'muted' }, t('common.none')), tk.asset_tag ? h('div', { class: 'muted small' }, h('span', { class: 'mono', dir: 'ltr' }, tk.asset_tag), tk.asset_id ? ' ' + pick(tk.asset_ar, tk.asset_en) : '') : null),
          h('td', {}, h('div', { class: 'cell-stack' }, ticketChip(tk), tk.status === 'new' && canWork(tk) ? h('button', { type: 'button', class: 'btn btn-primary btn-small btn-receive', onclick: () => receiveNow(tk.id) }, icon('check'), t('tk.receive')) : null, lateNote(tk, now), tk.repeat_n ? h('span', { class: 'note note-near' }, t('tk.repeat', { n: tk.repeat_n })) : null)),
          h(
            'td',
            {},
            !tk.assignee_name
              ? h('span', { class: 'muted' }, t('common.none'))
              : canSupervise(tk) || tk.assigned_to === S.user.id
                ? h('button', { type: 'button', class: 'btn-link', title: t('pp.view'), onclick: () => personDialog(tk, 'assignee') }, pick(tk.assignee_name, tk.assignee_name_en))
                : pick(tk.assignee_name, tk.assignee_name_en),
          ),
          h('td', {}, tk.status === 'closed' ? timeEl(tk.closed_at) : timeEl(tk.status === 'new' ? tk.response_due : tk.expected_at || tk.resolve_due)),
        ),
      ),
    ),
  );
  // On a phone each row is a card, and each cell shows its column name (styles.css).
  for (const tr of table.tBodies[0].rows)
    [...tr.cells].forEach((td, i) => {
      td.setAttribute('data-label', t(cols[i]));
      if (td.textContent === t('common.none')) td.classList.add('cell-none');
    });
  return table;
}

// The public link (and its QR) to share with every department.
export async function linkDialog() {
  const url = requestUrl('');
  const qr = h('div', { class: 'qr-box' }, loading());
  const dlg = openDialog({
    title: t('tk.link'),
    body: h(
      'div',
      { class: 'stack' },
      h('p', { class: 'muted' }, t('tk.link_help')),
      h('div', { class: 'copy-row' }, input({ type: 'text', readonly: true, value: url, dir: 'ltr', onfocus: (e) => e.target.select() })),
      qr,
    ),
    submitLabel: t('tk.copy'),
    onSubmit: async () => {
      try {
        await navigator.clipboard.writeText(url);
        toast(t('tk.copied'));
      } catch {
        toast(url);
      }
    },
  });
  dlg.querySelector('.dialog-actions').append(h('button', { type: 'button', class: 'btn', onclick: () => printQr([{ url, title: t('tk.link_any') }]) }, t('qr.print')));
  try {
    qr.replaceChildren(await qrSvg(url, 200));
  } catch {
    qr.replaceChildren();
  }
}

export async function ticketDetail(root, id, alive) {
  let data;
  let meta;
  try {
    [data, meta] = await Promise.all([api('/tickets/' + id), S.ticketMeta ? Promise.resolve(S.ticketMeta) : loadTicketMeta()]);
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const tk = data.ticket;
  const now = new Date().toISOString();
  const metaRow = (label, value) => h('div', { class: 'meta' }, h('span', { class: 'meta-label' }, label), value);
  const act = (action, body) => api('/tickets/' + id + '/action', { method: 'POST', body: Object.assign({ action }, body) }).then(() => {
    toast(t('tk.saved'));
    render();
    refreshBadge();
  });
  const btn = (label, fn, primary) => h('button', { type: 'button', class: 'btn' + (primary ? ' btn-primary' : ''), onclick: fn }, label);
  const actions = [];
  const receive = () => expectedDialog('receive', t('tk.receive'), tk, act);
  const waiting = data.can_work && tk.status === 'new';
  if (data.can_work) {
    if (tk.status === 'new') actions.push(btn(t('tk.receive'), receive, true));
    if (tk.status === 'in_progress') {
      actions.push(btn(t('tk.close'), () => closeDialog(tk, act), true));
      actions.push(btn(t('tk.hold'), () => holdDialog(act)));
      actions.push(btn(t('tk.change_expected'), () => expectedDialog('expected', t('tk.change_expected'), tk, act)));
    }
    if (tk.status === 'on_hold') {
      actions.push(btn(t('tk.resume'), () => act('resume', {}).catch((e) => toast(errText(e), true)), true));
      actions.push(btn(t('tk.close'), () => closeDialog(tk, act)));
    }
    if (tk.status === 'new') actions.push(btn(t('tk.close_direct'), () => closeDialog(tk, act)));
    if (tk.status !== 'closed') actions.push(btn(t('tk.transfer'), () => transferDialog(tk, meta, act)));
    if (tk.status !== 'closed' && !tk.vendor_called_at) actions.push(btn(t('vnd.send'), () => vendorCallDialog(tk, data.asset_contract, act)));
    if (tk.vendor_called_at && !tk.vendor_arrived_at) actions.push(btn(t('vnd.arrived'), () => vendorArriveDialog(act), tk.status !== 'new'));
  }
  if (data.can_supervise) {
    if (tk.status !== 'closed') actions.push(btn(t('tk.assign'), () => assignDialog(tk, meta, act)));
    if (tk.status !== 'closed') actions.push(btn(t('tk.change_priority'), () => priorityDialog(tk, act)));
    if (tk.status === 'closed') actions.push(btn(t('tk.reopen'), () => noteDialog(t('tk.reopen'), t('tk.reason'), (note) => act('reopen', { note }))));
  }
  if (data.can_work) actions.push(btn(t('tk.comment'), () => noteDialog(t('tk.comment'), t('tk.comment_label'), (note) => act('comment', { note }))));
  if (S.user.desk === 'admin')
    actions.push(
      h('button', {
        type: 'button',
        class: 'btn btn-icon',
        title: t('common.delete'),
        'aria-label': t('common.delete'),
        onclick: () =>
          openDialog({
            title: t('tk.delete_q', { n: id }),
            body: h('p', { class: 'muted' }, t('tk.delete_hint')),
            submitLabel: t('common.delete'),
            danger: true,
            onSubmit: async () => {
              await api('/tickets/' + id, { method: 'DELETE' });
              toast(t('tk.deleted'));
              navigate('tickets');
            },
          }),
      }, icon('trash')),
    );

  // Spare parts used on it: loaded after the page is drawn, so the request opens at once.
  const partsBox = h('div', {});
  ticketParts(partsBox, tk);
  const who = (u) => u.name + (u.title ? ' - ' + t('job.' + u.title) : '');
  const events = data.events.map((e) => {
    let d = {};
    try {
      d = JSON.parse(e.data || '{}') || {};
    } catch {
      /* no details */
    }
    const extra = [];
    if (d.expected_at) extra.push(t('tk.expected') + ': ' + fmtTime(d.expected_at));
    if (d.to && e.kind === 'assigned') extra.push(pick(d.to, d.to_en) + (d.auto ? ' (' + t('tk.auto') + ')' : ''));
    if (e.kind === 'repeat') extra.push(t('tk.repeat_detail', { n: d.n, days: d.days }));
    if (e.kind === 'expected') extra.push(fmtTime(d.from) + ' ' + t('log.arrow') + ' ' + fmtTime(d.to));
    if (e.kind === 'hold') extra.push(t('hold.' + d.code));
    if (e.kind === 'resume' && d.minutes !== undefined) extra.push(t('tk.held_for', { d: fmtDuration(d.minutes * 60000) }));
    if (e.kind === 'closed') extra.push(t('res.' + d.result) + (d.code ? ' - ' + t('close.' + d.code) : ''));
    if (e.kind === 'priority') extra.push('P' + d.from + ' ' + t('log.arrow') + ' P' + d.to);
    if (e.kind === 'transferred') extra.push(d.from + ' ' + t('log.arrow') + ' ' + d.to);
    if (e.kind === 'alert') extra.push(t(d.level === 2 ? 'tk.alert_escalated' : 'tk.alert_team'));
    if (e.kind === 'feedback' && d.rating) extra.push('★ ' + d.rating + ' / 5');
    if (e.kind === 'vendor_called') extra.push(pick(d.vendor, d.vendor_en) + (d.contract ? ' - ' + t('con.contract') + ' ' + d.contract : '') + (d.at && Math.abs(Date.parse(d.at) - Date.parse(e.at)) > 60000 ? ' - ' + fmtTime(d.at) : ''));
    if (e.kind === 'part_issued' || e.kind === 'part_returned' || e.kind === 'part_requested') extra.push(pick(d.part, d.part_en) + ' (' + d.code + ') - ' + fmtQty(d.qty) + ' ' + unitText(d.unit));
    if (e.kind === 'vendor_arrived') extra.push(fmtTime(d.at) + (d.late_min ? ' - ' + t('con.late_by', { d: fmtHours(d.late_min) }) : ''));
    return h(
      'li',
      {},
      h('div', { class: 'step-head' }, h('span', { class: 'strong' }, t('ev.' + e.kind)), h('span', { class: 'muted small' }, e.actor === 'system' ? t('tk.system') : e.actor), h('span', { class: 'muted small nowrap' }, fmtTime(e.at))),
      extra.length ? h('div', { class: 'small' }, extra.join(' - ')) : null,
      e.note ? h('div', { class: 'step-note' }, e.note) : null,
    );
  });

  root.replaceChildren(
    h('p', {}, link('tickets', { class: 'back-link' }, t('tk.back'))),
    waiting
      ? h(
          'div',
          { class: 'receive-bar', role: 'status' },
          h('div', {}, h('div', { class: 'strong' }, t('tk.waiting')), h('div', { class: 'small' }, t('tk.waiting_hint'))),
          h('button', { type: 'button', class: 'btn btn-primary', onclick: receive }, icon('check'), t('tk.receive_now')),
        )
      : '', // replaceChildren would print null
    h(
      'div',
      { class: 'panel doc-head' },
      h('div', { class: 'doc-title ticket-title' }, ticketNo(tk.id), priorityChip(tk.priority), ticketChip(tk), lateNote(tk, now), tk.patient_impact ? h('span', { class: 'note note-expired strong' }, t('tk.impact')) : null, tk.repeat_n ? h('span', { class: 'note note-near strong' }, t('tk.repeat', { n: tk.repeat_n })) : null, tk.pm_plan_id ? h('span', { class: 'chip chip-pm' }, t('pm.kind.' + tk.pm_kind)) : null),
      h('h1', {}, pick(tk.cat_ar, tk.cat_en)),
      h(
        'div',
        { class: 'meta-grid' },
        metaRow(t('tk.team'), h('span', { class: 'strong' }, pick(tk.team_ar, tk.team_en))),
        tk.pm_plan_id
          ? metaRow(t('pm.order'), h('span', {}, t('pm.kind.' + tk.pm_kind) + ' - ' + t('pm.due') + ' ', h('span', { dir: 'ltr' }, fmtDate(tk.pm_due))))
          : metaRow(t('tk.requester'), h('span', {}, h('button', { type: 'button', class: 'btn-link', title: t('pp.view'), onclick: () => personDialog(tk, 'requester') }, h('bdi', {}, tk.requester_name)), ' ', h('span', { class: 'muted mono', dir: 'ltr' }, '#' + tk.requester_emp_no))),
        metaRow(t('tk.rdept'), h('span', {}, pick(tk.rdept_ar, tk.rdept_en) || t('common.none'))),
        metaRow(
          t('tk.phone'),
          tk.requester_phone
            ? h(
                'span',
                { class: 'phone-row' },
                h('a', { href: 'tel:' + tk.requester_phone, dir: 'ltr' }, tk.requester_phone),
                data.can_work && waNumber(tk.requester_phone)
                  ? h('a', { class: 'btn btn-small', href: 'https://wa.me/' + waNumber(tk.requester_phone) + '?text=' + encodeURIComponent(t('wa.msg', { org: orgNameIn('ar'), org_en: orgNameIn('en'), name: tk.requester_name, name_en: tk.requester_name_en || tk.requester_name, n: tk.id, cat: tk.cat_ar || tk.cat_en, cat_en: tk.cat_en || tk.cat_ar })), target: '_blank', rel: 'noopener' }, t('wa.send'))
                  : null,
              )
            : h('span', { class: 'muted' }, t('common.none')),
        ),
        metaRow(t('tk.location'), h('span', {}, [pick(tk.loc_ar, tk.loc_en), tk.location_text].filter(Boolean).join(' - ') || t('common.none'))),
        metaRow(
          t('tk.asset'),
          !tk.asset_tag
            ? h('span', { class: 'muted' }, t('common.none'))
            : tk.asset_id && access('assets') !== 'none'
              ? link('assets/register/' + tk.asset_id, {}, h('span', { class: 'mono', dir: 'ltr' }, tk.asset_tag), ' ' + pick(tk.asset_ar, tk.asset_en))
              : h('span', {}, h('span', { class: 'mono', dir: 'ltr' }, tk.asset_tag), tk.asset_id ? ' ' + pick(tk.asset_ar, tk.asset_en) : ''),
        ),
        metaRow(t('tk.created'), timeEl(tk.created_at)),
        metaRow(t('tk.response_due'), h('div', { class: 'cell-stack' }, timeEl(tk.response_due), tk.response_met === false ? h('span', { class: 'note note-expired' }, t('tk.missed')) : null)),
        metaRow(
          t('tk.received'),
          tk.received_at
            ? h(
                'span',
                {},
                fmtTime(tk.received_at),
                tk.assignee_name ? ' - ' : '',
                !tk.assignee_name
                  ? ''
                  : data.can_supervise || tk.assigned_to === S.user.id
                    ? h('button', { type: 'button', class: 'btn-link', title: t('pp.view'), onclick: () => personDialog(tk, 'assignee') }, who({ name: pick(tk.assignee_name, tk.assignee_name_en), title: tk.assignee_title }))
                    : who({ name: pick(tk.assignee_name, tk.assignee_name_en), title: tk.assignee_title }),
              )
            : h('span', { class: 'muted' }, t('trk.waiting')),
        ),
        metaRow(t('tk.expected'), timeEl(tk.expected_at)),
        metaRow(t('tk.resolve_due'), timeEl(tk.resolve_due)),
        tk.closed_at ? metaRow(t('tk.closed'), h('div', { class: 'cell-stack' }, timeEl(tk.closed_at), h('span', { class: 'note ' + (tk.sla_met ? '' : 'note-expired') }, t(tk.sla_met ? 'tk.on_time' : 'tk.missed')))) : null,
        tk.rating ? metaRow(t('kpi.rating'), h('span', { class: 'strong' }, '★ ' + tk.rating + ' / 5')) : null,
        tk.vendor_called_at
          ? metaRow(
              t('con.vendor'),
              h(
                'div',
                { class: 'cell-stack' },
                h('span', { class: 'strong' }, pick(tk.vendor_ar, tk.vendor_en), tk.contract_number ? h('span', { class: 'muted' }, ' - ' + t('con.contract') + ' ', h('span', { dir: 'ltr' }, tk.contract_number)) : null),
                tk.vendor_phone ? h('a', { href: 'tel:' + tk.vendor_phone, dir: 'ltr' }, tk.vendor_phone) : null,
                h('span', { class: 'small' }, t('con.called') + ': ' + fmtTime(tk.vendor_called_at)),
                tk.vendor_arrived_at
                  ? h('span', { class: 'small' }, t('con.arrived') + ': ' + fmtTime(tk.vendor_arrived_at))
                  : h('span', { class: 'note note-near' }, t('con.not_arrived') + (tk.vendor && tk.vendor.due_at ? ' - ' + t('vnd.due_by', { t: fmtTime(tk.vendor.due_at) }) : '')),
                tk.vendor && tk.vendor.late_min ? h('span', { class: 'note note-expired' }, lateText(tk.vendor) + (tk.vendor.penalty ? ' - ' + t('con.penalty') + ' ' + fmtMoney(tk.vendor.penalty) : '')) : null,
              ),
            )
          : data.asset_contract
            ? metaRow(t('con.contract'), h('span', { class: 'small' }, t('vnd.covered', { c: data.asset_contract.number, v: vendorName(data.asset_contract) })))
            : null,
      ),
    ),
    h(
      'section',
      { class: 'panel pad stack' },
      h('h2', {}, t('req.desc')),
      h('p', { class: 'pre' }, tk.description),
      tk.has_photo ? h('a', { href: '/api/tickets/' + id + '/photo', target: '_blank', rel: 'noopener', class: 'ticket-photo' }, h('img', { src: '/api/tickets/' + id + '/photo', alt: t('req.photo'), loading: 'lazy' })) : null,
      tk.status === 'closed' ? h('div', { class: 'notice' + (tk.resolution === 'unresolved' ? ' notice-warn' : '') }, h('div', { class: 'strong' }, t('res.' + tk.resolution) + (tk.close_code ? ' - ' + t('close.' + tk.close_code) : '')), h('div', { class: 'pre' }, tk.close_note), tk.cause_note ? h('div', { class: 'small' }, t('tk.cause') + ': ' + tk.cause_note) : null) : null,
    ),
    actions.length ? h('div', { class: 'actions ticket-actions' }, actions) : '',
    partsBox,
    h('section', { class: 'panel pad stack' }, h('h2', {}, t('tk.history')), h('ol', { class: 'steps' }, events)),
  );
  if (S.autoReceive === Number(id)) {
    S.autoReceive = null;
    if (waiting) receive();
  }
}

// Clicking a name on a request: how this person's requests went in the period, within what the viewer may see.
export function personDialog(tk, who) {
  const { dlg, box } = flowDialog(t(who === 'assignee' ? 'pp.title_assignee' : 'pp.title_requester'));
  const days = select([30, 90, 365].map((d) => [String(d), t('pp.days', { n: d })]), '90', { 'aria-label': t('pp.period') });
  const body = h('div', { class: 'stack' }, loading());
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '-');
  const min = (m) => (m === null ? '-' : fmtDuration(m * 60000));
  const draw = async () => {
    body.replaceChildren(loading());
    let d;
    try {
      d = await api('/tickets/' + tk.id + '/person?who=' + who + '&days=' + days.value);
    } catch (e) {
      body.replaceChildren(h('p', { class: 'form-error' }, errText(e)));
      return;
    }
    const p = d.person;
    const s = d.stats;
    const sub = [p.job_title ? t('job.' + p.job_title) : '', pick(p.dept_ar, p.dept_en)].filter(Boolean).join(' - ');
    const items =
      who === 'assignee'
        ? [
            ['pp.handled', s.total],
            ['pp.closed', s.closed],
            ['pp.open', s.open],
            ['pp.done', pct(s.closed, s.total)],
            ['kpi.response_on_time', pct(s.received_on_time, s.received)],
            ['kpi.on_time', pct(s.fixed_on_time, s.closed)],
            ['kpi.avg_resolve', min(s.avg_fix_min)],
            ['kpi.resolved', pct(s.resolved, s.closed)],
            ['kpi.reopened', s.reopened],
            ['kpi.rating', s.rating === null ? '-' : s.rating + ' / 5'],
          ]
        : [
            ['pp.sent', s.total],
            ['pp.open', s.open],
            ['pp.closed', s.closed],
            ['pp.late', s.late],
            ['kpi.on_time', pct(s.fixed_on_time, s.closed)],
            ['kpi.avg_resolve', min(s.avg_fix_min)],
            ['pp.impact', s.impact],
            ['pp.rating_given', s.rating === null ? '-' : s.rating + ' / 5'],
          ];
    body.replaceChildren(
      h(
        'div',
        { class: 'pp-head' },
        h('div', { class: 'strong' }, h('bdi', {}, pick(p.name, p.name_en)), p.emp_no ? ' ' : null, p.emp_no ? h('span', { class: 'muted mono', dir: 'ltr' }, '#' + p.emp_no) : null),
        sub ? h('div', { class: 'muted small' }, sub) : null,
        !p.active ? h('span', { class: 'note note-near' }, t('pp.inactive')) : null,
      ),
      !s.total
        ? h('p', { class: 'muted' }, t('pp.none'))
        : h('section', { class: 'panel kpis pp-kpis', 'aria-label': t('kpi.title') }, items.map(([k, v]) => h('div', { class: 'kpi' }, h('span', { class: 'kpi-num', dir: /[\u0600-\u06FF]/.test(String(v)) ? 'rtl' : 'ltr' }, String(v)), h('span', { class: 'kpi-label' }, t(k))))),
      d.categories.length ? h('div', { class: 'stack' }, h('h3', { class: 'small strong' }, t('pp.top_types')), h('ul', { class: 'pp-list' }, d.categories.map((c) => h('li', {}, h('span', {}, pick(c.name_ar, c.name_en) || t('common.none')), h('span', { class: 'muted', dir: 'ltr' }, String(c.n)))))) : '',
      d.recent.length
        ? h(
            'div',
            { class: 'stack' },
            h('h3', { class: 'small strong' }, t('pp.recent')),
            h(
              'ul',
              { class: 'pp-list' },
              d.recent.map((r) =>
                h(
                  'li',
                  {},
                  r.id === tk.id
                    ? h('span', {}, ticketNo(r.id), ' ', pick(r.cat_ar, r.cat_en))
                    : link('tickets/' + r.id, { onclick: () => dlg.close() }, ticketNo(r.id), ' ', pick(r.cat_ar, r.cat_en)),
                  h('span', { class: 'muted small nowrap' }, t('tst.' + r.status)),
                ),
              ),
            ),
          )
        : '', // replaceChildren would print null
    );
  };
  days.addEventListener('change', draw);
  box.append(h('div', { class: 'pp-period' }, days), body);
  draw();
  return dlg;
}

export function expectedDialog(action, title, tk, act) {
  const dueLocal = toLocalInput(tk.resolve_due);
  const at = input({ type: 'datetime-local', required: true, value: tk.expected_at ? toLocalInput(tk.expected_at) : dueLocal });
  const note = h('textarea', { rows: 2, maxlength: 2000, required: action === 'expected' });
  openDialog({
    title,
    body: h('div', { class: 'stack' }, field(t('tk.expected'), at, t('tk.expected_hint', { t: fmtTime(tk.resolve_due) })), field(t(action === 'expected' ? 'tk.reason' : 'tk.note_optional'), note)),
    submitLabel: title,
    onSubmit: () => act(action, { expected_at: fromLocalInput(at.value), note: note.value }),
  });
}
export function holdDialog(act) {
  const code = select([['', t('req.pick')], ...['parts', 'vendor', 'access', 'requester', 'other'].map((c) => [c, t('hold.' + c)])], '', { required: true });
  const note = h('textarea', { rows: 2, maxlength: 2000 });
  openDialog({
    title: t('tk.hold'),
    body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, t('tk.hold_help')), field(t('tk.hold_reason'), code), field(t('tk.note_optional'), note)),
    submitLabel: t('tk.hold'),
    onSubmit: () => act('hold', { code: code.value, note: note.value }),
  });
}
export function closeDialog(tk, act) {
  const result = select(['resolved', 'workaround', 'unresolved'].map((r) => [r, t('res.' + r)]), 'resolved', {});
  const code = select([['', t('req.pick')], ...['replace', 'vendor', 'duplicate', 'no_fault', 'not_ours', 'other'].map((c) => [c, t('close.' + c)])], '', {});
  const codeField = field(t('tk.close_code'), code);
  const note = h('textarea', { rows: 3, maxlength: 2000, required: true });
  const cause = input({ type: 'text', maxlength: 500 });
  const sync = () => {
    codeField.hidden = result.value === 'resolved';
    code.required = result.value === 'unresolved';
  };
  result.addEventListener('change', sync);
  sync();
  openDialog({
    title: t('tk.close') + ' #' + tk.id,
    body: h('div', { class: 'stack' }, field(t('tk.result'), result), codeField, field(t('tk.solution'), note, t('tk.solution_hint')), field(t('tk.cause'), cause, t('tk.cause_hint'))),
    submitLabel: t('tk.close'),
    onSubmit: () => act('close', { result: result.value, code: result.value === 'resolved' ? null : code.value || null, note: note.value, cause: cause.value }),
  });
}
export function assignDialog(tk, meta, act) {
  const people = meta.members.filter((m) => m.department_id === tk.team_id);
  if (!people.length) {
    toast(t('tk.no_members'), true);
    return;
  }
  const who = select(people.map((m) => [m.id, personName(m) + (m.job_title ? ' - ' + t('job.' + m.job_title) : '')]), tk.assigned_to || people[0].id, {});
  const at = input({ type: 'datetime-local', value: toLocalInput(tk.expected_at || tk.resolve_due) });
  const note = h('textarea', { rows: 2, maxlength: 2000 });
  openDialog({
    title: t('tk.assign'),
    body: h('div', { class: 'stack' }, field(t('tk.assignee'), who), field(t('tk.expected'), at, t('tk.expected_hint', { t: fmtTime(tk.resolve_due) })), field(t('tk.note_optional'), note)),
    submitLabel: t('tk.assign'),
    onSubmit: () => act('assign', { user_id: Number(who.value), expected_at: fromLocalInput(at.value), note: note.value }),
  });
}
export function priorityDialog(tk, act) {
  const p = select([1, 2, 3, 4].map((n) => [n, 'P' + n + ' ' + t('prio.' + n)]), tk.priority, {});
  const note = h('textarea', { rows: 2, maxlength: 2000, required: true });
  openDialog({
    title: t('tk.change_priority'),
    body: h('div', { class: 'stack' }, field(t('tk.priority'), p), field(t('tk.reason'), note)),
    onSubmit: () => act('priority', { priority: Number(p.value), note: note.value }),
  });
}
export function transferDialog(tk, meta, act) {
  const cats = meta.categories.filter((c) => c.active && c.id !== tk.category_id);
  const teams = new Map(meta.teams.map((d) => [d.id, deptName(d)]));
  const cat = select(cats.map((c) => [c.id, pick(c.name_ar, c.name_en) + ' - ' + (teams.get(c.team_id) || '')]), '', { required: true });
  const note = h('textarea', { rows: 2, maxlength: 2000, required: true });
  openDialog({
    title: t('tk.transfer'),
    body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, t('tk.transfer_help')), field(t('tk.category'), cat), field(t('tk.reason'), note)),
    submitLabel: t('tk.transfer'),
    onSubmit: async () => {
      await act('transfer', { category_id: Number(cat.value), note: note.value });
    },
  });
}
export function noteDialog(title, label, send) {
  const note = h('textarea', { rows: 3, maxlength: 2000, required: true });
  openDialog({ title, body: h('div', { class: 'stack' }, field(label, note)), submitLabel: title, onSubmit: () => send(note.value) });
}

export function exportTickets(rows) {
  const ST = XLS_STYLE;
  const head = ['tk.no', 'tk.created', 'tk.priority', 'tk.category', 'tk.team', 'tk.requester', 'staff.emp_no', 'req.dept', 'tk.location', 'req.asset', 'req.desc', 'tk.status', 'tk.assignee', 'tk.received', 'tk.expected', 'tk.closed', 'xls.response_min', 'xls.resolve_h', 'xls.on_time', 'tk.solution', 'kpi.rating'].map((k) => t(k));
  const local = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    return (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()) / 86400000) + 25569;
  };
  const body = rows.map((tk) => [
    { v: tk.id, s: ST.num },
    { v: local(tk.created_at), s: ST.time },
    { v: 'P' + tk.priority + ' ' + t('prio.' + tk.priority), s: ST.num },
    { v: pick(tk.cat_ar, tk.cat_en) },
    { v: pick(tk.team_ar, tk.team_en) },
    { v: tk.requester_name },
    { v: tk.requester_emp_no },
    { v: pick(tk.rdept_ar, tk.rdept_en) },
    { v: [pick(tk.loc_ar, tk.loc_en), tk.location_text].filter(Boolean).join(' - ') },
    { v: tk.asset_tag },
    { v: tk.description },
    { v: tk.status === 'closed' ? t('res.' + tk.resolution) + (tk.close_code ? ' - ' + t('close.' + tk.close_code) : '') : t('tst.' + tk.status) + (tk.late ? ' - ' + t('tcard.late') : ''), s: tk.status === 'closed' ? (tk.resolution === 'unresolved' ? ST.expired : ST.valid) : tk.late ? ST.expired : ST.text },
    { v: tk.assignee_name ? pick(tk.assignee_name, tk.assignee_name_en) : '' },
    { v: local(tk.received_at), s: ST.time },
    { v: local(tk.expected_at), s: ST.time },
    { v: local(tk.closed_at), s: ST.time },
    { v: tk.received_at ? Math.round((Date.parse(tk.received_at) - Date.parse(tk.created_at)) / 60000) : null, s: ST.num },
    { v: tk.closed_at ? Math.round((Date.parse(tk.closed_at) - Date.parse(tk.created_at)) / 360000) / 10 : null, s: ST.num },
    { v: tk.sla_met === null ? '' : t(tk.sla_met ? 'common.yes' : 'common.no'), s: tk.sla_met === false ? ST.expired : tk.sla_met ? ST.valid : ST.num },
    { v: tk.close_note },
    { v: tk.rating, s: ST.num },
  ]);
  downloadXlsx({ fileName: 'requests-report', sheet: t('xls.tk_sheet'), title: t('xls.tk_title'), head, widths: [8, 16, 14, 22, 18, 22, 12, 18, 24, 14, 40, 20, 18, 16, 16, 16, 12, 12, 10, 40, 8], rows: body });
}

/* problem types (super admin) */

export async function categoriesPage(root, _param, alive) {
  let meta;
  try {
    meta = await loadTicketMeta();
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const teams = new Map(meta.teams.map((d) => [d.id, deptName(d)]));
  root.replaceChildren(
    h('p', {}, link('tickets', { class: 'back-link' }, t('tk.back'))),
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('nav.categories')), h('p', { class: 'muted' }, t('cat.sub'))), h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => categoryDialog(null, meta) }, icon('plus'), t('cat.add')))),
    meta.teams.length ? '' : h('p', { class: 'notice notice-warn' }, t('cat.no_teams')),
    h(
      'section',
      { class: 'panel' },
      meta.categories.some((c) => !c.pm)
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['dept.name_ar', 'dept.name_en', 'tk.team', 'tk.priority', 'user.status', 'cat.count', 'common.actions'].map((c) => h('th', { scope: 'col' }, t(c))))),
              h(
                'tbody',
                {},
                meta.categories.filter((c) => !c.pm).map((c) =>
                  h(
                    'tr',
                    {},
                    h('td', { class: 'strong', dir: 'rtl' }, c.name_ar),
                    h('td', { dir: 'ltr' }, c.name_en),
                    h('td', {}, teams.get(c.team_id) || ''),
                    h('td', {}, priorityChip(c.priority)),
                    h('td', {}, c.active ? t('field.active') : h('span', { class: 'muted' }, t('user.inactive'))),
                    h('td', {}, h('span', { class: 'mono' }, String(c.ticket_count))),
                    h(
                      'td',
                      {},
                      h(
                        'div',
                        { class: 'row-actions' },
                        h('button', { type: 'button', class: 'btn btn-icon', title: t('common.edit'), 'aria-label': t('common.edit') + ': ' + pick(c.name_ar, c.name_en), onclick: () => categoryDialog(c, meta) }, icon('edit')),
                        h('button', {
                          type: 'button',
                          class: 'btn btn-icon',
                          title: t('common.delete'),
                          'aria-label': t('common.delete') + ': ' + pick(c.name_ar, c.name_en),
                          onclick: () => simpleDelete(t('cat.delete_q', { name: pick(c.name_ar, c.name_en) }), '/ticket-categories/' + c.id, t('cat.deleted')),
                        }, icon('trash')),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('cat.empty')),
    ),
  );
}
export function categoryDialog(c, meta) {
  if (!meta.teams.length) {
    toast(t('cat.no_teams'), true);
    return;
  }
  const ar = input({ type: 'text', required: true, maxlength: 100, dir: 'rtl', value: c ? c.name_ar : '' });
  const en = input({ type: 'text', required: true, maxlength: 100, dir: 'ltr', value: c ? c.name_en : '' });
  const team = select(meta.teams.map((d) => [d.id, deptName(d)]), c ? c.team_id : meta.teams[0].id, {});
  const prio = select([1, 2, 3, 4].map((n) => [n, 'P' + n + ' ' + t('prio.' + n)]), c ? c.priority : 3, {});
  const active = input({ type: 'checkbox', checked: c ? !!c.active : true });
  openDialog({
    title: t(c ? 'cat.edit' : 'cat.add'),
    body: h('div', { class: 'stack' }, field(t('dept.name_ar'), ar), field(t('dept.name_en'), en), field(t('tk.team'), team, t('cat.team_hint')), field(t('tk.priority'), prio, t('cat.prio_hint')), checkField(t('cat.active'), active)),
    onSubmit: async () => {
      await api(c ? '/ticket-categories/' + c.id : '/ticket-categories', { method: c ? 'PUT' : 'POST', body: { name_ar: ar.value, name_en: en.value, team_id: Number(team.value), priority: Number(prio.value), active: active.checked } });
      toast(t('tk.saved'));
      render();
    },
  });
}
export function simpleDelete(title, path, done, after) {
  openDialog({
    title,
    body: h('div', {}),
    submitLabel: t('common.delete'),
    danger: true,
    onSubmit: async () => {
      await api(path, { method: 'DELETE' });
      toast(done);
      (after || render)();
    },
  });
}

/* places with a QR code (super admin) */

export async function locationsPage(root, _param, alive) {
  let list;
  try {
    const [d, l] = await Promise.all([api('/departments'), api('/locations')]);
    S.departments = d.departments;
    list = l.locations;
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const label = (l) => pick(l.name_ar, l.name_en);
  const active = list.filter((l) => l.active);
  const desk = access('desk') !== 'none';
  root.replaceChildren(
    desk ? h('p', {}, link('tickets', { class: 'back-link' }, t('tk.back'))) : '',
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.locations')), h('p', { class: 'muted' }, t('loc.sub'))),
      h(
        'div',
        { class: 'actions' },
        active.length ? h('button', { type: 'button', class: 'btn', onclick: () => printQr(active.map((l) => ({ url: requestUrl(l.code), title: label(l) }))) }, t('loc.print_all')) : null,
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => locationDialog(null) }, icon('plus'), t('loc.add')),
      ),
    ),
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
              h('thead', {}, h('tr', {}, ['loc.name', 'user.department', 'user.status', ...(desk ? ['cat.count'] : []), 'common.actions'].map((c) => h('th', { scope: 'col' }, t(c))))),
              h(
                'tbody',
                {},
                list.map((l) =>
                  h(
                    'tr',
                    {},
                    h('td', { class: 'strong' }, label(l)),
                    h('td', {}, l.department_id ? deptName(deptById(l.department_id)) : h('span', { class: 'muted' }, t('common.none'))),
                    h('td', {}, l.active ? t('field.active') : h('span', { class: 'muted' }, t('user.inactive'))),
                    desk ? h('td', {}, h('span', { class: 'mono' }, String(l.ticket_count))) : null,
                    h(
                      'td',
                      {},
                      h(
                        'div',
                        { class: 'row-actions' },
                        l.active ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => printQr([{ url: requestUrl(l.code), title: label(l) }]) }, t('qr.print')) : null,
                        h('button', { type: 'button', class: 'btn btn-icon', title: t('common.edit'), 'aria-label': t('common.edit') + ': ' + label(l), onclick: () => locationDialog(l) }, icon('edit')),
                        h('button', { type: 'button', class: 'btn btn-icon', title: t('common.delete'), 'aria-label': t('common.delete') + ': ' + label(l), onclick: () => simpleDelete(t('loc.delete_q', { name: label(l) }), '/locations/' + l.id, t('loc.deleted')) }, icon('trash')),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('loc.empty')),
    ),
  );
}
export function locationDialog(l) {
  const ar = input({ type: 'text', required: true, maxlength: 100, dir: 'rtl', value: l ? l.name_ar : '', placeholder: 'العناية المركزة - غرفة 3' });
  const en = input({ type: 'text', required: true, maxlength: 100, dir: 'ltr', value: l ? l.name_en : '', placeholder: 'ICU - Room 3' });
  const dept = select([['', t('common.none')], ...S.departments.map((d) => [d.id, deptName(d)])], l ? l.department_id : '', {});
  const active = input({ type: 'checkbox', checked: l ? !!l.active : true });
  const renew = input({ type: 'checkbox' });
  openDialog({
    title: t(l ? 'loc.edit' : 'loc.add'),
    body: h('div', { class: 'stack' }, field(t('dept.name_ar'), ar), field(t('dept.name_en'), en), field(t('user.department'), dept, t('loc.dept_hint')), checkField(t('cat.active'), active), l ? checkField(t('loc.renew'), renew) : null, l ? h('p', { class: 'hint' }, t('loc.renew_hint')) : null),
    onSubmit: async () => {
      await api(l ? '/locations/' + l.id : '/locations', { method: l ? 'PUT' : 'POST', body: { name_ar: ar.value, name_en: en.value, department_id: dept.value ? Number(dept.value) : null, active: active.checked, renew_code: renew.checked } });
      toast(t('tk.saved'));
      render();
    },
  });
}

/* staff list (super admin): who may send requests from the public page */

export async function staffPage(root, _param, alive) {
  let list;
  try {
    const [d, s] = await Promise.all([api('/departments'), api('/staff')]);
    S.departments = d.departments;
    list = s.staff;
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const search = input({ type: 'search', class: 'doc-search-input', value: S.staffQ || '', placeholder: t('staff.search_ph'), 'aria-label': t('staff.search'), autocomplete: 'off' });
  const box = h('div', {});
  const draw = () => {
    const q = normText(search.value);
    const rows = list.filter((m) => !q || normText(m.emp_no + ' ' + m.name + ' ' + (m.name_en || '') + ' ' + (m.phone || '') + ' ' + (m.email || '') + ' ' + (m.job_title || '')).includes(q));
    const shown = rows.slice(0, 300);
    box.replaceChildren(
      h(
        'section',
        { class: 'panel' },
        h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', {}, t('nav.staff')), h('span', { class: 'muted small' }, t('staff.count', { n: list.filter((m) => m.active).length, total: list.length })))),
        shown.length
          ? h(
              'div',
              { class: 'table-scroll' },
              h(
                'table',
                {},
                h('thead', {}, h('tr', {}, ['staff.emp_no', 'user.name', 'user.department', 'tk.phone', 'user.email', 'user.status', 'common.actions'].map((c) => h('th', { scope: 'col' }, t(c))))),
                h(
                  'tbody',
                  {},
                  shown.map((m) =>
                    h(
                      'tr',
                      {},
                      h('td', {}, h('span', { class: 'mono', dir: 'ltr' }, m.emp_no)),
                      h('td', {}, h('div', { class: 'strong' }, personName(m)), m.job_title ? h('div', { class: 'small muted' }, m.job_title) : null),
                      h('td', {}, m.department_id ? deptName(deptById(m.department_id)) : h('span', { class: 'muted' }, t('common.none'))),
                      h('td', {}, m.phone ? h('span', { dir: 'ltr' }, m.phone) : h('span', { class: 'muted' }, t('common.none'))),
                      h('td', {}, m.email ? h('bdi', { dir: 'ltr', class: 'small' }, m.email) : h('span', { class: 'muted' }, t('common.none'))),
                      h('td', {}, m.active ? h('span', { class: 'chip chip-valid' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('field.active')) : h('span', { class: 'chip chip-review' }, t('user.inactive'))),
                      h(
                        'td',
                        {},
                        h(
                          'div',
                          { class: 'row-actions' },
                          h('button', { type: 'button', class: 'btn btn-icon', title: t('common.edit'), 'aria-label': t('common.edit') + ': ' + personName(m), onclick: () => staffDialog(m) }, icon('edit')),
                          h('button', { type: 'button', class: 'btn btn-icon', title: t('common.delete'), 'aria-label': t('common.delete') + ': ' + personName(m), onclick: () => simpleDelete(t('staff.delete_q', { name: personName(m) }), '/staff/' + m.id, t('staff.deleted')) }, icon('trash')),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty' }, list.length ? t('staff.no_match') : t('staff.empty')),
        rows.length > shown.length ? h('p', { class: 'muted small panel-foot' }, t('staff.more', { n: rows.length - shown.length })) : null,
      ),
    );
  };
  search.addEventListener('input', () => {
    S.staffQ = search.value;
    draw();
  });
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('nav.staff')), h('p', { class: 'muted' }, t('staff.sub'))),
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', class: 'btn', onclick: staffTemplate }, icon('download'), t('staff.template')),
        h('button', { type: 'button', class: 'btn', onclick: () => importDialog(list) }, icon('file'), t('staff.import')),
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => staffDialog(null) }, icon('plus'), t('staff.add')),
      ),
    ),
    list.some((m) => m.active) ? '' : h('p', { class: 'notice notice-warn' }, t('staff.off')),
    h('div', { class: 'filters' }, h('div', { class: 'doc-search', role: 'search' }, icon('search'), search)),
    box,
  );
  draw();
}
export function staffDialog(m) {
  const no = input({ type: 'text', required: true, maxlength: 30, dir: 'ltr', value: m ? m.emp_no : '' });
  const name = input({ type: 'text', required: true, maxlength: 100, dir: 'rtl', value: m ? m.name : '' });
  const nameEn = input({ type: 'text', required: true, maxlength: 100, dir: 'ltr', value: m ? m.name_en || '' : '' });
  const dept = select([['', t('common.none')], ...S.departments.map((d) => [d.id, deptName(d)])], m ? m.department_id : '', {});
  const phone = input({ type: 'tel', maxlength: 30, dir: 'ltr', value: m ? m.phone || '' : '' });
  const email = input({ type: 'email', maxlength: 160, dir: 'ltr', value: m ? m.email || '' : '' });
  const job = input({ type: 'text', maxlength: 120, value: m ? m.job_title || '' : '' });
  const active = input({ type: 'checkbox', checked: m ? !!m.active : true });
  openDialog({
    title: t(m ? 'staff.edit' : 'staff.add'),
    body: h('div', { class: 'stack' }, field(t('staff.emp_no'), no), field(t('user.name_ar'), name), field(t('user.name_en'), nameEn), field(t('user.department'), dept), field(t('user.job_title'), job), field(t('tk.phone'), phone), field(t('user.email'), email), checkField(t('staff.active'), active)),
    onSubmit: async () => {
      await api(m ? '/staff/' + m.id : '/staff', { method: m ? 'PUT' : 'POST', body: { emp_no: no.value, name: name.value, name_en: nameEn.value, department_id: dept.value ? Number(dept.value) : null, phone: phone.value, email: email.value, job_title: job.value, active: active.checked } });
      toast(t('tk.saved'));
      render();
    },
  });
}
export function staffTemplate() {
  downloadXlsx({
    fileName: 'staff-template',
    sheet: t('nav.staff'),
    title: null,
    head: [t('staff.emp_no'), t('user.name_ar'), t('user.name_en'), t('user.department'), t('tk.phone'), t('user.email'), t('user.job_title')],
    widths: [16, 30, 30, 26, 16, 28, 24],
    rows: [[{ v: '1001' }, { v: t('staff.sample_name') }, { v: t('staff.sample_name_en') }, { v: S.departments[0] ? deptName(S.departments[0]) : '' }, { v: '0500000000' }, { v: 'name@example.com' }, { v: '' }]],
  });
}
