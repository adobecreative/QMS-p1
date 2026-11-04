// The monthly report and the compliance report.
import { render } from '../app.js';
import { contractChip, contractTitle, vendorName } from './contracts.js';
import { S, h, t } from './core.js';
import { printHead } from './layout.js';
import { api, checkField, errText, errorBox, field, fmtDate, input, select, toast } from './offline.js';
import { pick } from './tickets.js';

/* --------------------------------- reports -------------------------------- */

// The monthly report: each figure with last month's beside it, then where the requests came from.
export async function reportsPage(root, _param, alive) {
  let d;
  try {
    d = await api('/reports' + (S.repMonth ? '?month=' + S.repMonth : ''));
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const { cur, prev } = d;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '-');
  const num = (v, digits) => (v === null || v === undefined ? '-' : Number(v).toFixed(digits || 0));
  const monthName = (m) => {
    try {
      return new Intl.DateTimeFormat(S.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(m + '-01T00:00:00Z'));
    } catch {
      return m;
    }
  };
  const months = [];
  for (let m = d.this_month, i = 0; i < 12; i++) {
    months.push(m);
    const [y, mm] = m.split('-').map(Number);
    m = mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, '0')}`;
  }
  const pickMonth = select(months.map((m) => [m, monthName(m)]), d.month, { 'aria-label': t('rep.month') });
  pickMonth.addEventListener('change', () => {
    S.repMonth = pickMonth.value;
    render();
  });
  // A figure, with last month's in small type.
  const card = (label, value, before, hint) =>
    h(
      'div',
      { class: 'kpi rep-kpi' },
      h('span', { class: 'kpi-num', dir: 'ltr' }, String(value)),
      h('span', { class: 'kpi-label' }, t(label)),
      before !== undefined ? h('span', { class: 'rep-prev' }, t('rep.prev'), ' ', h('span', { dir: 'ltr' }, String(before))) : '',
      hint ? h('span', { class: 'rep-prev' }, hint) : '',
    );
  const cards = (list) => h('div', { class: 'panel kpis rep-kpis' }, list);
  const section = (title, ...kids) => h('section', { class: 'rep-section' }, h('h2', {}, t(title)), ...kids);
  const top = (title, rows) =>
    h(
      'div',
      { class: 'panel rep-top' },
      h('h3', {}, t(title)),
      rows.length
        ? h(
            'ol',
            {},
            rows.map((r) => {
              const max = rows[0].n || 1;
              return h('li', {}, h('span', { class: 'rep-top-name' }, pick(r.name_ar, r.name_en)), h('span', { class: 'rep-bar', 'aria-hidden': 'true' }, h('span', { style: `width:${Math.max(4, Math.round((r.n / max) * 100))}%` })), h('span', { class: 'mono', dir: 'ltr' }, String(r.n)));
            }),
          )
        : h('p', { class: 'muted small' }, t('rep.none')),
    );
  // Six months up to the chosen one, months without requests included.
  const shown = months.filter((m) => m <= d.month).slice(0, 6).reverse();
  const byMonth = new Map(d.trend.map((x) => [x.m, x]));
  const trendRows = shown.map((m) => byMonth.get(m) || { m, opened: 0 });
  const trendMax = Math.max(1, ...trendRows.map((x) => x.opened));
  const trend = h(
    'div',
    { class: 'panel rep-trend' },
    h('h3', {}, t('rep.trend')),
    trendRows.length
      ? h(
          'div',
          { class: 'rep-columns', role: 'list' },
          trendRows.map((x) =>
            h(
              'div',
              { class: 'rep-col' + (x.m === d.month ? ' rep-col-now' : ''), role: 'listitem', 'aria-label': monthName(x.m) + ': ' + x.opened },
              h('span', { class: 'mono small', dir: 'ltr' }, String(x.opened)),
              h('span', { class: 'rep-col-bar', style: `height:${x.opened ? Math.max(4, Math.round((x.opened / trendMax) * 120)) : 2}px` }),
              h('span', { class: 'small muted' }, monthName(x.m).split(' ')[0]),
            ),
          ),
        )
      : h('p', { class: 'muted small' }, t('rep.none')),
  );
  root.replaceChildren(
    printHead(),
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('rep.title'), ' - ', monthName(d.month)), h('p', { class: 'muted' }, t('rep.sub', { prev: monthName(prev.month) }))),
      h('div', { class: 'actions' }, pickMonth, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => window.print() }, t('rep.print'))),
    ),
    section(
      'app.desk',
      cards([
        card('rep.opened', cur.opened.n, prev.opened.n),
        card('rep.closed', cur.closed.n, prev.closed.n),
        card('rep.resp_ok', pct(cur.opened.resp_ok, cur.opened.received), pct(prev.opened.resp_ok, prev.opened.received)),
        card('rep.res_ok', pct(cur.closed.res_ok, cur.closed.n), pct(prev.closed.res_ok, prev.closed.n)),
        card('rep.avg_resp', num(cur.opened.avg_resp_min), num(prev.opened.avg_resp_min), t('rep.minutes')),
        card('rep.avg_res', num(cur.closed.avg_res_h, 1), num(prev.closed.avg_res_h, 1), t('rep.hours')),
        card('rep.rating', cur.closed.rated ? num(cur.closed.rating, 1) + ' / 5' : '-', prev.closed.rated ? num(prev.closed.rating, 1) + ' / 5' : '-'),
        card('rep.impact', cur.opened.impact, prev.opened.impact),
      ]),
      d.month === d.this_month ? h('p', { class: 'hint' }, t('rep.now_open', { n: d.now.open, late: d.now.late })) : '',
      trend,
      h(
        'div',
        { class: 'panel' },
        h('h3', { class: 'rep-h3' }, t('rep.by_team')),
        d.teams.length
          ? h(
              'div',
              { class: 'table-scroll' },
              h(
                'table',
                {},
                h('thead', {}, h('tr', {}, ['tk.team', 'rep.opened', 'rep.closed', 'rep.res_ok', 'rep.open_now', 'rep.rating'].map((c) => h('th', { scope: 'col' }, t(c))))),
                h(
                  'tbody',
                  {},
                  d.teams.map((x) =>
                    h(
                      'tr',
                      {},
                      h('td', { class: 'strong' }, pick(x.name_ar, x.name_en)),
                      h('td', { class: 'mono' }, String(x.opened)),
                      h('td', { class: 'mono' }, String(x.closed)),
                      h('td', { class: 'mono' }, pct(x.res_ok, x.closed)),
                      h('td', { class: 'mono' }, String(x.open_now)),
                      h('td', { class: 'mono' }, x.rating === null ? '-' : num(x.rating, 1)),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty' }, t('rep.none')),
      ),
      h('div', { class: 'rep-tops' }, top('rep.top_cats', d.categories), top('rep.top_places', d.places), top('rep.top_depts', d.departments)),
    ),
    section(
      'rep.maint',
      cards([
        card('rep.pm_done', cur.pm.n, prev.pm.n),
        card('rep.pm_ontime', pct(cur.pm.ok, cur.pm.n), pct(prev.pm.ok, prev.pm.n)),
        card('rep.pm_late', d.now.pm_late),
        card('rep.assets', d.assets.n),
        card('rep.assets_out', d.assets.out_of_service),
      ]),
    ),
    section(
      'app.rounds',
      cards([
        card('rep.rounds_done', cur.rounds.n, prev.rounds.n),
        card('rep.rounds_ontime', pct(cur.rounds.ok, cur.rounds.n), pct(prev.rounds.ok, prev.rounds.n)),
        card('rep.rounds_fail', cur.rounds.with_fail, prev.rounds.with_fail),
        card('rep.findings', cur.rounds.findings, prev.rounds.findings),
        card('rep.scanned', pct(cur.rounds.scanned, cur.rounds.n), pct(prev.rounds.scanned, prev.rounds.n)),
        card('rep.rounds_late', d.now.rounds_late),
      ]),
    ),
    section(
      'app.docs',
      cards([card('rep.files', d.files.n), card('rep.files_expired', d.files.expired), card('rep.files_near', d.files.near), card('rep.files_review', d.files.review)]),
    ),
    h('p', { class: 'muted small rep-foot' }, t('rep.foot', { date: fmtDate(d.today) })),
    reportMailPanel(),
  );
}

// Last month's report by email on the 1st: on or off, to whom, or sent now.
export function reportMailPanel() {
  const box = h('section', { class: 'panel pad stack settings rep-mail' }, h('h2', {}, t('rm.title')), h('p', { class: 'muted' }, t('rm.help')));
  api('/reports/mail')
    .then((m) => {
      const on = input({ type: 'checkbox', checked: m.on });
      const to = input({ type: 'text', value: (m.to || '').split(',').filter(Boolean).join(', '), dir: 'ltr', placeholder: m.defaults.join(', '), autocomplete: 'off' });
      const save = h('button', { type: 'button', class: 'btn btn-primary' }, t('common.save'));
      const now = h('button', { type: 'button', class: 'btn' }, t('rm.send_now'));
      const run = (btn, fn) => async () => {
        btn.disabled = true;
        try {
          await fn();
        } catch (e) {
          toast(errText(e), true);
        } finally {
          btn.disabled = false;
        }
      };
      save.addEventListener('click', run(save, async () => {
        await api('/reports/mail', { method: 'PUT', body: { on: on.checked, to: to.value } });
        toast(t('set.saved'));
      }));
      now.addEventListener('click', run(now, async () => toast(t('rm.sent', { n: (await api('/reports/mail', { method: 'POST' })).sent }))));
      box.append(
        m.mail_ready ? '' : h('p', { class: 'note note-near' }, t('rm.no_mail')),
        checkField(t('rm.on'), on),
        field(t('rm.to'), to, t('rm.to_hint')),
        m.last_sent ? h('p', { class: 'muted small' }, t('rm.last', { m: m.last_sent })) : '',
        h('div', { class: 'actions' }, save, now),
      );
    })
    .catch((e) => box.append(h('p', { class: 'form-error' }, errText(e))));
  return box;
}

// The compliance report for surveys (JCI, CBAHI): each figure against its target, then the lists a surveyor asks to see.
export async function compliancePage(root, _param, alive) {
  let d;
  try {
    d = await api('/reports/compliance' + (S.cmpPeriod ? '?period=' + encodeURIComponent(S.cmpPeriod) : ''));
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const pctText = (v) => (v === null ? '-' : v + '%');
  const periodName = (id) => {
    const q = /^(\d{4})-Q([1-4])$/.exec(id);
    return q ? t('cmp.quarter', { q: q[2], y: q[1] }) : t('cmp.year', { y: id });
  };
  const [thisYear, thisQ] = d.period.this_quarter.split('-Q').map(Number);
  const periods = [];
  for (let y = thisYear, q = thisQ, i = 0; i < 8; i++) {
    periods.push(`${y}-Q${q}`);
    if (--q === 0) (q = 4), y--;
  }
  for (let i = 0; i < 3; i++) periods.push(String(thisYear - i));
  const pickPeriod = select(periods.map((p) => [p, periodName(p)]), d.period.id, { 'aria-label': t('cmp.period') });
  pickPeriod.addEventListener('change', () => {
    S.cmpPeriod = pickPeriod.value;
    render();
  });
  const T = d.targets;
  // A result against its target: met, or how far below.
  const verdict = (v, target) =>
    v === null
      ? h('span', { class: 'muted small' }, t('cmp.no_data'))
      : h('span', { class: 'chip ' + (v >= target ? 'chip-valid' : v >= target - 10 ? 'chip-near' : 'chip-expired') }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t(v >= target ? 'cmp.met' : 'cmp.below'));
  const docsValid = d.files.n ? rate(d.files.n - d.files.expired, d.files.n) : null;
  const score = [
    ['cmp.k_pm_high', rate(d.pm.high.ok, d.pm.high.due), T.pm_high],
    ['cmp.k_pm', rate(d.pm.all.ok, d.pm.all.due), T.pm],
    ['cmp.k_rounds', rate(d.rounds_all.ok, d.rounds_all.due), T.rounds],
    ['cmp.k_response', rate(d.tickets_all.resp_ok, d.tickets_all.received), T.response],
    ['cmp.k_resolve', rate(d.tickets_all.res_ok, d.tickets_all.closed), T.resolve],
    ['cmp.k_docs', docsValid, T.docs],
  ];
  const table = (cols, rows, empty) =>
    rows.length
      ? h('div', { class: 'table-scroll' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', { scope: 'col' }, t(c))))), h('tbody', {}, rows)))
      : h('p', { class: 'empty' }, t(empty || 'rep.none'));
  const panel = (title, ...kids) => h('div', { class: 'panel' }, h('h3', { class: 'rep-h3' }, t(title)), ...kids);
  const section = (title, ...kids) => h('section', { class: 'rep-section' }, h('h2', {}, t(title)), ...kids);
  const card = (label, value, warn) => h('div', { class: 'kpi rep-kpi' + (warn ? ' kpi-expired' : '') }, h('span', { class: 'kpi-num', dir: 'ltr' }, String(value)), h('span', { class: 'kpi-label' }, t(label)));
  const cards = (list) => h('div', { class: 'panel kpis rep-kpis' }, list);
  const mono = (v) => h('td', { class: 'mono' }, String(v));
  const pmLine = (label, r) => h('tr', {}, h('td', { class: 'strong' }, label), mono(r.due), mono(r.done), mono(r.ok), mono(pctText(rate(r.done, r.due))), mono(pctText(rate(r.ok, r.due))));
  const pmKinds = Object.keys(d.pm.kinds).filter((k) => d.pm.kinds[k].due);

  root.replaceChildren(
    printHead(),
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, t('cmp.title'), ' - ', periodName(d.period.id)), h('p', { class: 'muted', dir: 'ltr' }, fmtDate(d.period.from_day) + ' - ' + fmtDate(d.period.to_day))),
      h('div', { class: 'actions' }, pickPeriod, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => window.print() }, t('rep.print'))),
    ),
    section(
      'cmp.summary',
      h(
        'div',
        { class: 'panel' },
        table(
          ['cmp.indicator', 'cmp.target', 'cmp.result', 'cmp.status'],
          score.map(([k, v, target]) => h('tr', {}, h('td', { class: 'strong' }, t(k)), h('td', { class: 'mono', dir: 'ltr' }, '≥ ' + target + '%'), mono(pctText(v)), h('td', {}, verdict(v, target)))),
        ),
      ),
    ),
    section(
      'rep.maint',
      cards([
        card('rep.assets', d.assets.n),
        card('cmp.high_risk', d.assets.high),
        card('cmp.no_plan', d.assets.no_plan, d.assets.no_plan > 0),
        card('cmp.high_no_plan', d.assets.high_no_plan, d.assets.high_no_plan > 0),
        card('cmp.uncovered_high', d.uncovered_high, d.uncovered_high > 0),
        card('rep.assets_out', d.assets.out_of_service),
      ]),
      panel(
        'cmp.pm_by_kind',
        table(
          ['pm.kind', 'cmp.due', 'cmp.done', 'cmp.on_time', 'cmp.completion', 'cmp.on_time_rate'],
          d.pm.all.due ? [...pmKinds.map((k) => pmLine(t('pm.kind.' + k), d.pm.kinds[k])), pmLine(t('cmp.high_risk'), d.pm.high), pmLine(t('cmp.total'), d.pm.all)] : [],
        ),
      ),
      panel(
        'cmp.pm_late',
        table(
          ['ast.tag', 'ast.name', 'pm.kind', 'cmp.place', 'cmp.was_due'],
          d.pm_late.map((r) =>
            h(
              'tr',
              {},
              h('td', { class: 'mono' }, r.tag),
              h('td', { class: 'strong' }, pick(r.name_ar, r.name_en), r.risk === 'high' ? h('span', { class: 'chip chip-expired cmp-risk' }, t('ast.risk.high')) : ''),
              h('td', {}, t('pm.kind.' + r.kind)),
              h('td', {}, r.loc_ar ? pick(r.loc_ar, r.loc_en) : '-'),
              h('td', { class: 'mono nowrap' }, fmtDate(r.next_due)),
            ),
          ),
          'cmp.none_late',
        ),
      ),
    ),
    section(
      'app.rounds',
      cards([
        card('cmp.rounds_due', d.rounds_all.due),
        card('rep.rounds_done', d.rounds_all.done),
        card('rep.findings', d.rounds_all.findings),
        card('cmp.findings_closed', d.findings.n ? pctText(rate(d.findings.closed, d.findings.n)) : '-'),
      ]),
      panel(
        'cmp.by_checklist',
        table(
          ['cmp.checklist', 'cmp.due', 'cmp.done', 'cmp.on_time_rate', 'rep.rounds_fail', 'rep.findings'],
          d.rounds.map((f) => h('tr', {}, h('td', { class: 'strong' }, pick(f.name_ar, f.name_en)), mono(f.due), mono(f.done), mono(pctText(rate(f.ok, f.due))), mono(f.with_fail), mono(f.findings))),
        ),
      ),
    ),
    section(
      'cmp.corrective',
      panel(
        'cmp.by_priority',
        table(
          ['tk.priority', 'cmp.requests', 'rep.resp_ok', 'rep.res_ok', 'rep.impact'],
          d.tickets.length
            ? [
                ...d.tickets.map((r) => h('tr', {}, h('td', { class: 'strong' }, t('prio.' + r.priority)), mono(r.n), mono(pctText(rate(r.resp_ok, r.received))), mono(pctText(rate(r.res_ok, r.closed))), mono(r.impact))),
                h('tr', {}, h('td', { class: 'strong' }, t('cmp.total')), mono(d.tickets_all.n), mono(pctText(rate(d.tickets_all.resp_ok, d.tickets_all.received))), mono(pctText(rate(d.tickets_all.res_ok, d.tickets_all.closed))), mono(d.tickets_all.impact)),
              ]
            : [],
        ),
      ),
    ),
    section(
      'cmp.contracts',
      panel(
        'cmp.contract_list',
        table(
          ['con.number', 'con.vendor', 'cmp.contract', 'con.end', 'cmp.status', 'con.assets', 'con.visits'],
          d.contracts.map((c) =>
            h(
              'tr',
              {},
              h('td', { class: 'mono' }, c.number),
              h('td', {}, vendorName(c)),
              h('td', { class: 'strong' }, contractTitle(c)),
              h('td', { class: 'mono nowrap' }, fmtDate(c.end_date)),
              h('td', {}, contractChip(c)),
              mono(c.asset_count),
              mono(c.visits.total ? `${c.visits.done} / ${c.visits.due}` : '-'),
            ),
          ),
        ),
      ),
    ),
    section(
      'app.docs',
      cards([card('rep.files', d.files.n), card('rep.files_expired', d.files.expired, d.files.expired > 0), card('rep.files_near', d.files.near), card('rep.files_review', d.files.review)]),
      panel(
        'cmp.files_expired',
        table(
          ['field.name', 'field.file_number', 'cmp.department', 'field.expiry_date'],
          d.files_expired.map((f) => h('tr', {}, h('td', { class: 'strong' }, f.name), h('td', { class: 'mono' }, f.file_number), h('td', {}, pick(f.dept_ar, f.dept_en)), h('td', { class: 'mono nowrap' }, fmtDate(f.expiry_date)))),
          'cmp.none_expired',
        ),
      ),
    ),
  );
}
