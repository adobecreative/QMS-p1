// The owner's health page: use of the site, failures, and the free-plan limits, on one page.
import { fmtSize, logDetails } from './admin.js';
import { S, h, has, t } from './core.js';
import { api, errorBox, fmtDate } from './offline.js';

export async function healthPage(root, _param, alive) {
  let d;
  try {
    d = await api('/health');
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const fmt = new Intl.DateTimeFormat(S.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const card = (label, value, hint, warn) =>
    h(
      'div',
      { class: 'kpi rep-kpi' + (warn ? ' kpi-expired' : '') },
      h('span', { class: 'kpi-num', dir: 'ltr' }, String(value)),
      h('span', { class: 'kpi-label' }, t(label)),
      hint ? h('span', { class: 'rep-prev' }, hint) : '',
    );
  const cards = (list) => h('div', { class: 'panel kpis rep-kpis' }, list);
  const section = (title, ...kids) => h('section', { class: 'rep-section' }, h('h2', {}, t(title)), ...kids);
  // The last 14 days as columns, days without any included.
  const days = [];
  for (let i = 0, t0 = Date.parse(d.from + 'T00:00:00Z'); i < 14; i++) days.push(new Date(t0 + i * 86400000).toISOString().slice(0, 10));
  const columns = (title, rows) => {
    const by = new Map(rows.map((x) => [x.d, x.n]));
    const max = Math.max(1, ...days.map((x) => by.get(x) || 0));
    return h(
      'div',
      { class: 'panel rep-trend' },
      h('h3', {}, t(title)),
      h(
        'div',
        { class: 'rep-columns rep-days', role: 'list' },
        days.map((x) => {
          const n = by.get(x) || 0;
          return h(
            'div',
            { class: 'rep-col' + (x === d.today ? ' rep-col-now' : ''), role: 'listitem', 'aria-label': fmtDate(x) + ': ' + n },
            h('span', { class: 'mono small', dir: 'ltr' }, String(n)),
            h('span', { class: 'rep-col-bar', style: `height:${n ? Math.max(4, Math.round((n / max) * 120)) : 2}px` }),
            h('span', { class: 'small muted', dir: 'ltr' }, x.slice(8, 10) + '/' + x.slice(5, 7)),
          );
        }),
      ),
    );
  };
  const aiPct = d.ai.limit ? Math.round((d.ai.today / d.ai.limit) * 100) : 0;
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('nav.health')), h('p', { class: 'muted' }, t('hl.sub')))),
    section(
      'hl.use',
      cards([
        card('hl.users_active', d.users.active, t('hl.of_total', { n: d.users.total })),
        card('hl.seen_7', d.users.seen_7),
        card('hl.seen_30', d.users.seen_30),
        card('hl.tickets_30', d.usage_30.tickets),
        card('hl.rounds_30', d.usage_30.rounds),
        card('hl.moves_30', d.usage_30.moves),
        card('hl.files_30', d.usage_30.files),
        card('hl.push', d.push_devices),
      ]),
      columns('hl.logins_days', d.logins),
      columns('hl.activity_days', d.activity),
    ),
    section(
      'hl.problems',
      cards([
        card('hl.errors_7', d.errors_7, '', d.errors_7 > 0),
        card('hl.failed_logins', d.failed_logins, '', d.failed_logins >= 20),
        card('hl.locked', d.locked, '', d.locked > 0),
      ]),
      h(
        'div',
        { class: 'panel' },
        h('h3', { class: 'rep-h3' }, t('hl.errors')),
        d.errors.length
          ? h(
              'div',
              { class: 'table-scroll' },
              h(
                'table',
                {},
                h('thead', {}, h('tr', {}, ['log.time', 'log.what', 'log.details'].map((c) => h('th', { scope: 'col' }, t(c))))),
                h(
                  'tbody',
                  {},
                  d.errors.map((l) => {
                    const key = 'log.' + l.action + '.' + l.entity;
                    return h(
                      'tr',
                      {},
                      h('td', { class: 'nowrap' }, fmt.format(new Date(l.at))),
                      h('td', { class: 'wrap-cell' }, h('span', { class: 'strong' }, has(key) ? t(key) : l.action + ' ' + l.entity), l.label ? [': ', h('bdi', { dir: 'ltr' }, l.label)] : null),
                      h('td', { class: 'wrap-cell small' }, l.action === 'server_error' || l.action === 'cron_failed' ? h('bdi', { dir: 'ltr' }, JSON.parse(l.details || '{}').error || '') : logDetails(l)),
                    );
                  }),
                ),
              ),
            )
          : h('p', { class: 'empty' }, t('hl.no_errors')),
      ),
    ),
    section(
      'hl.limits',
      cards([
        card('hl.ai_today', d.ai.enabled ? `${d.ai.today} / ${d.ai.limit}` : t('hl.off'), d.ai.enabled ? aiPct + '%' : '', d.ai.enabled && aiPct >= 80),
        card('hl.storage', d.storage.bytes ? fmtSize(d.storage.bytes) : '0', t('hl.files_n', { n: d.storage.files })),
        card('hl.backup', d.backup ? fmtDate(d.backup.name.slice(0, 10)) : t('hl.none'), '', !d.backup),
        card('hl.license', d.license.days === undefined ? '-' : d.license.days, d.license.expires ? fmtDate(d.license.expires) : '', d.license.days !== undefined && d.license.days <= 30),
      ]),
      d.ai.enabled ? columns('hl.ai_days', d.ai.days) : '',
    ),
  );
}
