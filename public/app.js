import { LOCKED, licenseBar, licenseLockPage, logsPage, settingsPage, usersPage } from './js/admin.js';
import { apiPage } from './js/api.js';
import { registerPage } from './js/assets.js';
import { contractsPage, vendorsPage } from './js/contracts.js';
import { $app, I18N, S, h, icon, store, t } from './js/core.js';
import { healthPage } from './js/health.js';
import { dashboardPage, departmentsPage, documentsPage, typesPage } from './js/docs.js';
import { costsPage, devTypesPage, movesPage, partsPage, pmPage, requestsPage } from './js/inventory.js';
import { APPS, access, appPages, applyBrand, authPage, currentRoute, forgotPage, header, link, loginCodeStep, myApps, resetPage, roleLabel, setUrl, twoFactorRequiredPage } from './js/layout.js';
import { IDB, OFF, api, drawOffBar, errText, loading, personName, syncQueue, toast, warmPages } from './js/offline.js';
import { attendancePage, calendarPage, checkinPage, committeesPage } from './js/meetings.js';
import { assessPage, chaptersPage, portalDocsPage, standardsPage } from './js/quality.js';
import { capaPage } from './js/capa.js';
import { incidentPage, ovrCatsPage, ovrListPage, ovrNewPage, ovrTrackPage } from './js/ovr.js';
import { kpisPage, readinessPage } from './js/kpis.js';
import { compliancePage, reportsPage } from './js/reports.js';
import { checklistsPage, duePage, roundLogPage, roundScanPage } from './js/rounds.js';
import { categoriesPage, locationsPage, refreshBadge, requestPage, staffPage, ticketsPage, trackPage } from './js/tickets.js';

let renderSeq = 0;
/* -------------------------------- portal -------------------------------- */

// The first page after signing in: a greeting with today's date, the systems this person can open
// (each with its own few numbers, only from what they may see) and the meetings coming up.
const HOME_STATS = {
  ovr: (d) => d.ovr && (d.ovr.open !== undefined ? [[d.ovr.new, 'home.ovr_new'], [d.ovr.open, 'home.ovr_open'], [d.ovr.late, 'home.ovr_late', true]] : [[d.ovr.tasks, 'home.ovr_tasks'], [d.ovr.late, 'home.ovr_late', true], [d.ovr.mine, 'home.ovr_mine']]),
  meetings: (d) => d.meetings && [[d.meetings.today, 'home.meetings_today'], [d.meetings.upcoming, 'home.meetings_upcoming'], [d.meetings.late, 'home.meetings_late', true]],
  quality: (d) => d.quality && [[d.quality.pct === null ? '-' : d.quality.pct + '%', 'home.quality_pct'], [d.quality.esr_gap, 'home.quality_esr', true], [d.quality.capa_open, 'home.capa_open', d.quality.capa_late > 0]],
  desk: (d) => d.desk && [[d.desk.new, 'home.desk_new'], [d.desk.doing, 'home.desk_doing'], [d.desk.late, 'home.desk_late', true]],
  assets: (d) => d.assets && [[d.assets.total, 'home.assets_total'], [d.assets.pm_week, 'home.assets_pm'], [d.assets.down, 'home.assets_down', true]],
  rounds: (d) => d.rounds && [[d.rounds.due, 'home.rounds_due'], [d.rounds.late, 'home.rounds_late', true], [d.rounds.done, 'home.rounds_done']],
  docs: (d) => d.docs && [[d.docs.total, 'home.docs_total'], [d.docs.near, 'home.docs_near'], [d.docs.expired, 'home.docs_expired', true]],
  admin: (d) => d.admin && [[d.admin.users, 'home.admin_users'], [d.admin.departments, 'home.admin_departments']],
};
const otherLang = (key) => I18N[S.lang === 'ar' ? 'en' : 'ar'][key] || '';

function portalPage(root, alive) {
  const apps = myApps();
  const now = new Date();
  const name = personName(S.user).split(' ')[0];
  const date = new Intl.DateTimeFormat(S.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now);
  const canRequest = access('desk') !== 'none';
  const head = h(
    'div',
    { class: 'page-head' },
    h('div', {}, h('h1', {}, t(now.getHours() < 12 ? 'home.morning' : 'home.evening', { name })), h('p', { class: 'muted' }, t('home.sub', { date }))),
    canRequest ? h('div', { class: 'actions' }, link('request', { class: 'btn btn-primary' }, icon('plus'), t('req.new'))) : null,
  );
  const statsBox = (app) => h('div', { class: 'app-stats', hidden: true });
  const cards = apps.map((app) => {
    const box = statsBox(app);
    const el = link(
      app + '/' + appPages(app)[0],
      { class: 'app-card app-' + app },
      h('span', { class: 'app-icon' }, icon(APPS[app].icon, 26)),
      h('span', { class: 'app-title' }, t('app.' + app)),
      h('span', { class: 'app-sub', lang: S.lang === 'ar' ? 'en' : 'ar' }, otherLang('app.' + app)),
      h('span', { class: 'app-desc' }, t('app.' + app + '_desc')),
      box,
    );
    return { app, el, box };
  });
  const side = h('div', { class: 'home-side' });
  if (!alive()) return;
  root.replaceChildren(
    head,
    apps.length ? h('section', { class: 'apps', 'aria-label': t('portal.title') }, cards.map((c) => c.el)) : h('p', { class: 'panel empty' }, t('portal.none')),
    side,
  );
  api('/home')
    .then((d) => {
      if (!alive()) return;
      for (const c of cards) {
        const stats = HOME_STATS[c.app] && HOME_STATS[c.app](d);
        if (!stats) continue;
        c.box.replaceChildren(...stats.map(([n, key, alert]) => h('span', { class: 'app-stat' + (alert && n ? ' is-alert' : '') }, h('b', {}, String(n ?? 0)), h('span', {}, t(key)))));
        c.box.hidden = false;
        c.el.classList.add('has-stats');
      }
      const panels = [];
      if (d.meetings) {
        const when = new Intl.DateTimeFormat(S.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        const en = S.lang === 'en';
        panels.push(
          h(
            'section',
            { class: 'panel home-recent' },
            h('h2', {}, t('home.next_meetings')),
            d.meetings.next.length
              ? h(
                  'ul',
                  { class: 'home-list' },
                  d.meetings.next.map((m) =>
                    h(
                      'li',
                      {},
                      link('meetings/committees/' + m.committee_id, { class: 'home-item' },
                        h('span', { class: 'home-item-text' }, h('b', {}, en ? m.name_en : m.name_ar), h('small', { class: 'muted' }, [m.code, m.venue].filter(Boolean).join(' · '))),
                        h('span', { class: 'home-pill' + (m.date === d.today ? ' is-new' : '') }, when.format(new Date(m.date + 'T00:00:00')) + ' · ' + m.start_time),
                      ),
                    ),
                  ),
                )
              : h('p', { class: 'muted' }, t('home.next_none')),
          ),
        );
      }
      side.replaceChildren(...panels);
      side.classList.toggle('one', panels.length === 1);
    })
    .catch(() => {});
}

/* --------------------------------- start -------------------------------- */

const PAGES = { dashboard: dashboardPage, tickets: ticketsPage, categories: categoriesPage, locations: locationsPage, staff: staffPage, api: apiPage, documents: documentsPage, departments: departmentsPage, types: typesPage, users: usersPage, logs: logsPage, health: healthPage, settings: settingsPage, register: registerPage, pm: pmPage, devtypes: devTypesPage, contracts: contractsPage, vendors: vendorsPage, parts: partsPage, moves: movesPage, requests: requestsPage, costs: costsPage, due: duePage, rlog: roundLogPage, checklists: checklistsPage, scan: roundScanPage, overview: reportsPage, compliance: compliancePage, chapters: chaptersPage, standards: standardsPage, assess: assessPage, committees: committeesPage, calendar: calendarPage, attendance: attendancePage, pdocs: portalDocsPage, capa: capaPage, ovrs: ovrListPage, ovrnew: ovrNewPage, ovrcats: ovrCatsPage, kpis: kpisPage, readiness: readinessPage };

export function render() {
  const seq = ++renderSeq;
  document.documentElement.lang = S.lang;
  document.documentElement.dir = S.lang === 'ar' ? 'rtl' : 'ltr';
  applyBrand();
  document.body.classList.remove('no-scroll');
  // A reset link works even in a browser where someone is already signed in.
  // Its token is taken out of the address bar at once, so it is not left in history.
  const m = /^reset\/([0-9a-f]{64})$/.exec(S.route);
  if (m) {
    S.resetToken = m[1];
    S.route = 'reset';
    setUrl('reset', false);
  }
  // Arriving from the Fikra portal with a one-minute sign-in token: taken out of the address bar at once.
  const so = /^sso\/([A-Za-z0-9_.-]{20,900})$/.exec(S.route);
  if (so) {
    S.route = '';
    setUrl('', false);
    portalSignIn(so[1]);
    return;
  }
  if (!S.needsSetup && S.route === 'reset' && S.resetToken) {
    $app.replaceChildren(resetPage(S.resetToken));
    return;
  }
  // A member checking in to a committee session (their emailed link or the session's QR code): no account needed.
  const ck = /^checkin\/(\d+\.(?:q|\d+)\.[0-9a-f]{24})$/.exec(S.route);
  if (ck) {
    $app.replaceChildren(h('div', { class: 'auth public' }, loading()));
    checkinPage(ck[1]).then((page) => {
      if (seq === renderSeq) $app.replaceChildren(page);
    });
    return;
  }
  // Incident reports from a place's QR code (signed in or with an employee number), and their tracking link.
  const ot = /^ovr-track\/(\d+)\/([0-9a-f]{32})$/.exec(S.route);
  if (ot || S.route === 'incident' || (location.pathname === '/incident' && !S.route)) {
    $app.replaceChildren(h('div', { class: 'auth public' }, loading()));
    (ot ? ovrTrackPage(Number(ot[1]), ot[2]) : incidentPage()).then((page) => {
      if (seq === renderSeq) $app.replaceChildren(page);
    });
    return;
  }
  // The employees' request and tracking pages: no account needed.
  const tr = /^track\/(\d+)\/([0-9a-f]{32})$/.exec(S.route);
  if (tr || S.route === 'request' || (location.pathname === '/request' && !S.route)) {
    $app.replaceChildren(h('div', { class: 'auth public' }, loading()));
    (tr ? trackPage(Number(tr[1]), tr[2]) : requestPage()).then((page) => {
      if (seq === renderSeq) $app.replaceChildren(page);
    });
    return;
  }
  if (S.license && LOCKED.includes(S.license.state)) {
    $app.replaceChildren(licenseLockPage());
    return;
  }
  if (S.needsSetup || !S.user) {
    let page;
    if (S.needsSetup) page = authPage(true);
    else if (S.route === 'forgot') page = forgotPage();
    else page = authPage(false);
    $app.replaceChildren(page);
    return;
  }
  if (S.user.must_2fa) {
    $app.replaceChildren(twoFactorRequiredPage());
    return;
  }
  const [app, name, param] = currentRoute();
  const main = h('main', { class: 'wrap main', id: 'main' }, loading());
  $app.replaceChildren(header(app, name), licenseBar(), main);
  const alive = () => seq === renderSeq;
  if (!app) return portalPage(main, alive);
  if (app === 'desk') refreshBadge();
  (name === 'settings' ? settingsPage : PAGES[name])(main, param, alive, app);
}

async function portalSignIn(token) {
  $app.replaceChildren(h('div', { class: 'auth' }, loading()));
  try {
    const r = await api('/sso', { method: 'POST', body: { token } });
    if (r.need_code) {
      S.user = null;
      $app.replaceChildren(authPage(false));
      loginCodeStep($app.querySelector('.auth-card'), r.ticket);
      return;
    }
    await boot();
  } catch (e) {
    toast(errText(e), true);
    render();
  }
}

export async function boot() {
  try {
    const b = await api('/bootstrap');
    // A device another person used: their saved pages are not for this one.
    const who = b.user ? String(b.user.id) : '';
    if (who && store.get('fm_off_uid', '') !== who) {
      if (store.get('fm_off_uid', '')) await IDB.clear();
      store.set('fm_off_uid', who);
    }
    S.user = b.user;
    S.needsSetup = b.needsSetup;
    S.defaults = b.defaults;
    if (b.brand) S.brand = b.brand;
    S.license = b.license || null;
    S.portalUrl = b.portal_url || '';
    S.today = b.today;
  } catch (e) {
    $app.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'auth-card' }, h('p', { class: 'form-error' }, errText(e)), h('button', { type: 'button', class: 'btn', onclick: boot }, t('common.retry')))));
    return;
  }
  render();
  OFF.pending = (await IDB.all()).length;
  drawOffBar();
  if (OFF.pending) syncQueue();
  else if (S.user) warmPages();
}

// Back/forward buttons and hand-edited addresses.
const onUrlChange = () => {
  const path = location.hash.replace(/^#\/?/, '');
  if (path === S.route) return;
  S.route = path;
  render();
};
window.addEventListener('hashchange', onUrlChange);
window.addEventListener('popstate', onUrlChange);
if ('serviceWorker' in navigator && !window.__NO_HREF) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
