// Admin Center: users, activity log, settings, license and backup.
import { render } from '../app.js';
import { ApiError, S, h, has, icon, t } from './core.js';
import { OFF_APPS, applyBrand, authShell, brand, isAdminRole } from './layout.js';
import { api, checkField, deptById, deptName, errText, errorBox, field, fileName, fmtDate, input, openDialog, personName, select, toast, typeName } from './offline.js';
import { fmtDuration, pick, priorityChip } from './tickets.js';
import { linkPanel } from './quality.js';
import { zipStore } from './xlsx.js';

/* --------------------------------- users -------------------------------- */

export async function usersPage(root, _param, alive) {
  let users;
  let missing = [];
  try {
    const [d, u, pu] = await Promise.all([api('/departments'), api('/users'), S.user.role === 'super_admin' ? api('/portal-users').catch(() => null) : null]);
    S.departments = d.departments;
    users = u.users;
    if (pu && pu.on) missing = pu.users;
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const fromPortal = !!S.portalUrl && !S.user.is_owner;
  const manage = S.user.role === 'super_admin' && !fromPortal;
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, t('nav.users')), manage ? h('div', { class: 'actions' }, missing.length ? h('button', { type: 'button', class: 'btn', onclick: () => portalUsersDialog(missing) }, icon('users'), t('puser.button', { n: missing.length })) : null, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => userDialog(null) }, icon('plus'), t('user.add'))) : ''),
    fromPortal ? h('p', { class: 'notice' }, t('user.from_portal'), ' ', h('a', { href: S.portalUrl + '/#/admin/users' }, t('portal.fikra'))) : manage ? '' : h('p', { class: 'notice' }, t('user.view_only')),
    h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'table-scroll' },
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, ['user.name', 'user.department', 'user.permissions', 'user.status', ...(manage ? ['common.actions'] : [])].map((c) => h('th', { scope: 'col' }, t(c))))),
          h(
            'tbody',
            {},
            users.map((u) =>
              h(
                'tr',
                {},
                h('td', {}, h('div', { class: 'strong' }, personName(u)), h('div', { class: 'muted user-email' }, h('bdi', { dir: 'ltr' }, u.email))),
                h('td', {}, u.department_id ? deptName(deptById(u.department_id)) : h('span', { class: 'muted' }, t('common.none'))),
                // One column for all four systems, so every permission (Assets included) fits without sideways scrolling.
                h(
                  'td',
                  {},
                  isAdminRole(u)
                    ? h('div', { class: 'chips' }, h('span', { class: 'chip chip-progress' }, t('role.' + u.role)), h('span', { class: 'muted' }, t('user.all_systems')))
                    : h(
                        'dl',
                        { class: 'perm-list' },
                        ['quality', 'meetings', 'docs', 'desk', 'assets', 'rounds'].filter((app) => !OFF_APPS.includes(app)).map((app) => {
                          const r = u[app + '_role'] || 'none';
                          return h('div', {}, h('dt', {}, t('app.' + app)), h('dd', r === 'none' ? { class: 'muted' } : {}, t(app + 'role.' + r)));
                        }),
                      ),
                ),
                h(
                  'td',
                  {},
                  h(
                    'div',
                    { class: 'chips' },
                    u.active ? h('span', { class: 'chip chip-valid' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('field.active')) : h('span', { class: 'chip chip-review' }, t('user.inactive')),
                    u.totp_on ? h('span', { class: 'chip chip-progress', title: t('tfa.title') }, icon('shield', 14), t('tfa.short')) : null,
                    u.portal ? h('span', { class: 'chip' }, t(u.portal_off ? 'puser.off_chip' : 'puser.chip')) : null,
                  ),
                ),
                manage ? h(
                  'td',
                  {},
                  u.role === 'super_admin' && !S.user.is_owner && u.id !== S.user.id ? '' : h(
                    'div',
                    { class: 'row-actions' },
                    h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': t('common.edit') + ': ' + personName(u), title: t('common.edit'), onclick: () => userDialog(u) }, icon('edit')),
                    u.totp_on && u.id !== S.user.id ? h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': t('tfa.reset') + ': ' + personName(u), title: t('tfa.reset'), onclick: () => resetTwoFactor(u) }, icon('shield')) : null,
                    u.id !== S.user.id ? h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': t('common.delete') + ': ' + personName(u), title: t('common.delete'), onclick: () => deleteUser(u) }, icon('trash')) : null,
                  ),
                ) : '',
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

// The portal's people with no account here: the admin adds them one by one, deciding password and roles.
function portalUsersDialog(list) {
  const dlg = openDialog({
    title: t('puser.title'),
    body: h(
      'div',
      { class: 'stack' },
      h('p', { class: 'hint' }, t('puser.help')),
      list.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              {},
              h(
                'tbody',
                {},
                list.map((p) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, h('div', { class: 'strong' }, S.lang === 'ar' ? p.name_ar : p.name_en || p.name_ar), h('div', { class: 'muted user-email' }, h('bdi', { dir: 'ltr' }, p.email))),
                    h('td', { class: 'muted' }, (S.lang === 'ar' ? p.department_ar : p.department_en || p.department_ar) || ''),
                    h('td', {}, h('button', { type: 'button', class: 'btn btn-small', onclick: () => (dlg.close(), userDialog(null, p)) }, icon('plus'), t('puser.add'))),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'muted' }, t('puser.empty')),
    ),
    submitLabel: t('common.close'),
    onSubmit: async () => {},
  });
}

// One account for every system: the department is the person's own, and each system gets its own role.
// from: a portal account to add (its names and email come filled in, and the new account is linked to it).
export function userDialog(u, from) {
  const isSelf = !!u && u.id === S.user.id;
  const name = input({ type: 'text', required: true, maxlength: 100, dir: 'rtl', value: u ? u.name : from ? from.name_ar : '' });
  const nameEn = input({ type: 'text', required: true, maxlength: 100, dir: 'ltr', value: u ? u.name_en || '' : from ? from.name_en || '' : '' });
  const email = input({ type: 'email', required: true, dir: 'ltr', value: u ? u.email : from ? from.email : '' });
  const phone = input({ type: 'tel', maxlength: 30, dir: 'ltr', autocomplete: 'tel', placeholder: '05xxxxxxxx', value: u ? u.phone || '' : from ? from.phone || '' : '' });
  // Only the system owner appoints or changes a super admin.
  const lockedSup = !!u && u.role === 'super_admin' && !S.user.is_owner;
  const levels = S.user.is_owner || lockedSup ? ['user', 'systems_admin', 'super_admin'] : ['user', 'systems_admin'];
  const level = select(levels.map((r) => [r, t('level.' + r)]), u ? u.role : 'user', { disabled: isSelf || lockedSup });
  const dept = select([['', t('common.none')], ...S.departments.map((d) => [d.id, deptName(d)])], u ? u.department_id ?? '' : '', {});
  const docs = select(['none', 'viewer', 'dept_admin'].map((r) => [r, t('docsrole.' + r)]), u ? u.docs_role : 'viewer', {});
  const desk = select(['none', 'dept', 'technician', 'supervisor'].map((r) => [r, t('deskrole.' + r)]), u ? u.desk_role : 'none', {});
  const assetsRole = select(['none', 'viewer', 'manager'].map((r) => [r, t('assetsrole.' + r)]), u ? u.assets_role || 'none' : 'none', {});
  const roundsRole = select(['none', 'inspector', 'manager'].map((r) => [r, t('roundsrole.' + r)]), u ? u.rounds_role || 'none' : 'none', {});
  const qualityRole = select(['none', 'viewer', 'assessor', 'manager'].map((r) => [r, t('qualityrole.' + r)]), u ? u.quality_role || 'none' : 'none', {});
  const meetingsRole = select(['none', 'viewer', 'secretary', 'manager'].map((r) => [r, t('meetingsrole.' + r)]), u ? u.meetings_role || 'none' : 'none', {});
  const job = select([['', t('common.none')], ...['technician', 'engineer', 'supervisor', 'specialist'].map((j) => [j, t('job.' + j)])], u ? u.job_title || '' : '', {});
  const jobField = field(t('user.job_title'), job);
  const password = input({ type: 'password', minlength: 8, required: !u, autocomplete: 'new-password', dir: 'ltr' });
  const active = input({ type: 'checkbox', checked: u ? u.active : true, disabled: isSelf });
  const deptField = field(t('user.department'), dept, t('user.department_hint'));
  const teamNote = h('p', { class: 'hint' }, t('user.team_hint'));
  const perApp = h(
    'fieldset',
    { class: 'app-roles' },
    h('legend', {}, t('user.app_roles')),
    h('div', { class: 'form-grid' }, field(t('app.quality'), qualityRole, t('user.quality_hint')), field(t('app.meetings'), meetingsRole, t('user.meetings_hint')), field(t('app.docs'), docs, t('user.docs_hint')), OFF_APPS.includes('desk') ? null : field(t('app.desk'), desk, t('user.desk_hint')), OFF_APPS.includes('assets') ? null : field(t('app.assets'), assetsRole, t('user.assets_hint')), field(t('app.rounds'), roundsRole, t('user.rounds_hint'))),
    teamNote,
    jobField,
  );
  const sync = () => {
    const isSup = level.value !== 'user';
    perApp.hidden = isSup;
    deptField.hidden = isSup;
    const team = desk.value === 'technician' || desk.value === 'supervisor';
    jobField.hidden = !team;
    const d = deptById(Number(dept.value));
    teamNote.hidden = !team || !!(d && d.is_team);
    dept.required = !isSup && (docs.value === 'dept_admin' || desk.value !== 'none');
  };
  for (const el of [level, dept, docs, desk]) el.addEventListener('change', sync);
  sync();
  openDialog({
    title: t(u ? 'user.edit' : 'user.add'),
    body: h(
      'div',
      { class: 'stack' },
      h('div', { class: 'form-grid' }, field(t('user.name_ar'), name), field(t('user.name_en'), nameEn)),
      h('div', { class: 'form-grid' }, field(t('user.email'), email), field(t('user.phone'), phone)),
      field(t('user.level'), level),
      deptField,
      perApp,
      field(t(u ? 'user.new_password' : 'user.password'), password, t(u ? 'user.new_password_hint' : 'user.password_hint')),
      u ? checkField(t('user.active'), active) : null,
    ),
    onSubmit: async () => {
      const body = {
        name: name.value,
        name_en: nameEn.value,
        email: email.value,
        phone: phone.value,
        role: level.value,
        docs_role: docs.value,
        desk_role: desk.value,
        assets_role: assetsRole.value,
        rounds_role: roundsRole.value,
        quality_role: qualityRole.value,
        meetings_role: meetingsRole.value,
        department_id: level.value !== 'user' || !dept.value ? null : Number(dept.value),
        job_title: job.value || null,
        active: active.checked,
      };
      if (password.value) body.password = password.value;
      if (from) body.portal_id = from.id;
      await api(u ? '/users/' + u.id : '/users', { method: u ? 'PUT' : 'POST', body });
      if (isSelf) Object.assign(S.user, { name: name.value, name_en: nameEn.value });
      toast(t(u ? 'user.saved' : 'user.added'));
      render();
    },
  });
}
export function resetTwoFactor(u) {
  openDialog({
    title: t('tfa.reset_q', { name: personName(u) }),
    body: h('p', { class: 'muted' }, t('tfa.reset_body')),
    submitLabel: t('tfa.reset'),
    danger: true,
    onSubmit: async () => {
      await api('/users/' + u.id + '/2fa-reset', { method: 'POST' });
      toast(t('tfa.reset_done'));
      render();
    },
  });
}
export function deleteUser(u) {
  openDialog({
    title: t('user.delete_q', { name: personName(u) }),
    body: h('div', {}),
    submitLabel: t('common.delete'),
    danger: true,
    onSubmit: async () => {
      await api('/users/' + u.id, { method: 'DELETE' });
      toast(t('user.deleted'));
      render();
    },
  });
}

/* ---------------------------------- logs -------------------------------- */

export function logValue(key, v) {
  if (v === null || v === undefined || v === '') return t('common.none');
  if (key === 'under_review' || key === 'active') return t(v ? 'common.yes' : 'common.no');
  if (key === 'department_id') return deptName(deptById(v)) || '#' + v;
  if (key === 'doc_type') return typeName(v);
  if (key === 'is_team' || key === 'require_qr' || key === 'auto_assign' || key === 'ai_enabled' || key === 'round_reminders' || key === 'monthly_report' || key === 'link_on') return t(v && v !== '0' ? 'common.yes' : 'common.no');
  if (key === 'job_title') return has('job.' + v) ? t('job.' + v) : String(v);
  if (key === 'team_id') return deptName(deptById(v)) || '#' + v;
  if (key === 'priority') return 'P' + v;
  if (key === 'score' && has('qa.score.' + v)) return t('qa.score.' + v);
  if (key === 'esr') return t(v ? 'common.yes' : 'common.no');
  if (key === 'docs_role' || key === 'desk_role' || key === 'assets_role' || key === 'rounds_role' || key === 'quality_role' || key === 'meetings_role') {
    const k = key.replace('_role', 'role.') + v;
    return has(k) ? t(k) : String(v);
  }
  if (key === 'kind' && has('inv.kind.' + v)) return t('inv.kind.' + v);
  if (key === 'inventory_mode') return has('inv.mode.' + v) ? t('inv.mode.' + v) : String(v);
  if (key === 'status' && has('inv.req.' + v)) return t('inv.req.' + v);
  if (key === 'kind') return has('pm.kind.' + v) ? t('pm.kind.' + v) : String(v);
  if (key === 'status' || key === 'risk') return has('ast.' + key + '.' + v) ? t('ast.' + key + '.' + v) : String(v);
  if (key === 'warranty_end' || key === 'next_due') return fmtDate(String(v));
  if (key === 'role') return has('role.' + v) ? t('role.' + v) : String(v);
  if (/_date$/.test(key)) return fmtDate(String(v));
  return String(v);
}
export function logDetails(l) {
  if (!l.details) return null;
  let d;
  try {
    d = JSON.parse(l.details);
  } catch {
    return null;
  }
  if (l.action === 'notify') return t('log.notify_detail', { files: d.files, emails: d.emails });
  if (l.action === 'remind' && l.entity === 'contract') return t('log.remind_contract_detail', { n: d.items, emails: d.emails });
  if (l.action === 'remind' && l.entity === 'stock') return t('log.remind_stock_detail', { n: d.items, emails: d.emails });
  if (l.action === 'remind') return t('log.remind_detail', { places: d.places, emails: d.emails });
  if (l.action === 'remind_failed') return has('err.' + d.error) ? t('err.' + d.error) : String(d.error || '');
  if (l.action === 'backup' || l.action === 'demo_add' || l.action === 'demo_remove') return t('log.backup_detail', { files: d.files });
  if (l.action === 'login' || l.action === 'login_failed' || l.action === 'login_locked')
    return [d.ip ? h('div', {}, 'IP: ', h('bdi', { dir: 'ltr' }, d.ip) , d.country ? ' (' + d.country + ')' : '') : null, d.method ? h('div', {}, t('tfa.method_' + d.method)) : null, d.step ? h('div', {}, t('tfa.failed_' + d.step)) : null];
  if (l.action === 'reset_failed') return has('err.' + d.error) ? t('err.' + d.error) : d.error;
  if (l.action === 'import' && l.entity === 'standard') return t('log.import_std_detail', { saved: d.saved, errors: d.errors });
  if (l.action === 'import' && l.entity === 'asset') return t('log.import_asset_detail', { added: d.added, updated: d.updated, plans: d.plans });
  if (l.action === 'import') return t('log.import_detail', { added: d.added, updated: d.updated, deactivated: d.deactivated });
  if (l.action === 'notify_failed' && l.entity === 'ticket') return has('err.' + d.error) ? t('err.' + d.error) : d.error;
  if (l.action === 'notify_failed') return t('log.notify_failed_detail', { files: d.files }) + ' ' + (has('err.' + d.error) ? t('err.' + d.error) : '');
  return Object.entries(d).map(([k, pair]) => {
    const label = has('field.' + k) ? t('field.' + k) : k;
    if (k === 'password' || k === 'mail_token' || k === 'brevo_key' || k === 'code') return h('div', {}, label);
    const [a, b] = Array.isArray(pair) ? pair : [null, pair];
    return h('div', {}, label + ': ', h('bdi', {}, logValue(k, a)), ' ' + t('log.arrow') + ' ', h('bdi', {}, logValue(k, b)));
  });
}

export async function logsPage(root, _param, alive) {
  const logs = [];
  let more = false;
  const fetchMore = async () => {
    const before = logs.length ? '?before=' + logs[logs.length - 1].id : '';
    const batch = (await api('/logs' + before)).logs;
    logs.push(...batch);
    more = batch.length === 100;
  };
  try {
    const [d, ty] = await Promise.all([api('/departments'), api('/doc-types')]);
    S.departments = d.departments;
    S.docTypes = ty.doc_types;
    await fetchMore();
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  const fmt = new Intl.DateTimeFormat(S.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const draw = () => {
    root.replaceChildren(
      h('div', { class: 'page-head' }, h('h1', {}, t('nav.logs'))),
      h(
        'section',
        { class: 'panel' },
        logs.length
          ? h(
              'div',
              { class: 'table-scroll' },
              h(
                'table',
                {},
                h('thead', {}, h('tr', {}, ['log.time', 'log.user', 'log.what', 'log.details'].map((c) => h('th', { scope: 'col' }, t(c))))),
                h(
                  'tbody',
                  {},
                  logs.map((l) => {
                    const key = 'log.' + l.action + '.' + l.entity;
                    return h(
                      'tr',
                      {},
                      h('td', { class: 'nowrap' }, fmt.format(new Date(l.at))),
                      h('td', {}, l.user_name === 'system' ? h('span', { class: 'muted' }, 'system') : l.user_name),
                      h('td', { class: 'wrap-cell' }, h('span', { class: 'strong' }, has(key) ? t(key) : l.action + ' ' + l.entity), l.label ? [': ', h('bdi', {}, l.label)] : null),
                      h('td', { class: 'wrap-cell small' }, logDetails(l)),
                    );
                  }),
                ),
              ),
            )
          : h('p', { class: 'empty' }, t('log.empty')),
        more
          ? h(
              'div',
              { class: 'panel-foot' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn',
                  onclick: async (e) => {
                    e.target.disabled = true;
                    try {
                      await fetchMore();
                      draw();
                    } catch (err) {
                      toast(errText(err), true);
                      e.target.disabled = false;
                    }
                  },
                },
                t('log.more'),
              ),
            )
          : null,
      ),
    );
  };
  draw();
}

/* -------------------------------- settings ------------------------------ */

export const TIMEZONES = ['Africa/Cairo', 'Asia/Riyadh', 'Asia/Dubai', 'Asia/Kuwait', 'Asia/Qatar', 'Asia/Bahrain', 'Asia/Muscat', 'Asia/Amman', 'Asia/Beirut', 'Asia/Baghdad', 'Africa/Tripoli', 'Africa/Tunis', 'Africa/Algiers', 'Africa/Casablanca', 'Africa/Khartoum', 'UTC'];

/* ------------------------------- license ------------------------------- */

export const LOCKED = ['missing', 'invalid', 'domain'];
export function licensePanel(l) {
  if (!l || l.state === 'dev') return '';
  const row = (k, v) => h('div', { class: 'kv' }, h('dt', {}, t(k)), h('dd', {}, v));
  const chip = { ok: 'chip-valid', expiring: 'chip-near', grace: 'chip-expired', readonly: 'chip-expired' }[l.state] || 'chip-review';
  return h(
    'section',
    { class: 'panel pad stack settings' },
    h('h2', {}, t('lic.title')),
    h('dl', { class: 'kv-list' },
      row('lic.status', h('span', { class: 'chip ' + chip }, t('lic.state_' + l.state))),
      row('lic.org', pick(l.org_ar, l.org_en)),
      row('lic.domains', h('bdi', { dir: 'ltr' }, (l.domains || []).join(', '))),
      row('lic.expires', fmtDate(l.expires) + ' (' + (l.days >= 0 ? t('lic.days_left', { n: l.days }) : t('lic.days_past', { n: -l.days })) + ')'),
      row('lic.users', l.max_users ? t('lic.users_of', { n: l.active_users, max: l.max_users }) : t('lic.users_any', { n: l.active_users })),
    ),
  );
}
// A notice under the menu: to super admins as the end date nears, and to everyone once read-only.
export function licenseBar() {
  const l = S.license;
  if (!l || !['expiring', 'grace', 'readonly'].includes(l.state)) return '';
  if (l.state !== 'readonly' && !isAdminRole(S.user)) return '';
  return h('div', { class: 'lic-bar', role: 'status' }, h('div', { class: 'wrap' }, t('lic.bar_' + l.state, { n: Math.abs(l.days), date: fmtDate(l.expires) })));
}
export function licenseLockPage() {
  return authShell(t('lic.locked_title'), h('p', { class: 'muted' }, t('lic.locked_' + S.license.state)), h('p', { class: 'muted small' }, h('bdi', { dir: 'ltr' }, S.license.host || location.hostname)));
}

export function backupPanel(s) {
  const status = h('p', { class: 'muted small', 'aria-live': 'polite' });
  const btn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => downloadBackup(btn, status) }, icon('download'), t('bak.button'));
  return h(
    'section',
    { class: 'panel pad stack settings' },
    h('h2', {}, t('bak.title')),
    h('p', { class: 'muted' }, t(S.user.is_owner ? 'bak.help' : 'bak.help_pdf')),
    h('div', { class: 'actions logo-actions' }, btn),
    status,
    h('p', { class: 'hint' }, t('bak.hint')),
    S.user.is_owner ? autoBackups(s) : '',
  );
}
export const fmtSize = (n) => (n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB');
// The weekly copies the system keeps on its own, newest first.
export function autoBackups(s) {
  // A copy of each weekly backup can also go to the owner's mailbox, away from Cloudflare.
  const mailIt = input({ type: 'checkbox', checked: !!(s && s.backup_email) });
  mailIt.addEventListener('change', async () => {
    mailIt.disabled = true;
    try {
      await api('/settings', { method: 'PUT', body: { backup_email: mailIt.checked } });
      toast(t('set.saved'));
    } catch (e) {
      mailIt.checked = !mailIt.checked;
      toast(errText(e), true);
    } finally {
      mailIt.disabled = false;
    }
  });
  const sendNow = h('button', { type: 'button', class: 'btn' }, t('bak.email_now'));
  sendNow.addEventListener('click', async () => {
    sendNow.disabled = true;
    try {
      toast(t('bak.email_sent', { to: (await api('/backup/auto/email', { method: 'POST' })).to }));
    } catch (e) {
      toast(errText(e), true);
    } finally {
      sendNow.disabled = false;
    }
  });
  const box = h('div', { class: 'stack' }, h('h3', { class: 'small strong' }, t('bak.auto')), checkField(t('bak.email'), mailIt));
  api('/backup/auto')
    .then((r) =>
      box.append(
        r.backups.length
          ? h('ul', { class: 'pp-list' }, r.backups.map((b) => h('li', {}, h('a', { href: '/api/backup/auto/' + encodeURIComponent(b.name), download: 'backup-' + b.name, dir: 'ltr' }, b.name.replace('.json', '')), h('span', { class: 'muted small', dir: 'ltr' }, fmtSize(b.size)))))
          : h('p', { class: 'muted small' }, t('bak.auto_none')),
        r.backups.length ? h('div', { class: 'actions' }, sendNow) : '',
      ),
    )
    .catch((e) => box.append(h('p', { class: 'form-error' }, errText(e))));
  return box;
}

// Sample departments and files for showing the system; removing them deletes only what was added.
export function demoPanel(active) {
  const add = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api('/settings/demo', { method: 'POST' });
      toast(t('demo.added', { files: r.files }));
      render();
    } catch (error) {
      toast(errText(error), true);
      btn.disabled = false;
    }
  };
  const remove = () =>
    openDialog({
      title: t('demo.remove_q'),
      body: h('p', { class: 'muted' }, t('demo.remove_help')),
      submitLabel: t('common.delete'),
      danger: true,
      onSubmit: async () => {
        const r = await api('/settings/demo', { method: 'DELETE' });
        toast(r.kept_departments ? t('demo.removed_kept', { n: r.kept_departments }) : t('demo.removed'));
        render();
      },
    });
  return h(
    'section',
    { class: 'panel pad stack settings' },
    h('h2', {}, t('demo.title')),
    h('p', { class: 'muted' }, t(active ? 'demo.help_active' : 'demo.help')),
    h(
      'div',
      { class: 'actions' },
      active
        ? h('button', { type: 'button', class: 'btn btn-danger', onclick: remove }, icon('trash'), t('demo.remove'))
        : h('button', { type: 'button', class: 'btn', onclick: add }, t('demo.add')),
    ),
  );
}

// Each system has its own settings page; the Admin Center holds what all systems share.
export async function settingsPage(root, _param, alive, app) {
  let s;
  let lic;
  try {
    ({ settings: s, license: lic } = await api('/settings'));
  } catch (e) {
    if (alive()) root.replaceChildren(errorBox(e));
    return;
  }
  if (!alive()) return;
  // The Admin Center's settings are the system owner's alone (the server answers only the systems' own
  // settings to anyone else). Other admins find the backup here and nothing more: the PDF files only,
  // as the database copy is the owner's alone.
  const owner = !!S.user.is_owner;
  if (app === 'admin' && !owner) {
    root.replaceChildren(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('nav.settings')), h('p', { class: 'muted' }, t('app.admin')))), backupPanel(s));
    return;
  }
  const zones = !s.timezone || TIMEZONES.includes(s.timezone) ? TIMEZONES : [s.timezone, ...TIMEZONES];
  const mailUrl = input({ type: 'url', dir: 'ltr', maxlength: 500, placeholder: 'https://.../exec', value: s.mail_url });
  const mailToken = input({ type: 'password', dir: 'ltr', maxlength: 200, autocomplete: 'off' });
  const senderName = input({ type: 'text', maxlength: 80, value: s.sender_name });
  // Two ways to send; each keeps its own saved values, so switching back needs nothing re-entered.
  const provider = select([['gas', t('set.provider_gas')], ['brevo', t('set.provider_brevo')]], s.mail_provider, {});
  const brevoKey = input({ type: 'password', dir: 'ltr', maxlength: 200, autocomplete: 'off' });
  const mailFrom = input({ type: 'email', dir: 'ltr', maxlength: 200, value: s.mail_from || '', placeholder: 'notifications@example.com' });
  const replyTo = input({ type: 'email', dir: 'ltr', maxlength: 200, value: s.mail_reply_to || '' });
  const gasFields = h('div', { class: 'stack' }, field(t('set.mail_url'), mailUrl), field(t('set.mail_token'), mailToken, s.mail_token_set ? t('set.mail_token_set') : null));
  const brevoFields = h('div', { class: 'stack' }, field(t('set.brevo_key'), brevoKey, s.brevo_key_set ? t('set.mail_token_set') : null), field(t('set.mail_from'), mailFrom), field(t('set.reply_to'), replyTo));
  const showProvider = () => {
    gasFields.hidden = provider.value !== 'gas';
    brevoFields.hidden = provider.value !== 'brevo';
  };
  provider.addEventListener('change', showProvider);
  showProvider();
  const nearDays = input({ type: 'number', min: 0, max: 3650, step: 1, required: true, inputmode: 'numeric', value: s.near_days });
  const repeatDays = input({ type: 'number', min: 0, max: 365, step: 1, required: true, inputmode: 'numeric', value: s.repeat_days });
  const timezone = select(zones.map((z) => [z, z]), s.timezone, { dir: 'ltr' });
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const save = h('button', { type: 'submit', class: 'btn btn-primary' }, t('set.save'));
  const orgAr = input({ type: 'text', maxlength: 100, dir: 'rtl', value: s.org_name_ar || '' });
  const orgEn = input({ type: 'text', maxlength: 100, dir: 'ltr', value: s.org_name_en || '' });
  const support = input({ type: 'email', maxlength: 200, dir: 'ltr', autocomplete: 'off', value: s.support_email || '', placeholder: 'info@example.com' });
  // Who a request can affect, in the sector's words (patient, student, guest...), used across the screens, emails and reports.
  const who = Object.fromEntries(['one_ar', 'all_ar', 'one_en', 'all_en'].map((k) => [k, input({ type: 'text', maxlength: 40, required: true, dir: k.endsWith('_ar') ? 'rtl' : 'ltr', value: s['who_' + k] || '' })]));
  const requireQr = input({ type: 'checkbox', checked: !!s.require_qr });
  const aiOn = input({ type: 'checkbox', checked: !!s.ai_enabled });
  const require2fa = select(['off', 'super', 'managers'].map((v) => [v, t('tfa.level_' + v)]), s.require_2fa, {});
  const aiLimit = input({ type: 'number', min: 0, max: 5000, step: 1, required: true, inputmode: 'numeric', value: s.ai_daily_limit });
  // Response and resolution time per priority, in minutes, each with its length in words beside it.
  const sla = {};
  const slaRows = [1, 2, 3, 4].map((p) => {
    const cell = (kind) => {
      const key = 'sla_p' + p + '_' + kind;
      const box = input({ type: 'number', min: 5, max: 129600, step: 1, required: true, inputmode: 'numeric', value: s[key], 'aria-label': 'P' + p + ' - ' + t(kind === 'resp' ? 'set.sla_resp' : 'set.sla_res') });
      const words = h('span', { class: 'muted small' });
      const show = () => (words.textContent = box.value > 0 ? fmtDuration(box.value * 60000) : '');
      box.addEventListener('input', show);
      show();
      sla[key] = box;
      return h('td', {}, h('div', { class: 'sla-cell' }, box, words));
    };
    return h('tr', {}, h('th', { scope: 'row' }, priorityChip(p)), cell('resp'), cell('res'));
  });

  // Logo: uploaded on its own as soon as a file is picked, no need to press Save.
  const MAX_LOGO = 1024 * 1024;
  const logoPreview = h('div', { class: 'logo-preview', 'aria-live': 'polite' });
  const logoInput = input({ type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg', class: 'visually-hidden', id: 'logo-file' });
  const logoPick = h('label', { class: 'btn btn-primary', for: 'logo-file' }, icon('plus'), '');
  const logoRemove = h('button', { type: 'button', class: 'btn' }, icon('trash'), t('set.logo_remove'));
  const drawLogo = () => {
    logoPreview.replaceChildren(S.brand.logo ? h('img', { src: S.brand.logo, alt: t('set.logo') }) : h('p', { class: 'muted small' }, t('set.logo_none')));
    logoPick.lastChild.textContent = t(S.brand.logo ? 'set.logo_change' : 'set.logo_upload');
    logoRemove.hidden = !S.brand.logo;
  };
  const brandUpdated = (b) => {
    S.brand = b;
    drawLogo();
    applyBrand();
    const top = document.querySelector('.top .brand');
    if (top) top.replaceWith(brand());
  };
  logoInput.addEventListener('change', async () => {
    const f = logoInput.files && logoInput.files[0];
    logoInput.value = '';
    if (!f) return;
    if (f.size > MAX_LOGO) {
      toast(t('err.logo_too_large'), true);
      return;
    }
    const fd = new FormData();
    fd.set('logo', f);
    logoPick.classList.add('is-busy');
    try {
      brandUpdated((await api('/settings/logo', { method: 'POST', form: fd })).brand);
      toast(t('set.logo_saved'));
    } catch (e) {
      toast(errText(e), true);
    } finally {
      logoPick.classList.remove('is-busy');
    }
  });
  logoRemove.addEventListener('click', async () => {
    logoRemove.disabled = true;
    try {
      brandUpdated((await api('/settings/logo', { method: 'DELETE' })).brand);
      toast(t('set.logo_removed'));
    } catch (e) {
      toast(errText(e), true);
    } finally {
      logoRemove.disabled = false;
    }
  });
  drawLogo();

  const form = h(
    'form',
    { class: 'settings' },
    // Long and rarely changed, so they open on demand.
    app !== 'admin' ? '' : h(
      'details',
      { class: 'panel fold' },
      h('summary', {}, h('h2', {}, t('set.brand'))),
      h(
        'div',
        { class: 'pad stack' },
        h('div', { class: 'field' }, h('span', { class: 'label' }, t('set.logo')), logoPreview, h('div', { class: 'actions logo-actions' }, logoInput, logoPick, logoRemove), h('p', { class: 'hint' }, t('set.logo_hint'))),
        h('div', { class: 'form-grid' }, field(t('set.org_ar'), orgAr), field(t('set.org_en'), orgEn)),
        h('p', { class: 'hint' }, t('set.org_hint')),
        field(t('set.support'), support),
        h('h3', { class: 'small strong' }, t('set.who')),
        h('p', { class: 'hint' }, t('set.who_hint')),
        h('div', { class: 'form-grid' }, field(t('set.who_one_ar'), who.one_ar), field(t('set.who_all_ar'), who.all_ar)),
        h('div', { class: 'form-grid' }, field(t('set.who_one_en'), who.one_en), field(t('set.who_all_en'), who.all_en)),
      ),
    ),
    app !== 'admin' ? '' : h(
      'details',
      { class: 'panel fold' },
      h('summary', {}, h('h2', {}, t('set.sender'))),
      h(
        'div',
        { class: 'pad stack' },
        h('p', { class: 'muted' }, t('set.sender_help')),
        field(t('set.provider'), provider),
        gasFields,
        brevoFields,
        field(t('set.sender_name'), senderName),
        field(t('set.timezone'), timezone),
        h('p', { class: 'hint' }, t('set.email_both')),
      ),
    ),
    app !== 'admin' ? '' : h(
      'section',
      { class: 'panel pad stack' },
      h('h2', {}, t('set.security')),
      h('p', { class: 'muted' }, t('set.security_help')),
      field(t('set.require_2fa'), require2fa, t('set.require_2fa_hint')),
      S.user.totp_on ? '' : h('p', { class: 'notice notice-warn' }, t('set.require_2fa_self')),
    ),
    app !== 'admin' ? '' : h(
      'section',
      { class: 'panel pad stack' },
      h('h2', {}, t('set.ai')),
      h('p', { class: 'muted' }, t('set.ai_help')),
      s.ai_available ? null : h('p', { class: 'notice notice-warn' }, t('set.ai_missing')),
      checkField(t('set.ai_enabled'), aiOn),
      field(t('set.ai_limit'), aiLimit, t('set.ai_limit_hint')),
      h('p', { class: 'hint' }, t('set.ai_used', { n: s.ai_used_today || 0, max: s.ai_daily_limit })),
    ),
    app !== 'docs' ? '' : h(
      'section',
      { class: 'panel pad stack' },
      h('h2', {}, t('set.reminders')),
      field(t('set.near_days'), nearDays, t('set.near_hint')),
      field(t('set.repeat_days'), repeatDays, t('set.repeat_hint')),
    ),
    app !== 'desk' ? '' : h(
      'section',
      { class: 'panel pad stack' },
      h('h2', {}, t('set.tickets')),
      h('p', { class: 'muted' }, t('set.sla_help')),
      h('div', { class: 'table-scroll' }, h('table', { class: 'sla-table' }, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, t('tk.priority')), h('th', { scope: 'col' }, t('set.sla_resp')), h('th', { scope: 'col' }, t('set.sla_res')))), h('tbody', {}, slaRows))),
      checkField(t('set.require_qr'), requireQr),
      h('p', { class: 'hint' }, t('set.require_qr_hint')),
    ),
    err,
    h('div', { class: 'actions' }, save),
  );
  // A field the browser flags inside a closed section opens it, so the message can be seen.
  form.addEventListener('invalid', (ev) => { const d = ev.target.closest('details'); if (d) d.open = true; }, true);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    save.disabled = true;
    try {
      await api('/settings', {
        method: 'PUT',
        // Only this page's own settings are sent.
        body:
          app === 'admin'
            ? { mail_provider: provider.value, mail_url: mailUrl.value, mail_token: mailToken.value, brevo_key: brevoKey.value, mail_from: mailFrom.value, mail_reply_to: replyTo.value, sender_name: senderName.value, timezone: timezone.value, org_name_ar: orgAr.value, org_name_en: orgEn.value, support_email: support.value, ...Object.fromEntries(Object.entries(who).map(([k, el]) => ['who_' + k, el.value])), ai_enabled: aiOn.checked, ai_daily_limit: Number(aiLimit.value), require_2fa: require2fa.value }
            : app === 'docs'
              ? { near_days: Number(nearDays.value), repeat_days: Number(repeatDays.value) }
              : { require_qr: requireQr.checked, ...Object.fromEntries(Object.entries(sla).map(([k, box]) => [k, Number(box.value)])) },
      });
      S.defaults.near_days = Number(nearDays.value);
      // Only the Admin Center's page holds the brand, so only it updates what the screens show.
      if (app === 'admin') {
        S.brand = Object.assign({}, S.brand, { name_ar: orgAr.value.trim(), name_en: orgEn.value.trim(), support: support.value.trim().toLowerCase() });
        S.brand.who = Object.fromEntries(Object.entries(who).map(([k, el]) => [k, el.value.trim()]));
      }
      toast(t('set.saved'));
      render();
    } catch (e) {
      err.textContent = errText(e);
      err.hidden = false;
      save.disabled = false;
    }
  });

  const run = (path, done) => async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      toast(done(await api(path, { method: 'POST' })));
    } catch (error) {
      toast(errText(error), true);
    } finally {
      btn.disabled = false;
    }
  };
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('nav.settings')), h('p', { class: 'muted' }, t('app.' + app)))),
    form,
    h(
      'section',
      { class: 'panel pad stack settings' },
      h('h2', {}, t('set.tools')),
      h(
        'div',
        { class: 'actions' },
        app === 'admin' ? h('button', { type: 'button', class: 'btn', onclick: run('/settings/test-email', (r) => t('set.test_sent', { to: r.to })) }, t('set.test')) : '',
        app === 'docs' ? h('button', { type: 'button', class: 'btn', onclick: run('/settings/run-reminders', (r) => (r.files ? t('set.run_done', { files: r.files, emails: r.emails }) : t('set.run_none'))) }, t('set.run')) : '',
        app === 'desk' ? h('button', { type: 'button', class: 'btn', onclick: run('/settings/run-ticket-alerts', (r) => (r.tickets ? t('set.alerts_done', { n: r.tickets, emails: r.emails }) : t('set.alerts_none'))) }, t('set.alerts')) : '',
      ),
    ),
    app === 'docs' ? demoPanel(s.demo) : '',
    app === 'admin' ? linkPanel() : '',
    app === 'admin' ? licensePanel(lic) : '',
    app === 'admin' ? backupPanel(s) : '',
  );
}

/* ------------------------------- backup -------------------------------- */

// A full copy the organisation keeps itself: backup.json (all data) + every PDF in a folder per department.
// Built in the browser, so it works on the free plan whatever the number of files.
export async function downloadBackup(btn, status) {
  const safe = (v) => String(v || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || '-';
  const day = new Date().toLocaleDateString('en-CA');
  btn.disabled = true;
  status.textContent = t('bak.preparing');
  try {
    const b = await api('/backup');
    const depts = new Map(b.data.departments.map((d) => [d.id, d]));
    const entries = {};
    const missing = [];
    const used = new Set();
    const full = b.kind === 'full';
    const withPdf = b.data.files.filter((f) => f.pdf_key || f.has_pdf);
    let total = 0;
    for (let i = 0; i < withPdf.length; i++) {
      const f = withPdf[i];
      status.textContent = t('bak.progress', { n: i + 1, total: withPdf.length });
      const d = depts.get(f.department_id);
      let path = 'PDF/' + safe(d ? (S.lang === 'en' ? d.name_en : d.name_ar) : f.department_id) + '/' + safe(f.file_number + ' - ' + fileName(f));
      let unique = path;
      for (let k = 2; used.has(unique); k++) unique = path + ' (' + k + ')';
      used.add(unique);
      try {
        const res = await fetch('/api/files/' + f.id + '/pdf', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(String(res.status));
        const bytes = new Uint8Array(await res.arrayBuffer());
        total += bytes.length;
        if (total > 3.5 * 1024 ** 3) throw new ApiError('backup_too_large');
        entries[unique + '.pdf'] = bytes;
      } catch (e) {
        if (e instanceof ApiError) throw e;
        missing.push(f.file_number + ' - ' + fileName(f));
      }
    }
    if (full && S.brand.logo) {
      try {
        const res = await fetch(S.brand.logo);
        if (res.ok) {
          const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' }[res.headers.get('content-type')] || 'img';
          entries['logo.' + ext] = new Uint8Array(await res.arrayBuffer());
        }
      } catch {
        /* the logo is optional in a backup */
      }
    }
    const readme = !full ? '' : [
      t('bak.readme_title'),
      t('bak.readme_date') + ': ' + fmtDate(day) + ' - ' + b.created_by,
      t('bak.readme_counts', { files: b.data.files.length, pdfs: withPdf.length - missing.length, depts: b.data.departments.length, users: b.data.users.length }),
      '',
      t('bak.readme_pdf'),
      t('bak.readme_json'),
      t('bak.readme_private'),
      missing.length ? '\n' + t('bak.readme_missing') + '\n' + missing.map((m) => '- ' + m).join('\n') : '',
    ].join('\n');
    const zip = zipStore(full ? Object.assign({ 'README.txt': '\ufeff' + readme, 'backup.json': JSON.stringify(b, null, 2) }, entries) : entries);
    const url = URL.createObjectURL(zip);
    const a = h('a', { href: url, download: 'backup-' + day + '.zip' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    const missKey = full ? 'bak.done_missing' : 'bak.done_missing_pdf';
    status.textContent = missing.length ? t(missKey, { n: missing.length }) : t('bak.done');
    if (missing.length) toast(t(missKey, { n: missing.length }), true);
    else toast(t('bak.done'));
  } catch (e) {
    status.textContent = '';
    toast(errText(e), true);
  } finally {
    btn.disabled = false;
  }
}
