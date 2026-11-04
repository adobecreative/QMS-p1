// Routing, the page frame, sign-in, two-step sign-in and the forgotten-password pages.
import { boot, render } from '../app.js';
import { ApiError, I18N, NO_HREF, S, h, icon, store, t } from './core.js';
import { IDB, OFF, api, checkField, errText, field, input, loading, openDialog, personName, syncQueue, toast } from './offline.js';
import { qrSvg } from './tickets.js';

/* ------------------------------- routing ------------------------------- */

// The route lives in memory and is mirrored to the URL hash when the browser allows it.
export function setUrl(path, push) {
  try {
    history[push ? 'pushState' : 'replaceState'](null, '', path ? '#/' + path : location.pathname + location.search);
  } catch {
    /* embedded viewers may refuse; the in-memory route is enough */
  }
}
export function navigate(path) {
  path = fullPath(path);
  S.route = path;
  setUrl(path, true);
  window.scrollTo(0, 0);
  render();
}
// An in-app link. Navigation is handled here, never left to the browser.
export function link(path, attrs, ...kids) {
  path = fullPath(path);
  const a = h('a', Object.assign(NO_HREF ? { role: 'link', tabindex: '0' } : { href: '#/' + path }, attrs), ...kids);
  a.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; // let "open in new tab" work
    e.preventDefault();
    navigate(path);
  });
  if (NO_HREF) {
    a.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') navigate(path);
    });
  }
  return a;
}

/* ------------------------------- layout -------------------------------- */

// The organisation's own name (from Settings), falling back to the other language, then to the app name.
export const orgName = () => (S.lang === 'en' ? S.brand.name_en || S.brand.name_ar : S.brand.name_ar || S.brand.name_en);
export const brandName = () => orgName() || t('app.name');
// The name in one language whatever the screen's language: for what goes out in both (WhatsApp, print, Excel).
export const orgNameIn = (lang) => (lang === 'en' ? S.brand.name_en || S.brand.name_ar : S.brand.name_ar || S.brand.name_en) || I18N[lang]['app.name'];
// Both names, Arabic first; one when they are the same.
export const orgNames = () => [...new Set([orgNameIn('ar'), orgNameIn('en')])].join(' | ');
// Shown on paper only, above a printed report (the screen's header is not printed): logo and both names.
export function printHead() {
  const names = [...new Set([orgNameIn('ar'), orgNameIn('en')])];
  return h(
    'div',
    { class: 'print-head', 'aria-hidden': 'true' },
    h('img', { src: S.brand.logo || '/fikra-logo.png', alt: '' }),
    h('div', {}, h('div', { class: 'print-org', dir: 'rtl' }, names[0]), names[1] ? h('div', { class: 'print-org-en', dir: 'ltr' }, names[1]) : ''),
  );
}

// Logo + name. "auth" = the larger, centred version on the sign-in page.
export function brand(variant) {
  const org = orgName();
  // The organisation's own logo when it uploaded one, otherwise the AI Fikra logo.
  const mark = h('span', { class: 'brand-logo' + (S.brand.logo ? '' : ' brand-logo-fikra') }, h('img', { src: S.brand.logo || '/fikra-logo.png', alt: S.brand.logo ? brandName() : 'AI Fikra', decoding: 'async' }));
  return h(
    'div',
    { class: 'brand has-logo' + (variant ? ' brand-' + variant : '') },
    mark,
    h('div', { class: 'brand-text' }, h('div', { class: 'brand-name' }, brandName()), h('div', { class: 'brand-tag' }, org ? t('app.name') + ' - ' + t('app.tagline') : t('app.tagline'))),
  );
}

// Browser tab title and icon (also used when the page is added to a phone's home screen).
export function applyBrand() {
  const org = orgName();
  document.title = org ? t('app.name') + ' | ' + org : t('app.name');
  // Without a logo, the home screen keeps the app's own icon (an iPhone needs one to show notifications).
  for (const [rel, plain] of [['icon', null], ['apple-touch-icon', '/apple-touch-icon.png']]) {
    let link = document.head.querySelector('link[rel="' + rel + '"]');
    const href = S.brand.logo || plain;
    if (!href) {
      if (link) link.remove();
      continue;
    }
    if (!link) {
      link = h('link', { rel });
      document.head.append(link);
    }
    link.href = href;
  }
}

// Where staff write for help, when the admin has set it.
export const supportLine = () => (S.brand && S.brand.support ? h('p', { class: 'support-line small muted' }, t('sup.contact') + ' ', h('a', { href: 'mailto:' + S.brand.support, dir: 'ltr' }, S.brand.support)) : '');
export function langToggle() {
  const button = (code, label) =>
    h(
      'button',
      {
        type: 'button',
        class: 'lang-btn',
        'aria-pressed': String(S.lang === code),
        onclick: () => {
          if (S.lang === code) return;
          S.lang = code;
          store.set('fm_lang', code);
          render();
        },
      },
      label,
    );
  return h('div', { class: 'lang', role: 'group', 'aria-label': 'Language' }, button('ar', 'عربي'), button('en', 'English'));
}

/* The portal and its systems. One account opens every system the person has a role in;
   each system has its own menu, and its name is the first part of the address (desk/tickets/5). */
export const APPS = {
  docs: { icon: 'file', pages: (r) => (r === 'admin' ? ['dashboard', 'documents', 'types', 'settings'] : r === 'dept_admin' ? ['dashboard', 'documents'] : r === 'viewer' ? ['documents', 'dashboard'] : []) },
  desk: { icon: 'desk', pages: (r) => (r === 'admin' ? ['tickets', 'categories', 'locations', 'settings'] : r === 'none' ? [] : ['tickets']) },
  assets: { icon: 'box', pages: (r) => (r === 'none' ? [] : ['register', 'pm', 'contracts', 'vendors', 'parts', 'moves', 'requests', 'costs', ...(r === 'viewer' ? [] : ['devtypes'])]) },
  rounds: { icon: 'clipboard', pages: (r) => (r === 'none' ? [] : r === 'inspector' ? ['due', 'rlog', 'scan'] : ['due', 'rlog', 'checklists', 'scan']) },
  reports: { icon: 'chart', pages: (r) => (r === 'admin' ? ['overview', 'compliance'] : []) },
  admin: { icon: 'shield', pages: (r) => (r === 'admin' ? ['users', 'departments', 'staff', ...(S.user.is_owner ? ['api'] : []), 'logs', ...(S.user.is_owner ? ['health'] : []), 'settings'] : []) },
};
export const APP_ORDER = ['docs', 'desk', 'assets', 'rounds', 'reports', 'admin'];
// Both admin roles run the Admin Center; only the super admin changes the user accounts.
export const isAdminRole = (u) => u.role === 'super_admin' || u.role === 'systems_admin';
export const access = (app) => (app === 'admin' || app === 'reports' ? (isAdminRole(S.user) ? 'admin' : 'none') : S.user[app] || 'none');
export const appPages = (app) => APPS[app].pages(access(app));
export const myApps = () => APP_ORDER.filter((a) => appPages(a).length);
// Pages opened from inside another page, not shown in the menu.
export const HIDDEN_ROUTES = { categories: 'tickets', locations: 'tickets', scan: 'due', vendors: 'contracts', moves: 'parts', requests: 'parts' };
// Addresses from before the portal (bookmarks, links in emails) still open their page.
export const PAGE_APP = { dashboard: 'docs', documents: 'docs', types: 'docs', tickets: 'desk', categories: 'desk', locations: 'desk', users: 'admin', departments: 'admin', staff: 'admin', api: 'admin', logs: 'admin', health: 'admin', register: 'assets', pm: 'assets', devtypes: 'assets', contracts: 'assets', vendors: 'assets', parts: 'assets', moves: 'assets', requests: 'assets', costs: 'assets', due: 'rounds', rlog: 'rounds', checklists: 'rounds', scan: 'rounds', overview: 'reports', compliance: 'reports' };
// A link written as a page name ("tickets/5") goes to that page in the system it belongs to.
export function fullPath(path) {
  const first = path.split('/')[0];
  if (!first || APPS[first] || !S.user) return path;
  const here = currentApp();
  if (here && appPages(here).includes(first)) return here + '/' + path;
  return PAGE_APP[first] ? PAGE_APP[first] + '/' + path : path;
}
export function currentApp() {
  const first = S.route.split('/')[0];
  return APPS[first] ? first : PAGE_APP[first] || null;
}
// [system, page, param]; no system = the portal.
export function currentRoute() {
  let parts = S.route.split('/');
  if (!APPS[parts[0]]) parts = PAGE_APP[parts[0]] ? [PAGE_APP[parts[0]], ...parts] : [''];
  const [app, page, param] = parts;
  if (!app) return ['', '', ''];
  const pages = appPages(app);
  if (!pages.length) return ['', '', ''];
  return [app, pages.includes(page) ? page : pages[0], pages.includes(page) ? param || '' : ''];
}

// Under the name: what the person is in the system open now.
export function roleLabel(app) {
  if (isAdminRole(S.user)) return t('role.' + S.user.role);
  if (app === 'docs' || app === 'desk' || app === 'assets' || app === 'rounds') return t(app + 'role.' + access(app));
  return '';
}

export function header(app, active) {
  const nav = app
    ? h(
        'nav',
        { class: 'nav wrap', 'aria-label': t('nav.label') },
        appPages(app)
          .filter((n) => !HIDDEN_ROUTES[n])
          .map((n) =>
            link(
              app + '/' + n,
              { class: 'nav-link', 'data-nav': n, 'aria-current': n === active || HIDDEN_ROUTES[active] === n ? 'page' : null },
              t(n === 'settings' ? 'nav.settings' : 'nav.' + n),
              n === 'tickets' ? h('span', { class: 'badge', hidden: true }) : null,
            ),
          ),
      )
    : null;
  // On a narrow screen the menu scrolls sideways: keep the open page's link in view.
  if (nav)
    requestAnimationFrame(() => {
      const on = nav.querySelector('[aria-current="page"]');
      if (on && nav.scrollWidth > nav.clientWidth) nav.scrollLeft += on.getBoundingClientRect().left - nav.getBoundingClientRect().left - (nav.clientWidth - on.offsetWidth) / 2;
    });
  const home = link('', { class: 'app-switch', 'aria-label': t('portal.title'), title: t('portal.title') }, icon('grid', 20), app ? h('span', { class: 'app-name' }, t('app.' + app)) : null);
  const userBtn = h(
    'button',
    { type: 'button', class: 'user-btn', 'aria-label': personName(S.user), onclick: accountDialog },
    icon('user', 20),
    h('span', { class: 'user-text' }, h('span', { class: 'user-name' }, personName(S.user)), h('span', { class: 'user-role' }, roleLabel(app))),
  );
  return h('header', { class: 'top' }, h('div', { class: 'top-row wrap' }, h('div', { class: 'top-start' }, brand(), home), h('div', { class: 'top-tools' }, langToggle(), userBtn)), nav);
}

// Notifications on this device (see sw.js). An iPhone or iPad shows them only for a site added to the home screen.
export const PUSH_OK = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const pushFor = (u) => isAdminRole(u) || u.desk === 'supervisor' || u.desk === 'technician';
export const keyBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
export async function pushSub() {
  if (!PUSH_OK) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
export async function pushOn() {
  if (IOS && !standalone()) return toast(t('push.ios_home'), true);
  if (!PUSH_OK) return toast(t('push.unsupported'), true);
  // Asked first, while the tap still counts as the person's own action.
  if ((await Notification.requestPermission()) !== 'granted') return toast(t('push.denied'), true);
  const { key } = await api('/me/push/key');
  const reg = await navigator.serviceWorker.ready;
  let sub;
  try {
    sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
  } catch {
    throw new ApiError('bad_subscription');
  }
  const j = sub.toJSON();
  await api('/me/push', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys, lang: S.lang } });
  toast(t('push.on'));
  api('/me/push/test', { method: 'POST' }).catch(() => {});
  return true;
}
export async function pushOff() {
  const sub = await pushSub();
  if (!sub) return;
  await api('/me/push', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
if (PUSH_OK) navigator.serviceWorker.addEventListener('message', (e) => {
  if (e.data && typeof e.data.open === 'string' && e.data.open.startsWith('#/')) location.hash = e.data.open;
});

export function accountDialog() {
  const current = input({ type: 'password', required: true, autocomplete: 'current-password' });
  const next = input({ type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
  const dlg = openDialog({
    title: personName(S.user),
    body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, S.user.email), field(t('acc.current'), current), field(t('acc.new'), next, t('user.password_hint')), supportLine()),
    submitLabel: t('acc.change'),
    onSubmit: async () => {
      await api('/me/password', { method: 'POST', body: { current: current.value, password: next.value } });
      toast(t('acc.changed'));
    },
  });
  const logout = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-end',
      onclick: async () => {
        // Waiting entries go out under this person's sign-in, so they must leave first.
        await syncQueue();
        if (OFF.pending) return toast(t('off.logout_wait'), true);
        // The next person on this device must not get this person's alerts.
        await pushOff().catch(() => {});
        try {
          await api('/logout', { method: 'POST' });
        } catch {
          /* signing out locally anyway */
        }
        IDB.clear();
        store.set('fm_off_uid', '');
        S.user = null;
        S.route = ''; // the next person starts on their own first page
        setUrl('', false);
        dlg.close();
        render();
      },
    },
    icon('logout'),
    t('acc.logout'),
  );
  const tfa = h(
    'button',
    {
      type: 'button',
      class: 'btn',
      onclick: () => {
        dlg.close();
        twoFactorDialog();
      },
    },
    icon('shield'),
    t(S.user.totp_on ? 'tfa.manage' : 'tfa.turn_on'),
  );
  const push = h('button', { type: 'button', class: 'btn', hidden: !pushFor(S.user) }, icon('bell'), t('push.turn_on'));
  let pushIsOn = false;
  const showPush = (on) => {
    pushIsOn = on;
    push.lastChild.textContent = t(on ? 'push.turn_off' : 'push.turn_on');
  };
  pushSub().then((sub) => showPush(!!sub), () => {});
  push.addEventListener('click', async () => {
    push.disabled = true;
    try {
      if (pushIsOn) {
        await pushOff();
        toast(t('push.off'));
        showPush(false);
      } else if (await pushOn()) showPush(true);
    } catch (e) {
      toast(errText(e), true);
    } finally {
      push.disabled = false;
    }
  });
  dlg.querySelector('.dialog-actions').append(push, tfa, logout);
}

export function authPage(isSetup) {
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const name = input({ type: 'text', required: true, maxlength: 100, dir: 'rtl', autocomplete: 'name' });
  const nameEn = input({ type: 'text', required: true, maxlength: 100, dir: 'ltr' });
  const email = input({ type: 'email', required: true, autocomplete: 'username', dir: 'ltr' });
  const password = input({ type: 'password', required: true, minlength: isSetup ? 8 : null, autocomplete: isSetup ? 'new-password' : 'current-password', dir: 'ltr' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, t(isSetup ? 'setup.submit' : 'login.submit'));
  const form = h(
    'form',
    { class: 'stack' },
    isSetup ? field(t('user.name_ar'), name) : null,
    isSetup ? field(t('user.name_en'), nameEn) : null,
    field(t('user.email'), email),
    field(t('user.password'), password, isSetup ? t('user.password_hint') : null),
    err,
    submit,
    isSetup ? null : h('p', { class: 'auth-link' }, link('forgot', {}, t('reset.forgot'))),
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    submit.disabled = true;
    try {
      const body = { email: email.value, password: password.value };
      if (isSetup) Object.assign(body, { name: name.value, name_en: nameEn.value });
      const r = await api(isSetup ? '/setup' : '/login', { method: 'POST', body });
      if (r.need_code) return loginCodeStep(form.closest('.auth-card'), r.ticket);
      await boot();
    } catch (e) {
      err.textContent = errText(e);
      err.hidden = false;
      submit.disabled = false;
    }
  });
  return h(
    'div',
    { class: 'auth' },
    h('div', { class: 'auth-card' }, h('div', { class: 'auth-brand' }, brand('auth')), h('h1', {}, t(isSetup ? 'setup.title' : 'login.title')), isSetup ? h('p', { class: 'muted' }, t('setup.intro')) : null, form, langToggle(), supportLine()),
  );
}

/* --------------------------- two-step sign-in -------------------------- */

export const codeInput = () => input({ type: 'text', required: true, inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 12, dir: 'ltr', class: 'code-input' });
export const formError = () => h('p', { class: 'form-error', role: 'alert', hidden: true });
// A small form that runs one step and shows its error in place.
export function stepForm(kids, label, run) {
  const err = formError();
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, label);
  const form = h('form', { class: 'stack' }, ...kids, err, submit);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    submit.disabled = true;
    try {
      await run();
    } catch (e) {
      err.textContent = errText(e);
      err.hidden = false;
      submit.disabled = false;
    }
  });
  return form;
}

// The second page of signing in: a code from the app, or one of the recovery codes.
export function loginCodeStep(card, ticket) {
  const code = codeInput();
  const form = stepForm([h('p', { class: 'muted' }, t('tfa.login_intro')), field(t('tfa.code'), code, t('tfa.login_hint'))], t('tfa.verify'), async () => {
    try {
      const r = await api('/login/2fa', { method: 'POST', body: { ticket, code: code.value } });
      await boot();
      if (r.recovery_left !== null && r.recovery_left !== undefined) toast(t('tfa.recovery_used', { n: r.recovery_left }), r.recovery_left <= 2);
    } catch (e) {
      if (e.code === 'login_expired' || e.code === 'account_locked') {
        toast(errText(e), true);
        render();
        return;
      }
      throw e;
    }
  });
  form.append(h('p', { class: 'auth-link' }, h('button', { type: 'button', class: 'btn-link', onclick: render }, t('reset.back'))));
  card.querySelector('h1').textContent = t('tfa.title');
  card.querySelector('form').replaceWith(form);
  code.focus();
}

// The recovery codes, shown once: copy, download, and a tick to say they were kept.
export function recoveryCodesView(codes, onDone) {
  const text = codes.join('\n');
  const kept = input({ type: 'checkbox' });
  const done = h('button', { type: 'button', class: 'btn btn-primary btn-block', disabled: true, onclick: onDone }, t('tfa.done'));
  kept.addEventListener('change', () => (done.disabled = !kept.checked));
  const copy = h('button', { type: 'button', class: 'btn', onclick: async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast(t('tfa.copied'));
    } catch {
      toast(t('tfa.copy_failed'), true);
    }
  } }, t('tfa.copy'));
  const save = h('button', { type: 'button', class: 'btn', onclick: () => {
    const a = h('a', { href: URL.createObjectURL(new Blob([brandName() + '\n' + S.user.email + '\n\n' + text + '\n'], { type: 'text/plain' })), download: 'recovery-codes.txt' });
    document.body.append(a);
    a.click();
    a.remove();
  } }, icon('download'), t('tfa.download'));
  return h(
    'div',
    { class: 'stack' },
    h('p', { class: 'notice notice-warn' }, t('tfa.codes_intro')),
    h('ol', { class: 'tfa-codes', dir: 'ltr' }, codes.map((c) => h('li', {}, h('code', {}, c)))),
    h('div', { class: 'actions' }, copy, save),
    checkField(t('tfa.kept'), kept),
    done,
  );
}

export const PHONE = window.matchMedia('(pointer: coarse)').matches;
// Setting it up: the password, then the app's QR code and a first code, then the recovery codes.
export function twoFactorSetup(box, onDone) {
  const password = input({ type: 'password', required: true, autocomplete: 'current-password', dir: 'ltr' });
  box.replaceChildren(
    stepForm([h('p', { class: 'muted' }, t('tfa.setup_intro')), field(t('acc.current'), password)], t('tfa.next'), async () => {
      const r = await api('/me/2fa/setup', { method: 'POST', body: { password: password.value } });
      const qr = h('div', { class: 'tfa-qr' });
      qrSvg(r.uri, 200).then((svg) => qr.replaceChildren(svg)).catch(() => qr.replaceChildren(h('p', { class: 'muted small' }, t('tfa.qr_failed'))));
      const code = codeInput();
      box.replaceChildren(
        stepForm(
          [
            h('ol', { class: 'tfa-steps' }, h('li', {}, t('tfa.step_app')), h('li', {}, t('tfa.step_scan')), h('li', {}, t('tfa.step_code'))),
            // On the phone that will hold the app, the code cannot be scanned: one tap hands it to the app instead.
            PHONE ? h('a', { class: 'btn btn-primary btn-block', href: r.uri }, icon('shield'), t('tfa.open_app')) : null,
            qr,
            h(
              'div',
              { class: 'field' },
              h('span', { class: 'label' }, t('tfa.secret')),
              h(
                'div',
                { class: 'tfa-secret-row' },
                h('code', { class: 'tfa-secret', dir: 'ltr' }, r.secret.match(/.{1,4}/g).join(' ')),
                h('button', { type: 'button', class: 'btn btn-small', onclick: async () => {
                  try {
                    await navigator.clipboard.writeText(r.secret);
                    toast(t('tfa.key_copied'));
                  } catch {
                    toast(t('tfa.key_copy_failed'), true);
                  }
                } }, t('tfa.copy')),
              ),
            ),
            field(t('tfa.code'), code),
          ],
          t('tfa.enable'),
          async () => {
            const res = await api('/me/2fa/enable', { method: 'POST', body: { code: code.value } });
            S.user.totp_on = true;
            box.replaceChildren(recoveryCodesView(res.codes, onDone));
          },
        ),
      );
      code.focus();
    }),
  );
  password.focus();
}

// A plain dialog for flows with more than one step; it has only a close button.
export function flowDialog(title) {
  const box = h('div', { class: 'stack' });
  const dlg = h('dialog', { class: 'dialog' }, h('div', { class: 'dialog-flow' }, h('h2', { class: 'dialog-title' }, title), box, h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, t('tfa.close')))));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, box };
}

export async function twoFactorDialog() {
  const { dlg, box } = flowDialog(t('tfa.title'));
  box.append(loading());
  let st;
  try {
    st = await api('/me/2fa');
  } catch (e) {
    box.replaceChildren(h('p', { class: 'form-error' }, errText(e)));
    return;
  }
  if (!st.on) return twoFactorSetup(box, () => dlg.close());
  // Making new codes or turning it off needs the password and a current code.
  const confirmStep = (label, path, after) => {
    const password = input({ type: 'password', required: true, autocomplete: 'current-password', dir: 'ltr' });
    const code = codeInput();
    box.replaceChildren(stepForm([field(t('acc.current'), password), field(t('tfa.code'), code, t('tfa.app_only'))], label, async () => after(await api(path, { method: 'POST', body: { password: password.value, code: code.value } }))));
    password.focus();
  };
  box.replaceChildren(
    h('p', { class: 'chip chip-valid' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('tfa.on')),
    h('p', { class: st.recovery_left <= 2 ? 'notice notice-warn' : 'muted' }, t('tfa.left', { n: st.recovery_left })),
    st.required ? h('p', { class: 'hint' }, t('tfa.required_note')) : '', // replaceChildren would print null
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => confirmStep(t('tfa.new_codes'), '/me/2fa/recovery', (r) => box.replaceChildren(recoveryCodesView(r.codes, () => dlg.close()))) }, t('tfa.new_codes')),
      st.required
        ? null
        : h('button', { type: 'button', class: 'btn btn-danger', onclick: () => confirmStep(t('tfa.disable'), '/me/2fa/disable', () => {
            S.user.totp_on = false;
            toast(t('tfa.disabled'));
            dlg.close();
          }) }, t('tfa.disable')),
    ),
  );
}

// Required for this account and not set up yet: nothing else opens until it is.
export function twoFactorRequiredPage() {
  const box = h('div', { class: 'stack' });
  twoFactorSetup(box, async () => {
    toast(t('tfa.enabled'));
    await boot();
  });
  const out = h('button', { type: 'button', class: 'btn-link', onclick: async () => {
    try {
      await api('/logout', { method: 'POST' });
    } catch {
      /* signing out locally anyway */
    }
    S.user = null;
    render();
  } }, t('acc.logout'));
  return authShell(t('tfa.required_title'), h('p', { class: 'muted' }, t('tfa.required_intro')), box, h('p', { class: 'auth-link' }, out));
}

/* --------------------------- forgot password --------------------------- */

export const authShell = (title, ...body) =>
  h('div', { class: 'auth' }, h('div', { class: 'auth-card' }, h('div', { class: 'auth-brand' }, brand('auth')), h('h1', {}, title), ...body, langToggle(), supportLine()));
export const backToLogin = () => h('p', { class: 'auth-link' }, link('', {}, t('reset.back')));

export function forgotPage() {
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const email = input({ type: 'email', required: true, autocomplete: 'username', dir: 'ltr' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, t('reset.send'));
  const form = h('form', { class: 'stack' }, h('p', { class: 'muted' }, t('reset.intro')), field(t('user.email'), email), err, submit, backToLogin());
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    submit.disabled = true;
    try {
      await api('/password/forgot', { method: 'POST', body: { email: email.value, lang: S.lang } });
      // Same answer whether or not the email is registered.
      form.replaceChildren(h('p', { class: 'notice' }, t('reset.sent')), h('p', { class: 'muted small' }, t('reset.sent_hint')), backToLogin());
    } catch (e) {
      err.textContent = errText(e);
      err.hidden = false;
      submit.disabled = false;
    }
  });
  return authShell(t('reset.title'), form);
}

export function resetPage(token) {
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const pass = input({ type: 'password', required: true, minlength: 8, autocomplete: 'new-password', dir: 'ltr' });
  const again = input({ type: 'password', required: true, minlength: 8, autocomplete: 'new-password', dir: 'ltr' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, t('reset.save'));
  const form = h('form', { class: 'stack' }, field(t('acc.new'), pass, t('user.password_hint')), field(t('reset.again'), again), err, submit, backToLogin());
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    if (pass.value !== again.value) {
      err.textContent = t('reset.mismatch');
      err.hidden = false;
      return;
    }
    submit.disabled = true;
    try {
      await api('/password/reset', { method: 'POST', body: { token, password: pass.value } });
      S.resetToken = '';
      S.user = null; // every session of that account was just closed
      form.replaceChildren(h('p', { class: 'notice' }, t('reset.done')), h('p', { class: 'auth-link' }, link('', { class: 'btn btn-primary btn-block' }, t('login.submit'))));
    } catch (e) {
      err.textContent = errText(e);
      err.hidden = false;
      submit.disabled = false;
    }
  });
  return authShell(t('reset.new_title'), form);
}
